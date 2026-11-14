// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { hasKey, setLocale, tr } from '#lib/i18n';
import type { SourceView } from './api';
import { ApiError } from '#lib/api';
import { detectKind, fileFailText, fileLine, guideProviderLabel, isFileGuide, guideMoves, guideScopeLabel, guideStateLine, portRange, portsLine, refreshDone, refreshResult, scopeOptions, sourceError, sourceFailText, stateLine, tabOf, urlShapeOk } from './sources';

const at = (h: number, min: number, dayShift = 0) => new Date(2026, 10, 12 + dayShift, h, min).toISOString();
const NOW = new Date(2026, 10, 12, 9, 30);

const view = (state: Partial<SourceView['state']> = {}, over: Partial<SourceView> = {}): SourceView => ({
  id: 's1', kind: 'm3u', name: 'Nordlicht Paket', urlHint: 'https://iptv.example.com/…', epgHint: 'https://iptv.example.com/…', userAgent: null, allowLan: false,
  refresh: '24h', skipGroups: [], numbering: 'chno', numberBase: 1, logoPref: 'm3u', epgShiftMin: 0, maxStreams: null, enabled: true, position: 0,
  channelCount: 412, pendingGroups: 0, guideProvider: null, guideScope: null, fileName: null, fileBytes: null, servedChannels: 380,
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
    expect(tabOf('recordings')).toBe('sources'); // no such tab
  });
  it('urlShapeOk: scheme and host only', () => {
    expect(urlShapeOk('https://iptv.example.com/get.php?u=a', ['http:', 'https:'])).toBe(true);
    expect(urlShapeOk('srt://192.0.2.10:9000', ['http:', 'https:'])).toBe(false);
    expect(urlShapeOk('srt://192.0.2.10:9000', ['srt:'])).toBe(true);
    expect(urlShapeOk('iptv.example.com', ['https:'])).toBe(false);
  });
});

describe('sourceFailText: FriendFlix\'s own failures are not the provider\'s', () => {
  it('no code (network, 5xx, 429) is worded by the generic error text', () => {
    expect(sourceFailText(new TypeError('Failed to fetch'))).toBe('Keine Verbindung zum Server.');
    expect(sourceFailText(new ApiError(500, null))).not.toBe('Nicht erreichbar');
    expect(sourceFailText(new ApiError(429, {}))).not.toBe('Nicht erreichbar');
  });
  it('a 404 is a source deleted elsewhere', () => {
    expect(sourceFailText(new ApiError(404, { error: 'not_found' }))).toBe('Diese Quelle gibt es nicht mehr.');
    expect(sourceFailText(new ApiError(422, { error: 'not_found' }))).toBe('Nicht erreichbar'); // the provider's 404
  });
  it('a 400 invalid names its field', () => {
    expect(sourceFailText(new ApiError(400, { error: 'invalid', field: 'url' }))).toContain('keine gültige Adresse');
    expect(sourceFailText(new ApiError(400, { error: 'invalid', field: 'epgUrl' }))).toContain('keine gültige Adresse');
    expect(sourceFailText(new ApiError(400, { error: 'invalid', field: 'skipGroups' }))).not.toContain('Adresse');
    expect(sourceFailText(new ApiError(400, { error: 'invalid', field: 'userAgent' }))).toContain('User-Agent');
    expect(sourceFailText(new ApiError(400, { error: 'invalid', field: 'maxStreams' }))).toBe('Das hat nicht geklappt.');
  });
  it('too_large has its own text; provider codes keep theirs', () => {
    expect(sourceError('too_large')).toBe('Die Liste der ausgeschlossenen Gruppen ist zu groß.');
    expect(sourceFailText(new ApiError(422, { error: 'invalid' }))).toBe('Keine gültige Senderliste');
    expect(sourceFailText(new ApiError(400, { error: 'lan_required' }))).toContain('Heimnetz');
  });
});

describe('guides (extra programme guides)', () => {
  const list = view({}, { id: 'src-nordlicht', name: 'Nordlicht Paket', position: 0 });
  const list2 = view({}, { id: 'src-hafen', name: 'Hafen Paket', position: 2 });
  const feeds = view({}, { id: 'src-feeds', kind: 'feeds', name: 'Eigene Streams', position: 1 });
  const guide = (over: Partial<SourceView> = {}, state: Partial<SourceView['state']> = {}) => view({
    lastRefreshAt: null, lastOkAt: null, counts: null,
    epg: { lastRefreshAt: at(5, 40), lastOkAt: at(5, 40), lastError: null, programmes: 2140 }, ...state,
  }, { id: 'g1', kind: 'guide', name: 'Sternwarte Guide', urlHint: null, guideProvider: 'xmltv_url', guideScope: null, servedChannels: 12, channelCount: 0, position: 3, ...over });
  const all = [list2, feeds, list, guide()];

  it('guideScopeLabel: all channels, the named sources in card order, none left', () => {
    expect(guideScopeLabel(null, all)).toBe('Gilt für: Alle Sender');
    expect(guideScopeLabel(['src-feeds', 'src-nordlicht'], all)).toBe('Gilt für: Nordlicht Paket, Eigene Streams');
    expect(guideScopeLabel([], all)).toBe('Gilt für keine Quelle mehr');
    // ids of deleted sources are not shown; none left reads as none
    expect(guideScopeLabel(['src-gone', 'src-hafen'], all)).toBe('Gilt für: Hafen Paket');
    expect(guideScopeLabel(['src-gone'], all)).toBe('Gilt für keine Quelle mehr');
  });
  it('guideScopeLabel: English', async () => {
    await setLocale('en');
    expect(guideScopeLabel(null, all)).toMatch(/^[^:]+: \S/);
    expect(guideScopeLabel(['src-feeds'], all)).not.toContain('Eigene Streams');
  });
  it('scopeOptions: the lists by position, then the own streams; never a guide', () => {
    expect(scopeOptions(all).map((o) => o.id)).toEqual(['src-nordlicht', 'src-hafen', 'src-feeds']);
    expect(scopeOptions(all).at(-1)!.name).toBe('Eigene Streams');
  });
  it('guideStateLine: the last import of the guide', () => {
    expect(guideStateLine(guide(), NOW)).toBe('Zuletzt aktualisiert heute 05:40 · Programm: 2.140 Sendungen');
    expect(guideStateLine(guide({}, { epg: { lastRefreshAt: null, lastOkAt: null, lastError: null, programmes: null } }), NOW)).toBe('Noch nicht aktualisiert');
    expect(guideStateLine(guide({}, { epg: { lastRefreshAt: at(9, 0), lastOkAt: at(5, 40), lastError: 'timeout', programmes: 2140 } }), NOW)).toBe('Programm: Zeitüberschreitung · Zuletzt aktualisiert heute 05:40');
  });
  it('a guide refresh is done once its guide import moved; its result names the programmes', () => {
    const g = guide();
    expect(refreshDone(g, at(5, 40))).toBe(false);
    expect(refreshDone(guide({}, { epg: { ...g.state.epg, lastRefreshAt: at(9, 31) } }), at(5, 40))).toBe(true);
    expect(refreshResult(g)).toEqual({ ok: true, text: 'Programm aktualisiert: 2.140 Sendungen' });
    expect(refreshResult(guide({}, { epg: { ...g.state.epg, lastError: 'unreachable' } }))).toEqual({ ok: false, text: 'Aktualisieren fehlgeschlagen: Nicht erreichbar' });
  });
  it('guideMoves: up/down sends the neighbour\'s position (the server swaps the two); the page shows the swap; nothing past the ends', () => {
    const a = guide({ id: 'ga', position: 3 }), b = guide({ id: 'gb', position: 5 }), c = guide({ id: 'gc', position: 6 });
    expect(guideMoves([c, a, b], 'gb', -1)).toEqual({ patch: { id: 'gb', position: 3 }, swap: [{ id: 'gb', position: 3 }, { id: 'ga', position: 5 }] });
    expect(guideMoves([a, b, c], 'gb', 1)).toEqual({ patch: { id: 'gb', position: 6 }, swap: [{ id: 'gb', position: 6 }, { id: 'gc', position: 5 }] });
    expect(guideMoves([a, b, c], 'ga', -1)).toBeNull();
    expect(guideMoves([a, b, c], 'gc', 1)).toBeNull();
  });
  it('a 400 on guideScope has its own sentence', () => {
    expect(sourceFailText(new ApiError(400, { error: 'invalid', field: 'guideScope' }))).toBe('Wähle mindestens eine Quelle.');
  });
});

describe('guides from an uploaded file', () => {
  const f = (over: Partial<SourceView> = {}) => view({}, { kind: 'guide', guideProvider: 'xmltv_file', fileName: 'guide-uk.xml.gz', fileBytes: 48 * 1024 * 1024, ...over });
  it('fileLine: name and size, or none yet', () => {
    expect(fileLine(f())).toBe('guide-uk.xml.gz · 48 MB');
    expect(fileLine(f({ fileBytes: 1536 }))).toBe('guide-uk.xml.gz · 1,5 kB');
    expect(fileLine(f({ fileName: null, fileBytes: null }))).toBe('Noch keine Datei hochgeladen');
  });
  it('isFileGuide / guideProviderLabel', () => {
    expect(isFileGuide(f())).toBe(true);
    expect(isFileGuide(f({ guideProvider: 'xmltv_url' }))).toBe(false);
    expect(isFileGuide(view())).toBe(false);
    expect(guideProviderLabel(f())).toBe('Datei');
    expect(guideProviderLabel(f({ guideProvider: 'xmltv_url' }))).toBe('Link');
  });
  it('fileFailText: 413, 409 and 400 in words', () => {
    expect(fileFailText(new ApiError(413, { error: 'too_large' }))).toBe('Die Datei ist größer als 300 MB.');
    expect(fileFailText(new ApiError(409, { error: 'import_running' }))).toBe('Der Programmführer wird gerade eingelesen – versuche es gleich noch einmal.');
    // a 400 is an upload that broke off or was empty: the content is only read by the import
    expect(fileFailText(new ApiError(400, { error: 'invalid', field: 'file' }))).toBe('Die Datei konnte nicht hochgeladen werden oder war leer.');
    expect(fileFailText(new ApiError(409, { error: 'livetv_off' }))).toBe(tr('adminLive.src.refreshOff'));
    expect(fileFailText(new ApiError(404, { error: 'not_found' }))).toBe(tr('adminLive.src.gone'));
  });
  it('the import errors of a file in words: XMLTV refused, file gone, signature, gzip bomb', () => {
    const epg = (lastError: string) => ({ epg: { lastRefreshAt: '2026-11-14T09:00:00Z', lastOkAt: null, lastError, programmes: null } });
    const failed = (code: string, over: Partial<SourceView> = {}) => view(epg(code), { kind: 'guide', guideProvider: 'xmltv_file', fileName: 'a.xml', fileBytes: 10, ...over });
    expect(refreshResult(failed('invalid')).text).toBe('Aktualisieren fehlgeschlagen: Diese Datei ist kein XMLTV-Programmführer (.xml oder .xml.gz).');
    expect(refreshResult(failed('doctype')).text).toContain('kein XMLTV-Programmführer');
    // a link guide keeps the general wording
    expect(refreshResult(failed('invalid', { guideProvider: 'xmltv_url' })).text).not.toContain('Datei');
    expect(refreshResult(failed('no_file')).text).toBe('Aktualisieren fehlgeschlagen: Die gespeicherte Datei fehlt – lade sie neu hoch.');
    for (const code of ['no_file', 'bad_signature', 'ratio']) expect(sourceError(code)).not.toBe(tr('adminLive.err.generic'));
  });
});
