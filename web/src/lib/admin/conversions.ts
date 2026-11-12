// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Betrieb → Wiedergabe-Check, card *Umwandlungen* (live TV spec §5.6): the answer of GET /api/admin/conversions and the pure
 * helpers the card renders from (slot bar, hardware names, the measured line, the priority hint, the last outcome, refusals).
 */
import { ApiError } from '#lib/api';
import { fmtDateTime, fmtDuration, fmtNumber, fmtTime, tr, type TKey } from '#lib/i18n';

export type ConvKind = 'film' | 'live' | 'record' | 'download' | 'reencode';
export type ConvPriority = 'films' | 'live' | 'equal';
export type BenchOutcome = 'ok' | 'failed' | 'no_title' | 'busy' | 'no_user' | 'unsupported';

/** mirror of `ConversionsView` (backend/src/convbench.ts); `since` is an ISO time or null (null for now) */
export interface ConversionsView {
  limit: number;
  auto: number;
  custom: number | null;
  priority: ConvPriority;
  used: number;
  running: Array<{ kind: ConvKind; hevc: boolean; label: string | null; since: string | null; device: string | null }>;
  bench: {
    jellyfin: { speed: number; hwAccel: string; at: string } | null;
    livetv: { speed: number; encoder: string; at: string } | null;
    recommended: number | null;
    stale: boolean;
    noRealtime: boolean;
  };
  measure: { running: boolean; busy: 'watching' | 'unknown' | null; last: { outcome: BenchOutcome; at: string | null } | null };
}

export const SLOTS_MIN = 1;
export const SLOTS_MAX = 16;
export const PRIORITIES: readonly ConvPriority[] = ['films', 'live', 'equal'];

export type SegKind = 'film' | 'live' | 'record' | 'other' | 'free';
const FILL: readonly SegKind[] = ['film', 'live', 'record', 'other'];
const segOf = (k: ConvKind): SegKind => (k === 'film' || k === 'live' || k === 'record' ? k : 'other');

/**
 * `max(limit, used)` segments, filled film → live → record → other (download / re-encode), then free; the segments beyond the limit
 * are `over` (more runs than the budget allows, e.g. after the limit was lowered).
 */
export function slotSegments(v: ConversionsView): Array<{ kind: SegKind; over: boolean }> {
  const count = new Map<SegKind, number>();
  for (const r of v.running) count.set(segOf(r.kind), (count.get(segOf(r.kind)) ?? 0) + 1);
  const filled = FILL.flatMap((k) => Array.from({ length: count.get(k) ?? 0 }, () => k));
  const total = Math.max(v.limit, v.used, filled.length);
  return Array.from({ length: total }, (_, i) => ({ kind: filled[i] ?? 'free', over: i >= v.limit }));
}

const HW: Record<string, string> = { qsv: 'Intel QSV', vaapi: 'VA-API', nvenc: 'NVIDIA NVENC', amf: 'AMD AMF', videotoolbox: 'VideoToolbox' };
/** the encoder of a measurement; `none` is the processor, an unknown one a dash */
export function hwLabel(hwAccel: string): string {
  if (hwAccel === 'none') return tr('adminConv.cpu');
  if (!hwAccel || hwAccel === 'unknown') return '–';
  return HW[hwAccel] ?? hwAccel;
}

const validDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** "heute 03:10" for today, else the short date and time */
function whenText(d: Date, now: Date): string {
  return sameDay(d, now) ? tr('adminConv.today', { time: fmtTime(d) }) : fmtDateTime(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const speed = (n: number) => fmtNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * "Gemessen 4,6× Echtzeit (Jellyfin, Intel QSV) · Live-TV 4,4× · empfohlen 3 · geprüft heute 03:10"; "Noch nicht gemessen · bis dahin 2"
 * without a measurement; empty on a media server that is not measured (Plex).
 */
export function measuredLine(v: ConversionsView, now: Date): string {
  const { jellyfin, livetv, recommended } = v.bench;
  if (!jellyfin && !livetv) return v.measure.last?.outcome === 'unsupported' ? '' : tr('adminConv.never', { n: fmtNumber(v.auto) });
  const parts: string[] = [];
  if (jellyfin) parts.push(tr('adminConv.measured', { s: speed(jellyfin.speed), engine: `Jellyfin, ${hwLabel(jellyfin.hwAccel)}` }));
  if (livetv) parts.push(tr('adminConv.liveSpeed', { s: speed(livetv.speed) }));
  if (recommended !== null) parts.push(tr('adminConv.recommended', { n: fmtNumber(recommended) }));
  // the check time is the Jellyfin record's; the Live TV one only stands in while there is no Jellyfin record
  const checked = validDate(jellyfin ? jellyfin.at : livetv?.at);
  if (checked) parts.push(tr('adminConv.checked', { when: whenText(checked, now) }));
  return parts.join(' · ');
}

/** the one-line explanation of the selected priority (ruling 55) */
export function priorityHint(p: ConvPriority): TKey {
  return p === 'live' ? 'adminConv.priority.hint.live' : p === 'equal' ? 'adminConv.priority.hint.equal' : 'adminConv.priority.hint.films';
}

/** "seit 45 Min." of a running conversion; "–" without a (valid, past) start time (the backend sends none yet) */
export function runningSince(since: string | null, now: Date): string {
  const d = validDate(since);
  if (!d || d.getTime() > now.getTime()) return '–';
  return tr('adminConv.since', { d: fmtDuration((now.getTime() - d.getTime()) / 1000) });
}

export type LastLine = { tone: 'ok' | 'warn' | 'muted'; text: string };
/** how the last measurement ended (24 h), for the reserved line under *Neu messen* */
export function lastLine(last: ConversionsView['measure']['last'], now: Date): LastLine | null {
  if (!last) return null;
  if (last.outcome === 'unsupported') return { tone: 'muted', text: tr('adminConv.last.unsupported') };
  const d = validDate(last.at);
  const key = `adminConv.last.${last.outcome}` as TKey;
  return { tone: last.outcome === 'ok' ? 'ok' : 'warn', text: d ? `${tr(key)} · ${whenText(d, now)}` : tr(key) };
}

/** the honest message for a refused POST /benchmark; null = nothing specific (the caller shows the generic error) */
export function startError(e: unknown): TKey | null {
  if (!(e instanceof ApiError)) return null;
  const code = e.body?.error;
  if (e.status === 429) return 'adminConv.err.tooMany';
  if (e.status !== 409) return null;
  if (code === 'running') return 'adminConv.err.running';
  if (code === 'busy') return e.body?.reason === 'unknown' ? 'adminConv.err.busyUnknown' : 'adminConv.busyMeasure';
  if (code === 'no_user') return 'adminConv.err.noUser';
  if (code === 'unsupported') return 'adminConv.err.unsupported';
  return null;
}

/** the reason *Neu messen* is off, as a key (null: it may start) */
export const busyKey = (b: ConversionsView['measure']['busy']): TKey | null => (b === 'watching' ? 'adminConv.busyMeasure' : b === 'unknown' ? 'adminConv.err.busyUnknown' : null);

export const clampSlots = (n: number): number => Math.min(SLOTS_MAX, Math.max(SLOTS_MIN, Math.round(n)));
