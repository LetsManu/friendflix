import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CastInfo } from '#lib/cast';
import { airPlaySupported, ARM_MS, AVAILABILITY_EVENT, createAirPlay, WIRELESS_EVENT, type AirPlayDeps, type AirPlayState } from './airplay';

/** a <video> stand-in: Safari's AirPlay events are simulated by dispatching them */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  src = 'blob:hlsjs';
  attrs = new Map<string, string>([['crossorigin', 'use-credentials']]);
  webkitCurrentPlaybackTargetIsWireless = false;
  webkitShowPlaybackTargetPicker = vi.fn();
  play = vi.fn(async () => { this.paused = false; });
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  wireless(on: boolean) { this.webkitCurrentPlaybackTargetIsWireless = on; this.dispatchEvent(new Event(WIRELESS_EVENT)); }
}
const available = (t: EventTarget, on: boolean) => t.dispatchEvent(Object.assign(new Event(AVAILABILITY_EVENT), { availability: on ? 'available' : 'not-available' }));

const CI: CastInfo = {
  castId: 'c'.repeat(32), expiresAt: Date.now() + 3600_000, playSessionId: 'ps', mediaSourceId: 'ms', startTime: 754,
  contentUrl: 'https://ff.example/media/c/TOKEN/Videos/x/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Film', subtitles: [],
};
const CI2: CastInfo = { ...CI, castId: 'd'.repeat(32), contentUrl: 'https://ff.example/media/c/TOKEN2/Videos/x/master.m3u8' };
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { vi.useRealTimers(); });

function setup(over: Partial<AirPlayDeps> = {}, probe?: EventTarget) {
  const v = new FakeVideo();
  const states: AirPlayState[] = [];
  const deps = {
    request: vi.fn(async () => CI),
    revoke: vi.fn(),
    detach: vi.fn(),
    started: vi.fn(),
    restore: vi.fn(),
    fail: vi.fn(),
    change: vi.fn((s: AirPlayState) => { states.push(s); }),
    ...over,
  } satisfies AirPlayDeps;
  const c = createAirPlay(v, deps, probe);
  return { v, c, deps, states };
}
/** button tap (token stream on the element, picker) + the picker's choice (the TV) */
async function airplayOn(v: FakeVideo, c: ReturnType<typeof setup>['c']) {
  c.pick();
  await flush();
  v.wireless(true);
  await flush();
}

describe('feature detection', () => {
  it('needs webkitShowPlaybackTargetPicker (Chromium has none)', () => {
    expect(airPlaySupported(new FakeVideo())).toBe(true);
    expect(airPlaySupported({} as never)).toBe(false);
    expect(airPlaySupported(null)).toBe(false);
  });
});

describe('AirPlay controller', () => {
  it('allows AirPlay on the element and shows the button only while a receiver is available', () => {
    const { v, c, states } = setup();
    expect(v.getAttribute('x-webkit-airplay')).toBe('allow');
    expect(c.state.available).toBe(false);
    available(v, true);
    expect(states.at(-1)).toMatchObject({ available: true, active: false });
    available(v, false);
    expect(states.at(-1)?.available).toBe(false);
  });

  it('availability also comes from the probe element (hls.js blocks remote playback on the main video)', () => {
    const probe = new EventTarget();
    const { v, c } = setup({}, probe);
    available(probe, true);
    expect(c.state.available).toBe(true);
    available(v, false); // the main element says no: the probe still knows a receiver
    expect(c.state.available).toBe(true);
    available(probe, false);
    expect(c.state.available).toBe(false);
  });

  it('tap: token first (detach, request at the position, token URL on the element), THEN the picker; ready until a TV is chosen', async () => {
    const { v, c, deps, states } = setup();
    v.currentTime = 754.2; v.paused = false;
    c.pick();
    expect(c.state).toMatchObject({ busy: true, ready: false, active: false });
    expect(v.webkitShowPlaybackTargetPicker).not.toHaveBeenCalled(); // never with the cookie / MSE URL
    await flush();
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledWith(754.2);
    expect(deps.started).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI.contentUrl);
    expect(v.getAttribute('crossorigin')).toBeNull(); // the token URL needs no credentials
    expect(v.play).toHaveBeenCalled();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.request).mock.invocationCallOrder[0]).toBeLessThan(v.webkitShowPlaybackTargetPicker.mock.invocationCallOrder[0]!);
    expect(v.webkitShowPlaybackTargetPicker.mock.contexts[0]).toBe(v);
    expect(c.state).toMatchObject({ busy: false, ready: true, active: false, error: false });
    expect(c.info).toBe(CI);
    expect(states.some((s) => s.ready)).toBe(true);
    v.currentTime = 0; // a new src starts at 0 ...
    v.dispatchEvent(new Event('loadedmetadata'));
    expect(v.currentTime).toBe(754.2); // ... and resumes where the phone was
  });

  it('the picker throws (no gesture any more): still ready, the prompt opens it from a fresh tap', async () => {
    const { v, c } = setup();
    v.webkitShowPlaybackTargetPicker.mockImplementationOnce(() => { throw new Error('gesture'); });
    c.pick();
    await flush();
    expect(c.state.ready).toBe(true);
    c.pick(); // the prompt's / the button's tap while ready: opens the picker synchronously, no new token
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledTimes(2);
  });

  it('a tap while ready opens the picker synchronously without a new request', async () => {
    const { v, c, deps } = setup();
    c.pick();
    await flush();
    v.webkitShowPlaybackTargetPicker.mockClear();
    c.pick();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.detach).toHaveBeenCalledOnce();
  });

  it('double tap while the token loads: one request, one picker', async () => {
    let resolve!: (ci: CastInfo) => void;
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    c.pick();
    c.pick();
    await flush();
    c.pick();
    expect(c.state.busy).toBe(true);
    resolve(CI);
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
  });

  it('wireless after the picker: active right away, no src swap and no new token', async () => {
    const { v, c, deps } = setup();
    v.paused = false;
    c.pick();
    await flush();
    v.src = CI.contentUrl; // what the element holds (Safari may normalise it; we compare against info)
    v.wireless(true);
    expect(c.state).toMatchObject({ active: true, ready: false, busy: false, error: false });
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(c.info).toBe(CI);
    expect(v.src).toBe(CI.contentUrl);
  });

  it(`no TV within ${ARM_MS / 1000} s: token revoked, back to the normal stream at the position`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { v, c, deps } = setup();
    v.currentTime = 50; v.paused = false;
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state.ready).toBe(true);
    v.currentTime = 62;
    await vi.advanceTimersByTimeAsync(ARM_MS - 100);
    expect(deps.restore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledWith(62, true, CI);
    expect(v.getAttribute('crossorigin')).toBe('use-credentials');
    expect(c.info).toBeNull();
    expect(c.state).toMatchObject({ ready: false, active: false, busy: false });
  });

  it('ARM_MS is 90 s (the picker and the TV may take a while)', () => {
    expect(ARM_MS).toBe(90_000);
  });

  it('a tap while ready restarts the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { c, deps } = setup();
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ARM_MS - 10_000);
    c.pick();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.restore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ARM_MS);
    expect(deps.restore).toHaveBeenCalledOnce();
  });

  it('the arm timer is cleared once a TV is chosen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { v, c, deps } = setup();
    c.pick();
    await vi.advanceTimersByTimeAsync(0);
    v.wireless(true);
    await vi.advanceTimersByTimeAsync(ARM_MS * 2);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(c.state.active).toBe(true);
  });

  it('token request fails before any TV is chosen: toast + normal stream, no active / error state, no picker', async () => {
    const err = Object.assign(new Error('x'), { body: { error: 'max_streams', max: 1 } });
    const { v, c, deps } = setup({ request: vi.fn(async (): Promise<CastInfo> => { throw err; }) });
    v.currentTime = 42; v.paused = false;
    c.pick();
    await flush();
    expect(deps.fail).toHaveBeenCalledWith(err);
    expect(deps.restore).toHaveBeenCalledWith(42, true, null);
    expect(deps.started).not.toHaveBeenCalled();
    expect(v.webkitShowPlaybackTargetPicker).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: false, ready: false, busy: false, error: false });
    expect(c.info).toBeNull();
  });

  it('wireless while the token still loads (e.g. picked elsewhere): active as soon as the token URL is on the element, no picker', async () => {
    let resolve!: (ci: CastInfo) => void;
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    c.pick();
    await flush();
    v.wireless(true);
    resolve(CI);
    await flush();
    expect(deps.request).toHaveBeenCalledOnce();
    expect(v.src).toBe(CI.contentUrl);
    expect(c.state).toMatchObject({ active: true, ready: false, busy: false });
    expect(v.webkitShowPlaybackTargetPicker).not.toHaveBeenCalled();
  });

  it('wireless without a token URL on the element (Control Center route): falls back to fetching one and switching', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { v, c, deps } = setup();
    v.currentTime = 300; v.paused = false;
    v.wireless(true);
    expect(c.state).toMatchObject({ active: true, busy: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledWith(300);
    expect(deps.started).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI.contentUrl);
    expect(c.state).toMatchObject({ active: true, busy: false, error: false });
  });

  it('a playback error on the phone while ready: toast, token revoked, normal stream', async () => {
    const { v, c, deps } = setup();
    v.currentTime = 70;
    c.pick();
    await flush();
    c.videoError();
    await flush();
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledWith(70, false, CI);
    expect(c.state).toMatchObject({ ready: false, active: false, error: false });
  });

  it('refresh() while ready (other audio track): new token on the element, still ready, old one revoked', async () => {
    const request = vi.fn(async () => CI).mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2);
    const { v, c, deps } = setup({ request });
    c.pick();
    await flush();
    await c.refresh();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.info).toBe(CI2);
    expect(c.state).toMatchObject({ ready: true, active: false, busy: false });
    v.wireless(true);
    expect(c.state.active).toBe(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refresh() fails while ready: toast and back to the normal stream (no TV to show an error on)', async () => {
    const request = vi.fn(async () => CI);
    const { c, deps } = setup({ request });
    c.pick();
    await flush();
    request.mockImplementationOnce(async () => { throw new Error('net'); });
    await c.refresh();
    await flush();
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledOnce();
    expect(c.state).toMatchObject({ ready: false, active: false, error: false });
  });

  it('a paused video stays paused on the TV', async () => {
    const { v, c } = setup();
    v.currentTime = 30;
    await airplayOn(v, c);
    expect(v.play).not.toHaveBeenCalled();
  });

  it('wireless off: revokes the token and restores the normal stream at the position', async () => {
    const { v, c, deps } = setup();
    v.currentTime = 100; v.paused = false;
    await airplayOn(v, c);
    v.currentTime = 812;
    v.wireless(false);
    await flush();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledWith(812, true, CI);
    expect(v.getAttribute('crossorigin')).toBe('use-credentials');
    expect(c.info).toBeNull();
    expect(c.state).toMatchObject({ active: false, busy: false, error: false });
  });

  it('Control Center route: AirPlay ended while the token was still being requested: the late token is revoked, never used', async () => {
    let resolve!: (ci: CastInfo) => void;
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    v.wireless(true);
    await flush();
    v.wireless(false);
    await flush();
    expect(deps.restore).toHaveBeenCalledOnce();
    expect(c.state.active).toBe(false);
    resolve(CI);
    await flush();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.started).not.toHaveBeenCalled();
    expect(v.src).not.toBe(CI.contentUrl);
  });

  it('Control Center route: request fails while the TV is the target: error state with Retry, no fallback to the cookie stream', async () => {
    const err = Object.assign(new Error('x'), { body: { error: 'max_streams', max: 1 } });
    const request = vi.fn(async (): Promise<CastInfo> => { throw err; });
    const { v, c, deps } = setup({ request });
    v.currentTime = 42; v.paused = false;
    v.wireless(true);
    await flush();
    expect(deps.fail).toHaveBeenCalledWith(err);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: true, busy: false, error: true });
    // Retry succeeds
    request.mockImplementationOnce(async () => CI);
    await c.retry();
    expect(c.state).toMatchObject({ active: true, error: false });
    expect(v.src).toBe(CI.contentUrl);
  });

  it('refresh fails: the old token stays (not revoked), error state; Retry then swaps tokens', async () => {
    const request = vi.fn(async () => CI);
    const { v, c, deps } = setup({ request });
    await airplayOn(v, c);
    request.mockImplementationOnce(async () => { throw new Error('net'); });
    await c.refresh();
    expect(c.state.error).toBe(true);
    expect(c.info).toBe(CI);
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(v.src).toBe(CI.contentUrl);
    request.mockImplementationOnce(async () => CI2);
    await c.retry();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.state.error).toBe(false);
  });

  it('a playback error on the TV: error state + toast, Retry requests a new token', async () => {
    const request = vi.fn(async () => CI).mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2);
    const { v, c, deps } = setup({ request });
    await airplayOn(v, c);
    c.videoError();
    expect(c.state.error).toBe(true);
    expect(deps.fail).toHaveBeenCalledOnce();
    c.videoError(); // once
    expect(deps.fail).toHaveBeenCalledOnce();
    await c.retry();
    expect(request).toHaveBeenCalledTimes(2);
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
  });

  it('videoError() outside AirPlay or while switching does nothing', async () => {
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>(() => undefined)) });
    c.videoError();
    c.pick(); // busy (token loading)
    c.videoError();
    v.wireless(true); // still busy
    c.videoError();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it('refresh(): new token at the current position, the old one revoked (audio track / quality / renewal)', async () => {
    const request = vi.fn(async () => CI).mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2);
    const { v, c, deps } = setup({ request });
    v.currentTime = 10;
    await airplayOn(v, c);
    v.currentTime = 500;
    await c.refresh();
    expect(request).toHaveBeenLastCalledWith(500);
    expect(deps.detach).toHaveBeenCalledTimes(2); // the old session's stop report
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.info).toBe(CI2);
  });

  it('refresh() does nothing without AirPlay', async () => {
    const { c, deps } = setup();
    await c.refresh();
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('destroy() removes the listeners, stops the arm timer and revokes a live token', async () => {
    const { v, c, deps, states } = setup();
    await airplayOn(v, c);
    c.destroy();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    const n = states.length;
    available(v, true);
    v.wireless(false);
    expect(states).toHaveLength(n);
    expect(deps.restore).not.toHaveBeenCalled();
  });
});
