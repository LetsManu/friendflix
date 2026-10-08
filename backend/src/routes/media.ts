import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import { clearLive, countLive, getLive, listLive, setLive } from '../live.js';
import { requireUser } from '../session.js';
import { playbackHooks } from '../hooks.js';

const itemId = z.string().transform((s) => s.replace(/-/g, '').toLowerCase()).pipe(z.string().regex(/^[0-9a-f]{32}$/));
const psId = z.string().regex(/^[\w-]{8,64}$/);

const listQuery = z.object({
  parentId: itemId.optional(),
  q: z.string().max(100).optional(),
  types: z.string().regex(/^[A-Za-z,]+$/).max(80).optional(),
  sort: z.enum(['SortName', 'DateCreated', 'PremiereDate', 'CommunityRating', 'Random']).optional(),
  desc: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  start: z.coerce.number().int().min(0).optional(),
  filter: z.enum(['favorites', 'unplayed', 'played']).optional(),
  genre: z.string().max(60).optional(),
});

const reportBody = z.object({
  itemId,
  playSessionId: psId,
  mediaSourceId: z.string().regex(/^[\w-]{1,64}$/),
  positionTicks: z.number().int().min(0),
  isPaused: z.boolean().default(false),
  audioIndex: z.number().int().optional(),
  subtitleIndex: z.number().int().optional(),
  playMethod: z.enum(['DirectPlay', 'DirectStream', 'Transcode']).optional(),
});

/** Maps upstream errors to a clean 502/4xx without leaking details. */
function wrap<T extends (...a: any[]) => Promise<any>>(fn: T): T {
  return (async (req: any, reply: any) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof z.ZodError) return reply.code(400).send({ error: 'bad_request', issues: e.issues.map((i) => i.path.join('.')) });
      if (e instanceof JellyfinError) return reply.code(e.status === 404 ? 404 : e.status === 403 ? 403 : 502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  }) as T;
}

export function mediaRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  app.get('/api/library/views', pre, wrap(async (req) => ({ items: await ctx.jf.views(req.user!) })));

  app.get('/api/library/items', pre, wrap(async (req) => {
    const q = listQuery.parse(req.query);
    return ctx.jf.items(req.user!, { ...q, desc: q.desc === 'true' });
  }));

  app.get('/api/library/resume', pre, wrap(async (req) => ({ items: await ctx.jf.resume(req.user!) })));
  app.get('/api/library/nextup', pre, wrap(async (req) => ({ items: await ctx.jf.nextUp(req.user!) })));

  app.get('/api/items/:id', pre, wrap(async (req) => {
    const id = itemId.parse((req.params as any).id);
    const item = await ctx.jf.item(req.user!, id);
    const inWatchlist = (await ctx.db.query('select 1 from watchlist where user_id=$1 and item_id=$2', [req.user!.id, id])).rowCount! > 0;
    return { item, inWatchlist };
  }));
  app.get('/api/items/:id/seasons', pre, wrap(async (req) => ({ items: await ctx.jf.seasons(req.user!, itemId.parse((req.params as any).id)) })));
  app.get('/api/items/:id/episodes', pre, wrap(async (req) => {
    const seasonId = z.object({ seasonId: itemId.optional() }).parse(req.query).seasonId;
    return { items: await ctx.jf.episodes(req.user!, itemId.parse((req.params as any).id), seasonId) };
  }));

  for (const [path, fn] of [
    ['favorite', 'setFavorite'],
    ['played', 'setPlayed'],
  ] as const) {
    app.post(`/api/items/:id/${path}`, pre, wrap(async (req) => { await ctx.jf[fn](req.user!, itemId.parse((req.params as any).id), true); return { ok: true }; }));
    app.delete(`/api/items/:id/${path}`, pre, wrap(async (req) => { await ctx.jf[fn](req.user!, itemId.parse((req.params as any).id), false); return { ok: true }; }));
  }

  // Watchlist lives in Postgres (Jellyfin has no equivalent).
  app.get('/api/watchlist', pre, wrap(async (req) => {
    const r = await ctx.db.query<{ item_id: string }>('select item_id from watchlist where user_id=$1 order by added_at desc limit 200', [req.user!.id]);
    if (!r.rows.length) return { items: [] };
    return { items: (await ctx.jf.items(req.user!, { ids: r.rows.map((x) => x.item_id), types: 'Movie,Series,Episode', limit: 200 })).items };
  }));
  app.post('/api/items/:id/watchlist', pre, wrap(async (req) => {
    await ctx.db.query('insert into watchlist(user_id,item_id) values ($1,$2) on conflict do nothing', [req.user!.id, itemId.parse((req.params as any).id)]);
    return { ok: true };
  }));
  app.delete('/api/items/:id/watchlist', pre, wrap(async (req) => {
    await ctx.db.query('delete from watchlist where user_id=$1 and item_id=$2', [req.user!.id, itemId.parse((req.params as any).id)]);
    return { ok: true };
  }));

  // ---- Playback ----
  app.post('/api/playback/info', pre, wrap(async (req, reply) => {
    const b = z.object({ itemId, startTicks: z.number().int().min(0).optional(), audioIndex: z.number().int().min(0).optional() }).parse(req.body);
    const role = ctx.roles[req.user!.role]!;
    if ((await countLive(ctx, req.user!.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    const startTicks = b.startTicks ?? (await ctx.jf.item(req.user!, b.itemId)).positionTicks;
    return ctx.jf.playbackInfo(req.user!, b.itemId, { maxBitrate: role.maxBitrate, startTicks, audioIndex: b.audioIndex });
  }));

  const report = (kind: 'Playing' | 'Playing/Progress' | 'Playing/Stopped') =>
    wrap(async (req: any, reply: any) => {
      const b = reportBody.parse(req.body);
      const user = req.user!;
      const ticks = Math.floor(b.positionTicks);
      let live = await getLive(ctx, user.id, b.playSessionId);
      if (!live) {
        if (kind !== 'Playing') return reply.code(204).send(); // stale report after TTL/stop
        const role = ctx.roles[user.role]!;
        if ((await countLive(ctx, user.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
        const item = await ctx.jf.item(user, b.itemId);
        live = {
          userId: user.id, userName: user.name, itemId: b.itemId, title: item.name, seriesName: item.seriesName, type: item.type,
          positionTicks: ticks, runtimeTicks: item.runtimeTicks, isPaused: false, playSessionId: b.playSessionId, updatedAt: Date.now(), source: 'portal',
        };
      }
      const prev = live.updatedAt;
      live = { ...live, positionTicks: ticks, isPaused: b.isPaused, updatedAt: Date.now() };
      await ctx.jf.report(user, kind, {
        ItemId: b.itemId, MediaSourceId: b.mediaSourceId, PlaySessionId: b.playSessionId, PositionTicks: ticks, IsPaused: b.isPaused,
        AudioStreamIndex: b.audioIndex, SubtitleStreamIndex: b.subtitleIndex, PlayMethod: b.playMethod ?? 'DirectStream',
      });
      if (kind === 'Playing/Stopped') await clearLive(ctx, user.id, b.playSessionId);
      else await setLive(ctx, live);
      await playbackHooks.run(ctx, { kind, user, live, elapsedMs: Math.min(Date.now() - prev, 30_000) });
      return { ok: true };
    });
  app.post('/api/playback/start', pre, report('Playing'));
  app.post('/api/playback/progress', pre, report('Playing/Progress'));
  app.post('/api/playback/stop', pre, report('Playing/Stopped'));

  app.get('/api/nowplaying', pre, async () => ({
    items: (await listLive(ctx)).map((l) => ({
      user: l.userName, itemId: l.itemId, title: l.title, seriesName: l.seriesName,
      positionTicks: l.positionTicks, runtimeTicks: l.runtimeTicks, isPaused: l.isPaused,
    })),
  }));
}
