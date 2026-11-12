// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { hlsConfig, liveHlsConfig, loadHls, resetHlsLoader } from './hls';

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
  it('plays 3 segments behind the edge and catches up beyond 10', () => {
    expect(liveHlsConfig(1800, false)).toMatchObject({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 10 });
    expect(liveHlsConfig(1800, true)).toMatchObject({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 10 });
  });
  it('keeps the existing patient load policies', () => {
    const live = liveHlsConfig(1800, false) as Record<string, unknown>, film = hlsConfig(0) as Record<string, unknown>;
    for (const k of ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy']) expect(live[k]).toEqual(film[k]);
  });
});
