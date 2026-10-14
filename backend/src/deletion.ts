// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account deletion with a grace period: scheduling locks the account at once (locked_reason 'deletion', deletion_at = now + 7 days),
 * a restore within the grace period undoes it. The final deletion steps run in the deletion tick, which first claims the account
 * (an account_deletions row); from then on it can no longer be restored. Callers run these helpers in accountSerial (not re-entrant).
 */
import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { audit } from './audit.js';
import type { Ctx } from './ctx.js';
import { m } from './i18n.js';
import { notifyAdmins } from './notify.js';
import { HttpError, accessEnded, assertNotLastAdmin, lockUser, unlockUser } from './users.js';

/** the grace period between the request and the final deletion */
export const GRACE_MS = 7 * 86400e3;

/** `deleted-` + 8 hex characters of an HMAC over the id: stable, not reversible without the key (it replaces the name in the audit log) */
export function pseudonymFor(ctx: Pick<Ctx, 'encKey'>, userId: string): string {
  return `deleted-${createHmac('sha256', ctx.encKey).update(`friendflix deleted v1|${userId}`).digest('hex').slice(0, 8)}`;
}

const adminLink = (userId: string) => `/admin/users/${userId}`;

/**
 * Schedules the deletion and locks the account at once (sessions and offline licenses revoked). Refuses the last active admin
 * (400 last_admin) and an account that is already locked (409 account_locked). Returns the deletion date.
 */
export async function scheduleDeletion(ctx: Ctx, actor: string | null, userId: string, now = new Date()): Promise<Date> {
  const u = (await ctx.db.query<{ name: string; disabled: boolean }>('select name, disabled from users where id=$1', [userId])).rows[0];
  if (!u) throw new HttpError(404, 'not_found');
  if (u.disabled) throw new HttpError(409, 'account_locked');
  await assertNotLastAdmin(ctx, [userId], 'lock');
  const at = new Date(now.getTime() + GRACE_MS);
  await ctx.db.query('update users set deletion_at=$2 where id=$1', [userId, at]);
  try {
    await lockUser(ctx, actor, userId, 'deletion');
  } catch (e) {
    // the lock failed (e.g. media server down): no deletion date on an account that is still usable
    await ctx.db.query('update users set deletion_at=null where id=$1 and not disabled', [userId]);
    throw e;
  }
  const iso = at.toISOString();
  await audit(ctx, actor, 'user.deletion_requested', userId, { deletionAt: iso, by: actor === userId ? 'self' : 'admin' });
  await notifyAdmins(ctx, { kind: 'deletion_requested', title: m('notify.deletion.requested', { name: u.name, date: { date: iso } }), link: adminLink(userId), dedupe: `deletion-req-${userId}-${iso}` });
  return at;
}

/**
 * Cancels a scheduled deletion. One transaction locks the users row and then checks for a claim in a fresh statement, so a
 * claim that committed while this waited is seen (409 deletion_in_progress). Not scheduled: 409 not_scheduled; unknown: 404.
 * An account whose access has ended meanwhile stays locked, as 'expired' (never enabled); otherwise it is unlocked
 * (unlockUser audits the restore). Only this path sends the admins the "restored" notice.
 */
export async function restoreDeletion(ctx: Ctx, actor: string | null, userId: string): Promise<void> {
  const c = await (ctx.db as pg.Pool).connect();
  let u: { name: string; deletion_at: Date; access_until: Date | null };
  try {
    await c.query('begin');
    const r = await c.query<typeof u & { locked_reason: string | null }>(
      'select name, locked_reason, deletion_at, access_until from users where id=$1 for update', [userId]);
    const claimed = await c.query('select 1 from account_deletions where user_id=$1', [userId]);
    if (claimed.rowCount) throw new HttpError(409, 'deletion_in_progress');
    const row = r.rows[0];
    if (!row) throw new HttpError(404, 'not_found');
    if (row.locked_reason !== 'deletion' || !row.deletion_at) throw new HttpError(409, 'not_scheduled');
    u = row;
    // ended access: the lock stays and becomes the expiry lock (phase 1 never unlocks ended access)
    await c.query(`update users set deletion_at=null${accessEnded(u.access_until) ? ", locked_reason='expired'" : ''} where id=$1`, [userId]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  if (accessEnded(u.access_until)) await audit(ctx, actor, 'user.deletion_restored', userId, { lockedReason: 'expired' });
  else {
    try {
      await unlockUser(ctx, actor, userId); // still locked as 'deletion' here, so it audits user.deletion_restored
    } catch (e) {
      // e.g. media server down: the account is still locked; the date goes back so the restore can be retried
      await ctx.db.query("update users set deletion_at=$2 where id=$1 and disabled and locked_reason='deletion' and deletion_at is null", [userId, u.deletion_at]);
      throw e;
    }
  }
  await notifyAdmins(ctx, { kind: 'deletion_restored', title: m('notify.deletion.restored', { name: u.name }), link: adminLink(userId), dedupe: `deletion-restored-${userId}-${u.deletion_at.toISOString()}` });
}
