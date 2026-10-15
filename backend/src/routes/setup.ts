// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { mediaSettings } from '../media/index.js';
import { publicUrlSchema, SETTINGS, type SettingGroup } from '../settings/registry.js';
import { createSetupSession, hasSetupSession, requireSetupSession, verifySetupCode } from '../setup/code.js';
import { isSetupComplete } from '../setup/state.js';
import { saveWithProbes, testGroup, valuesSchema } from './adminSettings.js';

/**
 * The setup wizard's API (spec Parts E and F). Open while setup is incomplete (the gate in app.ts lets /api/setup/* through); the
 * endpoints that change something need the setup session (requireSetupSession) and answer 409 setup_complete afterwards. The global
 * CSRF hook skips /api/setup/: these endpoints carry their own token (x-ff-setup-csrf), never the account session's.
 */

/** The keys the wizard's steps 2-4 own: the public URL, the media server's keys and the sign-in group. */
const WIZARD_KEYS: readonly string[] = [
  'PUBLIC_URL',
  ...mediaSettings().map((d) => d.key),
  ...SETTINGS.filter((d) => d.group === 'signin' && d.visible !== false).map((d) => d.key),
];
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
    const r = await saveWithProbes(ctx, b.values, { force: b.force ?? false, actor: null, allowedKeys: WIZARD_KEYS });
    if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
    if ('probe' in r) return reply.code(400).send({ error: 'probe_failed', group: r.group, probe: r.probe });
    return r;
  });

  app.post('/api/setup/test', { ...session, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ group: z.string().max(32), values: valuesSchema.optional() }).parse(req.body);
    if (!(WIZARD_GROUPS as readonly string[]).includes(b.group)) return reply.code(400).send({ error: 'not_allowed' });
    const r = await testGroup(ctx, b.group as SettingGroup, b.values ?? {}, { allowedKeys: WIZARD_KEYS });
    if ('noProbe' in r) return reply.code(400).send({ error: 'no_probe' });
    if ('errors' in r) return reply.code(400).send({ error: 'invalid_settings', errors: r.errors });
    return r;
  });
}
