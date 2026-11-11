// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

// The admin-key library lookups by provider id (findByTmdb, findSeriesByTvdb) trust a hit only when the item carries that id.

let env: TestEnv;
let items: any[] = [];
let ignoreFilter = false;
beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const any = u.searchParams.get('anyProviderIdEquals');
      if (!any) return { json: { Items: [] } };
      const [k, v] = any.split('.');
      const type = u.searchParams.get('includeItemTypes');
      // ignoreFilter: the server answers with its first item of the type, whatever was asked; otherwise a substring match (older servers)
      const hits = items.filter((i) => i.Type === type && (ignoreFilter || Object.entries(i.ProviderIds ?? {}).some(([pk, pv]) => pk.toLowerCase() === k && String(pv).includes(v!))));
      return { json: { Items: hits } };
    },
  });
});
afterAll(() => env.close());

describe('library lookups by provider id', () => {
  it('a server that ignores the filter and answers with an unrelated item: not in the library', async () => {
    ignoreFilter = true;
    items = [{ Id: 'a'.repeat(32), Name: 'Unrelated', Type: 'Series', ProviderIds: { Tvdb: '1', Tmdb: '2' } }];
    try {
      expect(await env.ctx.jf.findByTmdb(7001, 'tv')).toBeNull();
      expect(await env.ctx.jf.findSeriesByTvdb!(7001)).toBeNull();
      items = [{ Id: 'a'.repeat(32), Name: 'No ids', Type: 'Movie' }];
      expect(await env.ctx.jf.findByTmdb(7001, 'movie')).toBeNull();
    } finally { ignoreFilter = false; }
  });

  it('an id that is only a prefix of the item\'s (7001 vs 70012) does not match, an exact one does, whatever the key case', async () => {
    items = [
      { Id: 'b'.repeat(32), Name: 'Prefix', Type: 'Series', ProviderIds: { Tvdb: '70012', Tmdb: '90012' } },
      { Id: 'c'.repeat(32), Name: 'Exact', Type: 'Series', ProviderIds: { TVDB: '7001', tmdb: '9001' } },
    ];
    expect(await env.ctx.jf.findSeriesByTvdb!(7001)).toEqual({ id: 'c'.repeat(32), name: 'Exact' }); // the prefix hit comes first and is skipped
    expect(await env.ctx.jf.findByTmdb(9001, 'tv')).toEqual({ id: 'c'.repeat(32), name: 'Exact' });
    items = [{ Id: 'b'.repeat(32), Name: 'Prefix', Type: 'Series', ProviderIds: { Tvdb: '70012' } }];
    expect(await env.ctx.jf.findSeriesByTvdb!(7001)).toBeNull();
  });

  it('asks for the provider ids and rejects ids that are not positive integers', async () => {
    env.jfCalls.length = 0;
    expect(await env.ctx.jf.findSeriesByTvdb!(0)).toBeNull();
    expect(await env.ctx.jf.findByTmdb(-3, 'movie')).toBeNull();
    expect(env.jfCalls.length).toBe(0);
    await env.ctx.jf.findSeriesByTvdb!(5);
    expect(env.jfCalls.at(-1)!.search).toContain('fields=ProviderIds');
  });
});
