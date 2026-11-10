// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { avRows, type CapsFacts } from './diagnoseav';
import type { StoredTiming } from './timing';

const caps: CapsFacts = { hevcFiles: true, hevcStreams: true, surround: ['eac3'], channels: 6, stereoChoice: false, soundMode: false, avoided: {} };
const tr = (k: string, p?: Record<string, string>) => (p ? `${k}${JSON.stringify(p)}` : k);
const last = (o: Partial<StoredTiming>) => ({ at: 0, videoOut: null, audioOut: null, why: [], audioCodec: null, channels: null, ...o }) as unknown as StoredTiming;
const row = (rows: Array<[string, string]>, k: string) => rows.find(([l]) => l === k)![1];

describe('avRows', () => {
  it('no stored report: "no playback yet"', () => {
    expect(row(avRows({ caps, abilities: null, last: null, t: tr, date: String }), 'diagnose.avRowLast')).toBe('diagnose.lastNone');
  });
  it('a report whose codes are unknown (Plex, older report) is a playback: "not known", never "none yet"', () => {
    const r = avRows({ caps, abilities: null, last: last({}), t: tr, date: String });
    expect(row(r, 'diagnose.avRowLast')).toContain('diagnose.out.unknown');
    expect(row(r, 'diagnose.avRowWhy')).toBe('diagnose.whyNone');
  });
  it('malformed stored reasons do not break the rows', () => {
    const r = avRows({ caps, abilities: null, last: last({ videoOut: 'hevc', why: 'oops' as unknown as string[] }), t: tr, date: String });
    expect(row(r, 'diagnose.avRowWhy')).toBe('diagnose.whyNone');
  });
});
