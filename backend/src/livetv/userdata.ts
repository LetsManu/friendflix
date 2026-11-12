// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import type { Ctx } from '../ctx.js';

/**
 * What a profile keeps of Live TV (spec §6.1, §8, §10): its favourites in its own order and *Zuletzt gesehen*. Both are per profile and
 * never deleted by a lost right: a channel the profile may not see is only left out of what the routes answer (the callers filter by
 * `channelSet`), and comes back with the right. Writes of one profile are serialised by a transaction-scoped advisory lock, so two
 * tabs adding a favourite cannot take the same position.
 */

/** the newest rows of *Zuletzt gesehen* a profile keeps (trimmed on every write, ruling 45) */
export const RECENT_MAX = 10;

async function inProfileTx<T>(ctx: Pick<Ctx, 'db'>, kind: string, profileId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`ltv:${kind}:${profileId}`]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** the profile's favourites by position (all of them, also those it cannot see now; the caller filters) */
export async function favouriteIds(ctx: Pick<Ctx, 'db'>, profileId: string): Promise<string[]> {
  return (await ctx.db.query<{ channel_id: string }>(
    'select channel_id from livetv_favourites where profile_id = $1 order by position, channel_id', [profileId])).rows.map((r) => r.channel_id);
}

/** the profile's *Zuletzt gesehen*, newest first (all rows, also those it cannot see now; the caller filters) */
export async function recentIds(ctx: Pick<Ctx, 'db'>, profileId: string): Promise<string[]> {
  return (await ctx.db.query<{ channel_id: string }>(
    'select channel_id from livetv_recent where profile_id = $1 order by at desc, channel_id', [profileId])).rows.map((r) => r.channel_id);
}

/**
 * `PUT /api/livetv/favourites`: `ids` is the complete order of the favourites the profile can see. false = an id is not one of them
 * (unknown, not a favourite, or not visible: nothing is revealed which) or listed twice; nothing changes then. Favourites missing from
 * `ids` (a hidden one, say) keep their relative order after the given ones.
 */
export async function setFavouriteOrder(ctx: Pick<Ctx, 'db'>, profileId: string, ids: readonly string[], visible: ReadonlySet<string>): Promise<boolean> {
  return inProfileTx(ctx, 'fav', profileId, async (c) => {
    const cur = (await c.query<{ channel_id: string }>(
      'select channel_id from livetv_favourites where profile_id = $1 order by position, channel_id', [profileId])).rows.map((r) => r.channel_id);
    const have = new Set(cur);
    const given = new Set(ids);
    if (given.size !== ids.length || ids.some((id) => !have.has(id) || !visible.has(id))) return false;
    const order = [...ids, ...cur.filter((id) => !given.has(id))];
    if (order.length) {
      await c.query(
        `update livetv_favourites f set position = o.pos
           from unnest($2::uuid[], $3::int[]) as o(id, pos)
          where f.profile_id = $1 and f.channel_id = o.id`,
        [profileId, order, order.map((_, i) => i)]);
    }
    return true;
  });
}

/** `POST /api/livetv/favourites/:id`: a new favourite goes last (`max(position) + 1`); one that already is stays where it is */
export async function addFavourite(ctx: Pick<Ctx, 'db'>, profileId: string, channelId: string): Promise<void> {
  await inProfileTx(ctx, 'fav', profileId, async (c) => {
    await c.query(
      `insert into livetv_favourites(profile_id, channel_id, position)
       select $1, $2, coalesce(max(position) + 1, 0) from livetv_favourites where profile_id = $1
       on conflict (profile_id, channel_id) do nothing`,
      [profileId, channelId]);
  });
}

/** `DELETE /api/livetv/favourites/:id`: the profile's own row goes, whether it can see the channel or not */
export async function removeFavourite(ctx: Pick<Ctx, 'db'>, profileId: string, channelId: string): Promise<void> {
  await ctx.db.query('delete from livetv_favourites where profile_id = $1 and channel_id = $2', [profileId, channelId]);
}

/**
 * `PUT /api/livetv/last`: the watch goes to the front of *Zuletzt gesehen* (`at = now()`, a channel already there moves up, no
 * duplicate) and the rows beyond the newest `RECENT_MAX` go, in one transaction (ruling 45).
 */
export async function recordRecent(ctx: Pick<Ctx, 'db'>, profileId: string, channelId: string): Promise<void> {
  await inProfileTx(ctx, 'recent', profileId, async (c) => {
    await c.query(
      `insert into livetv_recent(profile_id, channel_id, at) values ($1, $2, now())
       on conflict (profile_id, channel_id) do update set at = excluded.at`,
      [profileId, channelId]);
    await c.query(
      `delete from livetv_recent
        where profile_id = $1
          and channel_id in (select channel_id from livetv_recent where profile_id = $1 order by at desc, channel_id offset $2)`,
      [profileId, RECENT_MAX]);
  });
}
