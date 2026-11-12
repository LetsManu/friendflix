// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';

/**
 * What the acting profile may do (`/api/me` -> `perms`, the effective switches the server enforces with 403s). The UI hides what
 * is off instead of offering a button that would be refused. Until /api/me answers - and for older backends that send nothing -
 * everything counts as allowed (the last visit's boot hint hides the denied entries before the first paint, see gate.ts).
 */
export type PermKey = 'requests' | 'cast' | 'party' | 'partySchedule' | 'comments' | 'liveTv' | 'liveRecord';
export type Perms = Record<PermKey, boolean>;
export const PERM_KEYS: readonly PermKey[] = ['requests', 'cast', 'party', 'partySchedule', 'comments', 'liveTv', 'liveRecord'];
export const ALL_PERMS: Perms = { requests: true, cast: true, party: true, partySchedule: true, comments: true, liveTv: true, liveRecord: true };

/** Lenient parse: only an explicit `false` turns a switch off. */
export function permsFrom(raw: unknown): Perms {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...ALL_PERMS };
  for (const k of PERM_KEYS) if (r[k] === false) out[k] = false;
  return out;
}
/** the switches that are off, in PERM_KEYS order */
export const deniedKeys = (p: Perms): PermKey[] => PERM_KEYS.filter((k) => !p[k]);

export const perms = writable<Perms>(ALL_PERMS);
