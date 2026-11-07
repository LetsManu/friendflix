// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const calls: Array<{ path: string; body?: { ids: string[] } }> = [];
let answer: (ids: string[]) => unknown = () => ({ badges: {} });
let profile = 'p1';
let storyAnswer: unknown = { story: null };
vi.mock('#lib/api', () => ({
  getActiveProfile: () => profile,
  api: vi.fn(async (path: string, o?: { body?: { ids: string[] } }) => {
    calls.push({ path, body: o?.body });
    if (path.endsWith('/story')) return storyAnswer;
    if (path.endsWith('/facts')) return { fresh: null, leaving: null, traits: null };
    return answer(o?.body?.ids ?? []);
  }),
}));

const mod = () => import('./fresh');
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { calls.length = 0; answer = (ids) => ({ badges: Object.fromEntries(ids.filter((i) => i === 'a').map((i) => [i, { fresh: 'new' }])) }); });

describe('badge batching', () => {
  it('asks of one frame go out as ONE request, answers fill the store, silent ids become {}', async () => {
    const { wantBadge, badges } = await mod();
    wantBadge('a'); wantBadge('b'); wantBadge('a');
    await tick();
    expect(calls.filter((c) => c.path === '/api/discover/badges')).toHaveLength(1);
    expect(calls[0]!.body!.ids.sort()).toEqual(['a', 'b']);
    expect(get(badges)).toMatchObject({ a: { fresh: 'new' }, b: {} });
  });
  it('does not ask again within five minutes, but does afterwards', async () => {
    const { wantBadge } = await mod();
    const t0 = Date.now() + 10 * 60_000; // fresh module state is shared: use a far future clock
    wantBadge('c', t0); await tick();
    const n = calls.length;
    wantBadge('c', t0 + 60_000); await tick();
    expect(calls.length).toBe(n);
    wantBadge('c', t0 + 6 * 60_000); await tick();
    expect(calls.length).toBe(n + 1);
  });
  it('a failed request marks the ids as failed (null) so cards fall back to the old hints', async () => {
    const { wantBadge, badges } = await mod();
    answer = () => { throw new Error('down'); };
    wantBadge('f1', Date.now() + 99 * 60_000); await tick();
    expect(get(badges)['f1']).toBeNull();
  });
  it('a profile switch forgets everything (nothing leaks between profiles)', async () => {
    const { wantBadge, badges } = await mod();
    wantBadge('p1only', Date.now() + 200 * 60_000); await tick();
    expect('p1only' in get(badges)).toBe(true);
    profile = 'p2';
    wantBadge('x', Date.now() + 200 * 60_000);
    expect('p1only' in get(badges)).toBe(false);
    await tick();
  });
  it('ignores empty ids', async () => {
    const { wantBadge } = await mod();
    const n = calls.length;
    wantBadge(undefined); wantBadge(''); await tick();
    expect(calls.length).toBe(n);
  });
});

describe('facts memo', () => {
  it('one request per title and five minutes; forgetFacts drops it', async () => {
    const { loadFacts, forgetFacts } = await mod();
    const t0 = Date.now() + 500 * 60_000;
    await loadFacts('z', t0); await loadFacts('z', t0 + 1000);
    expect(calls.filter((c) => c.path === '/api/items/z/facts')).toHaveLength(1);
    forgetFacts('z');
    await loadFacts('z', t0 + 2000);
    expect(calls.filter((c) => c.path === '/api/items/z/facts')).toHaveLength(2);
  });
});

describe('story card', () => {
  const story = { reason: 'newSeason' as const, episode: { id: 'e1', name: 'N', season: 1, index: 3, overview: '' }, next: { id: 'e2', season: 2, index: 1 } };
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    profile = 'p1'; storyAnswer = { story };
  });

  it('keys a dismissal per profile, series and next episode', async () => {
    const { storyDismissKey } = await mod();
    expect(storyDismissKey('s1', story)).toBe('ff-story:p1:s1:e2');
    profile = '';
    expect(storyDismissKey('s1', story)).toBe('ff-story:-:s1:e2');
  });

  it('loads the story until the viewer dismissed that very card', async () => {
    const { loadStory, storyDismissKey, storyDismissed } = await mod();
    expect(await loadStory('s1')).toEqual(story);
    expect(calls.at(-1)!.path).toBe('/api/items/s1/story');
    store.set(storyDismissKey('s1', story), '1');
    expect(storyDismissed('s1', story)).toBe(true);
    expect(await loadStory('s1')).toBeNull();
    expect(await loadStory('s2')).toEqual(story); // other series
    profile = 'p2';
    expect(await loadStory('s1')).toEqual(story); // other profile
  });

  it('is null when there is no story or the request failed', async () => {
    const { loadStory } = await mod();
    storyAnswer = { story: null };
    expect(await loadStory('s1')).toBeNull();
    storyAnswer = null;
    expect(await loadStory('s1')).toBeNull();
  });

  it('counts as not dismissed when storage is unavailable', async () => {
    const { storyDismissed } = await mod();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(storyDismissed('s1', story)).toBe(false);
  });
});
