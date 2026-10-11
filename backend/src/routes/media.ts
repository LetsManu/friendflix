import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import { clearLive, countLive, getLive, listLive, setLive } from '../live.js';
import { effectiveRole } from '../roles.js';
import { requireUser } from '../session.js';
import { playbackHooks } from '../hooks.js';
import { tidyResume } from '../resume.js';

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
  genre: z.string().max(300).optional(), // several genres separated by | (Jellyfin: any of)
  studio: z.string().max(80).optional(),
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

  app.get('/api/library/views', pre, wrap(async (req) => ({ items: await ctx.jf.views(req.jfUser!) })));

  app.get('/api/library/items', pre, wrap(async (req) => {
    const q = listQuery.parse(req.query);
    return ctx.jf.items(req.jfUser!, { ...q, desc: q.desc === 'true' });
  }));

  app.get('/api/library/genres', pre, wrap(async (req) => ({ genres: await ctx.jf.genres(req.jfUser!) })));

  // "Überrasch mich": one random title, optionally by type/genre, unwatched by default.
  app.get('/api/library/random', pre, wrap(async (req, reply) => {
    const q = z.object({
      type: z.enum(['Movie', 'Series']).default('Movie'),
      genre: z.string().max(300).optional(), // several genres separated by | (Jellyfin: any of)
      unplayed: z.enum(['true', 'false']).default('true'),
    }).parse(req.query);
    const r = await ctx.jf.items(req.jfUser!, { types: q.type, genre: q.genre, sort: 'Random', limit: 1, filter: q.unplayed === 'true' ? 'unplayed' : undefined });
    return r.items[0] ? { item: r.items[0] } : reply.code(404).send({ error: 'nothing_found' });
  }));

  app.get('/api/library/resume', pre, wrap(async (req) => {
    const items = await ctx.jf.resume(req.jfUser!);
    const h = await ctx.db.query<{ item_id: string; hidden_at: Date }>('select item_id, hidden_at from resume_hidden where profile_id=$1', [req.profile!.id]);
    return { items: tidyResume(items, new Map(h.rows.map((r) => [r.item_id, r.hidden_at]))) };
  }));
  // "Remove from Weiterschauen": hides the item for this profile until it is played again (progress itself stays).
  app.delete('/api/library/resume/:id', pre, wrap(async (req) => {
    await ctx.db.query(
      'insert into resume_hidden(profile_id,item_id) values ($1,$2) on conflict (profile_id,item_id) do update set hidden_at=now()',
      [req.profile!.id, itemId.parse((req.params as any).id)],
    );
    return { ok: true };
  }));

  // Viewing history (Jellyfin played items + in-progress), removal marks unplayed.
  app.get('/api/history', pre, wrap(async (req) => {
    const q = z.object({ start: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return { items: await ctx.jf.history(req.jfUser!, q) };
  }));
  app.delete('/api/history/:id', pre, wrap(async (req) => {
    const id = itemId.parse((req.params as any).id);
    const { scope } = z.object({ scope: z.enum(['item', 'series']).default('item') }).parse(req.query);
    let target = id;
    if (scope === 'series') {
      const it = await ctx.jf.item(req.jfUser!, id);
      if (it.seriesId) target = it.seriesId;
    }
    await ctx.jf.setPlayed(req.jfUser!, target, false); // Jellyfin cascades unplayed to a series' episodes
    await ctx.db.query('delete from resume_hidden where profile_id=$1 and item_id in ($2,$3)', [req.profile!.id, id, target]);
    return { ok: true };
  }));
  app.get('/api/library/nextup', pre, wrap(async (req) => ({ items: await ctx.jf.nextUp(req.jfUser!) })));

  app.get('/api/items/:id', pre, wrap(async (req) => {
    const id = itemId.parse((req.params as any).id);
    const item = await ctx.jf.item(req.jfUser!, id);
    const inWatchlist = (await ctx.db.query('select 1 from watchlist where profile_id=$1 and item_id=$2', [req.profile!.id, id])).rowCount! > 0;
    const th = await ctx.db.query<{ value: number }>('select value from thumbs where profile_id=$1 and item_id=$2', [req.profile!.id, id]);
    return { item, inWatchlist, thumb: th.rows[0]?.value ?? 0 };
  }));
  app.get('/api/items/:id/segments', pre, wrap(async (req) => ({ segments: await ctx.jf.segments(req.jfUser!, itemId.parse((req.params as any).id)) })));
  app.get('/api/items/:id/similar', pre, wrap(async (req) => ({ items: await ctx.jf.similar(req.jfUser!, itemId.parse((req.params as any).id)) })));
  app.get('/api/library/because', pre, wrap(async (req) => {
    const up = (await ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value=1 order by created_at desc limit 1', [req.profile!.id])).rows[0];
    const seed = up ? await ctx.jf.item(req.jfUser!, up.item_id).catch(() => null) : null;
    const base = seed ?? (await ctx.jf.lastWatched(req.jfUser!));
    if (!base) return { because: null, items: [] };
    const down = new Set((await ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value=-1', [req.profile!.id])).rows.map((r) => r.item_id));
    return { because: { id: base.id, name: base.name, liked: Boolean(seed) }, items: (await ctx.jf.similar(req.jfUser!, base.id)).filter((i) => i.id !== base.id && !down.has(i.id)) };
  }));
  app.get('/api/items/:id/seasons', pre, wrap(async (req) => ({ items: await ctx.jf.seasons(req.jfUser!, itemId.parse((req.params as any).id)) })));
  app.get('/api/items/:id/episodes', pre, wrap(async (req) => {
    const seasonId = z.object({ seasonId: itemId.optional() }).parse(req.query).seasonId;
    return { items: await ctx.jf.episodes(req.jfUser!, itemId.parse((req.params as any).id), seasonId) };
  }));

  for (const [path, fn] of [
    ['favorite', 'setFavorite'],
    ['played', 'setPlayed'],
  ] as const) {
    app.post(`/api/items/:id/${path}`, pre, wrap(async (req) => { await ctx.jf[fn](req.jfUser!, itemId.parse((req.params as any).id), true); return { ok: true }; }));
    app.delete(`/api/items/:id/${path}`, pre, wrap(async (req) => { await ctx.jf[fn](req.jfUser!, itemId.parse((req.params as any).id), false); return { ok: true }; }));
  }

  // Watchlist lives in Postgres (Jellyfin has no equivalent).
  app.get('/api/watchlist', pre, wrap(async (req) => {
    const r = await ctx.db.query<{ item_id: string }>('select item_id from watchlist where profile_id=$1 order by added_at desc limit 200', [req.profile!.id]);
    if (!r.rows.length) return { items: [] };
    return { items: (await ctx.jf.items(req.jfUser!, { ids: r.rows.map((x) => x.item_id), types: 'Movie,Series,Episode', limit: 200 })).items };
  }));
  // Lightweight id list so cards can show the "Meine Liste" state without loading every item.
  app.get('/api/watchlist/ids', pre, async (req) => ({
    ids: (await ctx.db.query<{ item_id: string }>('select item_id from watchlist where profile_id=$1', [req.profile!.id])).rows.map((r) => r.item_id),
  }));
  app.post('/api/items/:id/watchlist', pre, wrap(async (req) => {
    await ctx.db.query('insert into watchlist(profile_id,user_id,item_id) values ($1,$2,$3) on conflict do nothing', [req.profile!.id, req.user!.id, itemId.parse((req.params as any).id)]);
    return { ok: true };
  }));
  app.delete('/api/items/:id/watchlist', pre, wrap(async (req) => {
    await ctx.db.query('delete from watchlist where profile_id=$1 and item_id=$2', [req.profile!.id, itemId.parse((req.params as any).id)]);
    return { ok: true };
  }));

  // ---- Playback ----
  app.post('/api/playback/info', pre, wrap(async (req, reply) => {
    const b = z.object({ itemId, startTicks: z.number().int().min(0).optional(), audioIndex: z.number().int().min(0).optional(), maxBitrate: z.number().int().min(300_000).max(200_000_000).optional() }).parse(req.body);
    const role = (await effectiveRole(ctx, req.user!.role))!;
    if ((await countLive(ctx, req.user!.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    const startTicks = b.startTicks ?? (await ctx.jf.item(req.jfUser!, b.itemId)).positionTicks;
    const cap = Math.min(role.maxBitrate, b.maxBitrate ?? role.maxBitrate); // the viewer may lower the quality, never raise it above the role limit
    const info = await ctx.jf.playbackInfo(req.jfUser!, b.itemId, { maxBitrate: cap, maxHeight: role.maxHeight, startTicks, audioIndex: b.audioIndex });
    info.roleMaxBitrate = role.maxBitrate;
    info.trickplay = await ctx.jf.trickplay(req.jfUser!, b.itemId, info.mediaSourceId);
    return info;
  }));

  const report = (kind: 'Playing' | 'Playing/Progress' | 'Playing/Stopped') =>
    wrap(async (req: any, reply: any) => {
      const b = reportBody.parse(req.body);
      const user = req.user!;
      const ticks = Math.floor(b.positionTicks);
      let live = await getLive(ctx, user.id, b.playSessionId);
      let elapsed = true;
      if (!live) {
        // Start takes a stream slot. Progress/Stopped after TTL expiry are still forwarded (a sleeping tab must not lose its position)
        // and rebuild the live record without counting against maxStreams.
        if (kind === 'Playing') {
          const role = (await effectiveRole(ctx, user.role))!;
          if ((await countLive(ctx, user.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
        }
        const item = await ctx.jf.item(req.jfUser!, b.itemId); // access check: the user must be able to see the item
        elapsed = false;
        live = {
          userId: user.id, userName: user.name, profileName: req.profile?.is_owner ? undefined : req.profile?.name, itemId: b.itemId, title: item.name, seriesName: item.seriesName, type: item.type,
          positionTicks: ticks, runtimeTicks: item.runtimeTicks, isPaused: false, playSessionId: b.playSessionId, updatedAt: Date.now(), source: 'portal',
        };
      }
      const prev = live.updatedAt;
      live = { ...live, positionTicks: ticks, isPaused: b.isPaused, updatedAt: Date.now() };
      await ctx.jf.report(req.jfUser!, kind, {
        ItemId: b.itemId, MediaSourceId: b.mediaSourceId, PlaySessionId: b.playSessionId, PositionTicks: ticks, IsPaused: b.isPaused,
        AudioStreamIndex: b.audioIndex, SubtitleStreamIndex: b.subtitleIndex, PlayMethod: b.playMethod ?? 'DirectStream',
      });
      if (kind === 'Playing/Stopped') await clearLive(ctx, user.id, b.playSessionId);
      else await setLive(ctx, live);
      await playbackHooks.run(ctx, { kind, user, live, elapsedMs: elapsed ? Math.min(Date.now() - prev, 30_000) : 0 });
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
