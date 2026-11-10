// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Upload-aware cap for NEW remote streams (Admin -> Settings -> Playback, UPLOAD_MBPS; empty = off). One home server shares its
 * upload with every viewer outside the home networks: when it is busy, a new remote stream starts at a lower bitrate instead of
 * every stream stalling. The rule, on purpose simple and predictable:
 *
 *   free = 0.85 × upload − Σ bitrate of the OTHER remote streams that are live now
 *
 * - only remote viewers are capped and counted (home viewers never touch the upload);
 * - streams already running are never changed; a paused one still counts (it resumes);
 * - the requesting device's own stream is not counted (a quality switch or restart replaces it);
 * - a stream counts with the cap it was granted at start (an upper bound: a direct play never exceeds it); streams the portal does
 *   not know a bitrate for (other apps on the media server, older records) are not counted;
 * - if `free` reaches the viewer's normal ceiling nothing changes; otherwise the stream starts at the highest player rung
 *   (8 / 4 / 1.5 Mbit/s) that fits, never below 1.5 Mbit/s;
 * - 15 % stay in reserve for protocol overhead and the household's own traffic.
 * Nothing about the viewer is measured or stored: the inputs are the admin's number and the live records the stream limit uses.
 */
export const UPLOAD_RESERVE = 0.15;
/** the web player's quality rungs below "original" that the cap snaps to (lib/player/abr.ts), highest first */
export const UPLOAD_RUNGS = [8_000_000, 4_000_000, 1_500_000] as const;
export const UPLOAD_FLOOR = 1_500_000;

export interface LiveLoad { bitrate?: number; remote?: boolean; deviceId?: string }

export function uploadCap(o: { uploadMbps: number | undefined; remote: boolean; ceiling: number; deviceId?: string; others: readonly LiveLoad[] }): { cap: number; limited: boolean } {
  const same = { cap: o.ceiling, limited: false };
  if (!o.remote || !o.uploadMbps || !(o.uploadMbps > 0)) return same;
  const used = o.others
    .filter((l) => l.remote === true && typeof l.bitrate === 'number' && l.bitrate > 0 && !(o.deviceId && l.deviceId === o.deviceId))
    .reduce((a, l) => a + l.bitrate!, 0);
  const free = o.uploadMbps * 1_000_000 * (1 - UPLOAD_RESERVE) - used;
  if (free >= o.ceiling) return same;
  const rung = UPLOAD_RUNGS.find((r) => r <= free) ?? UPLOAD_FLOOR;
  const cap = Math.min(o.ceiling, Math.max(UPLOAD_FLOOR, rung));
  return cap < o.ceiling ? { cap, limited: true } : same;
}
