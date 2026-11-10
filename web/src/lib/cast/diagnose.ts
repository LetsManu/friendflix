// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The data behind the casting section of /diagnose: card rows, the last AirPlay session, the pass countdown. No DOM, no storage. */
import { fmtDateTime, fmtNumber, type TFn } from '#lib/i18n';
import type { CastState } from '#lib/cast';
import type { CastLogEntry } from './castLog';
import type { CastSession } from './engine';
import type { CastLookup } from './resume';

export interface DiagRow { label: string; value: string; tone: 'none' | 'ok' | 'warn' | 'error' }

const NONE = '–';

/** "4 h 12 min" / "59 min": what is left of an access pass (never negative) */
export function passLeft(expiresAt: number, now: number, tf: TFn): string {
  const min = Math.max(0, Math.floor((expiresAt - now) / 60_000)), h = Math.floor(min / 60);
  return h ? tf('diagnose.cast.passHm', { h, m: min % 60 }) : tf('diagnose.cast.passM', { m: min });
}

export function chromecastRows(o: {
  capable: boolean; enabled: boolean; custom: boolean; state: CastState; session: CastSession | null; lookup: CastLookup | null;
  errors: number; now: number; tf: TFn;
  /** another tab of this browser holds the cast lock (it controls the cast; this tab shows nothing) */
  otherTab?: boolean;
}): DiagRow[] {
  const { tf } = o;
  const support: DiagRow = !o.capable ? { label: tf('diagnose.cast.support'), value: tf('diagnose.cast.supportNoBrowser'), tone: 'warn' }
    : !o.enabled ? { label: tf('diagnose.cast.support'), value: tf('diagnose.cast.supportOff'), tone: 'warn' }
    : { label: tf('diagnose.cast.support'), value: tf(o.custom ? 'diagnose.cast.supportReady' : 'diagnose.cast.supportDefault'), tone: 'ok' };
  const device = o.session?.device || (o.state.connected ? o.state.deviceName : '');
  const rows: DiagRow[] = [support];
  if (!o.capable || !o.enabled) return rows;
  const s = o.session;
  rows.push({
    label: tf('diagnose.cast.session'),
    value: !s && o.otherTab ? tf('diagnose.cast.otherTab') : s || o.state.connected ? tf('diagnose.cast.connectedTo', { device: device || '…' }) : tf('diagnose.cast.notConnected'),
    tone: 'none',
  });
  rows.push({ label: tf('diagnose.cast.playing'), value: s ? [s.title, s.subtitle].filter(Boolean).join(' · ') || NONE : NONE, tone: 'none' });
  rows.push({
    label: tf('diagnose.cast.pass'),
    value: s && o.lookup ? tf('diagnose.cast.passValid', { time: passLeft(o.lookup.expiresAt, o.now, tf) }) : NONE,
    tone: s && o.lookup && o.lookup.expiresAt <= o.now ? 'warn' : 'none',
  });
  if (s) {
    const label = s.next?.label ?? s.upcoming?.label ?? '…';
    rows.push({ label: tf('diagnose.cast.next'), value: o.state.queue.length ? tf('diagnose.cast.nextLoaded', { label }) : tf('diagnose.cast.nextNone'), tone: 'none' });
  }
  rows.push({ label: tf('diagnose.cast.rxErrorsLabel'), value: tf('diagnose.cast.rxErrors', { n: o.errors }), tone: o.errors > 0 ? 'warn' : 'none' });
  return rows;
}

export function airplayRows(o: {
  available: boolean; continuous: 'on' | 'off' | null; subsInStream: boolean; last: { at: number; episodes: number; reconnects: number } | null;
  lookup: CastLookup | null; tf: TFn;
  /** the address family the token is pinned to, when known; unknown: any refused family counts as a second address */
  pinned?: 'v4' | 'v6';
}): DiagRow[] {
  const { tf } = o;
  const rows: DiagRow[] = [{ label: tf('diagnose.cast.inBrowser'), value: tf(o.available ? 'diagnose.cast.airOk' : 'diagnose.cast.airNo'), tone: o.available ? 'ok' : 'none' }];
  if (o.continuous) rows.push({ label: tf('diagnose.cast.continuous'), value: tf(o.continuous === 'on' ? 'diagnose.cast.continuousOn' : 'diagnose.cast.continuousOff'), tone: 'none' });
  if (o.subsInStream) rows.push({ label: tf('diagnose.cast.subtitles'), value: tf('diagnose.cast.subsInStream'), tone: 'none' });
  if (o.last) rows.push({ label: tf('diagnose.cast.lastSession'), value: tf('diagnose.cast.lastSessionVal', { when: fmtDateTime(o.last.at, { weekday: 'short', hour: '2-digit', minute: '2-digit' }), n: o.last.episodes, r: o.last.reconnects }), tone: 'none' });
  if (o.lookup?.refused.families.some((f) => f !== o.pinned)) rows.push({ label: tf('diagnose.cast.network'), value: tf('diagnose.cast.twoAddresses'), tone: 'warn' });
  return rows;
}

/** the last AirPlay session of the cast log: the loads after the last gap of 3 h or more, and their reconnects; null without any */
export function lastAirSession(entries: CastLogEntry[]): { at: number; episodes: number; reconnects: number } | null {
  const GAP = 3 * 3_600_000;
  const air = entries.filter((e) => /airplay/i.test(e.text));
  const loads = air.filter((e) => /^session adopted · airplay/.test(e.text));
  const last = loads.at(-1);
  if (!last) return null;
  let from = last.at;
  for (let i = loads.length - 2; i >= 0 && from - loads[i]!.at < GAP; i--) from = loads[i]!.at;
  const inSession = (e: CastLogEntry) => e.at >= from;
  return { at: last.at, episodes: loads.filter(inSession).length, reconnects: air.filter((e) => inSession(e) && /reconnect/i.test(e.text)).length };
}

/** the line under the heading after the test video ran */
export function resultLine(r: { ok: boolean; firstFrameMs: number | null }, device: string, tf: TFn): { ok: boolean; text: string } {
  if (r.ok && r.firstFrameMs !== null) return { ok: true, text: tf('diagnose.cast.testOk', { device, s: fmtNumber(Math.round(r.firstFrameMs / 100) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) };
  return { ok: false, text: tf('diagnose.cast.testFail', { device }) };
}

/** the cards as label / value pairs for the copied report */
export const reportRows = (rows: DiagRow[]): Array<[string, string]> => rows.map((r) => [r.label, r.value]);
