// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { LIVE_CATCHUP_RATE, LIVE_LATENCY, LIVE_MAX_LATENCY_S, LIVE_SYNC_S, hlsConfig, liveHlsConfig, loadHls, raiseLatency, resetHlsLoader } from './hls';

describe('loadHls', () => {
  it('loads once and shares the promise', async () => {
    resetHlsLoader();
    const Fake = class {} as any;
    const imp = vi.fn(async () => ({ default: Fake }));
    const [a, b] = await Promise.all([loadHls(imp), loadHls(imp)]);
    expect(a).toBe(Fake); expect(b).toBe(Fake);
    expect(imp).toHaveBeenCalledTimes(1);
    await loadHls(imp);
    expect(imp).toHaveBeenCalledTimes(1);
  });
  it('a failed load can be retried', async () => {
    resetHlsLoader();
    const Fake = class {} as any;
    const imp = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ default: Fake });
    await expect(loadHls(imp)).rejects.toThrow('offline');
    await expect(loadHls(imp)).resolves.toBe(Fake);
    expect(imp).toHaveBeenCalledTimes(2);
  });
});

describe('hlsConfig', () => {
  it('starts at the resume point (or live edge = -1) and sets the buffer tuning', () => {
    expect(hlsConfig(0).startPosition).toBe(-1);
    expect(hlsConfig(1).startPosition).toBe(-1);
    expect(hlsConfig(95)).toMatchObject({ startPosition: 95, startFragPrefetch: true, backBufferLength: 90, maxMaxBufferLength: 120, maxBufferLength: 60 });
  });
  it('retries manifest and fragments more often than hls.js defaults, with growing delays', () => {
    const c = hlsConfig(0) as Record<string, any>;
    for (const k of ['manifestLoadPolicy', 'fragLoadPolicy'] as const) {
      const d = c[k].default;
      expect(d.maxLoadTimeMs).toBeGreaterThanOrEqual(60_000);
      expect(d.errorRetry.maxNumRetry).toBeGreaterThanOrEqual(4);
      expect(d.timeoutRetry.maxNumRetry).toBeGreaterThanOrEqual(4);
      expect(d.errorRetry.backoff).toBe('exponential');
    }
  });
});

describe('liveHlsConfig', () => {
  it('liveHlsConfig caps the back buffer on TVs', () => {
    expect(liveHlsConfig(7200, true).backBufferLength).toBe(300);
    expect(liveHlsConfig(7200, false).backBufferLength).toBe(1800);
    expect(liveHlsConfig(120, true).backBufferLength).toBe(120);
    expect(liveHlsConfig(600, false).backBufferLength).toBe(600);
    expect(liveHlsConfig(0, false).backBufferLength).toBe(0);
  });
  it('H3: plays 12 s behind the edge, catches up gently (1.1×) and goes back to it beyond 30 s, in seconds (not a count of a target that only grows)', () => {
    for (const tv of [false, true]) {
      const c = liveHlsConfig(1800, tv);
      expect(c).toMatchObject({ liveSyncDuration: 12, liveMaxLatencyDuration: 30, maxLiveSyncPlaybackRate: 1.1, lowLatencyMode: true });
      expect(c.liveSyncDurationCount).toBeUndefined();
      expect(c.liveMaxLatencyDurationCount).toBeUndefined();
    }
    expect([LIVE_SYNC_S, LIVE_MAX_LATENCY_S, LIVE_CATCHUP_RATE]).toEqual([12, 30, 1.1]);
  });
  it('review M8: 12 s also without a rewind buffer (hls.js keeps the start inside the window itself)', () => {
    expect(liveHlsConfig(0, false).liveSyncDuration).toBe(12);
  });
  it('review I3: long segments raise the sync to 3 target durations and keep the max latency above it; only ever raised', () => {
    expect(raiseLatency(LIVE_LATENCY, 4)).toEqual({ syncS: 12, maxLatencyS: 30 });
    expect(raiseLatency(LIVE_LATENCY, 6)).toEqual({ syncS: 18, maxLatencyS: 30 });
    const ten = raiseLatency(LIVE_LATENCY, 10);
    expect(ten).toEqual({ syncS: 30, maxLatencyS: 50 });
    // a later playlist with a shorter target does not lower it within the session
    expect(raiseLatency(ten, 4)).toEqual(ten);
    expect(raiseLatency(raiseLatency(LIVE_LATENCY, 6), 10)).toEqual({ syncS: 30, maxLatencyS: 50 });
    for (const t of [1, 4, 6, 8, 10, 15]) { const l = raiseLatency(LIVE_LATENCY, t); expect(l.maxLatencyS).toBeGreaterThan(l.syncS); }
    // nothing known changes nothing
    expect(raiseLatency(LIVE_LATENCY, Number.NaN)).toEqual(LIVE_LATENCY);
  });
  it('H3: hls.js accepts the live tuning (it refuses counts and seconds mixed, or a max latency at or under the sync point)', async () => {
    const { default: Hls } = await import('hls.js');
    for (const dvr of [0, 1800]) {
      const h = new Hls(liveHlsConfig(dvr, false));
      expect(h.config.liveMaxLatencyDuration).toBe(30);
      expect(h.config.maxLiveSyncPlaybackRate).toBe(1.1);
      h.destroy();
    }
  });
  it('keeps the existing patient load policies', () => {
    const live = liveHlsConfig(1800, false) as Record<string, unknown>, film = hlsConfig(0) as Record<string, unknown>;
    for (const k of ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy']) expect(live[k]).toEqual(film[k]);
  });
});
