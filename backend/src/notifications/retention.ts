// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';

/** Notifications older than this many days are deleted, read or unread (their notification_state rows cascade), except RETENTION_KEEP_KINDS. */
export const RETENTION_DAYS = 90;
/**
 * Kinds retention never deletes. Their dedupe key is the only durable "told once" marker of a condition a timer keeps seeing: the hourly
 * update check (`update-avail-<channel>-<version>`, stable and pinned name a version that can stay newest for months) and the last
 * active admin whose access ended but who is never locked (`access-skipped-<id>-<date>`, every expiry tick). Deleting such a row would
 * make the next tick tell (in-app, push and mail) again. Skipping the kinds is simpler than a tombstone of deleted keys: these rows are
 * rare (per admin: one per version, a nightly one per week, one per ended access). Every other dedupe key names a one-time event or carries a day or week.
 */
export const RETENTION_KEEP_KINDS: readonly string[] = ['update_available', 'access_ended'];
const DAY_TTL_S = 2 * 86_400;
/** rows deleted per statement: a large backlog (the first run) never holds one long lock */
const BATCH = 5000;

const pad = (n: number) => String(n).padStart(2, '0');
/** the server's calendar day of `d` (yyyy-mm-dd) */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * The daily clean-up of the notifications center: deletes notifications created more than RETENTION_DAYS before `now`, except
 * RETENTION_KEEP_KINDS. Runs once per server-local day across instances (kv day key); returns the number deleted, or null when today's
 * run already happened. A failure gives the day back, so the next tick tries again.
 */
export async function notesRetentionTick(ctx: Pick<Ctx, 'db' | 'kv'>, now: Date = new Date()): Promise<number | null> {
  const key = `notes:retention:${localDay(now)}`;
  if (!(await ctx.kv.setnx(key, '1', DAY_TTL_S))) return null;
  try {
    let total = 0;
    for (;;) {
      const r = await ctx.db.query(
        `delete from notifications where id in (
           select id from notifications where created_at < $1::timestamptz - make_interval(days => $2) and kind <> all($4::text[]) limit $3)`,
        [now, RETENTION_DAYS, BATCH, RETENTION_KEEP_KINDS],
      );
      total += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < BATCH) return total;
    }
  } catch (e) {
    await ctx.kv.del(key).catch(() => undefined);
    throw e;
  }
}
