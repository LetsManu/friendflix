// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
vi.mock('#lib/api', async (orig) => ({ ...(await orig<typeof import('#lib/api')>()), api: (...a: unknown[]) => api(...a) }));
const { cachedDetail, clearItemCache, primeDetail } = await import('#lib/api');
const { artClick, clipEnv, hoverClipAllowed, portal, previewActions, ratingLoader, releaseClick, saveFavorite } = await import('./hoverShared');

beforeEach(() => { api.mockReset(); clearItemCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

const movie = { id: 'm1', type: 'Movie', trailers: 0 };
const on = { hoverTrailers: true, hoverClip: true };
const env = { motion: true, saveData: false, hidden: false };

describe('hoverClipAllowed', () => {
  it('plays a movie or series clip, or any title with trailers', () => {
    expect(hoverClipAllowed(movie, on, env)).toBe(true);
    expect(hoverClipAllowed({ ...movie, type: 'Episode' }, on, env)).toBe(false);
    expect(hoverClipAllowed({ ...movie, type: 'Episode', trailers: 1 }, on, env)).toBe(true);
    expect(hoverClipAllowed(movie, { ...on, hoverClip: false }, env)).toBe(false);
  });
  it('respects the pref, motion, Save-Data and a hidden tab', () => {
    expect(hoverClipAllowed(movie, { ...on, hoverTrailers: false }, env)).toBe(false);
    expect(hoverClipAllowed(movie, on, { ...env, motion: false })).toBe(false);
    expect(hoverClipAllowed(movie, on, { ...env, saveData: true })).toBe(false);
    expect(hoverClipAllowed(movie, on, { ...env, hidden: true })).toBe(false);
  });
});

describe('clipEnv', () => {
  it('reads Save-Data and the hidden tab', () => {
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    vi.stubGlobal('document', { hidden: true });
    expect(clipEnv(false)).toEqual({ motion: false, saveData: true, hidden: true });
  });
  it('works without navigator / document', () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    expect(clipEnv(true)).toEqual({ motion: true, saveData: false, hidden: false });
  });
});

describe('ratingLoader', () => {
  const detail = (thumb: number) => ({ item: { id: 's1', name: 'S' }, thumb }) as never;
  it('shows the cached rating, then the fresh one, and primes the detail cache', async () => {
    primeDetail(detail(1));
    api.mockResolvedValue(detail(2));
    const seen: number[] = [];
    await ratingLoader('s1', (t) => seen.push(t)).load();
    expect(seen).toEqual([1, 2]);
    expect(api).toHaveBeenCalledWith('/api/items/s1');
    expect(cachedDetail('s1')?.thumb).toBe(2);
  });
  it('never overwrites a rating the viewer set meanwhile', async () => {
    let resolve!: (v: unknown) => void;
    api.mockReturnValue(new Promise((r) => (resolve = r)));
    const seen: number[] = [];
    const l = ratingLoader('s1', (t) => seen.push(t));
    const p = l.load();
    l.changed(-1);
    resolve(detail(2));
    await p;
    expect(seen).toEqual([]);
    expect(cachedDetail('s1')?.thumb).toBe(-1);
  });
  it('ignores a failed request', async () => {
    api.mockRejectedValue(new Error('x'));
    const seen: number[] = [];
    await ratingLoader('s1', (t) => seen.push(t)).load();
    expect(seen).toEqual([]);
  });
});

describe('saveFavorite', () => {
  it('posts or deletes and reports failures', async () => {
    api.mockResolvedValue({});
    expect(await saveFavorite('a', true)).toBe(true);
    expect(api).toHaveBeenLastCalledWith('/api/items/a/favorite', { method: 'POST' });
    expect(await saveFavorite('a', false)).toBe(true);
    expect(api).toHaveBeenLastCalledWith('/api/items/a/favorite', { method: 'DELETE' });
    api.mockRejectedValue(new Error('x'));
    expect(await saveFavorite('a', true)).toBe(false);
  });
});

describe('previewActions', () => {
  const t = ((k: string) => k) as never;
  const noop = () => undefined;
  it('favourite always, remove when removable, details when a link is given', () => {
    expect(previewActions({ fav: false, removable: false, t, toggleFav: noop, remove: noop }).map((a) => a.id)).toEqual(['fav']);
    const all = previewActions({ fav: true, removable: true, t, toggleFav: noop, remove: noop, detail: '/item/x' });
    expect(all.map((a) => a.id)).toEqual(['fav', 'remove', 'details']);
    expect(all[0]).toMatchObject({ label: 'home.card.favRemove', pressed: true });
    expect(all[2]).toMatchObject({ href: '/item/x' });
  });
});

describe('artClick', () => {
  const ev = (o: Partial<MouseEvent> & { inControl?: boolean }) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, target: { closest: () => (o.inControl ? {} : null) }, ...o }) as unknown as MouseEvent;
  it('opens on a plain click, a new tab with modifiers or the middle button, nothing on controls or the right button', () => {
    const open = vi.fn(), win = vi.fn();
    vi.stubGlobal('window', { open: win });
    artClick(ev({}), '/item/x', open);
    expect(open).toHaveBeenCalledTimes(1);
    artClick(ev({ inControl: true }), '/item/x', open);
    artClick(ev({ button: 2 }), '/item/x', open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(win).not.toHaveBeenCalled();
    artClick(ev({ ctrlKey: true }), '/item/x', open);
    artClick(ev({ button: 1 }), '/item/x', open);
    expect(win).toHaveBeenCalledTimes(2);
    expect(win).toHaveBeenCalledWith('/item/x', '_blank', 'noopener');
  });
});

describe('releaseClick and portal', () => {
  it('blurs after a mouse click only', () => {
    const blur = vi.fn();
    releaseClick({ detail: 1, currentTarget: { blur } } as unknown as MouseEvent);
    releaseClick({ detail: 0, currentTarget: { blur } } as unknown as MouseEvent);
    expect(blur).toHaveBeenCalledTimes(1);
  });
  it('moves the node to <body> and removes it again', () => {
    const appendChild = vi.fn(), remove = vi.fn();
    vi.stubGlobal('document', { body: { appendChild } });
    const node = { remove } as unknown as HTMLElement;
    const a = portal(node);
    expect(appendChild).toHaveBeenCalledWith(node);
    a.destroy();
    expect(remove).toHaveBeenCalled();
  });
});
