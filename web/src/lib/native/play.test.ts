// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  available: true,
  caps: { api: 1, play: true, download: true, cast: false },
  play: vi.fn(async (_r: unknown) => true),
  me: { profile: { id: 'p-1' } } as unknown,
}));
vi.mock('./bridge', () => ({
  native: { get available() { return h.available; }, capabilities: async () => h.caps, play: h.play },
}));
vi.mock('#lib/offline/manager', () => ({ getMe: async () => h.me }));

import { playRequest, resetNativeCaps, tryNativePlay } from './play';

beforeEach(() => { h.available = true; h.caps = { api: 1, play: true, download: true, cast: false }; h.me = { profile: { id: 'p-1' } }; h.play.mockClear(); h.play.mockResolvedValue(true); resetNativeCaps(); });

describe('playRequest', () => {
  it('maps ticks to ms and keeps valid tracks', () => {
    expect(playRequest({ id: 'abc', positionTicks: 90_000 * 10_000 }, 'p-1', { audio: 'ger', subtitle: 'en' })).toEqual({ itemId: 'abc', profileId: 'p-1', startMs: 90_000, audio: 'ger', subtitle: 'en' });
  });
  it('leaves out zero/absent/absurd positions and malformed tracks', () => {
    expect(playRequest({ id: 'abc', positionTicks: 0 }, 'p')).toEqual({ itemId: 'abc', profileId: 'p' });
    expect(playRequest({ id: 'abc', positionTicks: 1e18 }, 'p', { audio: 'a b', subtitle: '' })).toEqual({ itemId: 'abc', profileId: 'p' });
  });
  it('null for unusable ids', () => {
    expect(playRequest({ id: '../x' }, 'p')).toBeNull();
    expect(playRequest({ id: 'a' }, undefined)).toBeNull();
    expect(playRequest({ id: 'a' }, 'p/1')).toBeNull();
  });
});

describe('tryNativePlay', () => {
  it('hands the title to the app', async () => {
    await expect(tryNativePlay({ id: 'abc', positionTicks: 5_000_0000 })).resolves.toBe(true);
    expect(h.play).toHaveBeenCalledWith({ itemId: 'abc', profileId: 'p-1', startMs: 5000 });
  });
  it('false without the bridge, without the capability, without a profile, or when the app declines', async () => {
    h.available = false;
    await expect(tryNativePlay({ id: 'a' })).resolves.toBe(false);
    h.available = true; h.caps = { api: 1, play: false, download: false, cast: false };
    await expect(tryNativePlay({ id: 'a' })).resolves.toBe(false);
    resetNativeCaps(); h.caps = { api: 1, play: true, download: true, cast: false }; h.me = null;
    await expect(tryNativePlay({ id: 'a' })).resolves.toBe(false);
    h.me = { profile: { id: 'p' } }; h.play.mockResolvedValue(false);
    await expect(tryNativePlay({ id: 'a' })).resolves.toBe(false);
    expect(h.play).toHaveBeenCalledTimes(1);
  });
});
