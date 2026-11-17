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
