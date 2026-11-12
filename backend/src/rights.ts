// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
// rights.ts and limits.ts import each other: neither may use the other's exports at module load, only inside functions
import { getUserOverrides, type EffectiveLimits, type UserOverrides } from './limits.js';
// likewise livetv/rights.ts (it resolves `liveTv` through effectiveRights; its channel sets follow every rights change)
import { invalidateLivetvRights } from './livetv/rights.js';
import { DEFAULT_PERMS, KIDS_OFF, MATRIX_FIELDS, PERM_KEYS, readPerms, type PermKey, type Perms } from './perms.js';
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
  const [r, stored] = await Promise.all([
    resolveRole(ctx, role, explicit),
    row === undefined ? roleLimitRow(ctx, role) : row ? { limit: row.requestsPerMonth, set: true } : null,
  ]);
  if (!r) return undefined;
  // a stored limit equal to the base's default reads as inherited (ruling 2: "back to the default" writes the default, as does the
  // first write of any other field, because a null column means unlimited)
  const inherited = defaultLimit(r.base);
  const req = stored?.set ? stored : { limit: inherited, set: false };
  const reqSource: RoleSource = req.set && req.limit !== inherited ? 'role' : 'default';
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
    sources: { ...r.sources, requestsPerMonth: reqSource, ...permSources },
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

/**
 * the account's overrides in the effective encoding: field -> value (null = unlimited / unrestricted); unset fields are absent.
 * Stored sentinels: maxHeight 0, maxParentalRating -1 and requestsPerMonth -1 mean unlimited (the column's null is "as the role").
 */
function overrideValues(u: UserOverrides): Partial<EffectiveLimits> {
  const out: Record<string, unknown> = {};
  const put = (k: TemplateKey | 'requestsPerMonth', v: unknown) => { if (v !== null && v !== undefined) out[k] = v; };
  put('maxStreams', u.maxStreams);
  put('remoteMaxBitrate', u.remoteBitrate);
  put('maxDownloads', u.maxDownloads);
  put('downloadMaxHeight', u.downloadMaxHeight);
  put('downloadDays', u.downloadDays);
  if (u.requestsPerMonth !== null) out.requestsPerMonth = u.requestsPerMonth === -1 ? null : u.requestsPerMonth;
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
 * caches (role rows, catalogue). undefined for an unknown role. `explicit`: resolve over this override row instead of the stored one
 * (the rights editor compares before and after a write).
 */
export async function effectiveRights(
  ctx: RightsCtx, user: { id: string; role: string }, profile?: Pick<ProfileRow, 'kids' | 'kids_max_rating'> | null, explicit?: UserOverrides,
): Promise<Rights | undefined> {
  const [r, u] = await Promise.all([roleRights(ctx, user.role), explicit ?? cachedOverrides(ctx, user.id)]);
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
 * whose comments are hidden. An account whose role does not resolve counts as off (fail closed). Cached ~30 s per (ctx, perm).
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
    if (!rp) return true; // fail closed: an account whose role nobody knows has every switch off
    if (x.role === 'admin') return false;
    return !(readPerms(x.perms)[perm] ?? rp[perm]);
  }).map((x) => x.id);
  if (!per) without.set(ctx, (per = new Map()));
  per.set(perm, { at: Date.now(), ids });
  return [...ids];
}

// ---- comparing two resolutions (the role and the rights editor decide audit and policy re-apply with it) ----

/** fields the media server enforces through the identity policy: a change re-applies it (spec §2.3; `download` is the policy's
 * EnableContentDownloading / Plex' download flag, so it re-applies as the legacy editor did) */
export const MEDIA_FIELDS: ReadonlySet<string> = new Set(['libraries', 'maxParentalRating', 'maxStreams', 'maxBitrate', 'transcoding', 'maxHeight', 'download']);
export const isPerm = (k: string): k is PermKey => (PERM_KEYS as readonly string[]).includes(k);
/** equal as stored and audited (JSON; key order of objects counts, as both sides come from the same resolver) */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** a resolution of roleRights or effectiveRights */
export type Resolved = { template: EffectiveLimits; perms: Perms; sources: Record<RightKey, RightSource> };
/** the value of a matrix field (template field, requestsPerMonth or switch) in a resolution */
export const valueOf = (r: Resolved, k: string): unknown => (isPerm(k) ? r.perms[k] : r.template[k as keyof EffectiveLimits]);

export interface RightsDiff {
  /** changed values and values that only moved between layers: field -> value before / after */
  from: Record<string, unknown>; to: Record<string, unknown>;
  /** the fields whose value stayed but whose deciding layer moved (pinned / unpinned): field -> source before / after */
  layer: Record<string, { from: RightSource; to: RightSource }>;
  /** a value the media server policy carries changed: its identities need the policy again */
  media: boolean;
  /** some value changed (not only a layer) */
  effective: boolean;
}

/** what a write changed, over every matrix field: the audit's `{ from, to, layer }`, and whether policies and memos must follow */
export function diffRights(before: Resolved, after: Resolved): RightsDiff {
  const d: RightsDiff = { from: {}, to: {}, layer: {}, media: false, effective: false };
  for (const { key: k } of MATRIX_FIELDS) {
    const a = valueOf(before, k);
    const b = valueOf(after, k);
    const sa = before.sources[k as RightKey];
    const sb = after.sources[k as RightKey];
    if (!same(a, b)) {
      d.from[k] = a; d.to[k] = b; d.effective = true;
      if (MEDIA_FIELDS.has(k)) d.media = true;
    } else if (sa !== sb) {
      d.from[k] = a; d.to[k] = b; d.layer[k] = { from: sa, to: sb };
    }
  }
  return d;
}

/** Drops the cached overrides of one account (all without an id), every accountsWithout answer and every cached Live TV channel set. */
export function invalidateRights(userId?: string): void {
  if (userId === undefined) overrides.clear();
  else overrides.delete(userId);
  without = new WeakMap();
  invalidateLivetvRights();
}
