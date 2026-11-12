// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DVR_MAX_SECONDS, SegmentWindow } from '../src/window.js';

const T0 = Date.parse('2026-11-11T19:15:00.000Z');
/** n segments of `d` seconds, back to back from T0 */
function fill(w: SegmentWindow, n: number, d = 4, bytes = 1000): void {
  for (let i = 0; i < n; i++) w.add({ file: `f${i}.ts`, duration: d, pdt: T0 + i * d * 1000, bytes });
}
const lines = (w: SegmentWindow) => w.playlist().split('\n');
const uris = (w: SegmentWindow) => lines(w).filter((l) => l !== '' && !l.startsWith('#'));

describe('SegmentWindow', () => {
  it('dvr 30 s keeps 32 s of 4-s segments', () => {
    const w = new SegmentWindow({ dvrSeconds: 30, ext: 'ts' });
    fill(w, 10);
    expect(uris(w)).toEqual(['2.ts', '3.ts', '4.ts', '5.ts', '6.ts', '7.ts', '8.ts', '9.ts']);
    expect(lines(w)).toContain('#EXT-X-MEDIA-SEQUENCE:2');
    expect(w.seconds).toBe(32);
    expect(w.bytes).toBe(8000);
    expect(w.length).toBe(8);
  });

  it('dvr 0 keeps 3', () => {
    const w = new SegmentWindow({ dvrSeconds: 0, ext: 'ts' });
    fill(w, 7);
    expect(uris(w)).toEqual(['4.ts', '5.ts', '6.ts']);
  });

  it('dvr 7200 keeps 120 min; 7201 is refused', () => {
    expect(DVR_MAX_SECONDS).toBe(7200);
    const w = new SegmentWindow({ dvrSeconds: 7200, ext: 'ts' });
    fill(w, 1900);
    expect(w.length).toBe(1800);
    expect(w.seconds).toBe(7200);
    expect(lines(w)).toContain('#EXT-X-MEDIA-SEQUENCE:100');
    for (const bad of [7201, -1, 1.5, Number.NaN]) expect(() => new SegmentWindow({ dvrSeconds: bad, ext: 'ts' })).toThrow(RangeError);
  });

  it('dropped segments are handed to onDrop (the caller deletes the files)', () => {
    const dropped: string[] = [];
    const w = new SegmentWindow({ dvrSeconds: 8, ext: 'ts', onDrop: (f) => dropped.push(f) });
    fill(w, 5);
    expect(dropped).toEqual(['f0.ts', 'f1.ts']);
  });

  it('every segment carries a program date-time; oldest() answers the first kept one', () => {
    const w = new SegmentWindow({ dvrSeconds: 8, ext: 'ts' });
    expect(w.oldest()).toBeNull();
    fill(w, 5);
    const l = lines(w);
    const pdt = l.filter((x) => x.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
    expect(pdt).toHaveLength(uris(w).length);
    // the tag directly precedes each segment's EXTINF
    for (let i = 0; i < l.length; i++) if (l[i]!.startsWith('#EXTINF:')) expect(l[i - 1]).toMatch(/^#EXT-X-PROGRAM-DATE-TIME:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(pdt[0]).toBe('#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:08.000Z');
    expect(w.oldest()).toEqual({ seq: 2, pdt: T0 + 8000 });
    const one = new SegmentWindow({ dvrSeconds: 30, ext: 'ts' });
    one.add({ file: 'a.ts', duration: 4, pdt: Date.parse('2026-11-11T19:15:00.000Z') });
    expect(one.playlist()).toContain('#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:00.000Z\n#EXTINF:4.000,\n0.ts');
  });

  it('discontinuity tag placement and DISCONTINUITY-SEQUENCE after the marked segment leaves', () => {
    const w = new SegmentWindow({ dvrSeconds: 0, ext: 'ts' });
    const add = (disc = false) => w.add({ file: 'x.ts', duration: 4, pdt: T0, discontinuity: disc });
    add(); add(); add(true); add();
    // window 1, 2, 3; the tag sits right before segment 2
    let l = lines(w);
    expect(l).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:0');
    const at = l.indexOf('#EXT-X-DISCONTINUITY');
    expect(l.slice(at, at + 4)).toEqual(['#EXT-X-DISCONTINUITY', '#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:00.000Z', '#EXTINF:4.000,', '2.ts']);
    add();
    expect(lines(w)).toContain('#EXT-X-DISCONTINUITY');
    // segment 2 leaves: its tag is counted
    add();
    l = lines(w);
    expect(l).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:1');
    expect(l).not.toContain('#EXT-X-DISCONTINUITY');
    expect(uris(w)).toEqual(['3.ts', '4.ts', '5.ts']);
  });

  it('a sliding live playlist: no ENDLIST, no PLAYLIST-TYPE; TS is version 6, target duration rounded up', () => {
    const w = new SegmentWindow({ dvrSeconds: 30, ext: 'ts' });
    w.add({ file: 'a.ts', duration: 4.2, pdt: T0 });
    const l = lines(w);
    expect(l.slice(0, 5)).toEqual(['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-DISCONTINUITY-SEQUENCE:0']);
    expect(w.playlist()).not.toMatch(/ENDLIST|PLAYLIST-TYPE|EXT-X-MAP/);
    expect(l).toContain('#EXTINF:4.200,');
  });

  it('fMP4 has the MAP line and version 7', () => {
    const w = new SegmentWindow({ dvrSeconds: 30, ext: 'm4s', init: true });
    w.add({ file: 'a.m4s', duration: 4, pdt: T0, init: 0 });
    expect(lines(w).slice(0, 7)).toEqual(['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-MAP:URI="init-0.mp4"', '#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:00.000Z']);
    expect(uris(w)).toEqual(['0.m4s']);
    // an init window needs an init version on every segment, a TS window none
    expect(() => w.add({ file: 'b.m4s', duration: 4, pdt: T0 })).toThrow(RangeError);
    expect(() => w.add({ file: 'b.m4s', duration: 4, pdt: T0, init: -1 })).toThrow(RangeError);
    expect(() => new SegmentWindow({ dvrSeconds: 30, ext: 'ts' }).add({ file: 'b.ts', duration: 4, pdt: T0, init: 0 })).toThrow(RangeError);
  });

  it('an init change mid-stream: two MAP lines in place, each segment maps to its own init, the old init leaves with its segments', () => {
    const dropped: string[] = [];
    const w = new SegmentWindow({ dvrSeconds: 7200, ext: 'm4s', init: true, onDrop: (f) => dropped.push(f) });
    w.add({ file: 'a.m4s', duration: 4, pdt: T0, init: 0 });
    w.add({ file: 'b.m4s', duration: 4, pdt: T0 + 4000, init: 0 });
    // the init changes: a discontinuity even though the caller did not mark one
    w.add({ file: 'c.m4s', duration: 4, pdt: T0 + 8000, init: 1 });
    w.add({ file: 'd.m4s', duration: 4, pdt: T0 + 12000, init: 1 });
    w.add({ file: 'e.m4s', duration: 4, pdt: T0 + 16000, init: 1 });
    const body = lines(w).slice(5).filter((l) => !l.startsWith('#EXT-X-PROGRAM-DATE-TIME') && !l.startsWith('#EXTINF'));
    expect(body).toEqual(['#EXT-X-MAP:URI="init-0.mp4"', '0.m4s', '1.m4s', '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="init-1.mp4"', '2.m4s', '3.m4s', '4.m4s', '']);
    // a seek back: segment 0 is still served, under the MAP of init-0, and init-0 still exists
    expect(w.find('0.m4s')).toBe('a.m4s');
    expect(w.find('init-0.mp4')).toBe('init-0.mp4');
    expect(w.find('init-1.mp4')).toBe('init-1.mp4');
    expect(w.find('init-2.mp4')).toBeNull();
    expect(w.dropOldest()).toBe('a.m4s');
    expect(dropped).toEqual([]);
    expect(w.dropOldest()).toBe('b.m4s');
    // its last segment left: init-0 goes too
    expect(dropped).toEqual(['init-0.mp4']);
    expect(w.find('init-0.mp4')).toBeNull();
    const top = lines(w).slice(5, 8);
    expect(top).toEqual(['#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="init-1.mp4"', '#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:08.000Z']);
    expect(w.newest()).toEqual({ pdt: T0 + 16000, duration: 4 });
  });

  it('find maps a local name to the stored file; dropOldest never takes the newest 3', () => {
    const w = new SegmentWindow({ dvrSeconds: 7200, ext: 'ts' });
    fill(w, 4);
    expect(w.find('0.ts')).toBe('f0.ts');
    expect(w.find('3.ts')).toBe('f3.ts');
    for (const bad of ['4.ts', '0.m4s', 'index.m3u8', '-1.ts', 'x.ts', '01.ts', '00.ts', 'init-0.mp4']) expect(w.find(bad)).toBeNull();
    expect(new SegmentWindow({ dvrSeconds: 0, ext: 'ts' }).find('0.ts')).toBeNull();
    expect(new SegmentWindow({ dvrSeconds: 0, ext: 'ts' }).newest()).toBeNull();
    expect(w.dropOldest()).toBe('f0.ts');
    expect(w.find('0.ts')).toBeNull();
    expect(w.dropOldest()).toBeNull();
    expect(w.length).toBe(3);
    expect(lines(w)).toContain('#EXT-X-MEDIA-SEQUENCE:1');
  });

  it('local numbers keep rising after drops; an empty window answers its next number', () => {
    const w = new SegmentWindow({ dvrSeconds: 0, ext: 'ts' });
    expect(w.playlist()).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(w.seconds).toBe(0);
    const seqs = Array.from({ length: 6 }, () => w.add({ file: 'x.ts', duration: 2, pdt: T0 }));
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => w.add({ file: 'x.ts', duration: 0, pdt: T0 })).toThrow(RangeError);
    expect(() => w.add({ file: 'x.ts', duration: 2, pdt: Number.NaN })).toThrow(RangeError);
  });
});
