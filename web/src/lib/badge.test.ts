// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api', () => ({ api: vi.fn() }));
vi.mock('#lib/kids', async () => { const { writable } = await import('svelte/store'); return { kidsMode: writable(false) }; });
const { setAppBadge, syncBadge, badgeText } = await import('./badge');
const { api } = await import('#lib/api');
const { kidsMode } = await import('#lib/kids');
const { updateBadge } = await import('./sw/push');

describe('app badge', () => {
  it('sets, clamps and clears through the Badging API', async () => {
    const nav = { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn().mockResolvedValue(undefined) };
    expect(await setAppBadge(3, nav)).toBe(true);
    expect(nav.setAppBadge).toHaveBeenLastCalledWith(3);
    await setAppBadge(250, nav);
    expect(nav.setAppBadge).toHaveBeenLastCalledWith(99);
    expect(await setAppBadge(0, nav)).toBe(true);
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
    await setAppBadge(Number.NaN, nav);
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(2);
  });
  it('is a quiet no-op where unsupported or when the browser refuses', async () => {
    expect(await setAppBadge(2, {})).toBe(false);
    expect(await setAppBadge(2, undefined)).toBe(false);
    expect(await setAppBadge(2, { setAppBadge: () => Promise.reject(new Error('denied')) })).toBe(false);
  });
  it('service worker: badge = notifications still showing', async () => {
    const setB = vi.fn().mockResolvedValue(undefined), clearB = vi.fn().mockResolvedValue(undefined);
    const mk = (n: number) => ({ registration: { showNotification: vi.fn(), getNotifications: async () => new Array(n).fill({}) }, navigator: { setAppBadge: setB, clearAppBadge: clearB } });
    await updateBadge(mk(2)); expect(setB).toHaveBeenCalledWith(2);
    await updateBadge(mk(0)); expect(clearB).toHaveBeenCalledTimes(1);
    await expect(updateBadge({ registration: { showNotification: vi.fn() } })).resolves.toBeUndefined(); // no Badging API
  });
  it('a dot shows at most 99+', () => {
    expect([badgeText(1), badgeText(45), badgeText(99), badgeText(100), badgeText(1234)]).toEqual(['1', '45', '99', '99+', '99+']);
  });
  it('syncBadge uses the counts endpoint and caps at 99', async () => {
    const nav = { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal('navigator', nav);
    try {
      vi.mocked(api).mockReset().mockResolvedValue({ unread: 45, categories: [] });
      await syncBadge();
      expect(api).toHaveBeenCalledWith('/api/notifications/feed?limit=0');
      expect(nav.setAppBadge).toHaveBeenLastCalledWith(45); // every unread entry: the legacy list's 30 are no cap any more
      vi.mocked(api).mockResolvedValue({ unread: 250, categories: [] });
      await syncBadge();
      expect(nav.setAppBadge).toHaveBeenLastCalledWith(99);
      vi.mocked(api).mockRejectedValue(new Error('401'));
      await syncBadge();
      expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('kids profiles never ask for notifications: the badge is 0', async () => {
    const nav = { setAppBadge: vi.fn().mockResolvedValue(undefined), clearAppBadge: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal('navigator', nav);
    kidsMode.set(true);
    vi.mocked(api).mockClear();
    try {
      await syncBadge();
      expect(api).not.toHaveBeenCalled();
      expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
    } finally { kidsMode.set(false); vi.unstubAllGlobals(); }
  });
});
