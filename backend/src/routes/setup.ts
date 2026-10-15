// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { mediaSetupKeys } from '../media/index.js';
import { MEDIA_SETUP } from '../media/setup.js';
import { MediaSetupError } from '../media/types.js';
import { plainHttpUrl } from '../settings/probeKit.js';
import { publicUrlSchema, SETTINGS, type SettingGroup } from '../settings/registry.js';
import { createSetupSession, hasSetupSession, requireSetupSession, verifySetupCode } from '../setup/code.js';
import { isSetupComplete } from '../setup/state.js';
import { saveWithProbes, testGroup, valuesSchema } from './adminSettings.js';

/**
 * The setup wizard's API (spec Parts E and F). Open while setup is incomplete (the gate in app.ts lets /api/setup/* through); the
 * endpoints that change something need the setup session (requireSetupSession) and answer 409 setup_complete afterwards. The global
 * CSRF hook skips /api/setup/: these endpoints carry their own token (x-ff-setup-csrf), never the account session's.
 */

const SIGNIN_KEYS = SETTINGS.filter((d) => d.group === 'signin' && d.visible !== false).map((d) => d.key);
/** The keys the wizard's steps 2-4 own: the public URL, the media server kind's keys (its setup provider, spec Part H) and the sign-in group. */
const wizardKeys = (ctx: Ctx): readonly string[] => ['PUBLIC_URL', ...mediaSetupKeys(ctx.cfg), ...SIGNIN_KEYS];
const WIZARD_GROUPS = ['general', 'media', 'signin'] as const satisfies readonly SettingGroup[];

type Step = 'todo' | 'done' | 'env';
const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';
const runRequired = (ctx: Ctx, group: SettingGroup) =>
  SETTINGS.filter((d) => d.group === group && (typeof d.runRequired === 'function' ? d.runRequired(ctx.cfg) : d.runRequired)).map((d) => d.key);

/** 'env' when the environment provides every key of the step (locked, skippable), 'done' when all are set, else 'todo'. */
function step(ctx: Ctx, keys: readonly string[]): Step {
  const sources = ctx.settings.sources();
  const cfg = ctx.cfg as Record<string, unknown>;
  if (keys.length && keys.every((k) => sources[k] === 'env')) return 'env';
  return keys.every((k) => isSet(cfg[k])) ? 'done' : 'todo';
}

/** The origin the browser used (behind the proxy: x-forwarded-proto / -host), as the step 2 suggestion; null when it is not an origin. */
function prefillUrl(req: FastifyRequest): string | null {
  const fwd = req.headers['x-forwarded-host'];
  const host = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req.headers.host;
  if (!host) return null;
  const r = publicUrlSchema.safeParse(`${req.protocol}://${host}`);
  return r.success ? r.data : null;
}

/** 32 random bytes, base64url (settings/probes.ts publicUrl): nothing else is ever looked up */
const NONCE = /^[A-Za-z0-9_-]{43}$/;

export function setupRoutes(app: FastifyInstance, ctx: Ctx) {
  const session = { preHandler: requireSetupSession(ctx) };

  app.get('/api/setup/state', async (req) => {
    const complete = await isSetupComplete(ctx);
    return {
      complete,
      unlocked: !complete && (await hasSetupSession(ctx, req)),
      mediaKind: ctx.cfg.MEDIA_SERVER,
      // the media step's fields (labels: settings.keys.<KEY>) and whether "Create API key automatically" exists for this kind
      media: { keys: mediaSetupKeys(ctx.cfg), auto: MEDIA_SETUP[ctx.cfg.MEDIA_SERVER]?.auto?.fields ?? null },
      steps: {
        publicUrl: step(ctx, ['PUBLIC_URL']),
        media: step(ctx, runRequired(ctx, 'media')),
        signin: step(ctx, runRequired(ctx, 'signin')),
        admin: complete ? 'done' : 'todo',
      },
      prefill: { publicUrl: prefillUrl(req) },
    };
  });

  // per IP 5 attempts / 15 min (trustProxy: the client address behind the proxy); the global failure limit is in verifySetupCode
  app.post('/api/setup/unlock', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { code } = z.object({ code: z.string().max(64) }).parse(req.body);
    const r = await verifySetupCode(ctx, code, req.ip, req.log);
    if (r === 'complete') return reply.code(409).send({ error: 'setup_complete' });
    if (r === 'expired') return reply.code(410).send({ error: 'code_expired' });
    if (r === 'locked') return reply.code(410).send({ error: 'code_locked' });
    if (r === 'no_code') return reply.code(410).send({ error: 'no_code' }); // the web explains: start one backend with BACKGROUND_JOBS=true
    if (r === 'wrong') return reply.code(401).send({ error: 'wrong_code' });
    await createSetupSession(ctx, req, reply);
    req.log.info({ ip: req.ip }, 'setup session opened');
    return { ok: true };
  });

  // the publicUrl probe's target: answers only a nonce the probe stored a moment ago (kv, 60 s), with the stored answer and nothing of
  // the request, so it reflects nothing; open after setup too (Admin -> Settings probes PUBLIC_URL the same way)
  app.get('/api/setup/echo/:nonce', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { nonce } = req.params as { nonce: string };
    const answer = NONCE.test(nonce) ? await ctx.kv.get(`setup:echo:${nonce}`) : null;
    if (!answer) return reply.code(404).send({ error: 'not_found' });
    return { answer };
  });

  app.put('/api/setup/settings', { ...session, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ values: valuesSchema, force: z.boolean().optional() }).parse(req.body);
    // actor null: nobody is signed in yet; the audit row lists the keys only
    const r = await saveWithProbes(ctx, b.values, { force: b.force ?? false, actor: null, allowedKeys: wizardKeys(ctx) });
    if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
    if ('probe' in r) return reply.code(400).send({ error: 'probe_failed', group: r.group, probe: r.probe });
    return r;
  });

  app.post('/api/setup/test', { ...session, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ group: z.string().max(32), values: valuesSchema.optional() }).parse(req.body);
    if (!(WIZARD_GROUPS as readonly string[]).includes(b.group)) return reply.code(400).send({ error: 'not_allowed' });
    const r = await testGroup(ctx, b.group as SettingGroup, b.values ?? {}, { allowedKeys: wizardKeys(ctx) });
    if ('noProbe' in r) return reply.code(400).send({ error: 'no_probe' });
    if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
    return r;
  });

  // spec Part G "Jellyfin automation": the provider signs in with the administrator's username and password (in this request only:
  // never stored or logged, and the body is kept out of error logs, app.ts SENSITIVE_BODY), creates an API key and logs out; the key is
  // saved like a manual entry, so the media probe confirms it first. Answers { ok: true } or a ProbeResult failure.
  const autoBody = z.object({ url: z.string().max(2048), username: z.string().min(1).max(256), password: z.string().max(1024) });
  app.post('/api/setup/media/auto', { ...session, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = autoBody.parse(req.body);
    const provider = MEDIA_SETUP[ctx.cfg.MEDIA_SERVER];
    if (!provider?.auto) return reply.code(400).send({ error: 'not_supported' });
    // http(s) without user info, checked before any request
    if (!plainHttpUrl(b.url)) return reply.code(400).send({ ok: false, code: 'invalid', detail: 'invalid_url' });
    // keys from the environment stay as they are: the URL must be the locked one, and only the other keys are saved
    const sources = ctx.settings.sources();
    const lockedUrl = sources[provider.urlKey] === 'env' ? String((ctx.cfg as Record<string, unknown>)[provider.urlKey] ?? '') : undefined;
    if (lockedUrl !== undefined && b.url !== lockedUrl) return reply.code(400).send({ ok: false, code: 'invalid', detail: 'env_locked' });
    // one run at a time (all instances): two runs listing the keys at once could both pick the same new key and orphan the other
    const lock = 'setup:media:auto';
    if (!(await ctx.kv.setnx(lock, '1', 60))) return reply.code(409).send({ error: 'busy' });
    try {
      let values: Record<string, string>;
      try {
        values = await provider.auto.run(b, { fetchImpl: ctx.fetchImpl, appVersion: ctx.cfg.APP_VERSION ?? 'dev' });
      } catch (e) {
        if (!(e instanceof MediaSetupError)) throw e;
        req.log.info({ code: e.code, detail: e.detail }, 'media server: automatic API key failed');
        return { ok: false, code: e.code, ...(e.detail ? { detail: e.detail } : {}) };
      }
      const toSave = Object.fromEntries(Object.entries(values).filter(([k]) => sources[k] !== 'env'));
      const r = await saveWithProbes(ctx, toSave, { force: false, actor: null, allowedKeys: provider.keys });
      // a refusal saved nothing: the new credential would be orphaned, so it is revoked. Never when saveWithProbes throws: it may throw
      // after the commit (the audit write), and the saved key must keep working.
      if ('errors' in r || 'probe' in r) {
        await provider.auto.revoke?.(values, { fetchImpl: ctx.fetchImpl }).catch(() => undefined);
        req.log.info('media server: the created API key was not saved and has been revoked');
        if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
        return reply.code(400).send({ error: 'probe_failed', group: r.group, probe: r.probe });
      }
      req.log.info('media server: API key created and saved');
      return { ok: true };
    } finally {
      await ctx.kv.del(lock).catch(() => undefined);
    }
  });
}
