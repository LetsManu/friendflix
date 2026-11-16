// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { m } from './i18n.js';
import { notify } from './notify.js';

/**
 * Download licences about to expire (docs/superpowers/plans/2026-11-16-mail-stage-b.md, Controller's calls 5 and 10). Once a day from
 * 09:00 server time (kv day key, the tick runs every 10 minutes while downloads are on) every licence that is pending or fetched,
 * expires within the next 48 h and is at least 48 h old is claimed (`downloads.expiry_warned_at`: warned once, ever), and each person
 * with claimed licences gets one notice: in-app, their personal push and a mail of type `licence`, with the count and the earliest
 * expiry. The age rule keeps a 1- or 2-day licence from warning right after its download; the 48 h window leaves at least 24 h to act.
 *
 * Licences belong to the account (`downloads.user_id`), also those of a kids profile: the account is told, at its address.
 */

const HOUR_FROM = 9;
const DAY_TTL_S = 2 * 86_400;

const pad = (n: number) => String(n).padStart(2, '0');
/** the server's calendar day of `d` (yyyy-mm-dd), the same clock as the 09:00 rule */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * One run, at most once a day: null before 09:00 or when today's run happened (on this or another instance). A failure after the day
 * was taken gives it back and un-claims the licences of the people not told yet, then rethrows: the next tick tries again.
 */
export async function licenceExpiryTick(
  ctx: Pick<Ctx, 'db' | 'kv' | 'cfg' | 'fetchImpl' | 'encKey'>, now: Date = new Date(),
): Promise<{ warned: number; people: number } | null> {
  if (now.getHours() < HOUR_FROM) return null;
  const day = localDay(now);
  const key = `mail:licence-day:${day}`;
  if (!(await ctx.kv.setnx(key, '1', DAY_TTL_S))) return null;
  const untold = new Set<string>();
  try {
    const r = await ctx.db.query<{ user_id: string; expires_at: Date }>(
      `update downloads set expiry_warned_at = $1
        where status in ('pending','fetched') and expiry_warned_at is null
          and expires_at > $1 and expires_at <= $1::timestamptz + interval '48 hours'
          and created_at <= $1::timestamptz - interval '48 hours'
        returning user_id, expires_at`, [now]);
    const people = new Map<string, { n: number; first: Date }>();
    for (const row of r.rows) {
      const p = people.get(row.user_id);
      if (!p) people.set(row.user_id, { n: 1, first: row.expires_at });
      else {
        p.n++;
        if (row.expires_at < p.first) p.first = row.expires_at;
      }
      untold.add(row.user_id);
    }
    for (const [userId, { n, first }] of people) {
      await notify(ctx, {
        userId, kind: 'download_expiring',
        title: m('download.expiring.title', { n }),
        body: m('download.expiring.body', { n, date: { date: first.toISOString() } }),
        link: '/downloads', dedupe: `dl-expiring-${userId}-${day}`, personal: true, mail: 'licence',
      });
      untold.delete(userId);
    }
    return { warned: r.rows.length, people: people.size };
  } catch (e) {
    if (untold.size) {
      await ctx.db.query('update downloads set expiry_warned_at = null where expiry_warned_at = $1 and user_id = any($2::uuid[])', [now, [...untold]])
        .catch(() => undefined);
    }
    await ctx.kv.del(key).catch(() => undefined);
    throw e;
  }
}
