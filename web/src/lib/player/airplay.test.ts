import { describe, expect, it, vi } from 'vitest';
import type { CastInfo } from '#lib/cast';
import { airPlaySupported, AVAILABILITY_EVENT, createAirPlay, prefersNativeHls, WIRELESS_EVENT, type AirPlayDeps, type AirPlayState } from './airplay';

/** a <video> stand-in: Safari's AirPlay events are simulated by dispatching them */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  src = '/media/Videos/x/main.m3u8?local';
  attrs = new Map<string, string>([['crossorigin', 'use-credentials']]);
  webkitCurrentPlaybackTargetIsWireless = false;
  webkitShowPlaybackTargetPicker = vi.fn();
  play = vi.fn(async () => { this.paused = false; });
  canPlayType = (t: string) => (t === 'application/vnd.apple.mpegurl' ? 'maybe' : '');
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  available(on: boolean) { this.dispatchEvent(Object.assign(new Event(AVAILABILITY_EVENT), { availability: on ? 'available' : 'not-available' })); }
  wireless(on: boolean) { this.webkitCurrentPlaybackTargetIsWireless = on; this.dispatchEvent(new Event(WIRELESS_EVENT)); }
}

const CI: CastInfo = {
  castId: 'c'.repeat(32), expiresAt: Date.now() + 3600_000, playSessionId: 'ps', mediaSourceId: 'ms', startTime: 754,
  contentUrl: 'https://ff.example/media/c/TOKEN/Videos/x/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Film', subtitles: [],
};
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<AirPlayDeps> = {}) {
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
  const c = createAirPlay(v, deps);
  return { v, c, deps, states };
}

describe('feature detection', () => {
  it('needs webkitShowPlaybackTargetPicker (Chromium has none)', () => {
    expect(airPlaySupported(new FakeVideo())).toBe(true);
    expect(airPlaySupported({ canPlayType: () => 'maybe' } as never)).toBe(false);
    expect(airPlaySupported(null)).toBe(false);
  });
  it('native HLS only where AirPlay exists and HLS plays natively', () => {
    expect(prefersNativeHls(new FakeVideo())).toBe(true);
    const v = new FakeVideo(); v.canPlayType = () => '';
    expect(prefersNativeHls(v)).toBe(false);
    expect(prefersNativeHls({ canPlayType: () => 'maybe' } as never)).toBe(false);
  });
});

describe('AirPlay controller', () => {
  it('allows AirPlay on the element and shows the button only while a receiver is available', () => {
    const { v, c, states } = setup();
    expect(v.getAttribute('x-webkit-airplay')).toBe('allow');
    expect(c.state.available).toBe(false);
    v.available(true);
    expect(states.at(-1)).toMatchObject({ available: true, active: false });
    v.available(false);
    expect(states.at(-1)?.available).toBe(false);
  });

  it('pick() opens the system picker', () => {
    const { v, c } = setup();
    c.pick();
    expect(v.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
  });

  it('wireless on: detaches, requests a cast session at the current time, switches to the token URL and keeps the position', async () => {
    const { v, c, deps } = setup();
    v.currentTime = 754.2; v.paused = false;
    v.wireless(true);
    expect(c.state).toMatchObject({ active: true, busy: true });
    await flush();
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
    expect(c.state).toMatchObject({ active: true, busy: false });
  });

  it('a paused video stays paused on the TV', async () => {
    const { v } = setup();
    v.currentTime = 30;
    v.wireless(true);
    await flush();
    expect(v.play).not.toHaveBeenCalled();
  });

  it('wireless off: revokes the token and restores the normal stream at the position', async () => {
    const { v, c, deps } = setup();
    v.currentTime = 100; v.paused = false;
    v.wireless(true);
    await flush();
    v.currentTime = 812;
    v.wireless(false);
    await flush();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.restore).toHaveBeenCalledWith(812, true, CI);
    expect(v.getAttribute('crossorigin')).toBe('use-credentials');
    expect(c.info).toBeNull();
    expect(c.state).toMatchObject({ active: false, busy: false });
  });

  it('AirPlay ended while the token was still being requested: the late token is revoked, never used', async () => {
    let resolve!: (ci: CastInfo) => void;
    const { v, deps } = setup({ request: vi.fn(() => new Promise<CastInfo>((r) => (resolve = r))) });
    v.wireless(true);
    await flush();
    v.wireless(false);
    await flush();
    expect(deps.restore).toHaveBeenCalledOnce();
    resolve(CI);
    await flush();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(deps.started).not.toHaveBeenCalled();
    expect(v.src).not.toBe(CI.contentUrl);
  });

  it('errors: toast via fail() and fall back to the normal stream', async () => {
    const err = Object.assign(new Error('x'), { body: { error: 'max_streams', max: 1 } });
    const { v, c, deps } = setup({ request: vi.fn(async () => { throw err; }) });
    v.currentTime = 42; v.paused = false;
    v.wireless(true);
    await flush();
    expect(deps.fail).toHaveBeenCalledWith(err);
    expect(deps.restore).toHaveBeenCalledWith(42, true, null);
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ active: false, busy: false });
    expect(v.getAttribute('crossorigin')).toBe('use-credentials');
  });

  it('refresh(): new token at the current position, the old one revoked (audio track / quality / renewal)', async () => {
    const CI2 = { ...CI, castId: 'd'.repeat(32), contentUrl: 'https://ff.example/media/c/TOKEN2/Videos/x/master.m3u8' };
    const request = vi.fn(async () => CI).mockResolvedValueOnce(CI).mockResolvedValueOnce(CI2);
    const { v, c, deps } = setup({ request });
    v.currentTime = 10;
    v.wireless(true);
    await flush();
    v.currentTime = 500;
    await c.refresh();
    expect(request).toHaveBeenLastCalledWith(500);
    expect(deps.detach).toHaveBeenCalledTimes(2); // the old session's stop report
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    expect(v.src).toBe(CI2.contentUrl);
    expect(c.info).toBe(CI2);
    expect(c.state.active).toBe(true);
  });

  it('refresh() does nothing without AirPlay', async () => {
    const { c, deps } = setup();
    await c.refresh();
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('destroy() removes the listeners and revokes a live token', async () => {
    const { v, c, deps, states } = setup();
    v.wireless(true);
    await flush();
    c.destroy();
    expect(deps.revoke).toHaveBeenCalledWith(CI);
    const n = states.length;
    v.available(true);
    v.wireless(false);
    expect(states).toHaveLength(n);
    expect(deps.restore).not.toHaveBeenCalled();
  });
});
