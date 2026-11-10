// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { APP_VERSION } from '#lib/version/codenames';
import {
  _resetDeviceCaps, buildDeviceCaps, CACHE_KEY, confirmsType, decodeQueries, deviceCaps, inSafeMode, isProbedBlock, MIME, noteDirectFailure, PROBE_VERSION,
  runDecodeQueries, SAFE_KEY, safeCaps, warmDeviceCaps, type DecodeQuery, type DeviceDeps, type ProbeEnv,
} from './devicecaps';

const O = { client: 'web' as const, appVersion: '3.1.0' };
/** a device that answers 'probably' for everything in `yes` (codec strings) and 'maybe' for bare containers */
const env = (yes: (m: string) => boolean, more: Partial<ProbeEnv> = {}): ProbeEnv => ({
  canPlayType: (m) => (yes(m) ? (/codecs=/.test(m) ? 'probably' : 'maybe') : ''),
  hdrDisplay: false,
  ...more,
});
const all = () => true;
/** decode answers: every query key passes unless `no` matches it */
const decoded = (no: (key: string) => boolean = () => false) => new Map([...decodeQueries().keys()].map((k) => [k, !no(k)]));
const withApi: Partial<ProbeEnv> = { decodingInfo: async () => ({ supported: true }) };
const codecs = (c: ReturnType<typeof buildDeviceCaps>) => c!.video.map((v) => v.codec);

describe('confirmsType', () => {
  it('a codec string needs probably, or maybe plus MediaSource; a bare container any answer', () => {
    expect(confirmsType({ canPlayType: () => 'probably' }, MIME.hevcMain)).toBe(true);
    expect(confirmsType({ canPlayType: () => 'maybe' }, MIME.hevcMain)).toBe(false);
    expect(confirmsType({ canPlayType: () => 'maybe', isTypeSupported: () => true }, MIME.hevcMain)).toBe(true);
    expect(confirmsType({ canPlayType: () => '', isTypeSupported: () => true }, MIME.hevcMain)).toBe(false); // MSE alone is not direct play
    expect(confirmsType({ canPlayType: () => 'maybe' }, 'video/mp4')).toBe(true);
    expect(confirmsType({ canPlayType: () => '' }, 'video/mp4')).toBe(false);
  });
  it('a throwing probe is no', () => {
    expect(confirmsType({ canPlayType: () => { throw new Error('x'); } }, 'video/mp4')).toBe(false);
    expect(confirmsType({ canPlayType: () => 'maybe', isTypeSupported: () => { throw new Error('x'); } }, MIME.av1)).toBe(false);
  });
});

describe('buildDeviceCaps', () => {
  it('without the decode API canPlayType decides and nothing gets a height cap', () => {
    const c = buildDeviceCaps(env(all), O, new Map())!;
    expect(c.client).toBe('web');
    expect(codecs(c)).toEqual(['h264', 'hevc', 'av1', 'vp9']);
    expect(c.video.every((v) => v.maxHeight === undefined)).toBe(true);
    expect(c.video[0]!.profiles).toEqual(['constrained baseline', 'baseline', 'main', 'high', 'high 10']);
    expect(c.video[1]).toMatchObject({ codec: 'hevc', profiles: ['main', 'main 10'], tags: ['hvc1', 'hev1'] });
    expect(c.audio).toEqual(['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3']);
    expect(c.containers).toEqual(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ts']);
    expect(c.subtitles).toEqual(['srt', 'ass', 'ssa', 'vtt']);
    expect(c.ranges).toEqual(['sdr']); // no HDR claim without a decode probe
  });

  it('claims only what the device confirms (a typical desktop browser without HEVC)', () => {
    const c = buildDeviceCaps(env((m) => !/hvc1|hev1|6E0033|ac-3|ec-3|quicktime|matroska|mp2t/.test(m)), O, new Map())!;
    expect(codecs(c)).toEqual(['h264', 'av1', 'vp9']);
    expect(c.video[0]!.profiles).not.toContain('high 10');
    expect(c.audio).toEqual(['aac', 'mp3', 'opus', 'flac', 'vorbis']);
    expect(c.containers).toEqual(['mp4', 'm4v', 'webm']);
  });

  it('Safari-like: hvc1 yes, hev1 no -> the tag condition keeps hev1 files off direct play', () => {
    const c = buildDeviceCaps(env((m) => !m.includes('hev1')), O, new Map())!;
    expect(c.video.find((v) => v.codec === 'hevc')!.tags).toEqual(['hvc1']);
  });

  it('with the decode API but no answer yet: HEVC, AV1, VP9 and surround audio are left out, H.264 has no cap yet', () => {
    const c = buildDeviceCaps(env(all, withApi), O, null)!;
    expect(codecs(c)).toEqual(['h264']);
    expect(c.video[0]!.maxHeight).toBeUndefined();
    expect(c.audio).not.toContain('ac3');
    expect(c.audio).not.toContain('eac3');
  });

  it('the decode probe sets the height cap: 2160 when 4K passes, 1080 when only HD does, not claimed when neither', () => {
    const c = buildDeviceCaps(env(all, withApi), O, decoded((k) => k.startsWith(MIME.hevcMain + '@2160') || k.startsWith(MIME.vp9)))!;
    expect(c.video.find((v) => v.codec === 'h264')!.maxHeight).toBe(2160);
    expect(c.video.find((v) => v.codec === 'hevc')!.maxHeight).toBe(1080);
    expect(c.video.find((v) => v.codec === 'av1')!.maxHeight).toBe(2160);
    expect(codecs(c)).not.toContain('vp9');
  });

  it('HEVC main 10 only when its own decode probe passes; AV1 only when 8 and 10 bit both do', () => {
    const c = buildDeviceCaps(env(all, withApi), O, decoded((k) => k.startsWith(MIME.hevcMain10 + '@') || k.startsWith(MIME.av1Ten + '@')))!;
    expect(c.video.find((v) => v.codec === 'hevc')!.profiles).toEqual(['main']);
    expect(codecs(c)).not.toContain('av1');
    expect(codecs(buildDeviceCaps(env((m) => m !== MIME.av1Ten), O, new Map()))).not.toContain('av1');
  });

  it('surround audio needs the 6-channel decode probe where the API exists', () => {
    const c = buildDeviceCaps(env(all, withApi), O, decoded((k) => k.startsWith(MIME.audio.eac3)))!;
    expect(c.audio).toContain('ac3');
    expect(c.audio).not.toContain('eac3');
  });

  it('HDR ranges need an HDR screen AND a passing 10-bit decode probe; Dolby Vision is never claimed', () => {
    const sdrScreen = buildDeviceCaps(env(all, withApi), O, decoded())!;
    expect(sdrScreen.ranges).toEqual(['sdr']);
    const hdr = buildDeviceCaps(env(all, { ...withApi, hdrDisplay: true }), O, decoded())!;
    expect(hdr.ranges).toEqual(['sdr', 'hdr10', 'hlg', 'hdr10plus']);
    const noHlg = buildDeviceCaps(env(all, { ...withApi, hdrDisplay: true }), O, decoded((k) => k.endsWith('@hdr:hlg')))!;
    expect(noHlg.ranges).toEqual(['sdr', 'hdr10', 'hdr10plus']);
    // no 10-bit codec claimed: nothing to show HDR with
    const eightBit = buildDeviceCaps(env((m) => !m.includes('hvc1.2') && !m.includes('av01')), { ...O }, decoded())!;
    expect(buildDeviceCaps({ ...env((m) => !m.includes('hvc1.2') && !m.includes('av01')), ...withApi, hdrDisplay: true }, O, decoded())!.ranges).toEqual(['sdr']);
    expect(eightBit.ranges).not.toContain('dovi');
  });

  it('a device that confirms nothing sends no block (the server keeps its fixed list)', () => {
    expect(buildDeviceCaps(env(() => false), O, new Map())).toBeNull();
  });

  it('the Tizen app is client tizen', () => {
    expect(buildDeviceCaps(env(all), { client: 'tizen', appVersion: '1.0.0' }, new Map())!.client).toBe('tizen');
  });
});

describe('runDecodeQueries', () => {
  it('asks every query once; a rejection is "not supported"', async () => {
    const seen: DecodeQuery[] = [];
    const res = await runDecodeQueries(env(all, { decodingInfo: async (q) => { seen.push(q); if (q.video?.contentType === MIME.vp9) throw new TypeError('bad'); return { supported: true }; } }));
    expect(seen).toHaveLength(decodeQueries().size);
    expect(res.get(`${MIME.vp9}@1080`)).toBe(false);
    expect(res.get(`${MIME.hevcMain}@2160`)).toBe(true);
    expect(seen.find((q) => q.audio)?.audio?.channels).toBe('6');
  });
  it('without the API: an empty map', async () => {
    expect((await runDecodeQueries(env(all))).size).toBe(0);
  });
});

describe('this device: cache, sync claims, safe mode', () => {
  let store: Map<string, string>;
  let now = 1_000_000;
  const deps = (over: Partial<DeviceDeps> = {}): DeviceDeps => ({
    env: env(all, withApi), ua: 'UA/1', now: () => now, tizen: false,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    ...over,
  });
  afterEach(() => _resetDeviceCaps());
  const fresh = (over: Partial<DeviceDeps> = {}) => { store ??= new Map(); _resetDeviceCaps(deps(over)); };

  it('before the probe answers: the conservative sync block; afterwards the probed one, cached for the user agent', async () => {
    store = new Map(); now = 1_000_000; fresh();
    expect(codecs(deviceCaps())).toEqual(['h264']);
    await warmDeviceCaps();
    expect(codecs(deviceCaps())).toEqual(['h264', 'hevc', 'av1', 'vp9']);
    expect(deviceCaps()!.appVersion).toBe(APP_VERSION);
    const saved = JSON.parse(store.get(CACHE_KEY)!);
    expect(saved).toMatchObject({ v: PROBE_VERSION, ua: 'UA/1', at: now });
    // next page load: straight from the cache, no decode call
    fresh({ env: env(all, { decodingInfo: async () => { throw new Error('must not run'); } }) });
    expect(codecs(deviceCaps())).toEqual(['h264', 'hevc', 'av1', 'vp9']);
  });

  it('another user agent, another probe version or an old entry probes again', async () => {
    store = new Map(); now = 1_000_000;
    store.set(CACHE_KEY, JSON.stringify({ v: PROBE_VERSION, ua: 'UA/0', at: now, caps: safeCaps(O) }));
    fresh();
    expect(codecs(deviceCaps())).toEqual(['h264']); // not the cached safe block of the other UA
    store.set(CACHE_KEY, JSON.stringify({ v: PROBE_VERSION - 1, ua: 'UA/1', at: now, caps: safeCaps(O) }));
    fresh();
    expect(deviceCaps()!.audio).toContain('opus');
    store.set(CACHE_KEY, JSON.stringify({ v: PROBE_VERSION, ua: 'UA/1', at: now - 8 * 86_400_000, caps: safeCaps(O) }));
    fresh();
    expect(deviceCaps()!.audio).toContain('opus');
  });

  it('after a failed direct play the device sends the safe profile for 30 days, until its user agent changes', () => {
    store = new Map(); now = 1_000_000; fresh();
    expect(inSafeMode()).toBe(false);
    noteDirectFailure();
    expect(inSafeMode()).toBe(true);
    expect(deviceCaps()).toEqual(safeCaps({ client: 'web', appVersion: APP_VERSION }));
    expect(deviceCaps()!.video[0]!.profiles).not.toContain('high 10');
    fresh({ ua: 'UA/2' });
    expect(inSafeMode()).toBe(false);
    fresh();
    now += 31 * 86_400_000;
    expect(inSafeMode()).toBe(false);
  });

  it('blocked storage: still probes, nothing remembered, nothing thrown', async () => {
    _resetDeviceCaps(deps({ storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined } }));
    noteDirectFailure();
    await warmDeviceCaps();
    expect(codecs(deviceCaps())).toContain('hevc');
  });

  it('no media element: null (server defaults)', () => {
    fresh({ env: null });
    expect(deviceCaps()).toBeNull();
  });

  it('Tizen app: client tizen; probed blocks are recognised', () => {
    store = new Map(); fresh({ tizen: true, env: env(all) });
    const c = deviceCaps()!;
    expect(c.client).toBe('tizen');
    expect(isProbedBlock(c)).toBe(true);
    expect(isProbedBlock({ client: 'webos' })).toBe(false);
    expect(isProbedBlock(null)).toBe(false);
    expect(store.get(SAFE_KEY)).toBeUndefined();
  });
});
