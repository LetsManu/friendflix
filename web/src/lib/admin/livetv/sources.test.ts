// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { hasKey, setLocale } from '#lib/i18n';
import type { SourceView } from './api';
import { detectKind, portRange, portsLine, refreshDone, refreshResult, sourceError, stateLine, tabOf, urlShapeOk } from './sources';

const at = (h: number, min: number, dayShift = 0) => new Date(2026, 10, 12 + dayShift, h, min).toISOString();
const NOW = new Date(2026, 10, 12, 9, 30);

const view = (state: Partial<SourceView['state']> = {}, over: Partial<SourceView> = {}): SourceView => ({
  id: 's1', kind: 'm3u', name: 'Nordlicht Paket', urlHint: 'https://iptv.example.com/…', epgHint: 'https://iptv.example.com/…', userAgent: null, allowLan: false,
  refresh: '24h', skipGroups: [], numbering: 'chno', numberBase: 1, logoPref: 'm3u', epgShiftMin: 0, maxStreams: null, enabled: true, position: 0,
  channelCount: 412, pendingGroups: 0,
  state: {
    lastRefreshAt: at(6, 12), lastOkAt: at(6, 12), lastError: null, counts: { channels: 412, added: 3, removed: 1 },
    epg: { lastRefreshAt: at(6, 12), lastOkAt: at(6, 12), lastError: null, programmes: 6812 },
    ...state,
  },
  ...over,
});

afterEach(async () => { await setLocale('de'); });

describe('detectKind', () => {
  it('reads the kind of an own feed from its URL, as the backend does', () => {
    expect(detectKind('https://iptv.example.com/live/nordlicht/index.m3u8?token=abc')).toBe('hls');
    expect(detectKind('http://192.0.2.10:8080/hafenkanal.ts')).toBe('ts');
    expect(detectKind('srt://192.0.2.10:9000?streamid=hafenkanal&latency=200000')).toBe('srt');
  });
  it('is case-blind, reads only the path and falls back to HLS', () => {
    expect(detectKind('  HTTP://192.0.2.10/LIVE/HAFEN.TS  ')).toBe('ts');
    expect(detectKind('https://iptv.example.com/play?f=x.ts')).toBe('hls');
    expect(detectKind('http://192.0.2.10/stream')).toBe('hls');
    expect(detectKind('https://iptv.example.com/live.ts')).toBe('ts');
  });
});

describe('stateLine', () => {
  it('German: when, channels with the change, programmes', () => {
    expect(stateLine(view(), NOW)).toBe(`Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: 6.812 Sendungen`);
  });
  it('English', async () => {
    await setLocale('en');
    expect(stateLine(view(), NOW)).toBe('Last updated today 06:12 · 412 channels (+3 / −1) · Guide: 6,812 programmes');
  });
  it('yesterday, never, no guide', () => {
    expect(stateLine(view({ lastOkAt: at(23, 40, -1) }), NOW)).toMatch(/^Zuletzt aktualisiert gestern 23:40 · /);
    expect(stateLine(view({ lastRefreshAt: null, lastOkAt: null, counts: null, epg: { lastRefreshAt: null, lastOkAt: null, lastError: null, programmes: null } }), NOW)).toBe('Noch nicht aktualisiert');
    expect(stateLine(view({ epg: { lastRefreshAt: null, lastOkAt: null, lastError: null, programmes: null } }), NOW)).toBe('Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1)');
  });
  it('a failed refresh leads with the error in words; the last good counts follow', () => {
    expect(stateLine(view({ lastError: 'denied' }), NOW)).toBe(`Zugang abgelehnt (Benutzername oder Passwort?) · Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: 6.812 Sendungen`);
    expect(stateLine(view({ lastError: 'timeout', lastOkAt: null, counts: null, epg: { lastRefreshAt: null, lastOkAt: null, lastError: null, programmes: null } }), NOW)).toBe('Zeitüberschreitung');
  });
  it('a failed guide replaces the programme count', () => {
    expect(stateLine(view({ epg: { lastRefreshAt: at(6, 12), lastOkAt: null, lastError: 'too_big', programmes: 100 } }), NOW)).toBe('Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: Liste zu groß (über 50 MB, 2.000 Gruppen oder 200.000 Einträge)');
  });
});

describe('sourceError', () => {
  it('says each §19 case in words', () => {
    expect(sourceError('unreachable')).toBe('Nicht erreichbar');
    expect(sourceError('denied')).toBe('Zugang abgelehnt (Benutzername oder Passwort?)');
    expect(sourceError('timeout')).toBe('Zeitüberschreitung');
    expect(sourceError('too_big')).toBe('Liste zu groß (über 50 MB, 2.000 Gruppen oder 200.000 Einträge)');
    expect(sourceError('invalid')).toBe('Keine gültige Senderliste');
    expect(sourceError('empty')).toBe('Die Liste war leer – nichts geändert');
    expect(sourceError('refused')).toBe('Adresse nicht erlaubt (internes Netz)');
    expect(sourceError('incomplete')).toBe('Unvollständig übertragen');
  });
  it('lan_required points to the switch that allows it', () => {
    expect(sourceError('lan_required')).toBe('Adresse im eigenen Netz – dafür „Heimnetz erlauben“ einschalten');
  });
  it('a livetv service that is not reached is not the provider\'s fault', () => {
    expect(sourceError('livetv_unreachable')).toBe('Live-TV-Dienst nicht erreichbar');
  });
  it('maps the fetch codes of livetv and the backend onto them', () => {
    for (const c of ['not_found', 'http_error', 'redirects', 'scheme']) expect(sourceError(c), c).toBe('Nicht erreichbar');
    expect(sourceError('address_refused')).toBe('Adresse nicht erlaubt (internes Netz)');
    expect(sourceError('invalid_answer')).toBe('Keine gültige Senderliste');
    for (const c of ['not_m3u', 'doctype']) expect(sourceError(c), c).toBe('Keine gültige Senderliste');
  });
  it('never shows an unknown code', () => {
    expect(sourceError('ECONNRESET at iptv.example.com')).toBe('Das hat nicht geklappt.');
  });
  it('English', async () => {
    await setLocale('en');
    expect(sourceError('denied')).toBe('Access denied (username or password?)');
    expect(sourceError('empty')).toBe('The list was empty, nothing changed');
    expect(sourceError('too_big')).toBe('List too big (over 50 MB, 2,000 groups or 200,000 entries)');
  });
  it('every code has its key', () => {
    for (const k of ['unreachable', 'denied', 'timeout', 'too_big', 'invalid', 'empty', 'refused', 'lan_required', 'incomplete', 'livetv_unreachable']) expect(hasKey(`adminLive.src.err.${k}`), k).toBe(true);
  });
});

describe('portsLine', () => {
  it('names the UDP range', () => {
    expect(portsLine([9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009])).toBe('Gesendete Streams kommen über UDP 9000–9009 an. Nur diese Ports in der Firewall öffnen.');
  });
  it('splits gaps, sorts, drops duplicates; nothing without ports', () => {
    expect(portRange([9005, 9000, 9001, 9001, 9002, 9003])).toBe('9000–9003, 9005');
    expect(portRange([9000])).toBe('9000');
    expect(portsLine([])).toBe('');
  });
  it('takes the range GET /ingest answers; null = livetv cannot tell', () => {
    expect(portsLine({ from: 9000, to: 9009 })).toBe('Gesendete Streams kommen über UDP 9000–9009 an. Nur diese Ports in der Firewall öffnen.');
    expect(portsLine({ from: 9000, to: 9000 })).toBe('Gesendete Streams kommen über UDP 9000 an. Nur diese Ports in der Firewall öffnen.');
    expect(portsLine(null)).toBe('');
  });
  it('English', async () => {
    await setLocale('en');
    expect(portsLine([9000, 9001])).toBe('Pushed streams arrive on UDP 9000–9001. Open only these ports in the firewall.');
  });
});

describe('the refresh result', () => {
  it('is done once lastRefreshAt moved', () => {
    expect(refreshDone(view(), at(6, 12))).toBe(false);
    expect(refreshDone(view({ lastRefreshAt: at(9, 31) }), at(6, 12))).toBe(true);
    expect(refreshDone(view({ lastRefreshAt: at(9, 31) }), null)).toBe(true);
    expect(refreshDone(view({ lastRefreshAt: null }), null)).toBe(false);
  });
  it('says the counts or the error', () => {
    expect(refreshResult(view())).toEqual({ ok: true, text: 'Aktualisiert: 412 Sender (+3 / −1)' });
    expect(refreshResult(view({ lastError: 'unreachable' }))).toEqual({ ok: false, text: 'Aktualisieren fehlgeschlagen: Nicht erreichbar' });
  });
});

describe('small helpers', () => {
  it('tabOf: known tabs, else Quellen', () => {
    expect(tabOf('status')).toBe('status');
    expect(tabOf('channels')).toBe('channels');
    expect(tabOf(null)).toBe('sources');
    expect(tabOf('recordings')).toBe('sources');
  });
  it('urlShapeOk: scheme and host only', () => {
    expect(urlShapeOk('https://iptv.example.com/get.php?u=a', ['http:', 'https:'])).toBe(true);
    expect(urlShapeOk('srt://192.0.2.10:9000', ['http:', 'https:'])).toBe(false);
    expect(urlShapeOk('srt://192.0.2.10:9000', ['srt:'])).toBe(true);
    expect(urlShapeOk('iptv.example.com', ['https:'])).toBe(false);
  });
});
