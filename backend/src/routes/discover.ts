import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import type { ItemDto } from '../jellyfin/dto.js';
import { notify } from '../notify.js';
import { loadPrefs } from './prefs.js';
import { requireUser } from '../session.js';
import { SeerrError, portalStatus } from '../seerr/client.js';
import type { UserRow } from '../types.js';

const id32 = z.string().transform((s) => s.replace(/-/g, '').toLowerCase()).pipe(z.string().regex(/^[0-9a-f]{32}$/));

function wrap<T extends (...a: any[]) => Promise<any>>(fn: T): T {
  return (async (req: any, reply: any) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof JellyfinError) return reply.code(e.status === 404 ? 404 : 502).send({ error: 'jellyfin', status: e.status });
      if (e instanceof SeerrError) return reply.code(502).send({ error: 'seerr', status: e.status });
      throw e;
    }
  }) as T;
}

/** Fetches items by id in chunks (keeps URLs short) with the viewer's own token, so library permissions apply. */
async function itemsByIds(ctx: Ctx, user: UserRow, ids: string[]): Promise<ItemDto[]> {
  const out: ItemDto[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const r = await ctx.jf.items(user, { ids: ids.slice(i, i + 40), types: 'Movie,Series,Episode,BoxSet', limit: 40 }).catch(() => ({ items: [] as ItemDto[] }));
    out.push(...r.items);
  }
  const byId = new Map(out.map((i) => [i.id, i]));
  return ids.map((i) => byId.get(i)).filter((x): x is ItemDto => Boolean(x)); // keep the requested order
}

export function discoverRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  // ---- Group matcher: "what has none of us watched yet?" (opt-in per participant) ----
  app.get('/api/friends', pre, async (req) => {
    const r = await ctx.db.query<{ id: string; name: string; share: boolean | null }>(
      `select u.id, u.name, (p.data->>'shareHistory')::boolean as share from users u left join user_prefs p on p.user_id = u.id where u.id <> $1 and not u.disabled order by u.name`,
      [req.user!.id],
    );
    return { friends: r.rows.map((f) => ({ id: f.id, name: f.name, sharesHistory: f.share === true })) };
  });

  app.post('/api/match', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, wrap(async (req, reply) => {
    const b = z.object({
      userIds: z.array(z.string().uuid()).min(1).max(7),
      type: z.enum(['Movie', 'Series', 'Both']).default('Movie'),
      maxMinutes: z.number().int().min(20).max(400).optional(),
      genre: z.string().max(60).optional(),
    }).parse(req.body);
    const ids = [...new Set(b.userIds.filter((i) => i !== req.user!.id))];
    if (!ids.length) return reply.code(400).send({ error: 'need_other_participants' });
    const others = (await ctx.db.query<UserRow>('select * from users where id = any($1) and not disabled', [ids])).rows;
    if (others.length !== ids.length) return reply.code(400).send({ error: 'unknown_participant' });
    const notShared: string[] = [];
    for (const u of others) if (!(await loadPrefs(ctx, u.id)).shareHistory) notShared.push(u.name);
    if (notShared.length) return reply.code(403).send({ error: 'history_not_shared', names: notShared });

    const types = b.type === 'Both' ? 'Movie,Series' : b.type;
    const everyone = [req.user!, ...others];
    const sets = await Promise.all(everyone.map((u) => ctx.jf.unplayedIds(u, types)));
    let common = [...sets[0]!].filter((id) => sets.every((s) => s.has(id)));
    const total = common.length;
    // details + filters with the requester's token; sort by rating
    const details = await itemsByIds(ctx, req.user!, common.slice(0, 400));
    let items = details;
    if (b.maxMinutes) items = items.filter((i) => !i.runtimeTicks || i.runtimeTicks <= b.maxMinutes! * 600_000_000);
    if (b.genre) items = items.filter((i) => i.genres.includes(b.genre!));
    items.sort((a, c) => (c.communityRating ?? 0) - (a.communityRating ?? 0) || a.name.localeCompare(c.name));
    common = [];
    return { participants: everyone.map((u) => u.name), total, items: items.slice(0, 40) };
  }));

  // ---- Recommend to friends / "Von Freunden empfohlen" ----
  app.post('/api/recommend', pre, wrap(async (req, reply) => {
    const b = z.object({ itemId: id32, toUserIds: z.array(z.string().uuid()).min(1).max(10), note: z.string().trim().max(140).optional() }).parse(req.body);
    const item = await ctx.jf.item(req.user!, b.itemId); // proves the sender can see it
    const targets = (await ctx.db.query<{ id: string }>('select id from users where id = any($1) and id <> $2 and not disabled', [b.toUserIds, req.user!.id])).rows;
    let sent = 0;
    for (const t of targets) {
      const dup = await ctx.db.query("select 1 from recommendations where from_user=$1 and to_user=$2 and item_id=$3 and created_at > now() - interval '7 days'", [req.user!.id, t.id, item.id]);
      if (dup.rowCount) continue;
      await ctx.db.query('insert into recommendations(from_user,to_user,item_id,item_name,note) values ($1,$2,$3,$4,$5)', [req.user!.id, t.id, item.id, item.name, b.note || null]);
      await notify(ctx, { userId: t.id, kind: 'recommend', title: `${req.user!.name} empfiehlt dir „${item.name}“`, body: b.note, link: `/item/${item.id}` });
      sent++;
    }
    if (!sent && targets.length) return reply.code(409).send({ error: 'already_recommended' });
    return { sent };
  }));

  app.get('/api/recommendations', pre, wrap(async (req) => {
    const rows = (await ctx.db.query<{ item_id: string; note: string | null; from_name: string }>(
      `select r.item_id, r.note, u.name from_name from recommendations r join users u on u.id=r.from_user
        where r.to_user=$1 and r.created_at > now() - interval '60 days' order by r.seen, r.created_at desc limit 30`, [req.user!.id])).rows;
    const items = await itemsByIds(ctx, req.user!, [...new Set(rows.map((r) => r.item_id))]);
    const meta = new Map(rows.map((r) => [r.item_id, `Von ${r.from_name}${r.note ? `: ${r.note}` : ''}`]));
    return { items: items.map((i) => ({ ...i, caption: meta.get(i.id) })) };
  }));
  app.post('/api/recommendations/seen', pre, async (req) => {
    await ctx.db.query('update recommendations set seen = true where to_user = $1', [req.user!.id]);
    return { ok: true };
  });

  app.get('/api/library/friends-rated', pre, wrap(async (req) => {
    const rows = (await ctx.db.query<{ item_id: string; names: string[]; avg: string }>(
      `select r.item_id, array_agg(u.name || ' ' || r.stars || '★' order by r.created_at desc) names, avg(r.stars) avg
         from ratings r join users u on u.id = r.user_id left join user_prefs p on p.user_id = r.user_id
        where r.user_id <> $1 and r.stars >= 4 and r.created_at > now() - interval '90 days' and not u.disabled
          and coalesce((p.data->>'shareRatings')::boolean, true)
          and r.item_id not in (select item_id from ratings where user_id = $1)
          and r.item_id not in (select item_id from thumbs where user_id = $1 and value = -1)
        group by r.item_id order by max(r.created_at) desc limit 24`, [req.user!.id])).rows;
    const items = await itemsByIds(ctx, req.user!, rows.map((r) => r.item_id));
    const cap = new Map(rows.map((r) => [r.item_id, r.names.slice(0, 2).join(', ')]));
    return { items: items.filter((i) => !i.played).map((i) => ({ ...i, caption: cap.get(i.id) })) };
  }));

  // ---- Thumbs up / down (feeds "Weil du ... gesehen hast") ----
  app.put('/api/items/:id/thumb', pre, wrap(async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const { value } = z.object({ value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }).parse(req.body);
    if (value === 0) {
      await ctx.db.query('delete from thumbs where user_id=$1 and item_id=$2', [req.user!.id, id]);
      return { value: 0 };
    }
    const item = await ctx.jf.item(req.user!, id);
    await ctx.db.query(
      `insert into thumbs(user_id,item_id,value,item_name) values ($1,$2,$3,$4)
       on conflict (user_id,item_id) do update set value = excluded.value, created_at = now()`,
      [req.user!.id, id, value, item.name],
    );
    return { value };
  }));

  // ---- X-Ray (cast), extras, hover trailer, collections, studios ----
  app.get('/api/items/:id/people', pre, wrap(async (req) => ({ people: await ctx.jf.people(req.user!, id32.parse((req.params as { id: string }).id)) })));
  app.get('/api/items/:id/extras', pre, wrap(async (req) => ({ items: await ctx.jf.extras(req.user!, id32.parse((req.params as { id: string }).id)) })));
  app.get('/api/items/:id/trailer', pre, wrap(async (req, reply) => {
    if (!(await loadPrefs(ctx, req.user!.id)).hoverTrailers) return reply.code(404).send({ error: 'disabled' });
    const id = id32.parse((req.params as { id: string }).id);
    const t = await ctx.jf.trailer(req.user!, id);
    if (!t) return reply.code(404).send({ error: 'no_trailer' });
    // low-bitrate HLS: always playable in browsers, capped by the gateway; no playback reporting, not counted as a stream
    const p = new URLSearchParams({ MediaSourceId: t, DeviceId: ctx.jf.deviceId(req.user!), VideoCodec: 'h264', AudioCodec: 'aac', SegmentContainer: 'ts', MinSegments: '1', BreakOnNonKeyFrames: 'true', TranscodingMaxAudioChannels: '2', MaxStreamingBitrate: '1500000' });
    return { url: `/media/Videos/${t}/master.m3u8?${p}` };
  }));
  app.get('/api/library/collections', pre, wrap(async (req) => ({ items: await ctx.jf.collections(req.user!), studios: await ctx.jf.studios(req.user!).catch(() => []) })));

  // ---- Upcoming (Seerr discover) with wish status ----
  app.get('/api/seerr/upcoming', pre, wrap(async (req) => {
    const type = z.enum(['movie', 'tv']).default('movie').parse((req.query as { type?: string }).type);
    const r = await ctx.seerr.upcoming(type);
    return {
      results: r.results.slice(0, 30).map((x: any) => ({
        tmdbId: x.id as number, mediaType: type, title: String(x.title ?? x.name ?? ''), releaseDate: (x.releaseDate ?? x.firstAirDate) as string | undefined,
        overview: x.overview as string | undefined, poster: x.posterPath ? `/api/seerr/image${x.posterPath}` : undefined,
        status: portalStatus(x.mediaInfo?.status, x.mediaInfo?.requests?.[0]?.status),
      })),
    };
  }));
}
