// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Can this profile see it?" (spec §6.4, plan ruling 1): POST /api/admin/users/:id/check (title search with the admin key, answered as
 * the profile's own identity) and GET …/check?profile= (library counts). A fake Jellyfin decides visibility per media server user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import type { MediaAdmin } from '../src/media/types.js';
import { DEFAULT_ROLES } from '../src/roles.js';
import { ageOf } from '../src/viewcheck.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
const logs: string[] = [];
const key = keyFromBase64(ENC_KEY);
const hex = (c: string) => c.repeat(32);

// libraries (CollectionFolder ids) and titles (fictional)
const FILME = hex('1'), SERIEN = hex('2'), KINDER = hex('3');
const LIBS = [{ Id: FILME, Name: 'Filme' }, { Id: SERIEN, Name: 'Serien' }, { Id: KINDER, Name: 'Kinder' }];
const DUN = hex('a'), SALT = hex('b'), WREN = hex('c');
const ITEMS = [
  { Id: DUN, Name: 'Dunmoor', Type: 'Series', ProductionYear: 2024, OfficialRating: 'FSK-16', lib: SERIEN },
  { Id: SALT, Name: 'Saltwater Almanac', Type: 'Movie', ProductionYear: 2021, OfficialRating: 'FSK-6', lib: KINDER },
  { Id: WREN, Name: 'Wrenfield Pier', Type: 'Movie', ProductionYear: 2019, lib: FILME },
];
const libName = (id: string) => LIBS.find((l) => l.Id === id)!.Name;
const dto = ({ lib: _lib, ...i }: (typeof ITEMS)[number]) => ({ ...i, UserData: { Played: false } });

// media server users and what the fake lets each of them see (anyone else, e.g. the admin, sees everything)
const GUEST_JF = hex('4'), KINO_JF = hex('5'), ANNA_JF = hex('6'), KID_JF = hex('7'), FA_JF = hex('8'), OTHER_JF = hex('9');
const SEES = new Map<string, Set<string>>([
  [GUEST_JF, new Set([SALT, WREN])], // guest: FSK 12, all libraries
  [KINO_JF, new Set([DUN, SALT])], // role kino: Kinder + Serien
  [KID_JF, new Set([SALT])], // kids profile, FSK 12: no unrated titles
  [FA_JF, new Set([WREN, SALT])], // role filmabend: Filme + Kinder
  [OTHER_JF, new Set([])],
]);
const sees = (uid: string | null, id: string) => !uid || !SEES.has(uid.toLowerCase()) || SEES.get(uid.toLowerCase())!.has(id);
const BROKEN_TERM = 'Kaputtfilm';
/** the fake's search matches every title for this term */
const ALL_TERM = 'alle';

let guest = '', kino = '', anna = '', fa = '', other = '';
const KIDS = '11111111-2222-4333-8444-555555555555';
const OTHER_KIDS = '11111111-2222-4333-8444-666666666666';

const as = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const check = (user: string, profileId: string, query: string) => as('POST', `/api/admin/users/${user}/check`, { profileId, query });
const libs = (user: string, profile: string) => as('GET', `/api/admin/users/${user}/check?profile=${profile}`);
const audits = async (target: string) => (await env.pool.query("select actor, meta from audit_log where action='user.check_viewed' and target=$1 order by id", [target])).rows;
const hit = (hits: Array<{ id: string }>, id: string) => hits.find((h) => h.id === id);
const adminSearches = () => env.jfCalls.filter((c) => c.method === 'GET' && c.path === '/Items' && /searchterm=/i.test(c.search));

async function account(role: string, jf: string, name: string): Promise<string> {
  const id = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $1, $6) returning id`,
    [`${name.toLowerCase().replace(/\W/g, '')}-sub`, `${name.split(' ')[0]!.toLowerCase()}@friend.example.com`, name, role, jf, encrypt(key, 'pw')],
  )).rows[0].id as string;
  await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name.split(' ')[0]]);
  return id;
}

beforeAll(async () => {
  env = await makeEnv({
    'GET /Library/MediaFolders': () => ({ json: { Items: LIBS } }),
    'GET /Items': (u) => {
      const sp = u.searchParams;
      const get = (k: string) => [...sp.entries()].find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1] ?? null;
      const uid = get('userId'), term = get('searchTerm'), parent = get('parentId');
      if (term === BROKEN_TERM) return { status: 500 };
      let list = ITEMS.filter((i) => sees(uid, i.Id));
      if (term && term !== ALL_TERM) list = list.filter((i) => i.Name.toLowerCase().includes(term.toLowerCase()));
      if (parent) list = list.filter((i) => i.lib === parent);
      const limit = Number(get('limit') ?? 100);
      return { json: { Items: list.slice(0, limit).map(dto), TotalRecordCount: list.length } };
    },
    'GET /Items/[0-9a-f]{32}': (u) => {
      const id = u.pathname.split('/')[2]!;
      const it = ITEMS.find((i) => i.Id === id);
      if (!it || !sees(u.searchParams.get('userId'), id)) return { status: 404 };
      return { json: dto(it) };
    },
    'GET /Items/[0-9a-f]{32}/Ancestors': (u) => {
      const it = ITEMS.find((i) => i.Id === u.pathname.split('/')[2]);
      if (!it) return { status: 404 };
      return { json: [{ Id: hex('e'), Name: 'Unterordner', Type: 'Folder' }, { Id: it.lib, Name: libName(it.lib), Type: 'CollectionFolder' }, { Id: hex('f'), Name: 'Media Folders', Type: 'AggregateFolder' }] };
    },
  }, {
    ctxPatch: (c) => {
      c.roles = {
        ...c.roles,
        kino: { ...DEFAULT_ROLES.friend!, label: 'Kino', libraries: ['Kinder', 'Serien'] },
        filmabend: { ...DEFAULT_ROLES.friend!, label: 'Filmabend', libraries: ['Filme', 'Kinder'] },
      };
    },
    logger: { stream: { write: (l: string) => void logs.push(l) }, level: 'info' },
  });
  admin = await env.login();
  guest = await account('guest', GUEST_JF, 'Ben Muster');
  kino = await account('kino', KINO_JF, 'Carla Probe');
  anna = await account('friend', ANNA_JF, 'Anna Beispiel');
  fa = await account('filmabend', FA_JF, 'Anna Zwei');
  other = await account('friend', OTHER_JF, 'Ben Zwei');
  await env.pool.query(
    `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
     values ($1, $2, 'Kiddo', $3, 'anna-kiddo', $4, true, 12), ($5, $6, 'Kleiner', $7, 'ben-kleiner', $4, true, 6)`,
    [KIDS, anna, KID_JF, encrypt(key, 'kpw'), OTHER_KIDS, other, hex('0')],
  );
});
afterAll(async () => { await env.close(); });

describe('POST /api/admin/users/:id/check (title search as the profile)', () => {
  it('a guest owner (FSK 12) does not see an FSK-16 title: why rating', async () => {
    const r = await check(guest, guest, 'Dunmoor');
    expect(r.statusCode).toBe(200);
    expect(r.json().hits).toEqual([
      { id: DUN, name: 'Dunmoor', year: 2024, type: 'Series', visible: false, why: 'rating', rating: 'FSK-16', library: 'Serien' },
    ]);
  });

  it('the search runs with the admin key (no userId), ancestors give the library', async () => {
    const before = env.jfCalls.length;
    await check(guest, guest, 'Wrenfield');
    const calls = env.jfCalls.slice(before);
    const search = calls.filter((c) => c.path === '/Items' && /searchterm=/i.test(c.search));
    expect(search).toHaveLength(1);
    expect(search[0]!.search).not.toMatch(/userid=/i);
    expect(search[0]!.auth).not.toMatch(/tok-/); // the admin key, not a user token
    expect(calls.filter((c) => c.path.endsWith('/Ancestors'))).toHaveLength(1);
    // the visibility probe is the profile's own identity
    expect(calls.some((c) => c.path === `/Items/${WREN}` && c.search.includes(`userId=${GUEST_JF}`))).toBe(true);
  });

  it('a role limited to Kinder and Serien does not see a Filme title: why library', async () => {
    const r = await check(kino, kino, 'Wrenfield Pier');
    expect(r.statusCode).toBe(200);
    expect(hit(r.json().hits, WREN)).toMatchObject({ visible: false, why: 'library', library: 'Filme', rating: null });
  });

  it('a kids profile (FSK 12): unrated title why unrated_kids, FSK-16 why rating, FSK-6 visible', async () => {
    const r = await check(anna, KIDS, ALL_TERM); // matches all three titles
    expect(r.statusCode).toBe(200);
    const hits = r.json().hits;
    expect(hits).toHaveLength(3);
    expect(hit(hits, WREN)).toMatchObject({ visible: false, why: 'unrated_kids' });
    expect(hit(hits, DUN)).toMatchObject({ visible: false, why: 'rating' });
    expect(hit(hits, SALT)).toEqual({ id: SALT, name: 'Saltwater Almanac', year: 2021, type: 'Movie', visible: true, why: null, rating: 'FSK-6', library: 'Kinder' });
  });

  it('without findItems the service user searches and why is null', async () => {
    const adm = env.ctx.jf.admin as MediaAdmin;
    const find = adm.findItems;
    delete (adm as { findItems?: unknown }).findItems;
    try {
      const svc = (await env.pool.query("select jellyfin_user_id from users where role='admin' and not disabled order by created_at limit 1")).rows[0].jellyfin_user_id as string;
      const before = env.jfCalls.length;
      const r = await check(guest, guest, 'Dunmoor');
      expect(r.statusCode).toBe(200);
      expect(r.json().hits).toEqual([{ id: DUN, name: 'Dunmoor', year: 2024, type: 'Series', visible: false, why: null, rating: 'FSK-16', library: '' }]);
      const search = env.jfCalls.slice(before).filter((c) => c.path === '/Items' && /searchterm=/i.test(c.search));
      expect(search).toHaveLength(1);
      expect(search[0]!.search).toContain(`userId=${svc}`);
    } finally {
      (adm as { findItems?: unknown }).findItems = find;
    }
  });

  it('audit holds counts only', async () => {
    await env.pool.query('delete from audit_log');
    const r = await check(guest, guest, 'Dunmoor');
    expect(r.statusCode).toBe(200);
    const rows = await audits(guest);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ profile: guest, hits: 1 });
    const all = JSON.stringify((await env.pool.query('select action, target, meta from audit_log')).rows);
    expect(all).not.toContain('Dunmoor');
    expect(all).not.toContain('FSK');
  });

  it('query of 1 char → 400 (and over 100 chars)', async () => {
    expect((await check(guest, guest, 'D')).statusCode).toBe(400);
    expect((await check(guest, guest, 'D'.repeat(101))).statusCode).toBe(400);
    expect((await as('POST', `/api/admin/users/${guest}/check`, { profileId: 'nope', query: 'Dunmoor' })).statusCode).toBe(400);
  });

  it('foreign profile → 404 (POST and GET), nothing searched or audited', async () => {
    await env.pool.query('delete from audit_log');
    const before = adminSearches().length;
    const r = await check(anna, OTHER_KIDS, 'Dunmoor');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
    const g = await libs(anna, OTHER_KIDS);
    expect(g.statusCode).toBe(404);
    expect(g.json()).toEqual({ error: 'not_found' });
    expect((await check('11111111-2222-4333-8444-999999999999', OTHER_KIDS, 'Dunmoor')).json()).toEqual({ error: 'not_found' });
    expect(adminSearches().length).toBe(before);
    expect(await audits(anna)).toEqual([]);
  });

  it('a media server failure answers 502 media_unavailable; the query reaches no log line and no audit entry', async () => {
    await env.pool.query('delete from audit_log');
    const r = await check(guest, guest, BROKEN_TERM);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'media_unavailable' });
    expect(r.body).not.toContain(BROKEN_TERM);
    expect(logs.join('\n')).not.toContain(BROKEN_TERM);
    expect(logs.join('\n')).not.toContain('Dunmoor');
    expect(await audits(guest)).toEqual([]);
  });

  it('non-admins get 403', async () => {
    const r = await env.app.inject({ method: 'POST', url: `/api/admin/users/${guest}/check`, payload: { profileId: guest, query: 'Dunmoor' } });
    expect([401, 403]).toContain(r.statusCode);
  });
});

describe('GET /api/admin/users/:id/check?profile= (library counts)', () => {
  it('library counts: seen as the profile, total as the service user; a library not shared is visible false, seen null', async () => {
    await env.pool.query('delete from audit_log');
    const r = await libs(fa, fa);
    expect(r.statusCode).toBe(200);
    expect(r.json().libraries).toEqual([
      { id: FILME, name: 'Filme', visible: true, seen: 1, total: 1 },
      { id: SERIEN, name: 'Serien', visible: false, seen: null, total: 1 },
      { id: KINDER, name: 'Kinder', visible: true, seen: 1, total: 1 },
    ]);
    expect((await audits(fa)).map((a) => a.meta)).toEqual([{ profile: fa, libraries: 3 }]);
  });

  it('a kids profile counts with its own identity', async () => {
    const r = await libs(anna, KIDS);
    expect(r.json().libraries).toEqual([
      { id: FILME, name: 'Filme', visible: true, seen: 0, total: 1 },
      { id: SERIEN, name: 'Serien', visible: true, seen: 0, total: 1 },
      { id: KINDER, name: 'Kinder', visible: true, seen: 1, total: 1 },
    ]);
  });

  it('cached 10 min per profile (KV viewcnt:<pid>), audited every time, recounted when the rights change', async () => {
    await env.pool.query('delete from audit_log');
    const counts = () => env.jfCalls.filter((c) => c.path === '/Items' && /parentid=/i.test(c.search)).length;
    await libs(kino, kino);
    expect(await env.kv.get(`viewcnt:${kino}`)).not.toBeNull();
    const n = counts();
    const again = await libs(kino, kino);
    expect(again.statusCode).toBe(200);
    expect(counts()).toBe(n); // from the cache
    expect(await audits(kino)).toHaveLength(2);
    // the role changes: the cached answer belongs to other rights and is counted again
    await env.pool.query("update users set role='friend' where id=$1", [kino]);
    const after = await libs(kino, kino);
    expect(counts()).toBeGreaterThan(n);
    expect(after.json().libraries.every((l: { visible: boolean }) => l.visible)).toBe(true);
    await env.pool.query("update users set role='kino' where id=$1", [kino]);
  });

  it('rate limited to 30 per minute', async () => {
    const one = () => env.app.inject({ method: 'GET', url: `/api/admin/users/${fa}/check?profile=${fa}`, cookies: admin.cookies, remoteAddress: '192.0.2.50' });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await one()).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it('a missing ?profile= is 400', async () => {
    expect((await as('GET', `/api/admin/users/${fa}/check`)).statusCode).toBe(400);
  });
});

describe('ageOf (the rating behind why = rating / unrated_kids)', () => {
  it('reads the app spellings and country-prefixed ones; unrated and unknown are null', () => {
    expect([ageOf('FSK-16'), ageOf('DE-6'), ageOf('12'), ageOf('PG-13'), ageOf('de/16'), ageOf('us/PG-13'), ageOf('de/FSK 12')]).toEqual([16, 6, 12, 13, 16, 13, 12]);
    expect([ageOf(null), ageOf(''), ageOf('NR'), ageOf('xx/whatever')]).toEqual([null, null, null, null]);
  });
});
