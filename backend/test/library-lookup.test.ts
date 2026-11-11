// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMediaEvent } from '../src/media/events.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Jellyfin's /Items has no provider id filter (anyProviderIdEquals is ignored, the library's first items come back): the lookups by TMDB / TVDB id
// answer from an index built from a paged admin listing with fields=ProviderIds. This fake behaves like the real server: it ignores the filter.

let env: TestEnv;
let items: any[] = [];
let failListing = false;
let listings = 0;
const lib = (n: number, extra: Record<string, unknown> = {}) => ({ Id: n.toString(16).padStart(32, '0'), Name: `Fiction ${n}`, ...extra });
const listing = () => env.jfCalls.filter((c) => c.path === '/Items' && c.search.includes('fields=ProviderIds'));

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      if (u.searchParams.get('fields') !== 'ProviderIds') return { json: { Items: [] } };
      listings++;
      if (failListing) return { status: 500 };
      const types = (u.searchParams.get('includeItemTypes') ?? '').split(',');
      const start = Number(u.searchParams.get('startIndex') ?? 0), limit = Number(u.searchParams.get('limit') ?? 100);
      return { json: { Items: items.filter((i) => types.includes(i.Type)).slice(start, start + limit) } };
    },
  });
});
afterAll(() => env.close());
afterEach(() => { vi.useRealTimers(); });
beforeEach(async () => {
  await (env.ctx.jf as any).resetLibraryIndex(); // memory and kv
  vi.useRealTimers();
  items = []; failListing = false; listings = 0; env.jfCalls.length = 0;
});

describe('library lookups by provider id (index of the admin listing)', () => {
  it('finds a film and a series by TMDB id and a TVDB-only series by TVDB id; the filter parameter is not relied on', async () => {
    items = [
      lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '603', Imdb: 'tt1' } }),
      lib(2, { Type: 'Series', ProviderIds: { tmdb: '603' } }), // the same number in the series namespace
      lib(3, { Type: 'Series', ProviderIds: { Tvdb: '7001' } }),
    ];
    expect(await env.ctx.jf.findByTmdb(603, 'movie')).toEqual({ id: lib(1).Id, name: 'Fiction 1' });
    expect(await env.ctx.jf.findByTmdb(603, 'tv')).toEqual({ id: lib(2).Id, name: 'Fiction 2' });
    expect(await env.ctx.jf.findSeriesByTvdb!(7001)).toEqual({ id: lib(3).Id, name: 'Fiction 3' });
    expect(await env.ctx.jf.findByTmdb(7001, 'tv')).toBeNull(); // a TVDB id is no TMDB id
  });

  it('a miss: unknown ids, an id that only starts like a known one, items without provider ids, ids that are no positive integers', async () => {
    items = [lib(1, { Type: 'Series', ProviderIds: { Tvdb: '70012', Tmdb: '90012' } }), lib(2, { Type: 'Movie' })];
    expect(await env.ctx.jf.findSeriesByTvdb!(7001)).toBeNull();
    expect(await env.ctx.jf.findByTmdb(9001, 'tv')).toBeNull();
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).toBeNull();
    expect(await env.ctx.jf.findSeriesByTvdb!(70012)).not.toBeNull();
    listings = 0;
    expect(await env.ctx.jf.findByTmdb(0, 'movie')).toBeNull();
    expect(await env.ctx.jf.findSeriesByTvdb!(-1)).toBeNull();
    expect(listings).toBe(0);
  });

  it('a library of more than one page is listed page after page', async () => {
    items = Array.from({ length: 1200 }, (_x, i) => lib(i + 1, { Type: i % 2 ? 'Series' : 'Movie', ProviderIds: { Tmdb: String(100000 + i) } }));
    expect(await env.ctx.jf.findByTmdb(100000 + 1199, 'tv')).toEqual({ id: lib(1200).Id, name: 'Fiction 1200' }); // on the third page
    expect(await env.ctx.jf.findByTmdb(100000 + 600, 'movie')).toEqual({ id: lib(601).Id, name: 'Fiction 601' });
    expect(listing().length).toBe(3);
  });

  it('the index is reused (kv), and concurrent first lookups share one build', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    await Promise.all([env.ctx.jf.findByTmdb(5, 'movie'), env.ctx.jf.findByTmdb(6, 'movie'), env.ctx.jf.findSeriesByTvdb!(7)]);
    expect(listing().length).toBe(1);
    await env.ctx.jf.findByTmdb(5, 'movie');
    expect(listing().length).toBe(1);
    expect((await env.kv.keys('jf:provider')).length).toBe(1);
  });

  it('a failing listing throws to every waiting caller, nothing is cached, and the next call builds again', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    failListing = true;
    const r = await Promise.allSettled([env.ctx.jf.findByTmdb(5, 'movie'), env.ctx.jf.findSeriesByTvdb!(7)]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect(await env.kv.keys('jf:provider')).toEqual(['jf:providers:fail']); // no index, only the minute's memory of the failure
    failListing = false;
    await (env.ctx.jf as any).resetLibraryIndex();
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).toEqual({ id: lib(1).Id, name: 'Fiction 1' });
  });

  const MIN = 60_000;
  const at = (ms: number) => vi.setSystemTime(new Date(Date.parse('2026-11-11T10:00:00Z') + ms));
  const settle = () => vi.waitFor(() => { if ((env.ctx.jf as any).providerIndexBuild) throw new Error('building'); });

  it('the parsed index stays in memory: later lookups read neither kv nor the listing', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    await env.ctx.jf.findByTmdb(5, 'movie');
    const realGet = env.kv.get.bind(env.kv);
    let reads = 0;
    env.kv.get = async (k: string) => { if (k.startsWith('jf:providers')) reads++; return realGet(k); };
    try {
      for (let i = 0; i < 20; i++) await env.ctx.jf.findByTmdb(i % 2 ? 5 : 99, 'movie');
    } finally { env.kv.get = realGet; }
    expect(reads).toBe(0);
    expect(listing().length).toBe(1);
  });

  it('after a restart (memory empty) the kv copy is used and parsed once', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    await env.ctx.jf.findByTmdb(5, 'movie');
    (env.ctx.jf as any).providerMemo = null; // what a new process has
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).not.toBeNull();
    expect(listing().length).toBe(1);
  });

  it('an index past its lifetime answers at once from the stale copy and is refreshed in the background; a miss never rebuilds', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T10:00:00Z') });
    await env.ctx.jf.findByTmdb(5, 'movie');
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toBeNull(); // a miss: no rebuild however old the copy is not yet
    at(10 * MIN);
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toBeNull();
    expect(listing().length).toBe(1);
    items.push(lib(2, { Type: 'Movie', ProviderIds: { Tmdb: '6' } }));
    at(31 * MIN);
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toBeNull(); // answered from the stale copy, no waiting
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).not.toBeNull();
    await settle();
    expect(listing().length).toBe(2); // one refresh, however many lookups
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toEqual({ id: lib(2).Id, name: 'Fiction 2' });
    expect(listing().length).toBe(2);
  });

  it('a cold start (no copy anywhere) waits for the listing', async () => {
    items = [lib(1, { Type: 'Series', ProviderIds: { Tvdb: '9' } })];
    expect(await env.ctx.jf.findSeriesByTvdb!(9)).toEqual({ id: lib(1).Id, name: 'Fiction 1' });
    expect(listing().length).toBe(1);
  });

  it('a failed build is remembered for 60 s (memory and kv): lookups throw at once without listing again, then it is tried again', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T10:00:00Z') });
    failListing = true;
    await expect(env.ctx.jf.findByTmdb(5, 'movie')).rejects.toThrow();
    expect(listing().length).toBe(1);
    failListing = false;
    at(30_000);
    await expect(env.ctx.jf.findByTmdb(5, 'movie')).rejects.toThrow();
    (env.ctx.jf as any).providerFailure = null; // another process / a restart: the kv marker alone does it
    await expect(env.ctx.jf.findSeriesByTvdb!(5)).rejects.toThrow();
    expect(listing().length).toBe(1);
    at(61_000);
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).not.toBeNull();
    expect(listing().length).toBe(2);
  });

  it('a failing refresh keeps the stale copy in service', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T10:00:00Z') });
    await env.ctx.jf.findByTmdb(5, 'movie');
    failListing = true;
    at(31 * MIN);
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).not.toBeNull();
    await settle();
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).not.toBeNull(); // still answered, the failure only blocks new tries for a minute
  });

  it('the library change signal (itemAdded / itemRemoved of a film or series on the media event path) marks the index stale: the next lookup refreshes it in the background', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T10:00:00Z') });
    await env.ctx.jf.findByTmdb(5, 'movie');
    items.push(lib(2, { Type: 'Movie', ProviderIds: { Tmdb: '6' } }));
    await handleMediaEvent(env.ctx, { type: 'itemAdded', itemId: lib(2).Id, itemType: 'Movie' });
    at(2 * MIN); // past the minimum gap between refreshes
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toBeNull(); // the stale copy answers first
    await settle();
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toEqual({ id: lib(2).Id, name: 'Fiction 2' });
    expect(listing().length).toBe(2);
    await handleMediaEvent(env.ctx, { type: 'itemAdded', itemId: 'x', itemType: 'Episode' }); // an episode changes no film or series id
    await env.ctx.jf.findByTmdb(6, 'movie');
    await settle();
    expect(listing().length).toBe(2);
  });
});
