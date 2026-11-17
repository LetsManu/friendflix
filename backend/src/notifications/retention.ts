// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';

/** Notifications older than this many days are deleted, read or unread (their notification_state rows cascade). */
export const RETENTION_DAYS = 90;
const DAY_TTL_S = 2 * 86_400;
/** rows deleted per statement: a large backlog (the first run) never holds one long lock */
const BATCH = 5000;

const pad = (n: number) => String(n).padStart(2, '0');
/** the server's calendar day of `d` (yyyy-mm-dd) */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * The daily clean-up of the notifications center: deletes notifications created more than RETENTION_DAYS before `now`. Runs once
 * per server-local day across instances (kv day key); returns the number deleted, or null when today's run already happened. A
 * failure gives the day back, so the next tick tries again.
 */
export async function notesRetentionTick(ctx: Pick<Ctx, 'db' | 'kv'>, now: Date = new Date()): Promise<number | null> {
  const key = `notes:retention:${localDay(now)}`;
  if (!(await ctx.kv.setnx(key, '1', DAY_TTL_S))) return null;
  try {
    let total = 0;
    for (;;) {
      const r = await ctx.db.query(
        `delete from notifications where id in (
           select id from notifications where created_at < $1::timestamptz - make_interval(days => $2) limit $3)`,
        [now, RETENTION_DAYS, BATCH],
      );
      total += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < BATCH) return total;
    }
  } catch (e) {
    await ctx.kv.del(key).catch(() => undefined);
    throw e;
  }
}
