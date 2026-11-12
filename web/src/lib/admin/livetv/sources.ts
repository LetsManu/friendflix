// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV → *Quellen* (spec §9.1): the pure text and decision helpers the cards and sheets render from. The tab names live
 * here too, so the page and its tests agree on them.
 */
import { fmtDateTime, fmtNumber, fmtTime, getLocale, tr, type TKey } from '#lib/i18n';
import type { SourceView, StreamKind } from './api';

export const TABS = ['sources', 'channels', 'groups', 'guide', 'status'] as const;
export type Tab = (typeof TABS)[number];
/** `?tab=` → the tab; anything else is *Quellen* */
export const tabOf = (v: string | null | undefined): Tab => ((TABS as readonly string[]).includes(v ?? '') ? (v as Tab) : 'sources');

/** the kind of a pulled own feed, from its URL: `srt://` → srt, a `.m3u8` path → hls, anything else → MPEG-TS (the admin can change it) */
export function detectKind(url: string): StreamKind {
  const u = url.trim().toLowerCase();
  if (u.startsWith('srt://')) return 'srt';
  const path = u.split(/[?#]/, 1)[0] ?? '';
  return path.endsWith('.m3u8') ? 'hls' : 'ts';
}

/** grouped digits; German groups with a narrow no-break space, as the spec writes it ("6 812"), so the dots never read as decimals */
export function count(n: number): string {
  const s = fmtNumber(n);
  return getLocale() === 'de' ? s.replace(/\./g, ' ') : s;
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
const ERR: Record<string, 'unreachable' | 'denied' | 'timeout' | 'too_big' | 'invalid' | 'empty' | 'refused' | 'incomplete' | 'livetv_unreachable'> = {
  unreachable: 'unreachable', not_found: 'unreachable', http_error: 'unreachable', redirects: 'unreachable', scheme: 'unreachable',
  livetv_unreachable: 'livetv_unreachable', incomplete: 'incomplete',
  denied: 'denied',
  timeout: 'timeout',
  too_big: 'too_big',
  invalid: 'invalid', not_m3u: 'invalid', doctype: 'invalid',
  empty: 'empty',
  refused: 'refused', address_refused: 'refused', lan_required: 'refused',
};
export function sourceError(code: string): string {
  const k = ERR[code];
  return k ? tr(`adminLive.src.err.${k}` as TKey) : tr('adminLive.err.generic');
}

/**
 * The card's state line: "Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: 6 812 Sendungen". A failed refresh
 * leads with the error in words (the counts of the last good one follow); an EPG error replaces the programme part.
 */
export function stateLine(s: SourceView, now: Date): string {
  const st = s.state;
  const parts: string[] = [];
  if (st.lastError) parts.push(sourceError(st.lastError));
  const ok = validDate(st.lastOkAt);
  if (ok && st.counts) parts.push(tr('adminLive.src.state', { when: whenText(ok, now), n: count(st.counts.channels), a: count(st.counts.added), r: count(st.counts.removed) }));
  else if (!st.lastError) parts.push(tr('adminLive.src.never'));
  if (st.epg.lastError) parts.push(tr('adminLive.src.stateEpgErr', { err: sourceError(st.epg.lastError) }));
  else if (st.epg.programmes !== null) parts.push(tr('adminLive.src.stateEpg', { n: count(st.epg.programmes) }));
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
/** "Gesendete Streams kommen über UDP 9000–9009 an. Nur diese Ports in der Firewall öffnen."; empty without ports */
export function portsLine(ports: number[]): string {
  const range = portRange(ports);
  return range ? tr('adminLive.push.portsLine', { range }) : '';
}

/** the result toast of *Jetzt aktualisieren*: the error in words, or the new counts */
export function refreshResult(s: SourceView): { ok: boolean; text: string } {
  if (s.state.lastError) return { ok: false, text: tr('adminLive.src.refreshFailed', { err: sourceError(s.state.lastError) }) };
  const c = s.state.counts;
  return { ok: true, text: c ? tr('adminLive.src.refreshed', { n: count(c.channels), a: count(c.added), r: count(c.removed) }) : tr('adminLive.src.refreshedPlain') };
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
