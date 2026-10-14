// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import type { Ctx } from './ctx.js';
import { encrypt, randomPassword } from './crypto.js';
import type { IdentityPolicy } from './media/types.js';
import { effectiveLimits } from './limits.js';
import { effectiveRole } from './roles.js';
import { accountJellyfinIds, kidsPolicyFor } from './profiles.js';
import { revokeSessions } from './devices.js';
import type { OidcClaims } from './oidc.js';
import type { UserRow } from './types.js';

export async function getUserById(ctx: Ctx, id: string): Promise<UserRow | null> {
  const r = await ctx.db.query<UserRow>('select * from users where id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function getUserBySub(ctx: Ctx, sub: string): Promise<UserRow | null> {
  const r = await ctx.db.query<UserRow>('select * from users where authentik_sub = $1', [sub]);
  return r.rows[0] ?? null;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'freund';

/** Writes the role template (plus hidden flag / kids caps) as the media server policy of one identity. */
/** `extra.userId`: the account owning the identity, whose overrides (e.g. maxStreams -> MaxActiveSessions) apply; looked up when omitted. */
export async function applyRole(ctx: Ctx, jellyfinUserId: string, role: string, disabled = false, { userId, ...extra }: Pick<IdentityPolicy, 'hidden' | 'parental'> & { userId?: string } = {}) {
  const owner = userId ?? (await ctx.db.query<{ id: string }>('select id from users where jellyfin_user_id=$1 union all select user_id from profiles where jellyfin_user_id=$1 limit 1', [jellyfinUserId])).rows[0]?.id;
  const t = owner ? await effectiveLimits(ctx, { id: owner, role }) : await effectiveRole(ctx, role);
  if (!t) throw new Error(`unknown role ${role}`);
  // a kids profile keeps its parental cap through every re-apply (role edits, admin promotion, startup job)
  const kids = await kidsPolicyFor(ctx, jellyfinUserId, t.maxParentalRating);
  await ctx.jf.admin.applyPolicy(jellyfinUserId, { template: t, disabled, ...extra, ...(kids ? { parental: kids } : {}) });
}

/**
 * Creates the 1:1 mapping Authentik account = portal user = Jellyfin account:
 * a Jellyfin user with a random password (stored AES-GCM encrypted), role policy applied.
 */
export async function provisionUser(ctx: Ctx, claims: OidcClaims, role: string): Promise<UserRow> {
  const base = safeName(claims.name ?? claims.email?.split('@')[0] ?? 'freund');
  const password = randomPassword();
  let jf: { id: string } | undefined;
  let jfName = base;
  for (let attempt = 0; attempt < 4 && !jf; attempt++) {
    jfName = attempt === 0 ? base : `${base}${Math.floor(100 + Math.random() * 900)}`;
    try {
      jf = await ctx.jf.admin.createIdentity(jfName, password);
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
  try {
    const id = randomUUID();
    await applyRole(ctx, jf!.id, role, false, { userId: id });
    const pool = ctx.db as pg.Pool;
    const c = await pool.connect();
    let row: UserRow;
    try {
      await c.query('begin');
      const r = await c.query<UserRow>(
        `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [id, claims.sub, claims.email ?? null, claims.name ?? jfName, role, jf!.id, jfName, encrypt(ctx.encKey, password)],
      );
      row = r.rows[0]!;
      await c.query('insert into profiles(id, user_id, name, is_owner) values ($1,$1,$2,true)', [id, row.name.slice(0, 20).trim() || 'Profil']);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await audit(ctx, id, 'user.provisioned', id, { role, jellyfin: jfName });
    return row;
  } catch (e) {
    await ctx.jf.admin.deleteIdentity(jf!.id).catch(() => undefined); // roll back the orphaned Jellyfin account
    throw e;
  }
}

/** Re-applies the effective role policy to all non-disabled users of a role. Returns the number of failures. */
export async function reapplyRole(ctx: Ctx, role: string): Promise<number> {
  const r = await ctx.db.query<{ id: string; jellyfin_user_id: string; hidden: boolean }>(
    `select id, jellyfin_user_id, false hidden from users where role=$1 and not disabled
     union all select u.id, p.jellyfin_user_id, true from profiles p join users u on u.id=p.user_id
      where u.role=$1 and not u.disabled and p.jellyfin_user_id is not null`,
    [role],
  );
  let failed = 0;
  for (const u of r.rows) await applyRole(ctx, u.jellyfin_user_id, role, false, { hidden: u.hidden, userId: u.id }).catch(() => { failed++; });
  return failed;
}

/** One-time startup job (flag in app_flags): old accounts still carry the pre-maxHeight policies (e.g. guests without transcoding). Call after migrate. */
export async function reapplyPoliciesOnce(ctx: Ctx, flag = 'reapply_roles_v1'): Promise<void> {
  const got = await ctx.db.query('insert into app_flags(key) values ($1) on conflict do nothing returning key', [flag]);
  if (!got.rowCount) return;
  let failed = 0;
  for (const role of Object.keys(ctx.roles)) failed += await reapplyRole(ctx, role);
  if (failed) await ctx.db.query('delete from app_flags where key=$1', [flag]); // retry on next start
}

/** A business error with an HTTP status; app.ts' error handler answers `{ error: message }` with that status. */
export class HttpError extends Error {
  constructor(readonly statusCode: number, code: string) {
    super(code);
  }
}

export type LockReason = 'manual' | 'expired' | 'deletion';

/** Locks the account: its media server identities (owner + profiles) are disabled and every session (and offline license) is revoked. */
export async function lockUser(ctx: Ctx, actor: string | null, userId: string, reason: LockReason): Promise<void> {
  for (const jid of await accountJellyfinIds(ctx, userId)) await ctx.jf.admin.setDisabled(jid, true);
  await ctx.db.query('update users set disabled=true, locked_reason=$2 where id=$1', [userId, reason]);
  await revokeSessions(ctx, userId); // also revokes the account's offline licenses
  await audit(ctx, actor, 'user.disable', userId, { reason });
}

export async function unlockUser(ctx: Ctx, actor: string | null, userId: string): Promise<void> {
  for (const jid of await accountJellyfinIds(ctx, userId)) await ctx.jf.admin.setDisabled(jid, false);
  await ctx.db.query('update users set disabled=false, locked_reason=null where id=$1', [userId]);
  await audit(ctx, actor, 'user.enable', userId);
}

/** Changes the role: the role policy goes to the account's media server identity and all its profile identities. No-op when unchanged. */
export async function setRole(ctx: Ctx, actor: string | null, userId: string, role: string): Promise<void> {
  if (!Object.hasOwn(ctx.roles, role)) throw new HttpError(400, 'unknown_role');
  const user = await getUserById(ctx, userId);
  if (!user) throw new HttpError(404, 'not_found');
  if (user.role === role) return;
  const ids = await accountJellyfinIds(ctx, userId);
  for (const jid of ids) await applyRole(ctx, jid, role, user.disabled, { userId, hidden: jid !== user.jellyfin_user_id });
  await ctx.db.query('update users set role=$1 where id=$2', [role, userId]);
  await audit(ctx, actor, 'user.role', userId, { from: user.role, to: role });
}

/**
 * Sets or clears (null) the date the account's access ends. No-op when unchanged.
 * A change re-arms the expiry warning (expiry_notified_at); an account locked because its access expired is unlocked
 * when the new date lies in the future or is cleared. A manual lock stays.
 */
export async function setAccessUntil(ctx: Ctx, actor: string | null, userId: string, until: Date | null): Promise<void> {
  const r = await ctx.db.query<{ access_until: Date | null; locked_reason: LockReason | null }>('select access_until, locked_reason from users where id=$1', [userId]);
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  const { access_until: from, locked_reason } = r.rows[0]!;
  if (from?.getTime() === until?.getTime()) return;
  await ctx.db.query('update users set access_until=$2, expiry_notified_at=null where id=$1', [userId, until]);
  await audit(ctx, actor, 'user.access', userId, { from: from?.toISOString() ?? null, to: until?.toISOString() ?? null });
  if (locked_reason === 'expired' && (until === null || until.getTime() > Date.now())) await unlockUser(ctx, actor, userId);
}

/**
 * Throws `last_admin` when demoting or locking `userIds` would leave no active admin (role admin, not disabled).
 * Callers check the change first: `_change` only names it ('demote' | 'lock'), both count the same way.
 */
export async function assertNotLastAdmin(ctx: Ctx, userIds: string[], _change: 'demote' | 'lock'): Promise<void> {
  const r = await ctx.db.query<{ affected: number; remaining: number }>(
    `select count(*) filter (where id = any($1::uuid[]))::int affected, count(*) filter (where not id = any($1::uuid[]))::int remaining
       from users where role='admin' and not disabled`, [userIds]);
  const { affected, remaining } = r.rows[0]!;
  if (affected > 0 && remaining === 0) throw new HttpError(400, 'last_admin');
}
