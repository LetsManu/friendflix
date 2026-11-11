// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { permsOf } from '../src/permGuard.js';
import { DEFAULT_PERMS, KIDS_OFF, PERM_KEYS } from '../src/perms.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { parties } from '../src/routes/party.js';
import { ADMIN, cfg, ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

// Users & permissions Task 6: the role switches enforced on the server (comments, partySchedule, party, cast, requests) and
// GET /api/me.perms (the acting profile's effective switches, kids overlay applied). Every test sets up its own overrides and rooms.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let port = 0;
let admin: Sess, anna: Sess, ben: Sess, carla: Sess;
let adminId = '';

const ANNA = '0c000000-0000-4000-a000-000000000001';
const BEN = '0c000000-0000-4000-a000-000000000002';
const CARLA = '0c000000-0000-4000-a000-000000000003';
const EP = 'e'.repeat(32);
const MOVIE = 'c'.repeat(32);
const MOVIE2 = 'd'.repeat(32);
const ORIGIN = 'https://portal.example.com';
const dto = (id: string) => (id === EP
  ? { Id: EP, Name: 'Wrenfield Pier', SeriesName: 'Dunmoor', Type: 'Episode', UserData: { Played: true } }
  : { Id: id, Name: 'Saltwater Almanac', Type: 'Movie', UserData: {} });

let ip = 0;
// a fresh client address per request keeps the per-route limits (10 parties an hour, 10 casts a minute) out of the way
const call = (s: Sess, method: string, url: string, payload?: object) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-forwarded-for': `10.6.${Math.floor(++ip / 250)}.${ip % 250}` }, payload });
const comments = (s: Sess) => call(s, 'GET', `/api/items/${EP}/comments`);
const post = (s: Sess, body: string) => call(s, 'POST', `/api/items/${EP}/comments`, { body });
const rights = async (id: string, overrides: Record<string, boolean | null>) => {
  const r = await call(admin, 'PUT', `/api/admin/users/${id}/rights`, { overrides });
  expect(r.statusCode, r.body).toBe(200);
};
const rolePerms = async (role: string, perms: Record<string, boolean | null>) => {
  const r = await call(admin, 'PUT', `/api/admin/roles/${role}`, { perms });
  expect(r.statusCode, r.body).toBe(200);
};
/** a stored override written past the API (the API never stores one for admin): proves the admin lock in the resolver */
const rawPerms = async (userId: string, perms: Record<string, boolean>) => {
  await env.pool.query(
    'insert into user_limits(user_id, perms) values ($1, $2) on conflict (user_id) do update set perms = excluded.perms', [userId, JSON.stringify(perms)]);
  invalidateRights(userId);
};
/** an instant room hosted by Anna (allowed by default) */
const room = async () => {
  const r = await call(anna, 'POST', '/api/party', { itemId: MOVIE });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
};

const OPEN = 1; // WebSocket.OPEN
type Conn = { ws: WebSocket; msgs: any[]; closed: Promise<{ code: number; reason: string }> };
const connect = (id: string, s: Sess) =>
  new Promise<Conn>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/party/${id}`, { headers: { cookie: `ff_sid=${s.cookies.ff_sid}`, origin: ORIGIN } });
    const msgs: any[] = [];
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code: number, reason: Buffer) => r({ code, reason: reason.toString() })));
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs, closed }));
    ws.on('error', () => resolve({ ws, msgs, closed }));
    ws.on('unexpected-response', () => resolve({ ws, msgs, closed }));
  });
/** connected and welcomed into the room */
const join = async (id: string, s: Sess) => {
  const c = await connect(id, s);
  await vi.waitFor(() => expect(c.msgs[0]).toMatchObject({ t: 'welcome' }));
  return c;
};
const open: Conn[] = [];
const track = (c: Conn) => (open.push(c), c);

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => ({ json: dto(u.pathname.split('/')[2]!) }),
    'GET /Items': (u) => {
      const ids = (u.searchParams.get('ids') ?? u.searchParams.get('Ids') ?? '').split(',').filter(Boolean);
      return { json: { Items: ids.map(dto), TotalRecordCount: ids.length } };
    },
  });
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query<{ id: string }>("select id from users where role='admin' limit 1")).rows[0]!.id;
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
beforeEach(async () => {
  for (const c of open.splice(0)) { c.ws.close(); await c.closed; }
  parties.rooms.clear();
  await env.pool.query(`delete from user_limits; delete from role_settings; delete from episode_comments; delete from notifications;
    delete from poll_votes; delete from poll_options; delete from polls; update users set role = 'guest' where id = '${CARLA}'; update users set role = 'friend' where id in ('${ANNA}', '${BEN}');
    delete from profiles where kids`); // a kids profile locks the shared test device: the other sessions would land on it
  invalidateRoles(env.ctx);
  invalidateRights();
});

describe('comments switch', () => {
  it('guest still has no comments, a friend override hides theirs', async () => {
    expect((await post(ben, 'Der Leuchtturm am Ende!')).statusCode).toBe(200);
    expect((await comments(anna)).json().comments.map((c: { name: string }) => c.name)).toEqual(['Ben Muster']);
    // the guest role's default: neither read nor write
    expect((await comments(carla)).json()).toEqual({ watched: true, comments: [] });
    const g = await post(carla, 'Hallo');
    expect([g.statusCode, g.json()]).toEqual([403, { error: 'forbidden' }]);

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
    expect((await post(anna, 'Was für ein Finale')).statusCode).toBe(200);
    await rolePerms('guest', { comments: true });
    expect((await comments(carla)).json().comments.map((c: { name: string }) => c.name)).toEqual(['Anna Beispiel']);
    const mine = await post(carla, 'Schöne Folge');
    expect(mine.statusCode).toBe(200);
    expect((await comments(anna)).json().comments.some((c: { id: string }) => c.id === mine.json().id)).toBe(true);
    // the role back to its default: Carla's comment is hidden again
    await rolePerms('guest', { comments: null });
    expect((await comments(anna)).json().comments.some((c: { id: string }) => c.id === mine.json().id)).toBe(false);
    expect((await comments(carla)).json().comments).toEqual([]);
  });

  it('comments of an account whose role nobody knows are hidden (fail closed)', async () => {
    const own = (await env.pool.query<{ id: string }>('select id from profiles where user_id = $1 and is_owner', [CARLA])).rows[0]!.id;
    await env.pool.query("insert into episode_comments(item_id, profile_id, user_id, body) values ($1, $2, $3, 'Gruß aus Dunmoor')", [EP, own, CARLA]);
    await rolePerms('guest', { comments: true });
    expect((await comments(anna)).json().comments.map((c: { name: string }) => c.name)).toEqual(['Carla Probe']);
    await env.pool.query("update users set role = 'nosuchrole' where id = $1", [CARLA]);
    invalidateRights();
    expect((await comments(anna)).json().comments).toEqual([]);
  });
});

describe('party switches', () => {
  it('partySchedule replaces the admin check', async () => {
    await rights(ANNA, { partySchedule: true });
    for (let i = 0; i < 4; i++) {
      const r = await call(anna, 'POST', '/api/party', { itemId: MOVIE, startInMinutes: 60 });
      expect(r.statusCode, r.body).toBe(200);
    }
    // without the switch the 4th scheduled room is refused
    for (let i = 0; i < 3; i++) expect((await call(ben, 'POST', '/api/party', { itemId: MOVIE, startInMinutes: 60 })).statusCode).toBe(200);
    expect((await call(ben, 'POST', '/api/party', { itemId: MOVIE, startInMinutes: 60 })).statusCode).toBe(429);
    // admin: switches locked on, even a stored "off" (written past the API) changes nothing
    await rawPerms(adminId, { partySchedule: false, party: false });
    let last = '';
    for (let i = 0; i < 4; i++) {
      const r = await call(admin, 'POST', '/api/party', { itemId: MOVIE, startInMinutes: 60 });
      expect(r.statusCode, r.body).toBe(200);
      last = r.json().id;
    }
    expect((await call(admin, 'GET', `/api/party/${last}`)).statusCode).toBe(200);
  });

  it('party denied', async () => {
    const id = await room();
    expect((await call(ben, 'GET', '/api/party')).json().rooms.map((r: { id: string }) => r.id)).toEqual([id]); // allowed: Ben sees it
    await rights(BEN, { party: false });
    const r = await call(ben, 'POST', '/api/party', { itemId: MOVIE });
    expect([r.statusCode, r.json()]).toEqual([403, { error: 'party_forbidden' }]);
    expect((await call(ben, 'GET', '/api/party')).json()).toEqual({ rooms: [] });
    // an existing and a missing room answer the same: the refusal tells nothing about the room
    for (const rid of [id, 'nosuchroom1']) {
      const g = await call(ben, 'GET', `/api/party/${rid}`);
      expect([g.statusCode, g.json()]).toEqual([403, { error: 'party_forbidden' }]);
    }
    const inv = await call(ben, 'POST', `/api/party/${id}/invite`, { userIds: [ANNA] });
    expect([inv.statusCode, inv.json()]).toEqual([403, { error: 'party_forbidden' }]);

    // WebSocket: closed with 4403 before it joins (and the same for a room that does not exist)
    for (const rid of [id, 'nosuchroom1']) {
      const c = await connect(rid, ben);
      expect(await c.closed).toEqual({ code: 4403, reason: 'party_forbidden' });
    }
    expect([...parties.get(id)!.members.keys()]).not.toContain(BEN);
    track(await join(id, anna)); // Anna (allowed) still joins
  });

  it('an open socket is closed when a rights write turns party off', async () => {
    const id = await room();
    const a = track(await join(id, anna));
    const b = track(await join(id, ben));
    await rights(BEN, { party: false });
    expect(await b.closed).toEqual({ code: 4403, reason: 'party_forbidden' });
    await vi.waitFor(() => expect([...parties.get(id)!.members.keys()]).not.toContain(BEN));
    expect(a.ws.readyState).toBe(OPEN);
  });

  describe('party sockets of accounts that lose `party` through the account list', () => {
    /** Anna and Ben in one room; `act` runs; Anna's socket closes 4403, Ben's stays open */
    const losesParty = async (act: () => Promise<void>) => {
      const id = await room();
      const a = track(await join(id, anna));
      const b = track(await join(id, ben));
      await act();
      expect(await a.closed).toEqual({ code: 4403, reason: 'party_forbidden' });
      await new Promise((r) => setTimeout(r, 50));
      expect(b.ws.readyState).toBe(OPEN);
    };
    const roleOf = (id: string, role: string) => call(admin, 'PATCH', `/api/admin/users/${id}`, { role });

    it('bulk perm party off', () => losesParty(async () => {
      const r = await call(admin, 'POST', '/api/admin/users/bulk', { ids: [ANNA], action: 'perm', perm: 'party', value: false });
      expect([r.statusCode, r.json()]).toEqual([200, { done: 1 }]);
    }));

    it('bulk role change to a role without party', () => losesParty(async () => {
      await rolePerms('guest', { party: false });
      const r = await call(admin, 'POST', '/api/admin/users/bulk', { ids: [ANNA], action: 'role', role: 'guest' });
      expect([r.statusCode, r.json()]).toEqual([200, { done: 1 }]);
    }));

    it('single role change', () => losesParty(async () => {
      await rolePerms('guest', { party: false });
      expect((await roleOf(ANNA, 'guest')).statusCode).toBe(200);
    }));

    it('role delete with move', () => losesParty(async () => {
      const kino = (await call(admin, 'POST', '/api/admin/roles', { label: 'Kino', from: 'friend' })).json().key as string;
      const wenig = (await call(admin, 'POST', '/api/admin/roles', { label: 'Wenig', from: 'friend' })).json().key as string;
      await rolePerms(wenig, { party: false });
      expect((await roleOf(ANNA, kino)).statusCode).toBe(200);
      const r = await call(admin, 'DELETE', `/api/admin/roles/${kino}`, { moveTo: wenig });
      expect(r.statusCode, r.body).toBe(200);
    }));
  });

  it('an open socket is closed when the role write turns party off for its accounts', async () => {
    const id = await room();
    // Ben keeps it whatever the role says (stored directly: the API drops an override equal to the role's current value)
    await rawPerms(BEN, { party: true });
    const a = track(await join(id, anna));
    const b = track(await join(id, ben));
    const c = track(await join(id, carla)); // a guest: another role
    await rolePerms('friend', { party: false });
    expect(await a.closed).toEqual({ code: 4403, reason: 'party_forbidden' });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.ws.readyState).toBe(OPEN);
    expect(c.ws.readyState).toBe(OPEN);
  });

  it('invites skip people without the party switch', async () => {
    const id = await room();
    track(await join(id, anna));
    await rights(BEN, { party: false });
    const inv = await call(anna, 'POST', `/api/party/${id}/invite`, { userIds: [BEN, CARLA] });
    expect(inv.json()).toEqual({ sent: 1 });
    const got = (await env.pool.query<{ user_id: string }>("select user_id from notifications where kind = 'party_invite'")).rows.map((r) => r.user_id);
    expect(got).toEqual([CARLA]);
  });

  it('polls: no poll without party, no wish options without requests', async () => {
    const lib = [{ jfItemId: MOVIE }, { jfItemId: MOVIE2 }];
    const wish = [{ jfItemId: MOVIE }, { tmdbId: 7, mediaType: 'movie' }];
    await rights(BEN, { party: false });
    const p = await call(ben, 'POST', '/api/polls', { title: 'Filmabend', options: lib });
    expect([p.statusCode, p.json()]).toEqual([403, { error: 'party_forbidden' }]);
    await rights(ANNA, { requests: false });
    const before = env.seerrCalls.length;
    const w = await call(anna, 'POST', '/api/polls', { title: 'Filmabend', options: wish });
    expect([w.statusCode, w.json()]).toEqual([403, { error: 'requests_forbidden' }]);
    expect(env.seerrCalls.length).toBe(before); // refused before the request service is asked
    expect((await call(anna, 'POST', '/api/polls', { title: 'Filmabend', options: lib })).statusCode).toBe(200); // library options only
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

  it('cast off on the instance: 404 cast_disabled before the switch', async () => {
    await rights(BEN, { cast: false });
    const was = env.ctx.cfg.CAST_ENABLED;
    env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: 'false' };
    try {
      const r = await call(ben, 'POST', '/api/cast/session', { itemId: MOVIE });
      expect([r.statusCode, r.json()]).toEqual([404, { error: 'cast_disabled' }]);
    } finally {
      env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: was };
    }
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
    await rawPerms(adminId, { requests: false });
    expect((await call(admin, 'GET', '/api/requests/quota')).statusCode).toBe(200);
    expect((await call(anna, 'GET', '/api/requests/quota')).statusCode).toBe(200);
  });

  it('no request service: 404 requests_disabled before the switch', async () => {
    await rights(BEN, { requests: false });
    await env.ctx.settings.save({ REQUESTS_URL: null }, null);
    try {
      const r = await call(ben, 'GET', '/api/requests/quota');
      expect([r.statusCode, r.json()]).toEqual([404, { error: 'requests_disabled' }]);
    } finally {
      await env.ctx.settings.save({ REQUESTS_URL: cfg.REQUESTS_URL, REQUESTS_API_KEY: cfg.REQUESTS_API_KEY }, null);
    }
  });
});

describe('/api/me.perms', () => {
  it('/api/me.perms', async () => {
    const me = (await call(anna, 'GET', '/api/me')).json();
    expect(me.perms).toEqual(DEFAULT_PERMS.friend);
    expect(Object.keys(me.perms).sort()).toEqual([...PERM_KEYS].sort()); // the switches only, no sources
    expect(me.limits).toBeDefined();
    await rights(BEN, { party: false, cast: false, partySchedule: true });
    expect((await call(ben, 'GET', '/api/me')).json().perms).toEqual({ ...DEFAULT_PERMS.friend, party: false, cast: false, partySchedule: true });
    expect((await call(carla, 'GET', '/api/me')).json().perms).toEqual(DEFAULT_PERMS.guest);
    await rawPerms(adminId, { requests: false, party: false });
    expect((await call(admin, 'GET', '/api/me')).json().perms).toEqual(DEFAULT_PERMS.admin); // a stored "off" never reaches admin

    // a kids profile of Anna's account: the kids overlay switches KIDS_OFF off whatever the account allows; cast stays
    // (on a session of its own, so Anna's session of the other tests stays on her owner profile)
    const own = await env.login({ sub: 'sub-anna', email: 'sub-anna@friend.example.com', name: 'Anna Beispiel', groups: [] });
    const p = await call(own, 'POST', '/api/profiles', { name: 'Kind', kids: true, maxRating: 6 });
    expect(p.statusCode, p.body).toBe(201);
    const sel = await call(own, 'POST', `/api/profiles/${p.json().profile.id}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const kid: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: own.csrf };
    const kperms = (await call(kid, 'GET', '/api/me')).json().perms;
    for (const k of KIDS_OFF) expect(kperms[k], k).toBe(false);
    expect(kperms).toMatchObject({ cast: true, liveTv: true });
    // and the server refuses on the kids profile: a WebSocket closes 4403, cast is not refused by the switch
    const c = await connect('nosuchroom1', kid);
    expect((await c.closed).code).toBe(4403);
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
