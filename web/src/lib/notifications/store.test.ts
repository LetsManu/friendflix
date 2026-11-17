// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import type { NotesApi } from './api';
import { createFeed } from './store';
import type { Feed, FeedGroup, Filter } from './types';

const g = (id: string, over: Partial<FeedGroup> = {}): FeedGroup => ({ id, kind: 'k', category: 'other', title: id, body: null, link: null, at: '2026-10-01T00:00:00Z', count: 1, unread: true, items: [{ id: Number(id.replace(/\D/g, '')) || 1, title: id, body: null, at: '2026-10-01T00:00:00Z' }], ...over });
const page = (sections: Array<[string, string[]]>, next: string | null = null, unread = 3): Feed => ({ sections: sections.map(([key, ids]) => ({ key, groups: ids.map((i) => g(i)) })), next, unread, categories: [] });
const fake = (over: Partial<NotesApi> = {}): NotesApi => ({
  feed: vi.fn(async () => page([['today', ['a1']]])),
  counts: vi.fn(async () => ({ unread: 0, categories: [] })),
  markRead: vi.fn(async () => ({ ok: true })),
  hide: vi.fn(async () => ({ undo: 'tok', n: 1 })),
  unhide: vi.fn(async () => ({ n: 1 })),
  ...over,
});
const ids = (s: ReturnType<typeof createFeed>) => get(s).sections.map((x) => [x.key, x.groups.map((y) => y.id)]);

describe('notifications feed store', () => {
  it('more appends below and merges a section', async () => {
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']], ['2026-10', ['b1', 'b2']]], 'c1')).mockResolvedValueOnce(page([['2026-10', ['b3']], ['2026-09', ['c1']]]));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    await s.more();
    expect(ids(s)).toEqual([['today', ['a1']], ['2026-10', ['b1', 'b2', 'b3']], ['2026-09', ['c1']]]);
    expect(get(s).next).toBeNull();
    expect(feed).toHaveBeenLastCalledWith({ filter: 'all', cursor: 'c1' });
  });
  it('noteFresh never inserts rows', async () => {
    const s = createFeed(fake());
    await s.load('all');
    const before = ids(s);
    s.noteFresh(5);
    expect(get(s).fresh).toBe(2);
    expect(ids(s)).toEqual(before);
    s.noteFresh(1);
    expect(get(s).fresh).toBe(0);
  });
  it('refresh replaces the first page and resets fresh', async () => {
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]])).mockResolvedValueOnce(page([['today', ['a9', 'a1']]], null, 4));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    s.toggle('a1');
    s.noteFresh(4);
    await s.refresh();
    expect(ids(s)).toEqual([['today', ['a9', 'a1']]]);
    expect(get(s).fresh).toBe(0);
    expect(get(s).open.has('a1')).toBe(true);
    s.toggle('a1');
    expect(get(s).open.size).toBe(0);
  });
  it('hide removes optimistically and undo puts the group back in place', async () => {
    const s = createFeed(fake({ feed: vi.fn(async () => page([['today', ['a1', 'a2', 'a3']], ['week', ['w1']]])) }));
    await s.load('all');
    expect(await s.hide({ groups: ['a2', 'w1'] })).toBe('tok');
    expect(ids(s)).toEqual([['today', ['a1', 'a3']]]);
    await s.undo('tok');
    expect(ids(s)).toEqual([['today', ['a1', 'a2', 'a3']], ['week', ['w1']]]);
  });
  it('a failed hide puts the group back and sets error', async () => {
    const s = createFeed(fake({ feed: vi.fn(async () => page([['today', ['a1', 'a2']]])), hide: vi.fn(async () => { throw new Error('x'); }) }));
    await s.load('all');
    expect(await s.hide({ groups: ['a1'] })).toBeNull();
    expect(ids(s)).toEqual([['today', ['a1', 'a2']]]);
    expect(get(s).error).toBe('error');
  });
  it('an expired undo keeps the entries cleared', async () => {
    const s = createFeed(fake({ unhide: vi.fn(async () => { throw new Error('x'); }) }));
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    await s.undo('tok');
    expect(ids(s)).toEqual([]);
    expect(get(s).error).toBe('error');
  });
  it('filter change reloads from the first page', async () => {
    const feed = vi.fn(async ({ filter }: { filter: Filter }) => page([['today', [filter === 'all' ? 'a1' : 'u1']]]));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    await s.load('unread');
    expect(feed).toHaveBeenLastCalledWith({ filter: 'unread' });
    expect(ids(s)).toEqual([['today', ['u1']]]);
    expect(get(s).filter).toBe('unread');
  });
  it('read marks locally, reverts on failure', async () => {
    const markRead = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('x'));
    const s = createFeed(fake({ markRead }));
    await s.load('all');
    await s.read({ groups: ['a1'] });
    expect(get(s).sections[0].groups[0].unread).toBe(false);
    await s.load('all');
    await s.read();
    expect(markRead).toHaveBeenLastCalledWith(undefined);
    expect(get(s).sections[0].groups[0].unread).toBe(true);
    expect(get(s).error).toBe('error');
  });
  it('a failed first load and a failed more set error', async () => {
    const feed = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(page([['today', ['a1']]], 'n')).mockRejectedValueOnce(new Error('x'));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    expect(get(s).error).toBe('error');
    await s.load('all');
    await s.more();
    expect(get(s).error).toBe('error');
    expect(get(s).loading).toBe('idle');
  });
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const bigGroup = (id: string, count: number, over: Partial<FeedGroup> = {}) => g(id, { count, ...over });
const pageOf = (groups: FeedGroup[], unread: number, next: string | null = null): Feed => ({ sections: [{ key: 'today', groups }], next, unread, categories: [] });

describe('notifications feed store: baseline, reset, concurrency', () => {
  it('noteFresh counts against the baseline lowered by local read and hide', async () => {
    const feed = vi.fn(async () => pageOf([bigGroup('a1', 2), bigGroup('a2', 1)], 3));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    await s.read();
    s.noteFresh(2);
    expect(get(s).fresh).toBe(2);
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    s.noteFresh(3); // 3 unread now, the page knew 3 and 2 of them are gone: one entry was added... 3 - 1 = 2
    expect(get(s).fresh).toBe(2);
  });
  it('a failed read or hide and an undo restore the baseline', async () => {
    const feed = vi.fn(async () => pageOf([bigGroup('a1', 2), bigGroup('a2', 1)], 3));
    const s = createFeed(fake({ feed, markRead: vi.fn(async () => { throw new Error('x'); }), hide: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({ undo: 'tok', n: 1 }) }));
    await s.load('all');
    await s.read();
    s.noteFresh(3);
    expect(get(s).fresh).toBe(0);
    await s.hide({ groups: ['a1'] });
    s.noteFresh(3);
    expect(get(s).fresh).toBe(0);
    await s.hide({ groups: ['a1'] });
    s.noteFresh(3);
    expect(get(s).fresh).toBe(2);
    await s.undo('tok');
    s.noteFresh(3);
    expect(get(s).fresh).toBe(0);
  });
  it('reset empties everything and load clears rows at once', async () => {
    const d = deferred<Feed>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]])).mockReturnValueOnce(d.promise);
    const s = createFeed(fake({ feed }));
    await s.load('all');
    s.toggle('a1');
    await s.hide({ groups: ['a1'] });
    const p = s.load('unread');
    expect(get(s).sections).toEqual([]);
    expect(get(s).loading).toBe('first');
    expect(get(s).open.size).toBe(0);
    d.resolve(page([['today', ['u1']]]));
    await p;
    s.toggle('u1');
    s.reset();
    expect(get(s)).toMatchObject({ filter: 'all', sections: [], next: null, loading: 'idle', error: null, fresh: 0 });
    expect(get(s).open.size).toBe(0);
    await s.undo('tok'); // the token is gone: nothing comes back
    expect(get(s).sections).toEqual([]);
  });
  it('a reset during a load drops its answer', async () => {
    const d = deferred<Feed>();
    const s = createFeed(fake({ feed: vi.fn(() => d.promise) }));
    const p = s.load('all');
    s.reset();
    d.resolve(page([['today', ['a1']]]));
    await p;
    expect(get(s).sections).toEqual([]);
  });
  it('a filter change during an in-flight more never mixes results', async () => {
    const d = deferred<Feed>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]], 'n')).mockReturnValueOnce(d.promise).mockResolvedValueOnce(page([['today', ['u1']]]));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    const m = s.more();
    await s.load('unread');
    d.resolve(page([['today', ['a2']]], 'n2'));
    await m;
    expect(ids(s)).toEqual([['today', ['u1']]]);
    expect(get(s).next).toBeNull();
    expect(get(s).loading).toBe('idle');
  });
  it('two more() calls hit the api once', async () => {
    const d = deferred<Feed>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]], 'n')).mockReturnValueOnce(d.promise);
    const s = createFeed(fake({ feed }));
    await s.load('all');
    const m1 = s.more();
    const m2 = s.more();
    d.resolve(page([['today', ['a2']]]));
    await Promise.all([m1, m2]);
    expect(feed).toHaveBeenCalledTimes(2);
    expect(ids(s)).toEqual([['today', ['a1', 'a2']]]);
  });
  it('a merged section drops groups it already has', async () => {
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1', 'a2']]], 'n')).mockResolvedValueOnce(page([['today', ['a2', 'a3']]]));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    await s.more();
    expect(ids(s)).toEqual([['today', ['a1', 'a2', 'a3']]]);
  });
  it('a failed read puts back only the groups it flipped', async () => {
    const d = deferred<unknown>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]], 'n')).mockResolvedValueOnce(page([['today', ['a2']]]));
    const s = createFeed(fake({ feed, markRead: vi.fn(() => d.promise) }));
    await s.load('all');
    const r = s.read({ groups: ['a1'] });
    await s.more();
    d.reject(new Error('x'));
    await r;
    expect(ids(s)).toEqual([['today', ['a1', 'a2']]]);
    expect(get(s).sections[0].groups.map((x) => x.unread)).toEqual([true, true]);
  });
  it('a filter switch or refresh invalidates undo tokens', async () => {
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1', 'a2']]])).mockResolvedValueOnce(page([['today', ['a2']]]));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    await s.refresh();
    await s.undo('tok'); // the server may undo it, but this page does not know it: no row is put back from the old page
    expect(ids(s)).toEqual([['today', ['a2']]]);
  });
  it('a hide answered after a filter switch leaves no stale token', async () => {
    const d = deferred<{ undo: string; n: number }>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]])).mockResolvedValueOnce(page([['today', ['u1']]]));
    const s = createFeed(fake({ feed, hide: vi.fn(() => d.promise) }));
    await s.load('all');
    const h = s.hide({ groups: ['a1'] });
    await s.load('unread');
    d.resolve({ undo: 'late', n: 1 });
    await h;
    await s.undo('late');
    expect(ids(s)).toEqual([['today', ['u1']]]);
  });
  it('ids hide a group only when all its rows are known', async () => {
    const feed = vi.fn(async () => pageOf([g('a1', { count: 3, items: [{ id: 1, title: 't', body: null, at: '' }] }), g('a2', { id: 'a2', count: 1, items: [{ id: 2, title: 't', body: null, at: '' }] })], 2));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    await s.hide({ ids: [1, 2] });
    expect(ids(s)).toEqual([['today', ['a1']]]);
  });
  it('undo keeps the token after a transient error and drops it on undo_expired', async () => {
    const { ApiError } = await import('#lib/api');
    const unhide = vi.fn().mockRejectedValueOnce(new Error('net')).mockResolvedValueOnce({ n: 1 });
    const s = createFeed(fake({ unhide }));
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    await s.undo('tok');
    expect(ids(s)).toEqual([]);
    await s.undo('tok');
    expect(ids(s)).toEqual([['today', ['a1']]]);
    const gone = createFeed(fake({ unhide: vi.fn(async () => { throw new ApiError(404, { error: 'undo_expired' }); }) }));
    await gone.load('all');
    await gone.hide({ groups: ['a1'] });
    await gone.undo('tok');
    expect(get(gone).error).toBe('undo_expired');
    await gone.undo('tok');
    expect(ids(gone)).toEqual([]);
  });
  it('refresh keeps the rows and reports its own loading state', async () => {
    const d = deferred<Feed>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]])).mockReturnValueOnce(d.promise);
    const s = createFeed(fake({ feed }));
    await s.load('all');
    const p = s.refresh();
    expect(get(s).loading).toBe('refresh');
    expect(ids(s)).toEqual([['today', ['a1']]]);
    d.resolve(page([['today', ['a9']]]));
    await p;
    expect(ids(s)).toEqual([['today', ['a9']]]);
  });
});
