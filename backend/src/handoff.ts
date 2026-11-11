// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { CastVia } from './cast.js';
import type { Ctx } from './ctx.js';
import type { ClientKind } from './deviceKind.js';
import { MediaError } from './media/types.js';
import type { JfUser } from './types.js';

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

/** what GET /api/handoff answers: no device id, play session id, address or URL */
export interface HandoffAnswer {
  /** opaque, stable while that device plays that title */
  id: string;
  itemId: string;
  type: 'Movie' | 'Episode';
  title: string;
  year?: number;
  seriesName?: string;
  season?: number;
  episode?: number;
  imageId: string;
  positionTicks: number;
  runtimeTicks?: number;
  ageSec: number;
  device: { kind: ClientKind; name?: string; via?: HandoffVia };
}

const MIN_TICKS = 600_000_000; // 60 s
const MAX_AGE_HOURS = 6;

interface HandoffRow {
  device_id: string;
  item_id: string;
  series_id: string | null;
  position_ticks: string;
  runtime_ticks: string | null;
  via: HandoffVia | null;
  started_at: Date;
  age_sec: string;
  stale: boolean;
  hidden: boolean;
  client: ClientKind | null;
  name: string | null;
  label: string | null;
}

/**
 * The profile's offer "continue here" (spec 2.3): its newest row (of the item or series `item`, if given) unless that is this
 * device, too old, too short, nearly finished, hidden from Weiterschauen, dropped, gone from the library or already played.
 * All time decisions use the database's clock.
 */
export async function selectHandoff(ctx: Ctx, who: { userId: string; profileId: string; deviceId: string; jfUser: JfUser }, item?: string): Promise<HandoffAnswer | null> {
  await pruneHandoff(ctx, who.profileId);
  const r = (await ctx.db.query<HandoffRow>(
    `select h.device_id, h.item_id, h.series_id, h.position_ticks::text, h.runtime_ticks::text, h.via, h.started_at,
            floor(extract(epoch from now() - h.updated_at))::text as age_sec,
            h.updated_at < now() - interval '${MAX_AGE_HOURS} hours' as stale,
            (exists (select 1 from resume_hidden r where r.profile_id = h.profile_id and r.item_id in (h.item_id, h.series_id) and r.hidden_at >= h.updated_at)
             or exists (select 1 from dropped d where d.profile_id = h.profile_id and d.item_id in (h.item_id, h.series_id))) as hidden,
            d.client, d.name, d.label
       from handoff h left join devices d on d.user_id = h.user_id and d.device_id = h.device_id
      where h.profile_id = $1 and ($2::text is null or h.item_id = $2 or h.series_id = $2)
      order by h.updated_at desc limit 1`,
    [who.profileId, item ?? null],
  )).rows[0];
  if (!r || r.device_id === who.deviceId || r.stale || r.hidden) return null;
  const pos = Number(r.position_ticks);
  const runtime = r.runtime_ticks == null ? undefined : Number(r.runtime_ticks);
  if (pos < MIN_TICKS || (runtime !== undefined && runtime > 0 && pos >= runtime * 0.9)) return null;
  let it;
  try {
    it = await ctx.jf.item(who.jfUser, r.item_id);
  } catch (e) {
    if (e instanceof MediaError && (e.status === 404 || e.status === 403)) {
      await ctx.db.query('delete from handoff where profile_id = $1 and device_id = $2 and item_id = $3', [who.profileId, r.device_id, r.item_id]);
      return null;
    }
    throw e;
  }
  if (it.played || (it.type !== 'Movie' && it.type !== 'Episode')) return null;
  const kind: ClientKind = r.client ?? 'web';
  const name = r.name ?? (kind === 'web' ? r.label : null);
  const rt = runtime ?? it.runtimeTicks;
  return {
    id: createHash('sha256').update(`${r.device_id}|${r.item_id}|${r.started_at.toISOString()}`).digest('hex').slice(0, 16),
    itemId: it.id, type: it.type, title: it.name,
    ...(it.year != null ? { year: it.year } : {}),
    ...(it.seriesName ? { seriesName: it.seriesName } : {}),
    ...(it.parentIndexNumber != null ? { season: it.parentIndexNumber } : {}),
    ...(it.indexNumber != null && it.type === 'Episode' ? { episode: it.indexNumber } : {}),
    imageId: it.type === 'Episode' && !it.image ? (it.seriesId ?? r.series_id ?? it.id) : it.id,
    positionTicks: pos,
    ...(rt != null ? { runtimeTicks: rt } : {}),
    ageSec: Number(r.age_sec),
    device: { kind, ...(name ? { name } : {}), ...(r.via ? { via: r.via } : {}) },
  };
}
