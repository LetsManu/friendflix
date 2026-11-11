// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { castEnabled } from './cast.js';
import type { Ctx } from './ctx.js';
import { requestsEnabled } from './seerr/client.js';

/**
 * The permission registry (spec §1): on/off switches per role (role_settings.perms) and per account (user_limits.perms). Downloads stay
 * the template field `download`. A key removed in a later version is ignored on read and rejected on write.
 */
export const PERM_KEYS = ['requests', 'cast', 'party', 'partySchedule', 'comments', 'liveTv', 'liveRecord'] as const;
export type PermKey = (typeof PERM_KEYS)[number];
export type Perms = Record<PermKey, boolean>;

const ALL_ON: Perms = { requests: true, cast: true, party: true, partySchedule: true, comments: true, liveTv: true, liveRecord: true };
/** today's behaviour: guests have no comments (anime.ts), only admins keep more than 3 scheduled parties (party.ts) */
export const DEFAULT_PERMS: Record<'admin' | 'family' | 'friend' | 'guest', Perms> = {
  admin: { ...ALL_ON },
  family: { ...ALL_ON, partySchedule: false },
  friend: { ...ALL_ON, partySchedule: false },
  guest: { ...ALL_ON, partySchedule: false, comments: false, liveRecord: false },
};

/** switched off for a kids profile whatever role and overrides say (the hard kids overlay) */
export const KIDS_OFF: readonly PermKey[] = ['requests', 'party', 'partySchedule', 'comments', 'liveRecord'];

/** the optional feature a switch belongs to: hidden in the editor while the feature is absent */
export const PERM_REQUIRES: Partial<Record<PermKey, 'requests' | 'cast' | 'livetv'>> = { requests: 'requests', cast: 'cast', liveTv: 'livetv', liveRecord: 'livetv' };

const isPermKey = (k: string): k is PermKey => (PERM_KEYS as readonly string[]).includes(k);

/** stored perms JSON → known keys with boolean values only (anything else is ignored, never an error) */
export function readPerms(raw: unknown): Partial<Perms> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Perms> = {};
  for (const [k, v] of Object.entries(raw)) if (isPermKey(k) && typeof v === 'boolean') out[k] = v;
  return out;
}

/** a perms change on write: true / false sets, null clears (inherit); unknown keys are rejected */
export const permsPatch: z.ZodType<Partial<Record<PermKey, boolean | null>>> = z
  .object(Object.fromEntries(PERM_KEYS.map((k) => [k, z.boolean().nullable().optional()])) as Record<PermKey, z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>)
  .strict();

export type FieldKind = 'bool' | 'int' | 'bitrate' | 'height' | 'rating' | 'libraries';
export type FieldGroup = 'access' | 'playback' | 'downloads' | 'requests' | 'together' | 'cast' | 'livetv';
export interface MatrixField { key: string; group: FieldGroup; kind: FieldKind; min?: number; max?: number; options?: Array<number | null>; requires?: 'requests' | 'cast' | 'livetv' }

const BITRATE = { kind: 'bitrate', min: 300_000, max: 200_000_000 } as const;
/** the rows of the role matrix and the rights editor, in display order */
export const MATRIX_FIELDS: readonly MatrixField[] = [
  { key: 'libraries', group: 'access', kind: 'libraries' },
  { key: 'maxParentalRating', group: 'access', kind: 'rating', options: [null, 0, 6, 12, 16, 18] },
  { key: 'maxStreams', group: 'playback', kind: 'int', min: 1, max: 50 },
  { key: 'maxBitrate', group: 'playback', ...BITRATE },
  { key: 'remoteMaxBitrate', group: 'playback', ...BITRATE },
  { key: 'transcoding', group: 'playback', kind: 'bool' },
  { key: 'maxHeight', group: 'playback', kind: 'height', options: [null, 720, 1080, 1440, 2160] },
  { key: 'download', group: 'downloads', kind: 'bool' },
  { key: 'maxDownloads', group: 'downloads', kind: 'int', min: 0, max: 200 },
  { key: 'downloadMaxHeight', group: 'downloads', kind: 'height', options: [480, 720, 1080, 2160] },
  { key: 'downloadDays', group: 'downloads', kind: 'int', min: 1, max: 90 },
  { key: 'requests', group: 'requests', kind: 'bool', requires: 'requests' },
  { key: 'requestsPerMonth', group: 'requests', kind: 'int', min: 0, max: 100, options: [null], requires: 'requests' },
  { key: 'party', group: 'together', kind: 'bool' },
  { key: 'partySchedule', group: 'together', kind: 'bool' },
  { key: 'comments', group: 'together', kind: 'bool' },
  { key: 'cast', group: 'cast', kind: 'bool', requires: 'cast' },
  { key: 'liveTv', group: 'livetv', kind: 'bool', requires: 'livetv' },
  { key: 'liveRecord', group: 'livetv', kind: 'bool', requires: 'livetv' },
];

/** which optional features this install has (the editor hides the rows of absent ones); Live TV detection ships with Live TV Phase 1b */
export function featureFlags(ctx: Ctx): { requests: boolean; cast: boolean; livetv: boolean } {
  return { requests: requestsEnabled(ctx), cast: castEnabled(ctx), livetv: false };
}
