import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { digestSchedule, sendDigest, type DigestData } from '../digest.js';
import { requireAdmin, requireUser } from '../session.js';
import type { JfUser } from '../types.js';

/** Ids the viewer's own Jellyfin user may see (library permissions of the active profile apply). */
async function visibleIds(ctx: Ctx, user: JfUser, ids: string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 40) {
    const r = await ctx.jf.items(user, { ids: uniq.slice(i, i + 40), types: 'Movie,Series,Episode,BoxSet', limit: 40 }).catch(() => ({ items: [] }));
    for (const it of r.items) ok.add(it.id);
  }
  return ok;
}

export async function filterDigest(ctx: Ctx, user: JfUser, d: DigestData): Promise<DigestData> {
  const ids = [
    ...d.newMovies.map((m) => m.id),
    ...d.newEpisodes.flatMap((g) => [g.seriesId, ...g.episodes.map((e) => e.id)]),
    ...d.available.flatMap((a) => (a.itemId ? [a.itemId] : [])),
    ...d.recommendations.map((r) => r.itemId),
  ];
  const ok = await visibleIds(ctx, user, ids);
  const movies = d.newMovies.filter((m) => ok.has(m.id));
  const newEpisodes = d.newEpisodes.filter((g) => ok.has(g.seriesId)).map((g) => {
    const episodes = g.episodes.filter((e) => ok.has(e.id));
    return { ...g, episodes, count: Math.max(episodes.length, g.count - (g.episodes.length - episodes.length)) };
  });
  return {
    ...d,
    newMovies: movies,
    newMovieCount: Math.max(movies.length, d.newMovieCount - (d.newMovies.length - movies.length)),
    newEpisodes,
    newEpisodeCount: newEpisodes.reduce((n, g) => n + g.count, 0),
    available: d.available.filter((a) => !a.itemId || ok.has(a.itemId)),
    recommendations: d.recommendations.filter((r) => ok.has(r.itemId)),
  };
}

const settingsSchema = z.object({ enabled: z.boolean(), day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23) });

export function digestRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/digest/latest', pre, async (req) => {
    const r = await ctx.db.query<{ week: Date | string; sent_at: Date; data: DigestData }>(
      'select to_char(week, \'YYYY-MM-DD\') as week, sent_at, data from digests where user_id=$1 order by week desc limit 1', [req.user!.id]);
    const row = r.rows[0];
    if (!row) return { digest: null };
    return { digest: { week: row.week, sentAt: row.sent_at.toISOString(), data: await filterDigest(ctx, req.jfUser!, row.data) } };
  });

  const settings = async () => {
    const s = await digestSchedule(ctx);
    const last = (await ctx.db.query<{ week: string; sent_at: Date; n: string }>(
      `select to_char(week, 'YYYY-MM-DD') as week, max(sent_at) as sent_at, count(*) as n from digests
        where week = (select max(week) from digests) group by week`)).rows[0];
    return { ...s, lastRun: last ? { week: last.week, sentAt: last.sent_at.toISOString(), count: Number(last.n) } : null };
  };
  app.get('/api/admin/digest', admin, async () => settings());
  app.put('/api/admin/digest', admin, async (req) => {
    const b = settingsSchema.parse(req.body);
    await ctx.db.query(
      "insert into app_settings(key, value) values ('digest', $1) on conflict (key) do update set value = excluded.value, updated_at = now()", [JSON.stringify(b)]);
    await audit(ctx, req.user!.id, 'digest.settings', undefined, b);
    return settings();
  });
  app.post('/api/admin/digest/test', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 24 * 3600_000);
    const r = await sendDigest(ctx, req.user!, { key: 'test', since, until }, true);
    return { sent: r.sent, data: r.data };
  });
}
