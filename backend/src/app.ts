import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { metricsPlugin } from './metrics.js';
import { adminRoutes, inviteRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { internalRoutes } from './routes/internal.js';
import { discoverRoutes } from './routes/discover.js';
import { partyRoutes } from './routes/party.js';
import { prefsRoutes } from './routes/prefs.js';
import { pollRoutes } from './routes/polls.js';
import { sceneRoutes } from './routes/scenes.js';
import { seerrRoutes } from './routes/seerr.js';
import { statsRoutes } from './routes/stats.js';
import { tvRoutes } from './routes/tv.js';
import { mediaRoutes } from './routes/media.js';

export interface Extra {
  /** Additional route registrars for later steps. */
  register?: Array<(app: FastifyInstance, ctx: Ctx) => void | Promise<void>>;
}

export async function buildApp(ctx: Ctx, extra: Extra = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true, bodyLimit: 256 * 1024 });
  // Browsers send `content-type: application/json` with an empty body on body-less POST/DELETE (favorite, played,
  // watchlist ...). Fastify rejects that with 400 FST_ERR_CTP_EMPTY_JSON_BODY; treat it as "no body". Everything else
  // still goes through Fastify's own parser (prototype-poisoning protection included).
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined);
    defaultJson(req, body as string, done);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request', issues: err.issues.map((i) => i.path.join('.')) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    if (process.env.DEBUG_TEST) console.error(err);
    return reply.code(500).send({ error: 'internal' });
  });
  // Security headers for API responses (the UI gets its own CSP from SvelteKit).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin').header('X-Frame-Options', 'DENY')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    if (reply.getHeader('cache-control') === undefined) reply.header('Cache-Control', 'no-store');
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(metricsPlugin, { ctx });

  // CSRF: every state-changing /api request must carry the per-session token.
  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/invite/')) return; // anonymous, token-protected
    if (req.url.startsWith('/api/tv/code') || req.url.startsWith('/api/tv/claim')) return; // anonymous, protected by the TV's own poll secret (no ambient authority)
    const sid = req.cookies.ff_sid;
    const raw = sid ? await ctx.kv.get(`sess:${sid}`) : null;
    if (!raw) return; // unauthenticated -> route handler answers 401
    const want = Buffer.from((JSON.parse(raw) as { csrf: string }).csrf);
    const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return reply.code(403).send({ error: 'csrf' });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, boolean> = {
      redis: await ctx.kv.ping().catch(() => false),
      postgres: await ctx.db.query('select 1').then(() => true, () => false),
      jellyfin: await ctx.jf.client.ping(),
    };
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });

  authRoutes(app, ctx);
  mediaRoutes(app, ctx);
  internalRoutes(app, ctx);
  adminRoutes(app, ctx);
  inviteRoutes(app, ctx);
  seerrRoutes(app, ctx);
  await partyRoutes(app, ctx);
  pollRoutes(app, ctx);
  statsRoutes(app, ctx);
  prefsRoutes(app, ctx);
  discoverRoutes(app, ctx);
  sceneRoutes(app, ctx);
  tvRoutes(app, ctx);
  for (const r of extra.register ?? []) await r(app, ctx);
  return app;
}
