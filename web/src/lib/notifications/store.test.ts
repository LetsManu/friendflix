// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotesApi } from './api';
import { createFeed, type HeldTokens } from './store';
import type { Feed, FeedGroup, Filter } from './types';

/** unreadCount follows unread and count unless given (every entry of an unread group unread) */
const g = (id: string, over: Partial<FeedGroup> = {}): FeedGroup => {
  const base = { id, kind: 'k', category: 'other' as const, title: id, body: null, link: null, at: '2026-10-01T00:00:00Z', count: 1, unread: true, items: [{ id: Number(id.replace(/\D/g, '')) || 1, title: id, body: null, at: '2026-10-01T00:00:00Z' }], ...over };
  return { ...base, unreadCount: over.unreadCount ?? (base.unread ? base.count : 0) };
};
const page = (sections: Array<[string, string[]]>, next: string | null = null, unread = 3): Feed => ({ sections: sections.map(([key, ids]) => ({ key, groups: ids.map((i) => g(i)) })), next, unread, categories: [], max: 99 });
const fake = (over: Partial<NotesApi> = {}): NotesApi => ({
  feed: vi.fn(async () => page([['today', ['a1']]])),
  // no count reload by default (it fails: the local counts stay), so the baseline tests see the store's own arithmetic
  counts: vi.fn(async () => { throw new Error('no counts'); }),
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
    expect(await s.hide({ groups: ['a2', 'w1'] })).toEqual({ undo: 'tok', n: 1 });
    expect(ids(s)).toEqual([['today', ['a1', 'a3']]]);
    expect(await s.undo('tok')).toBe(true);
    expect(await s.undo('tok')).toBe(false); // used up
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
    expect(await s.undo('tok')).toBe(false);
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
    expect(await s.read({ groups: ['a1'] })).toBe(true);
    expect(get(s).sections[0].groups[0].unread).toBe(false);
    await s.load('all');
    expect(await s.read()).toBe(false);
    expect(markRead).toHaveBeenLastCalledWith(undefined);
    expect(get(s).sections[0].groups[0].unread).toBe(true);
    expect(get(s).error).toBe('error');
  });
  it('the state carries the unread count and the categories for the header and the chips', async () => {
    const feed = vi.fn(async () => ({ ...pageOf([bigGroup('a1', 2), bigGroup('a2', 1)], 3), categories: [{ key: 'devices' as const, n: 3 }] }));
    const s = createFeed(fake({ feed, hide: vi.fn(async () => ({ undo: 'tok', n: 2 })) }));
    await s.load('all');
    expect(get(s).unread).toBe(3);
    expect(get(s).categories).toEqual([{ key: 'devices', n: 3 }]);
    await s.read({ groups: ['a2'] });
    expect(get(s).unread).toBe(2);
    await s.hide({ groups: ['a1'] });
    expect(get(s).unread).toBe(0);
    await s.undo('tok');
    expect(get(s).unread).toBe(2);
    s.reset();
    expect(get(s)).toMatchObject({ unread: 0, categories: [] });
  });
  it('a clear and its undo reload the counts from the server (entries on pages not loaded, categories gone)', async () => {
    const feed = vi.fn(async () => ({ ...pageOf([bigGroup('a1', 1, { category: 'devices' })], 5, 'n'), categories: [{ key: 'devices' as const, n: 1 }, { key: 'series' as const, n: 9 }] }));
    const counts = vi.fn().mockResolvedValueOnce({ unread: 0, categories: [{ key: 'series', n: 9 }] }).mockResolvedValueOnce({ unread: 5, categories: [{ key: 'devices', n: 1 }, { key: 'series', n: 9 }] });
    const s = createFeed(fake({ feed, counts, hide: vi.fn(async () => ({ undo: 'tok', n: 5 })) }));
    await s.load('all');
    await s.hide({ category: 'unread' });
    expect(counts).toHaveBeenCalledTimes(1);
    await flush();
    expect(get(s)).toMatchObject({ unread: 0, categories: [{ key: 'series', n: 9 }] });
    s.noteFresh(0);
    expect(get(s).fresh).toBe(0);
    await s.undo('tok');
    expect(counts).toHaveBeenCalledTimes(2);
    expect(get(s)).toMatchObject({ unread: 5, categories: [{ key: 'devices', n: 1 }, { key: 'series', n: 9 }] });
    expect(ids(s)).toEqual([['today', ['a1']]]);
  });
  it('a count reload that answers after a reset is dropped', async () => {
    const d = deferred<{ unread: number; categories: Array<{ key: 'series'; n: number }> }>();
    const s = createFeed(fake({ counts: vi.fn(() => d.promise) }));
    await s.load('all');
    const h = s.hide({ groups: ['a1'] });
    await Promise.resolve();
    s.reset();
    d.resolve({ unread: 7, categories: [{ key: 'series', n: 7 }] });
    await h;
    expect(get(s)).toMatchObject({ unread: 0, categories: [] });
  });
  it('a clear answers (the undo toast) without waiting for the count reload', async () => {
    const d = deferred<{ unread: number; categories: Array<{ key: 'series'; n: number }> }>();
    const s = createFeed(fake({ feed: vi.fn(async () => pageOf([bigGroup('a1', 2), bigGroup('a2', 1)], 3)), counts: vi.fn(() => d.promise) }));
    await s.load('all');
    expect(await s.hide({ groups: ['a1'] })).toEqual({ undo: 'tok', n: 1 });
    expect(get(s).unread).toBe(1); // the local count until the server's arrives
    d.resolve({ unread: 4, categories: [{ key: 'series', n: 4 }] });
    await flush();
    expect(get(s)).toMatchObject({ unread: 4, categories: [{ key: 'series', n: 4 }] });
  });
  it('a failed count reload keeps the local counts', async () => {
    const s = createFeed(fake({ feed: vi.fn(async () => pageOf([bigGroup('a1', 2), bigGroup('a2', 1)], 3)), counts: vi.fn(async () => { throw new Error('x'); }) }));
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    expect(get(s).unread).toBe(1);
    expect(get(s).error).toBeNull();
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

/** lets answers already given (a count reload that runs on its own) arrive */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const bigGroup = (id: string, count: number, over: Partial<FeedGroup> = {}) => g(id, { count, ...over });
const pageOf = (groups: FeedGroup[], unread: number, next: string | null = null): Feed => ({ sections: [{ key: 'today', groups }], next, unread, categories: [], max: 99 });

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
  it('a partly read group lowers the baseline only by its unread entries (no phantom pill)', async () => {
    const feed = vi.fn(async () => pageOf([bigGroup('a1', 12, { unreadCount: 1 }), bigGroup('a2', 4)], 5));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    await s.read({ groups: ['a1'] });
    expect(get(s).unread).toBe(4);
    s.noteFresh(4); // the layout's next count: the server lowered unread by 1
    expect(get(s).fresh).toBe(0);
    await s.hide({ groups: ['a2'] });
    s.noteFresh(0);
    expect(get(s).fresh).toBe(0);
  });
  it('a failed read gives a partly read group its unread entries back', async () => {
    const feed = vi.fn(async () => pageOf([bigGroup('a1', 12, { unreadCount: 3 })], 3));
    const s = createFeed(fake({ feed, markRead: vi.fn(async () => { throw new Error('x'); }) }));
    await s.load('all');
    await s.read({ groups: ['a1'] });
    expect(get(s).sections[0]!.groups[0]).toMatchObject({ unread: true, unreadCount: 3 });
    expect(get(s).unread).toBe(3);
  });
  it('a recount arriving after the layout count corrects fresh', async () => {
    const d = deferred<{ unread: number; categories: [] }>();
    // the page thinks a1 holds 3 unread entries; another device read one of them meanwhile, so the server holds 2 there and 1 elsewhere
    const s = createFeed(fake({ feed: vi.fn(async () => pageOf([bigGroup('a1', 3)], 3)), counts: vi.fn(() => d.promise) }));
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    s.noteFresh(1); // the layout's count after the clear: 1 left on the server, the page's baseline is 0
    expect(get(s).fresh).toBe(1);
    d.resolve({ unread: 1, categories: [] });
    await flush();
    expect(get(s).unread).toBe(1);
    expect(get(s).fresh).toBe(0);
  });
  it('a reload forgets the last layout count', async () => {
    const feed = vi.fn().mockResolvedValueOnce(pageOf([bigGroup('a1', 1)], 3)).mockResolvedValueOnce(pageOf([bigGroup('a1', 1)], 1));
    const s = createFeed(fake({ feed }));
    await s.load('all');
    s.noteFresh(5);
    await s.load('all'); // another device read 4 of them meanwhile
    await s.read({ groups: ['a1'] });
    expect(get(s).fresh).toBe(0);
  });
  it('a clear or read by filter sends the first page\'s snapshot, so rows that arrived since stay', async () => {
    const hide = vi.fn(async () => ({ undo: 'tok', n: 2 }));
    const markRead = vi.fn(async () => ({ ok: true }));
    const feed = vi.fn().mockResolvedValueOnce({ ...pageOf([g('a1'), g('a9')], 3, 'c'), max: 40 }).mockResolvedValueOnce({ ...pageOf([g('b12')], 3), max: 40 })
      .mockResolvedValueOnce({ ...pageOf([g('a50')], 3), max: 55 });
    const s = createFeed(fake({ feed, hide, markRead }));
    await s.hide({ category: 'all' }); // nothing loaded: no snapshot to send
    expect(hide).toHaveBeenLastCalledWith({ category: 'all' });
    await s.load('devices');
    await s.read({ category: 'unread' });
    expect(markRead).toHaveBeenLastCalledWith({ category: 'unread', max: 40 });
    await s.more();
    await s.hide({ category: 'devices' });
    expect(hide).toHaveBeenLastCalledWith({ category: 'devices', max: 40 });
    await s.hide({ groups: ['x'] }); // ids and groups carry their own bound
    expect(hide).toHaveBeenLastCalledWith({ groups: ['x'] });
    await s.refresh();
    await s.hide({ category: 'devices' });
    expect(hide).toHaveBeenLastCalledWith({ category: 'devices', max: 55 });
    s.reset();
    await s.hide({ category: 'all' });
    expect(hide).toHaveBeenLastCalledWith({ category: 'all' });
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
    const api = fake({ feed });
    const s = createFeed(api);
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
    const unhide = api.unhide as ReturnType<typeof vi.fn>;
    await s.undo('tok'); // the token is gone: the server is not asked and nothing comes back
    expect(unhide).not.toHaveBeenCalled();
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
  it('undo after a refresh asks the server and refreshes instead of re-inserting old rows', async () => {
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1', 'a2']]])).mockResolvedValueOnce(page([['today', ['a2']]])).mockResolvedValueOnce(page([['today', ['a1', 'a2']]]));
    const api = fake({ feed });
    const s = createFeed(api);
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    await s.refresh();
    expect(ids(s)).toEqual([['today', ['a2']]]);
    await s.undo('tok');
    expect(api.unhide).toHaveBeenCalledWith('tok');
    expect(feed).toHaveBeenCalledTimes(3);
    expect(ids(s)).toEqual([['today', ['a1', 'a2']]]);
  });
  it('undo after a filter switch still undoes and refreshes', async () => {
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]])).mockResolvedValueOnce(page([['today', ['u1']]])).mockResolvedValueOnce(page([['today', ['u1', 'u2']]]));
    const api = fake({ feed });
    const s = createFeed(api);
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    await s.load('unread');
    await s.undo('tok');
    expect(api.unhide).toHaveBeenCalledWith('tok');
    expect(feed).toHaveBeenLastCalledWith({ filter: 'unread' });
    expect(ids(s)).toEqual([['today', ['u1', 'u2']]]);
  });
  it('a hide answered after a filter switch is still undoable', async () => {
    const d = deferred<{ undo: string; n: number }>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1']]])).mockResolvedValueOnce(page([['today', ['u1']]])).mockResolvedValueOnce(page([['today', ['u1', 'u3']]]));
    const api = fake({ feed, hide: vi.fn(() => d.promise) });
    const s = createFeed(api);
    await s.load('all');
    const h = s.hide({ groups: ['a1'] });
    await s.load('unread');
    d.resolve({ undo: 'late', n: 1 });
    await h;
    await s.undo('late');
    expect(api.unhide).toHaveBeenCalledWith('late');
    expect(ids(s)).toEqual([['today', ['u1', 'u3']]]);
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
  it('a reset or load while unhide is in flight restores nothing', async () => {
    for (const interrupt of [(s: ReturnType<typeof createFeed>) => s.reset(), (s: ReturnType<typeof createFeed>) => void s.load('unread')]) {
      const d = deferred<{ n: number }>();
      const feed = vi.fn().mockResolvedValueOnce(pageOf([bigGroup('a1', 2)], 2)).mockResolvedValue({ sections: [], next: null, unread: 0, categories: [] });
      const s = createFeed(fake({ feed, unhide: vi.fn(() => d.promise) }));
      await s.load('all');
      await s.hide({ groups: ['a1'] });
      const u = s.undo('tok');
      interrupt(s);
      d.resolve({ n: 1 });
      await u;
      await new Promise((r) => setTimeout(r));
      expect(ids(s)).toEqual([]);
      s.noteFresh(2);
      expect(get(s).fresh).toBe(2); // the baseline was not raised again
    }
  });
});

describe('notifications feed store: token lifetime, answers after a reset', () => {
  afterEach(() => vi.useRealTimers());
  it('a token older than 30 s is not sent to the server', async () => {
    vi.useFakeTimers();
    const api = fake();
    const s = createFeed(api);
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    vi.advanceTimersByTime(31_000);
    await s.undo('tok');
    expect(api.unhide).not.toHaveBeenCalled();
    expect(ids(s)).toEqual([]);
  });
  it('100 hides over time keep only the tokens of the last 30 s', async () => {
    vi.useFakeTimers();
    let n = 0;
    const api = fake({ hide: vi.fn(async () => ({ undo: `t${n++}`, n: 1 })) });
    const held: HeldTokens = new Map();
    const s = createFeed(api, held);
    await s.load('all');
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(1_000);
      await s.hide({ groups: [`x${i}`] });
    }
    expect(held.size).toBeGreaterThan(0);
    expect(held.size).toBeLessThanOrEqual(31);
    await s.undo('t0');
    expect(api.unhide).not.toHaveBeenCalled();
    await s.undo('t99');
    expect(api.unhide).toHaveBeenCalledWith('t99');
  });
  it('a failed unhide after a reset leaves the reset state alone', async () => {
    const d = deferred<{ n: number }>();
    const s = createFeed(fake({ unhide: vi.fn(() => d.promise) }));
    await s.load('all');
    await s.hide({ groups: ['a1'] });
    const u = s.undo('tok');
    s.reset();
    d.reject(new Error('x'));
    await u;
    expect(get(s)).toMatchObject({ sections: [], error: null });
  });
  it('a failed hide or read after a reset leaves the next page alone', async () => {
    const h = deferred<{ undo: string; n: number }>();
    const r = deferred<unknown>();
    const feed = vi.fn().mockResolvedValueOnce(page([['today', ['a1', 'a2']]])).mockResolvedValueOnce(pageOf([g('a1', { unread: false })], 0));
    const s = createFeed(fake({ feed, hide: vi.fn(() => h.promise), markRead: vi.fn(() => r.promise) }));
    await s.load('all');
    const hid = s.hide({ groups: ['a2'] });
    const read = s.read({ groups: ['a1'] });
    s.reset();
    await s.load('all');
    h.reject(new Error('x'));
    r.reject(new Error('x'));
    await Promise.all([hid, read]);
    expect(ids(s)).toEqual([['today', ['a1']]]);
    expect(get(s).sections[0].groups[0].unread).toBe(false);
    expect(get(s).error).toBeNull();
  });
});
