// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tr } from '#lib/i18n';
import type { CastState } from '#lib/cast';
import { airplayRows, chromecastRows, lastAirSession, passLeft, reportRows, resultLine } from './diagnose';
import type { CastLogEntry } from './castLog';
import type { CastSession } from './engine';
import type { CastLookup } from './resume';

const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const state = (o: Partial<CastState> = {}): CastState => ({ available: true, connected: true, deviceName: 'Wohnzimmer-TV', state: 'playing', currentTime: 10, duration: 600, paused: false, volume: 1, muted: false, loaded: true, contentId: '', idleReason: null, castId: '', queue: [], ...o });
const session = (o: Partial<CastSession> = {}) => ({ kind: 'chromecast', device: 'Wohnzimmer-TV', title: 'Dunmoor', subtitle: 'S1 E4', state: 'playing', ...o }) as CastSession;
const lookup = (o: Partial<CastLookup> = {}): CastLookup => ({ castId: 'a'.repeat(32), itemId: 'i', mediaSourceId: 'm', playSessionId: 'p', expiresAt: NOW + (4 * 60 + 12) * 60_000 + 20_000, via: 'chromecast', next: false, reported: true, title: 'Dunmoor', subtitles: [], pins: 1, refused: { count: 0, families: [] }, ...o });
const base = { capable: true, enabled: true, custom: true, state: state(), session: session(), lookup: lookup(), errors: 0, now: NOW, tf: tr };
const val = (rows: Array<{ label: string; value: string }>, label: string) => rows.find((r) => r.label === label)?.value;

describe('chromecastRows', () => {
  it('own receiver connected and playing', () => {
    const rows = chromecastRows(base);
    expect(val(rows, 'Cast-Unterstützung')).toBe('Bereit · FriendFlix-Empfänger');
    expect(val(rows, 'Sitzung')).toBe('Verbunden mit Wohnzimmer-TV');
    expect(val(rows, 'Zugangspass')).toBe('Gültig 4 h 12 min, wird 10 Min. vor Ablauf erneuert');
    expect(rows.find((r) => r.label === 'Cast-Unterstützung')?.tone).toBe('ok');
  });
  it('support variants', () => {
    expect(val(chromecastRows({ ...base, capable: false }), 'Cast-Unterstützung')).toBe('In diesem Browser nicht verfügbar (Chrome oder Edge nötig)');
    expect(val(chromecastRows({ ...base, enabled: false }), 'Cast-Unterstützung')).toBe('Auf diesem Server aus');
    expect(val(chromecastRows({ ...base, custom: false }), 'Cast-Unterstützung')).toBe('Bereit · Standard-Empfänger von Google');
  });
  it('nothing cast: not connected, no pass', () => {
    const rows = chromecastRows({ ...base, state: state({ connected: false, deviceName: '' }), session: null, lookup: null });
    expect(val(rows, 'Sitzung')).toBe('Nicht verbunden');
    expect(val(rows, 'Zugangspass')).toBe('–');
  });
  it('another tab holds the cast lock: says so instead of not connected', () => {
    const rows = chromecastRows({ ...base, state: state({ connected: true }), session: null, lookup: null, otherTab: true });
    expect(val(rows, 'Sitzung')).toBe('Wird von einem anderen Tab gesteuert');
    expect(chromecastRows({ ...base, session: null, lookup: null, state: state({ connected: false, deviceName: '' }), otherTab: false }).some((r) => r.value.includes('anderen Tab'))).toBe(false);
  });
  it('next episode and receiver errors', () => {
    const rows = chromecastRows({ ...base, session: session({ next: { itemId: 'n', label: 'E5', startsAt: null } }), state: state({ queue: [{ itemId: 1, contentId: 'x', castId: '' }] }), errors: 2 });
    expect(val(rows, 'Nächste Folge')).toBe('E5 auf dem Fernseher vorgemerkt');
    expect(val(chromecastRows(base), 'Nächste Folge')).toBe('Nicht vorgemerkt');
    expect(val(rows, 'Empfängerfehler')).toBe('2 in dieser Sitzung (siehe Ereignisse)');
    expect(rows.find((r) => r.label === 'Empfängerfehler')?.tone).toBe('warn');
  });
});

describe('airplayRows', () => {
  const air: Parameters<typeof airplayRows>[0] = { available: true, continuous: null, subsInStream: false, last: null, lookup: null, tf: tr };
  it('Chrome: not available', () => {
    expect(val(airplayRows({ ...air, available: false }), 'In diesem Browser')).toBe('Hier nicht verfügbar (AirPlay braucht Safari)');
    expect(val(airplayRows(air), 'In diesem Browser')).toBe('Verfügbar');
  });
  it('no continuous row while continuous is null; no subtitles row until it is turned on', () => {
    const labels = (o: Partial<Parameters<typeof airplayRows>[0]>) => airplayRows({ ...air, ...o }).map((r) => r.label);
    expect(labels({})).toEqual(['In diesem Browser']);
    expect(labels({ continuous: 'on' })).toHaveLength(2);
    expect(labels({ subsInStream: true })).toContain('Untertitel');
  });
  it('network row only with a family other than the pinned one', () => {
    const l = (families: Array<'v4' | 'v6'>) => lookup({ via: 'airplay', pins: 1, refused: { count: 1, families } });
    expect(val(airplayRows({ ...air, lookup: l(['v6']), pinned: 'v4' }), 'Netzwerk')).toContain('2 Adressen');
    expect(val(airplayRows({ ...air, lookup: l(['v4']), pinned: 'v4' }), 'Netzwerk')).toBeUndefined();
    expect(airplayRows({ ...air, lookup: l(['v6']), pinned: 'v4' }).find((r) => r.label === 'Netzwerk')?.tone).toBe('warn');
    expect(val(airplayRows({ ...air, lookup: lookup() }), 'Netzwerk')).toBeUndefined();
  });
  it('last session row', () => {
    expect(val(airplayRows({ ...air, last: { at: NOW, episodes: 3, reconnects: 0 } }), 'Letzte Sitzung')).toMatch(/3 Folgen, 0 Neuverbindungen$/);
  });
});

describe('lastAirSession', () => {
  const e = (at: number, text: string, tag: CastLogEntry['tag'] = 'session'): CastLogEntry => ({ at, level: 'info', tag, text });
  it('three AirPlay loads and no reconnects', () => {
    const log = [e(1000, 'session adopted · chromecast · S1 E4'), e(2000, 'session adopted · airplay · S1 E4'), e(3000, 'session adopted · airplay · S1 E5'), e(4000, 'session adopted · airplay · film'), e(5000, 'cast ended · stopped')];
    expect(lastAirSession(log)).toEqual({ at: 4000, episodes: 3, reconnects: 0 });
  });
  it('counts reconnects; null without AirPlay; an older session is not mixed in', () => {
    expect(lastAirSession([e(1, 'session adopted · chromecast · film')])).toBeNull();
    expect(lastAirSession([])).toBeNull();
    const h = 3_600_000;
    const log = [e(0, 'session adopted · airplay · S1 E1'), e(20 * h, 'session adopted · airplay · S1 E2'), e(20 * h + 1, 'airplay route reconnected', 'network')];
    expect(lastAirSession(log)).toEqual({ at: 20 * h, episodes: 1, reconnects: 1 });
  });
});

describe('passLeft', () => {
  it('hours and minutes, minutes only, nothing left', () => {
    expect(passLeft(NOW + (4 * 60 + 12) * 60_000 + 5000, NOW, tr)).toBe('4 h 12 min');
    expect(passLeft(NOW + 59 * 60_000, NOW, tr)).toBe('59 min');
    expect(passLeft(NOW + 2 * 3600_000, NOW, tr)).toBe('2 h 0 min');
    expect(passLeft(NOW - 5, NOW, tr)).toBe('0 min');
  });
});

describe('resultLine and reportRows', () => {
  it('formats the first frame with a decimal comma in German', () => {
    expect(resultLine({ ok: true, firstFrameMs: 1930 }, 'Wohnzimmer-TV', tr)).toEqual({ ok: true, text: 'Testvideo lief auf Wohnzimmer-TV · erstes Bild nach 1,9 s' });
    expect(resultLine({ ok: false, firstFrameMs: null }, 'Wohnzimmer-TV', tr)).toEqual({ ok: false, text: 'Das Testvideo lief auf Wohnzimmer-TV nicht.' });
  });
  it('report rows are label/value pairs of both cards, with the tone left out', () => {
    expect(reportRows([{ label: 'A', value: 'b', tone: 'ok' }])).toEqual([['A', 'b']]);
  });
});
