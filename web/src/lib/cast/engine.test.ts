// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get, writable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, clearItemCache, primeItem, secToTicks, type Item } from '#lib/api';
import type { CastInfo, CastState } from '#lib/cast';
import { DEFAULT_PREFS, type Prefs } from '#lib/stores';
import { createCastEngine, ENDED_HIDE_MS, PROGRESS_MS, RENEW_BEFORE_MS, type CastSession, type EngineDeps, type PlayerHandoff } from './engine';

const T0 = 1_000_000;
const ci = (castId: string, over: Partial<CastInfo> = {}): CastInfo => ({
  castId, expiresAt: T0 + 60 * 60_000, playSessionId: `ps-${castId}`, mediaSourceId: `ms-${castId}`, runtimeTicks: secToTicks(1800), startTime: 0,
  contentUrl: `/media/c/${castId}/master.m3u8`, contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'T', subtitles: [], ...over,
});
const items: Record<string, Partial<Item>> = {
  ep2: { id: 'ep2', name: 'Second', type: 'Episode', seriesId: 's1', seriesName: 'Bright Valley', indexNumber: 2, parentIndexNumber: 1 },
  film: { id: 'film', name: 'Film', type: 'Movie' },
  other: { id: 'other', name: 'Other', type: 'Movie' },
};
const idle: CastState = { available: true, connected: true, deviceName: 'Wohnzimmer-TV', state: 'idle', currentTime: 0, duration: 0, paused: true, volume: 1, muted: false, loaded: false };
const playing = (over: Partial<CastState> = {}): CastState => ({ ...idle, state: 'playing', loaded: true, paused: false, currentTime: 60, duration: 1800, ...over });

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** fake deps: every api call recorded, a writable castState, manual timers, no DOM */
function setup(o: { prefs?: Partial<Prefs> } = {}) {
  const calls: Array<{ path: string; init: { method?: string; body?: any; keepalive?: boolean } }> = [];
  const order: string[] = [];
  let n = 0;
  /** answers of POST /api/cast/session (default: a fresh token c<n>) */
  const posts: Array<() => Promise<CastInfo>> = [];
  const api = vi.fn(async (path: string, init: { method?: string; body?: any; keepalive?: boolean } = {}) => {
    calls.push({ path, init });
    order.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/api/cast/session') { const next = posts.shift(); return next ? next() : ci(`n${++n}`); }
    return null;
  });
  const state = writable<CastState>({ ...idle });
  let subs = 0;
  const castState = { ...state, subscribe: (fn: (s: CastState) => void) => { subs++; const un = state.subscribe(fn); return () => { subs--; un(); }; } };
  const events = new Set<(e: 'session-start' | 'session-end' | 'media-end') => void>();
  const loads: Array<{ info: CastInfo; sub: number }> = [];
  let loadImpl: (info: CastInfo) => Promise<boolean> = async () => true;
  const cast = {
    castState,
    onCastEvent: vi.fn((fn: (e: 'session-start' | 'session-end' | 'media-end') => void) => { events.add(fn); return () => { events.delete(fn); }; }),
    loadOnCast: vi.fn(async (info: CastInfo, sub = -1) => { loads.push({ info, sub }); return loadImpl(info); }),
    castPlayPause: vi.fn(), castSeek: vi.fn(), castStop: vi.fn(), castSetSubtitle: vi.fn(),
  };
  let now = T0;
  let timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let tid = 0;
  const timerDeps = {
    set: vi.fn((fn: () => void, ms: number) => { const t = { fn, at: now + ms, id: ++tid }; timers.push(t); return t.id; }),
    clear: vi.fn((id: unknown) => { timers = timers.filter((t) => t.id !== id); }),
    now: () => now,
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
      await flush();
    }
    now = end;
  };
  const hides = new Set<() => void>();
  const toast = vi.fn();
  const item = vi.fn(async (id: string) => { const it = items[id]; if (!it) throw new Error('404'); return it as Item; });
  const deps: EngineDeps = {
    api: api as unknown as EngineDeps['api'], item, cast: cast as unknown as EngineDeps['cast'], air: vi.fn() as unknown as EngineDeps['air'],
    body: () => ({}) as HTMLElement,
    onPageHide: vi.fn((fn: () => void) => { hides.add(fn); return () => { hides.delete(fn); }; }),
    toast, prefs: () => ({ ...DEFAULT_PREFS, ...o.prefs }), timers: timerDeps,
  };
  const out = writable<CastSession | null>(null);
  const engine = createCastEngine(deps, out);
  return {
    engine, out, deps, calls, order, posts, api, state, cast, events, loads, toast, timers: timerDeps, hides, item,
    advance, subs: () => subs, pending: () => timers.length,
    setLoad: (f: (info: CastInfo) => Promise<boolean>) => { loadImpl = f; },
    emit: (e: 'session-start' | 'session-end' | 'media-end') => events.forEach((fn) => fn(e)),
    reports: () => calls.filter((c) => c.path.startsWith('/api/playback/')).map((c) => c.path.slice('/api/playback/'.length)),
    deletes: () => calls.filter((c) => c.init.method === 'DELETE').map((c) => c.path.slice('/api/cast/session/'.length)),
    tokenPosts: () => calls.filter((c) => c.path === '/api/cast/session'),
  };
}
type Env = ReturnType<typeof setup>;

const handoff = (over: Partial<PlayerHandoff> = {}): PlayerHandoff => ({
  kind: 'chromecast', itemId: 'film', title: 'Film', subtitle: '', isEpisode: false, position: 60, duration: 1800, paused: false,
  cast: ci('c1'), started: false, audioIndex: 1, subIndex: -1, maxBitrate: 8_000_000, sleepAfterEpisode: false, ...over,
});
/** adopted Chromecast session that already reported `start` */
async function playingSession(env: Env, over: Partial<PlayerHandoff> = {}) {
  env.state.set(playing());
  env.engine.adopt(handoff({ started: true, ...over }));
  await flush();
}

describe('cast engine: adopt (Chromecast)', () => {
  it('adopt mirrors the receiver and reports start once, progress every 10 s and on pause', async () => {
    const env = setup();
    env.engine.adopt(handoff());
    expect(get(env.out)).toMatchObject({ kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'film', title: 'Film', posterId: 'film', state: 'connecting', buffering: true });
    env.state.set(playing({ state: 'buffering' }));
    expect(env.reports()).toEqual([]);
    expect(get(env.out)).toMatchObject({ position: 60, duration: 1800, paused: false, buffering: true });
    env.state.set(playing({ currentTime: 61 }));
    expect(get(env.out)).toMatchObject({ position: 61, buffering: false, state: 'playing' });
    env.state.set(playing({ currentTime: 62 }));
    expect(env.reports()).toEqual(['start']);
    expect(env.calls[0]!.init.body).toEqual({ itemId: 'film', playSessionId: 'ps-c1', mediaSourceId: 'ms-c1', positionTicks: secToTicks(61), isPaused: false, audioIndex: 1, playMethod: 'Transcode' });
    await env.advance(PROGRESS_MS);
    expect(env.reports()).toEqual(['start', 'progress']);
    env.state.set(playing({ currentTime: 75, paused: true }));
    expect(env.reports()).toEqual(['start', 'progress', 'progress']);
    expect(env.calls[2]!.init.body).toMatchObject({ isPaused: true, positionTicks: secToTicks(75) });
    expect(get(env.out)?.paused).toBe(true);
  });

  it('adopt with started=true sends no second start', async () => {
    const env = setup();
    env.state.set({ ...playing(), deviceName: '' });
    env.engine.adopt(handoff({ started: true }));
    env.state.set({ ...playing({ currentTime: 70 }), deviceName: '' });
    expect(env.reports()).toEqual([]);
    expect(get(env.out)).toMatchObject({ state: 'playing', device: 'Chromecast', position: 70 });
  });

  it('a second adopt replaces the first without leaking listeners', async () => {
    const env = setup();
    env.engine.adopt(handoff());
    env.engine.adopt(handoff({ itemId: 'other', cast: ci('c2') }));
    expect(env.subs()).toBe(1);
    expect(env.events.size).toBe(1);
    expect(env.hides.size).toBe(1);
    expect(get(env.out)?.itemId).toBe('other');
  });

  it('AirPlay hand-offs are not adopted by the Chromecast engine', () => {
    const env = setup();
    env.engine.adopt(handoff({ kind: 'airplay' }));
    expect(get(env.out)).toBeNull();
    expect(get(env.engine.airState)).toBeNull();
  });

  it('playPause, seek, skip and subtitles drive the receiver; seek reports progress', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.playPause();
    expect(env.cast.castPlayPause).toHaveBeenCalledTimes(1);
    env.engine.seek(300);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(300);
    expect(get(env.out)?.position).toBe(300);
    expect(env.reports()).toEqual(['progress']);
    expect(env.calls.at(-1)!.init.body.positionTicks).toBe(secToTicks(300));
    env.engine.skip(-10);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(290);
    env.engine.skip(5000);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(1800);
    env.engine.seek(-5);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(0);
    env.engine.setSubtitle(2);
    expect(env.cast.castSetSubtitle).toHaveBeenLastCalledWith(2);
  });

  it('controls without a session do nothing', async () => {
    const env = setup();
    env.engine.playPause(); env.engine.seek(10); env.engine.skip(10); env.engine.setSubtitle(1); env.engine.reconnect(); env.engine.release();
    await env.engine.playOnTv('film');
    await env.engine.refresh();
    await env.engine.stop();
    await env.engine.next();
    expect(env.calls).toEqual([]);
    expect(env.cast.castPlayPause).not.toHaveBeenCalled();
    expect(env.cast.castSeek).not.toHaveBeenCalled();
    expect(env.cast.castStop).not.toHaveBeenCalled();
  });

  it('nothing is touched before adopt (no listeners, no timers)', () => {
    const env = setup();
    expect(env.subs()).toBe(0);
    expect(env.cast.onCastEvent).not.toHaveBeenCalled();
    expect(env.deps.onPageHide).not.toHaveBeenCalled();
    expect(env.timers.set).not.toHaveBeenCalled();
    expect(env.api).not.toHaveBeenCalled();
    expect(get(env.out)).toBeNull();
  });
});

describe('cast engine: playOnTv (Chromecast)', () => {
  it('playOnTv: stop for the old title, old token revoked, new token loaded, metadata from the item', async () => {
    const env = setup();
    await playingSession(env);
    const p = env.engine.playOnTv('ep2', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'connecting' });
    await p;
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/c1', 'POST /api/cast/session']);
    expect(env.calls[0]!.init.body).toMatchObject({ itemId: 'film', playSessionId: 'ps-c1' });
    expect(env.calls[2]!.init.body).toEqual({ itemId: 'ep2', startTicks: 0, maxBitrate: 8_000_000 });
    expect(env.loads).toEqual([{ info: expect.objectContaining({ castId: 'n1' }), sub: -1 }]);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', seriesId: 's1', posterId: 'ep2', isEpisode: true, title: 'Bright Valley', subtitle: 'S1:F2 Second', state: 'connecting', position: 0, duration: 1800 });
    // the receiver still reports the old title until it is loaded: no start yet, then start for the new token
    env.state.set(playing({ currentTime: 1 }));
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toEqual({ itemId: 'ep2', playSessionId: 'ps-n1', mediaSourceId: 'ms-n1', positionTicks: secToTicks(1), isPaused: false, audioIndex: undefined, playMethod: 'Transcode' });
    expect(get(env.out)?.state).toBe('playing');
  });

  it('playOnTv without startAt sends no startTicks (server resume position)', async () => {
    const env = setup({ prefs: { quality: 4_000_000 } });
    await playingSession(env, { maxBitrate: undefined });
    await env.engine.playOnTv('film');
    const body = env.tokenPosts()[0]!.init.body;
    expect('startTicks' in body ? body.startTicks : undefined).toBeUndefined();
    expect(body.maxBitrate).toBe(4_000_000); // no quality chosen in the player: the saved default
  });

  it('a receiver that keeps reporting the old title during the switch changes nothing', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p = env.engine.playOnTv('other', 0);
    await flush();
    env.state.set(playing({ currentTime: 900 }));
    expect(get(env.out)?.position).toBe(0);
    expect(env.reports()).toEqual(['stop']);
    load.resolve(true);
    await p;
    expect(env.reports()).toEqual(['stop']);
    env.state.set(playing({ currentTime: 1 })); // the receiver reports the loaded title
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(get(env.out)?.position).toBe(1);
  });

  it('last playOnTv wins', async () => {
    const env = setup();
    await playingSession(env);
    const a = deferred<CastInfo>(), b = deferred<CastInfo>();
    env.posts.push(() => a.promise, () => b.promise);
    const p1 = env.engine.playOnTv('film', 0);
    await flush(); // the first token request is in flight
    const p2 = env.engine.playOnTv('ep2', 0);
    await flush();
    b.resolve(ci('cB'));
    await flush();
    a.resolve(ci('cA'));
    await Promise.all([p1, p2]);
    env.state.set(playing({ currentTime: 2 }));
    expect(env.deletes()).toEqual(['c1', 'cA']);
    expect(env.loads.map((l) => l.info.castId)).toEqual(['cB']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley' });
    expect(env.reports().filter((r) => r === 'start')).toHaveLength(1);
    expect(env.calls.find((c) => c.path === '/api/playback/start')!.init.body.playSessionId).toBe('ps-cB');
  });

  it('a newer playOnTv while the older one loads on the receiver revokes the older token', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p1 = env.engine.playOnTv('film', 0);
    await flush();
    env.setLoad(async () => true);
    const p2 = env.engine.playOnTv('ep2', 0);
    load.resolve(true);
    await Promise.all([p1, p2]);
    expect(env.deletes()).toEqual(['c1', 'n1']);
    expect(env.loads.map((l) => l.info.castId)).toEqual(['n1', 'n2']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'connecting' });
  });

  it('a failed switch does not retry', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new ApiError(429, { error: 'max_streams', max: 2 })));
    await env.engine.playOnTv('ep2', 0);
    await env.advance(60_000);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.toast.mock.calls).toEqual([['error', 'Maximal 2 gleichzeitige Streams erlaubt.']]);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', state: 'reconnect' });
    expect(env.loads).toEqual([]);
  });

  it('token errors use the player texts (transcoding not allowed, other)', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new ApiError(403, { error: 'transcoding_disabled' })), () => Promise.reject(new Error('net')));
    await env.engine.playOnTv('ep2', 0);
    env.engine.reconnect();
    await flush();
    expect(env.toast.mock.calls.map((c) => c[1])).toEqual(['Chromecast braucht Transcoding – mit deiner Rolle nicht erlaubt.', 'Übertragung auf Chromecast fehlgeschlagen.']);
  });

  it('receiver load failure -> failed with toast', async () => {
    const env = setup();
    await playingSession(env);
    env.setLoad(async () => false);
    await env.engine.playOnTv('film', 0);
    expect(env.toast).toHaveBeenCalledWith('error', '„Film“ kann auf Wohnzimmer-TV nicht abgespielt werden.');
    expect(get(env.out)).toMatchObject({ itemId: 'film', state: 'failed' });
    expect(env.deletes()).toEqual(['c1', 'n1']); // the unusable token does not stay live
    env.state.set(playing({ currentTime: 5 }));
    expect(env.reports()).toEqual(['stop']);
  });

  it('reconnect() after a failed token retries exactly once', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new ApiError(429, { error: 'rate_limited' })));
    await env.engine.playOnTv('ep2', 30);
    env.engine.reconnect();
    env.engine.reconnect(); // a double tap while connecting does not ask twice
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
    expect(env.tokenPosts()[1]!.init.body).toEqual({ itemId: 'ep2', startTicks: secToTicks(30), maxBitrate: 8_000_000 });
    expect(get(env.out)?.state).toBe('connecting');
    env.engine.reconnect();
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
  });

  it('item metadata that cannot be loaded falls back to the cast info', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(async () => ci('cx', { title: 'Pilot', seriesName: 'Unknown Show' }));
    await env.engine.playOnTv('missing', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'missing', title: 'Unknown Show', subtitle: 'Pilot', isEpisode: true });
    env.posts.push(async () => ci('cy', { title: 'Movie X' }));
    await env.engine.playOnTv('missing2', 0);
    expect(get(env.out)).toMatchObject({ title: 'Movie X', subtitle: '', isEpisode: false });
  });

  it('session-end during playOnTv revokes the new token', async () => {
    const env = setup();
    await playingSession(env);
    const post = deferred<CastInfo>();
    env.posts.push(() => post.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    post.resolve(ci('cNew'));
    env.emit('session-end');
    await p;
    expect(env.deletes()).toEqual(['c1', 'cNew']);
    expect(get(env.out)).toBeNull();
    expect(env.loads).toEqual([]);
    expect(env.reports()).toEqual(['stop']);
  });

  it('session-end while the receiver loads: token revoked, no start, no toast', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    env.emit('session-end');
    load.resolve(false);
    await p;
    expect(env.deletes()).toEqual(['c1', 'n1']);
    expect(get(env.out)).toBeNull();
    expect(env.toast).not.toHaveBeenCalled();
    expect(env.reports()).toEqual(['stop']);
  });

  it('a token failure after the session ended stays silent', async () => {
    const env = setup();
    await playingSession(env);
    const post = deferred<CastInfo>();
    env.posts.push(() => post.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    env.emit('session-end');
    post.reject(new ApiError(429, {}));
    await p;
    expect(env.toast).not.toHaveBeenCalled();
    expect(get(env.out)).toBeNull();
  });

  it('media-end while a switch loads is ignored', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    env.emit('media-end');
    load.resolve(true);
    await p;
    expect(get(env.out)?.state).not.toBe('ended');
  });
});

describe('cast engine: session end, stop, pagehide (Chromecast)', () => {
  it('session-end: stop report, token revoked, session null', async () => {
    const env = setup();
    await playingSession(env);
    env.emit('session-start'); // unrelated events change nothing
    env.emit('session-end');
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['c1']);
    expect(get(env.out)).toBeNull();
    expect(env.subs()).toBe(0);
    expect(env.hides.size).toBe(0);
    expect(env.pending()).toBe(0);
    expect(env.cast.castStop).not.toHaveBeenCalled();
  });

  it('session-end before the receiver played sends no stop', async () => {
    const env = setup();
    env.engine.adopt(handoff());
    env.emit('session-end');
    await flush();
    expect(env.reports()).toEqual([]);
    expect(env.deletes()).toEqual(['c1']);
  });

  it('media-end: stop report at the end, ended, receiver stopped and bar gone after 5 s', async () => {
    const env = setup();
    await playingSession(env);
    env.emit('media-end');
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(1800));
    expect(env.deletes()).toEqual(['c1']);
    expect(get(env.out)).toMatchObject({ state: 'ended', position: 1800 });
    env.state.set(playing({ currentTime: 3 }));
    expect(env.reports()).toEqual(['stop']);
    await env.advance(ENDED_HIDE_MS - 1);
    expect(get(env.out)).not.toBeNull();
    await env.advance(1);
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    expect(env.pending()).toBe(0);
  });

  it('playOnTv after the end cancels the hide timer', async () => {
    const env = setup();
    await playingSession(env);
    env.emit('media-end');
    await flush();
    await env.engine.playOnTv('ep2', 0);
    await env.advance(ENDED_HIDE_MS);
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(get(env.out)?.itemId).toBe('ep2');
    expect(env.reports()).toEqual(['stop']); // no second stop for the finished title
  });

  it('stop(): stop report, revoke, castStop, null', async () => {
    const env = setup();
    await playingSession(env);
    await env.engine.stop();
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/c1']);
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    env.emit('session-end'); // the receiver's own end event after castStop
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.pending()).toBe(0);
  });

  it('pagehide: stop with keepalive, revoke, castStop', async () => {
    const env = setup();
    await playingSession(env);
    env.hides.forEach((fn) => fn());
    expect(env.reports()).toEqual(['stop']);
    const call = env.calls[0]!;
    expect(call.init.keepalive).toBe(true);
    expect(env.deletes()).toEqual(['c1']);
    expect(env.calls[1]!.init.keepalive).toBe(true);
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
  });

  it('renews the token 10 min before expiry', async () => {
    const env = setup();
    await playingSession(env, { cast: ci('c1', { expiresAt: T0 + RENEW_BEFORE_MS + 15_000 }) });
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(0);
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.tokenPosts()[0]!.init.body).toEqual({ itemId: 'film', startTicks: secToTicks(60), audioIndex: 1, maxBitrate: 8_000_000 });
    expect(env.deletes()).toEqual(['c1']);
    expect(env.loads).toEqual([{ info: expect.objectContaining({ castId: 'n1' }), sub: -1 }]);
    expect(get(env.out)).toMatchObject({ itemId: 'film', title: 'Film' });
    expect(env.item).not.toHaveBeenCalled();
  });

  it('refresh() takes a new audio track / quality and keeps the subtitle', async () => {
    const env = setup();
    await playingSession(env, { subIndex: 3 });
    await env.engine.refresh({ audioIndex: 2, maxBitrate: 2_000_000 });
    expect(env.tokenPosts()[0]!.init.body).toEqual({ itemId: 'film', startTicks: secToTicks(60), audioIndex: 2, maxBitrate: 2_000_000 });
    expect(env.loads[0]!.sub).toBe(3);
    env.state.set(playing({ currentTime: 61 }));
    expect(env.calls.find((c) => c.path === '/api/playback/start')!.init.body.audioIndex).toBe(2);
  });

  it('a failed refresh can be retried with reconnect()', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new Error('net')));
    await env.engine.refresh();
    expect(get(env.out)).toMatchObject({ state: 'reconnect', title: 'Film' });
    env.engine.reconnect();
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
    expect(env.tokenPosts()[1]!.init.body.startTicks).toBe(secToTicks(60));
  });

  it('release() clears a failed session without castStop', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.release(); // not failed: nothing happens
    expect(get(env.out)).not.toBeNull();
    env.setLoad(async () => false);
    await env.engine.playOnTv('film', 0);
    env.engine.release();
    expect(get(env.out)).toBeNull();
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(env.subs()).toBe(0);
    expect(env.pending()).toBe(0);
  });
});

describe('cast engine: failures of fire-and-forget requests', () => {
  it('a rejected report or revoke is swallowed', async () => {
    const env = setup();
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => { await record(path, init); throw new Error('offline'); });
    await playingSession(env);
    await env.engine.stop();
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['c1']);
  });

  it('adopting the same token again sends no stop and keeps it live', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.adopt(handoff({ started: true }));
    await flush();
    expect(env.calls).toEqual([]);
    expect(env.subs()).toBe(1);
  });

  it('adopting another token stops and revokes the previous one', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.adopt(handoff({ cast: ci('c2'), started: true }));
    await flush();
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/c1']);
  });
});

describe('castEngine (browser wiring)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearItemCache(); });

  it('uses the item cache, window pagehide, the app toast and real timers', async () => {
    vi.useFakeTimers();
    const added: Array<() => void> = [];
    const removed: Array<() => void> = [];
    vi.stubGlobal('window', { addEventListener: (_t: string, fn: () => void) => added.push(fn), removeEventListener: (_t: string, fn: () => void) => removed.push(fn) });
    vi.stubGlobal('location', { pathname: '/', href: '/' });
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      paths.push(path);
      if (path === '/api/items/ep9') return new Response(JSON.stringify({ item: { ...items.other, id: 'ep9', name: 'Fetched' } }));
      return new Response(path === '/api/cast/session' ? JSON.stringify(ci('b1')) : '');
    }));
    const { castEngine, castSession } = await import('./engine');
    const { toasts } = await import('#lib/ui/toast');
    primeItem({ ...items.film, id: 'film' } as Item);
    castEngine.adopt(handoff());
    expect(added).toHaveLength(1);
    expect(get(castSession)?.itemId).toBe('film');
    await castEngine.playOnTv('film', 0); // no Cast SDK here: the receiver cannot load it
    expect(get(castSession)).toMatchObject({ title: 'Film', state: 'failed' });
    expect(get(toasts).at(-1)).toMatchObject({ kind: 'error', message: '„Film“ kann auf Chromecast nicht abgespielt werden.' });
    await castEngine.refresh(); // no live token: nothing
    await vi.advanceTimersByTimeAsync(PROGRESS_MS);
    await castEngine.playOnTv('ep9', 0);
    expect(get(castSession)?.title).toBe('Fetched');
    added[0]!();
    expect(removed).toEqual([added[0]]);
    expect(get(castSession)).toBeNull();
    expect(paths).toContain('/api/items/ep9');
  });
});
