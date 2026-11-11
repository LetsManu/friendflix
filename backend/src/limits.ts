// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { readPerms, type Perms } from './perms.js';
// limits.ts and rights.ts import each other (the resolver reads the overrides, the wrapper calls the resolver): only inside functions
import { effectiveRights, invalidateRights } from './rights.js';
import type { RoleTemplate } from './roles.js';

/** Per-user overrides (table user_limits). null = the role value applies. */
export type UserLimits = { maxStreams: number | null; remoteBitrate: number | null; maxDownloads: number | null; downloadMaxHeight: number | null; requestsPerMonth: number | null };
/**
 * Every per-user override (user_limits, migration 47), in the stored encoding: null = as the role; `maxHeight` 0 = unlimited;
 * `maxParentalRating` -1 = unrestricted, 0..21 = cap; `libraries` 'all' or library names; `perms` only the switches set for this account.
 */
export type UserOverrides = UserLimits & {
  transcoding: boolean | null; maxHeight: number | null; download: boolean | null; maxBitrate: number | null; maxParentalRating: number | null;
  libraries: 'all' | string[] | null; perms: Partial<Perms>; note: string | null;
};
/** The role template with the user's overrides on top, plus the monthly request limit (null = unlimited). */
export type EffectiveLimits = RoleTemplate & { requestsPerMonth: number | null };

const NONE: UserLimits = { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null };
const NO_OVERRIDES: UserOverrides = { ...NONE, transcoding: null, maxHeight: null, download: null, maxBitrate: null, maxParentalRating: null, libraries: null, perms: {}, note: null };

/** the row goes once nothing is overridden any more (the user follows the role again) */
const DROP_EMPTY = `delete from user_limits where user_id=$1 and max_streams is null and remote_bitrate is null and max_downloads is null
  and download_max_height is null and requests_per_month is null and transcoding is null and max_height is null and download is null
  and max_bitrate is null and max_parental_rating is null and libraries is null and perms = '{}'::jsonb and note is null`;

export async function getUserLimits(ctx: Pick<Ctx, 'db'>, userId: string): Promise<UserLimits> {
  const { maxStreams, remoteBitrate, maxDownloads, downloadMaxHeight, requestsPerMonth } = await getUserOverrides(ctx, userId);
  return { maxStreams, remoteBitrate, maxDownloads, downloadMaxHeight, requestsPerMonth };
}

/** Stores the five limits of the old editor; the other overrides stay. Nothing overridden any more removes the row. */
export async function setUserLimits(ctx: Pick<Ctx, 'db'>, userId: string, l: UserLimits): Promise<void> {
  await ctx.db.query(
    `insert into user_limits(user_id, max_streams, remote_bitrate, max_downloads, download_max_height, requests_per_month) values ($1,$2,$3,$4,$5,$6)
     on conflict (user_id) do update set max_streams=$2, remote_bitrate=$3, max_downloads=$4, download_max_height=$5, requests_per_month=$6, updated_at=now()`,
    [userId, l.maxStreams, l.remoteBitrate, l.maxDownloads, l.downloadMaxHeight, l.requestsPerMonth]);
  await ctx.db.query(DROP_EMPTY, [userId]);
  invalidateLimits(userId);
}

const readLibraries = (v: unknown): 'all' | string[] | null =>
  v === 'all' ? 'all' : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

export async function getUserOverrides(ctx: Pick<Ctx, 'db'>, userId: string): Promise<UserOverrides> {
  const r = await ctx.db.query<{
    max_streams: number | null; remote_bitrate: number | null; max_downloads: number | null; download_max_height: number | null; requests_per_month: number | null;
    transcoding: boolean | null; max_height: number | null; download: boolean | null; max_bitrate: number | null; max_parental_rating: number | null;
    libraries: unknown; perms: unknown; note: string | null;
  }>(`select max_streams, remote_bitrate, max_downloads, download_max_height, requests_per_month, transcoding, max_height, download, max_bitrate,
        max_parental_rating, libraries, perms, note from user_limits where user_id=$1`, [userId]);
  const x = r.rows[0];
  if (!x) return { ...NO_OVERRIDES, perms: {} };
  return {
    maxStreams: x.max_streams, remoteBitrate: x.remote_bitrate, maxDownloads: x.max_downloads, downloadMaxHeight: x.download_max_height, requestsPerMonth: x.requests_per_month,
    transcoding: x.transcoding, maxHeight: x.max_height, download: x.download, maxBitrate: x.max_bitrate, maxParentalRating: x.max_parental_rating,
    libraries: readLibraries(x.libraries), perms: readPerms(x.perms), note: x.note,
  };
}

/** Stores every override of an account; every field null, `perms` empty and no note removes the row. */
export async function setUserOverrides(ctx: Pick<Ctx, 'db'>, userId: string, o: UserOverrides): Promise<void> {
  await ctx.db.query(
    `insert into user_limits(user_id, max_streams, remote_bitrate, max_downloads, download_max_height, requests_per_month, transcoding, max_height, download,
       max_bitrate, max_parental_rating, libraries, perms, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (user_id) do update set max_streams=$2, remote_bitrate=$3, max_downloads=$4, download_max_height=$5, requests_per_month=$6, transcoding=$7,
       max_height=$8, download=$9, max_bitrate=$10, max_parental_rating=$11, libraries=$12, perms=$13, note=$14, updated_at=now()`,
    [userId, o.maxStreams, o.remoteBitrate, o.maxDownloads, o.downloadMaxHeight, o.requestsPerMonth, o.transcoding, o.maxHeight, o.download,
      o.maxBitrate, o.maxParentalRating, o.libraries === null ? null : JSON.stringify(o.libraries), JSON.stringify(o.perms), o.note]);
  await ctx.db.query(DROP_EMPTY, [userId]);
  invalidateLimits(userId);
}

/**
 * Effective role with the user's overrides on top (effectiveRights' template, same shape as before the rights model).
 * The override row is cached ~30 s per (ctx, user); undefined for an unknown role (like effectiveRole).
 */
export async function effectiveLimits(ctx: Pick<Ctx, 'db' | 'roles'>, user: { id: string; role: string }): Promise<EffectiveLimits | undefined> {
  return (await effectiveRights(ctx, user))?.template;
}

/** Drops the cached overrides of one user (all users without an id) and the derived rights caches. */
export const invalidateLimits = (userId?: string) => invalidateRights(userId);
