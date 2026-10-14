// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { audit } from './audit.js';
import type { Ctx } from './ctx.js';
import { m } from './i18n.js';
import { notify, notifyAdmins } from './notify.js';
import { HttpError, assertNotLastAdmin, lockUser } from './users.js';

/** How long before `access_until` the account and the admins are warned. */
const WARN_MS = 3 * 86400e3;
const ADMIN_LINK = '/admin/users';

interface Due { id: string; name: string; access_until: Date }

/**
 * Timer tick for "access until": warns accounts whose access ends within 3 days (once per date, via expiry_notified_at)
 * and locks accounts whose access has ended (locked_reason 'expired'). Never locks the last active admin: the admins are
 * told once and the skip is audited instead. Idempotent: a second run sends nothing and locks nothing again.
 */
export async function expiryTick(ctx: Ctx, now = new Date()): Promise<{ warned: number; locked: number }> {
  // claim first (atomic), so overlapping ticks cannot both warn
  const soon = await ctx.db.query<Due>(
    `update users set expiry_notified_at=$1
      where access_until > $1 and access_until <= $2 and expiry_notified_at is null and not disabled
      returning id, name, access_until`,
    [now, new Date(now.getTime() + WARN_MS)],
  );
  for (const u of soon.rows) {
    const iso = u.access_until.toISOString();
    await notify(ctx, { userId: u.id, kind: 'access_soon', title: m('notify.access.soon', { date: { date: iso } }), dedupe: `access-soon-${u.id}-${iso}` });
    await notifyAdmins(ctx, { kind: 'access_soon', title: m('notify.access.soonAdmin', { name: u.name, date: { date: iso } }), link: ADMIN_LINK, dedupe: `access-soon-admin-${u.id}-${iso}` });
  }

  const ended = await ctx.db.query<Due>('select id, name, access_until from users where access_until <= $1 and not disabled order by access_until, id', [now]);
  let locked = 0;
  let failure: unknown;
  for (const u of ended.rows) {
    try {
      if (await expire(ctx, u)) locked++;
    } catch (e) {
      failure ??= e; // one failing account (e.g. media server error) must not block the others; retried next tick
    }
  }
  if (failure) throw failure;
  return { warned: soon.rowCount ?? 0, locked };
}

/** Locks one account whose access ended. Returns false when it is the last active admin and stays unlocked. */
async function expire(ctx: Ctx, u: Due): Promise<boolean> {
  const iso = u.access_until.toISOString();
  const adminNotice = { kind: 'access_ended', title: m('notify.access.endedAdmin', { name: u.name, date: { date: iso } }), link: ADMIN_LINK };
  try {
    await assertNotLastAdmin(ctx, [u.id], 'lock');
  } catch (e) {
    if (!(e instanceof HttpError) || e.message !== 'last_admin') throw e;
    // the account stays usable (else nobody could administer the instance); tell the admins (incl. this one) once per date
    if (await notifyAdmins(ctx, { ...adminNotice, dedupe: `access-skipped-${u.id}-${iso}` })) {
      await audit(ctx, null, 'user.expiry_skipped_last_admin', u.id, { accessUntil: iso });
    }
    return false;
  }
  await lockUser(ctx, null, u.id, 'expired');
  await audit(ctx, null, 'user.expired', u.id, { accessUntil: iso });
  await notify(ctx, { userId: u.id, kind: 'access_ended', title: m('notify.access.ended', { date: { date: iso } }), dedupe: `access-ended-${u.id}-${iso}` });
  await notifyAdmins(ctx, { ...adminNotice, dedupe: `access-ended-admin-${u.id}-${iso}` });
  return true;
}
