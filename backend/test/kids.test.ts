import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db.js';
import { kidsPolicy } from '../src/profiles.js';
import { reapplyRole } from '../src/users.js';
import { TEST_DB, makeEnv, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let envRef: TestEnv | null = null;
afterEach(async () => { const e = envRef; envRef = null; await e?.close(); });

const hex = (c: string) => c.repeat(32);
/** fake library: rating value as Jellyfin compares it (FSK 0/12/16) and one unrated film */
const LIB = [
  { Id: hex('a'), Name: 'Bärenbande', Type: 'Movie', OfficialRating: 'FSK-0', v: 0 },
  { Id: hex('b'), Name: 'Abenteuerinsel', Type: 'Series', OfficialRating: 'FSK-12', v: 12 },
  { Id: hex('c'), Name: 'Nachtangst', Type: 'Movie', OfficialRating: 'FSK-16', v: 16 },
  { Id: hex('d'), Name: 'Ohne Freigabe', Type: 'Movie', v: null as number | null },
];

/**
 * Jellyfin fake that enforces the policy like the real server: the caller is the user behind the token, MaxParentalRating and
 * BlockUnratedItems of that user's stored policy filter every list and item lookup.
 */
function parentalJellyfin() {
  const ids = new Map<string, string>(); // username -> id
  const policy = new Map<string, Record<string, any>>();
  let n = 0;
  const who = (init: RequestInit) => {
    const tok = /Token="tok-([^"]+)"/.exec(String((init.headers as Record<string, string>)?.Authorization ?? ''))?.[1];
    return tok ? ids.get(tok) : undefined;
  };
  const allowed = (uid: string | undefined, i: (typeof LIB)[number]) => {
    const p = uid ? policy.get(uid) ?? {} : {};
    if (i.v === null) return !(p.BlockUnratedItems ?? []).includes(i.Type);
    return p.MaxParentalRating === null || p.MaxParentalRating === undefined || i.v <= p.MaxParentalRating;
  };
  const dto = ({ v: _v, ...i }: (typeof LIB)[number]) => ({ ...i, UserData: {} });
  const routes: Record<string, Handler> = {
    'POST /Users/New': (_u, _i, b) => { const id = `jf${String(++n).padStart(30, '0')}ab`; ids.set(b.Name, id); return { json: { Id: id, Name: b.Name } }; },
    'GET /Users/[^/]+': (u) => ({ json: { Policy: policy.get(u.pathname.split('/')[2]!) ?? { Keep: 'me' } } }),
    'POST /Users/[^/]+/Policy': (u, _i, b) => { policy.set(u.pathname.split('/')[2]!, b); return { status: 204 }; },
    'GET /Items': (u, init) => {
      const uid = who(init);
      const want = new Set((u.searchParams.get('includeItemTypes') ?? 'Movie,Series').split(','));
      const q = (u.searchParams.get('searchTerm') ?? '').toLowerCase();
      const only = u.searchParams.get('ids')?.split(',');
      const out = LIB.filter((i) => want.has(i.Type) && allowed(uid, i) && (!q || i.Name.toLowerCase().includes(q)) && (!only || only.includes(i.Id)));
      return { json: { Items: out.map(dto), TotalRecordCount: out.length } };
    },
    'GET /Items/[^/]+': (u, init) => {
      const i = LIB.find((x) => x.Id === u.pathname.split('/')[2]);
      return i && allowed(who(init), i) ? { json: dto(i) } : { status: 404 };
    },
    'GET /Persons': () => ({ json: { Items: [] } }),
    'GET /Genres': () => ({ json: { Items: [] } }),
  };
  return { routes, policy, ids };
}

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const sessOf = (r: { cookies: Array<{ name: string; value: string }> }, prev: Sess): Sess => ({ cookies: { ff_sid: r.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: prev.csrf });
async function mkProfile(s: Sess, body: Record<string, unknown>) {
  const r = await call(s, 'POST', '/api/profiles', body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().profile as { id: string; name: string; kids: boolean; maxRating?: number };
}
async function select(s: Sess, id: string, pin?: string) {
  return call(s, 'POST', `/api/profiles/${id}/select`, pin ? { pin } : {});
}
async function switchTo(s: Sess, id: string, pin?: string): Promise<Sess> {
  const r = await select(s, id, pin);
  expect(r.statusCode, r.body).toBe(200);
  return sessOf(r, s);
}
const jfIdOf = async (profileId: string) => (await env.pool.query<{ j: string }>('select jellyfin_user_id j from profiles where id=$1', [profileId])).rows[0]!.j;

describe('kids profiles', () => {
  it('kidsPolicy: lower of role cap and kids cap, unrated hidden; a normal profile clears the unrated block', () => {
    expect(kidsPolicy({ kids: true, kids_max_rating: 12 }, null)).toEqual({ MaxParentalRating: 12, BlockUnratedItems: ['Movie', 'Series', 'Trailer'] });
    expect(kidsPolicy({ kids: true, kids_max_rating: 12 }, 6)).toMatchObject({ MaxParentalRating: 6 });
    expect(kidsPolicy({ kids: true, kids_max_rating: 0 }, 12)).toMatchObject({ MaxParentalRating: 0 });
    expect(kidsPolicy({ kids: false, kids_max_rating: 6 }, null)).toEqual({ BlockUnratedItems: [] });
  });

  it('owner creates a kids profile; the cap reaches its Jellyfin user and filters items, detail and search server-side', async () => {
    const jf = parentalJellyfin();
    env = envRef = await makeEnv(jf.routes);
    const s = await env.login();
    expect((await call(s, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 7 })).statusCode).toBe(400); // only 0/6/12
    const kid = await mkProfile(s, { name: 'Mia', kids: true, maxRating: 6 });
    expect(kid).toMatchObject({ kids: true, maxRating: 6 });
    expect(jf.policy.get(await jfIdOf(kid.id))).toMatchObject({ MaxParentalRating: 6, BlockUnratedItems: ['Movie', 'Series', 'Trailer'], IsHidden: true, Keep: 'me' });

    // the owner sees everything, the kid only what its cap allows - whatever the client asks for
    const all = (await call(s, 'GET', '/api/library/items?types=Movie,Series')).json().items.map((i: { name: string }) => i.name);
    expect(all).toHaveLength(4);
    const k = await switchTo(s, kid.id);
    const me = (await call(k, 'GET', '/api/me')).json();
    expect(me).toMatchObject({ kids: true, profile: { id: kid.id, kids: true, maxRating: 6 } });
    expect((await call(k, 'GET', '/api/library/items?types=Movie,Series')).json().items.map((i: { name: string }) => i.name)).toEqual(['Bärenbande']);
    expect((await call(k, 'GET', `/api/items/${hex('c')}`)).statusCode).toBe(404); // FSK 16 detail
    expect((await call(k, 'GET', `/api/items/${hex('d')}`)).statusCode).toBe(404); // unrated
    expect((await call(k, 'GET', `/api/items/${hex('a')}`)).statusCode).toBe(200);
    const found = (await call(k, 'GET', '/api/search?q=an')).json();
    expect(found.titles.map((i: { name: string }) => i.name)).toEqual(['Bärenbande']);
    expect((await call(k, 'GET', '/api/library/items?types=Movie&filter=favorites')).json().items.every((i: { name: string }) => i.name === 'Bärenbande')).toBe(true);
  });

  it('a role re-apply keeps the kids cap (and never caps normal profiles)', async () => {
    const jf = parentalJellyfin();
    env = envRef = await makeEnv(jf.routes);
    const s = await env.login();
    const kid = await mkProfile(s, { name: 'Mia', kids: true, maxRating: 0 });
    const big = await mkProfile(s, { name: 'Tom' });
    await reapplyRole(env.ctx, 'admin');
    expect(jf.policy.get(await jfIdOf(kid.id))).toMatchObject({ MaxParentalRating: 0, BlockUnratedItems: ['Movie', 'Series', 'Trailer'] });
    expect(jf.policy.get(await jfIdOf(big.id))).toMatchObject({ MaxParentalRating: null, BlockUnratedItems: [] });
  });

  it('only the owner profile turns kids mode on/off or changes the cap; the owner profile itself cannot be a kids profile', async () => {
    const jf = parentalJellyfin();
    env = envRef = await makeEnv(jf.routes);
    const s = await env.login();
    const ownerId = (await call(s, 'GET', '/api/me')).json().profile.id;
    const tom = await mkProfile(s, { name: 'Tom' });
    expect((await call(s, 'PATCH', `/api/profiles/${ownerId}`, { kids: true })).json().error).toBe('owner_not_kids');
    const on = await call(s, 'PATCH', `/api/profiles/${tom.id}`, { kids: true, maxRating: 12 });
    expect(on.statusCode).toBe(200);
    expect(on.json().profile).toMatchObject({ kids: true, maxRating: 12 });
    expect(jf.policy.get(await jfIdOf(tom.id))).toMatchObject({ MaxParentalRating: 12 });
    // the kid cannot free itself or raise its cap (renaming itself is fine)
    const k = await switchTo(s, tom.id);
    expect((await call(k, 'PATCH', `/api/profiles/${tom.id}`, { kids: false })).statusCode).toBe(403);
    expect((await call(k, 'PATCH', `/api/profiles/${tom.id}`, { maxRating: 12, name: 'Tommy' })).statusCode).toBe(200); // same cap: no change
    expect((await call(k, 'PATCH', `/api/profiles/${tom.id}`, { maxRating: 6 })).statusCode).toBe(403);
    expect((await env.pool.query('select kids, kids_max_rating, name from profiles where id=$1', [tom.id])).rows[0]).toEqual({ kids: true, kids_max_rating: 12, name: 'Tommy' });
    const back = await switchTo(k, ownerId); // no PIN anywhere: allowed (documented, the owner gets a hint)
    const off = await call(back, 'PATCH', `/api/profiles/${tom.id}`, { kids: false });
    expect(off.json().profile).toMatchObject({ kids: false });
    expect(jf.policy.get(await jfIdOf(tom.id))).toMatchObject({ MaxParentalRating: null, BlockUnratedItems: [] });
  });

  it('a failing Jellyfin policy write rolls the kids flag back (502)', async () => {
    const jf = parentalJellyfin();
    let fail = false;
    env = envRef = await makeEnv({ ...jf.routes, 'POST /Users/[^/]+/Policy': (u, i, b) => (fail ? { status: 500 } : jf.routes['POST /Users/[^/]+/Policy']!(u, i, b)) });
    const s = await env.login();
    const tom = await mkProfile(s, { name: 'Tom' });
    fail = true;
    expect((await call(s, 'PATCH', `/api/profiles/${tom.id}`, { kids: true })).statusCode).toBe(502);
    expect((await env.pool.query('select kids from profiles where id=$1', [tom.id])).rows[0].kids).toBe(false);
  });

  it('social routes answer 403 kids_profile for kids, personal ones keep working', async () => {
    const jf = parentalJellyfin();
    env = envRef = await makeEnv(jf.routes);
    const s = await env.login();
    const kid = await mkProfile(s, { name: 'Mia', kids: true });
    const k = await switchTo(s, kid.id);
    const A = hex('a');
    const blocked: Array<[string, string, unknown?]> = [
      ['GET', `/api/items/${A}/friends`], ['GET', `/api/items/${A}/reactions`], ['PUT', `/api/items/${A}/reactions`, { emoji: 'like' }],
      ['GET', '/api/lists'], ['POST', '/api/lists', { name: 'x' }], ['GET', '/api/lists/featured'], ['GET', `/api/items/${A}/lists`],
      ['GET', '/api/polls'], ['POST', '/api/polls', {}], ['GET', `/api/items/${A}/ratings`], ['PUT', `/api/items/${A}/rating`, { stars: 5 }],
    ];
    for (const [m, u, b] of blocked) {
      const r = await call(k, m, u, b);
      expect([r.statusCode, r.json().error], `${m} ${u}`).toEqual([403, 'kids_profile']);
    }
    // personal things stay: thumbs (onboarding), watch status
    expect((await call(k, 'PUT', `/api/items/${A}/thumb`, { value: 1 })).json()).toEqual({ value: 1 });
    expect((await call(k, 'GET', `/api/items/${A}/status`)).statusCode).toBe(200);
    // the same routes still work for a grown-up profile
    const o = await switchTo(k, (await env.pool.query('select id from profiles where is_owner')).rows[0].id);
    expect((await call(o, 'GET', '/api/lists')).statusCode).toBe(200);
    expect((await call(o, 'GET', `/api/items/${A}/reactions`)).statusCode).toBe(200);
  });

  it('leaving a kids profile needs the target PIN, else the owner PIN; wrong PINs are rejected and counted', async () => {
    const jf = parentalJellyfin();
    env = envRef = await makeEnv(jf.routes);
    const s = await env.login();
    const ownerId = (await call(s, 'GET', '/api/me')).json().profile.id;
    const kid = await mkProfile(s, { name: 'Mia', kids: true });
    const anna = await mkProfile(s, { name: 'Anna', pin: '2222' });
    const ben = await mkProfile(s, { name: 'Ben' });
    expect((await call(s, 'PUT', `/api/profiles/${ownerId}/pin`, { pin: '1111' })).statusCode).toBe(200);
    expect((await call(s, 'GET', '/api/profiles')).json()).toMatchObject({ kidsLock: null, kidsUnguarded: false });
    const k = await switchTo(s, kid.id);

    const list = (await call(k, 'GET', '/api/profiles')).json();
    expect(list.kidsLock).toBe(kid.id);
    expect(list.profiles.find((p: { id: string }) => p.id === ben.id)).toMatchObject({ hasPin: false, unlock: 'owner' });
    expect(list.profiles.find((p: { id: string }) => p.id === anna.id)).toMatchObject({ hasPin: true });
    expect(list.profiles.find((p: { id: string }) => p.id === anna.id).unlock).toBeUndefined();

    // Ben has no PIN: the owner's PIN unlocks, nothing else
    expect((await select(k, ben.id)).json()).toEqual({ error: 'pin_required', pinOf: 'owner' });
    expect((await select(k, ben.id, '2222')).json()).toEqual({ error: 'pin_wrong', pinOf: 'owner' });
    // Anna has her own PIN: only hers counts (not the owner's)
    expect((await select(k, anna.id, '1111')).json().error).toBe('pin_wrong');
    // the kids profile itself can always be re-selected
    expect((await select(k, kid.id)).statusCode).toBe(200);
    const bb = await switchTo(k, ben.id, '1111');
    expect((await call(bb, 'GET', '/api/me')).json()).toMatchObject({ kids: false, profile: { id: ben.id } });
    // going into a kids profile needs nothing, leaving it again does
    const k2 = await switchTo(bb, kid.id);
    expect((await select(k2, ownerId)).json().error).toBe('pin_required');
  });

  it('guessing the owner PIN from a kids profile locks after 5 tries', async () => {
    env = envRef = await makeEnv(parentalJellyfin().routes);
    const s = await env.login();
    const ownerId = (await call(s, 'GET', '/api/me')).json().profile.id;
    const kid = await mkProfile(s, { name: 'Mia', kids: true });
    const ben = await mkProfile(s, { name: 'Ben' });
    await call(s, 'PUT', `/api/profiles/${ownerId}/pin`, { pin: '1111' });
    const k = await switchTo(s, kid.id);
    for (let i = 0; i < 4; i++) expect((await select(k, ben.id, String(1000 + i))).statusCode).toBe(403);
    expect((await select(k, ben.id, '0000')).json()).toEqual({ error: 'pin_locked', pinOf: 'owner' });
    expect((await select(k, ben.id, '1111')).statusCode).toBe(429); // even the right PIN, until the lock expires
  });

  it('without any PIN leaving is allowed, and the owner is told to set one', async () => {
    env = envRef = await makeEnv(parentalJellyfin().routes);
    const s = await env.login();
    const kid = await mkProfile(s, { name: 'Mia', kids: true });
    const ben = await mkProfile(s, { name: 'Ben' });
    expect((await call(s, 'GET', '/api/profiles')).json().kidsUnguarded).toBe(true);
    const k = await switchTo(s, kid.id);
    expect((await call(k, 'GET', '/api/profiles')).json().profiles.find((p: { id: string }) => p.id === ben.id).unlock).toBeUndefined();
    expect((await select(k, ben.id)).statusCode).toBe(200);
  });

  it('a new login on a kid\'s device lands on the kids profile again (logout is no way out)', async () => {
    env = envRef = await makeEnv(parentalJellyfin().routes);
    const s = await env.login();
    const ownerId = (await call(s, 'GET', '/api/me')).json().profile.id;
    const kid = await mkProfile(s, { name: 'Mia', kids: true });
    const ben = await mkProfile(s, { name: 'Ben' });
    const o = await switchTo(s, ownerId);
    await call(o, 'PUT', `/api/profiles/${ownerId}/pin`, { pin: '1111' });
    await switchTo(o, kid.id);
    const again = await env.login(); // same browser (device cookie), fresh session without a chosen profile
    const me = (await call(again, 'GET', '/api/me')).json();
    expect(me).toMatchObject({ kids: true, profile: { id: kid.id }, profileChosen: false });
    expect((await select(again, ben.id)).json()).toEqual({ error: 'pin_required', pinOf: 'owner' });
    const b = await switchTo(again, ben.id, '1111');
    // unlocked: the device is no longer tied to the kids profile
    expect((await env.pool.query('select kids_profile_id from devices')).rows.every((r) => r.kids_profile_id === null)).toBe(true);
    void b;
    const third = await env.login();
    expect((await call(third, 'GET', '/api/me')).json().kids).toBe(false);
  });

  it('onboarding flag: new profiles see /welcome once, a settings save never resets it', async () => {
    env = envRef = await makeEnv(parentalJellyfin().routes);
    const s = await env.login();
    expect((await call(s, 'GET', '/api/me')).json().onboarded).toBe(false); // a brand new account's owner profile
    const kid = await mkProfile(s, { name: 'Mia', kids: true });
    const k = await switchTo(s, kid.id);
    expect((await call(k, 'GET', '/api/me')).json().onboarded).toBe(false);
    expect((await call(k, 'PUT', '/api/prefs/onboarded', { onboarded: false })).statusCode).toBe(400);
    expect((await call(k, 'PUT', '/api/prefs/onboarded', { onboarded: true })).json()).toEqual({ onboarded: true });
    expect((await call(k, 'GET', '/api/me')).json().onboarded).toBe(true);
    // a full prefs save (settings page) with onboarded false keeps the stored flag
    const put = await call(k, 'PUT', '/api/prefs', { autoplayNext: false, onboarded: false });
    expect(put.json().prefs).toMatchObject({ autoplayNext: false });
    expect(put.json().prefs.onboarded).toBeUndefined(); // not a viewing pref
    expect((await env.pool.query('select data from profile_prefs where profile_id=$1', [kid.id])).rows[0].data).toMatchObject({ autoplayNext: false, onboarded: true });
    expect((await call(k, 'GET', '/api/me')).json().onboarded).toBe(true);
    // per profile: the owner profile still has to go through it
    expect((await env.pool.query("select data->>'onboarded' v from profile_prefs where profile_id<>$1", [kid.id])).rows.every((r) => r.v !== 'true')).toBe(true);
  });

  it('requires a login for the new endpoint', async () => {
    env = envRef = await makeEnv(parentalJellyfin().routes);
    expect((await env.app.inject({ method: 'PUT', url: '/api/prefs/onboarded', payload: { onboarded: true } })).statusCode).toBe(401);
  });
});

describe('migration 31', () => {
  const pool = new pg.Pool({ connectionString: TEST_DB, max: 2 });
  afterAll(() => pool.end());
  it('adds the kids columns and marks every existing profile as onboarded (keeping its prefs)', async () => {
    const idx = MIGRATIONS.findIndex((m) => m.includes('add column kids boolean'));
    expect(idx).toBe(30);
    await pool.query('drop schema public cascade; create schema public;');
    for (const m of MIGRATIONS.slice(0, idx)) await pool.query(m);
    const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
    for (const [id, sub] of [[a, 's1'], [b, 's2']]) {
      await pool.query("insert into users(id,authentik_sub,name,role,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values ($1,$2,'A','friend','jf'||$2,'n'||$2,'enc')", [id, sub]);
      await pool.query("insert into profiles(id,user_id,name,is_owner) values ($1,$1,'A',true)", [id]);
    }
    await pool.query(`insert into profile_prefs(profile_id,data) values ($1,'{"language":"en"}')`, [a]);
    await pool.query(MIGRATIONS[idx]!);
    const rows = (await pool.query('select p.id, p.kids, p.kids_max_rating, pp.data from profiles p join profile_prefs pp on pp.profile_id=p.id order by p.id')).rows;
    expect(rows).toEqual([
      { id: a, kids: false, kids_max_rating: 12, data: { language: 'en', onboarded: true } },
      { id: b, kids: false, kids_max_rating: 12, data: { onboarded: true } },
    ]);
    await expect(pool.query('update profiles set kids_max_rating=16 where id=$1', [a])).rejects.toThrow();
  });
});
