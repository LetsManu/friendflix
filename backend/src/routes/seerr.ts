import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { notify } from '../notify.js';
import { portalStatus, SeerrError } from '../seerr/client.js';
import { ensureSeerrUser } from '../seerr/service.js';
import { requireAdmin, requireUser } from '../session.js';
import { checkSecret } from './internal.js';
import { seerrHooks } from '../hooks.js';

const mediaType = z.enum(['movie', 'tv']);

function mapResult(r: any) {
  return {
    tmdbId: r.id as number,
    mediaType: r.mediaType as string,
    title: (r.title ?? r.name ?? '') as string,
    year: String(r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4) || undefined,
    overview: r.overview as string | undefined,
    poster: r.posterPath ? `/api/seerr/image${r.posterPath}` : undefined,
    status: portalStatus(r.mediaInfo?.status),
  };
}

function wrap<T extends (...a: any[]) => Promise<any>>(fn: T): T {
  return (async (req: any, reply: any) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof z.ZodError) return reply.code(400).send({ error: 'bad_request' });
      if (e instanceof SeerrError) return reply.code(502).send({ error: 'seerr', status: e.status });
      throw e;
    }
  }) as T;
}

export function seerrRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/seerr/search', pre, wrap(async (req) => {
    const q = z.object({ q: z.string().min(2).max(100), page: z.coerce.number().int().min(1).max(10).default(1) }).parse(req.query);
    const r = await ctx.seerr.search(q.q, q.page);
    return { results: r.results.filter((x) => x.mediaType === 'movie' || x.mediaType === 'tv').map(mapResult), totalPages: r.totalPages };
  }));

  // TMDB posters are proxied (fixed host, strict path) so browsers never contact third parties.
  app.get('/api/seerr/image/*', { ...pre, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const path = '/' + String((req.params as { '*': string })['*']);
    if (!/^\/[A-Za-z0-9_-]{5,60}\.(jpg|png|webp)$/.test(path)) return reply.code(400).send({ error: 'bad_path' });
    const r = await ctx.fetchImpl(`https://image.tmdb.org/t/p/w342${path}`, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (!r.ok || !r.body) return reply.code(404).send();
    reply.header('content-type', r.headers.get('content-type') ?? 'image/jpeg').header('cache-control', 'private, max-age=86400');
    return reply.send(Readable.fromWeb(r.body as never));
  });

  app.get('/api/seerr/:type/:id/status', pre, wrap(async (req) => {
    const p = z.object({ type: mediaType, id: z.coerce.number().int().positive() }).parse(req.params);
    const d = await ctx.seerr.details(p.type, p.id);
    return { status: portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status) };
  }));

  app.post('/api/requests', pre, wrap(async (req, reply) => {
    const b = z.object({ mediaType, tmdbId: z.number().int().positive(), seasons: z.array(z.number().int().min(0).max(100)).optional() }).parse(req.body);
    const d = await ctx.seerr.details(b.mediaType, b.tmdbId);
    const st = portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status);
    if (st !== 'nicht_angefragt' && st !== 'abgelehnt') return reply.code(409).send({ error: 'already_requested', status: st });
    const seerrUserId = await ensureSeerrUser(ctx, req.user!);
    const created = await ctx.seerr.createRequest({ mediaType: b.mediaType, mediaId: b.tmdbId, seasons: b.mediaType === 'tv' ? (b.seasons ?? 'all') : undefined, userId: seerrUserId });
    const title = String(d.title ?? d.name ?? `#${b.tmdbId}`);
    await ctx.db.query(
      'insert into seerr_requests(seerr_request_id, user_id, media_type, tmdb_id, title, poster) values ($1,$2,$3,$4,$5,$6) on conflict (seerr_request_id) do nothing',
      [created.id, req.user!.id, b.mediaType, b.tmdbId, title, d.posterPath ?? null],
    );
    await audit(ctx, req.user!.id, 'request.create', String(created.id), { title });
    await seerrHooks.run(ctx, { type: 'requested', user: req.user!, tmdbId: b.tmdbId, mediaType: b.mediaType });
    return { id: created.id, status: portalStatus(created.media?.status, created.status) };
  }));

  app.get('/api/requests/mine', pre, wrap(async (req) => {
    const rows = (await ctx.db.query('select * from seerr_requests where user_id=$1 order by created_at desc limit 50', [req.user!.id])).rows;
    const out = [];
    for (const r of rows) {
      let status = 'angefragt';
      try {
        const sr = await ctx.seerr.getRequest(r.seerr_request_id);
        status = portalStatus(sr.media?.status, sr.status);
      } catch (e) {
        if (e instanceof SeerrError && e.status === 404) status = 'entfernt';
      }
      out.push({ id: r.seerr_request_id, title: r.title, mediaType: r.media_type, tmdbId: r.tmdb_id, poster: r.poster ? `/api/seerr/image${r.poster}` : undefined, status, createdAt: r.created_at });
    }
    return { requests: out };
  }));

  // ---- admin approval ----
  app.get('/api/admin/requests', admin, wrap(async (req) => {
    const f = z.enum(['pending', 'approved', 'processing', 'available', 'all']).default('pending').parse((req.query as { filter?: string }).filter);
    const r = await ctx.seerr.listRequests(f, 50, 0);
    const ids = r.results.map((x: any) => x.id);
    const owners = ids.length ? (await ctx.db.query('select s.seerr_request_id id, u.name from seerr_requests s join users u on u.id=s.user_id where s.seerr_request_id = any($1)', [ids])).rows : [];
    const byId = new Map(owners.map((o: any) => [o.id, o.name]));
    const titles = await Promise.all(r.results.map(async (x: any) => {
      try {
        const m = x.media ?? {};
        const d = await ctx.seerr.details(x.type ?? m.mediaType, m.tmdbId);
        return String(d.title ?? d.name);
      } catch {
        return `#${x.media?.tmdbId}`;
      }
    }));
    return {
      requests: r.results.map((x: any, i: number) => ({
        id: x.id, title: titles[i], mediaType: x.type, requestedBy: byId.get(x.id) ?? x.requestedBy?.displayName ?? '?',
        status: portalStatus(x.media?.status, x.status), createdAt: x.createdAt,
      })),
    };
  }));
  for (const action of ['approve', 'decline'] as const) {
    app.post(`/api/admin/requests/:id/${action}`, admin, wrap(async (req) => {
      const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
      await ctx.seerr[action](id);
      await audit(ctx, req.user!.id, `request.${action}`, String(id));
      const m = (await ctx.db.query('select user_id, title from seerr_requests where seerr_request_id=$1', [id])).rows[0];
      if (m) await notify(ctx, { userId: m.user_id, kind: `request_${action}`, title: action === 'approve' ? `Dein Wunsch „${m.title}“ wurde freigegeben` : `Dein Wunsch „${m.title}“ wurde abgelehnt`, link: '/requests', dedupe: `req-${action}-${id}` });
      return { ok: true };
    }));
  }

  // ---- Seerr webhook (internal URL, shared secret in Authorization header or x-webhook-secret) ----
  app.post('/internal/webhook/seerr', async (req, reply) => {
    const ok = checkSecret(req, 'x-webhook-secret', ctx.cfg.WEBHOOK_SECRET) || checkSecret(req, 'authorization', ctx.cfg.WEBHOOK_SECRET);
    if (!ok) return reply.code(403).send({ error: 'forbidden' });
    const b = z.object({
      notification_type: z.string(),
      subject: z.string().optional(),
      media: z.object({ media_type: z.string().optional(), tmdbId: z.union([z.string(), z.number()]).optional() }).partial().optional(),
      request: z.object({ request_id: z.union([z.string(), z.number()]).optional() }).partial().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { notification_type: type, subject, media, request } = b.data;
    const rid = request?.request_id ? Number(request.request_id) : undefined;
    const tmdbId = media?.tmdbId ? Number(media.tmdbId) : undefined;
    const mt = media?.media_type;
    const rows = (await ctx.db.query(
      'select * from seerr_requests where seerr_request_id = $1 or (tmdb_id = $2 and media_type = $3)',
      [rid ?? -1, tmdbId ?? -1, mt ?? ''],
    )).rows;
    const title = subject ?? rows[0]?.title ?? 'Titel';
    if (type === 'MEDIA_AVAILABLE') {
      for (const r of rows) await notify(ctx, { userId: r.user_id, kind: 'available', title: `„${r.title}“ ist jetzt verfügbar`, link: '/requests', dedupe: `avail-${r.seerr_request_id}` });
      await notify(ctx, { userId: null, kind: 'available_all', title: `Neu verfügbar: ${title}`, link: '/', dedupe: `availall-${mt}-${tmdbId ?? title}`, external: true });
      if (tmdbId && mt) await seerrHooks.run(ctx, { type: 'available', tmdbId, mediaType: mt });
    } else if (type === 'MEDIA_PENDING') {
      await notify(ctx, { userId: null, kind: 'request_pending', title: `Neuer Wunsch wartet auf Freigabe: ${title}`, link: '/admin/requests', dedupe: `pending-${rid ?? title}`, external: true });
    } else if (type === 'MEDIA_DECLINED' || type === 'MEDIA_APPROVED' || type === 'MEDIA_AUTO_APPROVED') {
      for (const r of rows) await notify(ctx, { userId: r.user_id, kind: type.toLowerCase(), title: type === 'MEDIA_DECLINED' ? `Wunsch abgelehnt: ${r.title}` : `Wunsch freigegeben: ${r.title}`, link: '/requests', dedupe: `${type}-${r.seerr_request_id}` });
    }
    return { ok: true };
  });

  // ---- notifications (in-app) ----
  app.get('/api/notifications', pre, async (req) => {
    const r = await ctx.db.query(
      `select id, kind, title, body, link, created_at, (read_at is not null) as read from notifications
        where user_id = $1 or user_id is null order by created_at desc limit 30`,
      [req.user!.id],
    );
    return { notifications: r.rows };
  });
  app.post('/api/notifications/read', pre, async (req) => {
    await ctx.db.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [req.user!.id]);
    return { ok: true };
  });
}
