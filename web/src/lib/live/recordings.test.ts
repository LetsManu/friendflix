// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conflictText, groupBySeries, PAD_MAX, recordingFor, schedule, stateLabel, stepPad, type Recording } from './recordings';

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
