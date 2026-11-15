// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { api, ApiError } from '#lib/api';
import { t, type TKey } from '#lib/i18n';

/**
 * Web side of the recordings API (backend: livetv/recroutes.ts, spec §15.8, plan Phase 3 Task 4): the types the routes answer,
 * the calls, and the pure helpers the screens share (grouping by series, the state label, the padding stepper, the conflict line).
 * Every request goes through `api()`. Nothing here holds a token beyond the call that asked for it.
 */
export type RecState = 'scheduled' | 'recording' | 'done' | 'partial' | 'failed' | 'cancelled';
export type Visibility = 'private' | 'account' | 'everyone';

/** one recording as this profile sees it (backend `RecordingView`) */
export interface Recording {
  id: string;
  title: string;
  subtitle: string | null;
  episode: string | null;
  channel: { id: string | null; name: string; logo: string | null };
  /** ISO */
  start: string;
  end: string;
  /** minutes */
  padBefore: number;
  padAfter: number;
  state: RecState;
  error: string | null;
  /** number of gaps (a `partial` recording) */
  gaps: number;
  durationS: number | null;
  bytes: number;
  keep: boolean;
  visibility: Visibility;
  /** the profile's own recording (else a share it sees) */
  mine: boolean;
  seriesKey: string | null;
  ruleId: string | null;
  positionS: number;
  watched: boolean;
  deleteAfter: string | null;
  storage: 'ff' | 'library';
  growing: boolean;
  /** an own planned recording: the forecast's verdict (*Geplant*'s *Konflikt* chip) */
  conflict?: boolean;
}

/** a recording rule (backend `ruleView`) */
export interface Rule {
  id: string;
  kind: 'series' | 'time';
  channelId: string | null;
  seriesKey: string | null;
  title: string;
  onlyNew: boolean;
  keepMax: number | null;
  padBefore: number | null;
  padAfter: number | null;
  /** 1 = Monday … 7 = Sunday */
  weekdays: number[] | null;
  /** "HH:MM" */
  startTime: string | null;
  durationMin: number | null;
  tz: string | null;
  enabled: boolean;
}

/** the conflict forecast of a planned recording (spec §15.4) */
export interface Forecast {
  slots: { used: number; limit: number };
  parallel: { used: number; max: number };
  provider: { used: number; max: number } | null;
  conflict: boolean;
}

/** GET /api/livetv/programme/:channelId/:start */
export interface ProgrammeDetail {
  channelId: string;
  start: string;
  end: string;
  title: string;
  subtitle?: string;
  description?: string;
  episode?: string;
  seriesKey: string;
  categories?: string[];
  recording?: { id: string; state: RecState };
  rule?: { id: string };
  canRecord: boolean;
}

/** POST /api/livetv/recordings/:id/play */
export interface RecPlay {
  token: string;
  url: string;
  growing: boolean;
  segments: 'ts' | 'fmp4';
  durationS: number | null;
  positionS: number;
  expiresAt: number;
}

const enc = encodeURIComponent;

// ---- calls ----

export const listRecordings = (state: 'done' | 'scheduled' | 'all' = 'all') =>
  api<{ recordings: Recording[]; rules: Rule[] }>(`/api/livetv/recordings?state=${state}`);

export const getRecording = (id: string) => api<{ recording: Recording }>(`/api/livetv/recordings/${enc(id)}`).then((r) => r.recording);

export const programme = (channelId: string, start: string) => api<ProgrammeDetail>(`/api/livetv/programme/${enc(channelId)}/${enc(start)}`);

export interface ScheduleBody { channelId: string; start: string; end?: string; title?: string; padBefore?: number; padAfter?: number; force?: boolean }
/** schedules a programme (or, with `end` + `title`, a time span); a conflict without `force` comes back typed with its forecast */
export async function schedule(b: ScheduleBody): Promise<{ ok: true; recording: Recording; forecast?: Forecast } | { ok: false; forecast: Forecast }> {
  try {
    const r = await api<{ recording: Recording; forecast?: Forecast }>('/api/livetv/recordings', { method: 'POST', body: b });
    return { ok: true, recording: r.recording, ...(r.forecast ? { forecast: r.forecast } : {}) };
  } catch (e) {
    const body = e instanceof ApiError ? (e.body as { error?: string; forecast?: Forecast } | null) : null;
    if (e instanceof ApiError && e.status === 409 && body?.error === 'conflict' && body.forecast) return { ok: false, forecast: body.forecast };
    throw e;
  }
}

export const patchRecording = (id: string, b: { keep?: boolean; visibility?: Visibility; padBefore?: number; padAfter?: number }) =>
  api<{ recording: Recording | null }>(`/api/livetv/recordings/${enc(id)}`, { method: 'PATCH', body: b }).then((r) => r.recording);

/** a planned recording is cancelled, anything else deleted (the backend decides by state) */
export const deleteRecording = (id: string, keepalive = false) => api<null>(`/api/livetv/recordings/${enc(id)}`, { method: 'DELETE', keepalive });

export const toLibrary = (id: string) => api<{ recording: Recording }>(`/api/livetv/recordings/${enc(id)}/library`, { method: 'POST', body: {} }).then((r) => r.recording);

export const playRecording = (id: string, via?: 'local' | 'chromecast' | 'airplay') =>
  api<RecPlay>(`/api/livetv/recordings/${enc(id)}/play`, { method: 'POST', body: via ? { via } : {} });

export const recordingProgress = (id: string, positionS: number, o: { played?: boolean; keepalive?: boolean } = {}) =>
  api<{ ok: true }>(`/api/livetv/recordings/${enc(id)}/progress`, { method: 'POST', body: { positionS: Math.max(0, Math.floor(positionS)), ...(o.played ? { played: true } : {}) }, keepalive: o.keepalive });

export type SeriesRuleBody = { kind: 'series'; channelId: string | null; seriesKey: string; title: string; onlyNew: boolean; keepMax?: number | null; padBefore?: number; padAfter?: number };
export type TimeRuleBody = { kind: 'time'; channelId: string; weekdays: number[]; startTime: string; durationMin: number; tz: string; title: string; padBefore?: number; padAfter?: number };
export const createRule = (b: SeriesRuleBody | TimeRuleBody) => api<{ rule: Rule; forecast: Forecast | null }>('/api/livetv/rules', { method: 'POST', body: b });
export const patchRule = (id: string, b: { onlyNew?: boolean; keepMax?: number | null; padBefore?: number | null; padAfter?: number | null; enabled?: boolean; title?: string }) =>
  api<{ rule: Rule }>(`/api/livetv/rules/${enc(id)}`, { method: 'PATCH', body: b }).then((r) => r.rule);
export const deleteRule = (id: string) => api<null>(`/api/livetv/rules/${enc(id)}`, { method: 'DELETE' });

// ---- pure helpers ----

/** the padding steppers' bounds in minutes (backend `padBefore` / `padAfter`) */
export const PAD_MAX = { before: 30, after: 120 } as const;
/** one stepper press: clamped to 0–30 (Vorlauf) / 0–120 (Nachlauf) */
export const stepPad = (which: 'before' | 'after', value: number, delta: number): number => Math.min(PAD_MAX[which], Math.max(0, Math.round(value + delta)));
/** *Höchstens … behalten*: null = all, else 1–10 (one step below all is 10; the backend takes up to 100) */
export const KEEP_MAX = 10;
export const stepKeep = (value: number | null, delta: number): number | null => {
  if (value === null) return delta < 0 ? KEEP_MAX : null;
  const v = value + delta;
  return v > KEEP_MAX ? null : Math.max(1, v);
};

const STATE_KEY: Record<RecState, TKey> = {
  scheduled: 'live.rec.state.scheduled', recording: 'live.rec.state.recording', done: 'live.rec.state.done',
  partial: 'live.rec.state.partial', failed: 'live.rec.state.failed', cancelled: 'live.rec.state.cancelled',
};
/** the state chip's text (spec §20 `live.rec.state.*`): *Unvollständig* names its gaps */
export const stateLabel = (r: Pick<Recording, 'state' | 'gaps'>): string => get(t)(STATE_KEY[r.state], { n: r.gaps });

/**
 * The conflict line (spec §20): the conversion slots, else the parallel limit, else the provider's connections. The forecast's `used`
 * counts the new recording too (backend `forecast`), so the line names the others: "schon 2 von 2 … verplant".
 */
export function conflictText(f: Forecast): string {
  const tr = get(t);
  const others = (n: number) => Math.max(0, n - 1);
  if (f.slots.used > f.slots.limit) return tr('live.rec.conflict', { u: others(f.slots.used), l: f.slots.limit });
  if (f.parallel.used > f.parallel.max) return tr('live.rec.conflictParallel', { u: others(f.parallel.used), l: f.parallel.max });
  if (f.provider && f.provider.used > f.provider.max) return tr('live.rec.conflictProvider', { n: f.provider.max });
  return tr('live.rec.conflict', { u: others(f.slots.used), l: f.slots.limit });
}

/** the profile's planned or running recording of a programme (channel + start), else null */
export function recordingFor(list: readonly Recording[], channelId: string, start: string): Recording | null {
  const at = Date.parse(start);
  return list.find((r) => r.mine && r.channel.id === channelId && Date.parse(r.start) === at && (r.state === 'scheduled' || r.state === 'recording')) ?? null;
}

export type RecGroup = { kind: 'series'; key: string; title: string; items: Recording[] } | { kind: 'single'; item: Recording };
const newest = (a: Recording, b: Recording) => Date.parse(b.start) - Date.parse(a.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/**
 * *Fertig* (spec §15.7): grouped by series (the rule, else the series key when two or more share it) with the episodes newest first;
 * the rest are singles. Groups and singles are ordered by date, a group by its newest episode.
 */
export function groupBySeries(list: readonly Recording[]): RecGroup[] {
  const keyOf = (r: Recording) => (r.ruleId ? `rule:${r.ruleId}` : r.seriesKey ? `series:${r.seriesKey}` : null);
  const by = new Map<string, Recording[]>();
  for (const r of list) {
    const k = keyOf(r);
    if (k) by.set(k, [...(by.get(k) ?? []), r]);
  }
  const out: RecGroup[] = [];
  const done = new Set<string>();
  for (const r of [...list].sort(newest)) {
    const k = keyOf(r);
    const members = k ? by.get(k)! : [];
    if (k && (members.length > 1 || r.ruleId)) {
      if (done.has(k)) continue;
      done.add(k);
      out.push({ kind: 'series', key: k, title: members[0]!.title, items: [...members].sort(newest) });
    } else out.push({ kind: 'single', item: r });
  }
  return out;
}

/** the states a recording can be played in (the row's tiles, *Fertig*) */
export const PLAYABLE: readonly RecState[] = ['recording', 'done', 'partial'];
/** the *Aufnahmen* row (spec §15.7): the latest 12 playable recordings, newest first */
export const ROW_MAX = 12;
export const rowRecordings = (list: readonly Recording[]): Recording[] => list.filter((r) => PLAYABLE.includes(r.state)).sort(newest).slice(0, ROW_MAX);
/** *Fertig*: what was recorded (failed ones too, with their reason) */
export const finished = (list: readonly Recording[]): Recording[] => list.filter((r) => PLAYABLE.includes(r.state) || r.state === 'failed');
/** *Geplant*: the profile's planned recordings, soonest first */
export const planned = (list: readonly Recording[]): Recording[] => list.filter((r) => r.state === 'scheduled').sort((a, b) => -newest(a, b));
/** minutes of a recording: its recorded length, else its planned span */
export const minutesOf = (r: Pick<Recording, 'durationS' | 'start' | 'end'>): number =>
  Math.max(1, Math.round(r.durationS !== null && r.durationS > 0 ? r.durationS / 60 : (Date.parse(r.end) - Date.parse(r.start)) / 60_000));
/** "HH:MM" of a local time, for a time rule's start */
export const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** how far into a recording the profile is, 0–1 (0 without a known length) */
export const progressOf = (r: Pick<Recording, 'positionS' | 'durationS'>): number => (r.durationS && r.durationS > 0 ? Math.min(1, Math.max(0, r.positionS / r.durationS)) : 0);
