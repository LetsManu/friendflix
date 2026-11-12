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
import { checkItem, checkTitles, libraryCounts } from '../src/viewcheck.js';
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
    // ratings Plex's own table reads (plex/access.ts) but the app's generic reading does not
    rk.gb = f.addMovie({ title: 'Wrenfield Pier 2', rating: 'gb/12A', sectionId: sec.filme });
    rk.au = f.addMovie({ title: 'Wrenfield Pier 3', rating: 'au/MA15+', sectionId: sec.filme });
    rk.ca = f.addMovie({ title: 'Wrenfield Pier 4', rating: 'ca/14A', sectionId: sec.filme });
    rk.approved = f.addMovie({ title: 'Wrenfield Pier 5', rating: 'Approved', sectionId: sec.filme });
  });
});
afterAll(async () => { await e.close(); });

describe('Plex MediaAdmin.findItems', () => {
  it('maps librarySectionTitle, type, year and the raw contentRating', async () => {
    const hits = await e.ms.admin.findItems!('Dunmoor', 8);
    expect(hits).toEqual([{ id: item(rk.dun!), name: 'Dunmoor', year: e.fake.items.get(rk.dun!)!.year, type: 'Series', rating: 'de/16', age: 16, library: 'Serien' }]);
    const films = await e.ms.admin.findItems!('Wrenfield Pier', 8);
    expect(films[0]).toEqual({ id: item(rk.wren!), name: 'Wrenfield Pier', year: 2019, type: 'Movie', rating: null, age: null, library: 'Filme' });
  });

  it('carries the age the adapter enforces (Plex rating table), null for unrated and unknown spellings', async () => {
    const hits = await e.ms.admin.findItems!('Wrenfield Pier ', 8);
    const age = Object.fromEntries(hits.map((h) => [h.rating, h.age]));
    expect(age).toEqual({ 'gb/12A': 12, 'au/MA15+': 15, 'ca/14A': 14, Approved: null });
  });

  it('ranks exact title matches first across sections before cutting', async () => {
    const extra = Array.from({ length: 9 }, (_, i) => e.fake.addMovie({ title: `Dunmoor ${i + 2}`, sectionId: sec.filme })); // section before Serien
    try {
      const hits = await e.ms.admin.findItems!('dunmoor', 8);
      expect(hits).toHaveLength(8);
      expect(hits[0]).toMatchObject({ id: item(rk.dun!), name: 'Dunmoor', library: 'Serien' });
    } finally {
      for (const k of extra) e.fake.remove(k);
    }
  });

  it('findItem: one title by id with the admin token (library, age); unknown or foreign ids are null', async () => {
    expect(await e.ms.admin.findItem!(item(rk.dun!))).toEqual({ id: item(rk.dun!), name: 'Dunmoor', year: e.fake.items.get(rk.dun!)!.year, type: 'Series', rating: 'de/16', age: 16, library: 'Serien' });
    expect(await e.ms.admin.findItem!(item(rk.au!))).toMatchObject({ rating: 'au/MA15+', age: 15, library: 'Filme' });
    expect(await e.ms.admin.findItem!(item(99999))).toBeNull();
    expect(await e.ms.admin.findItem!(section(sec.filme!))).toBeNull();
    expect(await e.ms.admin.findItem!('a'.repeat(32))).toBeNull();
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
    expect((await checkTitles(ctxOf(), u, await owner(u), 'Saltwater Almanac'))[0]).toMatchObject({ visible: true, why: null, library: 'Kinder' });
    // Plex hides unrated (and not understood) ratings under any cap: a grown-up's reason is `unrated`
    expect((await checkTitles(ctxOf(), u, await owner(u), 'Wrenfield Pier'))[0]).toMatchObject({ id: item(rk.wren!), visible: false, why: 'unrated', library: 'Filme' });
    expect(await checkItem(ctxOf(), u, await owner(u), item(rk.approved!))).toEqual([
      { id: item(rk.approved!), name: 'Wrenfield Pier 5', year: 2020, type: 'Movie', visible: false, why: 'unrated', rating: 'Approved', library: 'Filme' },
    ]);
    // gb/12A is FSK 12 for Plex: visible to the guest
    expect(await checkItem(ctxOf(), u, await owner(u), item(rk.gb!))).toMatchObject([{ visible: true, why: null }]);
    expect(await checkItem(ctxOf(), u, await owner(u), item(424242))).toEqual([]);
  });

  it('a kids profile (FSK 12): the unrated film is unrated_kids', async () => {
    const parent = await identity(e.ms, 'friend');
    const u = await account('friend', parent.jellyfin_user_id);
    const kid = await identity(e.ms, 'friend', kids(12));
    const p = (await e.pool.query<ProfileRow>(
      `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
       values (gen_random_uuid(), $1, 'Kiddo', $2, 'kiddo', '', true, 12) returning *`, [u.id, kid.jellyfin_user_id])).rows[0]!;
    expect((await checkTitles(ctxOf(), u, p, 'Wrenfield Pier'))[0]).toMatchObject({ id: item(rk.wren!), visible: false, why: 'unrated_kids', library: 'Filme' });
    // rated, above the kids cap: `rating`, never `unrated_kids`
    expect(await checkItem(ctxOf(), u, p, item(rk.au!))).toMatchObject([{ visible: false, why: 'rating', rating: 'au/MA15+' }]);
    expect(await checkItem(ctxOf(), u, p, item(rk.ca!))).toMatchObject([{ visible: false, why: 'rating', rating: 'ca/14A' }]);
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
      // Plex hides unrated titles under any age cap (access.ts visibleSql), not only for kids profiles; gb/12A is seen, au/ca/Approved not
      { id: section(sec.filme!), name: 'Filme', visible: true, seen: 1, total: 5 },
      { id: section(sec.serien!), name: 'Serien', visible: true, seen: 0, total: 1 },
      { id: section(sec.kinder!), name: 'Kinder', visible: true, seen: 1, total: 1 },
    ]);
  });
});
