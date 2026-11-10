// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION } from '#lib/version/codenames';
import {
  _resetDeviceCaps, avoidedUntil, AVOID_KEY, AVOID_MS, buildDeviceCaps, CACHE_KEY, capsPending, capsSummary, confirmsType, measureChannelsWith, remeasureOutput, decodeQueries, deviceCaps, inSafeMode, isFormatFailure, isProbedBlock, MIME,
  noteDirectFailure, noteHlsFailure, outputChannels, withOutput, PROBE_VERSION, runDecodeQueries, SAFE_KEY, SAFE_MS, setStereoOnly, STEREO_KEY, stereoOnly, warmDeviceCaps, type DecodeQuery, type DeviceDeps, type ProbeEnv,
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
    expect(c.containers).toEqual(['mp4', 'm4v', 'webm', 'mov', 'mkv']); // never ts in a browser (only MSE plays it)
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

  it('browsers: MKV / MOV only on probably for a codec-qualified type, a bare maybe is not enough; Tizen keeps the bare check', () => {
    // Chromium: x-matroska -> maybe, x-matroska with avc1 -> probably
    const chromium = (strictMkv: boolean): ProbeEnv => ({
      canPlayType: (m) => (m === 'video/x-matroska' || m === 'video/quicktime' ? 'maybe' : m.startsWith('video/x-matroska;') ? (strictMkv ? 'probably' : 'maybe') : m.startsWith('video/quicktime;') ? '' : /codecs=/.test(m) ? 'probably' : 'maybe'),
      hdrDisplay: false,
    });
    expect(buildDeviceCaps(chromium(true), O, new Map())!.containers).toEqual(['mp4', 'm4v', 'webm', 'mkv']);
    expect(buildDeviceCaps(chromium(false), O, new Map())!.containers).toEqual(['mp4', 'm4v', 'webm']);
    expect(buildDeviceCaps(chromium(false), { client: 'tizen', appVersion: '1.0.0' }, new Map())!.containers).toEqual(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ts']);
  });

  it('H.264 High 10 needs its decode probe where the API exists (not claimed while it is pending)', () => {
    const high10 = `${MIME.h264[4]!.mime}@1080`;
    expect(buildDeviceCaps(env(all, withApi), O, decoded((k) => k === high10))!.video[0]!.profiles).not.toContain('high 10');
    expect(buildDeviceCaps(env(all, withApi), O, decoded())!.video[0]!.profiles).toContain('high 10');
    expect(buildDeviceCaps(env(all, withApi), O, null)!.video[0]!.profiles).not.toContain('high 10');
    expect(decodeQueries().has(high10)).toBe(true);
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

describe('isFormatFailure (what arms the 7-day fallback)', () => {
  it('a decode error, or any failure after metadata arrived, counts', () => {
    expect(isFormatFailure({ watchdog: false, code: 3, readyState: 0 })).toBe(true);
    expect(isFormatFailure({ watchdog: false, code: 4, readyState: 1 })).toBe(true);
    expect(isFormatFailure({ watchdog: true, readyState: 2 })).toBe(true);
  });
  it('an HTTP error / network failure before any metadata (code 4 or 2, readyState 0) or a slow watchdog does not', () => {
    expect(isFormatFailure({ watchdog: false, code: 4, readyState: 0 })).toBe(false);
    expect(isFormatFailure({ watchdog: false, code: 2, readyState: 0 })).toBe(false);
    expect(isFormatFailure({ watchdog: false, code: null, readyState: 0 })).toBe(false);
    expect(isFormatFailure({ watchdog: true, readyState: 0 })).toBe(false);
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
    store.set(CACHE_KEY, JSON.stringify({ v: PROBE_VERSION, ua: 'UA/0', at: now, caps: { ...buildDeviceCaps(env(all), O, new Map())!, audio: ['aac'] } }));
    fresh();
    expect(codecs(deviceCaps())).toEqual(['h264']); // not the cached block of the other UA
    store.set(CACHE_KEY, JSON.stringify({ v: PROBE_VERSION - 1, ua: 'UA/1', at: now, caps: { ...buildDeviceCaps(env(all), O, new Map())!, audio: ['aac'] } }));
    fresh();
    expect(deviceCaps()!.audio).toContain('opus');
    store.set(CACHE_KEY, JSON.stringify({ v: PROBE_VERSION, ua: 'UA/1', at: now - 8 * 86_400_000, caps: { ...buildDeviceCaps(env(all), O, new Map())!, audio: ['aac'] } }));
    fresh();
    expect(deviceCaps()!.audio).toContain('opus');
  });

  it('after a failed direct play the device sends no block (the old server browser list) for 7 days, until its user agent changes', () => {
    store = new Map(); now = 1_000_000; fresh();
    expect(inSafeMode()).toBe(false);
    noteDirectFailure();
    expect(inSafeMode()).toBe(true);
    expect(deviceCaps()).toBeNull();
    expect(capsPending()).toBeNull(); // nothing to wait for either
    expect(SAFE_MS).toBe(7 * 86_400_000);
    fresh({ ua: 'UA/2' });
    expect(inSafeMode()).toBe(false);
    fresh();
    now += 8 * 86_400_000;
    expect(inSafeMode()).toBe(false);
  });

  it('a new failure during the period does not restart it', () => {
    store = new Map(); now = 1_000_000; fresh();
    noteDirectFailure();
    now += 6 * 86_400_000;
    noteDirectFailure();
    expect(JSON.parse(store.get(SAFE_KEY)!).at).toBe(1_000_000);
    now += 2 * 86_400_000;
    expect(inSafeMode()).toBe(false);
  });

  it('the cache follows the screen: HDR on/off at probe time differs -> probe again', async () => {
    store = new Map(); now = 1_000_000;
    fresh({ env: env(all, { ...withApi, hdrDisplay: true }) });
    await warmDeviceCaps();
    expect(deviceCaps()!.ranges).toContain('hdr10');
    expect(JSON.parse(store.get(CACHE_KEY)!).hdr).toBe(true);
    fresh({ env: env(all, { ...withApi, hdrDisplay: false }) });
    expect(deviceCaps()!.ranges).toEqual(['sdr']); // not the cached HDR claims
    fresh({ env: env(all, { ...withApi, hdrDisplay: true }) });
    expect(deviceCaps()!.ranges).toContain('hdr10'); // same screen state: cache hit
  });

  it('capsPending waits (bounded) only while the probe runs', async () => {
    store = new Map(); now = 1_000_000;
    fresh({ env: env(all, { decodingInfo: () => new Promise(() => undefined) }) }); // never answers
    const t0 = Date.now();
    await capsPending(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    fresh();
    await capsPending();
    expect(capsPending()).toBeNull(); // probed: nothing to wait for
    fresh({ env: null });
    expect(capsPending()).toBeNull();
  });

  it('clients with their own caps (LG / Fire TV app): no probe starts and nothing is waited for; a browser is unchanged', async () => {
    store = new Map(); now = 1_000_000;
    const decodingInfo = vi.fn(async () => ({ supported: true }));
    fresh({ ownCaps: true, env: env(all, { decodingInfo }) });
    expect(capsPending()).toBeNull();
    await warmDeviceCaps();
    expect(decodingInfo).not.toHaveBeenCalled();
    expect(store.get(CACHE_KEY)).toBeUndefined();
    fresh({ ownCaps: false, env: env(all, { decodingInfo }) });
    const w = capsPending();
    expect(w).not.toBeNull();
    await w;
    expect(decodingInfo).toHaveBeenCalled();
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


// ---- Task 3: the HLS claim, the output channels, the avoid memory, the stereo choice ----
describe('hls claim (buildDeviceCaps)', () => {
  const mse = { isTypeSupported: () => true };
  const msQueries = (c: ReturnType<typeof decodeQueries>) => [...c].filter(([, q]) => q.type === 'media-source');
  /** every decode passes except the media-source queries `no` selects */
  const decodedExcept = (no: (q: DecodeQuery) => boolean) => decoded((k) => { const q = decodeQueries().get(k)!; return q.type === 'media-source' && no(q); });
  const full = env(all, { ...mse, ...withApi });

  it('asks media-source queries: HEVC at 1080p and eac3 / ac3 / aac at 6 channels', () => {
    const ms = msQueries(decodeQueries());
    expect(ms.filter(([, q]) => q.video).map(([, q]) => [q.video!.contentType, q.video!.height])).toEqual([[MIME.hevcMain, 1080]]);
    expect(ms.filter(([, q]) => q.audio).map(([, q]) => `${q.audio!.contentType}|${q.audio!.channels}`).sort()).toEqual([`${MIME.audio.aac}|6`, `${MIME.audio.ac3}|6`, `${MIME.audio.eac3}|6`].sort());
    expect(PROBE_VERSION).toBe(2);
  });

  it('hevc in streams needs MSE plus the media-source decode, and the file claim', () => {
    const c = buildDeviceCaps(full, O, decoded())!;
    expect(c.hls).toEqual({ video: ['h264', 'hevc'], audio: ['aac', 'ac3', 'eac3'], surround: ['eac3', 'ac3', 'aac'] });
    // the media-source HEVC decode fails: no hevc stream, although the file claim stands
    const noDec = buildDeviceCaps(full, O, decodedExcept((q) => Boolean(q.video)))!;
    expect(codecs(noDec)).toContain('hevc');
    expect(noDec.hls!.video).toEqual(['h264']);
    // MSE does not confirm hevc
    const noMse = buildDeviceCaps(env(all, { ...withApi, isTypeSupported: (m) => !/hvc1|hev1/.test(m) }), O, decoded())!;
    expect(noMse.hls!.video).toEqual(['h264']);
  });

  it('never claims hevc streams without hevc in video[]', () => {
    const c = buildDeviceCaps(env((m) => !/hvc1|hev1/.test(m), { ...mse, ...withApi }), O, decoded())!;
    expect(codecs(c)).not.toContain('hevc');
    expect(c.hls!.video).toEqual(['h264']);
  });

  it("'maybe' without MSE is not enough: no isTypeSupported, no hls block at all", () => {
    const maybe: ProbeEnv = { canPlayType: (m) => (/codecs=/.test(m) ? 'maybe' : 'maybe'), hdrDisplay: false, ...withApi };
    expect(buildDeviceCaps(maybe, O, decoded())?.hls).toBeUndefined();
    expect(buildDeviceCaps(env(all, withApi), O, decoded())!.hls).toBeUndefined();
    // MSE says no to everything: nothing to claim either
    expect(buildDeviceCaps(env(all, { ...withApi, isTypeSupported: () => false }), O, decoded())!.hls).toBeUndefined();
  });

  it('surround needs the 6-channel media-source query per codec', () => {
    const noEac3 = buildDeviceCaps(full, O, decodedExcept((q) => q.audio?.contentType === MIME.audio.eac3))!;
    expect(noEac3.hls!.surround).toEqual(['ac3', 'aac']);
    const none = buildDeviceCaps(full, O, decodedExcept((q) => Boolean(q.audio)))!;
    expect(none.hls!.surround).toEqual([]);
    expect(none.hls!.audio).toContain('eac3'); // stereo-capable inside HLS still
  });

  it('ac3 / eac3 in hls.audio only with audio[] and MSE; aac needs MSE', () => {
    const c = buildDeviceCaps(env((m) => !/ac-3|ec-3/.test(m), { ...mse, ...withApi }), O, decoded())!;
    expect(c.hls!.audio).toEqual(['aac']);
    expect(c.hls!.surround).toEqual(['aac']); // surround is a subset of hls.audio
    const noMseEac3 = buildDeviceCaps(env(all, { ...withApi, isTypeSupported: (m) => !/ec-3/.test(m) }), O, decoded())!;
    expect(noMseEac3.hls!.audio).toEqual(['aac', 'ac3']);
  });

  it('S6: the hls claim may rest on ManagedMediaSource (iPhone); the direct-play claims do not', () => {
    const managed = { ...withApi, hlsTypeSupported: () => true } as Partial<ProbeEnv>;
    const c = buildDeviceCaps(env(all, managed), O, decoded())!;
    expect(c.hls).toMatchObject({ video: ['h264', 'hevc'], surround: ['eac3', 'ac3', 'aac'] });
    // canPlayType 'maybe' still needs isTypeSupported for the file claims
    const maybe: ProbeEnv = { canPlayType: (m) => (/codecs=/.test(m) ? 'maybe' : 'maybe'), hdrDisplay: false, ...managed };
    expect(codecs(buildDeviceCaps(maybe, O, decoded())!)).toEqual([]);
    expect(buildDeviceCaps(maybe, O, decoded())!.hls!.video).toEqual(['h264']); // hevc also needs the file claim
  });

  it('while the decode probe is pending: no hls hevc and no surround; without the API MSE alone claims hevc but never surround', () => {
    const pending = buildDeviceCaps(full, O, null)!;
    expect(pending.hls!.video).toEqual(['h264']);
    expect(pending.hls!.surround).toEqual([]);
    const noApi = buildDeviceCaps(env(all, mse), O, new Map())!;
    expect(noApi.hls!.video).toEqual(['h264', 'hevc']);
    expect(noApi.hls!.surround).toEqual([]);
  });
});

describe('this device: output channels, stereo choice, avoid memory', () => {
  let store: Map<string, string>;
  let now = 1_000_000;
  const DAY = 86_400_000;
  const full = env(all, { isTypeSupported: () => true, ...withApi });
  const deps = (over: Partial<DeviceDeps> = {}): DeviceDeps => ({
    env: full, ua: 'UA/1', now: () => now, tizen: false, channels: () => 6, soundMode: () => false,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    ...over,
  });
  afterEach(() => _resetDeviceCaps());
  const fresh = async (over: Partial<DeviceDeps> = {}) => { _resetDeviceCaps(deps(over)); await warmDeviceCaps(); };
  const reset = () => { store = new Map(); now = 1_000_000; };

  it('before the asynchronous probe has answered: no hls hevc and no surround', () => {
    reset(); _resetDeviceCaps(deps());
    const c = deviceCaps()!;
    expect(c.hls?.video).toEqual(['h264']);
    expect(c.hls?.surround).toEqual([]);
  });

  it('audioChannels is the output channel count from 6 up, otherwise 2', async () => {
    reset();
    for (const [n, want] of [[6, 6], [8, 8], [2, 2], [4, 2], [1, 2], [32, 16]] as const) {
      await fresh({ channels: () => n });
      expect(deviceCaps()!.audioChannels).toBe(want);
    }
  });

  it('the output is measured once and again after a devicechange (the measure is cached per page)', () => {
    reset(); let n = 2, calls = 0;
    _resetDeviceCaps(deps({ channels: () => { calls++; return n; } }));
    expect(outputChannels()).toBe(2); n = 6;
    expect(outputChannels()).toBe(2); expect(calls).toBe(1);
  });

  it('Tizen: audioChannels 6 when hls.surround is not empty, else 2', async () => {
    reset();
    await fresh({ tizen: true, channels: () => 2 });
    expect(deviceCaps()).toMatchObject({ client: 'tizen', audioChannels: 6 });
    store.clear();
    await fresh({ tizen: true, channels: () => 2, env: env(all, { isTypeSupported: () => true, decodingInfo: async (q) => ({ supported: !q.audio || q.type === 'file' }) }) });
    expect(deviceCaps()!.hls!.surround).toEqual([]);
    expect(deviceCaps()!.audioChannels).toBe(2);
  });

  it('withOutput (LG / Fire TV blocks): the TV states 6 from its claim, the switch and the avoid memory narrow it, no claim states nothing', () => {
    reset(); _resetDeviceCaps(deps({ channels: () => 2 }));
    const tv = { client: 'webos' as const, appVersion: '1', containers: [], video: [], audio: [], subtitles: [], audioChannels: 6,
      hls: { video: ['h264', 'hevc'] as ('h264' | 'hevc')[], audio: ['eac3' as const], surround: ['eac3' as const] } };
    expect(withOutput(tv)).toMatchObject({ audioChannels: 6, hls: { video: ['h264', 'hevc'], surround: ['eac3'] } });
    setStereoOnly(true);
    expect(withOutput(tv)).toMatchObject({ audioChannels: 2, hls: { surround: [] } });
    setStereoOnly(false);
    noteHlsFailure('hevc');
    expect(withOutput(tv).hls!.video).toEqual(['h264']);
    const { hls: _h, audioChannels: _a, ...bare } = tv;
    expect('audioChannels' in withOutput(bare)).toBe(false);
  });

  it('the stereo choice or a sound mode gives audioChannels 2 and surround []', async () => {
    reset(); await fresh();
    expect(deviceCaps()).toMatchObject({ audioChannels: 6, hls: { surround: ['eac3', 'ac3', 'aac'] } });
    setStereoOnly(true);
    expect(store.get(STEREO_KEY)).toBe('1'); expect(stereoOnly()).toBe(true);
    expect(deviceCaps()).toMatchObject({ audioChannels: 2, hls: { surround: [] } });
    expect(deviceCaps()!.hls!.video).toContain('hevc'); // only the sound narrows
    setStereoOnly(false);
    expect(store.has(STEREO_KEY)).toBe(false);
    expect(deviceCaps()!.audioChannels).toBe(6);
    await fresh({ soundMode: () => true });
    expect(deviceCaps()).toMatchObject({ audioChannels: 2, hls: { surround: [] } });
  });

  it('noteHlsFailure hevc removes hevc for 30 days; a user agent change resets it', async () => {
    reset(); await fresh();
    expect(avoidedUntil()).toEqual({});
    noteHlsFailure('hevc');
    expect(JSON.parse(store.get(AVOID_KEY)!)).toEqual({ ua: 'UA/1', hevc: now });
    expect(avoidedUntil()).toEqual({ hevc: now + 30 * DAY });
    expect(AVOID_MS).toBe(30 * DAY);
    expect(deviceCaps()!.hls!.video).toEqual(['h264']);
    expect(deviceCaps()!.hls!.surround).toEqual(['eac3', 'ac3', 'aac']);
    expect(codecs(deviceCaps())).toContain('hevc'); // direct play is not touched
    now += 29 * DAY; expect(deviceCaps()!.hls!.video).not.toContain('hevc');
    now += 2 * DAY; expect(deviceCaps()!.hls!.video).toContain('hevc'); expect(avoidedUntil()).toEqual({});
    now = 1_000_000; noteHlsFailure('hevc');
    await fresh({ ua: 'UA/2' });
    // a new user agent has its own (empty) cache and no memory
    expect(avoidedUntil()).toEqual({});
  });

  it('noteHlsFailure surround empties surround; both does both; the second note keeps the other one', async () => {
    reset(); await fresh();
    noteHlsFailure('surround');
    expect(deviceCaps()).toMatchObject({ hls: { video: ['h264', 'hevc'], surround: [] } });
    expect(Object.keys(avoidedUntil())).toEqual(['surround']);
    now += DAY; noteHlsFailure('hevc');
    expect(Object.keys(avoidedUntil()).sort()).toEqual(['hevc', 'surround']);
    reset(); await fresh(); noteHlsFailure('both');
    expect(deviceCaps()).toMatchObject({ hls: { video: ['h264'], surround: [] } });
  });

  it('S2: with blocked storage the failure is still honoured for this page', async () => {
    reset(); await fresh();
    const blocked = { getItem: () => null, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    _resetDeviceCaps(deps({ storage: blocked })); await warmDeviceCaps();
    expect(deviceCaps()!.hls!.video).toContain('hevc');
    noteHlsFailure('hevc');
    expect(deviceCaps()!.hls!.video).toEqual(['h264']);
    expect(avoidedUntil()).toEqual({ hevc: now + 30 * DAY });
    now += 31 * DAY; expect(avoidedUntil()).toEqual({});
  });

  it('S5: remeasureOutput forgets the measured count', () => {
    reset(); let n = 2;
    _resetDeviceCaps(deps({ channels: () => n }));
    expect(outputChannels()).toBe(2); n = 6;
    expect(outputChannels()).toBe(2);
    remeasureOutput();
    expect(outputChannels()).toBe(6);
  });

  it('N5: a devicechange measures again; the measurement tolerates a missing close() and a throwing constructor', () => {
    reset(); let n = 2; const fire: Array<() => void> = [];
    _resetDeviceCaps(deps({ channels: () => n, mediaDevices: { addEventListener: (_t: string, f: () => void) => void fire.push(f) } }));
    expect(outputChannels()).toBe(2); n = 6;
    expect(outputChannels()).toBe(2);
    fire.forEach((f) => f());
    expect(outputChannels()).toBe(6);
    class NoClose { destination = { maxChannelCount: 8 }; }
    expect(measureChannelsWith(NoClose as never)).toBe(8);
    class Throws { constructor() { throw new Error('no audio'); } }
    expect(() => measureChannelsWith(Throws as never)).toThrow();
    _resetDeviceCaps(deps({ channels: undefined }));
    expect(measureChannelsWith(undefined)).toBe(2);
  });

  it('PROBE_VERSION 2 discards a version-1 cache', async () => {
    reset();
    store.set(CACHE_KEY, JSON.stringify({ v: 1, ua: 'UA/1', at: now, caps: { ...buildDeviceCaps(env(all), O, new Map())!, audio: ['aac'] } }));
    await fresh();
    expect(deviceCaps()!.audio).toContain('opus');
    expect(JSON.parse(store.get(CACHE_KEY)!).v).toBe(2);
  });

  it('capsSummary: abilities before the stereo choice, the choice, the mode, the avoid memory', async () => {
    reset(); await fresh();
    expect(capsSummary()).toEqual({ hevcFiles: true, hevcStreams: true, surround: ['eac3', 'ac3', 'aac'], channels: 6, stereoChoice: false, soundMode: false, avoided: {} });
    setStereoOnly(true); noteHlsFailure('hevc');
    expect(capsSummary()).toEqual({ hevcFiles: true, hevcStreams: true, surround: ['eac3', 'ac3', 'aac'], channels: 6, stereoChoice: true, soundMode: false, avoided: { hevc: now + 30 * DAY } });
    await fresh({ channels: () => 2 });
    expect(capsSummary().channels).toBe(2);
  });
});
