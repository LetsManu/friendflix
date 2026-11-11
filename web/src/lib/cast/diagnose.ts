// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The data behind the casting section of /diagnose: card rows, the last AirPlay session, the pass countdown. No DOM, no storage. */
import type { Item } from '#lib/api';
import { fmtDateTime, fmtNumber, type TFn } from '#lib/i18n';
import type { CastState } from '#lib/cast';
import { barLine1 } from './bar';
import type { CastLogEntry } from './castLog';
import type { CastSession } from './engine';
import type { CastLookup } from './resume';

export interface DiagRow { label: string; value: string; tone: 'none' | 'ok' | 'warn' | 'error' }

const NONE = '–';

/** "4 Std. 12 Min." / "59 Min.": what is left of an access pass (never negative; the app's duration format) */
export function passLeft(expiresAt: number, now: number, tf: TFn): string {
  const min = Math.max(0, Math.floor((expiresAt - now) / 60_000)), h = Math.floor(min / 60), m = min % 60;
  return !h ? tf('common.duration.m', { m }) : m ? tf('common.duration.hm', { h, m }) : tf('common.duration.h', { h });
}

/** the episode code of a queued item's label ("S1:E5 · Name" gives "S1:E5"); a name alone has no code */
const codeOfLabel = (label: string): string => /^(.+?) · /.exec(label)?.[1] ?? '…';

export function chromecastRows(o: {
  capable: boolean; enabled: boolean; custom: boolean; state: CastState; session: CastSession | null; lookup: CastLookup | null;
  errors: number; now: number; tf: TFn;
  /** another tab of this browser holds the cast lock (it controls the cast; this tab shows nothing) */
  otherTab?: boolean;
  /** the playing item, for its episode code (the engine's cache) */
  item?: Pick<Item, 'parentIndexNumber' | 'indexNumber'> | null;
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
    value: s?.state === 'detached' ? tf('player.castRemote.lost')
      : !s && o.otherTab ? tf('diagnose.cast.otherTab') : s || o.state.connected ? tf('diagnose.cast.connectedTo', { device: device || '…' }) : tf('diagnose.cast.notConnected'),
    tone: s?.state === 'detached' ? 'warn' : 'none',
  });
  rows.push({ label: tf('diagnose.cast.playing'), value: s ? barLine1(s, o.item, tf) || NONE : NONE, tone: 'none' });
  rows.push({
    label: tf('diagnose.cast.pass'),
    value: s && o.lookup ? tf('diagnose.cast.passValid', { time: passLeft(o.lookup.expiresAt, o.now, tf) }) : NONE,
    tone: s && o.lookup && o.lookup.expiresAt <= o.now ? 'warn' : 'none',
  });
  if (s) {
    const label = codeOfLabel(s.next?.label ?? s.upcoming?.label ?? '');
    rows.push({ label: tf('diagnose.cast.next'), value: o.state.queue.length ? tf('diagnose.cast.nextLoaded', { label }) : tf('diagnose.cast.nextNone'), tone: 'none' });
  }
  rows.push({ label: tf('diagnose.cast.rxErrorsLabel'), value: tf('diagnose.cast.rxErrors', { n: o.errors }), tone: o.errors > 0 ? 'warn' : 'none' });
  return rows;
}

export function airplayRows(o: {
  available: boolean; continuous: 'on' | 'off' | null; subsInStream: boolean; last: { at: number; episodes: number; reconnects: number } | null;
  lookup: CastLookup | null; tf: TFn;
  /** the address family the TV's pin is on (the lookup's `pinFamily`); unknown: no Network row */
  pinned?: 'v4' | 'v6' | null;
}): DiagRow[] {
  const { tf } = o;
  const rows: DiagRow[] = [{ label: tf('diagnose.cast.inBrowser'), value: tf(o.available ? 'diagnose.cast.airOk' : 'diagnose.cast.airNo'), tone: o.available ? 'ok' : 'none' }];
  if (o.continuous) rows.push({ label: tf('diagnose.cast.continuous'), value: tf(o.continuous === 'on' ? 'diagnose.cast.continuousOn' : 'diagnose.cast.continuousOff'), tone: 'none' });
  if (o.subsInStream) rows.push({ label: tf('diagnose.cast.subtitles'), value: tf('diagnose.cast.subsInStream'), tone: 'none' });
  if (o.last) rows.push({ label: tf('diagnose.cast.lastSession'), value: tf('diagnose.cast.lastSessionVal', { when: fmtDateTime(o.last.at, { weekday: 'short', hour: '2-digit', minute: '2-digit' }), episodes: tf('diagnose.cast.episodesN', { n: o.last.episodes }), reconnects: tf('diagnose.cast.reconnectsN', { n: o.last.reconnects }) }), tone: 'none' });
  if (o.pinned && o.lookup?.refused.families.some((f) => f !== o.pinned)) rows.push({ label: tf('diagnose.cast.network'), value: tf('diagnose.cast.twoAddresses'), tone: 'warn' });
  return rows;
}

/**
 * The last AirPlay session of the cast log, from the engine's own texts: it starts at the last "session adopted · airplay · <label>" and
 * runs to the next "cast ended" (or the end). Episodes = the distinct labels (the adopted one plus every "<label> · from …" load);
 * reconnects = "AirPlay route lost" and "reconnect tapped". Null without an AirPlay session.
 */
export function lastAirSession(entries: CastLogEntry[]): { at: number; episodes: number; reconnects: number } | null {
  let from = -1;
  entries.forEach((e, i) => { if (e.tag === 'session' && /^session adopted · airplay\b/.test(e.text)) from = i; });
  if (from < 0) return null;
  let to = entries.findIndex((e, i) => i > from && e.tag === 'session' && /^cast ended\b/.test(e.text));
  if (to < 0) to = entries.length;
  const win = entries.slice(from, to);
  const labels = new Set<string>();
  const first = /^session adopted · airplay · (.+)$/.exec(win[0]!.text);
  if (first) labels.add(first[1]!);
  for (const e of win) {
    const m = e.tag === 'load' ? /^(S\d+ E\d+|film|episode) · from /.exec(e.text) : null;
    if (m) labels.add(m[1]!);
  }
  return { at: win[0]!.at, episodes: Math.max(1, labels.size), reconnects: win.filter((e) => /^(AirPlay route lost|reconnect tapped)/.test(e.text)).length };
}

/** the line under the heading after the test video ran */
export function resultLine(r: { ok: boolean; firstFrameMs: number | null }, device: string, tf: TFn): { ok: boolean; text: string } {
  if (r.ok && r.firstFrameMs !== null) return { ok: true, text: tf('diagnose.cast.testOk', { device, s: fmtNumber(Math.round(r.firstFrameMs / 100) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) };
  return { ok: false, text: tf('diagnose.cast.testFail', { device }) };
}

/** the cards as label / value pairs for the copied report */
export const reportRows = (rows: DiagRow[]): Array<[string, string]> => rows.map((r) => [r.label, r.value]);
