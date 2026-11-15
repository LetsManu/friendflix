// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 18: channel groups (incl. release), per-profile channel rights (spec §8), `features.livetv` (ruling 13) and the
 * Live TV data on the Phase 0 people pages (role matrix, Rechte, Sicht prüfen).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { updateGroup } from '../src/livetv/groups.js';
import { allowedGroups, channelAllowed, channelSet, invalidateLivetvRights, livetvFeature } from '../src/livetv/rights.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { writeRole } from '../src/roleWrite.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const installed = { v: true };
vi.mock('../src/livetv/detect.js', async (orig) => ({
  ...(await orig<typeof import('../src/livetv/detect.js')>()),
  livetvInstalled: vi.fn(() => installed.v),
}));

type Sess = { cookies: Record<string, string>; csrf: string };
type Who = { user: { id: string; role: string }; profile: { id: string; kids: boolean } };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);
const hex = (c: string) => c.repeat(32);

// people (fictional): the admin, Anna Beispiel (family, with a kids profile), Ben Muster (friend), Carla Probe (guest)
let adminId = '';
const ANNA = '0c000000-0000-4000-a000-000000000001';
const ANNA_KIDS = '0c000000-0000-4000-a000-000000000002';
const BEN = '0c000000-0000-4000-a000-000000000003';
const CARLA = '0c000000-0000-4000-a000-000000000004';
const ADMIN_KIDS = '0c000000-0000-4000-a000-000000000005';
const who = {
  admin: (): Who => ({ user: { id: adminId, role: 'admin' }, profile: { id: adminId, kids: false } }),
  adminKids: (): Who => ({ user: { id: adminId, role: 'admin' }, profile: { id: ADMIN_KIDS, kids: true } }),
  anna: (): Who => ({ user: { id: ANNA, role: 'family' }, profile: { id: ANNA, kids: false } }),
  annaKids: (): Who => ({ user: { id: ANNA, role: 'family' }, profile: { id: ANNA_KIDS, kids: true } }),
  ben: (): Who => ({ user: { id: BEN, role: 'friend' }, profile: { id: BEN, kids: false } }),
  carla: (): Who => ({ user: { id: CARLA, role: 'guest' }, profile: { id: CARLA, kids: false } }),
};
const sees = async (w: Who) => [...(await channelSet(env.ctx, w.user, w.profile))].map((id) => names.get(id)).sort();
const names = new Map<string, string>();

let addr = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });

let source = '';
let off = '';
async function group(name: string, o: { released?: boolean; kid?: boolean; roles?: string[] } = {}): Promise<string> {
  const id = (await env.pool.query<{ id: string }>(
    `insert into livetv_groups(id, name, kid_friendly, released, position)
     values (gen_random_uuid(), $1, $2, $3, (select coalesce(max(position) + 1, 0) from livetv_groups)) returning id`, [name, o.kid ?? false, o.released ?? true])).rows[0]!.id;
  for (const r of o.roles ?? []) await env.pool.query('insert into livetv_group_roles(group_id, role) values ($1, $2)', [id, r]);
  invalidateLivetvRights(); // direct table writes in the test; the routes do this themselves
  return id;
}
/** maps a provider group-title of `src` onto a group */
const map = (providerGroup: string, groupId: string, src = source) =>
  env.pool.query('insert into livetv_group_map(source_id, provider_group, group_id) values ($1, $2, $3)', [src, providerGroup, groupId]);
let n = 0;
async function channel(name: string, o: { importGroup?: string; override?: string; src?: string; hidden?: boolean; missing?: boolean } = {}): Promise<string> {
  const id = (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, import_group, group_override, hidden, missing_since)
     values (gen_random_uuid(), $1, $2, $3, 'hls', $4, $5, $6, $7, $8) returning id`,
    [o.src ?? source, `k${++n}`, encrypt(key, `https://iptv.example.com/live/${n}.m3u8`), name, o.importGroup ?? null, o.override ?? null, o.hidden ?? false, o.missing ? new Date() : null])).rows[0]!.id;
  names.set(id, name);
  invalidateLivetvRights();
  return id;
}

async function account(id: string, role: string, name: string, jf: string): Promise<void> {
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
     values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, `${name.split(' ')[0]!.toLowerCase()}-sub`, `${name.split(' ')[0]!.toLowerCase()}@friend.example.com`, name, role, jf, encrypt(key, 'pw')]);
  await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name.split(' ')[0]]);
}

beforeAll(async () => {
  env = await makeEnv({ 'GET /Items': () => ({ json: { Items: [], TotalRecordCount: 0 } }) });
  admin = await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
  await account(ANNA, 'family', 'Anna Beispiel', hex('1'));
  await account(BEN, 'friend', 'Ben Muster', hex('2'));
  await account(CARLA, 'guest', 'Carla Probe', hex('3'));
  await env.pool.query(
    `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
     values ($1, $2, 'Kiddo', $3, 'anna-kiddo', $4, true, 6), ($5, $6, 'Kleine', $7, 'admin-kleine', $4, true, 12)`,
    [ANNA_KIDS, ANNA, hex('4'), encrypt(key, 'kpw'), ADMIN_KIDS, adminId, hex('5')]);
});
afterAll(() => env.close());
beforeEach(async () => {
  installed.v = true;
  await env.pool.query('delete from livetv_channels; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from user_limits; delete from audit_log');
  source = (await env.pool.query<{ id: string }>("insert into livetv_sources(id, kind, name) values (gen_random_uuid(), 'manual', 'Eigene Feeds') returning id")).rows[0]!.id;
  off = (await env.pool.query<{ id: string }>("insert into livetv_sources(id, kind, name, enabled) values (gen_random_uuid(), 'manual', 'Aus', false) returning id")).rows[0]!.id;
  names.clear();
  invalidateRoles(env.ctx);
  invalidateRights();
});

describe('unreleased groups', () => {
  it('unreleased groups are invisible to everyone', async () => {
    // a group an import created: unreleased, its channels imported; even a role grant and a per-user allow do not reach it (ruling 39)
    const g = await group('DE | Neu', { released: false, roles: ['family', 'friend'] });
    await map('DE | Neu', g);
    await channel('Nordlicht TV', { importGroup: 'DE | Neu' });
    await channel('Hafenkanal', { override: g });
    expect((await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [g], deny: [] })).statusCode).toBe(200);
    for (const w of [who.admin(), who.anna(), who.ben(), who.carla()]) expect(await sees(w)).toEqual([]);
    expect((await allowedGroups(env.ctx, who.ben().user, who.ben().profile))!.ids.has(g)).toBe(false);
    // the only group: no channel for anyone, so no Live-TV tab (the admin included)
    expect(await livetvFeature(env.ctx, who.admin().user, who.admin().profile)).toBe(false);
    expect((await call('GET', '/api/me')).json().features.livetv).toBe(false);
    const chk = (await call('GET', `/api/admin/users/${BEN}/check?profile=${BEN}`)).json();
    expect(chk.livetv).toEqual({ groups: [{ id: g, name: 'DE | Neu', visible: false, reason: 'notReleased' }], channels: 0 });
    // the admin list shows it first, with the pending count
    await group('Nachrichten');
    const list = (await call('GET', '/api/admin/livetv/groups')).json();
    expect(list.pending).toBe(1);
    expect(list.groups.map((x: { name: string }) => x.name)).toEqual(['DE | Neu', 'Nachrichten']);
    expect(list.groups[0]).toEqual({ id: g, name: 'DE | Neu', kidFriendly: false, roles: ['family', 'friend'], released: false, position: 0, channels: 2, providerGroups: ['DE | Neu'] });
  });

  it('release grants roles and shows the channels', async () => {
    const g = await group('DE | Doku', { released: false });
    await map('DE | Doku', g);
    await channel('Sternwarte 24', { importGroup: 'DE | Doku' });
    expect(await sees(who.anna())).toEqual([]); // cached now: the release must drop it
    const r = await call('POST', '/api/admin/livetv/groups/release', { ids: [g], roles: ['family'], kidFriendly: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ released: 1 });
    expect(await sees(who.anna())).toEqual(['Sternwarte 24']);
    expect(await sees(who.ben())).toEqual([]);
    expect(await sees(who.admin())).toEqual(['Sternwarte 24']);
    const [a] = (await env.pool.query("select target, meta from audit_log where action = 'livetv.group.release'")).rows;
    expect(a.meta).toEqual({ ids: [g], roles: ['family'], kidFriendly: false });

    // no role: only admins and per-user allows
    expect((await call('POST', '/api/admin/livetv/groups/release', { ids: [g], roles: [], kidFriendly: false })).json()).toEqual({ released: 1 });
    await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [g], deny: [] });
    expect(await sees(who.anna())).toEqual([]);
    expect(await sees(who.ben())).toEqual(['Sternwarte 24']);
    expect(await sees(who.admin())).toEqual(['Sternwarte 24']);

    // Freigabe zurücknehmen: hidden from everyone again, the roles stay
    await call('POST', '/api/admin/livetv/groups/release', { ids: [g], roles: ['family'], kidFriendly: false });
    const p = await call('PATCH', `/api/admin/livetv/groups/${g}`, { released: false });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ id: g, released: false, roles: ['family'] });
    for (const w of [who.admin(), who.anna(), who.ben()]) expect(await sees(w)).toEqual([]);
  });

  it('release refuses an unknown role and a bad body', async () => {
    const g = await group('DE | Musik', { released: false });
    expect((await call('POST', '/api/admin/livetv/groups/release', { ids: [g], roles: ['nobody'], kidFriendly: false })).json()).toEqual({ error: 'invalid', field: 'roles' });
    expect((await call('POST', '/api/admin/livetv/groups/release', { ids: [], roles: [], kidFriendly: false })).json()).toEqual({ error: 'invalid', field: 'ids' });
    expect((await env.pool.query('select released from livetv_groups where id = $1', [g])).rows[0].released).toBe(false);
  });
});

describe('groups the admin makes', () => {
  it('manual groups start released', async () => {
    const r = await call('POST', '/api/admin/livetv/groups', { name: 'Hafen', roles: ['friend'] });
    expect(r.statusCode).toBe(201);
    const g = r.json();
    expect(g).toEqual({ id: expect.any(String), name: 'Hafen', kidFriendly: false, roles: ['friend'], released: true, position: 0, channels: 0, providerGroups: [] });
    await channel('Hafenkanal', { override: g.id });
    expect(await sees(who.ben())).toEqual(['Hafenkanal']);
    expect(await sees(who.anna())).toEqual([]);
    expect((await call('POST', '/api/admin/livetv/groups', { name: 'hafen' })).json()).toEqual({ error: 'name_taken' });
    expect((await call('POST', '/api/admin/livetv/groups', { name: 'x'.repeat(41) })).json()).toEqual({ error: 'invalid', field: 'name' });
    const [a] = (await env.pool.query("select target, meta from audit_log where action = 'livetv.group.create'")).rows;
    expect(a).toEqual({ target: g.id, meta: { fields: ['name', 'kidFriendly', 'roles', 'released'] } });
  });

  it('rename, order and delete', async () => {
    const a = (await call('POST', '/api/admin/livetv/groups', { name: 'Sport' })).json().id as string;
    const b = (await call('POST', '/api/admin/livetv/groups', { name: 'Nachrichten' })).json().id as string;
    const c = (await call('POST', '/api/admin/livetv/groups', { name: 'Kinder' })).json().id as string;
    expect((await call('PATCH', `/api/admin/livetv/groups/${a}`, { name: 'Sport & Spiel' })).json()).toMatchObject({ name: 'Sport & Spiel' });
    expect((await call('PUT', '/api/admin/livetv/groups/order', { ids: [c, a] })).json()).toEqual({ ok: true });
    const list = (await call('GET', '/api/admin/livetv/groups')).json();
    expect(list.groups.map((x: { id: string; position: number }) => [x.id, x.position])).toEqual([[c, 0], [a, 1], [b, 2]]);
    const ch = await channel('Bergblick Sport', { override: a });
    expect((await call('DELETE', `/api/admin/livetv/groups/${a}`)).json()).toEqual({ ok: true });
    expect((await env.pool.query('select group_override from livetv_channels where id = $1', [ch])).rows[0].group_override).toBeNull();
    expect(await sees(who.admin())).toEqual(['Bergblick Sport']); // Ohne Gruppe: only admins
    expect((await call('DELETE', `/api/admin/livetv/groups/${a}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/admin/livetv/groups/${a}`, { name: 'X' })).statusCode).toBe(404);
  });
});

describe('per-profile channel rights', () => {
  it('roles and exceptions', async () => {
    const sport = await group('Sport', { roles: ['family'] });
    await map('DE | Sport', sport);
    const sportCh = await channel('Bergblick Sport', { importGroup: 'DE | Sport' });
    await channel('Sternwarte 24'); // no group
    expect(await sees(who.ben())).toEqual([]);
    expect(await sees(who.anna())).toEqual(['Bergblick Sport']);
    expect(await channelAllowed(env.ctx, who.anna().user, who.anna().profile, sportCh)).toBe(true);
    expect(await channelAllowed(env.ctx, who.ben().user, who.ben().profile, sportCh)).toBe(false);
    // the admin role: every group and the channels without a group
    expect(await sees(who.admin())).toEqual(['Bergblick Sport', 'Sternwarte 24']);
    expect(await allowedGroups(env.ctx, who.admin().user, who.admin().profile)).toEqual({ all: true, ids: new Set([sport]) });

    expect((await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [sport], deny: [] })).json())
      .toEqual({ livetvGroups: { allow: [{ id: sport, name: 'Sport' }], deny: [] } });
    expect(await sees(who.ben())).toEqual(['Bergblick Sport']);
    await call('PUT', `/api/admin/users/${ANNA}/livetv-groups`, { allow: [], deny: [sport] });
    expect(await sees(who.anna())).toEqual([]);
    const [a] = (await env.pool.query("select target, meta from audit_log where action = 'user.livetv_groups' order by id desc limit 1")).rows;
    expect(a).toEqual({ target: ANNA, meta: { allow: [], deny: [sport] } });

    // a guest sees nothing until the group is granted to guests
    expect(await sees(who.carla())).toEqual([]);
    await call('PATCH', `/api/admin/livetv/groups/${sport}`, { roles: ['family', 'guest'] });
    expect(await sees(who.carla())).toEqual(['Bergblick Sport']);
  });

  it('exceptions refuse overlaps, unknown groups and the admin role', async () => {
    const sport = await group('Sport');
    expect((await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [sport], deny: [sport] })).json()).toEqual({ error: 'invalid', field: 'deny' });
    expect((await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: ['0c000000-0000-4000-a000-0000000000ff'], deny: [] })).json()).toEqual({ error: 'invalid', field: 'allow' });
    expect((await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: 'x', deny: [] })).json()).toEqual({ error: 'invalid', field: 'allow' });
    expect((await call('PUT', `/api/admin/users/${adminId}/livetv-groups`, { allow: [], deny: [sport] })).json()).toEqual({ error: 'admin_groups_locked' });
    expect((await call('PUT', `/api/admin/users/${adminId}/livetv-groups`, { allow: [], deny: [] })).statusCode).toBe(200);
    expect((await call('PUT', '/api/admin/users/0c000000-0000-4000-a000-0000000000ee/livetv-groups', { allow: [], deny: [] })).statusCode).toBe(404);
    expect((await env.pool.query('select count(*)::int n from livetv_group_users')).rows[0].n).toBe(0);
  });

  it('kids see kid-friendly groups only', async () => {
    const kinder = await group('Kinderinsel', { kid: true, roles: ['family'] });
    const sport = await group('Sport', { roles: ['family'] });
    await channel('Kinderinsel', { override: kinder });
    await channel('Bergblick Sport', { override: sport });
    await channel('Sternwarte 24'); // no group: never for a kids profile
    expect(await sees(who.anna())).toEqual(['Bergblick Sport', 'Kinderinsel']);
    expect(await sees(who.annaKids())).toEqual(['Kinderinsel']);
    // an admin's kids profile: kid-friendly groups only, no channels without a group
    expect(await sees(who.adminKids())).toEqual(['Kinderinsel']);
    expect(await allowedGroups(env.ctx, who.adminKids().user, who.adminKids().profile)).toEqual({ all: false, ids: new Set([kinder]) });
    expect(await livetvFeature(env.ctx, who.annaKids().user, who.annaKids().profile)).toBe(true);
    // no kid-friendly group -> no tab for kids
    await call('PATCH', `/api/admin/livetv/groups/${kinder}`, { kidFriendly: false });
    expect(await livetvFeature(env.ctx, who.annaKids().user, who.annaKids().profile)).toBe(false);
    expect(await livetvFeature(env.ctx, who.adminKids().user, who.adminKids().profile)).toBe(false);
    expect(await livetvFeature(env.ctx, who.anna().user, who.anna().profile)).toBe(true);
  });

  it('liveTv switched off → nothing', async () => {
    const g = await group('Nachrichten', { roles: ['family'] });
    await channel('Nordlicht TV', { override: g });
    expect(await sees(who.anna())).toEqual(['Nordlicht TV']);
    // the Phase 0 override: invalidateRights drops the cached channel set too
    expect((await call('PUT', `/api/admin/users/${ANNA}/rights`, { overrides: { liveTv: false } })).statusCode).toBe(200);
    expect(await allowedGroups(env.ctx, who.anna().user, who.anna().profile)).toBeNull();
    expect(await sees(who.anna())).toEqual([]);
    expect(await sees(who.annaKids())).toEqual([]);
    expect((await call('GET', `/api/admin/users/${ANNA}/check?profile=${ANNA}`)).json().livetv).toBeNull();
  });

  it('hidden, missing and disabled sources are out', async () => {
    const g = await group('Nachrichten', { roles: ['family'] });
    await map('DE | News', g);
    await map('DE | News', g, off);
    await channel('Nordlicht TV', { importGroup: 'DE | News' });
    await channel('Hafenkanal', { importGroup: 'DE | News', hidden: true });
    await channel('Sternwarte 24', { importGroup: 'DE | News', missing: true });
    await channel('Kanal Wolkenlos', { importGroup: 'DE | News', src: off });
    expect(await sees(who.anna())).toEqual(['Nordlicht TV']);
    expect(await sees(who.admin())).toEqual(['Nordlicht TV']);
  });

  it('writes invalidate at once', async () => {
    const g = (await call('POST', '/api/admin/livetv/groups', { name: 'Nachrichten', roles: ['family'] })).json().id as string;
    await channel('Nordlicht TV', { override: g });
    expect(await sees(who.anna())).toEqual(['Nordlicht TV']);
    expect(await sees(who.ben())).toEqual([]);
    await call('PATCH', `/api/admin/livetv/groups/${g}`, { roles: ['friend'] });
    expect(await sees(who.anna())).toEqual([]);
    expect(await sees(who.ben())).toEqual(['Nordlicht TV']);
    await call('DELETE', `/api/admin/livetv/groups/${g}`);
    expect(await sees(who.ben())).toEqual([]);
  });

  it('features.livetv', async () => {
    const g = await group('Nachrichten', { roles: ['family'] });
    installed.v = false;
    await channel('Nordlicht TV', { override: g });
    expect((await call('GET', '/api/me')).json().features.livetv).toBe(false);
    expect(await livetvFeature(env.ctx, who.anna().user, who.anna().profile)).toBe(false);
    installed.v = true;
    expect((await call('GET', '/api/me')).json().features.livetv).toBe(true);
    expect(await livetvFeature(env.ctx, who.anna().user, who.anna().profile)).toBe(true);
    expect(await livetvFeature(env.ctx, who.ben().user, who.ben().profile)).toBe(false);
  });
});

describe('merge', () => {
  it('merge moves maps and overrides', async () => {
    const sport = await group('Sport', { roles: ['family'] });
    const hd = await group('Sport HD', { roles: ['friend'] });
    const extra = await group('Sport Extra');
    await map('DE | Sport', sport);
    await map('Sport HD', hd);
    await map('Sport Extra', extra);
    await channel('Bergblick Sport', { importGroup: 'DE | Sport' });
    await channel('Bergblick Sport HD', { importGroup: 'Sport HD' });
    const moved = await channel('Hafenkanal', { override: hd });
    await channel('Kanal Wolkenlos', { importGroup: 'Sport Extra' });
    await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [hd], deny: [] });
    expect(await sees(who.ben())).toEqual(['Bergblick Sport HD', 'Hafenkanal']);
    // a merge with nothing but `into` is refused (and not audited); `into` among other ids is dropped
    expect((await call('POST', '/api/admin/livetv/groups/merge', { ids: [sport], into: sport })).json()).toEqual({ error: 'invalid', field: 'ids' });
    const r = await call('POST', '/api/admin/livetv/groups/merge', { ids: [hd, extra, sport], into: sport });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: sport, name: 'Sport', kidFriendly: false, roles: ['family'], released: true, position: 0, channels: 4, providerGroups: ['DE | Sport', 'Sport Extra', 'Sport HD'] });
    expect((await env.pool.query('select group_override from livetv_channels where id = $1', [moved])).rows[0].group_override).toBe(sport);
    expect((await env.pool.query('select id from livetv_groups')).rows.map((x) => x.id)).toEqual([sport]);
    // the merged groups' roles and exceptions went with them; Sport keeps its own
    expect(await sees(who.ben())).toEqual([]);
    expect(await sees(who.anna())).toEqual(['Bergblick Sport', 'Bergblick Sport HD', 'Hafenkanal', 'Kanal Wolkenlos']);
    const merges = (await env.pool.query("select target, meta from audit_log where action = 'livetv.group.merge'")).rows;
    expect(merges).toHaveLength(1);
    expect(merges[0].target).toBe(sport);
    expect([...merges[0].meta.ids].sort()).toEqual([hd, extra].sort());
    expect((await call('POST', '/api/admin/livetv/groups/merge', { ids: [sport], into: hd })).statusCode).toBe(404);
  });
});

describe('merge with into among ids', () => {
  it('ids [a, b] into b merges a into b', async () => {
    const a = await group('Sport HD');
    const b = await group('Sport');
    await map('Sport HD', a);
    await channel('Bergblick Sport HD', { importGroup: 'Sport HD' });
    const r = await call('POST', '/api/admin/livetv/groups/merge', { ids: [a, b], into: b });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: b, providerGroups: ['Sport HD'], channels: 1 });
    expect((await env.pool.query('select id from livetv_groups')).rows.map((x) => x.id)).toEqual([b]);
    const merges = (await env.pool.query("select target, meta from audit_log where action = 'livetv.group.merge'")).rows;
    expect(merges).toEqual([{ target: b, meta: { ids: [a] } }]);
  });

  it('ids [b] into b answers 400', async () => {
    const b = await group('Sport');
    expect((await call('POST', '/api/admin/livetv/groups/merge', { ids: [b], into: b })).json()).toEqual({ error: 'invalid', field: 'ids' });
    expect((await env.pool.query("select count(*)::int n from audit_log where action = 'livetv.group.merge'")).rows[0].n).toBe(0);
    expect((await env.pool.query('select id from livetv_groups')).rows.map((x) => x.id)).toEqual([b]);
  });
});

describe('Phase 0 people pages', () => {
  it('people pages carry the data', async () => {
    const sport = await group('Sport', { roles: ['family', 'friend'] });
    const kinder = await group('Kinderinsel', { kid: true, roles: ['family'] });
    const neu = await group('DE | Neu', { released: false, roles: ['family'] });
    await channel('Bergblick Sport', { override: sport });
    await channel('Kinderinsel', { override: kinder });
    await channel('Nordlicht TV', { override: neu });
    await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [kinder], deny: [sport] });

    const rights = (await call('GET', `/api/admin/users/${BEN}/rights`)).json();
    expect(rights.livetvGroups).toEqual({ allow: [{ id: kinder, name: 'Kinderinsel' }], deny: [{ id: sport, name: 'Sport' }] });
    expect(rights.rows.some((r: { key: string }) => r.key === 'liveTv')).toBe(true);
    expect((await call('GET', `/api/admin/users/${ANNA}/rights`)).json().livetvGroups).toEqual({ allow: [], deny: [] });

    const kids = (await call('GET', `/api/admin/users/${ANNA}/check?profile=${ANNA_KIDS}`)).json();
    expect(kids.libraries).toBeDefined();
    expect(kids.livetv).toEqual({
      groups: [
        { id: neu, name: 'DE | Neu', visible: false, reason: 'notReleased' },
        { id: sport, name: 'Sport', visible: false, reason: 'notKidFriendly' },
        { id: kinder, name: 'Kinderinsel', visible: true, reason: null },
      ],
      channels: 1,
    });
    const ben = (await call('POST', `/api/admin/users/${BEN}/check`, { profileId: BEN, query: 'Dunmoor' })).json();
    expect(ben.livetv.groups.map((g: { name: string; reason: string | null }) => [g.name, g.reason])).toEqual([['DE | Neu', 'notReleased'], ['Sport', 'denied'], ['Kinderinsel', null]]);
    expect(ben.livetv.channels).toBe(1);
    const carla = (await call('GET', `/api/admin/users/${CARLA}/check?profile=${CARLA}`)).json();
    expect(carla.livetv.groups.find((g: { id: string }) => g.id === sport)).toEqual({ id: sport, name: 'Sport', visible: false, reason: 'notGranted' });
    installed.v = false;
    expect((await call('GET', `/api/admin/users/${CARLA}/check?profile=${CARLA}`)).json().livetv).toBeNull();

    const roles = (await call('GET', '/api/admin/roles')).json().matrix.roles as Array<{ key: string; livetvGroups: string[] }>;
    const of = (k: string) => roles.find((r) => r.key === k)!.livetvGroups;
    expect(of('family')).toEqual(['Sport', 'Kinderinsel']);
    expect(of('friend')).toEqual(['Sport']);
    expect(of('guest')).toEqual([]);
    expect(of('admin')).toEqual(['Sport', 'Kinderinsel']); // released groups only
  });
});

describe('fix round 1', () => {
  const audits = async (action: string) => (await env.pool.query<{ target: string | null; meta: Record<string, unknown> }>(
    'select target, meta from audit_log where action = $1 order by id', [action])).rows;

  it('a per-user allow does not open a group that is not kid-friendly to a kids profile', async () => {
    const sport = await group('Sport');
    await channel('Bergblick Sport', { override: sport });
    await call('PUT', `/api/admin/users/${ANNA}/livetv-groups`, { allow: [sport], deny: [] });
    expect(await sees(who.anna())).toEqual(['Bergblick Sport']);
    expect(await sees(who.annaKids())).toEqual([]);
    expect(await livetvFeature(env.ctx, who.annaKids().user, who.annaKids().profile)).toBe(false);
    const chk = (await call('GET', `/api/admin/users/${ANNA}/check?profile=${ANNA_KIDS}`)).json();
    expect(chk.livetv.groups).toEqual([{ id: sport, name: 'Sport', visible: false, reason: 'notKidFriendly' }]);
  });

  it('caps id lists at 500 and refuses a blank name', async () => {
    const g = await group('Sport');
    const many = Array.from({ length: 501 }, (_, i) => `0d000000-0000-4000-a000-${String(i).padStart(12, '0')}`);
    expect((await call('POST', '/api/admin/livetv/groups/release', { ids: many, roles: [], kidFriendly: false })).json()).toEqual({ error: 'invalid', field: 'ids' });
    expect((await call('POST', '/api/admin/livetv/groups/merge', { ids: many, into: g })).json()).toEqual({ error: 'invalid', field: 'ids' });
    expect((await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: many, deny: [] })).json()).toEqual({ error: 'invalid', field: 'allow' });
    expect((await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [], deny: many })).json()).toEqual({ error: 'invalid', field: 'deny' });
    const blank = await call('POST', '/api/admin/livetv/groups', { name: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toEqual({ error: 'invalid', field: 'name' });
    expect((await call('PATCH', `/api/admin/livetv/groups/${g}`, { name: ' ' })).json()).toEqual({ error: 'invalid', field: 'name' });
    expect((await env.pool.query('select name from livetv_groups')).rows).toEqual([{ name: 'Sport' }]);
  });

  it('PATCH released: true is a release, audited like the release route', async () => {
    const g = await group('DE | Doku', { released: false, roles: ['family'] });
    await channel('Sternwarte 24', { override: g });
    const r = await call('PATCH', `/api/admin/livetv/groups/${g}`, { released: true, name: 'Doku' });
    expect(r.json()).toMatchObject({ released: true, roles: ['family'], kidFriendly: false, name: 'Doku' });
    expect(await sees(who.anna())).toEqual(['Sternwarte 24']);
    expect(await audits('livetv.group.release')).toEqual([{ target: null, meta: { ids: [g], roles: ['family'], kidFriendly: false } }]);
    expect(await audits('livetv.group.update')).toEqual([{ target: g, meta: { fields: ['name'] } }]);
    // with roles and the flag in the same patch: those are the release's
    const h = await group('DE | Kinder', { released: false });
    await call('PATCH', `/api/admin/livetv/groups/${h}`, { released: true, roles: ['friend', 'guest'], kidFriendly: true });
    expect((await audits('livetv.group.release'))[1]).toEqual({ target: null, meta: { ids: [h], roles: ['friend', 'guest'], kidFriendly: true } });
    expect(await audits('livetv.group.update')).toHaveLength(1);
  });

  it('writes that change nothing are not audited', async () => {
    const g = await group('Sport', { roles: ['family'] });
    const h = await group('Nachrichten');
    // an empty patch, the same values again, an already released group released again as it is, an unknown id
    expect((await call('PATCH', `/api/admin/livetv/groups/${g}`, {})).statusCode).toBe(200);
    expect((await call('PATCH', `/api/admin/livetv/groups/${g}`, { name: 'Sport', kidFriendly: false, roles: ['family'], released: true })).statusCode).toBe(200);
    expect((await call('POST', '/api/admin/livetv/groups/release', { ids: [g], roles: ['family'], kidFriendly: false })).json()).toEqual({ released: 1 });
    expect((await call('POST', '/api/admin/livetv/groups/release', { ids: ['0d000000-0000-4000-a000-0000000000aa'], roles: [], kidFriendly: false })).json()).toEqual({ released: 0 });
    expect((await call('PUT', '/api/admin/livetv/groups/order', { ids: [g, h] })).json()).toEqual({ ok: true });
    await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [h], deny: [g] });
    await call('PUT', `/api/admin/users/${BEN}/livetv-groups`, { allow: [h], deny: [g] });
    const rows = (await env.pool.query<{ action: string }>('select action from audit_log order by id')).rows.map((r) => r.action);
    expect(rows).toEqual(['user.livetv_groups']);
    expect(await audits('user.livetv_groups')).toEqual([{ target: BEN, meta: { allow: [h], deny: [g] } }]);
    // a real change is audited with what changed
    await call('PATCH', `/api/admin/livetv/groups/${g}`, { kidFriendly: true, roles: ['family'] });
    expect(await audits('livetv.group.update')).toEqual([{ target: g, meta: { fields: ['kidFriendly'] } }]);
    await call('PUT', '/api/admin/livetv/groups/order', { ids: [h, g] });
    expect(await audits('livetv.group.order')).toEqual([{ target: null, meta: { count: 2 } }]);
  });

  it('channelSet hands out a copy', async () => {
    const g = await group('Nachrichten', { roles: ['family'] });
    const ch = await channel('Nordlicht TV', { override: g });
    const first = await channelSet(env.ctx, who.anna().user, who.anna().profile);
    (first as Set<string>).delete(ch);
    expect(await channelAllowed(env.ctx, who.anna().user, who.anna().profile, ch)).toBe(true);
  });

  it('features.livetv for a person who is not an admin', async () => {
    const ben = await env.login({ sub: 'ben-sub', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] });
    const me = async () => (await env.app.inject({ url: '/api/me', cookies: ben.cookies })).json();
    const role = (await env.pool.query<{ role: string }>("select role from users where authentik_sub = 'ben-sub'")).rows[0]!.role;
    expect(role).not.toBe('admin');
    const g = (await call('POST', '/api/admin/livetv/groups', { name: 'Nachrichten', roles: [role] })).json().id as string;
    await channel('Nordlicht TV', { override: g });
    expect((await me()).features.livetv).toBe(true);
    expect((await call('PUT', `/api/admin/users/${BEN}/rights`, { overrides: { liveTv: false } })).statusCode).toBe(200);
    expect((await me()).features.livetv).toBe(false);
  });
});

// Roles redesign Task 3: a role's released channel groups are written with the role (PUT /api/admin/roles/:role { livetvGroups }) and
// read back from GET /api/admin/roles (livetvGroupIds, matrix.livetv)
describe('role write: livetvGroups', () => {
  const putRole = (role: string, body: object) => call('PUT', `/api/admin/roles/${role}`, body);
  const matrix = async () => (await call('GET', '/api/admin/roles')).json().matrix;
  const roleOf = async (k: string) => (await matrix()).roles.find((r: { key: string }) => r.key === k);
  const grants = async (role: string) => (await env.pool.query<{ group_id: string }>('select group_id from livetv_group_roles where role = $1 order by group_id', [role])).rows.map((r) => r.group_id);
  const roleAudits = async (role: string) => (await env.pool.query<{ meta: Record<string, unknown> }>("select meta from audit_log where action = 'role.update' and target = $1 order by id", [role])).rows.map((r) => r.meta);

  it('PUT livetvGroups sets the released groups of the role; GET shows livetvGroupIds in group order', async () => {
    const nord = await group('Nordlicht TV', { roles: ['friend'] });
    const hafen = await group('Hafenkanal');
    const sport = await group('Sport', { roles: ['family'] });
    const r = await putRole('friend', { livetvGroups: [hafen, nord] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect((await grants('friend')).sort()).toEqual([nord, hafen].sort());
    const friend = await roleOf('friend');
    expect(friend.livetvGroupIds).toEqual([nord, hafen]);
    expect(friend.livetvGroups).toEqual(['Nordlicht TV', 'Hafenkanal']);
    expect((await roleOf('family')).livetvGroupIds).toEqual([sport]);
    expect((await roleOf('admin')).livetvGroupIds).toEqual([nord, hafen, sport]);
    // a groups-only write stores no role settings
    expect((await env.pool.query("select 1 from role_settings where role = 'friend'")).rowCount).toBe(0);
    // the empty set removes every released grant
    expect((await putRole('friend', { livetvGroups: [] })).statusCode).toBe(200);
    expect(await grants('friend')).toEqual([]);
  });

  it("PUT livetvGroups keeps the role's grant on an unreleased group", async () => {
    const nord = await group('Nordlicht TV');
    const neu = await group('DE | Neu', { released: false, roles: ['friend'] });
    await channel('Hafenkanal Eins', { override: neu });
    expect((await putRole('friend', { livetvGroups: [nord] })).statusCode).toBe(200);
    expect((await grants('friend')).sort()).toEqual([nord, neu].sort());
    expect((await roleOf('friend')).livetvGroupIds).toEqual([nord]);
    // released later (keeping its roles): the role sees it
    expect((await call('PATCH', `/api/admin/livetv/groups/${neu}`, { released: true })).statusCode).toBe(200);
    expect(await sees(who.ben())).toEqual(['Hafenkanal Eins']);
  });

  it('PUT livetvGroups with an unreleased or unknown id → 400 invalid livetvGroups, nothing stored', async () => {
    const nord = await group('Nordlicht TV', { roles: ['friend'] });
    const neu = await group('DE | Neu', { released: false });
    for (const ids of [[neu], [nord, '0d000000-0000-4000-a000-0000000000aa']]) {
      const r = await putRole('friend', { livetvGroups: ids, maxStreams: 3 });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid', field: 'livetvGroups' });
    }
    expect((await putRole('friend', { livetvGroups: ['nope'] })).statusCode).toBe(400);
    expect(await grants('friend')).toEqual([nord]);
    expect((await env.pool.query("select 1 from role_settings where role = 'friend'")).rowCount).toBe(0);
    expect(await roleAudits('friend')).toEqual([]);
  });

  it('PUT livetvGroups on admin → 400 admin_groups_locked; on an env-only role → 400 not_in_catalogue', async () => {
    const nord = await group('Nordlicht TV');
    const r = await putRole('admin', { livetvGroups: [nord] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'admin_groups_locked' });
    const saved = env.ctx.roles;
    env.ctx.roles = { ...saved, 'Crew.X': { ...saved.friend!, label: 'Crew' } }; // not a valid key: it cannot be stored
    invalidateRoles(env.ctx);
    try {
      const e = await putRole('Crew.X', { livetvGroups: [nord] });
      expect(e.statusCode).toBe(400);
      expect(e.json()).toEqual({ error: 'not_in_catalogue' });
    } finally {
      env.ctx.roles = saved;
      invalidateRoles(env.ctx);
    }
    expect((await env.pool.query('select 1 from livetv_group_roles')).rowCount).toBe(0);
  });

  it('the role.update audit carries livetvGroups as names (Nordlicht TV → Nordlicht TV, Hafenkanal); an unchanged set writes no entry', async () => {
    const nord = await group('Nordlicht TV', { roles: ['friend'] });
    const hafen = await group('Hafenkanal');
    expect((await putRole('friend', { livetvGroups: [hafen, nord] })).statusCode).toBe(200);
    expect(await roleAudits('friend')).toEqual([{ from: { livetvGroups: ['Nordlicht TV'] }, to: { livetvGroups: ['Nordlicht TV', 'Hafenkanal'] } }]);
    expect((await putRole('friend', { livetvGroups: [nord, hafen] })).statusCode).toBe(200);
    expect(await roleAudits('friend')).toHaveLength(1);
    // with a field in the same write: one entry with both
    expect((await putRole('friend', { livetvGroups: [hafen], maxDownloads: 3 })).statusCode).toBe(200);
    expect((await roleAudits('friend'))[1]).toEqual({ from: { maxDownloads: 15, livetvGroups: ['Nordlicht TV', 'Hafenkanal'] }, to: { maxDownloads: 3, livetvGroups: ['Hafenkanal'] } });
    await env.pool.query("delete from role_settings where role = 'friend'");
  });

  it('a person of the role sees the new group\'s channels at once', async () => {
    const nord = await group('Nordlicht TV');
    await channel('Nordlicht Eins', { override: nord });
    expect(await sees(who.ben())).toEqual([]); // primed (cached 60 s)
    expect((await putRole('friend', { livetvGroups: [nord] })).statusCode).toBe(200);
    expect(await sees(who.ben())).toEqual(['Nordlicht Eins']);
  });

  it('GET matrix.livetv is null without Live TV; with it lists released groups with channel counts and pending', async () => {
    const nord = await group('Nordlicht TV', { kid: true });
    const hafen = await group('Hafenkanal');
    await group('DE | Neu', { released: false });
    await channel('Nordlicht Eins', { override: nord });
    await channel('Nordlicht Zwei', { override: nord });
    await channel('Nordlicht Alt', { override: nord, missing: true });
    expect((await matrix()).livetv).toEqual({
      groups: [{ id: nord, name: 'Nordlicht TV', kidFriendly: true, channels: 2 }, { id: hafen, name: 'Hafenkanal', kidFriendly: false, channels: 0 }],
      pending: 1,
    });
    installed.v = false;
    expect((await matrix()).livetv).toBeNull();
    // the field is still accepted without Live TV (groups may exist from an earlier install)
    expect((await putRole('friend', { livetvGroups: [hafen] })).statusCode).toBe(200);
    expect(await grants('friend')).toEqual([hafen]);
  });
});

// Fix round 1 (review I1): a role write with livetvGroups and a group write granting that role must not deadlock. The group write locks
// its group row, then its grant insert takes FOR KEY SHARE on the role's catalogue row (FK livetv_group_roles.role); the role write
// locks that row (FOR NO KEY UPDATE, which KEY SHARE does not wait for), then the released group rows. The interleaving is forced: a
// held role_settings row stops the role write after it took the catalogue row and before it locks the groups.
describe('role write vs group write', () => {
  it('writeRole({ livetvGroups }) and updateGroup({ roles }) at the same time both complete', async () => {
    const nord = await group('Nordlicht TV');
    await env.pool.query("insert into role_settings(role, template) values ('friend', '{}') on conflict (role) do nothing");
    const blocker = await env.pool.connect();
    const waiting = async (needle: string) => Number((await env.pool.query<{ n: string }>(
      "select count(*) n from pg_stat_activity where wait_event_type = 'Lock' and query like $1", [`%${needle}%`])).rows[0]!.n);
    const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    try {
      await blocker.query('begin');
      await blocker.query("select 1 from role_settings where role = 'friend' for update");
      // the role write takes its role lock and catalogue row, then waits on the held role_settings row
      const role = settle(writeRole(env.ctx, null, 'friend', { maxStreams: 3, livetvGroups: [nord] }));
      await vi.waitFor(async () => expect(await waiting('insert into role_settings')).toBe(1), { timeout: 5000, interval: 20 });
      // the group write locks the group row and grants the role: its FK check must not wait for the role write
      let groupDone = false;
      const grp = settle(updateGroup(env.ctx, adminId, nord, { roles: ['friend'] })).finally(() => { groupDone = true; });
      await vi.waitFor(async () => expect(groupDone || (await waiting('livetv_group_roles')) > 0).toBe(true), { timeout: 5000, interval: 20 });
      await blocker.query('commit');
      const [r, g] = await Promise.all([role, grp]);
      expect(g.ok ? 'ok' : String((g as { e: unknown }).e)).toBe('ok');
      expect(r.ok ? 'ok' : String((r as { e: unknown }).e)).toBe('ok');
      expect((await env.pool.query("select 1 from livetv_group_roles where role = 'friend' and group_id = $1", [nord])).rowCount).toBe(1);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await env.pool.query("delete from role_settings where role = 'friend'");
      invalidateRoles(env.ctx);
    }
  });
});
