// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildLgCaps, confirmedTypes, type MediaProbe } from './caps';

const all: MediaProbe = { canPlayType: () => 'probably', isTypeSupported: () => true };
const none: MediaProbe = { canPlayType: () => '', isTypeSupported: () => false };

describe('buildLgCaps', () => {
  it('all confirmed gives the full lists without dts or truehd', () => {
    const c = buildLgCaps(all, '1.2.3')!;
    expect(c.client).toBe('webos');
    expect(c.appVersion).toBe('1.2.3');
    expect(c.containers).toEqual(['mkv', 'mp4', 'm4v', 'mov', 'ts', 'webm']);
    expect(c.video.map((v) => v.codec)).toEqual(['h264', 'hevc', 'av1', 'vp9', 'mpeg2video']);
    expect(c.video.every((v) => v.maxHeight === 2160)).toBe(true);
    expect(c.video[1].profiles).toEqual(['main', 'main 10']);
    expect(c.audio).toEqual(['aac', 'ac3', 'eac3', 'mp3', 'flac', 'opus', 'vorbis']);
    expect(c.audio).not.toContain('dts');
    expect(c.audio).not.toContain('truehd');
    expect(c.subtitles).toEqual(['srt', 'ass', 'ssa', 'vtt']);
  });

  it('counts isTypeSupported when canPlayType says no, and maybe as confirmed', () => {
    const m: MediaProbe = {
      canPlayType: (t) => (t.includes('hvc1.2.4') ? '' : 'maybe'),
      isTypeSupported: (t) => t.includes('hvc1.2.4'),
    };
    expect(buildLgCaps(m, '1.0.0')!.video.find((v) => v.codec === 'hevc')!.profiles).toEqual(['main', 'main 10']);
  });

  it('drops a codec without a confirmed profile', () => {
    const m: MediaProbe = { canPlayType: (t) => (t.includes('hvc1') || t.includes('hev1') ? '' : 'probably') };
    expect(buildLgCaps(m, '1.0.0')!.video.map((v) => v.codec)).not.toContain('hevc');
  });

  it('nothing confirmed gives null', () => {
    expect(buildLgCaps(none, '1.0.0')).toBeNull();
    expect(buildLgCaps(null, '1.0.0')).toBeNull();
  });

  it('survives a missing MediaSource and canPlayType throwing for ec-3', () => {
    const m: MediaProbe = { canPlayType: (t) => { if (t.includes('ec-3')) throw new Error('boom'); return 'probably'; } };
    const c = buildLgCaps(m, '1.0.0')!;
    expect(c.audio).not.toContain('eac3');
    expect(c.audio).toContain('ac3');
    expect(confirmedTypes(m).audio).not.toContain('eac3');
  });
});
