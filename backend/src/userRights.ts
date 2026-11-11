// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { z } from 'zod';
import { auditInTx } from './audit.js';
import type { Ctx } from './ctx.js';
import { fetchLibraries, knownLibraries, missingLibraries } from './libraries.js';
import { getUserOverrides, setUserOverrides, type EffectiveLimits, type UserOverrides } from './limits.js';
import { KIDS_OFF, MATRIX_FIELDS, PERM_KEYS, type PermKey } from './perms.js';
import { effectiveRights, invalidateRights, roleRights, type RightKey, type RightSource } from './rights.js';
import { MEDIA_FIELDS, rolePatch } from './roleWrite.js';
import type { ProfileRow } from './types.js';
import { HttpError } from './users.js';
import { wellFormed } from './wellFormed.js';

/**
 * The rights of one account (spec §4.2): GET /api/admin/users/:id/rights (every matrix row with the effective value, the role's value,
 * the stored override and the deciding layer) and the override write behind PUT …/rights and the legacy PUT …/limits. Overrides use
 * the role editor's encodings (null = back to the role, 'unlimited' lifts a cap); an override equal to the role's value is not stored.
 */

type Override = Exclude<RightKey, 'downloadDays'>;
/** every field a person can override: all matrix rows except downloadDays (user_limits has no column for it, it stays the role's) */
export const OVERRIDE_KEYS: readonly Override[] = MATRIX_FIELDS.map((f) => f.key as RightKey).filter((k): k is Override => k !== 'downloadDays');

const r = rolePatch.shape;
const permFields = Object.fromEntries(PERM_KEYS.map((k) => [k, z.boolean().nullable().optional()])) as Record<PermKey, z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>;
/** the overrides of a PUT: field -> value in the role editor's encoding, null = as the role; unknown fields are refused */
export const rightsOverrides = z.object({
  libraries: r.libraries, maxParentalRating: r.maxParentalRating, maxStreams: r.maxStreams, maxBitrate: r.maxBitrate,
  remoteMaxBitrate: r.remoteMaxBitrate, transcoding: r.transcoding, maxHeight: r.maxHeight, download: r.download,
  maxDownloads: r.maxDownloads, downloadMaxHeight: r.downloadMaxHeight, requestsPerMonth: r.requestsPerMonth, ...permFields,
}).strict();
/** PUT /api/admin/users/:id/rights; `note`: the admin's why (≤ 200 characters, empty = none), shown in the editor, never audited */
export const rightsBody = z.object({
  overrides: rightsOverrides.optional(),
  note: z.string().trim().max(200).refine(wellFormed).nullable().optional(),
}).strict();
export type RightsBody = z.infer<typeof rightsBody>;
type OverrideValue = unknown;

const isPerm = (k: string): k is PermKey => (PERM_KEYS as readonly string[]).includes(k);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Resolved = { template: EffectiveLimits; perms: Record<PermKey, boolean>; sources: Record<RightKey, RightSource> };
const valueOf = (x: Resolved, k: string): unknown => (isPerm(k) ? x.perms[k] : x.template[k as keyof EffectiveLimits]);

/** the stored sentinel of 'unlimited' where the column's null already means "as the role" */
const UNLIMITED: Partial<Record<Override, number>> = { maxHeight: 0, maxParentalRating: -1, requestsPerMonth: -1 };
/** the UserOverrides field of a template override (the old column name of the remote cap) */
const fieldOf = (k: Exclude<Override, PermKey>): keyof Omit<UserOverrides, 'perms' | 'note'> => (k === 'remoteMaxBitrate' ? 'remoteBitrate' : k);

/** an account's stored override of one field in the PUT encoding ('unlimited' for a sentinel); null = none */
export function overrideOf(u: UserOverrides, k: Override): OverrideValue {
  if (isPerm(k)) return u.perms[k] ?? null;
  const v = u[fieldOf(k)];
  if (v === null || v === undefined) return null;
  return Object.hasOwn(UNLIMITED, k) && v === UNLIMITED[k] ? 'unlimited' : v;
}
function setOverride(u: UserOverrides, k: Override, v: OverrideValue): void {
  if (isPerm(k)) {
    if (v === null) delete u.perms[k];
    else u.perms[k] = v as boolean;
    return;
  }
  (u as Record<string, unknown>)[fieldOf(k)] = v === 'unlimited' ? UNLIMITED[k]! : v;
}
/** a PUT value in the effective encoding (null = unlimited), for the comparison with the role */
const effectiveOf = (v: OverrideValue): unknown => (v === 'unlimited' ? null : v);
/** equal for the account: library lists compare as sets, case-insensitively (as the policy matches them) */
function sameValue(k: Override, a: unknown, b: unknown): boolean {
  if (k === 'libraries' && Array.isArray(a) && Array.isArray(b)) {
    const set = (x: unknown[]) => [...new Set(x.map((n) => String(n).toLowerCase()))].sort();
    return same(set(a), set(b));
  }
  return same(a, b);
}

export interface RightsRow { key: string; value: unknown; roleValue: unknown; override: OverrideValue | null; source: RightSource }
export interface RightsView {
  role: string; note: string | null; rows: RightsRow[];
  profile: { id: string; name: string; kids: boolean; maxRating: number | null } | null;
  /** the switches the kids overlay turns off (the profile is a kids profile), else [] */
  hardKids: PermKey[];
  /** library names of the effective list the media server no longer has (the policy skips them; shown as "nicht mehr vorhanden") */
  missingLibraries: string[];
}

/** GET /api/admin/users/:id/rights: one row per matrix field, in matrix order; `profile` adds its kids overlay to `value` / `source` */
export async function rightsView(ctx: Ctx, user: { id: string; role: string }, profile: ProfileRow | null): Promise<RightsView> {
  const u = await getUserOverrides(ctx, user.id);
  const [eff, role, libs] = await Promise.all([effectiveRights(ctx, user, profile, u), roleRights(ctx, user.role), fetchLibraries(ctx)]);
  if (!eff || !role) throw new HttpError(409, 'unknown_role');
  const overridable = new Set<string>(OVERRIDE_KEYS);
  return {
    role: user.role,
    note: u.note,
    rows: MATRIX_FIELDS.map(({ key }) => ({
      key,
      value: valueOf(eff, key),
      roleValue: valueOf(role, key),
      // the admin role's switches are locked: a stored switch of an account that once held another role does not apply
      override: !overridable.has(key) || (user.role === 'admin' && isPerm(key)) ? null : overrideOf(u, key as Override),
      source: eff.sources[key as RightKey],
    })),
    profile: profile && { id: profile.id, name: profile.name, kids: Boolean(profile.kids), maxRating: profile.kids ? profile.kids_max_rating : null },
    hardKids: profile?.kids ? [...KIDS_OFF] : [],
    missingLibraries: missingLibraries(eff.template.libraries, libs),
  };
}

export interface RightsWrite {
  /** the audited keys (changed effective values and values that moved between layers) */
  changed: string[];
  /** an effective value the media server policy carries changed: the account's identities need the policy again */
  media: boolean;
  /** some effective value changed: the gateway forgets the memoised identity of the account's sessions */
  effective: boolean;
}

/**
 * Writes an account's overrides (partial: an absent field stays, null = back to the role) in one transaction on one connection,
 * serialized per account across instances (the routes also run it in accountSerial). A value equal to the role's is not stored (an
 * existing override of that field goes). One user.rights audit entry per stored change, inside the transaction: `{ from, to }` of the
 * changed effective account values (no kids overlay), `layer` for a value that only moved between layers (unpinned), `note: 'changed'`
 * when the note changed (never its text). The caches of the account are dropped after commit; re-applying the policy and forgetting
 * the gateway memo are the caller's (`media`, `effective`), outside the transaction.
 */
export async function writeRights(ctx: Ctx, actor: string | null, userId: string, body: RightsBody): Promise<RightsWrite> {
  const o = body.overrides ?? {};
  // names → the server's spelling, before the transaction (a media server call); 400 unknown_library, 502 libraries_unavailable
  const libraries = Array.isArray(o.libraries) ? await knownLibraries(ctx, o.libraries) : o.libraries;
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  const layer: Record<string, { from: string; to: string }> = {};
  let media = false;
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`rights:${userId}`]);
    // the resolver reads roles and overrides through this connection: a fresh ctx object, nothing cached from before the lock is used
    const tx = { db: c, roles: ctx.roles };
    const user = (await c.query<{ id: string; role: string }>('select id, role from users where id=$1 for share', [userId])).rows[0];
    if (!user) throw new HttpError(404, 'not_found');
    if (user.role === 'admin' && PERM_KEYS.some((k) => o[k] !== undefined)) throw new HttpError(400, 'admin_perms_locked');
    const role = await roleRights(tx, user.role);
    if (!role) throw new HttpError(409, 'unknown_role');
    const cur = await getUserOverrides(tx, userId);
    const next: UserOverrides = { ...cur, perms: { ...cur.perms } };
    for (const k of OVERRIDE_KEYS) {
      const v = k === 'libraries' ? libraries : o[k];
      if (v === undefined) continue;
      setOverride(next, k, v !== null && !sameValue(k, effectiveOf(v), valueOf(role, k)) ? v : null);
    }
    if (body.note !== undefined) next.note = body.note || null;

    const before = (await effectiveRights(tx, user, null, cur))!;
    const after = (await effectiveRights(tx, user, null, next))!;
    let effective = false;
    for (const { key: k } of MATRIX_FIELDS) {
      const a = valueOf(before, k);
      const b = valueOf(after, k);
      const sa = before.sources[k as RightKey];
      const sb = after.sources[k as RightKey];
      if (!same(a, b)) {
        from[k] = a; to[k] = b; effective = true;
        if (MEDIA_FIELDS.has(k)) media = true;
      } else if (sa !== sb) {
        from[k] = a; to[k] = b; layer[k] = { from: sa, to: sb };
      }
    }
    const note = cur.note !== next.note;
    if (!same(cur, next)) await setUserOverrides(tx, userId, next);
    // in the transaction: an entry for every stored change, in commit order (the account lock is still held)
    if (Object.keys(to).length || note) {
      await auditInTx(tx, actor, 'user.rights', userId, { from, to, ...(Object.keys(layer).length ? { layer } : {}), ...(note ? { note: 'changed' } : {}) });
    }
    await c.query('commit');
    return { changed: Object.keys(to), media, effective };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    invalidateRights(userId); // after commit: a reader that loaded the row while the transaction ran must not keep it for 30 s
  }
}
