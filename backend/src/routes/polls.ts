import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { bus } from '../bus.js';
import type { Ctx } from '../ctx.js';
import { seerrHooks } from '../hooks.js';
import { approvePoll, createPoll, pollTick, resolveRequestedPolls } from '../polls.js';
import { notify } from '../notify.js';
import { requireAdmin, requireUser } from '../session.js';

const id32 = z.string().regex(/^[0-9a-f]{32}$/);
const optionSchema = z.object({ jfItemId: id32.optional(), tmdbId: z.number().int().positive().optional(), mediaType: z.enum(['movie', 'tv']).optional() })
  .refine((o) => Boolean(o.jfItemId) !== Boolean(o.tmdbId && o.mediaType), 'jfItemId or tmdbId+mediaType');

export function pollRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireAdmin(ctx) };

  seerrHooks.add(async (c, e) => {
    if (e.type === 'available') await resolveRequestedPolls(c);
  });

  app.post('/api/polls', pre, async (req, reply) => {
    const b = z.object({
      title: z.string().trim().min(3).max(80),
      options: z.array(optionSchema).min(2).max(10),
      closesInMinutes: z.number().int().min(5).max(7 * 24 * 60).default(60),
      startsAfterMinutes: z.number().int().min(0).max(7 * 24 * 60).default(10),
    }).parse(req.body);
    const open = await ctx.db.query("select 1 from polls where created_by=$1 and status='open'", [req.user!.id]);
    if (open.rowCount) return reply.code(409).send({ error: 'poll_already_open' });
    try {
      return { id: await createPoll(ctx, req.user!.id, b) };
    } catch {
      return reply.code(400).send({ error: 'invalid_options' });
    }
  });

  const detail = async (pollId: string, userId: string) => {
    const p = (await ctx.db.query('select p.*, u.name creator from polls p join users u on u.id=p.created_by where p.id=$1', [pollId])).rows[0];
    if (!p) return null;
    const opts = (await ctx.db.query(
      `select o.id, o.title, o.jf_item_id, o.tmdb_id, o.media_type, o.poster, count(v.user_id)::int votes
         from poll_options o left join poll_votes v on v.option_id=o.id where o.poll_id=$1 group by o.id order by o.id`, [pollId])).rows;
    const mine = (await ctx.db.query('select option_id from poll_votes where poll_id=$1 and user_id=$2', [pollId, userId])).rows[0];
    return {
      id: p.id, title: p.title, creator: p.creator, status: p.status, closesAt: p.closes_at, startsAt: p.starts_at, roomId: p.room_id, winnerOptionId: p.winner_option_id,
      myVote: mine ? Number(mine.option_id) : null,
      options: opts.map((o) => ({ id: Number(o.id), title: o.title, inLibrary: Boolean(o.jf_item_id), itemId: o.jf_item_id, tmdbId: o.tmdb_id, mediaType: o.media_type, poster: o.poster ? `/api/seerr/image${o.poster}` : undefined, votes: o.votes })),
    };
  };

  app.get('/api/polls', pre, async (req) => {
    const ids = (await ctx.db.query("select id from polls where status in ('open','scheduled','needs_approval','requested') or created_at > now() - interval '3 days' order by created_at desc limit 20")).rows;
    return { polls: (await Promise.all(ids.map((r) => detail(r.id, req.user!.id)))).filter(Boolean) };
  });
  app.get('/api/polls/:id', pre, async (req, reply) => {
    const d = await detail(z.string().uuid().parse((req.params as { id: string }).id), req.user!.id);
    return d ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post('/api/polls/:id/vote', pre, async (req, reply) => {
    const pollId = z.string().uuid().parse((req.params as { id: string }).id);
    const { optionId } = z.object({ optionId: z.number().int() }).parse(req.body);
    const ok = await ctx.db.query(
      `select 1 from polls p join poll_options o on o.poll_id=p.id where p.id=$1 and o.id=$2 and p.status='open' and p.closes_at > now()`, [pollId, optionId]);
    if (!ok.rowCount) return reply.code(409).send({ error: 'poll_closed_or_option_invalid' });
    await ctx.db.query('insert into poll_votes(poll_id,user_id,option_id) values ($1,$2,$3) on conflict (poll_id,user_id) do update set option_id=excluded.option_id', [pollId, req.user!.id, optionId]);
    return { ok: true };
  });

  app.get('/api/admin/polls', admin, async (req) => {
    const ids = (await ctx.db.query("select id from polls where status='needs_approval' order by created_at")).rows;
    return { polls: await Promise.all(ids.map((r) => detail(r.id, req.user!.id))) };
  });
  for (const [action, approve] of [['approve', true], ['reject', false]] as const) {
    app.post(`/api/admin/polls/:id/${action}`, admin, async (req, reply) => {
      const ok = await approvePoll(ctx, z.string().uuid().parse((req.params as { id: string }).id), req.user!.id, approve);
      return ok ? { ok: true } : reply.code(409).send({ error: 'not_waiting_for_approval' });
    });
  }

  // ---- ratings / reviews ----
  app.get('/api/items/:id/ratings', pre, async (req) => {
    const itemId = id32.parse((req.params as { id: string }).id);
    const r = await ctx.db.query('select u.name, r.stars, r.review, r.created_at, r.user_id = $2 mine from ratings r join users u on u.id=r.user_id where r.item_id=$1 order by r.created_at desc limit 50', [itemId, req.user!.id]);
    const avg = r.rows.length ? r.rows.reduce((a, x) => a + x.stars, 0) / r.rows.length : null;
    return { ratings: r.rows, average: avg };
  });
  app.put('/api/items/:id/rating', pre, async (req) => {
    const itemId = id32.parse((req.params as { id: string }).id);
    const b = z.object({ stars: z.number().int().min(1).max(5), review: z.string().trim().max(280).optional() }).parse(req.body);
    const item = await ctx.jf.item(req.user!, itemId);
    await ctx.db.query(
      `insert into ratings(user_id,item_id,item_name,stars,review) values ($1,$2,$3,$4,$5)
       on conflict (user_id,item_id) do update set stars=excluded.stars, review=excluded.review, created_at=now()`,
      [req.user!.id, itemId, item.name, b.stars, b.review || null],
    );
    bus.emitT('rating.created', { userId: req.user!.id });
    return { ok: true };
  });
  app.delete('/api/items/:id/rating', pre, async (req) => {
    await ctx.db.query('delete from ratings where user_id=$1 and item_id=$2', [req.user!.id, id32.parse((req.params as { id: string }).id)]);
    return { ok: true };
  });

  // ---- series calendar ----
  app.get('/api/calendar', pre, async (req) => {
    const [up, follows] = await Promise.all([
      ctx.jf.upcoming(req.user!),
      ctx.db.query<{ series_id: string }>('select series_id from series_follows where user_id=$1', [req.user!.id]),
    ]);
    const f = new Set(follows.rows.map((r) => r.series_id));
    return { items: up.map((e) => ({ ...e, followed: Boolean(e.seriesId && f.has(e.seriesId)) })) };
  });
  app.post('/api/series/:id/follow', pre, async (req) => {
    const id = id32.parse((req.params as { id: string }).id);
    const s = await ctx.jf.item(req.user!, id);
    await ctx.db.query('insert into series_follows(user_id,series_id,series_name) values ($1,$2,$3) on conflict do nothing', [req.user!.id, id, s.name]);
    return { ok: true };
  });
  app.delete('/api/series/:id/follow', pre, async (req) => {
    await ctx.db.query('delete from series_follows where user_id=$1 and series_id=$2', [req.user!.id, id32.parse((req.params as { id: string }).id)]);
    return { ok: true };
  });
  app.get('/api/series/:id/follow', pre, async (req) => ({
    followed: (await ctx.db.query('select 1 from series_follows where user_id=$1 and series_id=$2', [req.user!.id, id32.parse((req.params as { id: string }).id)])).rowCount! > 0,
  }));
  void audit;
}

/** Hourly: notify followers about episodes that aired (deduped per episode). */
export async function calendarNotifications(ctx: Ctx) {
  const users = (await ctx.db.query('select distinct u.* from users u join series_follows f on f.user_id=u.id where not u.disabled')).rows;
  for (const u of users) {
    const follows = new Set((await ctx.db.query('select series_id from series_follows where user_id=$1', [u.id])).rows.map((r) => r.series_id));
    const up = await ctx.jf.upcoming(u).catch(() => []);
    for (const e of up) {
      if (!e.seriesId || !follows.has(e.seriesId) || !e.premiereDate || new Date(e.premiereDate).getTime() > Date.now()) continue;
      await notify(ctx, { userId: u.id, kind: 'episode', title: `Neue Folge: ${e.seriesName} S${e.parentIndexNumber}E${e.indexNumber}`, body: e.name, link: `/watch/${e.id}`, dedupe: `cal-${u.id}-${e.id}` });
    }
  }
}

export { pollTick };
