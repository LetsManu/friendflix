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
    prepare: vi.fn(() => { v.src = '/media/Videos/x/main.m3u8'; return true; }), // hls.js -> native HLS
    reattach: vi.fn(),
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
/** button tap + the picker's choice (the TV) */
async function airplayOn(v: FakeVideo, c: ReturnType<typeof setup>['c']) {
  c.pick();
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

  it('pick(): prepares native HLS in the click, then opens the picker; normal playback is never touched before', () => {
    const { v, c, deps } = setup();
    expect(deps.prepare).not.toHaveBeenCalled();
    c.pick();
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.prepare).mock.invocationCallOrder[0]).toBeLessThan(v.webkitShowPlaybackTargetPicker.mock.invocationCallOrder[0]!);
    expect(c.state.armed).toBe(true);
  });

  it('no wireless target within 30 s (picker dismissed): back to hls.js at the current position', () => {
    vi.useFakeTimers();
    const { v, c, deps } = setup();
    v.currentTime = 50; v.paused = false;
    c.pick();
    v.currentTime = 62;
    vi.advanceTimersByTime(ARM_MS - 1);
    expect(deps.reattach).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deps.reattach).toHaveBeenCalledWith(62, true);
    expect(c.state.armed).toBe(false);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('wireless right after the tap, before the native src reached the position: the token starts at the tapped position', async () => {
    const { v, c, deps } = setup({ prepare: vi.fn(() => { v.src = '/media/x.m3u8'; v.currentTime = 0; return true; }) });
    v.currentTime = 321;
    c.pick();
    v.wireless(true);
    await flush();
    expect(deps.request).toHaveBeenCalledWith(321);
  });

  it('a second tap while armed restarts the 30 s wait without preparing again', () => {
    vi.useFakeTimers();
    const { c, deps } = setup();
    c.pick();
    vi.advanceTimersByTime(20_000);
    c.pick();
    expect(deps.prepare).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20_000);
    expect(deps.reattach).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(deps.reattach).toHaveBeenCalledOnce();
  });

  it('prepare() false (direct play already AirPlay-able): no arming, no reattach', () => {
    vi.useFakeTimers();
    const { c, deps } = setup({ prepare: vi.fn(() => false) });
    c.pick();
    expect(c.state.armed).toBe(false);
    vi.advanceTimersByTime(ARM_MS);
    expect(deps.reattach).not.toHaveBeenCalled();
  });

  it('wireless on: detaches, requests a cast session at the current time, switches to the token URL and keeps the position', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { v, c, deps } = setup();
    v.currentTime = 754.2; v.paused = false;
    c.pick();
    v.wireless(true);
    expect(c.state).toMatchObject({ active: true, busy: true, armed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledWith(754.2);
    expect(deps.started).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI.contentUrl);
    expect(v.getAttribute('crossorigin')).toBeNull(); // the token URL needs no credentials
    expect(v.play).toHaveBeenCalled();
    v.currentTime = 0; // a new src starts at 0 ...
    v.dispatchEvent(new Event('loadedmetadata'));
    expect(v.currentTime).toBe(754.2); // ... and resumes where the phone was
    expect(c.info).toBe(CI);
    expect(c.state).toMatchObject({ active: true, busy: false, error: false });
    vi.advanceTimersByTime(ARM_MS); // the arm timer was cleared
    expect(deps.reattach).not.toHaveBeenCalled();
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

  it('AirPlay ended while the token was still being requested: the late token is revoked, never used', async () => {
    let resolve!: (ci: CastInfo) => void;
    const { v, c, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    await airplayOn(v, c);
    v.wireless(false);
    await flush();
    expect(deps.restore).toHaveBeenCalledOnce();
    resolve(CI);
    await flush();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.started).not.toHaveBeenCalled();
    expect(v.src).not.toBe(CI.contentUrl);
  });

  it('request fails while the TV is the target: error state with Retry, no fallback to the cookie stream', async () => {
    const err = Object.assign(new Error('x'), { body: { error: 'max_streams', max: 1 } });
    const request = vi.fn(async (): Promise<CastInfo> => { throw err; });
    const { v, c, deps } = setup({ request });
    v.currentTime = 42; v.paused = false;
    await airplayOn(v, c);
    expect(deps.fail).toHaveBeenCalledWith(err);
    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.reattach).not.toHaveBeenCalled();
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
    c.pick(); v.wireless(true); // busy
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
