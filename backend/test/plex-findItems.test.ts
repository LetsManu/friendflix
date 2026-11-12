// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plex parity of "Can this profile see it?": MediaAdmin.findItems through the section search (librarySectionTitle = the library),
 * the title check and the library counts over the Plex mirror.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { DEFAULT_ROLES } from '../src/roles.js';
import type { ProfileRow, UserRow } from '../src/types.js';
import { checkTitles, libraryCounts } from '../src/viewcheck.js';
import { PLEX_TOKEN } from './plexfake.js';
import { identity, item, kids, plexEnv, section, type PlexEnv } from './plex/setup.js';

let e: PlexEnv;
const rk: Record<string, string> = {};
const sec: Record<string, number> = {};

beforeAll(async () => {
  e = await plexEnv((f) => {
    sec.filme = f.addSection('Filme', 'movie');
    sec.serien = f.addSection('Serien', 'show');
    sec.kinder = f.addSection('Kinder', 'movie');
    rk.wren = f.addMovie({ title: 'Wrenfield Pier', year: 2019, sectionId: sec.filme });
    rk.dun = f.addShow({ title: 'Dunmoor', rating: 'de/16', sectionId: sec.serien }).show;
    rk.salt = f.addMovie({ title: 'Saltwater Almanac', rating: 'de/6', year: 2021, sectionId: sec.kinder });
  });
});
afterAll(async () => { await e.close(); });

describe('Plex MediaAdmin.findItems', () => {
  it('maps librarySectionTitle, type, year and the raw contentRating', async () => {
    const hits = await e.ms.admin.findItems!('Dunmoor', 8);
    expect(hits).toEqual([{ id: item(rk.dun!), name: 'Dunmoor', year: e.fake.items.get(rk.dun!)!.year, type: 'Series', rating: 'de/16', library: 'Serien' }]);
    const films = await e.ms.admin.findItems!('Wrenfield', 8);
    expect(films).toEqual([{ id: item(rk.wren!), name: 'Wrenfield Pier', year: 2019, type: 'Movie', rating: null, library: 'Filme' }]);
  });

  it('searches every film and series section with the admin token in the header; limit holds; no token in the answer', async () => {
    e.fake.calls = [];
    const hits = await e.ms.admin.findItems!('a', 2); // Saltwater Almanac, Dunmoor, the fixtures' titles with an "a" …
    expect(hits).toHaveLength(2);
    const calls = e.fake.calls.filter((c) => /^\/library\/sections\/\d+\/search$/.test(c.path));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.token === PLEX_TOKEN && !c.search.includes(PLEX_TOKEN))).toBe(true);
    expect(JSON.stringify(hits)).not.toContain(PLEX_TOKEN);
  });

  it('a failing search names neither the query nor the token', async () => {
    e.fake.fail = { re: /\/search$/, status: 500 };
    try {
      const err = await e.ms.admin.findItems!('Dunmoor', 8).then(() => null, (x: Error) => x);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).not.toContain('Dunmoor');
      expect(err!.message).not.toContain(PLEX_TOKEN);
    } finally {
      e.fake.fail = null;
    }
  });
});

describe('Plex title check and library counts', () => {
  let n = 0;
  const kv = new Map<string, string>();
  const ctxOf = (): Ctx => ({
    db: e.pool, roles: DEFAULT_ROLES, jf: e.ms,
    kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => void kv.set(k, v) },
  }) as unknown as Ctx;
  async function account(role: string, jf: string): Promise<UserRow> {
    const u = (await e.pool.query<UserRow>(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), $1, null, 'Ben Muster', $2, $3, $1, '') returning *`, [`plex-${++n}`, role, jf])).rows[0]!;
    await e.pool.query("insert into profiles(id, user_id, name, is_owner) values ($1, $1, 'Ben', true)", [u.id]);
    return u;
  }
  const owner = async (u: UserRow) => (await e.pool.query<ProfileRow>('select * from profiles where id=$1', [u.id])).rows[0]!;

  it('a guest (FSK 12) does not see de/16: why rating; de/6 visible', async () => {
    const ident = await identity(e.ms, 'guest');
    const u = await account('guest', ident.jellyfin_user_id);
    const hits = await checkTitles(ctxOf(), u, await owner(u), 'Dunmoor');
    expect(hits).toEqual([{ id: item(rk.dun!), name: 'Dunmoor', year: e.fake.items.get(rk.dun!)!.year, type: 'Series', visible: false, why: 'rating', rating: 'de/16', library: 'Serien' }]);
    expect((await checkTitles(ctxOf(), u, await owner(u), 'Saltwater'))[0]).toMatchObject({ visible: true, why: null, library: 'Kinder' });
    // unrated under a grown-up's cap: hidden on Plex, but no reason of spec §4.2 fits (unrated_kids is for kids profiles only)
    expect((await checkTitles(ctxOf(), u, await owner(u), 'Wrenfield'))[0]).toMatchObject({ visible: false, why: null, library: 'Filme' });
  });

  it('a kids profile (FSK 12): the unrated film is unrated_kids', async () => {
    const parent = await identity(e.ms, 'friend');
    const u = await account('friend', parent.jellyfin_user_id);
    const kid = await identity(e.ms, 'friend', kids(12));
    const p = (await e.pool.query<ProfileRow>(
      `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
       values (gen_random_uuid(), $1, 'Kiddo', $2, 'kiddo', '', true, 12) returning *`, [u.id, kid.jellyfin_user_id])).rows[0]!;
    expect((await checkTitles(ctxOf(), u, p, 'Wrenfield'))[0]).toMatchObject({ visible: false, why: 'unrated_kids', library: 'Filme' });
  });

  it('library counts: items with limit 0 still count (seen as the profile, total as the service user)', async () => {
    const svc = await identity(e.ms, 'admin');
    await account('admin', svc.jellyfin_user_id); // the service user (first active admin)
    const ident = await identity(e.ms, 'guest');
    const u = await account('guest', ident.jellyfin_user_id);
    const r = await e.ms.items(ident, { parentId: section(sec.serien!), limit: 0 });
    expect(r).toEqual({ items: [], total: 0 }); // de/16 above the guest's FSK 12
    expect((await e.ms.items(ident, { parentId: section(sec.kinder!), limit: 0 })).total).toBe(1);
    const libs = await libraryCounts(ctxOf(), u, await owner(u));
    expect(libs.filter((l) => ['Filme', 'Serien', 'Kinder'].includes(l.name))).toEqual([
      // Plex hides unrated titles under any age cap (access.ts visibleSql), not only for kids profiles
      { id: section(sec.filme!), name: 'Filme', visible: true, seen: 0, total: 1 },
      { id: section(sec.serien!), name: 'Serien', visible: true, seen: 0, total: 1 },
      { id: section(sec.kinder!), name: 'Kinder', visible: true, seen: 1, total: 1 },
    ]);
  });
});
