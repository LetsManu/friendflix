// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV → *Kanäle* (spec §9.2): the wire shapes of the channel routes (plan Task 19, backend/src/livetv/adminChannels.ts), thin
 * callers, and the pure text helpers the list and its sheets render from. The browser never gets a stream URL: a channel carries only
 * what the backend's `AdminChannel` allows (F13). Texts come out of `adminLive.ch.*`.
 */
import { api, ApiError } from '#lib/api';
import { fmtTime, tr, type TKey } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import { shiftLabel } from './picker';

export type StreamKind = 'hls' | 'ts' | 'srt';
export type Needs = 'passthrough' | 'remux' | 'transcode';
export type ShiftFrom = 'channel' | 'list' | 'source' | 'none';
/** a programme with the channel's effective EPG offset applied (backend `Prog`): ISO date-times */
export interface Prog { title: string; start: string; end: string; subtitle?: string }
export interface ProbeFacts {
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; channels: number };
  needs: Needs | null;
}

/** `AdminChannel` of backend/src/livetv/adminChannels.ts */
export interface AdminChannel {
  id: string;
  number: number | null;
  name: string;
  groupId: string | null;
  sourceId: string;
  streamKind: StreamKind;
  ingest: 'pull' | 'push';
  logoHash: string | null;
  hidden: boolean;
  missing: boolean;
  /** an EPG mapping is set */
  epg: boolean;
  /** the programme on now, the offset applied; null without one */
  now: Prog | null;
  /** from the last stream test; null = not tested or the test failed */
  mode: Needs | null;
  /** the fixed code of the last failed test */
  probeError: string | null;
  /** the import value of each overridden field; a key is present only while overridden (`group` is the import group's id) */
  overridden: { name?: string; number?: number | null; group?: string | null; logo?: true };
  /** another channel that is not missing has the same number */
  dupNumber: boolean;
  epgShift: { min: number; from: ShiftFrom };
  /** push feeds only: the port and the hint, never the stream id */
  push?: { port: number; hint: string; portInRange: boolean };
  /** push feeds only: false while livetv has not taken the latest ingest set ("wird übertragen …"); absent for other channels */
  synced?: boolean;
}

/** the row shows "wird übertragen …": an own feed whose change is not applied in livetv yet */
export const syncing = (c: Pick<AdminChannel, 'synced'>): boolean => c.synced === false;

/** how often a page with a syncing row is read again to see it cleared (the backend retries a failed sync every minute) */
export const SYNC_POLL_MS = 5000;

/**
 * `rows` with the `synced` flag of the same channels in `fresh` (a re-read of the page); nothing else of a row changes, so a re-read never
 * overwrites an edit in progress. Rows `fresh` does not have, and rows whose flag did not change, are returned as they were.
 */
export function mergeSynced(rows: AdminChannel[], fresh: AdminChannel[]): AdminChannel[] {
  const by = new Map(fresh.map((c) => [c.id, c.synced]));
  return rows.map((r) => (by.has(r.id) && by.get(r.id) !== r.synced ? { ...r, synced: by.get(r.id) } : r));
}

export const PAGE_SIZE = 100;
/** *Reihenfolge* shows at most this many channels (the backend's page maximum): one group or one source */
export const ORDER_MAX = 500;
/** a bulk test takes at most this many channels (backend MAX_BULK_TEST) */
export const TEST_MAX = 20;
/** a logo is a raw PNG / JPEG / WebP of at most 512 KB (backend LOGO_MIMES / LOGO_MAX_BYTES) */
export const LOGO_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
export const LOGO_MAX = 512 * 1024;

export type ChannelSort = 'number' | 'name' | 'source';
export interface ChannelFilter {
  q: string;
  source: string | null;
  /** a group id or 'none' (*Ohne Gruppe*) */
  group: string | null;
  state: 'visible' | 'hidden' | 'missing' | null;
  epg: 'yes' | 'no' | null;
  error: boolean;
  sort: ChannelSort;
  dir: 'asc' | 'desc';
  offset: number;
}
export const emptyFilter = (): ChannelFilter => ({ q: '', source: null, group: null, state: null, epg: null, error: false, sort: 'number', dir: 'asc', offset: 0 });

/**
 * The filter of the *Reihenfolge* view: exactly the chosen group and/or source (a real group, not *Ohne Gruppe*), by number from the
 * start. null = neither is chosen. The list's search, state, EPG and error filters do not narrow it: the order is of the whole set.
 */
export function orderFilter(f: ChannelFilter): ChannelFilter | null {
  const group = f.group && f.group !== 'none' ? f.group : null;
  if (!group && !f.source) return null;
  return { ...emptyFilter(), source: f.source, group };
}

/** entering *Reihenfolge*: *Ohne Gruppe* is no group there (the select does not offer it), so it counts as "all groups" */
export const forOrder = (f: ChannelFilter): ChannelFilter => (f.group === 'none' ? { ...f, group: null } : f);

/** the rows after a saved order: in the saved order, numbered from the `from` the answer names (never guessed from the old numbers) */
export function afterOrderSave(rows: AdminChannel[], ids: string[], from: number): AdminChannel[] {
  const by = new Map(rows.map((c) => [c.id, c]));
  const out: AdminChannel[] = [];
  ids.forEach((id, i) => { const c = by.get(id); if (c) out.push({ ...c, number: from + i }); });
  return out;
}

/** the query of `GET /channels`: set filters in a fixed order, then sort, direction, the page size and the offset */
export function queryString(f: ChannelFilter, limit: number = PAGE_SIZE): string {
  const p: string[] = [];
  const add = (k: string, v: string | number) => p.push(`${k}=${encodeURIComponent(String(v))}`);
  const q = f.q.trim().slice(0, 100); // the backend caps `q` at 100 (a longer one is a 400)
  if (q) add('q', q);
  if (f.source) add('source', f.source);
  if (f.group) add('group', f.group);
  if (f.state) add('state', f.state);
  if (f.epg) add('epg', f.epg);
  if (f.error) add('error', 1);
  add('sort', f.sort);
  add('dir', f.dir);
  add('limit', limit);
  add('offset', f.offset);
  return p.join('&');
}

/**
 * The text of the small dot at an overridden value: "geändert (Import: Nordlicht TV)". The import's name, number and group (named by
 * `opts.group`, which knows the group list) come after "Import:"; a replaced logo adds "eigenes Logo". Own feeds have no import to compare
 * against (a push feed always is one; the caller says `own` for a pulled one): null. null as well without any override.
 */
export function overrideHint(c: AdminChannel, opts: { own?: boolean; group?: (id: string) => string | null } = {}): string | null {
  if (opts.own || c.ingest === 'push') return null;
  const o = c.overridden;
  const imp: string[] = [];
  if (o.name !== undefined) imp.push(o.name);
  if ('number' in o) imp.push(o.number === null || o.number === undefined ? tr('adminLive.ch.importNoNumber') : tr('adminLive.ch.importNumber', { n: o.number }));
  if ('group' in o) imp.push(o.group === null || o.group === undefined ? tr('adminLive.ch.filters.noGroup') : opts.group?.(o.group) ?? '–');
  const what = [imp.length ? tr('adminLive.ch.importOf', { v: imp.join(' · ') }) : '', o.logo ? tr('adminLive.ch.ownLogo') : ''].filter(Boolean).join('; ');
  return what ? tr('adminLive.ch.changed', { what }) : null;
}

const VIDEO: Record<string, string> = { h264: 'H.264', hevc: 'H.265', h265: 'H.265', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', av1: 'AV1', vp9: 'VP9', vc1: 'VC-1' };
const AUDIO: Record<string, string> = { aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', mp2: 'MP2', mp3: 'MP3', opus: 'Opus', dts: 'DTS', vorbis: 'Vorbis' };
const LAYOUT: Record<number, string> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' };

/** "H.264 1920×1080 25 fps · AAC 2.0 · wird umverpackt": what a stream test found; what is missing is left out */
export function factsLine(p: ProbeFacts): string {
  const parts: string[] = [];
  const v = p.video;
  if (v) parts.push(`${VIDEO[v.codec.toLowerCase()] ?? v.codec.toUpperCase()} ${v.width}×${v.height} ${tr('adminLive.ch.facts.fps', { n: Math.round(v.fps * 100) / 100 })}`);
  const a = p.audio;
  if (a) parts.push(`${AUDIO[a.codec.toLowerCase()] ?? a.codec.toUpperCase()} ${LAYOUT[a.channels] ?? tr('adminLive.ch.facts.channels', { n: a.channels })}`);
  if (p.needs) parts.push(tr(`adminLive.ch.facts.${p.needs}` as TKey));
  return parts.join(' · ');
}

/** the stream kind chip: *HLS* / *TS* / *SRT* / *SRT empfangen* (a push feed) */
export function kindChip(c: Pick<AdminChannel, 'streamKind' | 'ingest'>): TKey {
  return (c.ingest === 'push' ? 'adminLive.ch.kind.push' : `adminLive.ch.kind.${c.streamKind}`) as TKey;
}

/** "+1 Std. · aus der Senderliste (tvg-shift)", "… · aus der Quelle", "… · für diesen Sender festgelegt", "keine" */
export function shiftFromLine(c: Pick<AdminChannel, 'epgShift'>): string {
  const { min, from } = c.epgShift;
  if (from === 'none') return tr('adminLive.ch.shift.from.none');
  return tr('adminLive.ch.shift.line', { shift: shiftLabel(min), from: tr(`adminLive.ch.shift.from.${from}` as TKey) });
}

/** the *Jetzt* line: "Die Leuchtturmwärter · 20:15–21:00", or "Kein Programm verfügbar" */
export function nowLine(p: Prog | null): string {
  return p ? `${p.title} · ${fmtTime(p.start)}–${fmtTime(p.end)}` : tr('adminLive.ch.shift.noProgramme');
}

const ERR = new Set([
  'test_running', 'no_stream_url', 'livetv_off', 'livetv_unreachable', 'livetv_error', 'address_refused', 'source_disabled', 'not_found', 'timeout',
  'unreachable', 'denied', 'no_video', 'invalid', 'failed', 'too_large', 'unsupported_type', 'svg',
]);
/** a fixed code of the channel routes, a stream test or the logo checks → its sentence; an unknown code never shows as text */
export function channelError(code: string | null | undefined): string {
  const c = code === 'refused' ? 'address_refused' : code;
  return c && ERR.has(c) ? tr(`adminLive.ch.err.${c}` as TKey) : tr('adminLive.err.generic');
}
/** the fixed code of a failed call (`{ error }` of the body), null for anything else */
export const errorCode = (e: unknown): string | null => (e instanceof ApiError && typeof e.body?.error === 'string' ? e.body.error : null);

/** the toast text of a failed channel call: the fixed code in words, else the generic text for the status */
export const failText = (e: unknown): string => {
  const c = errorCode(e);
  // `invalid` is the stream test's "no readable data" only there (TestSheet uses channelError); a PATCH / bulk 400 is a refused change
  if (c === 'invalid') return tr('adminLive.ch.err.rejected');
  return c ? channelError(c) : errorText(e);
};

/** the logo checks before anything is sent: null = fine, else the code `channelError` words */
export function checkLogoFile(f: { name: string; type: string; size: number }): 'svg' | 'too_large' | 'unsupported_type' | null {
  if (/svg/i.test(f.type) || /\.svg$/i.test(f.name)) return 'svg';
  if (f.size <= 0 || !LOGO_TYPES.includes(f.type)) return 'unsupported_type';
  return f.size > LOGO_MAX ? 'too_large' : null;
}

// ---- the routes (backend adminRoutes.ts) ----
const B = '/api/admin/livetv/channels';
const enc = encodeURIComponent;

export const listChannels = (f: ChannelFilter, signal?: AbortSignal, limit?: number) => api<{ channels: AdminChannel[]; total: number }>(`${B}?${queryString(f, limit)}`, { signal });
/** *Reihenfolge* → Speichern: the channels get consecutive numbers in this order, from the smallest of them */
export const orderChannels = (ids: string[]) => api<{ from: number }>(`${B}/order`, { method: 'PUT', body: { ids } });
export const getChannel = (id: string) => api<AdminChannel>(`${B}/${enc(id)}`);
/** `channelPatch`: a key that is sent changes it, `null` = back to the import (`epgShiftMin: null` = inherited again) */
export interface ChannelPatch { name?: string | null; number?: number | null; groupId?: string | null; hidden?: boolean; epg?: boolean | null; epgShiftMin?: number | null }
export const patchChannel = (id: string, body: ChannelPatch) => api<AdminChannel>(`${B}/${enc(id)}`, { method: 'PATCH', body });

export type BulkBody =
  | { ids: string[]; action: 'hide' | 'show' | 'reset' }
  | { ids: string[]; action: 'group'; groupId: string | null }
  | { ids: string[]; action: 'renumber'; from: number };
export const bulkChannels = (body: BulkBody) => api<{ changed: number; synced?: boolean }>(`${B}/bulk`, { method: 'POST', body });
export interface BulkTestResult { id: string; ok: boolean; needs?: Needs; error?: string }
export const bulkTest = (ids: string[]) => api<{ results: BulkTestResult[] }>(`${B}/bulk`, { method: 'POST', body: { ids, action: 'test' } });

/** `POST /channels/:id/test`: 409 `test_running` / `no_stream_url` / `source_disabled`, 503 `livetv_unreachable`, 502 `livetv_error` */
export interface TestAnswer { ok: boolean; video: ProbeFacts['video'] | null; audio: ProbeFacts['audio'] | null; needs: Needs | null; error?: string; /** the channel could start: a test token to play it for 10 s */ preview?: { url: string; token: string } }
export const testChannel = (id: string) => api<TestAnswer>(`${B}/${enc(id)}/test`, { method: 'POST' });

/** the logo upload is a raw image body (ruling 32), not JSON: 413 `too_large`, 415 `unsupported_type` */
export const uploadLogo = (id: string, file: Blob) => api<AdminChannel>(`${B}/${enc(id)}/logo`, { method: 'PUT', raw: file });
export const dropLogo = (id: string) => api<AdminChannel>(`${B}/${enc(id)}/logo`, { method: 'DELETE' });
/** a channel logo by its hash (the backend serves provider, XMLTV and uploaded logos here) */
export const logoSrc = (hash: string) => `/api/livetv/logos/${enc(hash)}`;
