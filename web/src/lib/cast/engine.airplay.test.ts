// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get, writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, secToTicks, type Item } from '#lib/api';
import type { CastInfo } from '#lib/cast';
import { tr } from '#lib/i18n';
import { ARM_MS, CONNECT_TIMEOUT_MS, createAirPlay, SETTLE_MS, WIRELESS_EVENT, WIRELESS_OFF_GRACE_MS, type AirPlayTimers, type AirPlayVideo } from '#lib/player/airplay';
import { clearAirLog, readAirLog, srcKind } from '#lib/player/airplayLog';
import { DEFAULT_PREFS } from '#lib/stores';
import { episodesBeforeAsk, noteInteraction } from '#lib/stillwatching';
import { SUBS_REFUSED_KEY } from './airsubs';
import { joinedAsk } from './joined';
import { CAST_VIDEO_ATTR, createCastEngine, ENDED_HIDE_MS, ENDED_IDLE_MS, PROGRESS_MS, type CastSession, type EngineDeps, type PlayerHandoff } from './engine';

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

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** `document.body` stand-in: records the elements appended to it */
class FakeBody {
  children: FakeVideo[] = [];
  appendChild = vi.fn((el: FakeVideo) => { el.parent?.drop(el); el.parent = this; this.children.push(el); return el; });
  drop(el: FakeVideo) { this.children = this.children.filter((c) => c !== el); }
}
/** a <video> stand-in: media and AirPlay events are simulated by dispatching them */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = false;
  duration = Number.NaN;
  ended = false;
  error: { code: number; message: string } | null = null;
  src = 'blob:hlsjs';
  parent: FakeBody | null = { drop: () => undefined } as unknown as FakeBody; // inside the Player's stage
  attrs = new Map<string, string>();
  webkitCurrentPlaybackTargetIsWireless = false;
  webkitShowPlaybackTargetPicker = vi.fn();
  play = vi.fn(async () => { if (!this.paused) return; this.paused = false; this.fire('play'); });
  pause = vi.fn(() => { if (this.paused) return; this.paused = true; this.fire('pause'); });
  load = vi.fn();
  remove = vi.fn(() => { this.parent?.drop(this); this.parent = null; });
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); if (n === 'src') this.src = ''; }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  fire(type: string) { this.dispatchEvent(new Event(type)); }
  wireless(on: boolean) { this.webkitCurrentPlaybackTargetIsWireless = on; this.fire(WIRELESS_EVENT); }
}

/** the stream probe and the variant fallback fetch the token's playlists: 404 (no network in unit tests) */
const probeFetch = vi.fn(async (_u: string, _o?: unknown) => new Response('', { status: 404 }));
beforeEach(() => { probeFetch.mockClear(); vi.stubGlobal('fetch', probeFetch); });
afterEach(() => { vi.unstubAllGlobals(); clearAirLog(); });

/** fake deps (api, manual timers, a fake body) and an AirPlay controller playing on the TV, as the Player hands it over */
/** `at`: where the Player put its token (and the TV is held: the position guard) */
async function setup(o: { started?: boolean; first?: Partial<CastInfo>; continuous?: boolean; at?: number } = {}) {
  const calls: Array<{ path: string; init: { method?: string; body?: any; keepalive?: boolean } }> = [];
  const order: string[] = [];
  let n = 0;
  const posts: Array<() => Promise<CastInfo>> = [];
  const api = vi.fn(async (path: string, init: { method?: string; body?: any; keepalive?: boolean } = {}) => {
    calls.push({ path, init });
    order.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/api/cast/session') { const next = posts.shift(); return next ? next() : ci(`n${++n}`); }
    if (path === '/api/items/ep1/next') return { item: items.ep2 };
    return null;
  });
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
  const wakes = new Set<() => void>();
  /** the title's segments (GET /api/items/{id}/segments as the engine gets them) */
  const segs: Record<string, Array<{ type: string; start: number; end: number }>> = {};
  let hiddenNow = false;
  const toast = vi.fn();
  const body = new FakeBody();
  const store = new Map<string, string>();
  const deps: EngineDeps = {
    profileName: () => '', formFactor: () => 'computer', motion: () => true,
    api: api as unknown as EngineDeps['api'],
    item: vi.fn(async (id: string) => { const it = items[id]; if (!it) throw new Error('404'); return it as Item; }),
    cast: { castState: writable({}), onCastEvent: vi.fn(), loadOnCast: vi.fn(), castPlayPause: vi.fn(), castSeek: vi.fn(), castStop: vi.fn(), castSetSubtitle: vi.fn(), queueOnCast: vi.fn(async () => null), castQueueRemove: vi.fn(), castQueueNext: vi.fn() } as unknown as EngineDeps['cast'],
    air: vi.fn() as unknown as EngineDeps['air'],
    body: () => body as unknown as HTMLElement,
    onPageHide: vi.fn((fn: () => void) => { hides.add(fn); return () => { hides.delete(fn); }; }),
    segments: vi.fn(async (id: string) => segs[id] ?? []), hidden: () => hiddenNow, onWake: vi.fn((fn: () => void) => { wakes.add(fn); return () => { wakes.delete(fn); }; }),
    toast, prefs: () => ({ ...DEFAULT_PREFS }), timers: timerDeps,
    ...(o.continuous ? { continuous: (f: { episode: boolean; autoplay: boolean; sleepAfter: boolean; maxEpisodes: number }) => (f.episode && f.autoplay && !f.sleepAfter ? { continuous: true as const, maxEpisodes: f.maxEpisodes } : {}) } : {}),
    onHidden: vi.fn(() => () => undefined), store: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => { store.delete(k); } }, digest: async () => '', log: vi.fn(), requestSession: vi.fn(async () => false), leave: vi.fn(), whenReady: vi.fn(), lock: vi.fn(async () => () => undefined), onRestore: vi.fn(),
  };
  const out = writable<CastSession | null>(null);
  const engine = createCastEngine(deps, out);

  // the Player's side: tap on the AirPlay button (token a1 on the element), the TV picked, settle window over
  const video = new FakeVideo();
  const probe = new FakeVideo();
  video.currentTime = o.at ?? 60;
  const player = { request: vi.fn(async () => ci('a1', o.first)), revoke: vi.fn(), detach: vi.fn(), started: vi.fn(), restore: vi.fn(), fail: vi.fn(), change: vi.fn() };
  const air = createAirPlay(video as unknown as AirPlayVideo, player, probe, timerDeps as unknown as AirPlayTimers);
  air.pick();
  await flush();
  video.wireless(true);
  await advance(SETTLE_MS);
  expect(air.state).toMatchObject({ active: true, error: false });
  const spy = {
    rebind: vi.spyOn(air, 'rebind'), pick: vi.spyOn(air, 'pick'), retry: vi.spyOn(air, 'retry'), refresh: vi.spyOn(air, 'refresh'),
    switchItem: vi.spyOn(air, 'switchItem'), destroy: vi.spyOn(air, 'destroy'), videoError: vi.spyOn(air, 'videoError'),
  };
  const handoff: PlayerHandoff = {
    kind: 'airplay', itemId: 'film', title: 'Film', subtitle: '', isEpisode: false, position: 60, duration: 1800, paused: false,
    cast: air.info!, started: o.started ?? true, audioIndex: 1, subIndex: -1, maxBitrate: 8_000_000, sleepAfterEpisode: false,
    video: video as unknown as HTMLVideoElement, air, probe: probe as unknown as HTMLVideoElement,
  };
  const srcBefore = video.src;
  return {
    cast_setSubtitleCalls: () => vi.mocked(deps.cast.castSetSubtitle).mock.calls.length,
    engine, out, deps, calls, order, posts, api, toast, hides, body, store, video, probe, air, player, spy, handoff, srcBefore,
    advance, segs, wakes, hide: (on: boolean) => { hiddenNow = on; }, wake: () => wakes.forEach((fn) => fn()), pending: () => timers.length,
    adopt: async (over: Partial<PlayerHandoff> = {}) => { engine.adopt({ ...handoff, ...over }); await flush(); },
    reports: () => calls.filter((c) => c.path.startsWith('/api/playback/')).map((c) => c.path.slice('/api/playback/'.length)),
    deletes: () => calls.filter((c) => c.init.method === 'DELETE').map((c) => c.path.slice('/api/cast/session/'.length)),
    tokenPosts: () => calls.filter((c) => c.path === '/api/cast/session'),
    engineLog: () => readAirLog().filter((e) => e.ev === 'engine').map((e) => e.note),
  };
}
type Env = Awaited<ReturnType<typeof setup>>;
/** sustained route loss: wireless off for longer than the grace */
async function routeLost(env: Env) {
  env.video.wireless(false);
  await env.advance(WIRELESS_OFF_GRACE_MS);
}

describe('cast engine: AirPlay adopt', () => {
  it('adopt moves the element into body unchanged and rebinds the controller', async () => {
    const env = await setup();
    await env.adopt();
    expect(env.body.children).toEqual([env.video, env.probe]);
    expect(env.body.appendChild).toHaveBeenCalledTimes(2);
    expect(env.video.src).toBe(env.srcBefore);
    expect(srcKind(env.video.src)).toBe('token');
    expect(env.video.getAttribute(CAST_VIDEO_ATTR)).toBe('');
    expect(CAST_VIDEO_ATTR).toBe('data-cast-engine');
    for (const el of [env.video, env.probe]) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.getAttribute('style')).toBe('position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none');
    }
    expect(env.probe.getAttribute(CAST_VIDEO_ATTR)).toBeNull();
    expect(env.spy.rebind).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toMatchObject({ kind: 'airplay', device: tr('player.castBar.airplayDevice'), itemId: 'film', title: 'Film', state: 'playing', position: 60 });
    expect(get(env.engine.airState)).toMatchObject({ active: true, error: false });
    expect(env.engineLog()).toEqual(['adopt']);
    expect(env.calls).toEqual([]);
  });

  it('an AirPlay hand-off without element and controller is ignored', async () => {
    const env = await setup();
    env.engine.adopt({ ...env.handoff, video: undefined, air: undefined });
    expect(get(env.out)).toBeNull();
    expect(env.spy.rebind).not.toHaveBeenCalled();
  });

  it('start on the first playing after the token, progress on pause / play and every 10 s, element mirrored', async () => {
    const env = await setup({ started: false });
    await env.adopt();
    expect(get(env.out)?.state).toBe('connecting');
    env.video.duration = 1790;
    env.video.fire('durationchange');
    env.video.fire('waiting');
    expect(get(env.out)).toMatchObject({ buffering: true, duration: 1790, position: 60 });
    env.video.currentTime = 62;
    env.video.fire('playing');
    expect(env.reports()).toEqual(['start']);
    expect(env.calls[0]!.init.body).toEqual({ itemId: 'film', playSessionId: 'ps-a1', mediaSourceId: 'ms-a1', positionTicks: secToTicks(62), isPaused: false, audioIndex: 1, playMethod: 'Transcode', via: 'airplay' });
    expect(get(env.out)).toMatchObject({ state: 'playing', buffering: false, position: 62 });
    env.video.fire('playing');
    env.video.currentTime = 70;
    env.video.fire('timeupdate');
    expect(get(env.out)?.position).toBe(70);
    expect(env.reports()).toEqual(['start']);
    env.engine.playPause();
    expect(env.video.pause).toHaveBeenCalledTimes(1);
    expect(env.reports()).toEqual(['start', 'progress']);
    expect(env.calls[1]!.init.body).toMatchObject({ isPaused: true, positionTicks: secToTicks(70) });
    env.engine.playPause();
    expect(env.video.play).toHaveBeenCalled();
    expect(env.reports()).toEqual(['start', 'progress', 'progress']);
    await env.advance(PROGRESS_MS);
    expect(env.reports()).toEqual(['start', 'progress', 'progress', 'progress']);
    env.engine.seek(300);
    expect(env.video.currentTime).toBe(300);
    expect(get(env.out)?.position).toBe(300);
    expect(env.reports().at(-1)).toBe('progress');
    env.engine.skip(5000);
    expect(env.video.currentTime).toBe(1790);
    env.engine.setSubtitle(2); // the receiver only shows tracks inside the stream
    expect(env.deps.cast.castSetSubtitle).not.toHaveBeenCalled();
    expect(env.deps.cast.castSeek).not.toHaveBeenCalled();
    expect(env.deps.cast.castPlayPause).not.toHaveBeenCalled();
  });
});

describe('cast engine: AirPlay change device', () => {
  it('pick() opens the picker of the controller the engine owns, synchronously', async () => {
    const env = await setup();
    await env.adopt({ audioTracks: [{ index: 1, title: 'Deutsch', isDefault: true }, { index: 2, title: 'English', isDefault: false }] });
    const before = env.video.webkitShowPlaybackTargetPicker.mock.calls.length;
    env.engine.pick();
    expect(env.spy.pick).toHaveBeenCalledTimes(1);
    expect(env.video.webkitShowPlaybackTargetPicker).toHaveBeenCalledTimes(before + 1);
    expect(get(env.out)?.audioTracks.map((a) => a.index)).toEqual([1, 2]);
  });

  it('pick() after the session ended does nothing', async () => {
    const env = await setup();
    await env.adopt();
    await env.engine.stop();
    env.engine.pick();
    expect(env.spy.pick).not.toHaveBeenCalled();
  });
});

describe('cast engine: AirPlay title switch', () => {
  it('airplay: switch sends stop for the old title and asks a token for the new item', async () => {
    const env = await setup();
    await env.adopt();
    await env.engine.playOnTv('ep2', 0);
    expect(env.order).toEqual(['POST /api/playback/stop', 'POST /api/cast/session', 'DELETE /api/cast/session/a1']);
    expect(env.tokenPosts()[0]!.init.body).toEqual({ itemId: 'ep2', startTicks: 0, audioIndex: undefined, maxBitrate: 8_000_000, via: 'airplay' });
    expect(env.spy.switchItem).toHaveBeenCalledWith(0);
    expect(env.video.src).toBe('/media/c/n1/master.m3u8');
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', isEpisode: true, state: 'connecting', position: 0 });
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'ep2', playSessionId: 'ps-n1' });
    expect(get(env.out)?.state).toBe('playing');
    expect(env.engineLog()).toEqual(['adopt', 'switch']);
  });

  it('airplay: last switch wins', async () => {
    const env = await setup();
    await env.adopt();
    const first = deferred<CastInfo>(), second = deferred<CastInfo>();
    env.posts.push(() => first.promise, () => second.promise);
    const p1 = env.engine.playOnTv('ep2', 0);
    await flush();
    expect(env.tokenPosts()).toHaveLength(1);
    const p2 = env.engine.playOnTv('other', 30);
    await flush();
    first.resolve(ci('x1'));
    await flush();
    expect(env.video.src).toBe('/media/c/x1/master.m3u8');
    env.video.fire('playing'); // the loser plays briefly: no start for it
    expect(env.reports()).toEqual(['stop']);
    expect(get(env.out)?.itemId).toBe('other');
    second.resolve(ci('n1'));
    await Promise.all([p1, p2]);
    expect(env.tokenPosts().map((c) => c.init.body.itemId)).toEqual(['ep2', 'other']);
    expect(env.tokenPosts()[1]!.init.body.startTicks).toBe(secToTicks(30));
    expect(env.deletes()).toEqual(['a1', 'x1']);
    expect(env.air.info?.castId).toBe('n1');
    expect(get(env.out)).toMatchObject({ itemId: 'other', title: 'Other', state: 'connecting' });
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'other', playSessionId: 'ps-n1' });
  });

  it('a failed switch: player toast, reconnect, no retry; a tap retries once', async () => {
    const env = await setup();
    await env.adopt();
    env.posts.push(() => Promise.reject(new ApiError(429, { error: 'max_streams', max: 2 })));
    await env.engine.playOnTv('ep2', 120);
    expect(env.toast).toHaveBeenCalledWith('error', tr('player.error.maxStreams', { n: 2 }));
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'reconnect', buffering: false, paused: true });
    // the old title's stop was reported: its token must not keep playing unreported on the TV
    expect(env.video.pause).toHaveBeenCalled();
    expect(env.video.paused).toBe(true);
    await env.advance(5 * 60_000);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.deletes()).toEqual([]);
    env.engine.reconnect();
    expect(env.spy.retry).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
    expect(env.tokenPosts()[1]!.init.body).toMatchObject({ itemId: 'ep2', startTicks: secToTicks(120) });
    expect(env.deletes()).toEqual(['a1']);
    env.video.fire('playing');
    expect(get(env.out)).toMatchObject({ state: 'playing', itemId: 'ep2' });
    expect(env.reports()).toEqual(['stop', 'start']);
  });

  it('item metadata that cannot be loaded falls back to the cast info', async () => {
    const env = await setup();
    await env.adopt();
    env.posts.push(async () => ci('n9', { title: 'Pilot', seriesName: 'Show' }));
    await env.engine.playOnTv('gone', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'gone', title: 'Show', subtitle: 'Pilot', posterId: 'gone', isEpisode: true });
  });

  it('a switch the controller does not take (busy elsewhere) leaves reconnect', async () => {
    const env = await setup();
    await env.adopt();
    env.spy.switchItem.mockResolvedValueOnce(undefined);
    await env.engine.playOnTv('ep2', 0);
    expect(env.tokenPosts()).toHaveLength(0);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'reconnect', buffering: false });
  });

  it('a switch the controller does not take pauses the old title (its stop is reported)', async () => {
    const env = await setup();
    await env.adopt();
    expect(env.video.paused).toBe(false);
    env.spy.switchItem.mockResolvedValueOnce(undefined);
    await env.engine.playOnTv('ep2', 0);
    expect(env.reports()).toEqual(['stop']);
    expect(env.video.pause).toHaveBeenCalled();
    expect(env.video.paused).toBe(true);
    expect(get(env.out)).toMatchObject({ state: 'reconnect', paused: true });
  });

  it('tap after a switch the controller did not take loads the remembered title', async () => {
    const env = await setup();
    await env.adopt();
    env.spy.switchItem.mockResolvedValueOnce(undefined);
    await env.engine.playOnTv('ep2', 0);
    expect(get(env.out)?.state).toBe('reconnect');
    env.engine.reconnect();
    expect(env.spy.switchItem).toHaveBeenCalledTimes(2);
    await flush();
    expect(env.tokenPosts().map((c) => c.init.body.itemId)).toEqual(['ep2']);
    expect(env.video.src).toBe('/media/c/n1/master.m3u8');
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'ep2', playSessionId: 'ps-n1' });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'playing' });
  });

  it('the same hand-off again keeps the element and the token', async () => {
    const env = await setup();
    await env.adopt();
    await env.adopt();
    expect(env.spy.destroy).not.toHaveBeenCalled();
    expect(env.calls).toEqual([]);
    expect(env.body.children).toEqual([env.video, env.probe]);
    expect(env.spy.rebind).toHaveBeenCalledTimes(2);
    expect(get(env.out)).toMatchObject({ kind: 'airplay', state: 'playing' });
  });

  it('other token errors use the AirPlay texts', async () => {
    const env = await setup();
    await env.adopt();
    env.posts.push(() => Promise.reject(new ApiError(403, { error: 'transcoding_disabled' })));
    await env.engine.playOnTv('ep2', 0);
    expect(env.toast).toHaveBeenLastCalledWith('error', tr('player.airplay.needsTranscode'));
  });

  it('refresh(): a new token for the same title with the new audio track', async () => {
    const env = await setup();
    await env.adopt();
    env.video.currentTime = 400;
    env.video.fire('timeupdate');
    await env.engine.refresh({ audioIndex: 3 });
    expect(env.spy.refresh).toHaveBeenCalledTimes(1);
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'film', audioIndex: 3, startTicks: secToTicks(400), via: 'airplay' });
    expect(env.deletes()).toEqual(['a1']);
    expect(get(env.out)?.title).toBe('Film');
  });

  it('a new token for the same title (audio switch) keeps the hand-off\'s subtitle list; another title takes its token\'s', async () => {
    const env = await setup();
    const subs = [{ index: 3, title: 'Deutsch (SDH)', language: 'deu' }];
    await env.adopt({ subtitles: subs });
    env.posts.push(async () => ci('r1', { subtitles: [] }));
    await env.engine.refresh({ audioIndex: 2 });
    expect(get(env.out)).toMatchObject({ subtitles: subs, audioIndex: 2 });
    env.posts.push(async () => ci('o1', { subtitles: [{ index: 7, title: 'English', language: 'eng', url: '/media/c/o1/7.vtt' }] }));
    await env.engine.playOnTv('other', 0);
    expect(get(env.out)?.subtitles).toEqual([{ index: 7, title: 'English', language: 'eng' }]);
  });

  it('a renewal keeps a paused TV paused', async () => {
    const env = await setup();
    env.posts.push(async () => ci('r1', { expiresAt: T0 + 9 * 60 * 60_000 }));
    await env.adopt({ cast: { ...env.air.info!, expiresAt: T0 + 5 * 60_000 } });
    env.engine.playPause();
    expect(env.video.paused).toBe(true);
    env.video.play.mockClear();
    await env.advance(PROGRESS_MS);
    expect(env.air.info?.castId).toBe('r1');
    expect(env.video.play).not.toHaveBeenCalled();
    expect(get(env.out)).toMatchObject({ state: 'playing', paused: true, buffering: false });
    const start = env.calls.filter((c) => c.path === '/api/playback/start').at(-1)!;
    expect(start.init.body).toMatchObject({ playSessionId: 'ps-r1', isPaused: true });
    env.engine.playPause(); // the bar's play button drives the new token
    expect(env.video.play).toHaveBeenCalledTimes(1);
  });

  it('renews the token before it expires', async () => {
    const env = await setup();
    env.posts.push(async () => ci('r1', { expiresAt: T0 + 9 * 60 * 60_000 }));
    await env.adopt({ cast: { ...env.air.info!, expiresAt: T0 + 5 * 60_000 } });
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.air.info?.castId).toBe('r1');
  });
});

describe('cast engine: AirPlay route loss and reconnect', () => {
  it('sustained route loss -> reconnect, paused, no cookie URL', async () => {
    const env = await setup();
    await env.adopt();
    env.video.currentTime = 300;
    env.video.fire('timeupdate');
    await routeLost(env);
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(300));
    expect(env.deletes()).toEqual(['a1']);
    expect(env.video.pause).toHaveBeenCalled();
    expect(srcKind(env.video.src)).not.toBe('cookie');
    expect(env.player.restore).not.toHaveBeenCalled();
    expect(get(env.out)).toMatchObject({ state: 'reconnect', position: 300, paused: true, buffering: false });
    expect(env.engineLog()).toEqual(['adopt', 'reconnect: route lost']);
    expect(env.deps.log).toHaveBeenCalledWith({ level: 'warn', tag: 'session', text: 'AirPlay route lost' }); // Diagnose counts it as a reconnect
  });

  it('reconnect() calls pick synchronously and resumes on active', async () => {
    const env = await setup();
    await env.adopt();
    env.video.currentTime = 300;
    env.video.fire('timeupdate');
    await routeLost(env);
    env.engine.reconnect();
    expect(env.spy.pick).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'film', startTicks: secToTicks(300), via: 'airplay' });
    expect(get(env.engine.airState)).toMatchObject({ ready: true, active: false });
    const pickerCalls = env.video.webkitShowPlaybackTargetPicker.mock.calls.length;
    env.engine.reconnect(); // the bar's second tap: the picker opens inside this gesture
    expect(env.video.webkitShowPlaybackTargetPicker).toHaveBeenCalledTimes(pickerCalls + 1);
    expect(env.tokenPosts()).toHaveLength(1);
    const plays = env.video.play.mock.calls.length;
    env.video.wireless(true);
    expect(env.video.play).toHaveBeenCalledTimes(plays + 1);
    expect(get(env.out)?.state).toBe('connecting');
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ playSessionId: 'ps-n1' });
    expect(get(env.out)?.state).toBe('playing');
    expect(env.engineLog()).toEqual(['adopt', 'reconnect: route lost', 'reconnect: tap', 'reconnect: tap']);
  });

  it('connect timeout turns the remote screen to reconnect', async () => {
    const env = await setup({ started: false }); // the TV was picked at setup's start, SETTLE_MS ago
    await env.adopt();
    expect(get(env.out)?.state).toBe('connecting');
    await env.advance(CONNECT_TIMEOUT_MS - SETTLE_MS - 1);
    expect(get(env.out)?.state).toBe('connecting');
    await env.advance(1);
    expect(get(env.out)).toMatchObject({ state: 'reconnect', buffering: false });
    expect(get(env.engine.airState)).toMatchObject({ active: true, connecting: false });
    expect(env.engineLog()).toEqual(['adopt', 'reconnect: connect timeout']);
    expect(env.deletes()).toEqual([]); // the token stays: a late start on the TV still counts
    env.video.fire('playing');
    expect(get(env.out)?.state).toBe('playing');
    expect(env.reports()).toEqual(['start']);
  });

  it('after a connect timeout, Neu verbinden and then a late start of the TV on its own: playing stays playing', async () => {
    const env = await setup({ started: false });
    await env.adopt();
    await env.advance(CONNECT_TIMEOUT_MS);
    expect(get(env.out)?.state).toBe('reconnect');
    env.engine.reconnect(); // the picker opens (the controller is active); the person closes it without a choice
    expect(env.spy.pick).toHaveBeenCalledOnce();
    env.video.fire('playing'); // the TV starts late, by itself
    expect(get(env.out)?.state).toBe('playing');
    env.probe.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'not-available' })); // any later state change
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'playing', buffering: false });
    expect(env.tokenPosts()).toEqual([]);
  });

  it('connect timeout while the TV already plays changes nothing', async () => {
    const env = await setup({ started: true });
    await env.adopt();
    await env.advance(CONNECT_TIMEOUT_MS);
    expect(get(env.out)?.state).toBe('playing');
    expect(env.engineLog()).toEqual(['adopt']);
  });

  it('reconnect() outside the reconnect state does nothing', async () => {
    const env = await setup();
    await env.adopt();
    env.engine.reconnect();
    expect(env.spy.pick).not.toHaveBeenCalled();
    expect(env.spy.retry).not.toHaveBeenCalled();
  });

  it('playOnTv without the route: reconnect, the item is remembered and loaded (server resume) on the tap', async () => {
    const env = await setup();
    await env.adopt();
    await routeLost(env);
    await env.engine.playOnTv('ep2');
    expect(env.tokenPosts()).toHaveLength(0);
    expect(env.spy.switchItem).not.toHaveBeenCalled();
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', state: 'reconnect' });
    env.posts.push(async () => ci('r1', { startTime: 754 }));
    env.engine.reconnect();
    expect(env.spy.pick).toHaveBeenCalledTimes(1);
    await flush();
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep2', startTicks: undefined, via: 'airplay' });
    expect(get(env.out)?.position).toBe(754);
    env.video.fire('loadedmetadata');
    expect(env.video.currentTime).toBe(754);
  });

  it('playOnTv during ready: the TV gets the new title once it is picked', async () => {
    const env = await setup();
    await env.adopt();
    await routeLost(env);
    env.engine.reconnect();
    await flush();
    expect(get(env.engine.airState)).toMatchObject({ ready: true, active: false });
    await env.engine.playOnTv('ep2', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'reconnect' });
    env.engine.reconnect(); // picker (ready)
    env.video.wireless(true); // the TV is picked: it first gets the ready token (film)
    await flush();
    expect(env.tokenPosts().map((c) => c.init.body.itemId)).toEqual(['film', 'ep2']);
    expect(env.video.src).toBe('/media/c/n2/master.m3u8');
    expect(env.deletes()).toEqual(['a1', 'n1']);
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.at(-1)!.init.body).toMatchObject({ itemId: 'ep2', playSessionId: 'ps-n2' });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'playing' });
  });

  it('a route loss after the end changes nothing', async () => {
    const env = await setup();
    await env.adopt();
    env.video.fire('ended');
    await routeLost(env);
    expect(get(env.out)?.state).toBe('ended');
  });
});

describe('cast engine: AirPlay end and stop', () => {
  it('report bodies carry via', async () => {
    const env = await setup({ started: false });
    await env.adopt();
    env.video.currentTime = 62;
    env.video.fire('playing');
    await env.advance(PROGRESS_MS);
    await env.engine.stop();
    const sent = env.calls.filter((c) => c.path.startsWith('/api/playback/'));
    expect(sent.map((c) => c.path)).toEqual(['/api/playback/start', '/api/playback/progress', '/api/playback/stop']);
    for (const c of sent) expect(c.init.body.via).toBe('airplay');
  });

  it('stop(): controller destroyed, src removed, element removed, null', async () => {
    const env = await setup();
    await env.adopt();
    await env.engine.stop();
    expect(env.reports()).toEqual(['stop']);
    expect(env.spy.destroy).toHaveBeenCalledTimes(1);
    expect(env.deletes()).toEqual(['a1']);
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/a1']);
    expect(env.video.getAttribute('src')).toBeNull();
    expect(env.video.src).toBe('');
    expect(env.video.load).toHaveBeenCalledTimes(1);
    expect(env.body.children).toEqual([]);
    expect(env.video.remove).toHaveBeenCalled();
    expect(env.probe.remove).toHaveBeenCalled();
    expect(get(env.out)).toBeNull();
    expect(get(env.engine.airState)).toBeNull();
    expect(env.pending()).toBe(0);
    expect(env.engineLog()).toEqual(['adopt', 'stop']);
    env.video.fire('playing');
    env.video.fire('pause');
    expect(env.reports()).toEqual(['stop']);
  });

  it('stop() while a switch waits for its token: the new token is revoked, no start', async () => {
    const env = await setup();
    await env.adopt();
    const late = deferred<CastInfo>();
    env.posts.push(() => late.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    await env.engine.stop();
    late.resolve(ci('x1'));
    await p;
    await flush();
    env.video.fire('playing');
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['a1', 'x1']);
    expect(get(env.out)).toBeNull();
  });

  it('ended element: stop report once', async () => {
    const env = await setup();
    await env.adopt();
    env.video.fire('ended');
    env.video.fire('ended');
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(1800));
    expect(get(env.out)).toMatchObject({ state: 'ended', position: 1800 });
    expect(env.deletes()).toEqual(['a1']); // revoked at the end, after its stop
    expect(env.order.slice(0, 2)).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/a1']);
    await env.advance(ENDED_HIDE_MS);
    expect(get(env.out)).toBeNull();
    expect(env.deletes()).toEqual(['a1']); // not a second time when the controller goes
    expect(env.body.children).toEqual([]);
    expect(env.reports()).toEqual(['stop']);
  });

  it('episode end: the next episode follows on the same element after the countdown', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.video.fire('ended');
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep2', label: 'S1:F2 · Second' } });
    expect(get(env.out)?.next?.startsAt).not.toBeNull();
    await env.advance(10_000);
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'ep2', via: 'airplay' });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
    expect(env.body.children).toContain(env.video);
  });

  it('cancelled next episode: token revoked at the end, session closed after ENDED_IDLE_MS, no second stop or revoke', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.video.fire('ended');
    await flush();
    expect(env.deletes()).toEqual(['a1']);
    env.engine.cancelNext();
    await env.advance(ENDED_IDLE_MS - 1);
    expect(get(env.out)?.state).toBe('ended');
    await env.advance(1);
    expect(get(env.out)).toBeNull();
    expect(env.body.children).toEqual([]);
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['a1']);
  });

  it('next() after a cancelled countdown: the ended token is not revoked again', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.video.fire('ended');
    await flush();
    env.engine.cancelNext();
    await env.engine.next();
    await flush();
    expect(env.air.info?.castId).toBe('n1');
    expect(env.deletes()).toEqual(['a1']);
  });

  it('a title switch after the end keeps the element', async () => {
    const env = await setup();
    await env.adopt();
    env.video.fire('ended');
    await env.engine.playOnTv('ep2', 0);
    await env.advance(ENDED_HIDE_MS);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
    expect(env.body.children).toContain(env.video);
  });

  it('pagehide still ends AirPlay', async () => {
    const env = await setup();
    await env.adopt();
    env.hides.forEach((fn) => fn());
    expect(env.calls.map((c) => [c.init.method, c.path, c.init.keepalive])).toEqual([
      ['POST', '/api/playback/stop', true], ['DELETE', '/api/cast/session/a1', true],
    ]);
    expect(env.spy.destroy).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    expect(env.hides.size).toBe(0);
    expect(env.deps.leave).not.toHaveBeenCalled(); // the Chromecast-only leave
    expect(env.store.size).toBe(0); // AirPlay never writes the resume hint
  });

  it('variant fallback failed on the TV: failed toast, failed state; release() drops the element', async () => {
    const env = await setup();
    await env.adopt();
    env.video.error = { code: 1, message: '' };
    env.video.fire('error'); // aborted: not a failure
    expect(env.spy.videoError).not.toHaveBeenCalled();
    env.video.error = { code: 4, message: '' };
    env.video.fire('error');
    expect(env.spy.videoError).toHaveBeenCalledWith(4, '');
    await flush();
    expect(env.toast).toHaveBeenCalledWith('error', tr('player.castBar.failed', { title: 'Film', device: tr('player.castBar.airplayDevice') }));
    expect(get(env.out)).toMatchObject({ state: 'failed' });
    expect(env.reports()).toEqual(['stop']);
    env.engine.release();
    expect(get(env.out)).toBeNull();
    expect(env.body.children).toEqual([]);
    await flush();
    expect(env.deletes()).toEqual(['a1']);
  });

  it('a Chromecast hand-off replaces the AirPlay session and drops its element', async () => {
    const env = await setup();
    await env.adopt();
    env.engine.adopt({ ...env.handoff, kind: 'chromecast', cast: ci('c9'), video: undefined, air: undefined, probe: undefined });
    await flush();
    expect(env.body.children).toEqual([]);
    expect(env.spy.destroy).toHaveBeenCalledTimes(1);
    expect(env.deletes()).toEqual(['a1']);
    expect(get(env.out)).toMatchObject({ kind: 'chromecast' });
  });
});

describe('cast engine: AirPlay next episode without a receiver queue', () => {
  it('ended while the page was hidden (locked phone): the next episode starts at once, no countdown nobody saw', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.hide(true);
    env.video.fire('ended');
    await flush();
    await env.advance(0);
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'ep2', via: 'airplay' });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
    expect(env.engineLog()).toContain('switch: ended while hidden');
  });

  it('an end the sleeping page never got as an event is found on wake and handled as a late one', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.wake(); // not ended: nothing
    expect(get(env.out)?.state).toBe('playing');
    env.video.ended = true;
    env.wake();
    await flush();
    await env.advance(0);
    expect(env.reports()).toEqual(['stop']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
  });

  it('credits: the countdown switches while the TV still plays (the AirPlay route never reaches the end of the media)', async () => {
    const env = await setup();
    await env.adopt({ itemId: 'ep1', isEpisode: true });
    env.video.duration = 1800;
    env.video.currentTime = 1780;
    env.video.fire('timeupdate');
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'playing', next: { itemId: 'ep2' } });
    await env.advance(10_000);
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'ep2', via: 'airplay' });
    expect(env.spy.switchItem).toHaveBeenCalled();
    expect(env.reports().at(-1)).toBe('stop'); // ep1's (after the 10 s progress)
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
  });
});

describe('cast engine: AirPlay subtitles inside the stream', () => {
  const subs = [{ index: 3, title: 'Deutsch (SDH)', language: 'deu' }];
  const bodies = (env: Env) => env.tokenPosts().map((c) => c.init.body as Record<string, unknown>);

  it('subtitle choice on AirPlay re-requests the stream with subtitleIndex at the current position', async () => {
    const env = await setup();
    await env.adopt({ subtitles: subs });
    env.video.currentTime = 400;
    env.video.fire('timeupdate');
    env.posts.push(async () => ci('s1', { hlsSub: true }));
    env.engine.setSubtitle(3);
    await flush();
    expect(env.cast_setSubtitleCalls()).toBe(0); // the receiver is the TV: nothing side-loaded
    expect(bodies(env)).toHaveLength(1);
    expect(bodies(env)[0]).toMatchObject({ via: 'airplay', subtitleIndex: 3, startTicks: secToTicks(400), itemId: 'film' });
    expect(get(env.out)).toMatchObject({ subIndex: 3 });
    expect(env.deletes()).toEqual(['a1']);
    expect(env.reports().filter((r) => r === 'stop')).toHaveLength(1);
    // off again: a new token without the key
    env.posts.push(async () => ci('s2'));
    env.engine.setSubtitle(-1);
    await flush();
    expect(bodies(env)).toHaveLength(2);
    expect('subtitleIndex' in bodies(env)[1]!).toBe(false);
  });

  it('an audio change keeps the chosen subtitle in the new token', async () => {
    const env = await setup();
    await env.adopt({ subtitles: subs });
    env.posts.push(async () => ci('s1', { hlsSub: true }));
    env.engine.setSubtitle(3);
    await flush();
    await env.engine.refresh({ audioIndex: 2 });
    expect(bodies(env)[1]).toMatchObject({ audioIndex: 2, subtitleIndex: 3, via: 'airplay' });
  });

  it('a server without the capability sends no subtitleIndex and does not re-request', async () => {
    const env = await setup();
    env.deps.subsInStream = () => false;
    await env.adopt({ subtitles: subs });
    env.engine.setSubtitle(3);
    await flush();
    expect(bodies(env)).toHaveLength(0);
    expect(get(env.out)?.subIndex).toBe(-1);
  });

  it('code 4 retries once without subtitles: toast, remembered for 30 days, subIndex off; a second code 4 never asks again', async () => {
    const env = await setup();
    await env.adopt({ subtitles: subs });
    env.posts.push(async () => ci('s1', { hlsSub: true }));
    env.engine.setSubtitle(3);
    await flush();
    expect(env.video.src).toContain('/s1/');
    env.posts.push(async () => ci('s2'));
    env.air.videoError(4);
    await flush(); await flush();
    expect(bodies(env)).toHaveLength(2);
    expect('subtitleIndex' in bodies(env)[1]!).toBe(false);
    expect(env.toast).toHaveBeenCalledWith('info', tr('player.castRemote.subsRefused'));
    expect(Number(env.store.get(SUBS_REFUSED_KEY))).toBeGreaterThanOrEqual(T0);
    expect(get(env.out)?.subIndex).toBe(-1);
    expect(env.video.src).toContain('/s2/');
    expect(env.reports().filter((r) => r === 'stop')).toHaveLength(1); // the hand-off's token only: s1 never started, so it owes none
    expect(env.deletes()).toEqual(['a1', 's1']);
    env.air.videoError(4);
    await flush(); await flush();
    expect(bodies(env)).toHaveLength(2);
  });

  it('a remembered refusal starts AirPlay without subtitles until picked again', async () => {
    const env = await setup();
    env.store.set(SUBS_REFUSED_KEY, String(T0 - 24 * 3600_000));
    await env.adopt({ subtitles: subs, subIndex: 3, cast: { ...env.handoff.cast, hlsSub: true } });
    await env.engine.refresh({ audioIndex: 2 });
    expect('subtitleIndex' in bodies(env)[0]!).toBe(false);
    env.engine.setSubtitle(3);
    await flush();
    expect(bodies(env)[1]).toMatchObject({ subtitleIndex: 3 });
    expect(env.store.has(SUBS_REFUSED_KEY)).toBe(false);
  });

  it('a refusal older than 30 days no longer counts', async () => {
    const env = await setup();
    env.store.set(SUBS_REFUSED_KEY, String(T0 - 31 * 24 * 3600_000));
    await env.adopt({ subtitles: subs, subIndex: 3, cast: { ...env.handoff.cast, hlsSub: true } });
    await env.engine.refresh({ audioIndex: 2 });
    expect(bodies(env)[0]).toMatchObject({ subtitleIndex: 3 });
  });

  it('adopt: a token that does not carry the rendition starts with subtitles off, one that does keeps the track', async () => {
    const a = await setup();
    await a.adopt({ subtitles: subs, subIndex: 3 });
    expect(get(a.out)?.subIndex).toBe(-1);
    const b = await setup();
    await b.adopt({ subtitles: subs, subIndex: 3, cast: { ...b.handoff.cast, hlsSub: true } });
    expect(get(b.out)?.subIndex).toBe(3);
  });

  it('a new token without the rendition (the server ignored the index) switches the chip off', async () => {
    const env = await setup();
    await env.adopt({ subtitles: subs });
    env.posts.push(async () => ci('s1')); // no hlsSub
    env.engine.setSubtitle(3);
    await flush();
    expect(get(env.out)?.subIndex).toBe(-1);
  });
});

describe('cast engine: continuous AirPlay (a joined stream)', () => {
  const E1 = { itemId: 'ep1', title: 'First', season: 1, episode: 1, start: 0, duration: 2832 };
  const E2 = { itemId: 'ep2', title: 'Second', season: 1, episode: 2, start: 2832, duration: 2700 };
  const E3 = { itemId: 'ep3', title: 'Third', season: 1, episode: 3, start: 5532, duration: 2600 };
  const J = { items: [E1, E2, E3], subtitles: false };
  /** the Player's joined token (episodes 1–3, the server's runtime is the joined total) at stream second 2900 = episode 2 at 68 s */
  async function joinedEnv(over: Partial<PlayerHandoff> = {}) {
    noteInteraction(); // the still-watching chain other tests ran up starts over (it caps maxEpisodes)
    const env = await setup({ started: false, continuous: true, first: { joined: J, runtimeTicks: secToTicks(8132) }, at: 2900 });
    // the Player hands over episode 1's metadata, the joined position and its element's (stale) duration
    await env.adopt({ itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', subtitle: 'S1:F1 First', isEpisode: true, position: 2900, duration: 1800, ...over });
    return env;
  }
  /** the TV plays (at the hand-over position: the position guard holds it there), then reaches stream second `at` */
  const playing = (env: Env, at: number) => { env.video.fire('playing'); env.video.currentTime = at; env.video.fire('timeupdate'); };

  it('the session shows the current episode', async () => {
    const env = await joinedEnv();
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', subtitle: 'S1:F2 Second', posterId: 'ep2', isEpisode: true, position: 68, duration: 2700, state: 'connecting',
      joined: { items: J.items, index: 1, streamPosition: 2900, streamDuration: 8132 } });
    env.video.duration = 1800; // the element may still report episode 1's length right after the token loaded
    env.video.fire('durationchange');
    expect(get(env.out)?.duration).toBe(2700);
    playing(env, 2950);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', position: 118, duration: 2700, state: 'playing', joined: { index: 1, streamPosition: 2950 } });
    env.video.currentTime = 5540; // the stream moved on into episode 3 by itself
    env.video.fire('timeupdate');
    expect(get(env.out)).toMatchObject({ itemId: 'ep3', subtitle: 'S1:F3 Third', posterId: 'ep3', position: 8, duration: 2600, joined: { index: 2, streamPosition: 5540 } });
    expect(env.calls.filter((c) => c.path.endsWith('/next'))).toEqual([]); // no up-next lookup
    expect(env.deps.segments).not.toHaveBeenCalled(); // no skip / credits logic
    expect(get(env.out)?.next).toBeUndefined();
  });

  it('an episode reached by playing on counts as an autoplay for "still watching?", one reached by a seek does not', async () => {
    const env = await joinedEnv();
    playing(env, 2900);
    const p = { ...DEFAULT_PREFS, stillWatching: true, stillWatchingEpisodes: 2 as const }; // ask after 2: chain 0 -> 3 left (capped), 1 -> 2
    expect(episodesBeforeAsk(p)).toBe(3);
    env.engine.seek(2690); // a seek to just before the boundary, then the stream plays across it
    env.video.currentTime = 5540;
    env.video.fire('timeupdate');
    expect(get(env.out)?.itemId).toBe('ep3');
    expect(episodesBeforeAsk(p)).toBe(2);
    env.video.currentTime = 3000; // back into episode 2 by the TV's own scrubbing: no autoplay
    env.video.fire('timeupdate');
    expect(episodesBeforeAsk(p)).toBe(2);
    await env.engine.next(); // a tap: the viewer is there (the chain starts over), no autoplay counted
    expect(get(env.out)?.itemId).toBe('ep3');
    expect(episodesBeforeAsk(p)).toBe(3);
  });

  it('a joined hand-over is never reported, even when the Player claims it reported its start', async () => {
    const env = await joinedEnv({ started: true });
    playing(env, 2900);
    env.video.pause();
    void env.video.play();
    await env.advance(2 * PROGRESS_MS);
    env.video.currentTime = 8132;
    env.video.fire('ended');
    await flush();
    expect(env.reports()).toEqual([]);
  });

  it('next seeks to the next boundary, no-op on the last', async () => {
    const env = await joinedEnv();
    playing(env, 2900);
    await env.engine.next();
    expect(env.video.currentTime).toBe(5532);
    expect(get(env.out)).toMatchObject({ itemId: 'ep3', position: 0, joined: { index: 2 } });
    await env.engine.next();
    expect(env.video.currentTime).toBe(5532);
    expect(env.tokenPosts()).toEqual([]);
    expect(env.toast).not.toHaveBeenCalled();
  });

  it('prev seeks to the previous, no-op on the first', async () => {
    const env = await joinedEnv();
    playing(env, 2900);
    env.engine.prev();
    expect(env.video.currentTime).toBe(0);
    expect(get(env.out)).toMatchObject({ itemId: 'ep1', position: 0, duration: 2832, joined: { index: 0 } });
    env.video.currentTime = 50;
    env.engine.prev();
    expect(env.video.currentTime).toBe(50);
    expect(env.tokenPosts()).toEqual([]);
  });

  it('prev without a joined stream does nothing', async () => {
    const env = await setup();
    await env.adopt();
    env.video.currentTime = 400;
    env.engine.prev();
    expect(env.video.currentTime).toBe(400);
  });

  it('seek is episode-relative', async () => {
    const env = await joinedEnv();
    playing(env, 2900);
    env.engine.seek(100);
    expect(env.video.currentTime).toBe(2932);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', position: 100 });
    env.engine.seek(-5);
    expect(env.video.currentTime).toBe(2832);
    env.engine.skip(-10); // the ±10 s buttons move on the stream: back into episode 1
    expect(env.video.currentTime).toBe(2822);
    expect(get(env.out)).toMatchObject({ itemId: 'ep1', position: 2822 });
  });

  it('no page progress reports for a joined token', async () => {
    const env = await joinedEnv();
    playing(env, 2900);
    env.video.pause();
    void env.video.play();
    env.engine.seek(200);
    await env.advance(3 * PROGRESS_MS);
    await env.engine.stop();
    await flush();
    expect(env.reports()).toEqual([]);
    expect(env.deletes()).toEqual(['a1']);
  });

  /** a joined env whose handed-over token expires in 5 min: the first loop tick renews it */
  async function expiring() {
    const env = await joinedEnv();
    env.engine.adopt({ ...env.handoff, itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', isEpisode: true, position: 2900, cast: { ...env.air.info!, expiresAt: T0 + 5 * 60_000 } });
    await flush();
    playing(env, 2900);
    return env;
  }
  /** the episodes 2 and 3 as a new joined stream (episode 2 starts it at 0), from 68 s */
  const R1 = ci('r1', { startTime: 68, expiresAt: T0 + 9 * 60 * 60_000, runtimeTicks: secToTicks(5300),
    joined: { items: [{ ...E2, start: 0 }, { ...E3, start: 2700 }], subtitles: false } });

  it('a renewal restarts at the episode and offset', async () => {
    const env = await expiring();
    env.posts.push(async () => R1);
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep2', startTicks: 680_000_000, via: 'airplay', continuous: true, maxEpisodes: 2 });
    expect(env.air.info?.castId).toBe('r1');
    env.video.currentTime = 0;
    env.video.fire('loadedmetadata'); // the new stream starts with episode 2: the element goes to its offset, not to stream second 2900
    expect(env.video.currentTime).toBe(68);
    playing(env, 68);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', position: 68, duration: 2700, state: 'playing', joined: { index: 0, streamPosition: 68, streamDuration: 5300 } });
    expect(env.reports()).toEqual([]);
  });

  it('an audio change asks for the episode and offset too', async () => {
    const env = await joinedEnv();
    playing(env, 6000);
    await env.engine.refresh({ audioIndex: 3 });
    const body = env.tokenPosts()[0]!.init.body;
    // the stream's last episode: one episode left, so a plain token (a joined one of one episode is a single token anyway)
    expect(body).toMatchObject({ itemId: 'ep3', startTicks: secToTicks(468), audioIndex: 3, tracksOf: 'ep1', via: 'airplay' });
    expect(body).not.toHaveProperty('continuous');
    expect(body).not.toHaveProperty('maxEpisodes');
  });

  it('a re-mint from a later episode names the episode its tracks belong to; the answer\'s tracks become the session\'s', async () => {
    const env = await setup({ started: false, continuous: true, first: { joined: J, runtimeTicks: secToTicks(8132), hlsSub: true }, at: 2900 });
    await env.adopt({ itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', isEpisode: true, position: 2900, audioIndex: 2, subIndex: 3,
      audioTracks: [{ index: 1, title: 'Deutsch', language: 'ger' }, { index: 2, title: 'English', language: 'eng' }], subtitles: [{ index: 3, title: 'Deutsch', language: 'ger' }] });
    playing(env, 2900);
    // episode 2 numbers its tracks differently: the server mapped English audio to 4 and German subtitles to 7
    env.posts.push(async () => ci('r1', { ...R1, castId: 'r1', hlsSub: true, audioIndex: 4, subtitleIndex: 7,
      audioTracks: [{ index: 1, language: 'ger', title: 'Deutsch', isDefault: true }, { index: 4, language: 'eng', title: 'English', isDefault: false }],
      subtitles: [{ index: 2, language: 'eng', title: 'English', url: '/media/c/r1/2.vtt' }, { index: 7, language: 'ger', title: 'Deutsch', url: '/media/c/r1/7.vtt' }] }));
    await env.engine.refresh();
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep2', tracksOf: 'ep1', audioIndex: 2, subtitleIndex: 3, continuous: true });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', audioIndex: 4, subIndex: 7,
      audioTracks: [{ index: 1, language: 'ger', title: 'Deutsch', isDefault: true }, { index: 4, language: 'eng', title: 'English', isDefault: false }],
      subtitles: [{ index: 2, language: 'eng', title: 'English' }, { index: 7, language: 'ger', title: 'Deutsch' }] });
    // the next re-mint (episode 3 of the new stream) maps from episode 2's real choice
    env.video.fire('loadedmetadata');
    playing(env, 2800);
    await env.engine.refresh();
    expect(env.tokenPosts()[1]!.init.body).toMatchObject({ itemId: 'ep3', tracksOf: 'ep2', audioIndex: 4, subtitleIndex: 7 });
  });

  it('a hand-over of a token that starts with a later episode (the Player re-minted it before the TV) takes that episode\'s tracks', async () => {
    const tracks = { hlsSub: true, audioIndex: 4, subtitleIndex: 7, audioTracks: [{ index: 4, language: 'eng', title: 'English', isDefault: false }],
      subtitles: [{ index: 7, language: 'ger', title: 'Deutsch', url: '/media/c/a1/7.vtt' }] };
    const env = await setup({ started: false, continuous: true, first: { ...R1, ...tracks }, at: 68 });
    // the Player's own indices are episode 1's (its page)
    await env.adopt({ itemId: 'ep1', tracksOf: 'ep1', seriesId: 's1', title: 'Bright Valley', isEpisode: true, position: 68, audioIndex: 2, subIndex: 3 });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', audioIndex: 4, subIndex: 7, audioTracks: [{ index: 4, language: 'eng' }], subtitles: [{ index: 7, language: 'ger' }] });
    playing(env, 2800); // episode 3 of that stream
    await env.engine.refresh();
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep3', tracksOf: 'ep2', audioIndex: 4, subtitleIndex: 7 });
  });

  it('a renewal of the episode the tracks belong to sends no `tracksOf`', async () => {
    const env = await joinedEnv();
    playing(env, 100);
    await env.engine.refresh();
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep1', startTicks: secToTicks(100) });
    expect(env.tokenPosts()[0]!.init.body).not.toHaveProperty('tracksOf');
  });

  it('a paused renewal of a joined token reports nothing', async () => {
    const env = await expiring();
    env.engine.playPause();
    expect(env.video.paused).toBe(true);
    env.posts.push(async () => R1);
    await env.advance(PROGRESS_MS);
    expect(env.air.info?.castId).toBe('r1');
    expect(get(env.out)).toMatchObject({ state: 'playing', paused: true });
    expect(env.reports()).toEqual([]);
  });

  it('switch off: a renewal falls back to a single token', async () => {
    const env = await expiring();
    env.posts.push(() => Promise.reject(new ApiError(400, { error: 'continuous_off' })));
    env.posts.push(async () => ci('s1', { startTime: 68, expiresAt: T0 + 9 * 60 * 60_000, runtimeTicks: secToTicks(2700) }));
    await env.advance(PROGRESS_MS);
    const bodies = env.tokenPosts().map((c) => c.init.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ itemId: 'ep2', startTicks: 680_000_000, continuous: true, maxEpisodes: 2 });
    expect(bodies[1]).toMatchObject({ itemId: 'ep2', startTicks: 680_000_000, via: 'airplay' });
    expect(bodies[1]).not.toHaveProperty('continuous');
    expect(bodies[1]).not.toHaveProperty('maxEpisodes');
    expect(env.toast).not.toHaveBeenCalled();
    expect(env.air.info?.castId).toBe('s1');
    env.video.fire('loadedmetadata');
    expect(env.video.currentTime).toBe(68);
    playing(env, 70);
    // the session goes on with episode 2 alone: a plain token the page reports again
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', position: 70, duration: 2700, state: 'playing' });
    expect(get(env.out)?.joined).toBeUndefined();
    expect(env.reports()).toEqual(['start']);
    expect(env.deps.segments).toHaveBeenCalledWith('ep2'); // the episode's own skip / credits again
  });

  it('a lost route: the reconnect asks for the episode and offset', async () => {
    const env = await joinedEnv();
    playing(env, 2900);
    await routeLost(env);
    expect(get(env.out)).toMatchObject({ state: 'reconnect', itemId: 'ep2', position: 68 });
    env.posts.push(async () => R1);
    env.engine.reconnect(); // the picker: the controller asks for a new token at the element's (stream) position
    await flush();
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'ep2', startTicks: 680_000_000, continuous: true, maxEpisodes: 2 });
    expect(env.reports()).toEqual([]);
    // the new stream starts with episode 2: the element goes to its offset
    env.video.currentTime = 0;
    env.video.fire('loadedmetadata');
    expect(env.video.currentTime).toBe(68);
  });

  it('a lost route: no TV picked after the reconnect tap, the session stays at the episode and offset', async () => {
    const env = await joinedEnv();
    playing(env, 2900);
    await routeLost(env);
    env.posts.push(async () => R1);
    env.engine.reconnect();
    await flush();
    env.video.currentTime = 0; // the new token's metadata is not there yet: its hand-over position counts
    await env.advance(ARM_MS); // nobody picks the TV: the controller gives the stream back
    expect(get(env.out)).toMatchObject({ state: 'reconnect', itemId: 'ep2', position: 68 });
  });

  it('the stream ends after the last episode', async () => {
    const env = await joinedEnv();
    playing(env, 8000);
    env.video.currentTime = 8132;
    env.video.fire('ended');
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'ended', itemId: 'ep3', position: 2600 });
    expect(get(env.out)?.next).toBeUndefined();
    expect(env.deletes()).toEqual(['a1']);
    await env.advance(ENDED_HIDE_MS);
    expect(get(env.out)).toBeNull();
    expect(env.body.children).toEqual([]);
    expect(env.reports()).toEqual([]);
    expect(env.calls.filter((c) => c.path.endsWith('/next'))).toEqual([]);
  });

  it('the Player\'s re-mint before a TV is picked (the phone plays the joined token) asks for the episode and offset', async () => {
    // the controller as the Player owns it: `ready` (token on the element, no TV yet), then a quality change (refresh)
    const video = new FakeVideo();
    const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (t: ReturnType<typeof setTimeout>) => clearTimeout(t) };
    let info: CastInfo | null = null;
    const request = vi.fn(async (_pos: number, o?: { joined?: { itemId: string; left: number } }) => (o?.joined ? R1 : ci('a1', { joined: J })));
    const air = createAirPlay(video as unknown as AirPlayVideo, {
      request, revoke: vi.fn(), detach: vi.fn(), restore: vi.fn(), fail: vi.fn(), change: vi.fn(),
      started(c) { info = c; },
      joined: (pos) => (info?.joined ? joinedAsk(info.joined.items, pos) : null),
    }, null, timers as unknown as AirPlayTimers);
    video.currentTime = 10;
    air.pick();
    await flush();
    expect(air.state.ready).toBe(true);
    expect(request).toHaveBeenLastCalledWith(10); // the first token: the page's own episode and position
    video.currentTime = 2900;
    await air.refresh();
    expect(request).toHaveBeenLastCalledWith(68, { joined: { itemId: 'ep2', left: 2 } });
    video.currentTime = 0;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(68);
    air.destroy();
  });
});
