// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The in-app sign-in routes (Block 23 phase 3): `/auth/flow/*` drives an Authentik flow through the executor (akflow.ts) and answers
 * sanitised steps (flowSteps.ts).
 *
 * - CSRF: double submit. Every POST carries `x-ff-flow-csrf` equal to the `ff_flow_csrf` cookie (set by GET /auth/flow/config); a jar that
 *   belongs to a session (`userId`) also needs that session's `x-csrf-token`. These routes are outside /api/, so the global hook in app.ts
 *   does not run here.
 * - Single-use steps: every answer names the step id it answers; the id is claimed atomically and rotated before Authentik is called, so a
 *   replay (double click, captured request) gets 409 `step_used` and Authentik sees one POST.
 * - Answers are checked against the step that was shown (its stage, and whether it offered a passkey, an inline password, a code).
 * - Rate limits: per IP (route config) and per account: failed answers count under `flowfail:<sha256(lower(identifier))>` for every jar
 *   kind; at 10 within 15 min the next answer is refused without calling Authentik.
 * - Errors: codes only. Logged as `{ route, code }`, never the error object or the body (passwords, codes, credentials).
 *   Authentik unreachable or answering nonsense → `200 {stage:'unavailable'}` (the card offers retry and the classic sign-in).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  akExec, appHost, createJar, dropJar, endAkSession, flowSlug, type Jar, JAR_TTL_S, loadJar, loginUi, type RawChallenge, saveJar,
} from '../akflow.js';
import { akFlowExists } from '../authentik.js';
import { secureCookies } from '../config.js';
import type { Ctx } from '../ctx.js';
import { randomToken, sha256 } from '../crypto.js';
import { FlowFieldError, type FlowError, type FlowStep, stepErrors, toAnswer, toStep } from '../flowSteps.js';
import { lookupInvite } from '../invites.js';
import { COOKIE as SESSION_COOKIE, loadSession } from '../session.js';
import { HttpError } from '../users.js';

/** the flow id (httpOnly, only sent to /auth/flow) */
export const FLOW_COOKIE = 'ff_flow';
/** the double-submit token, readable by the page */
export const FLOW_CSRF_COOKIE = 'ff_flow_csrf';
export const FLOW_CSRF_HEADER = 'x-ff-flow-csrf';
const FLOW_PATH = '/auth/flow';
/** failed answers per account before the next one is refused, and the window they count in */
export const MAX_FLOW_FAILURES = 10;
export const FLOW_FAIL_WINDOW_S = 900;
/** internal hops answered by the backend itself (select-stage) before a step is shown */
const MAX_AUTO = 3;

type AnswerableStep = Extract<FlowStep, { step: string }>;
type Reply = AnswerableStep & { errors?: FlowError[] } | FlowStep;

/** the per-account failure counter's key: the identifier the person typed, case-insensitive, hashed */
export const flowFailKey = (identifier: string) => `flowfail:${sha256(identifier.trim().toLowerCase())}`;
const usedStepKey = (flowId: string, step: string) => `akflow:used:${sha256(`${flowId}|${step}`)}`;

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const badRequest = () => new HttpError(400, 'bad_request');
const csrfError = () => new HttpError(403, 'csrf');
const AK_DOWN: ReadonlySet<string> = new Set(['authentik_unavailable', 'authentik_error']);

const StartBody = z.strictObject({
  kind: z.enum(['login', 'recovery', 'enroll']),
  invite: z.string().min(1).max(128).optional(),
});
const AnswerHead = z.object({ step: z.string().min(1).max(64), stage: z.string().min(1).max(32) });

/** the challenge as kept in the jar: what toAnswer reads, without the avatar (a data URI) and the flow's brand info */
function keptChallenge(c: RawChallenge): RawChallenge {
  const { pending_user_avatar: _avatar, flow_info: _info, ...rest } = c;
  return rest;
}

/** an answer may only use what the shown step offered (an inline password, a passkey, a code); prompt answers only the shown fields */
function checkOffered(shown: AnswerableStep, answer: Record<string, unknown>): void {
  const has = (k: string) => Object.hasOwn(answer, k);
  switch (shown.stage) {
    case 'identify':
      if ((has('passkey') && !shown.passkey) || (has('password') && !shown.passwordInline)) throw badRequest();
      return;
    case 'mfa':
      if ((has('webauthn') && !shown.passkey) || (has('code') && !shown.totp && !shown.recovery)) throw badRequest();
      return;
    case 'prompt': {
      const keys = new Set(shown.fields.map((f) => f.key));
      if (Object.keys(answer).some((k) => !keys.has(k))) throw badRequest();
      return;
    }
    default:
  }
}

export function authFlowRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = () => secureCookies(ctx.cfg); // PUBLIC_URL applies live

  const setFlowCookie = (reply: FastifyReply, flowId: string) =>
    reply.setCookie(FLOW_COOKIE, flowId, { httpOnly: true, secure: secure(), sameSite: 'strict', path: FLOW_PATH, maxAge: JAR_TTL_S });
  const clearFlowCookie = (reply: FastifyReply) => reply.clearCookie(FLOW_COOKIE, { path: FLOW_PATH });

  /** the double-submit check: header and cookie present and equal (timing-safe) */
  function checkFlowCsrf(req: FastifyRequest): void {
    const cookie = req.cookies[FLOW_CSRF_COOKIE];
    const header = req.headers[FLOW_CSRF_HEADER];
    if (!cookie || typeof header !== 'string' || !sameToken(header, cookie)) throw csrfError();
  }

  /** a jar of a signed-in person (re-authentication, security actions): only that session, with its own csrf token, may drive it */
  async function checkSessionCsrf(req: FastifyRequest, jar: Jar): Promise<void> {
    if (!jar.userId) return;
    const s = await loadSession(ctx, req.cookies[SESSION_COOKIE]);
    const sent = req.headers['x-csrf-token'];
    if (!s || s.userId !== jar.userId || typeof sent !== 'string' || !sameToken(sent, s.csrf)) throw csrfError();
  }

  /**
   * The end of a flow (`{internal:'end'}`). Task 4 replaces this single call with completeFlow (silent authorize, resolveLogin); until
   * then a finished flow never yields a session: the Authentik session is ended, the jar dropped, and the card shows "unavailable".
   */
  async function onFlowEnd(_req: FastifyRequest, _reply: FastifyReply, flowId: string, jar: Jar): Promise<FlowStep> {
    await endAkSession(ctx, jar);
    await dropJar(ctx, flowId);
    return { stage: 'unavailable' };
  }

  /**
   * Turns a challenge into the answer for the browser: internal outcomes are handled here (select-stage answered automatically, the end
   * of the flow, a link interstitial outside resume → classic consent). A step with an id is kept in the jar (`live`); any other outcome
   * ends the flow in the app and drops the jar.
   */
  async function advance(req: FastifyRequest, reply: FastifyReply, flowId: string, jar: Jar, first: RawChallenge): Promise<{ out: FlowStep; live: boolean }> {
    let challenge = first;
    for (let i = 0; i <= MAX_AUTO; i++) {
      const out = toStep(challenge, jar, jar.step, appHost(ctx.cfg));
      if ('internal' in out) {
        if (out.internal === 'select-stage' && i < MAX_AUTO) {
          challenge = (await akExec(ctx, jar, 'POST', { selected_stage: out.pk }, req.ip)).challenge;
          continue;
        }
        if (out.internal === 'end') return { out: await onFlowEnd(req, reply, flowId, jar), live: false };
        break; // link-confirm comes only from resume (Task 5); anything else here is a consent the app does not answer
      }
      if ('step' in out) {
        jar.last = { raw: keptChallenge(challenge), step: out };
        await saveJar(ctx, flowId, jar);
        return { out, live: true };
      }
      await dropJar(ctx, flowId);
      return { out, live: false };
    }
    await dropJar(ctx, flowId);
    return { out: { stage: 'classic', reason: 'consent' }, live: false };
  }

  /**
   * Every handler answers codes only: FlowFieldError → 400 `{errors}`, Authentik down → 200 `{stage:'unavailable'}`, HttpError →
   * `{error: code}`, anything else → 500 `{error:'internal'}`. Logged as `{ route, code }` only, never the error or the body.
   */
  const guarded = (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        const route = req.routeOptions.url ?? 'unmatched';
        if (err instanceof FlowFieldError) {
          req.log.warn({ route, code: err.message }, 'flow answer refused');
          return reply.code(400).send({ errors: err.errors });
        }
        if (err instanceof HttpError) {
          const code = /^[a-z0-9_]{1,64}$/.test(err.message) ? err.message : 'internal';
          req.log.warn({ route, code }, 'flow request refused');
          if (AK_DOWN.has(code) && err.statusCode >= 500) return reply.code(200).send({ stage: 'unavailable' });
          return reply.code(err.statusCode).send({ error: code });
        }
        req.log.warn({ route, code: 'internal' }, 'flow request failed');
        return reply.code(500).send({ error: 'internal' });
      }
    };

  // What the login page needs before it renders: the mode, whether "forgot password" and enrolment exist, and a fresh csrf cookie.
  // No executor call here (the reset and confirm pages call it on mount, plan Ruling 11).
  app.get('/auth/flow/config', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, guarded(async (_req, reply) => {
    const mode = loginUi(ctx.cfg);
    const recovery = mode === 'app' ? await akFlowExists(ctx, flowSlug(ctx.cfg, 'recovery')!) : false;
    reply.setCookie(FLOW_CSRF_COOKIE, randomToken(), { httpOnly: false, secure: secure(), sameSite: 'strict', path: '/', maxAge: JAR_TTL_S });
    return { mode, recovery, enroll: mode === 'app' && flowSlug(ctx.cfg, 'enroll') !== undefined };
  }));

  app.post('/auth/flow/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, guarded(async (req, reply) => {
    checkFlowCsrf(req);
    const parsed = StartBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest();
    const body = parsed.data;
    if (loginUi(ctx.cfg) !== 'app') throw new HttpError(409, 'classic');
    let init: Partial<Pick<Jar, 'query' | 'invite'>> = {};
    if (body.kind === 'enroll') {
      // enrolment runs with the Authentik invitation of a portal invite; the invite also travels to the end of the flow (preflight P16)
      const inv = body.invite ? await lookupInvite(ctx, body.invite) : null;
      if (!inv?.authentik_invite) throw new HttpError(410, 'invite_invalid');
      init = { query: `itoken=${encodeURIComponent(inv.authentik_invite)}`, invite: body.invite };
    } else if (body.invite !== undefined) {
      if (body.kind !== 'login') throw badRequest();
      if (!(await lookupInvite(ctx, body.invite))) throw new HttpError(410, 'invite_invalid');
      init = { invite: body.invite };
    }
    // one attempt per browser: a new start forgets the previous jar
    const old = req.cookies[FLOW_COOKIE];
    if (old) await dropJar(ctx, old);
    const jar = await createJar(ctx, body.kind, { ...init, step: randomToken(16) });
    const flowId = randomToken();
    const { challenge } = await akExec(ctx, jar, 'GET', undefined, req.ip);
    const { out, live } = await advance(req, reply, flowId, jar, challenge);
    if (live) setFlowCookie(reply, flowId);
    else if (old) clearFlowCookie(reply);
    return out;
  }));

  app.post('/auth/flow/answer', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, guarded(async (req, reply): Promise<Reply> => {
    checkFlowCsrf(req);
    const raw = req.body;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw badRequest();
    const head = AnswerHead.safeParse(raw);
    if (!head.success) throw badRequest();
    const { step: _s, stage: _st, ...given } = raw as Record<string, unknown>;
    if (loginUi(ctx.cfg) !== 'app') throw new HttpError(409, 'classic');
    const flowId = req.cookies[FLOW_COOKIE];
    // older than 600 s, never started, or already finished: nothing reaches Authentik
    const jar = flowId ? await loadJar(ctx, flowId) : null;
    if (!flowId || !jar?.last) {
      if (flowId) clearFlowCookie(reply);
      return { stage: 'expired' };
    }
    await checkSessionCsrf(req, jar);
    if (!sameToken(head.data.step, jar.step)) throw new HttpError(409, 'step_used');
    const shown = jar.last.step;
    if (head.data.stage !== shown.stage) throw badRequest();
    checkOffered(shown, given);
    const answer = toAnswer(shown.stage, given, jar.last.raw); // 400 bad_request / password_mismatch, before anything is used up
    const typed = (answer as { uid_field?: unknown }).uid_field;
    const identifier = shown.stage === 'identify' && typeof typed === 'string' ? typed : jar.identifier;
    // single use: the step is claimed atomically (a concurrent replay loses here) and rotated before Authentik is called
    if (!(await ctx.kv.setnx(usedStepKey(flowId, jar.step), '1', JAR_TTL_S))) throw new HttpError(409, 'step_used');
    jar.step = randomToken(16);
    jar.last = { ...jar.last, step: { ...shown, step: jar.step } };
    if (identifier !== undefined) jar.identifier = identifier;
    await saveJar(ctx, flowId, jar);
    if (identifier && Number((await ctx.kv.get(flowFailKey(identifier))) ?? 0) >= MAX_FLOW_FAILURES) {
      return { ...jar.last.step, errors: ['rate_limited'] };
    }
    const { challenge } = await akExec(ctx, jar, 'POST', answer, req.ip);
    // a wrong password, code or passkey counts; the e-mail stage's resend notice is no error (stepErrors skips it)
    const errors = stepErrors(challenge);
    if (errors.length && identifier) await ctx.kv.incr(flowFailKey(identifier), FLOW_FAIL_WINDOW_S);
    const { out, live } = await advance(req, reply, flowId, jar, challenge);
    if (!live) clearFlowCookie(reply);
    return errors.length && 'step' in out ? { ...out, errors } : out;
  }));

  // Gives up the attempt: Authentik's session (if any) is ended, the jar deleted, the cookies cleared.
  app.post('/auth/flow/cancel', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, guarded(async (req, reply) => {
    checkFlowCsrf(req);
    const flowId = req.cookies[FLOW_COOKIE];
    const jar = flowId ? await loadJar(ctx, flowId) : null;
    if (flowId && jar) {
      await checkSessionCsrf(req, jar);
      await endAkSession(ctx, jar);
      await dropJar(ctx, flowId);
    }
    clearFlowCookie(reply);
    reply.clearCookie(FLOW_CSRF_COOKIE, { path: '/' });
    return { ok: true };
  }));
}
