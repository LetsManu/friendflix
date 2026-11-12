// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
// rights.ts calls invalidateLivetvRights and this module calls effectiveRights: neither is used at module load, only inside functions
import { effectiveRights } from '../rights.js';
import { CHANNEL_COLUMNS, CHANNEL_FROM } from './channels.js';
import { livetvInstalled } from './detect.js';

/**
 * Who may see which Live TV channel (spec §8). The effective channel set of a profile:
 *   1. the account lacks `liveTv` (Phase 0 rights, user override and kids overlay included) -> nothing;
 *   2. groups = granted to the account's role (livetv_group_roles) + per-user allow - per-user deny; the admin role: every group.
 *      Groups with `released = false` are out for everyone, admins included, and a per-user allow does not reach them (ruling 39);
 *   3. kids profile -> only kid-friendly groups (an admin's kids profile too; it never sees channels without a group);
 *   4. channels in those groups, not hidden, not missing, source enabled. An admin's grown-up profile also sees channels without a group.
 * The set is cached 60 s per (account, role, profile, kids) and dropped by every group, channel or rights write (invalidateLivetvRights).
 */
type RightsCtx = Pick<Ctx, 'db' | 'roles'>;
export interface LivetvUser { id: string; role: string }
export interface LivetvProfile { id: string; kids: boolean }

const TTL_MS = 60_000;
/** ctx -> cache key -> channel ids; replaced as a whole by invalidateLivetvRights */
let sets = new WeakMap<object, Map<string, { at: number; ids: Set<string> }>>();
/** bumped by every invalidation: a set computed while a write ran is not stored (it may hold the state from before the write) */
let generation = 0;

/** Drops every cached channel set (all profiles). Called by every group / channel / exception write and by Phase 0 invalidateRights. */
export function invalidateLivetvRights(): void {
  generation++;
  sets = new WeakMap();
}

/** the account's switches with the kids overlay of the profile (only `kids` matters for the switches; the age cap is not read here) */
async function hasLiveTv(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile): Promise<boolean> {
  const r = await effectiveRights(ctx, user, profile.kids ? { kids: true, kids_max_rating: 0 } : null);
  return r?.perms.liveTv === true;
}

/**
 * The groups the profile may see: `all` = also channels without a group (the admin role on a grown-up profile); `ids` = the allowed,
 * released groups. null = the account (with the profile's kids overlay) lacks `liveTv`.
 */
export async function allowedGroups(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile): Promise<{ all: boolean; ids: Set<string> } | null> {
  if (!(await hasLiveTv(ctx, user, profile))) return null;
  const admin = user.role === 'admin';
  const rows = (await ctx.db.query<{ id: string }>(
    `select g.id from livetv_groups g
      where g.released
        and (not $1::boolean or g.kid_friendly)
        and ($2::boolean or (
          (exists (select 1 from livetv_group_roles r where r.group_id = g.id and r.role = $3)
            or exists (select 1 from livetv_group_users u where u.group_id = g.id and u.user_id = $4 and u.allow))
          and not exists (select 1 from livetv_group_users u where u.group_id = g.id and u.user_id = $4 and not u.allow)))`,
    [profile.kids, admin, user.role, user.id])).rows;
  return { all: admin && !profile.kids, ids: new Set(rows.map((r) => r.id)) };
}

async function computeSet(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile): Promise<Set<string>> {
  const groups = await allowedGroups(ctx, user, profile);
  if (!groups || (!groups.all && groups.ids.size === 0)) return new Set();
  // the effective group (override ?? provider map) comes from CHANNEL_COLUMNS; a channel whose group is unreleased is never in `ids`
  const rows = (await ctx.db.query<{ id: string }>(
    `select x.id from (select ${CHANNEL_COLUMNS}, s.enabled from ${CHANNEL_FROM}) x
      where not x.hidden and x.missing_since is null and x.enabled
        and (x.group_id = any($1::uuid[]) or ($2::boolean and x.group_id is null))`,
    [[...groups.ids], groups.all])).rows;
  return new Set(rows.map((r) => r.id));
}

/** The ids of the channels the profile may watch (spec §8 steps 1-4), cached 60 s. The caller must not change the returned set. */
export async function channelSet(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile): Promise<Set<string>> {
  const key = `${user.id}|${user.role}|${profile.id}|${profile.kids ? 1 : 0}`;
  const hit = sets.get(ctx)?.get(key);
  if (hit && Date.now() - hit.at <= TTL_MS) return hit.ids;
  const gen = generation;
  const ids = await computeSet(ctx, user, profile);
  if (gen === generation) {
    let per = sets.get(ctx);
    if (!per) sets.set(ctx, (per = new Map()));
    per.set(key, { at: Date.now(), ids });
  }
  return ids;
}

export async function channelAllowed(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile, channelId: string): Promise<boolean> {
  return (await channelSet(ctx, user, profile)).has(channelId);
}

/** `/api/me.features.livetv` (ruling 13): the container is installed, the account has `liveTv` and the profile sees at least one channel */
export async function livetvFeature(ctx: Ctx, user: LivetvUser, profile: LivetvProfile): Promise<boolean> {
  if (!livetvInstalled(ctx)) return false;
  return (await channelSet(ctx, user, profile)).size >= 1;
}

export type GroupHiddenReason = 'notReleased' | 'notKidFriendly' | 'notGranted' | 'denied';
export interface LivetvCheck {
  groups: Array<{ id: string; name: string; visible: boolean; reason: GroupHiddenReason | null }>;
  channels: number;
}

/**
 * *Sicht prüfen* -> Live-TV (spec §8, P0 spec §6.4): every group with whether the profile sees it and why not, and the number of
 * channels it sees. null when Live TV is not installed or the account (with the profile's kids overlay) lacks `liveTv`.
 */
export async function livetvCheck(ctx: Ctx, user: LivetvUser, profile: LivetvProfile): Promise<LivetvCheck | null> {
  if (!livetvInstalled(ctx) || !(await hasLiveTv(ctx, user, profile))) return null;
  const rows = (await ctx.db.query<{ id: string; name: string; released: boolean; kid_friendly: boolean; granted: boolean; allow: boolean | null }>(
    `select g.id, g.name, g.released, g.kid_friendly,
            exists (select 1 from livetv_group_roles r where r.group_id = g.id and r.role = $1) as granted,
            (select u.allow from livetv_group_users u where u.group_id = g.id and u.user_id = $2) as allow
       from livetv_groups g order by g.released, g.position, lower(g.name)`,
    [user.role, user.id])).rows;
  const admin = user.role === 'admin';
  const reasonOf = (g: (typeof rows)[number]): GroupHiddenReason | null => {
    if (!g.released) return 'notReleased';
    if (profile.kids && !g.kid_friendly) return 'notKidFriendly';
    if (admin) return null;
    if (g.allow === false) return 'denied';
    return g.granted || g.allow === true ? null : 'notGranted';
  };
  const groups = rows.map((g) => {
    const reason = reasonOf(g);
    return { id: g.id, name: g.name, visible: reason === null, reason };
  });
  return { groups, channels: (await channelSet(ctx, user, profile)).size };
}
