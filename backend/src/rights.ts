// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
// rights.ts and limits.ts import each other: neither may use the other's exports at module load, only inside functions
import { getUserOverrides, type EffectiveLimits, type UserOverrides } from './limits.js';
import { DEFAULT_PERMS, KIDS_OFF, PERM_KEYS, readPerms, type PermKey, type Perms } from './perms.js';
import { defaultLimit, roleLimitRow } from './requestlimit.js';
import { readTemplate, resolveRole, type RoleTemplate, type TemplateKey } from './roles.js';
import type { ProfileRow } from './types.js';

/**
 * The one resolver of what an account may do (spec §1):
 *   code default (DEFAULT_ROLES / DEFAULT_PERMS) ← ROLE_TEMPLATES env ← role row (role_settings) ← user override (user_limits) ← kids overlay
 * with the layer that decided every field. The admin role's switches are always on (`admin`); the kids overlay is hard.
 */
export type RightSource = 'default' | 'env' | 'role' | 'user' | 'kids' | 'admin';
export type RightKey = Exclude<keyof RoleTemplate, 'label'> | 'requestsPerMonth' | PermKey;
export interface Rights { template: EffectiveLimits; perms: Perms; sources: Record<RightKey, RightSource> }
type RightsCtx = Pick<Ctx, 'db' | 'roles'>;
type RoleSource = Exclude<RightSource, 'user' | 'kids'>;

const TTL_MS = 30_000;
/** userId -> (ctx -> override row). Keyed by user first so invalidateRights(userId) works without a ctx. */
const overrides = new Map<string, WeakMap<object, { at: number; v: UserOverrides }>>();
/** ctx -> perm -> account ids with that switch off; replaced as a whole by invalidateRights */
let without = new WeakMap<object, Map<PermKey, { at: number; ids: string[] }>>();

const defaultPerms = (base: string): Perms => ({ ...(Object.hasOwn(DEFAULT_PERMS, base) ? DEFAULT_PERMS[base as keyof typeof DEFAULT_PERMS] : DEFAULT_PERMS.friend) });

/** a role_settings row as stored (raw template and perms JSON, the requests_per_month column) */
export interface RoleSettingsRow { template: unknown; perms: unknown; requestsPerMonth: number | null }

/**
 * A role's rights without any account: template (with requestsPerMonth), switches and their sources. undefined for an unknown role.
 * `row`: resolve over this role_settings row instead of the stored one (null = no row); the role editor compares before and after.
 */
export async function roleRights(ctx: RightsCtx, role: string, row?: RoleSettingsRow | null): Promise<{ template: EffectiveLimits; perms: Perms; sources: Record<RightKey, RoleSource> } | undefined> {
  const explicit = row === undefined ? undefined : row && { template: readTemplate(row.template), perms: row.perms };
  const [r, req] = await Promise.all([
    resolveRole(ctx, role, explicit),
    row === undefined ? roleLimitRow(ctx, role) : row ? { limit: row.requestsPerMonth, set: true } : { limit: defaultLimit(role), set: false },
  ]);
  if (!r) return undefined;
  const perms = defaultPerms(r.base);
  const permSources = Object.fromEntries(PERM_KEYS.map((k) => [k, 'default'])) as Record<PermKey, RoleSource>;
  for (const [k, v] of Object.entries(readPerms(r.perms)) as Array<[PermKey, boolean]>) {
    perms[k] = v;
    permSources[k] = 'role';
  }
  if (role === 'admin') for (const k of PERM_KEYS) { perms[k] = true; permSources[k] = 'admin'; }
  return {
    template: { ...r.template, requestsPerMonth: req.limit },
    perms,
    sources: { ...r.sources, requestsPerMonth: req.set ? 'role' : 'default', ...permSources },
  };
}

async function cachedOverrides(ctx: RightsCtx, userId: string): Promise<UserOverrides> {
  let per = overrides.get(userId);
  const hit = per?.get(ctx);
  if (hit && Date.now() - hit.at <= TTL_MS) return hit.v;
  const v = await getUserOverrides(ctx, userId);
  if (!per) overrides.set(userId, (per = new WeakMap()));
  per.set(ctx, { at: Date.now(), v });
  return v;
}

/** the account's overrides in the effective encoding: field -> value (null = unlimited / unrestricted); unset fields are absent */
function overrideValues(u: UserOverrides): Partial<EffectiveLimits> {
  const out: Record<string, unknown> = {};
  const put = (k: TemplateKey | 'requestsPerMonth', v: unknown) => { if (v !== null && v !== undefined) out[k] = v; };
  put('maxStreams', u.maxStreams);
  put('remoteMaxBitrate', u.remoteBitrate);
  put('maxDownloads', u.maxDownloads);
  put('downloadMaxHeight', u.downloadMaxHeight);
  put('requestsPerMonth', u.requestsPerMonth);
  put('transcoding', u.transcoding);
  put('download', u.download);
  put('maxBitrate', u.maxBitrate);
  put('libraries', u.libraries);
  if (u.maxHeight !== null) out.maxHeight = u.maxHeight === 0 ? null : u.maxHeight;
  if (u.maxParentalRating !== null) out.maxParentalRating = u.maxParentalRating === -1 ? null : u.maxParentalRating;
  return out as Partial<EffectiveLimits>;
}

/**
 * What an account may do: its role's rights with the account's overrides on top, and for a kids profile the kids overlay (KIDS_OFF
 * switched off, the age cap lowered to the profile's). The override row is cached ~30 s per (ctx, user); the role layer has its own
 * caches (role rows, catalogue). undefined for an unknown role.
 */
export async function effectiveRights(ctx: RightsCtx, user: { id: string; role: string }, profile?: Pick<ProfileRow, 'kids' | 'kids_max_rating'> | null): Promise<Rights | undefined> {
  const [r, u] = await Promise.all([roleRights(ctx, user.role), cachedOverrides(ctx, user.id)]);
  if (!r) return undefined;
  const template: EffectiveLimits = { ...r.template };
  const perms: Perms = { ...r.perms };
  const sources: Record<RightKey, RightSource> = { ...r.sources };
  for (const [k, v] of Object.entries(overrideValues(u)) as Array<[TemplateKey | 'requestsPerMonth', never]>) {
    template[k] = v;
    sources[k] = 'user';
  }
  if (user.role !== 'admin') {
    for (const [k, v] of Object.entries(u.perms) as Array<[PermKey, boolean]>) {
      perms[k] = v;
      sources[k] = 'user';
    }
  }
  if (profile?.kids) {
    for (const k of KIDS_OFF) { perms[k] = false; sources[k] = 'kids'; }
    const cap = template.maxParentalRating;
    const kidsCap = cap === null ? profile.kids_max_rating : Math.min(cap, profile.kids_max_rating);
    if (kidsCap !== cap) { template.maxParentalRating = kidsCap; sources.maxParentalRating = 'kids'; }
  }
  return { template, perms, sources };
}

/**
 * Ids of the non-disabled accounts whose effective switch `perm` is off (account level: role and override, no kids overlay), e.g.
 * whose comments are hidden. Cached ~30 s per (ctx, perm).
 */
export async function accountsWithout(ctx: RightsCtx, perm: PermKey): Promise<string[]> {
  let per = without.get(ctx);
  const hit = per?.get(perm);
  if (hit && Date.now() - hit.at <= TTL_MS) return [...hit.ids];
  const rows = (await ctx.db.query<{ id: string; role: string; perms: unknown }>(
    'select u.id, u.role, l.perms from users u left join user_limits l on l.user_id = u.id where not u.disabled')).rows;
  const roles = new Map<string, Perms | undefined>();
  for (const role of new Set(rows.map((x) => x.role))) roles.set(role, (await roleRights(ctx, role))?.perms);
  const ids = rows.filter((x) => {
    const rp = roles.get(x.role);
    if (!rp) return false; // an unknown role has no rights to switch off
    if (x.role === 'admin') return false;
    return !(readPerms(x.perms)[perm] ?? rp[perm]);
  }).map((x) => x.id);
  if (!per) without.set(ctx, (per = new Map()));
  per.set(perm, { at: Date.now(), ids });
  return [...ids];
}

/** Drops the cached overrides of one account (all without an id) and every accountsWithout answer. */
export function invalidateRights(userId?: string): void {
  if (userId === undefined) overrides.clear();
  else overrides.delete(userId);
  without = new WeakMap();
}
