// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conflictText, createRule, deleteRecording, deleteRule, getRecording, groupBySeries, listRecordings, PAD_MAX, patchRecording, patchRule, programme, recordingFor, schedule,
  stateLabel, stepPad, toLibrary, type Recording, finished, hhmm, KEEP_MAX, minutesOf, planned, progressOf, rowRecordings, ROW_MAX, stepKeep,
  doneRecordings, spanPreset, stopRecording,
} from './recordings';

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
let n = 0;
const rec = (o: Partial<Recording>): Recording => ({
  id: `r${++n}`, title: 'Die Leuchtturmwärter', subtitle: null, episode: null, channel: { id: 'ch-nord', name: 'Nordlicht TV', logo: null },
  start: at(10, 20, 15), end: at(10, 21), padBefore: 2, padAfter: 5, state: 'done', error: null, gaps: 0, durationS: 2700, bytes: 1, keep: false,
  visibility: 'private', mine: true, seriesKey: null, ruleId: null, positionS: 0, watched: false, deleteAfter: null, storage: 'ff', growing: false, ...o,
});

describe('groupBySeries', () => {
  it('groupBySeries orders episodes newest first', () => {
    const a = rec({ id: 'a', seriesKey: 'leucht', ruleId: 'rule1', start: at(8, 20) });
    const b = rec({ id: 'b', seriesKey: 'leucht', ruleId: 'rule1', start: at(11, 20) });
    const c = rec({ id: 'c', seriesKey: 'leucht', ruleId: 'rule1', start: at(9, 20) });
    const single = rec({ id: 's', title: 'Sternstunde Physik', seriesKey: 'sternstunde physik', start: at(10, 18) });
    const g = groupBySeries([a, single, b, c]);
    expect(g.map((x) => x.kind)).toEqual(['series', 'single']);
    const s = g[0]!;
    expect(s.kind === 'series' && s.items.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(s.kind === 'series' && s.title).toBe('Die Leuchtturmwärter');
    // the singles stand on their own, by date (the group's newest episode decides its place)
    expect(g[1]!.kind === 'single' && g[1]!.item.id).toBe('s');
  });
  it('two recordings with one series key and no rule form a group; one alone stays a single', () => {
    const g = groupBySeries([rec({ id: 'x', seriesKey: 'k', start: at(9, 20) }), rec({ id: 'y', seriesKey: 'k', start: at(12, 20) }), rec({ id: 'z', seriesKey: 'other', start: at(10, 20) })]);
    expect(g.map((x) => (x.kind === 'series' ? x.items.map((i) => i.id).join('+') : x.item.id))).toEqual(['y+x', 'z']);
  });
  it('a rule groups even one episode', () => {
    const g = groupBySeries([rec({ id: 'only', ruleId: 'r', seriesKey: 'k' })]);
    expect(g[0]!.kind).toBe('series');
  });
});

describe('stateLabel', () => {
  it('stateLabel covers every state with gaps count', () => {
    expect(stateLabel(rec({ state: 'scheduled' }))).toBe('Geplant');
    expect(stateLabel(rec({ state: 'recording' }))).toBe('Läuft');
    expect(stateLabel(rec({ state: 'done' }))).toBe('Fertig');
    expect(stateLabel(rec({ state: 'partial', gaps: 3 }))).toBe('Unvollständig (3 Lücken)');
    expect(stateLabel(rec({ state: 'partial', gaps: 1 }))).toBe('Unvollständig (1 Lücke)');
    expect(stateLabel(rec({ state: 'failed' }))).toBe('Fehlgeschlagen');
    expect(stateLabel(rec({ state: 'cancelled' }))).toBe('Abgebrochen');
  });
});

describe('stepPad', () => {
  it('padding stepper clamps 0–30 / 0–120', () => {
    expect(PAD_MAX).toEqual({ before: 30, after: 120 });
    expect(stepPad('before', 0, -1)).toBe(0);
    expect(stepPad('before', 29, 1)).toBe(30);
    expect(stepPad('before', 30, 1)).toBe(30);
    expect(stepPad('after', 119, 5)).toBe(120);
    expect(stepPad('after', 3, -5)).toBe(0);
    expect(stepPad('after', 5, 1)).toBe(6);
  });
});

describe('recordingFor and the conflict line', () => {
  it('finds the profile\'s planned or running recording of a programme', () => {
    const r = rec({ id: 'p', state: 'scheduled', start: at(12, 21, 0) });
    expect(recordingFor([r], 'ch-nord', at(12, 21, 0))?.id).toBe('p');
    expect(recordingFor([r], 'ch-hafen', at(12, 21, 0))).toBeNull();
    expect(recordingFor([{ ...r, state: 'cancelled' }], 'ch-nord', at(12, 21, 0))).toBeNull();
  });
  it('names the slots, else the parallel limit, else the provider', () => {
    expect(conflictText({ slots: { used: 3, limit: 2 }, parallel: { used: 1, max: 4 }, provider: null, conflict: true })).toBe(
      'Zu dieser Zeit sind schon 2 von 2 Umwandlungsplätzen für Aufnahmen verplant. Diese Aufnahme kann ausfallen.');
    expect(conflictText({ slots: { used: 0, limit: 2 }, parallel: { used: 5, max: 4 }, provider: null, conflict: true })).toMatch(/4 Aufnahmen/);
    expect(conflictText({ slots: { used: 0, limit: 2 }, parallel: { used: 1, max: 4 }, provider: { used: 3, max: 2 }, conflict: true })).toMatch(/2 Sender/);
  });
});

describe('schedule', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends the programme start and answers a conflict typed (409 with its forecast)', async () => {
    const fc = { slots: { used: 3, limit: 2 }, parallel: { used: 1, max: 4 }, provider: null, conflict: true };
    const f = vi.fn(async () => ({ status: 409, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'conflict', forecast: fc }) }));
    vi.stubGlobal('fetch', f);
    const r = await schedule({ channelId: 'ch-nord', start: at(12, 20, 15) });
    expect(r).toEqual({ ok: false, forecast: fc });
    const [u, init] = f.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(u).toBe('/api/livetv/recordings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ channelId: 'ch-nord', start: at(12, 20, 15) });
  });
});

describe('the calls', () => {
  afterEach(() => vi.unstubAllGlobals());
  type Init = { method?: string; body?: string; keepalive?: boolean };
  /** fetch answering `body` (200) and recording `METHOD url body` per call */
  function stub(body: unknown, status = 200) {
    const f = vi.fn(async (_u: string, _i: Init) => ({ status, ok: status < 400, headers: { get: () => null }, text: async () => JSON.stringify(body) }));
    vi.stubGlobal('fetch', f);
    return () => f.mock.calls.map(([u, i]) => `${i.method ?? 'GET'} ${u}${i.body ? ` ${i.body}` : ''}${i.keepalive ? ' keepalive' : ''}`);
  }
  const r1 = rec({ id: 'r/1' });
  const rule = { id: 'ru 1' };
  it.each<[string, () => Promise<unknown>, unknown, unknown, string]>([
    ['listRecordings', () => listRecordings(), { recordings: [], rules: [] }, { recordings: [], rules: [] }, 'GET /api/livetv/recordings?state=all'],
    ['listRecordings with conflicts', () => listRecordings('scheduled', { conflicts: true }), { recordings: [], rules: [] }, { recordings: [], rules: [] }, 'GET /api/livetv/recordings?state=scheduled&conflicts=1'],
    ['getRecording', () => getRecording('r/1'), { recording: r1 }, r1, 'GET /api/livetv/recordings/r%2F1'],
    ['programme', () => programme('ch nord', '2026-11-10T19:15:00.000Z'), { title: 'x' }, { title: 'x' }, 'GET /api/livetv/programme/ch%20nord/2026-11-10T19%3A15%3A00.000Z'],
    ['patchRecording', () => patchRecording('r/1', { keep: true }), { recording: r1 }, r1, 'PATCH /api/livetv/recordings/r%2F1 {"keep":true}'],
    ['deleteRecording', () => deleteRecording('r/1', true), null, null, 'DELETE /api/livetv/recordings/r%2F1 keepalive'],
    ['toLibrary', () => toLibrary('r/1'), { recording: r1 }, r1, 'POST /api/livetv/recordings/r%2F1/library {}'],
    ['stopRecording', () => stopRecording('r/1'), { recording: r1 }, r1, 'POST /api/livetv/recordings/r%2F1/stop {}'],
    ['createRule', () => createRule({ kind: 'series', channelId: null, seriesKey: 'leucht', title: 'Die Leuchtturmwärter', onlyNew: true }), { rule, forecast: null }, { rule, forecast: null },
      'POST /api/livetv/rules {"kind":"series","channelId":null,"seriesKey":"leucht","title":"Die Leuchtturmwärter","onlyNew":true}'],
    ['patchRule', () => patchRule('ru 1', { enabled: false }), { rule }, rule, 'PATCH /api/livetv/rules/ru%201 {"enabled":false}'],
    ['deleteRule', () => deleteRule('ru 1'), null, null, 'DELETE /api/livetv/rules/ru%201'],
  ])('%s calls its endpoint', async (_n, call, answer, want, line) => {
    const calls = stub(answer);
    expect(await call()).toEqual(want);
    expect(calls()).toEqual([line]);
  });
  it('schedule answers the recording (and a forecast when there is one); other errors are thrown', async () => {
    stub({ recording: r1 });
    expect(await schedule({ channelId: 'ch-nord', start: at(12, 20) })).toEqual({ ok: true, recording: r1 });
    const fc = { slots: { used: 1, limit: 2 }, parallel: { used: 1, max: 4 }, provider: null, conflict: false };
    stub({ recording: r1, forecast: fc });
    expect(await schedule({ channelId: 'ch-nord', start: at(12, 20) })).toEqual({ ok: true, recording: r1, forecast: fc });
    stub({ error: 'conflict' }, 409); // no forecast: not a typed conflict
    await expect(schedule({ channelId: 'ch-nord', start: at(12, 20) })).rejects.toMatchObject({ status: 409 });
    stub({ error: 'busy' }, 503);
    await expect(schedule({ channelId: 'ch-nord', start: at(12, 20) })).rejects.toMatchObject({ status: 503 });
  });
});

describe('the list helpers', () => {
  it('stepKeep walks 1 … 10 and "all" (null) above', () => {
    expect(stepKeep(null, 1)).toBeNull();
    expect(stepKeep(null, -1)).toBe(KEEP_MAX);
    expect(stepKeep(KEEP_MAX, 1)).toBeNull();
    expect(stepKeep(1, -1)).toBe(1);
    expect(stepKeep(3, 1)).toBe(4);
  });
  it('the row keeps the newest playable ones, Fertig adds failed ones, Geplant is soonest first', () => {
    const list = [
      rec({ id: 'old', start: at(1, 20) }), rec({ id: 'new', start: at(9, 20), state: 'partial' }), rec({ id: 'run', start: at(10, 20), state: 'recording' }),
      rec({ id: 'bad', state: 'failed' }), rec({ id: 'p2', state: 'scheduled', start: at(20, 20) }), rec({ id: 'p1', state: 'scheduled', start: at(15, 20) }),
    ];
    expect(rowRecordings(list).map((r) => r.id)).toEqual(['run', 'new', 'old']);
    expect(rowRecordings(Array.from({ length: ROW_MAX + 3 }, () => rec({})))).toHaveLength(ROW_MAX);
    expect(finished(list).map((r) => r.id)).toEqual(['old', 'new', 'run', 'bad']);
    expect(planned(list).map((r) => r.id)).toEqual(['p1', 'p2']);
  });
  it('minutes, the time of day and the watched share', () => {
    expect(minutesOf({ durationS: 2700, start: at(10, 20), end: at(10, 21) })).toBe(45);
    expect(minutesOf({ durationS: null, start: at(10, 20), end: at(10, 21, 30) })).toBe(90);
    expect(hhmm(new Date(2026, 10, 10, 7, 5))).toBe('07:05');
    expect(progressOf({ positionS: 900, durationS: 1800 })).toBe(0.5);
    expect(progressOf({ positionS: 4000, durationS: 1800 })).toBe(1);
    expect(progressOf({ positionS: 10, durationS: null })).toBe(0);
  });
});

describe('less than a whole programme (DVR follow-ups)', () => {
  const prog = { title: 'Die Leuchtturmwärter', start: at(12, 20, 15), end: at(12, 21) };
  it('spanPreset: a running programme starts at this minute, an upcoming one at its start; both end with the programme', () => {
    const now = new Date(2026, 10, 12, 20, 37, 10);
    expect(spanPreset(prog, now)).toEqual({ start: new Date(2026, 10, 12, 20, 37), end: new Date(2026, 10, 12, 21), title: 'Die Leuchtturmwärter' });
    const early = new Date(2026, 10, 12, 19, 50, 30);
    expect(spanPreset(prog, early)).toEqual({ start: new Date(2026, 10, 12, 20, 15), end: new Date(2026, 10, 12, 21), title: 'Die Leuchtturmwärter' });
    // in its last minute: at least one minute long
    const last = new Date(2026, 10, 12, 20, 59, 40);
    expect(spanPreset(prog, last).end.getTime() - spanPreset(prog, last).start.getTime()).toBe(60_000);
  });
  it('doneRecordings: the finished ones (done, partial) for the home row, newest first, at most ROW_MAX', () => {
    const list = [
      rec({ id: 'a', state: 'done', start: at(9, 20) }), rec({ id: 'b', state: 'recording', start: at(12, 20) }), rec({ id: 'c', state: 'partial', start: at(11, 20) }),
      rec({ id: 'd', state: 'failed', start: at(10, 20) }), rec({ id: 'e', state: 'scheduled', start: at(13, 20) }),
    ];
    expect(doneRecordings(list).map((r) => r.id)).toEqual(['c', 'a']);
    expect(doneRecordings(Array.from({ length: 20 }, (_, i) => rec({ id: `x${i}`, start: at(1 + i, 20) })))).toHaveLength(ROW_MAX);
  });
});
