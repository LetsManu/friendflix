// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { atEdge, behind, oldestPoint, restartTarget, resumePoint } from './dvr';

const ranges = (...pairs: Array<[number, number]>): TimeRanges =>
  ({ length: pairs.length, start: (i: number) => pairs[i]![0], end: (i: number) => pairs[i]![1] }) as TimeRanges;
const local = (h: number, m: number, s = 0) => new Date(2026, 10, 12, h, m, s, 0).getTime();
const frag = (programDateTime: number | null, start: number) => ({ programDateTime, start });

describe('behind / atEdge', () => {
  it('seconds behind the live edge, never negative', () => {
    expect(behind({ currentTime: 940 }, 1000)).toBe(60);
    expect(behind({ currentTime: 1003 }, 1000)).toBe(0);
  });
  it('at the edge up to 6 s behind', () => {
    expect(atEdge(0)).toBe(true);
    expect(atEdge(6)).toBe(true);
    expect(atEdge(6.01)).toBe(false);
    expect(atEdge(330)).toBe(false);
  });
});

describe('resumePoint', () => {
  it('a 40-min pause on a 30-min buffer resumes at the oldest point and says so', () => {
    expect(resumePoint(40 * 60, 1800, 250)).toEqual({ at: 250, tooLong: true });
  });
  it('a pause inside the buffer is not too long', () => {
    expect(resumePoint(10 * 60, 1800, 250)).toMatchObject({ tooLong: false });
    expect(resumePoint(1800, 1800, 250)).toMatchObject({ tooLong: false });
    expect(resumePoint(40 * 60, 7200, 0)).toMatchObject({ tooLong: false });
  });
});

describe('oldestPoint', () => {
  const P = local(20, 0);
  it('hls.js: the first fragment of the current level', () => {
    const hls = { levels: [{ details: { fragments: [frag(P, 100), frag(P + 2000, 102)] } }], currentLevel: 0 };
    expect(oldestPoint({ hls, video: { seekable: ranges([100, 1900]) } })).toEqual({ pdt: P, time: 100 });
  });
  it('hls.js: another current level is read, an unset one (-1) falls back to the first level with details', () => {
    const levels = [{}, { details: { fragments: [frag(P + 4000, 12), frag(P + 6000, 14)] } }];
    expect(oldestPoint({ hls: { levels, currentLevel: 1 }, video: { seekable: ranges([12, 900]) } })).toEqual({ pdt: P + 4000, time: 12 });
    expect(oldestPoint({ hls: { levels, currentLevel: -1 }, video: { seekable: ranges([12, 900]) } })).toEqual({ pdt: P + 4000, time: 12 });
  });
  it('hls.js: no date-time, no fragments or no details is null', () => {
    expect(oldestPoint({ hls: { levels: [{ details: { fragments: [frag(null, 0)] } }], currentLevel: 0 }, video: { seekable: ranges([0, 10]) } })).toBeNull();
    expect(oldestPoint({ hls: { levels: [{ details: { fragments: [] } }], currentLevel: 0 }, video: { seekable: ranges() } })).toBeNull();
    expect(oldestPoint({ hls: { levels: [{}], currentLevel: 0 }, video: { seekable: ranges() } })).toBeNull();
  });
  it("Safari: getStartDate() is media time 0, so the oldest point is it plus seekable.start(0)", () => {
    const P0 = local(19, 59, 20);
    expect(oldestPoint({ hls: null, video: { seekable: ranges([40, 1840]), getStartDate: () => new Date(P0) } })).toEqual({ pdt: P0 + 40_000, time: 40 });
  });
  it('Safari: an invalid start date, nothing seekable or no getStartDate is null', () => {
    expect(oldestPoint({ hls: null, video: { seekable: ranges([40, 1840]), getStartDate: () => new Date(Number.NaN) } })).toBeNull();
    expect(oldestPoint({ hls: null, video: { seekable: ranges(), getStartDate: () => new Date(P) } })).toBeNull();
    expect(oldestPoint({ hls: null, video: { seekable: ranges([40, 1840]) } })).toBeNull();
  });
});

describe('restartTarget (ruling 48: max(oldest, start − 30 s))', () => {
  const o = { pdt: local(20, 0, 0), time: 100 };
  it('programme 20:15 with the oldest segment at 20:00:00 / media 100 s → 100 + 870 = 970', () => {
    expect(restartTarget(local(20, 15), o)).toBe(970);
  });
  it('programme 20:00:10 → clamped to the oldest point (100)', () => {
    expect(restartTarget(local(20, 0, 10), o)).toBe(100);
    expect(restartTarget(local(20, 0, 0), o)).toBe(100);
  });
  it('programme 19:59 (older than the buffer) → null', () => {
    expect(restartTarget(local(19, 59), o)).toBeNull();
  });
  it('no oldest point → null', () => {
    expect(restartTarget(local(20, 15), null)).toBeNull();
  });
  it('a programme 95 min old in a 120-min buffer lands 30 s before its start', () => {
    const now = local(20, 37);
    expect(restartTarget(now - 95 * 60_000, { pdt: now - 120 * 60_000, time: 0 })).toBe(25 * 60 - 30);
  });
});
