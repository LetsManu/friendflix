// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';

/**
 * Live TV channels (spec §6.1): the stored row and the effective values every reader uses. Derived values live here, not in a SQL view,
 * so they can change without a migration (ruling, Task 12). Import fields (`import_*`) are rewritten by every refresh, admin overrides
 * never are; the effective value is the most specific one that is set. The own-feeds source kind is stored as 'manual' (spec §6.1
 * SQL); the API and the web call it 'feeds'.
 */

/** `livetv_sources.kind` of the own-feeds source as stored (spec §6.1); the API and the web say 'feeds' */
export const OWN_FEEDS_KIND = 'manual';
export const isOwnFeeds = (kind: string): boolean => kind === OWN_FEEDS_KIND;

export type StreamKind = 'hls' | 'ts' | 'srt';
export type Ingest = 'pull' | 'push';

/** the last stream probe (`livetv_channels.probe`) */
export interface ProbeRec {
  at: string;
  ok: boolean;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; channels: number };
  needs: 'passthrough' | 'remux' | 'transcode' | null;
  error?: string;
}

/** a `livetv_channels` row as stored (migration 48); `*_enc` columns are APP_ENC_KEY blobs and never leave the backend */
export interface ChannelRow {
  id: string;
  source_id: string;
  source_key: string;
  stream_url_enc: string | null;
  stream_kind: StreamKind;
  ingest: Ingest;
  push_port: number | null;
  push_stream_id_enc: string | null;
  push_stream_id_hint: string | null;
  push_passphrase_enc: string | null;
  allow_lan: boolean | null;
  import_name: string;
  import_number: number | null;
  import_group: string | null;
  import_logo_hash: string | null;
  tvg_id: string | null;
  tvg_name: string | null;
  import_epg_shift_min: number | null;
  name_override: string | null;
  number_override: number | null;
  group_override: string | null;
  logo_override_hash: string | null;
  epg_shift_override_min: number | null;
  hidden: boolean;
  epg_source_id: string | null;
  epg_channel_id: string | null;
  epg_match: 'auto' | 'manual' | 'none';
  epg_logo_hash: string | null;
  probe: ProbeRec | null;
  missing_since: Date | null;
  created_at: Date;
}

export type EpgShiftFrom = 'channel' | 'list' | 'source' | 'none';

export interface EffectiveChannel {
  id: string;
  sourceId: string;
  number: number | null;
  name: string;
  groupId: string | null;
  logoHash: string | null;
  hidden: boolean;
  missing: boolean;
  streamKind: StreamKind;
  ingest: Ingest;
  epg: { sourceId: string; channelId: string } | null;
  epgShiftMin: number;
  epgShiftFrom: EpgShiftFrom;
  probe: ProbeRec | null;
}

/** what CHANNEL_SELECT returns per row (no encrypted column) */
export interface EffectiveRow {
  id: string;
  source_id: string;
  name: string;
  number: number | null;
  group_id: string | null;
  logo_hash: string | null;
  hidden: boolean;
  missing_since: Date | null;
  stream_kind: StreamKind;
  ingest: Ingest;
  epg_source_id: string | null;
  epg_channel_id: string | null;
  epg_shift_min: number;
  epg_shift_from: EpgShiftFrom;
  probe: ProbeRec | null;
}

/** the effective EPG offset in minutes (override, else the list's tvg-shift, else the source's); one fragment for CHANNEL_COLUMNS and nowNext */
export const EFFECTIVE_SHIFT_SQL = 'coalesce(c.epg_shift_override_min, c.import_epg_shift_min, s.epg_shift_min)';
/** the effective columns over `livetv_channels c join livetv_sources s` (aliases `c`, `s` are part of the contract) */
export const CHANNEL_COLUMNS = `c.id, c.source_id,
  coalesce(c.name_override, c.import_name) as name,
  coalesce(c.number_override, c.import_number) as number,
  coalesce(c.group_override, (select m.group_id from livetv_group_map m where m.source_id = c.source_id and m.provider_group = c.import_group)) as group_id,
  coalesce(c.logo_override_hash, case when s.logo_pref = 'xmltv' then coalesce(c.epg_logo_hash, c.import_logo_hash)
    else coalesce(c.import_logo_hash, c.epg_logo_hash) end) as logo_hash,
  c.hidden, c.missing_since, c.stream_kind, c.ingest, c.epg_source_id, c.epg_channel_id,
  ${EFFECTIVE_SHIFT_SQL} as epg_shift_min,
  case when c.epg_shift_override_min is not null then 'channel' when c.import_epg_shift_min is not null then 'list'
    when s.epg_shift_min <> 0 then 'source' else 'none' end as epg_shift_from,
  c.probe`;
export const CHANNEL_FROM = 'livetv_channels c join livetv_sources s on s.id = c.source_id';
/**
 * `${CHANNEL_SELECT} where …` reads effective channel rows; pass each through toEffective. The effective columns (`name`, `number`,
 * `group_id`, `logo_hash`, `epg_shift_min`, `epg_shift_from`) are select-list aliases, so a `where`/`order by`/`join` on them in the
 * same query is invalid SQL (`where group_id = …`): to filter by the effective group (rights, group listings) wrap it
 * (`select * from (${CHANNEL_SELECT}) e where e.group_id = any($1)`) or build the query from CHANNEL_COLUMNS / CHANNEL_FROM and repeat
 * the coalesce expression in the condition.
 */
export const CHANNEL_SELECT = `select ${CHANNEL_COLUMNS} from ${CHANNEL_FROM}`;

export function toEffective(r: EffectiveRow): EffectiveChannel {
  return {
    id: r.id,
    sourceId: r.source_id,
    number: r.number,
    name: r.name,
    groupId: r.group_id,
    logoHash: r.logo_hash,
    hidden: r.hidden,
    missing: r.missing_since !== null,
    streamKind: r.stream_kind,
    ingest: r.ingest,
    epg: r.epg_source_id !== null && r.epg_channel_id !== null ? { sourceId: r.epg_source_id, channelId: r.epg_channel_id } : null,
    epgShiftMin: r.epg_shift_min,
    epgShiftFrom: r.epg_shift_from,
    probe: r.probe,
  };
}

/**
 * The host shown in the SRT push setup hint (spec §3.5): LIVETV_SRT_HOST, else the host of PUBLIC_URL, derived when read. null while
 * neither is known (PUBLIC_URL is '' before setup): callers then show no host.
 */
export function srtHost(ctx: Ctx): string | null {
  if (ctx.cfg.LIVETV_SRT_HOST) return ctx.cfg.LIVETV_SRT_HOST;
  try {
    return ctx.cfg.PUBLIC_URL ? new URL(ctx.cfg.PUBLIC_URL).hostname || null : null;
  } catch {
    return null;
  }
}
