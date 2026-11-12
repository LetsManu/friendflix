// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { LiveChannel, Prog } from './api';
import { progressAt, rowName, timeLeft, watchPath } from './progress';

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 12, h, m, s);
const prog = (title: string, from: [number, number], to: [number, number]): Prog => ({ title, start: at(...from).toISOString(), end: at(...to).toISOString() });
const evening = prog('Die Leuchtturmwärter', [20, 15], [21, 0]);

describe('progressAt', () => {
  it('is the elapsed share of the programme', () => {
    expect(progressAt(evening, at(20, 30))).toBeCloseTo(1 / 3, 10);
    expect(progressAt(evening, at(20, 15))).toBe(0);
    expect(progressAt(evening, at(21, 0))).toBe(1);
  });
  it('moves in whole minutes: seconds do not count', () => {
    expect(progressAt(evening, at(20, 30, 0))).toBe(progressAt(evening, at(20, 30, 59)));
    expect(progressAt(evening, at(20, 31, 0))).toBeGreaterThan(progressAt(evening, at(20, 30, 59)));
  });
  it('stays within 0 to 1 before the start and after the end, and for a broken programme', () => {
    expect(progressAt(evening, at(19, 0))).toBe(0);
    expect(progressAt(evening, at(23, 0))).toBe(1);
    expect(progressAt({ title: 'x', start: evening.end, end: evening.start }, at(20, 30))).toBe(0);
    expect(progressAt({ title: 'x', start: 'nope', end: 'nope' }, at(20, 30))).toBe(0);
  });
});

describe('timeLeft', () => {
  it('minutes rounded up', () => {
    expect(timeLeft(evening, at(20, 37, 10))).toEqual({ key: 'live.timeLeft', n: 23 });
    expect(timeLeft(evening, at(20, 37, 0))).toEqual({ key: 'live.timeLeft', n: 23 });
    expect(timeLeft(evening, at(20, 38, 0))).toEqual({ key: 'live.timeLeft', n: 22 });
    expect(timeLeft(evening, at(20, 59, 0))).toEqual({ key: 'live.timeLeft', n: 1 });
  });
  it('from 60 minutes on: hours and minutes', () => {
    const long = prog('Abenteuer Wattenmeer', [19, 0], [21, 0]);
    expect(timeLeft(long, at(19, 40))).toEqual({ key: 'live.timeLeftLong', h: 1, m: 20 });
    expect(timeLeft(long, at(20, 0))).toEqual({ key: 'live.timeLeftLong', h: 1, m: 0 });
    expect(timeLeft(long, at(20, 1))).toEqual({ key: 'live.timeLeft', n: 59 });
    expect(timeLeft(long, at(19, 0))).toEqual({ key: 'live.timeLeftLong', h: 2, m: 0 });
  });
  it('under a minute: endet gleich', () => {
    expect(timeLeft(evening, at(20, 59, 30))).toEqual({ key: 'live.endingNow' });
    expect(timeLeft(evening, at(21, 0, 0))).toEqual({ key: 'live.endingNow' });
  });
  it('no programme (or a broken one): nothing', () => {
    expect(timeLeft(undefined, at(20, 0))).toBeNull();
    expect(timeLeft({ title: 'x', start: 'a', end: 'b' }, at(20, 0))).toBeNull();
  });
});

describe('watchPath', () => {
  it('the player route of a channel, the id encoded', () => {
    expect(watchPath('ch-hafen')).toBe('/live/watch/ch-hafen');
    expect(watchPath('a b/c')).toBe('/live/watch/a%20b%2Fc');
  });
});

describe('rowName (spec §21)', () => {
  const ch: LiveChannel = { id: 'a', number: 4, name: 'Hafenkanal', logo: null, groupId: 'g', running: true, epg: 'ok', favourite: false, now: evening, next: prog('Wetter am Hafen', [21, 0], [22, 0]) };
  it('{number} {name}, jetzt: {title}, bis {time}', () => {
    expect(rowName(ch, at(20, 30))).toBe('4 Hafenkanal, jetzt: Die Leuchtturmwärter, bis 21:00');
  });
  it('without a running programme only number and name', () => {
    expect(rowName({ ...ch, now: undefined, epg: 'none' }, at(20, 30))).toBe('4 Hafenkanal');
    expect(rowName({ ...ch, epg: 'gap', now: undefined }, at(20, 30))).toBe('4 Hafenkanal');
    expect(rowName({ ...ch, receiving: false }, at(20, 30))).toBe('4 Hafenkanal');
  });
});
