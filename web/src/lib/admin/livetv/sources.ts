// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV → *Quellen* (spec §9.1): the pure text and decision helpers the cards and sheets render from. The tab names live
 * here too, so the page and its tests agree on them.
 */
import { ApiError } from '#lib/api';
import { fmtDateTime, fmtTime, tr, type TKey } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import type { SourceView, StreamKind } from './api';

export const TABS = ['sources', 'channels', 'groups', 'guide', 'status', 'settings'] as const;
export type Tab = (typeof TABS)[number];
/** `?tab=` → the tab; anything else is *Quellen* */
export const tabOf = (v: string | null | undefined): Tab => ((TABS as readonly string[]).includes(v ?? '') ? (v as Tab) : 'sources');

/**
 * The kind of a pulled own feed, from its URL, as the backend detects it (backend/src/livetv/ownfeeds.ts `detectKind`): `srt://` → srt,
 * a path ending in `.ts` → MPEG-TS, anything else → HLS. The admin can change it (srt only with an srt URL).
 */
export function detectKind(url: string): StreamKind {
  const u = url.trim().toLowerCase();
  if (u.startsWith('srt://')) return 'srt';
  const path = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/, '').split(/[?#]/, 1)[0] ?? '';
  return path.endsWith('.ts') ? 'ts' : 'hls';
}

const validDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
const dayDiff = (d: Date, now: Date) =>
  Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
/** "heute 06:12", "gestern 23:40", else the short date and time */
export function whenText(d: Date, now: Date): string {
  const diff = dayDiff(d, now);
  if (diff === 0) return tr('adminLive.src.today', { time: fmtTime(d) });
  if (diff === 1) return tr('adminLive.src.yesterday', { time: fmtTime(d) });
  return fmtDateTime(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * the §19 / §20 code a refresh or *Prüfen* failed with → its sentence; an unknown code never shows as text. `too_big` also stands for a
 * list over 2 000 groups or 200 000 entries; `incomplete` = a stream that ended without its end line; `livetv_unreachable` = the
 * backend did not reach the livetv service (503), not the provider.
 */
type ErrKey = 'unreachable' | 'denied' | 'timeout' | 'too_big' | 'too_large' | 'invalid' | 'empty' | 'refused' | 'lan_required' | 'incomplete' | 'livetv_unreachable';
const ERR: Record<string, ErrKey> = {
  unreachable: 'unreachable', not_found: 'unreachable', http_error: 'unreachable', redirects: 'unreachable', scheme: 'unreachable',
  livetv_unreachable: 'livetv_unreachable', incomplete: 'incomplete',
  denied: 'denied',
  timeout: 'timeout',
  too_big: 'too_big', too_large: 'too_large',
  invalid: 'invalid', not_m3u: 'invalid', doctype: 'invalid', invalid_answer: 'invalid',
  empty: 'empty',
  refused: 'refused', address_refused: 'refused',
  lan_required: 'lan_required',
};
/** the list limits livetv refuses as `too_big` besides the 50 MB (formatted for the language by `tr`) */
const LIMITS = { groups: 2_000, entries: 200_000 };
export function sourceError(code: string): string {
  const k = ERR[code];
  return k ? tr(`adminLive.src.err.${k}` as TKey, LIMITS) : tr('adminLive.err.generic');
}

/**
 * The text of a failed Prüfen / save / create of a source: FriendFlix's own failures (network, 5xx, 429, no code) are worded by
 * `errorText`, never as the provider being unreachable; a 404 is a source deleted elsewhere; a 400 `invalid` names its field (only the
 * URL fields say "keine gültige Adresse"); other codes (the provider fetch's 422, `refused`, `lan_required`, …) go through `sourceError`.
 */
export function sourceFailText(e: unknown): string {
  const body = e instanceof ApiError ? e.body : null;
  const code = typeof body?.error === 'string' ? body.error : null;
  if (!(e instanceof ApiError) || !code) return errorText(e);
  if (e.status === 404) return tr('adminLive.src.gone');
  if (code === 'invalid' && e.status === 400) {
    const f = body?.field;
    if (f === 'url' || f === 'epgUrl') return tr('adminLive.src.urlBad');
    if (f === 'skipGroups') return tr('adminLive.src.skipBad');
    if (f === 'userAgent') return tr('adminLive.src.uaBad');
    return tr('adminLive.err.generic');
  }
  return sourceError(code);
}

/**
 * The card's state line: "Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: 6.812 Sendungen". A failed refresh
 * leads with the error in words (the counts of the last good one follow); an EPG error replaces the programme part. Numbers go
 * through `tr`, so they are grouped as everywhere in the app (de "6.812").
 */
export function stateLine(s: SourceView, now: Date): string {
  const st = s.state;
  const parts: string[] = [];
  if (st.lastError) parts.push(sourceError(st.lastError));
  const ok = validDate(st.lastOkAt);
  if (ok && st.counts) parts.push(tr('adminLive.src.state', { when: whenText(ok, now), n: st.counts.channels, a: st.counts.added, r: st.counts.removed }));
  else if (!st.lastError) parts.push(tr('adminLive.src.never'));
  if (st.epg.lastError) parts.push(tr('adminLive.src.stateEpgErr', { err: sourceError(st.epg.lastError) }));
  else if (st.epg.programmes !== null) parts.push(tr('adminLive.src.stateEpg', { n: st.epg.programmes }));
  return parts.join(' · ');
}

/** "9000–9009"; gaps split it ("9000–9003, 9005") */
export function portRange(ports: number[]): string {
  const sorted = [...new Set(ports.filter((p) => Number.isInteger(p)))].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return runs.join(', ');
}
/**
 * "Gesendete Streams kommen über UDP 9000–9009 an. Nur diese Ports in der Firewall öffnen."; a list of ports or the range `GET /ingest`
 * answers (`{ from, to }`); empty without ports (`null`: livetv cannot tell).
 */
export function portsLine(ports: number[] | { from: number; to: number } | null): string {
  if (!ports) return '';
  const range = Array.isArray(ports) ? portRange(ports) : ports.from === ports.to ? String(ports.from) : `${ports.from}–${ports.to}`;
  return range ? tr('adminLive.push.portsLine', { range }) : '';
}

/** the result toast of *Jetzt aktualisieren*: the error in words, or the new counts */
export function refreshResult(s: SourceView): { ok: boolean; text: string } {
  if (s.state.lastError) return { ok: false, text: tr('adminLive.src.refreshFailed', { err: sourceError(s.state.lastError) }) };
  const c = s.state.counts;
  return { ok: true, text: c ? tr('adminLive.src.refreshed', { n: c.channels, a: c.added, r: c.removed }) : tr('adminLive.src.refreshedPlain') };
}

/** *Jetzt aktualisieren*: how often the page asks `GET /sources` after the 202, and for how long (a refresh may take minutes) */
export const REFRESH_POLL_MS = 1_500;
export const REFRESH_POLLS = 120;

/** a refresh that started at `since` (the `lastRefreshAt` before it) is over once that moved */
export const refreshDone = (s: SourceView, since: string | null): boolean => s.state.lastRefreshAt !== since && s.state.lastRefreshAt !== null;

/** a URL the sheet may send: http(s) (lists) or also srt (own feeds); the server checks hosts and addresses (spec §3.4) */
export function urlShapeOk(raw: string, schemes: readonly string[]): boolean {
  try {
    const u = new URL(raw.trim());
    return schemes.includes(u.protocol) && Boolean(u.hostname);
  } catch { return false; }
}
