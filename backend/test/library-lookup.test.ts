// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  for (const k of await env.kv.keys('jf:provider')) await env.kv.del(k);
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
    expect(await env.kv.keys('jf:provider')).toEqual([]);
    failListing = false;
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).toEqual({ id: lib(1).Id, name: 'Fiction 1' });
  });

  it('a miss against an index older than a minute builds it once more (a title added since is found), a fresh index is not rebuilt for a miss', async () => {
    items = [lib(1, { Type: 'Movie', ProviderIds: { Tmdb: '5' } })];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-11T10:00:00Z') });
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toBeNull();
    expect(await env.ctx.jf.findByTmdb(7, 'movie')).toBeNull();
    expect(listing().length).toBe(1); // a second miss within the minute: no new listing
    items.push(lib(2, { Type: 'Movie', ProviderIds: { Tmdb: '6' } }));
    vi.setSystemTime(new Date('2026-11-11T10:01:30Z'));
    expect(await env.ctx.jf.findByTmdb(5, 'movie')).not.toBeNull(); // a hit never rebuilds
    expect(listing().length).toBe(1);
    expect(await env.ctx.jf.findByTmdb(6, 'movie')).toEqual({ id: lib(2).Id, name: 'Fiction 2' });
    expect(listing().length).toBe(2);
  });
});
