// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV → *Live-Status* and the guide counts (spec §9.4, §9.5, §20): the wire shapes of `GET /api/admin/livetv/status`
 * (backend/src/livetv/status.ts) and the pure text helpers the tab renders from. Nothing here is a URL: the answer carries channel ids,
 * names and numbers only (F13). The event codes are the backend's fixed list; the words come from `adminLive.ev.<code>` (F20).
 */
import { api } from '#lib/api';
import { fmtNumber, tr, type TKey } from '#lib/i18n';
import type { ConversionsView } from '../conversions';
import { sourceError } from './sources';

/** mirror of `LIVE_EVENT_CODES` (backend/src/livetv/events.ts), same order; a new code is added there first (F20) */
export const EVENT_CODES = [
  'source_refresh_failed',
  'ingest_sync_pending',
  'stopped_by_admin',
  'start_refused_full',
  'start_failed',
  'input_lost',
  'input_back',
  'push_rejected',
  'released_on_switch',
] as const;
export type LiveEventCode = (typeof EVENT_CODES)[number];
export type EventLevel = 'info' | 'warn' | 'error';

/** mirror of `LiveEvent` (backend/src/livetv/events.ts); `at` is epoch ms */
export interface LiveEvent {
  at: number;
  level: EventLevel;
  code: LiveEventCode;
  channelId?: string;
  sourceId?: string;
  n?: number;
  /** a fixed error code */
  reason?: string;
}

export type Mode = 'passthrough' | 'remux' | 'transcode';
export type InputState = 'ok' | 'reconnecting' | 'failed';
export type GpuAdvice = { level: 'warn' | 'info' | 'ok'; key: 'needsOverlay' | 'needsRenderGid' | 'needsNvidia' | 'cpuOnly' | 'both'; driver?: string };

export interface StatusStream {
  channelId: string;
  name: string;
  logoHash: string | null;
  mode: Mode;
  /** a count, never who (who watches is under Betrieb → Wiedergabe-Check) */
  viewers: number;
  since: number;
  bitrate: number | null;
  input: InputState;
  reconnects: number;
}
export interface StatusFeed {
  channelId: string;
  name: string;
  port: number;
  state: 'idle' | 'receiving';
  since: number | null;
  bitrate: number | null;
  rejected1h: number;
}
/** `GET /api/admin/livetv/status` (backend `LiveStatus`) */
export interface LiveStatus {
  version: string | null;
  budget: ConversionsView;
  system: { cpuPct: number; gpuPct: number | null; cache: { usedBytes: number; maxBytes: number } };
  streams: StatusStream[];
  ingest: StatusFeed[];
  events: LiveEvent[];
  gpu: { advice: GpuAdvice | null };
}
/** `GET /api/admin/livetv/epg/summary` (Task 17): channels with a programme mapped, all channels, and those without */
export interface EpgCounts { matched: number; total: number; unmatched: number }

const B = '/api/admin/livetv';
export const STATUS_POLL_MS = 5_000;
export const loadStatus = () => api<LiveStatus>(`${B}/status`);
export const loadCounts = () => api<EpgCounts>(`${B}/epg/summary`);
/** *Stoppen* and *Neu starten*: the stream ends; the next watcher starts it again. 503 `livetv_unreachable` when livetv does not answer. */
export const stopChannel = (channelId: string) => api<{ ok: true }>(`${B}/streams/${encodeURIComponent(channelId)}/stop`, { method: 'POST' });

const GB = 1024 ** 3;
const gb = (bytes: number) => fmtNumber(bytes / GB, { maximumFractionDigits: 1 });
/** "3,1 von 6 GB" (livetv counts its cache in GiB, the limit is set in GB); a dash while livetv cannot tell */
export function cacheLine(c: { usedBytes: number; maxBytes: number }): string {
  return c.maxBytes > 0 ? tr('adminLive.status.cacheLine', { used: gb(c.usedBytes), max: gb(c.maxBytes) }) : '–';
}

/** "4,2 Mbit/s"; a dash when livetv does not know */
export function bitrateText(bitsPerSecond: number | null): string {
  return bitsPerSecond === null || !Number.isFinite(bitsPerSecond) ? '–' : tr('adminLive.status.mbit', { n: fmtNumber(bitsPerSecond / 1e6, { maximumFractionDigits: 1 }) });
}

export const modeText = (m: Mode): string => tr(`adminLive.status.mode.${m}` as TKey);
export const levelWord = (l: EventLevel): string => tr(`adminLive.status.level.${l}` as TKey);
/** *läuft* / *verbinde neu (3)* / *gestört* */
export function inputText(s: InputState, reconnects: number): string {
  if (s === 'reconnecting') return reconnects > 0 ? tr('adminLive.status.input.reconnectingN', { n: reconnects }) : tr('adminLive.status.input.reconnecting');
  return tr(`adminLive.status.input.${s}` as TKey);
}

/**
 * The sentence of an event (spec §9.5; events carry codes and ids, never text, F13). `names.source` is the source's name where the
 * page knows it. A reason goes through `adminLive.src.err.<reason>` (`sourceError`): an unknown one never shows as text.
 */
export function eventText(e: LiveEvent, names: { source?: string } = {}): string {
  const code: LiveEventCode = EVENT_CODES.includes(e.code) ? e.code : 'start_failed';
  switch (code) {
    case 'source_refresh_failed':
      return tr('adminLive.ev.source_refresh_failed', { source: names.source ?? tr('adminLive.status.unknownSource'), reason: sourceError(e.reason ?? '') });
    case 'input_lost':
    case 'input_back':
      return typeof e.n === 'number' ? tr(`adminLive.ev.${code}` as TKey, { n: e.n }) : tr(`adminLive.evBare.${code}` as TKey);
    default:
      return tr(`adminLive.ev.${code}` as TKey);
  }
}

/** "398 von 412 Sendern mit Programm · 14 ohne" */
export function matchLine(c: EpgCounts): string {
  return tr('adminLive.epg.matched', { matched: c.matched, total: c.total, without: c.unmatched });
}
