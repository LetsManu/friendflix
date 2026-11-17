// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { effectiveLanguage, LANGUAGES, m } from '../i18n.js';
import { localizeStored, notify } from '../notify.js';
import { decodeCursor, feed, FEED_PAGE, feedCounts, isFeedFilter } from '../notifications/feed.js';
import { portalStatus, RequestsDisabledError, requestsClient, requestsEnabled, requestStateKey, SeerrError, viewerLanguage } from '../seerr/client.js';
import { ensureSeerrUser } from '../seerr/service.js';
import { collectionOf, partState, seasonRequestable, seasonStates } from '../seerr/states.js';
import { requireGrownUp } from '../kids.js';
import { requirePerm } from '../permGuard.js';
import { requireAdmin } from '../session.js';
import { limitFor, quota, release, reserve, resetsAt, usage } from '../requestlimit.js';
import { checkSecret } from './internal.js';
import { seerrHooks } from '../hooks.js';
import { inPool } from '../discoverData.js';
import { wrap as sharedWrap } from './_shared.js';

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

/** the season numbers of a request (the service's `seasons: [{ seasonNumber }]`), sorted; undefined for none */
const seasonList = (v: unknown): number[] | undefined => {
  const n = (Array.isArray(v) ? v : []).map((x) => x?.seasonNumber).filter((x): x is number => Number.isInteger(x) && x >= 0);
  return n.length ? [...new Set(n)].sort((a, b) => a - b) : undefined;
};

const wrap = <T extends (...a: any[]) => Promise<any>>(fn: T): T => sharedWrap(fn, { zod: 'plain', jellyfin: false, seerr: true });

/** preHandler after the sign-in checks: without a request service its routes answer 404 {error:'requests_disabled'} */
const requestsOn = (ctx: Ctx) => async () => {
  if (!requestsEnabled(ctx)) throw new RequestsDisabledError();
};

/** a TMDB poster path through the image proxy (same rule as the proxy: one file name), else undefined */
const posterOf = (p: unknown): string | undefined => (typeof p === 'string' && /^\/[A-Za-z0-9_-]{5,60}\.(jpg|png|webp)$/.test(p) ? `/api/seerr/image${p}` : undefined);

type WishOutcome =
  | { kind: 'ok'; id: number; status: string; seasons?: number[]; collection: { id: number; name: string } | null }
  | { kind: 'exists'; status: string }
  | { kind: 'bad_seasons' }
  | { kind: 'limit'; limit: number | null; used: number; resetsAt: string };

/**
 * One wish in the viewer's name (POST /api/requests and each part of POST /api/requests/batch): the title must still be open
 * (else `exists`); chosen seasons are cut to the ones the series has (none: `bad_seasons`) and that are still open (none: `exists`);
 * then a quota slot is held while the service is asked. A service failure throws (SeerrError) and frees the slot.
 */
async function createWish(ctx: Ctx, req: FastifyRequest, b: { mediaType: 'movie' | 'tv'; tmdbId: number; seasons?: number[] }): Promise<WishOutcome> {
  const d = await requestsClient(ctx).details(b.mediaType, b.tmdbId, await viewerLanguage(ctx, req)); // the title is stored for the account's request list
  const st = portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status);
  let seasons: number[] | undefined;
  if (b.mediaType === 'tv' && b.seasons) {
    const all = seasonStates(d);
    const known = new Map(all.map((x) => [x.number, x.state]));
    const asked = [...new Set(b.seasons)].filter((n) => known.has(n)).sort((x, y) => x - y);
    if (!asked.length) return { kind: 'bad_seasons' };
    seasons = asked.filter((n) => seasonRequestable(known.get(n)!));
    if (!seasons.length) return { kind: 'exists', status: st };
  } else if (st !== 'nicht_angefragt' && st !== 'abgelehnt') return { kind: 'exists', status: st };
  const user = req.user!;
  const limit = await limitFor(ctx, user);
  const slot = await reserve(ctx, user.id, limit); // atomic check + hold; a failure below must not burn it
  if (slot === null) return { kind: 'limit', limit, used: await usage(ctx, user.id), resetsAt: await resetsAt(ctx) };
  let created;
  const title = String(d.title ?? d.name ?? `#${b.tmdbId}`);
  try {
    const seerrUserId = await ensureSeerrUser(ctx, user);
    try {
      created = await requestsClient(ctx).createRequest({ mediaType: b.mediaType, mediaId: b.tmdbId, seasons: b.mediaType === 'tv' ? (seasons ?? 'all') : undefined, userId: seerrUserId });
    } catch (e) {
      if (e instanceof SeerrError && e.status === 409) return { kind: 'exists', status: st }; // somebody asked already (an older request we did not see)
      throw e;
    }
    // a 2xx without a request id: the service had nothing left to ask for (e.g. 202 "no seasons available")
    if (!Number.isInteger(created?.id)) return { kind: 'exists', status: st };
    await ctx.db.query(
      'insert into seerr_requests(seerr_request_id, user_id, media_type, tmdb_id, title, poster, seasons) values ($1,$2,$3,$4,$5,$6,$7) on conflict (seerr_request_id) do nothing',
      [created.id, user.id, b.mediaType, b.tmdbId, title, d.posterPath ?? null, seasons ?? null],
    );
  } finally {
    await release(ctx, slot);
  }
  await ctx.kv.del(`reqmine:${user.id}`).catch(() => undefined);
  const collection = b.mediaType === 'movie' ? collectionOf(d) : null;
  if (collection) await dropCollectionCache(ctx, collection.id); // the sheet of its collection shows it as asked for at once
  await audit(ctx, user.id, 'request.create', String(created.id), { title, ...(seasons ? { seasons } : {}) });
  await seerrHooks.run(ctx, { type: 'requested', user, tmdbId: b.tmdbId, mediaType: b.mediaType });
  return { kind: 'ok', id: created.id, status: portalStatus(created.media?.status, created.status), ...(seasons ? { seasons } : {}), collection };
}

/** the cached collection (titles and part states) per language: GET /api/seerr/movie/:id/collection */
const colKey = (id: number, lang: string) => `seerrcol:${id}:${lang}`;
async function dropCollectionCache(ctx: Pick<Ctx, 'kv'>, id: number) {
  for (const l of LANGUAGES) await ctx.kv.del(colKey(id, l)).catch(() => undefined);
}

/**
 * The batch's time budget: a part starts only within `startWindowMs` of the call (each service call is capped at 15 s, so the
 * answer is back within about 55 s, before the usual 60 s proxy timeout). `now` is replaceable for tests.
 */
export const BATCH_LIMITS = { startWindowMs: 25_000, now: (): number => Date.now() };

export function seerrRoutes(app: FastifyInstance, ctx: Ctx) {
  const on = requestsOn(ctx);
  // Seerr requests are for grown-ups: kids profiles get 403 kids_profile; then 404 requests_disabled without the service, then 403
  // requests_forbidden without the `requests` switch (admins always have it: the admin routes below need only `on`)
  const pre = { preHandler: [requireGrownUp(ctx), on, requirePerm(ctx, 'requests', 'requests_forbidden')] };
  // the poster proxy fetches TMDB itself: it also serves stored posters (polls, reminders) while the request service is off
  const img = { preHandler: requireGrownUp(ctx) };
  // the account's notifications (party invites, recommendations, requests ...) are not shown on kids profiles either
  const npre = { preHandler: requireGrownUp(ctx, { allowNoProfile: true }) };
  const admin = { preHandler: [requireAdmin(ctx), on] };

  app.get('/api/seerr/search', pre, wrap(async (req) => {
    const q = z.object({ q: z.string().min(2).max(100), page: z.coerce.number().int().min(1).max(10).default(1) }).parse(req.query);
    const r = await requestsClient(ctx).search(q.q, q.page, await viewerLanguage(ctx, req));
    return { results: r.results.filter((x) => x.mediaType === 'movie' || x.mediaType === 'tv').map(mapResult), totalPages: r.totalPages };
  }));

  // TMDB posters are proxied (fixed host, strict path) so browsers never contact third parties.
  app.get('/api/seerr/image/*', { ...img, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const path = '/' + String((req.params as { '*': string })['*']);
    if (!/^\/[A-Za-z0-9_-]{5,60}\.(jpg|png|webp)$/.test(path)) return reply.code(400).send({ error: 'bad_path' });
    const r = await ctx.fetchImpl(`https://image.tmdb.org/t/p/w342${path}`, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (!r.ok || !r.body) return reply.code(404).send();
    reply.header('content-type', r.headers.get('content-type') ?? 'image/jpeg').header('cache-control', 'private, max-age=86400');
    return reply.send(Readable.fromWeb(r.body as never));
  });

  app.get('/api/seerr/:type/:id/status', pre, wrap(async (req) => {
    const p = z.object({ type: mediaType, id: z.coerce.number().int().positive() }).parse(req.params);
    const d = await requestsClient(ctx).details(p.type, p.id);
    return { status: portalStatus(d.mediaInfo?.status, d.mediaInfo?.requests?.[0]?.status) };
  }));

  // Official trailer key from TMDB (via Seerr); only the validated YouTube key leaves the backend.
  app.get('/api/seerr/:type/:id/trailer', pre, wrap(async (req, reply) => {
    const p = z.object({ type: mediaType, id: z.coerce.number().int().positive() }).parse(req.params);
    const lang = await viewerLanguage(ctx, req);
    const ck = `trailer:${p.type}:${p.id}:${lang}`; // the list of videos depends on the language
    const cached = await ctx.kv.get(ck); // '' = cached "no trailer"
    let key = cached ?? '';
    if (cached === null) {
      const vids: any[] = ((await requestsClient(ctx).details(p.type, p.id, lang)) as any).relatedVideos ?? [];
      const yt = Array.isArray(vids) ? vids.filter((v) => v?.site === 'YouTube' && typeof v.key === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(v.key)) : [];
      key = (yt.find((v) => v.type === 'Trailer') ?? yt.find((v) => v.type === 'Teaser'))?.key ?? '';
      await ctx.kv.set(ck, key, 24 * 3600);
    }
    if (!key) return reply.code(404).send({ error: 'no_trailer' });
    return { key };
  }));

  // a wish: a movie, a whole series (no `seasons`, older clients) or the chosen seasons of a series. Of the chosen seasons only the
  // ones still open are asked for (a partly requested series can get more); one request is one wish of the monthly quota.
  app.post('/api/requests', pre, wrap(async (req, reply) => {
    const b = z.object({ mediaType, tmdbId: z.number().int().positive(), seasons: z.array(z.number().int().min(0).max(100)).min(1).max(101).optional() }).parse(req.body);
    const r = await createWish(ctx, req, b);
    if (r.kind === 'exists') return reply.code(409).send({ error: 'already_requested', status: r.status });
    if (r.kind === 'bad_seasons') return reply.code(400).send({ error: 'bad_seasons' });
    if (r.kind === 'limit') return reply.code(429).send({ error: 'request_limit', limit: r.limit, used: r.used, resetsAt: r.resetsAt });
    return { id: r.id, status: r.status, ...(r.seasons ? { seasons: r.seasons } : {}), ...(b.mediaType === 'movie' ? { collection: r.collection } : {}) };
  }));

  // the parts of a collection, each its own movie wish: one call (one CSRF check, one rate-limit hit) instead of up to 30. In the
  // given order, one after the other: the quota stops it part-way deterministically (the first ones go through, the rest answer
  // `limit` without a call); an upstream failure fails only that part. Every created request is audited like a single one.
  const BATCH_MAX = 30;
  const perUser = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (req: FastifyRequest) => `reqbatch:${req.user?.id ?? req.ip}` } });
  app.post('/api/requests/batch', { ...pre, config: perUser(12) }, wrap(async (req) => {
    const b = z.object({
      items: z.array(z.object({ mediaType: z.literal('movie'), tmdbId: z.number().int().positive() })).min(1).max(BATCH_MAX)
        .refine((a) => new Set(a.map((x) => x.tmdbId)).size === a.length, 'duplicate'),
      collectionId: z.number().int().positive().optional(),
    }).parse(req.body);
    type Result = 'requested' | 'exists' | 'limit' | 'failed' | 'skipped';
    const results: Array<{ tmdbId: number; result: Result; status?: string }> = [];
    // once set, every later part answers this without a call: `limit` (the quota is used up), `skipped` (the time budget is spent,
    // or the service is unreachable / failing: a timeout, a network error or a 5xx says "the service", not "this title")
    let stop: 'limit' | 'skipped' | null = null;
    const start = BATCH_LIMITS.now();
    for (const it of b.items) {
      if (!stop && BATCH_LIMITS.now() - start >= BATCH_LIMITS.startWindowMs) stop = 'skipped';
      if (stop) { results.push({ tmdbId: it.tmdbId, result: stop }); continue; }
      try {
        const r = await createWish(ctx, req, { mediaType: 'movie', tmdbId: it.tmdbId });
        if (r.kind === 'ok') results.push({ tmdbId: it.tmdbId, result: 'requested', status: r.status });
        else if (r.kind === 'exists') results.push({ tmdbId: it.tmdbId, result: 'exists', status: r.status });
        else { stop = 'limit'; results.push({ tmdbId: it.tmdbId, result: 'limit' }); }
      } catch (e) {
        req.log.warn({ err: e instanceof Error ? e.message : String(e), tmdbId: it.tmdbId }, 'batch wish failed');
        results.push({ tmdbId: it.tmdbId, result: 'failed' });
        if (!(e instanceof SeerrError) || e.status >= 500) stop = 'skipped';
      }
    }
    if (b.collectionId) await dropCollectionCache(ctx, b.collectionId);
    return { results, quota: await quota(ctx, req.user!) };
  }));

  // every season with its state, for the season picker (not cached: it is read once per opened picker and must be current)
  app.get('/api/seerr/tv/:id/seasons', pre, wrap(async (req) => {
    const p = z.object({ id: z.coerce.number().int().positive().max(2 ** 31 - 1) }).parse(req.params);
    const d = await requestsClient(ctx).details('tv', p.id, await viewerLanguage(ctx, req));
    return { tmdbId: p.id, title: String(d.name ?? d.title ?? `#${p.id}`), ...(posterOf(d.posterPath) ? { poster: posterOf(d.posterPath) } : {}), seasons: seasonStates(d) };
  }));

  // the collection a movie belongs to, its parts in release order (undated last) with their state. The movie -> collection link is
  // kept for a day, the collection itself (titles and states) for COLLECTION_TTL seconds; a batch wish with its id clears it.
  const COLLECTION_TTL = 30, COLLECTION_OF_TTL = 24 * 3600, PARTS_MAX = 30;
  app.get('/api/seerr/movie/:id/collection', pre, wrap(async (req) => {
    const p = z.object({ id: z.string().regex(/^\d{1,10}$/).transform(Number).pipe(z.number().int().positive().max(2 ** 31 - 1)) }).parse(req.params);
    const lang = await viewerLanguage(ctx, req);
    const ofKey = `seerrcolof:${p.id}`;
    let colId: number | null;
    const hit = await ctx.kv.get(ofKey).catch(() => null);
    if (hit !== null) colId = hit ? Number(hit) : null;
    else {
      colId = collectionOf(await requestsClient(ctx).details('movie', p.id, lang))?.id ?? null;
      await ctx.kv.set(ofKey, colId ? String(colId) : '', COLLECTION_OF_TTL).catch(() => undefined);
    }
    if (!colId) return { collection: null };
    const ck = colKey(colId, lang);
    const cached = await ctx.kv.get(ck).catch(() => null);
    if (cached) { try { return JSON.parse(cached); } catch { /* recompute */ } }
    const c: any = await requestsClient(ctx).collection(colId, lang);
    const today = new Date().toISOString().slice(0, 10);
    const parts = (Array.isArray(c?.parts) ? c.parts : [])
      .filter((x: any) => x && Number.isInteger(x.id) && x.id > 0 && (x.mediaType === undefined || x.mediaType === 'movie'))
      .map((x: any) => {
        const releaseDate = /^\d{4}-\d{2}-\d{2}/.test(String(x.releaseDate ?? '')) ? String(x.releaseDate).slice(0, 10) : undefined;
        return {
          tmdbId: x.id as number, title: String(x.title ?? x.name ?? `#${x.id}`), ...(releaseDate ? { year: releaseDate.slice(0, 4), releaseDate } : {}),
          ...(posterOf(x.posterPath) ? { poster: posterOf(x.posterPath) } : {}), state: partState(x.mediaInfo, releaseDate, today),
        };
      })
      .sort((a: any, b: any) => (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999') || a.title.localeCompare(b.title))
      .slice(0, PARTS_MAX);
    const body = { collection: { id: colId, name: String(c?.name ?? ''), ...(posterOf(c?.posterPath) ? { poster: posterOf(c.posterPath) } : {}), parts } };
    await ctx.kv.set(ck, JSON.stringify(body), COLLECTION_TTL).catch(() => undefined);
    return body;
  }));

  app.get('/api/requests/quota', pre, wrap(async (req) => quota(ctx, req.user!)));

  // one service call per request: at most 4 at a time, and the answer is kept for a few seconds (the page asks on every visit)
  const MINE_TTL = 20;
  app.get('/api/requests/mine', pre, wrap(async (req) => {
    const ck = `reqmine:${req.user!.id}`;
    const hit = await ctx.kv.get(ck).catch(() => null);
    if (hit) { try { return JSON.parse(hit); } catch { /* recompute */ } }
    const rows = (await ctx.db.query('select * from seerr_requests where user_id=$1 order by created_at desc limit 50', [req.user!.id])).rows;
    const out = await inPool(rows, 4, async (r) => {
      let status = 'angefragt';
      try {
        const sr = await requestsClient(ctx).getRequest(r.seerr_request_id);
        status = portalStatus(sr.media?.status, sr.status);
      } catch (e) {
        if (e instanceof SeerrError && e.status === 404) status = 'entfernt';
      }
      return { id: r.seerr_request_id, title: r.title, mediaType: r.media_type, tmdbId: r.tmdb_id, poster: r.poster ? `/api/seerr/image${r.poster}` : undefined, ...(r.seasons ? { seasons: r.seasons } : {}), status, createdAt: r.created_at };
    });
    const body = { requests: out };
    await ctx.kv.set(ck, JSON.stringify(body), MINE_TTL).catch(() => undefined);
    return body;
  }));

  // ---- admin approval ----
  app.get('/api/admin/requests', admin, wrap(async (req) => {
    const q = z.object({
      filter: z.enum(['pending', 'approved', 'processing', 'available', 'all']).default('pending'),
      take: z.coerce.number().int().min(1).max(100).default(50),
      skip: z.coerce.number().int().min(0).max(100_000).default(0),
    }).parse(req.query);
    const lang = await viewerLanguage(ctx, req);
    const r = await requestsClient(ctx).listRequests(q.filter, q.take, q.skip);
    const ids = r.results.map((x: any) => x.id);
    const owners = ids.length ? (await ctx.db.query('select s.seerr_request_id id, u.name from seerr_requests s join users u on u.id=s.user_id where s.seerr_request_id = any($1)', [ids])).rows : [];
    const byId = new Map(owners.map((o: any) => [o.id, o.name]));
    const titles = await Promise.all(r.results.map(async (x: any) => {
      try {
        const m = x.media ?? {};
        const d = await requestsClient(ctx).details(x.type ?? m.mediaType, m.tmdbId, lang);
        return String(d.title ?? d.name);
      } catch {
        return `#${x.media?.tmdbId}`;
      }
    }));
    return {
      // `status` is the legacy portal literal (German); `statusKey` is the language-neutral key the admin UI translates
      requests: r.results.map((x: any, i: number) => ({
        id: x.id, title: titles[i], mediaType: x.type, ...(seasonList(x.seasons) ? { seasons: seasonList(x.seasons) } : {}), requestedBy: byId.get(x.id) ?? x.requestedBy?.displayName ?? '?',
        status: portalStatus(x.media?.status, x.status), statusKey: requestStateKey(x.media?.status, x.status), createdAt: x.createdAt,
      })),
      total: Number(r.pageInfo?.results ?? r.results.length),
    };
  }));
  for (const action of ['approve', 'decline'] as const) {
    app.post(`/api/admin/requests/:id/${action}`, admin, wrap(async (req) => {
      const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
      await requestsClient(ctx)[action](id);
      await audit(ctx, req.user!.id, `request.${action}`, String(id));
      const row = (await ctx.db.query('select user_id, title from seerr_requests where seerr_request_id=$1', [id])).rows[0];
      if (row) await notify(ctx, { userId: row.user_id, kind: `request_${action}`, title: m(action === 'approve' ? 'request.approved' : 'request.declined', { title: row.title }), link: '/requests', dedupe: `req-${action}-${id}` });
      return { ok: true };
    }));
  }

  // ---- request service webhook (internal URL, shared secret in Authorization header or x-webhook-secret) ----
  // /internal/webhook/requests is the documented path; the old /internal/webhook/seerr keeps working for existing setups
  const requestWebhook = async (req: FastifyRequest, reply: FastifyReply) => {
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
    // the tmdb fallback is only right for "available" (everyone who wanted the title); approve/decline are per request
    const rows = (await ctx.db.query(
      type === 'MEDIA_AVAILABLE'
        ? 'select * from seerr_requests where seerr_request_id = $1 or (tmdb_id = $2 and media_type = $3)'
        : 'select * from seerr_requests where seerr_request_id = $1',
      type === 'MEDIA_AVAILABLE' ? [rid ?? -1, tmdbId ?? -1, mt ?? ''] : [rid ?? -1],
    )).rows;
    const named: string | undefined = subject ?? rows[0]?.title;
    const title = named ?? m('title.fallback');
    const dedupeTitle = named ?? 'Titel';
    if (type === 'MEDIA_AVAILABLE') {
      // the requester's own notice is also a mail (type `available`); the broadcast below is never mailed
      for (const r of rows) await notify(ctx, { userId: r.user_id, kind: 'available', title: m('title.available', { title: r.title }), link: '/requests', dedupe: `avail-${r.seerr_request_id}`, mail: 'available' });
      await notify(ctx, { userId: null, kind: 'available_all', title: m('title.availableAll', { title }), link: '/', dedupe: `availall-${mt}-${tmdbId ?? dedupeTitle}`, external: true });
      if (tmdbId && mt) await seerrHooks.run(ctx, { type: 'available', tmdbId, mediaType: mt });
    } else if (type === 'MEDIA_PENDING') {
      await notify(ctx, { userId: null, kind: 'request_pending', title: m('request.pending', { title }), link: '/admin/requests', dedupe: `pending-${rid ?? dedupeTitle}`, external: true });
    } else if (type === 'MEDIA_DECLINED' || type === 'MEDIA_APPROVED' || type === 'MEDIA_AUTO_APPROVED') {
      for (const r of rows) await notify(ctx, { userId: r.user_id, kind: type.toLowerCase(), title: m(type === 'MEDIA_DECLINED' ? 'request.declinedShort' : 'request.approvedShort', { title: r.title }), link: '/requests', dedupe: `${type}-${r.seerr_request_id}` });
    }
    return { ok: true };
  };
  app.post('/internal/webhook/requests', requestWebhook);
  app.post('/internal/webhook/seerr', requestWebhook);

  // ---- notifications (in-app) ----
  app.get('/api/notifications', npre, async (req) => {
    const r = await ctx.db.query(
      `select n.id, n.kind, n.title, n.body, n.link, n.created_at, n.msg,
              (case when n.user_id is null then coalesce(n.created_at <= u.notifications_read_at, false) else n.read_at is not null end) as read
         from notifications n, users u
        where u.id = $1 and (n.user_id = $1 or n.user_id is null) order by n.created_at desc limit 30`,
      [req.user!.id],
    );
    const lang = await effectiveLanguage(ctx, req.profile?.id ?? req.user!.id);
    return { notifications: r.rows.map((row) => localizeStored(row as { title: string; body: string | null; msg: unknown }, lang)) };
  });
  // the notifications center: grouped sections in the viewer's time zone, paged by groups; limit=0 answers only the counts (bell badge)
  app.get('/api/notifications/feed', npre, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const filter = q.filter === undefined || q.filter === '' ? 'all' : q.filter;
    if (typeof filter !== 'string' || !isFeedFilter(filter)) return reply.code(400).send({ error: 'invalid_filter' });
    const cursor = q.cursor === undefined || q.cursor === '' ? null : q.cursor;
    if (cursor !== null && (typeof cursor !== 'string' || !decodeCursor(cursor))) return reply.code(400).send({ error: 'invalid_cursor' });
    const limit = q.limit === undefined || q.limit === '' ? FEED_PAGE : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 0) return reply.code(400).send({ error: 'bad_request' });
    if (limit === 0) return feedCounts(ctx, req.user!.id);
    const lang = await effectiveLanguage(ctx, req.profile?.id ?? req.user!.id);
    return feed(ctx, req.user!.id, lang, { tz: typeof q.tz === 'string' ? q.tz : '', filter, cursor, limit: Math.min(limit, FEED_PAGE) });
  });
  app.post('/api/notifications/read', npre, async (req) => {
    await ctx.db.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [req.user!.id]);
    await ctx.db.query('update users set notifications_read_at = now() where id = $1', [req.user!.id]);
    return { ok: true };
  });
}
