// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { LIVE_CATCHUP_RATE, LIVE_MAX_LATENCY_S, LIVE_SYNC_S, hlsConfig, liveHlsConfig, liveSyncSeconds, loadHls, resetHlsLoader } from './hls';

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
  it('H3: a window of only the newest segments (no rewind buffer) plays 8 s behind, inside the window', () => {
    expect(liveHlsConfig(0, false).liveSyncDuration).toBe(8);
    expect(liveSyncSeconds(0)).toBe(8);
    expect(liveSyncSeconds(15)).toBe(8);
    expect(liveSyncSeconds(16)).toBe(12);
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
