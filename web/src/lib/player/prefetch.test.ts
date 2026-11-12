// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// node test environment: the bits of a browser the module touches
const store = new Map<string, string>();
vi.stubGlobal('window', globalThis);
vi.stubGlobal('location', new URL('http://ff.test/'));
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
const lgCapsMock = vi.fn(() => null as unknown);
vi.mock('#lib/webos/caps', () => ({ appCaps: () => lgCapsMock() }));
const api = vi.fn();
let profile: string | null = 'p1';
vi.mock('#lib/api', () => ({ api: (...a: unknown[]) => api(...a), getActiveProfile: () => profile }));
vi.mock('$app/navigation', () => ({ preloadCode: () => Promise.resolve() }));
vi.mock('./hls', () => ({ loadHls: () => Promise.resolve() }));
const markPlayArt = vi.fn();
vi.mock('./transition', async (orig) => ({ ...(await orig<typeof import('./transition')>()), markPlayArt: (...a: unknown[]) => markPlayArt(...a) }));
const { prepareNext, releaseNext, takeNext, WARM_GRACE_MS, WARM_MAX_RESUME_TICKS } = await import('./prefetch');
const { HOLD_TIMEOUT_MS, holdPrefetch, playPrefetch, prefetchPlayback, takePrefetched, watchTarget, startSecond, _resetPrefetch, PREFETCH_TTL_MS } = await import('./prefetch');
const { firstPlaybackRequest, playbackInfoBody, bodyKey } = await import('./infobody');
const { entryFadeMs, playTransition } = await import('./transition');
const { prefs, DEFAULT_PREFS } = await import('#lib/stores');
const { serverCaps, capsFrom } = await import('#lib/capabilities');

/** the body the player sends on its first request (no saved quality, no stored estimate -> 4 Mbit/s, network) */
const playerBody = (itemId: string) => firstPlaybackRequest(itemId, DEFAULT_PREFS).body;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  api.mockReset(); _resetPrefetch(); profile = 'p1'; prefs.set({ ...DEFAULT_PREFS }); serverCaps.set(capsFrom(undefined));
  store.clear();
});
afterEach(() => vi.useRealTimers());

describe('prefetchPlayback / takePrefetched', () => {
  it('posts the body the player sends first', () => {
    api.mockResolvedValue({ playSessionId: 'x' });
    prefetchPlayback('m1');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/playback/info', { method: 'POST', body: { itemId: 'm1', maxBitrate: 4_000_000, reasonHint: 'network' } });
  });

  it('never prefetches when the server starts its transcode in playback info (playbackPrefetch=false, Plex)', () => {
    api.mockResolvedValue({ playSessionId: 'x' });
    serverCaps.set(capsFrom({ playbackPrefetch: false }));
    prefetchPlayback('m1');
    expect(api).not.toHaveBeenCalled();
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    serverCaps.set(capsFrom({}));
    prefetchPlayback('m1');
    expect(api).toHaveBeenCalledTimes(1); // absent = allowed (Jellyfin, older backends)
  });

  it('takePrefetched returns the promise once', async () => {
    api.mockResolvedValue({ playSessionId: 'x' });
    prefetchPlayback('m1');
    prefetchPlayback('m1'); // the same item again: no second request
    expect(api).toHaveBeenCalledTimes(1);
    const p = takePrefetched('m1', playerBody('m1'));
    expect(p).not.toBeNull();
    expect(await p).toEqual({ playSessionId: 'x' });
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
  });

  it('expired after 30 s', () => {
    vi.useFakeTimers();
    api.mockResolvedValue({});
    prefetchPlayback('m1');
    vi.advanceTimersByTime(PREFETCH_TTL_MS);
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
  });

  it('body mismatch → null', () => {
    api.mockResolvedValue({});
    prefetchPlayback('m1');
    expect(takePrefetched('m1', { ...playerBody('m1'), audioLang: 'jpn' })).toBeNull();
    prefetchPlayback('m2');
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull(); // other item
    profile = 'p2';
    expect(takePrefetched('m2', playerBody('m2'))).toBeNull(); // the profile switched in between
  });

  it('error drops the entry', async () => {
    api.mockRejectedValue(Object.assign(new Error('API 429'), { status: 429 }));
    prefetchPlayback('m1');
    await flush();
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    api.mockResolvedValue({});
    prefetchPlayback('m1'); // after an error a new hover asks again
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('503 server_busy drops the entry quietly; the player then asks itself and shows its busy state', async () => {
    api.mockRejectedValue(Object.assign(new Error('API 503'), { status: 503, body: { error: 'server_busy' } }));
    prefetchPlayback('m1');
    await flush();
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
  });

  it('a new item replaces the old entry (one in flight)', () => {
    api.mockReturnValue(new Promise(() => undefined));
    prefetchPlayback('m1'); prefetchPlayback('m2');
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    expect(takePrefetched('m2', playerBody('m2'))).not.toBeNull();
  });

  it('follows the saved quality, audio and start of the link', () => {
    api.mockResolvedValue({});
    prefs.set({ ...DEFAULT_PREFS, quality: 8_000_000, audioLang: 'ger' });
    prefetchPlayback('m1', { audio: 'eng', startSec: 90 });
    expect(api.mock.calls[0]![1].body).toEqual({ itemId: 'm1', startTicks: 900_000_000, maxBitrate: 8_000_000, reasonHint: 'manual', audioLang: 'eng' });
    expect(takePrefetched('m1', firstPlaybackRequest('m1', { quality: 8_000_000, audioLang: 'ger' }, 'eng', 90).body)).not.toBeNull();
  });
});

describe('holdPrefetch (the leaving player\'s stop report)', () => {
  it('a prefetch during the hold makes no request; after the stop settles it does', async () => {
    api.mockResolvedValue({});
    let settle!: () => void;
    holdPrefetch(new Promise<void>((r) => (settle = r)));
    prefetchPlayback('m1');
    await flush();
    expect(api).not.toHaveBeenCalled();
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    settle();
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(takePrefetched('m1', playerBody('m1'))).not.toBeNull();
  });

  it('clears a cached entry when the hold starts; a failed stop also releases it', async () => {
    api.mockResolvedValue({});
    prefetchPlayback('m1');
    holdPrefetch(Promise.reject(new Error('offline')));
    expect(takePrefetched('m1', playerBody('m1'))).toBeNull();
    await flush();
    prefetchPlayback('m1');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('a stop that never settles releases the hold after 4 s', async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({});
    holdPrefetch(new Promise(() => undefined));
    prefetchPlayback('m1');
    await vi.advanceTimersByTimeAsync(HOLD_TIMEOUT_MS - 100);
    expect(api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('a newer hold is not released by the timeout of an older one', async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({});
    holdPrefetch(new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(3000);
    holdPrefetch(new Promise(() => undefined)); // the next player left meanwhile
    prefetchPlayback('m1');
    await vi.advanceTimersByTimeAsync(1500); // the first hold timed out, the second still runs
    expect(api).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(api).toHaveBeenCalledTimes(1);
  });
});

describe('playPrefetch click', () => {
  /** minimal element: listeners, href, no scope (artwork null) */
  const fakeLink = (href: string) => {
    const on = new Map<string, (e: unknown) => void>();
    const node = { getAttribute: () => href, closest: () => null, addEventListener: (k: string, f: (e: unknown) => void) => on.set(k, f), removeEventListener: () => undefined };
    playPrefetch(node as unknown as HTMLElement);
    return (e: Partial<MouseEvent>) => on.get('click')!({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...e });
  };
  beforeEach(() => markPlayArt.mockReset());
  it('a plain click marks the artwork for the transition', () => {
    fakeLink('/watch/m1')({});
    expect(markPlayArt).toHaveBeenCalledTimes(1);
  });
  it('ctrl/meta/shift/middle clicks and prevented clicks do not', () => {
    const click = fakeLink('/watch/m1');
    for (const e of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }, { defaultPrevented: true }]) click(e);
    expect(markPlayArt).not.toHaveBeenCalled();
  });
});

describe('infobody', () => {
  it('player and prefetch bodies stay identical when appCaps is set', () => {
    const caps = { client: 'webos', appVersion: '1.0.0', containers: ['mp4'], video: [{ codec: 'h264', maxHeight: 2160 }], audio: ['aac'], subtitles: ['srt'] };
    lgCapsMock.mockReturnValue(caps);
    try {
      api.mockResolvedValue({ playSessionId: 'x' });
      prefetchPlayback('m1');
      const sent = (api.mock.calls[0][1] as { body: object }).body;
      const player = playbackInfoBody({ itemId: 'm1', bps: 4_000_000, hint: 'network', caps: lgCapsMock() as never });
      expect(sent).toHaveProperty('caps', caps);
      expect(bodyKey(sent)).toBe(bodyKey(player));
    } finally { lgCapsMock.mockReturnValue(null); }
  });
  it('drops undefined fields and asks for the original at Infinity', () => {
    expect(playbackInfoBody({ itemId: 'a', bps: Infinity, hint: 'network' })).toEqual({ itemId: 'a', reasonHint: 'network' });
    expect(playbackInfoBody({ itemId: 'a', bps: Infinity, hint: 'network' })).not.toHaveProperty('caps');
    const caps = { client: 'webos' as const, appVersion: '1.0.0', containers: ['mp4'], video: [{ codec: 'h264', maxHeight: 2160 }], audio: ['aac'], subtitles: ['srt'] };
    expect(playbackInfoBody({ itemId: 'a', bps: Infinity, hint: 'network', caps })).toEqual({ itemId: 'a', reasonHint: 'network', caps });
    expect(bodyKey({ b: 1, a: undefined, c: 2 })).toBe(bodyKey({ c: 2, b: 1 }));
  });
  it('uses the remembered bandwidth estimate for the first rung', () => {
    localStorage.setItem('ff_bw', JSON.stringify({ bps: 30_000_000, at: Date.now() }));
    expect(firstPlaybackRequest('a', DEFAULT_PREFS).body.maxBitrate).toBeGreaterThan(4_000_000);
  });
  it('Auto on a fast link asks for original (70% of the estimate, above the top rung), shared by prefetch and player', () => {
    localStorage.setItem('ff_bw', JSON.stringify({ bps: 100_000_000, at: Date.now() }));
    const fr = firstPlaybackRequest('a', DEFAULT_PREFS);
    expect(fr.body).toEqual({ itemId: 'a', maxBitrate: 70_000_000, reasonHint: 'network' });
    expect(fr.bps).toBe(70_000_000);
    api.mockResolvedValue({});
    prefetchPlayback('a');
    expect(api).toHaveBeenCalledWith('/api/playback/info', { method: 'POST', body: fr.body });
    expect(takePrefetched('a', fr.body)).not.toBeNull();
  });
  it('a slow link stays on the ladder', () => {
    localStorage.setItem('ff_bw', JSON.stringify({ bps: 10_000_000, at: Date.now() }));
    expect(firstPlaybackRequest('a', DEFAULT_PREFS).body.maxBitrate).toBe(4_000_000);
  });
});

describe('watchTarget', () => {
  it('reads player links only', () => {
    expect(watchTarget('/watch/abc?audio=jpn&t=42')).toEqual({ id: 'abc', audio: 'jpn', startSec: 42 });
    expect(watchTarget('/watch/abc')).toEqual({ id: 'abc', audio: undefined, startSec: undefined });
    expect(watchTarget('/item/abc')).toBeNull();
    expect(watchTarget(null)).toBeNull();
  });
  it('t=0 means "from the start" (the TV detail page Restart), a missing or bad t means "resume"', () => {
    expect(watchTarget('/watch/abc?t=0')).toEqual({ id: 'abc', audio: undefined, startSec: 0 });
    expect(startSecond('0')).toBe(0);
    expect(startSecond('42.7')).toBe(42);
    expect(startSecond(null)).toBeUndefined();
    expect(startSecond('')).toBeUndefined();
    expect(startSecond('-3')).toBeUndefined();
    expect(startSecond('abc')).toBeUndefined();
    expect(startSecond('90000')).toBeUndefined();
  });
});

describe('transition choice', () => {
  it('TV none, reduced motion or no API fade, else view transition', () => {
    // TV (spec 5.2): the same transition when the API exists, the fade without it, an instant swap with reduced motion
    expect(playTransition({ tv: true, reduced: false, hasApi: true })).toBe('view');
    expect(playTransition({ tv: true, reduced: false, hasApi: false })).toBe('fade');
    expect(playTransition({ tv: true, reduced: true, hasApi: true })).toBe('none');
    expect(playTransition({ tv: false, reduced: true, hasApi: true })).toBe('fade');
    expect(playTransition({ tv: false, reduced: false, hasApi: false })).toBe('fade');
    expect(playTransition({ tv: false, reduced: false, hasApi: true })).toBe('view');
  });
  it('TV in the reduced set (frame guard tripped): a plain crossfade, no artwork morph', () => {
    expect(playTransition({ tv: true, reduced: false, hasApi: true, level: 'reduced' })).toBe('crossfade');
    expect(playTransition({ tv: true, reduced: false, hasApi: true, level: 'full' })).toBe('view');
    expect(playTransition({ tv: true, reduced: false, hasApi: false, level: 'reduced' })).toBe('fade');
    expect(playTransition({ tv: true, reduced: true, hasApi: true, level: 'reduced' })).toBe('none');
    expect(playTransition({ tv: false, reduced: false, hasApi: true, level: 'reduced' })).toBe('view'); // desktop has no frame guard
  });
  it('entry fade: 0 during a view transition / on TV with reduced motion, 120 reduced, 200 otherwise', () => {
    expect(entryFadeMs({ tv: true, reduced: true, viewTransition: false })).toBe(0);
    expect(entryFadeMs({ tv: true, reduced: false, viewTransition: false })).toBe(200);
    expect(entryFadeMs({ tv: false, reduced: false, viewTransition: true })).toBe(0);
    expect(entryFadeMs({ tv: false, reduced: true, viewTransition: false })).toBe(120);
    expect(entryFadeMs({ tv: false, reduced: false, viewTransition: false })).toBe(200);
  });
});

describe('next episode: prepareNext / releaseNext / takeNext', () => {
  const hlsInfo = (over: object = {}) => ({ playSessionId: 'ps-next-0001', hlsUrl: '/media/Videos/n1/master.m3u8?PlaySessionId=ps-next-0001', resumeTicks: 0, ...over });
  let fetched: string[];
  let aborted: boolean;
  beforeEach(() => {
    fetched = []; aborted = false;
    vi.stubGlobal('fetch', vi.fn(async (u: URL, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => { aborted = true; });
      fetched.push(u.pathname);
      const text = u.pathname.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?x=1\n' : u.pathname.endsWith('main.m3u8') ? '#EXTM3U\n#EXTINF:3,\nhls1/main/0.ts?x=1\n' : '';
      return { text: async () => text, body: { cancel: async () => undefined } };
    }));
  });
  // (window / location stay stubbed for the whole file: no unstubAllGlobals here; each test stubs fetch again)
  const body = (id = 'n1') => playerBody(id);
  const stops = () => api.mock.calls.filter((c) => c[0] === '/api/playback/warm/stop');

  it('asks for the info and warms master, variant and the first segment; the player takes it once', async () => {
    api.mockResolvedValue(hlsInfo());
    prepareNext('n1', body(), { warm: true });
    prepareNext('n1', body(), { warm: true }); // same item again: nothing new
    await flush(); await flush(); await flush();
    expect(api.mock.calls.filter((c) => c[0] === '/api/playback/info')).toHaveLength(1);
    expect(fetched).toEqual(['/media/Videos/n1/master.m3u8', '/media/Videos/n1/main.m3u8', '/media/Videos/n1/hls1/main/0.ts']);
    const p = takeNext('n1', body());
    expect(await p).toMatchObject({ playSessionId: 'ps-next-0001' });
    expect(takeNext('n1', body())).toBeNull();
  });

  it('a bitrate the network moved meanwhile still matches; another item, audio or profile does not', async () => {
    api.mockResolvedValue(hlsInfo());
    prepareNext('n1', body(), { warm: false });
    expect(takeNext('n2', body('n2'))).toBeNull();
    expect(takeNext('n1', { ...body(), audioLang: 'jpn' })).toBeNull();
    profile = 'p2';
    expect(takeNext('n1', body())).toBeNull();
    profile = 'p1';
    expect(takeNext('n1', { ...body(), maxBitrate: 8_000_000 })).not.toBeNull();
  });

  it('released and not taken within the grace: aborted and the warmed transcode stopped', async () => {
    vi.useFakeTimers();
    api.mockImplementation(async (path: string) => (path === '/api/playback/info' ? hlsInfo() : { ok: true }));
    prepareNext('n1', body(), { warm: true });
    await vi.advanceTimersByTimeAsync(0);
    releaseNext();
    await vi.advanceTimersByTimeAsync(WARM_GRACE_MS - 1);
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toEqual([['/api/playback/warm/stop', { method: 'POST', body: { playSessionId: 'ps-next-0001' } }]]);
    expect(aborted).toBe(true);
    expect(takeNext('n1', body())).toBeNull();
  });

  it('taken within the grace: nothing is stopped', async () => {
    vi.useFakeTimers();
    api.mockImplementation(async () => hlsInfo());
    prepareNext('n1', body(), { warm: true });
    await vi.advanceTimersByTimeAsync(0);
    releaseNext();
    await vi.advanceTimersByTimeAsync(1000);
    expect(takeNext('n1', body())).not.toBeNull();
    await vi.advanceTimersByTimeAsync(PREFETCH_TTL_MS);
    expect(stops()).toHaveLength(0);
  });

  it('never taken: stopped after the prefetch lifetime even while the countdown still holds it', async () => {
    vi.useFakeTimers();
    api.mockImplementation(async (path: string) => (path === '/api/playback/info' ? hlsInfo() : { ok: true }));
    prepareNext('n1', body(), { warm: true });
    await vi.advanceTimersByTimeAsync(PREFETCH_TTL_MS);
    expect(stops()).toHaveLength(1);
  });

  it('no warm for a direct play, a resume point far in, or without warm; nothing to stop then', async () => {
    vi.useFakeTimers();
    for (const info of [hlsInfo({ directUrl: '/media/Videos/n1/stream?static=true' }), hlsInfo({ resumeTicks: WARM_MAX_RESUME_TICKS + 1 })]) {
      api.mockImplementation(async (path: string) => (path === '/api/playback/info' ? info : { ok: true }));
      prepareNext('n1', body(), { warm: true });
      await vi.advanceTimersByTimeAsync(PREFETCH_TTL_MS);
    }
    expect(fetched).toEqual([]);
    expect(stops()).toHaveLength(0);
  });

  it('Plex (playbackPrefetch=false): never prepared', () => {
    serverCaps.set(capsFrom({ playbackPrefetch: false }));
    prepareNext('n1', body(), { warm: true });
    expect(api).not.toHaveBeenCalled();
  });

  it('a 429 at the stream limit drops it; the player asks itself', async () => {
    api.mockRejectedValue(new Error('429'));
    prepareNext('n1', body(), { warm: true });
    await flush(); await flush();
    expect(takeNext('n1', body())).toBeNull();
    expect(fetched).toEqual([]);
  });

  it('a 503 server_busy for the next episode drops it without a warm-up or a stop; the current playback is untouched', async () => {
    api.mockRejectedValue(Object.assign(new Error('API 503'), { status: 503, body: { error: 'server_busy' } }));
    prepareNext('n1', body(), { warm: true });
    await flush(); await flush();
    expect(takeNext('n1', body())).toBeNull();
    expect(fetched).toEqual([]);
    expect(stops()).toHaveLength(0);
  });

  it('survives holdPrefetch of the episode that ends (the hold only concerns that title)', async () => {
    api.mockResolvedValue(hlsInfo());
    prepareNext('n1', body(), { warm: false });
    holdPrefetch(Promise.resolve());
    expect(takeNext('n1', body())).not.toBeNull();
  });
});

describe('the probe and the prefetch (same body as the player)', () => {
  it('a running decode probe is awaited (bounded) before the prefetch body is built, so the player body matches it', async () => {
    const dc = await import('./devicecaps');
    let answer: () => void = () => undefined;
    const gate = new Promise<void>((r) => { answer = r; });
    dc._resetDeviceCaps({
      env: { canPlayType: (m) => (/codecs=/.test(m) ? 'probably' : 'maybe'), hdrDisplay: false, decodingInfo: async () => { await gate; return { supported: true }; } },
      ua: 'UA/t', storage: null, now: () => Date.now(), tizen: false,
    });
    lgCapsMock.mockImplementation(() => dc.deviceCaps());
    try {
      api.mockResolvedValue({ playSessionId: 'x' });
      prefetchPlayback('m1');
      expect(api).not.toHaveBeenCalled(); // waits for the probe
      answer();
      await flush(); await flush(); await flush();
      expect(api).toHaveBeenCalledTimes(1);
      const sent = api.mock.calls[0]![1].body;
      expect(sent.caps.video.map((v: { codec: string }) => v.codec)).toContain('hevc'); // the probed block, not the sync one
      expect(takePrefetched('m1', playerBody('m1'))).not.toBeNull(); // the player builds the same body afterwards
    } finally {
      lgCapsMock.mockReset(); lgCapsMock.mockImplementation(() => null);
      dc._resetDeviceCaps();
    }
  });
});

describe('next episode: the tab closes', () => {
  it('pagehide stops an unused warm-up with a keepalive request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (u: URL) => ({ text: async () => (u.pathname.endsWith('master.m3u8') ? 'main.m3u8\n' : u.pathname.endsWith('main.m3u8') ? 'hls1/main/0.ts\n' : ''), body: { cancel: async () => undefined } }));
    vi.stubGlobal('fetch', fetchMock);
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal('addEventListener', (t: string, f: () => void) => { listeners[t] = f; });
    api.mockImplementation(async (path: string) => (path === '/api/playback/info' ? { playSessionId: 'ps-next-0002', hlsUrl: '/media/Videos/n1/master.m3u8', resumeTicks: 0 } : { ok: true }));
    prepareNext('n1', playerBody('n1'), { warm: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(typeof listeners.pagehide).toBe('function');
    listeners.pagehide!();
    expect(api.mock.calls.filter((c) => c[0] === '/api/playback/warm/stop')).toEqual([['/api/playback/warm/stop', { method: 'POST', body: { playSessionId: 'ps-next-0002' }, keepalive: true }]]);
  });
});
