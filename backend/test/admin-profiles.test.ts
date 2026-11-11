// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, hashPin, keyFromBase64 } from '../src/crypto.js';
import { sockets } from '../src/partySockets.js';
import { effectiveRights, invalidateRights } from '../src/rights.js';
import type { ProfileRow } from '../src/types.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

// Users & permissions Task 10: admins switch a profile to kids, set its age cap, create kids profiles and delete profiles of an account.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let failPolicy = '';
let failDelete = false;

const ANNA = '0a000000-0000-4000-a000-000000000001';
const BEN = '0a000000-0000-4000-a000-000000000002';
const KID = '0a000000-0000-4000-a000-000000000003';
const JF = { anna: 'anna'.padEnd(32, '0'), ben: 'ben'.padEnd(32, '0'), kid: 'kid'.padEnd(32, '0') };
const UNRATED = ['Movie', 'Series', 'Trailer'];
const key = keyFromBase64(ENC_KEY);

beforeAll(async () => {
  env = await makeEnv({
    'POST /Users/[^/]+/Policy': (u) => (failPolicy && u.pathname.includes(failPolicy) ? { status: 500, raw: 'nope' } : { status: 204 }),
    'DELETE /Users/[^/]+': () => ({ status: failDelete ? 500 : 204 }),
  });
  admin = await env.login();
  // Anna Beispiel: a friend with her owner profile (PIN 4711), a grown-up profile "Ben Muster" and a kids profile "Carla Probe" (cap 6)
  await env.pool.query(
    "insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, 'sub-anna', 'Anna Beispiel', 'friend', $2, 'anna', $3)",
    [ANNA, JF.anna, encrypt(key, 'pw')]);
  await env.pool.query("insert into profiles(id, user_id, name, is_owner, pin_hash) values ($1, $1, 'Anna Beispiel', true, $2)", [ANNA, hashPin('4711')]);
  await env.pool.query("insert into devices(user_id, device_id, label, approved, last_seen) values ($1, 'dev-a', 'Firefox', true, now()), ($1, 'dev-b', 'Safari', true, now())", [ANNA]);
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from profiles where user_id=$1 and not is_owner', [ANNA]);
  await env.pool.query(
    `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating, pin_hash)
     values ($1, $3, 'Ben Muster', $4, 'anna-ben', $6, false, 12, null), ($2, $3, 'Carla Probe', $5, 'anna-carla', $6, true, 6, $7)`,
    [BEN, KID, ANNA, JF.ben, JF.kid, encrypt(key, 'kpw'), hashPin('2468')]);
  await env.pool.query('delete from audit_log; delete from account_deletions');
  for (const k of await env.kv.keys('sess:')) {
    if ((JSON.parse((await env.kv.get(k))!) as { userId: string }).userId === ANNA) await env.kv.del(k);
  }
  sockets.delete(ANNA);
  invalidateRights();
  env.jfCalls.length = 0;
  failPolicy = '';
  failDelete = false;
});

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  env.app.inject({ method, url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, ...(payload ? { payload } : {}) });
const patch = (pid: string, body: object) => call('PATCH', `/api/admin/users/${ANNA}/profiles/${pid}`, body);
const create = (body: object) => call('POST', `/api/admin/users/${ANNA}/profiles`, body);
const remove = (pid: string) => call('DELETE', `/api/admin/users/${ANNA}/profiles/${pid}`);
const row = async (pid: string) => (await env.pool.query<ProfileRow>('select * from profiles where id=$1', [pid])).rows[0];
const policyOf = (jf: string) => env.jfCalls.filter((c) => c.method === 'POST' && c.path === `/Users/${jf}/Policy`).at(-1)?.body;
const audits = async (action: string) => (await env.pool.query<{ actor: string; target: string; meta: Record<string, unknown> }>(
  'select actor, target, meta from audit_log where action=$1 order by id', [action])).rows;
/** no profile name, PIN or PIN hash in any audit entry */
const auditClean = async () => {
  const all = JSON.stringify((await env.pool.query('select meta from audit_log')).rows);
  for (const s of ['Ben', 'Carla', 'Dunmoor', '4711', '2468', '$scrypt', 'pin']) expect(all).not.toContain(s);
};
const session = (sid: string, deviceId: string, profileId: string) =>
  env.kv.set(`sess:${sid}`, JSON.stringify({ userId: ANNA, csrf: 'c', deviceId, deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now(), profileId }), 600);
/** a fake open party socket of a session: records how it was closed */
const peer = (sid: string, closed: string[]) => {
  const p = { sid, close: () => closed.push(`${sid}:revoked`), forbid: () => closed.push(`${sid}:forbidden`) };
  if (!sockets.has(ANNA)) sockets.set(ANNA, new Set());
  sockets.get(ANNA)!.add(p);
};

describe('PATCH /api/admin/users/:id/profiles/:pid (kids)', () => {
  it('switch a profile to kids with cap 6', async () => {
    await session('s-ben', 'dev-a', BEN);
    await session('s-own', 'dev-b', ANNA);
    const closed: string[] = [];
    peer('s-ben', closed);
    peer('s-own', closed);

    const r = await patch(BEN, { kids: true, maxRating: 6 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().profile).toMatchObject({ id: BEN, kids: true, maxRating: 6 });
    expect(await row(BEN)).toMatchObject({ kids: true, kids_max_rating: 6 });
    // the media server enforces the cap on that profile's own identity: cap 6, unrated titles hidden, still hidden as a user
    expect(policyOf(JF.ben)).toMatchObject({ MaxParentalRating: 6, BlockUnratedItems: UNRATED, IsHidden: true });
    expect(policyOf(JF.anna)).toBeUndefined(); // nobody else's policy is touched
    // FriendFlix: the kids overlay applies to the profile at once
    const rights = (await effectiveRights(env.ctx, { id: ANNA, role: 'friend' }, (await row(BEN))!))!;
    expect(rights.perms.party).toBe(false);
    expect(rights.template.maxParentalRating).toBe(6);
    // the open party socket of the session on that profile is refused, the owner's stays
    expect(closed).toEqual(['s-ben:forbidden']);
    expect(await audits('profile.admin_update')).toEqual([{
      actor: expect.any(String), target: ANNA,
      meta: { profile: BEN, from: { kids: false, maxRating: null }, to: { kids: true, maxRating: 6 } },
    }]);
    await auditClean();
  });

  it('a cap change re-applies the policy; nothing is changed by an unchanged value', async () => {
    const r = await patch(KID, { maxRating: 0 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().profile).toMatchObject({ kids: true, maxRating: 0 });
    expect(policyOf(JF.kid)).toMatchObject({ MaxParentalRating: 0, BlockUnratedItems: UNRATED, IsHidden: true });
    expect((await audits('profile.admin_update')).map((a) => a.meta)).toEqual([{ profile: KID, from: { kids: true, maxRating: 6 }, to: { kids: true, maxRating: 0 } }]);

    // the same values again: no write, no policy call, no entry
    env.jfCalls.length = 0;
    const same = await patch(KID, { kids: true, maxRating: 0 });
    expect(same.statusCode, same.body).toBe(200);
    expect(policyOf(JF.kid)).toBeUndefined();
    expect(await audits('profile.admin_update')).toHaveLength(1);
    await auditClean();
  });

  it('kids off clears the device lock', async () => {
    await env.pool.query("update devices set kids_profile_id = case device_id when 'dev-a' then $2::uuid else null end where user_id=$1", [ANNA, KID]);
    const r = await patch(KID, { kids: false });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().profile).toMatchObject({ kids: false });
    expect((await env.pool.query("select kids_profile_id from devices where user_id=$1 and device_id='dev-a'", [ANNA])).rows[0].kids_profile_id).toBeNull();
    // the unrated block goes again on the media server
    expect(policyOf(JF.kid)).toMatchObject({ BlockUnratedItems: [], IsHidden: true });
    expect((await audits('profile.admin_update')).map((a) => a.meta)).toEqual([{ profile: KID, from: { kids: true, maxRating: 6 }, to: { kids: false, maxRating: null } }]);
    await auditClean();
  });

  it('owner cannot become kids; a cap needs a kids profile; only 0/6/12', async () => {
    const owner = await patch(ANNA, { kids: true, maxRating: 6 });
    expect(owner.statusCode).toBe(400);
    expect(owner.json()).toEqual({ error: 'owner_not_kids' });
    expect((await patch(ANNA, { kids: false })).json()).toEqual({ error: 'owner_not_kids' });
    expect((await patch(ANNA, { maxRating: 6 })).json()).toEqual({ error: 'not_kids' });
    const cap = await patch(BEN, { maxRating: 6 });
    expect(cap.statusCode).toBe(400);
    expect(cap.json()).toEqual({ error: 'not_kids' });
    expect((await patch(KID, { kids: false, maxRating: 0 })).json()).toEqual({ error: 'not_kids' });
    expect((await patch(KID, { maxRating: 7 })).statusCode).toBe(400);
    expect((await patch(KID, { maxRating: 16 })).statusCode).toBe(400);
    expect((await patch(KID, { maxRating: null })).statusCode).toBe(400);
    expect((await patch(KID, { kids: 'yes' })).statusCode).toBe(400);
    expect((await patch(KID, { pin: '1234' })).statusCode).toBe(400); // .strict(): no other field
    expect((await row(ANNA))!.kids).toBe(false);
    expect(await row(BEN)).toMatchObject({ kids: false, kids_max_rating: 12 });
    expect(await row(KID)).toMatchObject({ kids: true, kids_max_rating: 6 });
    expect(env.jfCalls.filter((c) => c.path.endsWith('/Policy'))).toEqual([]);
    expect(await audits('profile.admin_update')).toEqual([]);
  });

  it('rename and kids in one body: one entry; the media server failing answers 502 and keeps the stricter stored state', async () => {
    const r = await patch(BEN, { name: 'Ben M', kids: true, maxRating: 12 });
    expect(r.statusCode, r.body).toBe(200);
    expect((await audits('profile.admin_update')).map((a) => a.meta)).toEqual([
      { profile: BEN, from: { name: 'Ben Muster', kids: false, maxRating: null }, to: { name: 'Ben M', kids: true, maxRating: 12 } },
    ]);
    await env.pool.query('delete from audit_log');

    failPolicy = JF.kid;
    const f = await patch(KID, { maxRating: 0 });
    expect(f.statusCode).toBe(502);
    expect(f.json()).toEqual({ error: 'jellyfin' });
    // the stored cap is the stricter one (FriendFlix enforces it at once); "Repair" re-applies it on the media server
    expect(await row(KID)).toMatchObject({ kids: true, kids_max_rating: 0 });
    expect((await audits('profile.admin_update')).map((a) => a.meta)).toEqual([{ profile: KID, from: { kids: true, maxRating: 6 }, to: { kids: true, maxRating: 0 } }]);
  });

  it('a claimed account and an unknown profile are refused', async () => {
    expect((await patch('0a000000-0000-4000-a000-0000000000ff', { kids: true })).statusCode).toBe(404);
    await env.pool.query("insert into account_deletions(user_id, pseudonym) values ($1, 'gelöscht')", [ANNA]);
    const r = await patch(BEN, { kids: true, maxRating: 6 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'deletion_in_progress' });
    expect((await create({ name: 'Dunmoor', kids: true, maxRating: 6 })).statusCode).toBe(409);
    expect((await remove(KID)).statusCode).toBe(409);
    expect((await row(BEN))!.kids).toBe(false);
    expect(await row(KID)).toBeDefined();
  });
});

describe('POST /api/admin/users/:id/profiles', () => {
  it('create a kids profile', async () => {
    const r = await create({ name: 'Dunmoor', kids: true, maxRating: 0, avatar: 'green' });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json().profile;
    expect(p).toMatchObject({ name: 'Dunmoor', kids: true, maxRating: 0, avatar: 'green', isOwner: false, hasPin: false });
    const stored = (await row(p.id))!;
    expect(stored).toMatchObject({ user_id: ANNA, kids: true, kids_max_rating: 0, pin_hash: null });
    // its own hidden media server identity, created with the kids policy
    expect(env.jfCalls.some((c) => c.method === 'POST' && c.path === '/Users/New')).toBe(true);
    expect(policyOf(stored.jellyfin_user_id!)).toMatchObject({ MaxParentalRating: 0, BlockUnratedItems: UNRATED, IsHidden: true });
    expect(await audits('profile.admin_create')).toEqual([{ actor: expect.any(String), target: ANNA, meta: { profile: p.id, maxRating: 0 } }]);
    await auditClean();
  });

  it('only kids profiles, valid caps, unique names, at most 5 profiles', async () => {
    expect((await create({ name: 'Dunmoor', kids: false, maxRating: 6 })).statusCode).toBe(400);
    expect((await create({ name: 'Dunmoor', maxRating: 6 })).statusCode).toBe(400);
    expect((await create({ name: 'Dunmoor', kids: true })).statusCode).toBe(400);
    expect((await create({ name: 'Dunmoor', kids: true, maxRating: 16 })).statusCode).toBe(400);
    expect((await create({ name: 'Dunmoor', kids: true, maxRating: 6, pin: '1234' })).statusCode).toBe(400);
    expect((await create({ name: '', kids: true, maxRating: 6 })).statusCode).toBe(400);
    expect((await create({ name: 'x'.repeat(21), kids: true, maxRating: 6 })).statusCode).toBe(400);
    const taken = await create({ name: 'carla probe', kids: true, maxRating: 6 });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'name_taken' });
    // owner + Ben + Carla = 3: two more fit, the sixth is refused
    expect((await create({ name: 'Wrenfield', kids: true, maxRating: 6 })).statusCode).toBe(201);
    expect((await create({ name: 'Saltwater', kids: true, maxRating: 12 })).statusCode).toBe(201);
    const full = await create({ name: 'Almanac', kids: true, maxRating: 6 });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: 'max_profiles' });
    expect(Number((await env.pool.query('select count(*) n from profiles where user_id=$1', [ANNA])).rows[0].n)).toBe(5);
    expect(await audits('profile.admin_create')).toHaveLength(2);
    await auditClean();
  });

  it('an unknown account is 404', async () => {
    const r = await call('POST', '/api/admin/users/0a000000-0000-4000-a000-0000000000ff/profiles', { name: 'Dunmoor', kids: true, maxRating: 6 });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });
});

describe('DELETE /api/admin/users/:id/profiles/:pid', () => {
  it('delete removes the profile and its identity', async () => {
    await session('s-kid', 'dev-a', KID);
    await session('s-own', 'dev-b', ANNA);
    await env.pool.query("update devices set kids_profile_id=$2 where user_id=$1 and device_id='dev-a'", [ANNA, KID]);
    await env.pool.query("insert into handoff(profile_id, user_id, device_id, item_id, position_ticks) values ($1, $2, 'dev-a', 'i1', 10)", [KID, ANNA]);
    await env.pool.query("insert into watchlist(user_id, profile_id, item_id) values ($2, $1, 'i1')", [KID, ANNA]);

    const r = await remove(KID);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === `/Users/${JF.kid}`)).toBe(true);
    expect(await row(KID)).toBeUndefined();
    expect((await env.pool.query("select kids_profile_id from devices where user_id=$1 and device_id='dev-a'", [ANNA])).rows[0].kids_profile_id).toBeNull();
    expect((await env.pool.query('select 1 from handoff where profile_id=$1', [KID])).rowCount).toBe(0);
    expect((await env.pool.query('select 1 from watchlist where profile_id=$1', [KID])).rowCount).toBe(0);
    // the session on that profile loses it (re-resolves on its next request), the owner's session keeps its profile
    expect(JSON.parse((await env.kv.get('sess:s-kid'))!).profileId).toBeUndefined();
    expect(JSON.parse((await env.kv.get('sess:s-own'))!).profileId).toBe(ANNA);
    expect(await audits('profile.admin_delete')).toEqual([{ actor: expect.any(String), target: ANNA, meta: { profile: KID } }]);
    await auditClean();
  });

  it('the owner profile stays; unknown profile 404; the media server failing keeps the profile', async () => {
    const owner = await remove(ANNA);
    expect(owner.statusCode).toBe(400);
    expect(owner.json()).toEqual({ error: 'owner_profile' });
    expect(await row(ANNA)).toBeDefined();
    expect((await remove('0a000000-0000-4000-a000-0000000000ff')).statusCode).toBe(404);
    failDelete = true;
    const f = await remove(BEN);
    expect(f.statusCode).toBe(502);
    expect(f.json()).toEqual({ error: 'jellyfin' });
    expect(await row(BEN)).toBeDefined();
    expect(await audits('profile.admin_delete')).toEqual([]);
  });
});
