// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CastVia } from './cast.js';
import type { Ctx } from './ctx.js';

/**
 * Device hand-off ("Continue here"): per profile and device the latest thing that device played, how far and when (table `handoff`,
 * migration 46). Written by every playback report (routes/media.ts playbackReport); read by GET /api/handoff. Rows hold ids,
 * positions and the database's clock only, never leave the profile, and live at most 24 hours.
 */

/** how the device played it: on a TV through AirPlay or Chromecast; null = on the device itself */
export type HandoffVia = CastVia;

/** a row older than this is gone (deleted lazily on each write and read of the profile) */
export const HANDOFF_KEEP_HOURS = 24;

/** deletes the profile's rows older than HANDOFF_KEEP_HOURS; shared by the write and the read path */
export async function pruneHandoff(ctx: Pick<Ctx, 'db'>, profileId: string): Promise<void> {
  await ctx.db.query(`delete from handoff where profile_id = $1 and updated_at < now() - interval '${HANDOFF_KEEP_HOURS} hours'`, [profileId]);
}

export interface HandoffWrite {
  userId: string;
  profileId: string;
  deviceId: string;
  itemId: string;
  seriesId?: string;
  positionTicks: number;
  runtimeTicks?: number;
  via: HandoffVia | null;
  /** a `start` report: this device began the item now */
  start: boolean;
}

/** the error class of a failed write: a pg code or the error's name, never its message (it can quote ids) */
const errorClass = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  return e instanceof Error ? e.name : 'unknown';
};

/**
 * Upserts the profile's row for this device. Best effort: never throws, logs only an error class. `started_at` moves on `start`
 * and when the item changed; series and runtime are replaced when the item changed, else a missing value keeps the stored one.
 */
export async function noteHandoff(ctx: Pick<Ctx, 'db'>, w: HandoffWrite): Promise<void> {
  try {
    await pruneHandoff(ctx, w.profileId);
    await ctx.db.query(
      `insert into handoff as h (profile_id, user_id, device_id, item_id, series_id, position_ticks, runtime_ticks, via)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (profile_id, device_id) do update set
         position_ticks = excluded.position_ticks,
         via = excluded.via,
         updated_at = now(),
         started_at = case when $9 or h.item_id <> excluded.item_id then now() else h.started_at end,
         series_id = case when h.item_id <> excluded.item_id then excluded.series_id else coalesce(excluded.series_id, h.series_id) end,
         runtime_ticks = case when h.item_id <> excluded.item_id then excluded.runtime_ticks else coalesce(excluded.runtime_ticks, h.runtime_ticks) end,
         item_id = excluded.item_id`,
      [w.profileId, w.userId, w.deviceId, w.itemId, w.seriesId ?? null, Math.max(0, Math.floor(w.positionTicks)), w.runtimeTicks == null ? null : Math.floor(w.runtimeTicks), w.via, w.start],
    );
  } catch (e) {
    console.warn('handoff write failed', errorClass(e));
  }
}
