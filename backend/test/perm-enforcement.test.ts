// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { permsOf } from '../src/permGuard.js';
import { DEFAULT_PERMS, KIDS_OFF, PERM_KEYS } from '../src/perms.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { ADMIN, ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

// Users & permissions Task 6: the role switches enforced on the server (comments, partySchedule, party, cast, requests) and
// GET /api/me.perms (the acting profile's effective switches, kids overlay applied).
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let port = 0;
let admin: Sess, anna: Sess, ben: Sess, carla: Sess;

const ANNA = '0c000000-0000-4000-a000-000000000001';
const BEN = '0c000000-0000-4000-a000-000000000002';
const CARLA = '0c000000-0000-4000-a000-000000000003';
const EP = 'e'.repeat(32);
const MOVIE = 'c'.repeat(32);
const ORIGIN = 'https://portal.example.com';
const dto = (id: string) => (id === EP
  ? { Id: EP, Name: 'Wrenfield Pier', SeriesName: 'Dunmoor', Type: 'Episode', UserData: { Played: true } }
  : { Id: id, Name: 'Saltwater Almanac', Type: 'Movie', UserData: {} });

const call = (s: Sess, method: string, url: string, payload?: object) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload });
const comments = (s: Sess) => call(s, 'GET', `/api/items/${EP}/comments`);
const post = (s: Sess, body: string) => call(s, 'POST', `/api/items/${EP}/comments`, { body });
const rights = async (id: string, overrides: Record<string, boolean | null>) => {
  const r = await call(admin, 'PUT', `/api/admin/users/${id}/rights`, { overrides });
  expect(r.statusCode, r.body).toBe(200);
};
/** a stored override written past the API (the API never stores one for admin): proves the admin lock in the resolver */
const rawPerms = async (userId: string, perms: Record<string, boolean>) => {
  await env.pool.query(
    'insert into user_limits(user_id, perms) values ($1, $2) on conflict (user_id) do update set perms = excluded.perms', [userId, JSON.stringify(perms)]);
  invalidateRights(userId);
};
const adminId = async () => (await env.pool.query<{ id: string }>("select id from users where role='admin' limit 1")).rows[0]!.id;

const connect = (id: string, s: Sess) =>
  new Promise<{ ws: WebSocket; msgs: any[]; closed: Promise<number> }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/party/${id}`, { headers: { cookie: `ff_sid=${s.cookies.ff_sid}`, origin: ORIGIN } });
    const msgs: any[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs, closed }));
    ws.on('error', () => resolve({ ws, msgs, closed }));
    ws.on('unexpected-response', () => resolve({ ws, msgs, closed }));
  });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => ({ json: dto(u.pathname.split('/')[2]!) }),
    'GET /Items': (u) => {
      const ids = (u.searchParams.get('ids') ?? u.searchParams.get('Ids') ?? '').split(',').filter(Boolean);
      return { json: { Items: ids.map(dto), TotalRecordCount: ids.length } };
    },
  });
  admin = await env.login(ADMIN);
  const enc = encrypt(keyFromBase64(ENC_KEY), 'pw');
  for (const [id, sub, name, role, jf] of [
    [ANNA, 'sub-anna', 'Anna Beispiel', 'friend', '1'.repeat(32)],
    [BEN, 'sub-ben', 'Ben Muster', 'friend', '2'.repeat(32)],
    [CARLA, 'sub-carla', 'Carla Probe', 'guest', '3'.repeat(32)],
  ] as const) {
    await env.pool.query(
      'insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, sub, `${sub}@friend.example.com`, name, role, jf, sub, enc]);
  }
  anna = await env.login({ sub: 'sub-anna', email: 'sub-anna@friend.example.com', name: 'Anna Beispiel', groups: [] });
  ben = await env.login({ sub: 'sub-ben', email: 'sub-ben@friend.example.com', name: 'Ben Muster', groups: [] });
  carla = await env.login({ sub: 'sub-carla', email: 'sub-carla@friend.example.com', name: 'Carla Probe', groups: [] });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(() => env.close());

describe('comments switch', () => {
  it('guest still has no comments, a friend override hides theirs', async () => {
    expect((await post(ben, 'Der Leuchtturm am Ende!')).statusCode).toBe(200);
    expect((await comments(anna)).json().comments.map((c: { name: string }) => c.name)).toEqual(['Ben Muster']);
    // the guest role's default: neither read nor write
    expect((await comments(carla)).json()).toEqual({ watched: true, comments: [] });
    expect((await post(carla, 'Hallo')).json()).toEqual({ error: 'forbidden' });
    expect((await post(carla, 'Hallo')).statusCode).toBe(403);

    await rights(BEN, { comments: false });
    const denied = await post(ben, 'Noch einer');
    expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'forbidden' }]);
    expect((await comments(ben)).json()).toEqual({ watched: true, comments: [] });
    expect((await comments(anna)).json().comments).toEqual([]); // Ben's earlier comment is hidden from everybody

    // back to the role (written past the API): visible again once the cached answers are dropped
    await env.pool.query("update user_limits set perms = '{}'::jsonb where user_id = $1", [BEN]);
    invalidateRights(BEN);
    expect((await comments(anna)).json().comments.map((c: { name: string }) => c.name)).toEqual(['Ben Muster']);
    expect((await post(ben, 'Wieder da')).statusCode).toBe(200);
  });

  it('guest granted comments', async () => {
    const put = await call(admin, 'PUT', '/api/admin/roles/guest', { perms: { comments: true } });
    expect(put.statusCode, put.body).toBe(200);
    expect((await comments(carla)).json().comments.length).toBeGreaterThan(0);
    const mine = await post(carla, 'Schöne Folge');
    expect(mine.statusCode).toBe(200);
    expect((await comments(anna)).json().comments.some((c: { id: string }) => c.id === mine.json().id)).toBe(true);
    // the role back to its default: Carla's comment is hidden again
    expect((await call(admin, 'PUT', '/api/admin/roles/guest', { perms: { comments: null } })).statusCode).toBe(200);
    expect((await comments(anna)).json().comments.some((c: { id: string }) => c.id === mine.json().id)).toBe(false);
    expect((await comments(carla)).json().comments).toEqual([]);
  });
});

describe('party switches', () => {
  const create = (s: Sess, body: object) => call(s, 'POST', '/api/party', body);
  let room = '';

  it('partySchedule replaces the admin check', async () => {
    await rights(ANNA, { partySchedule: true });
    for (let i = 0; i < 4; i++) {
      const r = await create(anna, { itemId: MOVIE, startInMinutes: 60 });
      expect(r.statusCode, r.body).toBe(200);
      room = r.json().id;
    }
    // admin: switches locked on, even a stored "off" (written past the API) changes nothing
    await rawPerms(await adminId(), { partySchedule: false, party: false });
    for (let i = 0; i < 4; i++) expect((await create(admin, { itemId: MOVIE, startInMinutes: 60 })).statusCode).toBe(200);
    expect((await call(admin, 'GET', `/api/party/${room}`)).statusCode).toBe(200);
  });

  it('party denied', async () => {
    expect((await call(ben, 'GET', '/api/party')).json().rooms.length).toBeGreaterThan(0); // allowed: Ben sees Anna's rooms
    await rights(BEN, { party: false });
    const r = await create(ben, { itemId: MOVIE });
    expect([r.statusCode, r.json()]).toEqual([403, { error: 'party_forbidden' }]);
    expect((await call(ben, 'GET', '/api/party')).json()).toEqual({ rooms: [] });
    // an existing and a missing room answer the same: the refusal tells nothing about the room
    for (const id of [room, 'nosuchroom1']) {
      const g = await call(ben, 'GET', `/api/party/${id}`);
      expect([g.statusCode, g.json()]).toEqual([403, { error: 'party_forbidden' }]);
    }
    const inv = await call(ben, 'POST', `/api/party/${room}/invite`, { userIds: [ANNA] });
    expect([inv.statusCode, inv.json()]).toEqual([403, { error: 'party_forbidden' }]);

    // WebSocket: closed with 4403 before it joins (and the same for a room that does not exist)
    for (const id of [room, 'nosuchroom1']) {
      const c = await connect(id, ben);
      expect(await c.closed).toBe(4403);
    }
    expect([...(await import('../src/routes/party.js')).parties.get(room)!.members.keys()]).not.toContain(BEN);
    // Anna (allowed) still joins
    const ok = await connect(room, anna);
    await vi.waitFor(() => expect(ok.msgs[0]).toMatchObject({ t: 'welcome' }));
    ok.ws.close();
    await ok.closed;
  });
});

describe('cast switch', () => {
  it('cast denied', async () => {
    await rights(BEN, { cast: false });
    const r = await call(ben, 'POST', '/api/cast/session', { itemId: MOVIE });
    expect([r.statusCode, r.json()]).toEqual([403, { error: 'cast_forbidden' }]);
    const a = await call(anna, 'POST', '/api/cast/session', { itemId: MOVIE });
    expect(a.json().error).not.toBe('cast_forbidden'); // past the switch (the fake has no playable item)
    expect(a.statusCode).not.toBe(403);
  });
});

describe('requests switch', () => {
  it('requests denied', async () => {
    expect((await call(ben, 'GET', '/api/requests/quota')).statusCode).toBe(200);
    await rights(BEN, { requests: false });
    const before = env.seerrCalls.length;
    for (const [method, url, body] of [
      ['POST', '/api/requests', { mediaType: 'movie', tmdbId: 1 }], ['GET', '/api/requests/quota'], ['GET', '/api/requests/mine'], ['GET', '/api/seerr/search?q=dunmoor'],
    ] as const) {
      const r = await call(ben, method, url, body);
      expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([403, { error: 'requests_forbidden' }]);
    }
    expect(env.seerrCalls.length).toBe(before); // refused before the request service is asked
    // admin: always allowed, even with a stored "off"
    await rawPerms(await adminId(), { requests: false });
    expect((await call(admin, 'GET', '/api/requests/quota')).statusCode).toBe(200);
    expect((await call(anna, 'GET', '/api/requests/quota')).statusCode).toBe(200);
  });
});

describe('/api/me.perms', () => {
  it('/api/me.perms', async () => {
    invalidateRoles(env.ctx);
    const me = (await call(anna, 'GET', '/api/me')).json();
    // Anna has a partySchedule override (above); everything else is the friend default
    expect(me.perms).toEqual({ ...DEFAULT_PERMS.friend, partySchedule: true });
    expect(Object.keys(me.perms).sort()).toEqual([...PERM_KEYS].sort()); // the switches only, no sources
    expect(me.limits).toBeDefined();
    expect((await call(ben, 'GET', '/api/me')).json().perms).toEqual({ ...DEFAULT_PERMS.friend, party: false, cast: false, requests: false });
    expect((await call(carla, 'GET', '/api/me')).json().perms).toEqual(DEFAULT_PERMS.guest);
    expect((await call(admin, 'GET', '/api/me')).json().perms).toEqual(DEFAULT_PERMS.admin); // a stored "off" never reaches admin

    // a kids profile of Anna's account: the kids overlay switches KIDS_OFF off whatever the account allows; cast stays
    const p = await call(anna, 'POST', '/api/profiles', { name: 'Kind', kids: true, maxRating: 6 });
    expect(p.statusCode, p.body).toBe(201);
    const sel = await call(anna, 'POST', `/api/profiles/${p.json().profile.id}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const kid: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: anna.csrf };
    const kperms = (await call(kid, 'GET', '/api/me')).json().perms;
    for (const k of KIDS_OFF) expect(kperms[k], k).toBe(false);
    expect(kperms).toMatchObject({ cast: true, liveTv: true });
    // and the server refuses on the kids profile: a WebSocket closes 4403, cast is not refused by the switch
    const c = await connect('nosuchroom1', kid);
    expect(await c.closed).toBe(4403);
    expect((await call(kid, 'POST', '/api/cast/session', { itemId: MOVIE })).json().error).not.toBe('cast_forbidden');
  });
});

describe('permsOf', () => {
  it('fails closed without an account or with a role nobody knows', async () => {
    const none = Object.fromEntries(PERM_KEYS.map((k) => [k, false]));
    expect(await permsOf(env.ctx, {} as never)).toEqual(none);
    expect(await permsOf(env.ctx, { user: { id: CARLA, role: 'nosuchrole' } } as never)).toEqual(none);
    // memoised per request, but a caller cannot change the remembered answer
    const req = { user: { id: ANNA, role: 'friend' } } as never;
    (await permsOf(env.ctx, req)).party = false;
    expect((await permsOf(env.ctx, req)).party).toBe(true);
  });
});
