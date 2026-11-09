// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

const lg = vi.hoisted(() => ({ on: false }));
const fire = vi.hoisted(() => ({ on: false, height: 1080 }));
vi.mock('./detect', () => ({ isLgApp: () => lg.on }));
vi.mock('#lib/firetv/detect', () => ({ isFireTvApp: () => fire.on, fireTvDisplayHeight: () => fire.height }));
import { APP_VERSION } from '#lib/version/codenames';
import { _resetAppCaps, appCaps, buildLgCaps, buildTvCaps, confirmedTypes, type MediaProbe } from './caps';

const all: MediaProbe = { canPlayType: () => 'probably', isTypeSupported: () => true };
const none: MediaProbe = { canPlayType: () => '', isTypeSupported: () => false };

describe('buildLgCaps', () => {
  it('all confirmed gives the full lists without dts or truehd', () => {
    const c = buildLgCaps(all, '1.2.3')!;
    expect(c.client).toBe('webos');
    expect(c.appVersion).toBe('1.2.3');
    expect(c.containers).toEqual(['mkv', 'mp4', 'm4v', 'mov', 'ts', 'webm']);
    expect(c.video[0].profiles).toEqual(['constrained baseline', 'baseline', 'main', 'high', 'high 10']);
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
    const m: MediaProbe = { canPlayType: (t) => (t.includes('hvc1') ? '' : 'probably') };
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

describe('buildTvCaps', () => {
  // a WebView that denies matroska (what Chrome answers): LG would add mkv anyway, Fire TV must not
  const noMkv: MediaProbe = { canPlayType: (t) => (t === 'video/x-matroska' ? '' : 'probably'), isTypeSupported: (t) => t !== 'video/x-matroska' };
  it('Fire TV: client firetv, maxHeight from the display, no assumed mkv', () => {
    const c = buildTvCaps(noMkv, { client: 'firetv', appVersion: '1.2.3', maxHeight: 1080, assumed: [] })!;
    expect(c.client).toBe('firetv');
    expect(c.appVersion).toBe('1.2.3');
    expect(c.video.every((v) => v.maxHeight === 1080)).toBe(true);
    expect(c.containers).toEqual(['mp4', 'm4v', 'mov', 'ts', 'webm']);
    expect(c.audio).toEqual(['aac', 'ac3', 'eac3', 'mp3', 'flac', 'opus', 'vorbis']);
  });
  it('Fire TV keeps mkv when its WebView confirms it', () => {
    expect(buildTvCaps(all, { client: 'firetv', appVersion: '1.2.3', maxHeight: 2160, assumed: [] })!.containers).toEqual(['mkv', 'mp4', 'm4v', 'mov', 'ts', 'webm']);
    expect(buildLgCaps(noMkv, '1.2.3')!.containers).toEqual(['mkv', 'mp4', 'm4v', 'mov', 'ts', 'webm']);
  });
  it('LG through buildTvCaps equals buildLgCaps', () => {
    expect(buildTvCaps(all, { client: 'webos', appVersion: '1.0.0', maxHeight: 2160, assumed: ['mkv'] })).toEqual(buildLgCaps(all, '1.0.0'));
  });
  it('nothing confirmed gives null', () => {
    expect(buildTvCaps(none, { client: 'firetv', appVersion: '1.0.0', maxHeight: 2160, assumed: [] })).toBeNull();
  });
});

describe('appCaps', () => {
  afterEach(() => { lg.on = false; fire.on = false; fire.height = 1080; _resetAppCaps(); vi.unstubAllGlobals(); });
  const stub = () => {
    vi.stubGlobal('window', { MediaSource: { isTypeSupported: (t: string) => t !== 'video/x-matroska' } });
    vi.stubGlobal('document', { createElement: () => ({ canPlayType: (t: string) => (t === 'video/x-matroska' ? '' : 'maybe') }) });
  };

  it('is null without a window', () => {
    lg.on = true; _resetAppCaps();
    expect(appCaps()).toBeNull();
  });

  it('is null in a browser (neither app)', () => {
    stub(); _resetAppCaps();
    expect(appCaps()).toBeNull();
  });

  it('builds the LG block in the LG app and caches it until reset', () => {
    stub(); lg.on = true; _resetAppCaps();
    const a = appCaps()!;
    expect(a.client).toBe('webos');
    expect(a.appVersion).toBe(APP_VERSION);
    expect(a.containers).toContain('mkv');
    expect(a.video.every((v) => v.maxHeight === 2160)).toBe(true);
    expect(appCaps()).toBe(a);
    _resetAppCaps();
    expect(appCaps()).not.toBe(a);
  });

  it('builds the Fire TV block with the display height and no assumed containers', () => {
    stub(); fire.on = true; fire.height = 2160; _resetAppCaps();
    const a = appCaps()!;
    expect(a.client).toBe('firetv');
    expect(a.appVersion).toBe(APP_VERSION);
    expect(a.video.every((v) => v.maxHeight === 2160)).toBe(true);
    expect(a.containers).not.toContain('mkv');
    fire.height = 1080; _resetAppCaps();
    expect(appCaps()!.video.every((v) => v.maxHeight === 1080)).toBe(true);
  });

  it('without a media element (or MediaSource) the TV confirms nothing: null', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement: () => { throw new Error('no video'); } });
    fire.on = true; _resetAppCaps();
    expect(appCaps()).toBeNull();
  });

  it('works without MediaSource', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement: () => ({ canPlayType: () => 'maybe' }) });
    fire.on = true; _resetAppCaps();
    expect(appCaps()!.client).toBe('firetv');
  });
});

describe('ASSUMED_CONTAINERS (owner probe: webOS 25 answered no for MKV)', () => {
  const only = (ok: string[]): MediaProbe => ({ canPlayType: (t) => (ok.some((o) => t.includes(o)) ? 'probably' : '') });
  it('adds mkv when the TV confirms other formats but denies matroska', () => {
    const c = buildLgCaps(only(['video/mp4', 'avc1', 'mp4a']), '2.4.0')!;
    expect(c.containers).toContain('mkv');
    expect(c.containers).toContain('mp4');
  });
  it('adds nothing when the TV confirms no container (no block at all stays no block)', () => {
    expect(buildLgCaps(only([]), '2.4.0')).toBeNull();
  });
  it('the probe still reports what the TV itself answers', () => {
    expect(confirmedTypes(only(['video/mp4'])).containers).not.toContain('mkv');
  });
});
