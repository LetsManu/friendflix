// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 33: the channel list (spec §10: groups, now / next, running + preview, receiving, EPG state, favourites, recent,
 * last), ordered favourites, *Zuletzt gesehen*, the preview image, the TV start (`/api/me.startLive`, rulings 14, 45, 58) and the admin
 * switch for it. livetv is a fake (`ctx.fetchImpl`): it lists what it runs, what it receives and serves a preview image.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import { invalidateLiveConversions } from '../src/livetv/streams.js';
import type { IngestState, StreamView } from '../src/livetv/wire.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const key = keyFromBase64(ENC_KEY);
const LOGO = 'c'.repeat(64);
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const hex = (c: string) => c.repeat(32);

let env: TestEnv;
let admin: Sess;
let anna: Sess;
let ben: Sess;
let carla: Sess;
const annaId = '0e000000-0000-4000-a000-0000000000a1';
const benId = '0e000000-0000-4000-a000-0000000000b1';
const carlaId = '0e000000-0000-4000-a000-0000000000c1';
const annaKidsId = '0e000000-0000-4000-a000-0000000000a2';

// ---- the fake livetv ----
const calls: Call[] = [];
const streams = new Map<string, StreamView>();
let ingest: IngestState[] = [];
let keyN = 0;
const view = (channelId: string): StreamView => ({
  channelId, streamKey: (++keyN).toString(16).padStart(32, '0'), mode: 'remux', since: Date.now(), state: 'running', bitrate: 4_000_000, errors: [], lastSegmentAt: Date.now(),
});
function fakeLivetv() {
  env.ctx.fetchImpl = fakeHttp({
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '3.3.0', bootId: '0123456789abcdef' } }),
    'GET /v1/streams': () => ({ json: [...streams.values()] }),
    'GET /v1/ingest': () => ({ json: ingest }),
    'GET /v1/streams/[\\w-]+/preview.jpg': (u) => (streams.has(u.pathname.split('/')[3]!) ? { raw: JPEG, type: 'image/jpeg' } : { status: 404, json: { error: 'not_found' } }),
  }, calls);
}

// ---- data ----
let src = '';
let news = '';
let kids = '';
let admins = '';
let n = 0;

async function addChannel(name: string, o: { group?: string | null; number?: number; logo?: string; push?: number; epg?: string; hidden?: boolean } = {}): Promise<string> {
  const push = o.push !== undefined;
  const id = (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, import_number, group_override, ingest, push_port,
       push_stream_id_enc, push_passphrase_enc, logo_override_hash, epg_source_id, epg_channel_id, hidden)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
    [src, `k${++n}`, push ? null : encrypt(key, `https://iptv.example.com/live/anna/geheim/${n}.m3u8`), push ? 'srt' : 'hls', name, o.number ?? null,
      o.group === undefined ? news : o.group, push ? 'push' : 'pull', o.push ?? null,
      push ? encrypt(key, 'ff-ABCDEFGHIJKLMNOP') : null, push ? encrypt(key, 'passphrase-geheim-1234567890abcd') : null, o.logo ?? null,
      o.epg ? src : null, o.epg ?? null, o.hidden ?? false])).rows[0]!.id;
  invalidateLivetvRights();
  return id;
}
/** a programme from `from` to `to` minutes around now (whole seconds, so the ISO strings compare) */
const T0 = Math.floor(Date.now() / 1000) * 1000;
const at = (min: number) => new Date(T0 + min * 60_000);
const prog = (xml: string, from: number, to: number, title: string, subtitle: string | null = null) =>
  env.pool.query('insert into livetv_programmes(source_id, xml_channel, start_at, end_at, title, subtitle) values ($1, $2, $3, $4, $5, $6)', [src, xml, at(from), at(to), title, subtitle]);

let addr = 0;
const call = (s: Sess, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, ...headers }, remoteAddress: `192.0.2.${(++addr % 200) + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });
const list = async (s: Sess) => {
  const r = await call(s, 'GET', '/api/livetv/channels');
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const ids = (l: { channels: Array<{ id: string }> }) => l.channels.map((c) => c.id);
const setLast = (s: Sess, id: string) => call(s, 'PUT', '/api/livetv/last', { id });
const star = (s: Sess, id: string) => call(s, 'POST', `/api/livetv/favourites/${id}`);

async function person(id: string, sub: string, name: string, role: string): Promise<Sess> {
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, sub, `${sub}@friend.example.com`, name, role, id.replace(/-/g, '').slice(0, 32), encrypt(key, 'pw')]);
  const s = await env.login({ sub, email: `${sub}@friend.example.com`, name, groups: [] });
  await env.pool.query('update devices set approved = true where user_id = $1', [id]);
  return s;
}

/** Anna on her kids profile (a session of its own: a profile switch ends the session it was made from after a short grace) */
async function annaKids(): Promise<Sess> {
  const s = await env.login({ sub: 'anna', email: 'anna@friend.example.com', name: 'Anna Beispiel', groups: [] });
  const sel = await call(s, 'POST', `/api/profiles/${annaKidsId}/select`, {});
  expect(sel.statusCode, sel.body).toBe(200);
  return { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: s.csrf };
}

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  anna = await person(annaId, 'anna', 'Anna Beispiel', 'family');
  ben = await person(benId, 'ben', 'Ben Muster', 'friend');
  carla = await person(carlaId, 'carla', 'Carla Probe', 'family');
  await env.pool.query(
    `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
     values ($1, $2, 'Kiddo', $3, 'anna-kiddo', $4, true, 6)`,
    [annaKidsId, annaId, hex('4'), encrypt(key, 'kpw')]);
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  await env.pool.query('delete from livetv_channels; delete from livetv_group_roles; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from livetv_logos; delete from livetv_programmes; delete from audit_log');
  streams.clear();
  ingest = [];
  calls.length = 0;
  fakeLivetv();
  await detectLivetv(env.ctx, 0);
  invalidateLiveConversions();
  src = (await env.pool.query<{ id: string }>("insert into livetv_sources(id, kind, name) values (gen_random_uuid(), 'manual', 'Anbieter A') returning id")).rows[0]!.id;
  news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), 'Nachrichten', true, 1) returning id")).rows[0]!.id;
  kids = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, kid_friendly, position) values (gen_random_uuid(), 'Kinder', true, true, 0) returning id")).rows[0]!.id;
  admins = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), 'Nur Admins', true, 2) returning id")).rows[0]!.id;
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family'), ($1, 'friend'), ($2, 'family'), ($2, 'friend')", [news, kids]);
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
});

// a device that picked a kids profile stays on it (a lock on the device row): lift it so Anna's grown-up session is hers again
afterEach(async () => { await env.pool.query('update devices set kids_profile_id = null where user_id = $1', [annaId]); });

describe('channel list', () => {
  it('the list shape', async () => {
    const nord = await addChannel('Nordlicht TV', { number: 1, logo: LOGO, epg: 'nordlicht' });
    const hafen = await addChannel('Hafenkanal', { number: 2, push: 9000 });
    const sternwarte = await addChannel('Sternwarte 24', { number: 3, group: admins }); // not for Anna
    await prog('nordlicht', -30, 30, 'Nachrichten am Abend', 'Mit Ben Muster');
    await prog('nordlicht', 30, 60, 'Wetter');
    streams.set(nord, view(nord));
    ingest = [{ channelId: hafen, port: 9000, state: 'receiving', since: Date.now(), bitrate: 3_000_000, rejected1h: 0 }];
    await star(anna, hafen);

    const l = await list(anna);
    expect(l.groups).toEqual([{ id: news, name: 'Nachrichten' }]); // only groups with channels this profile sees
    expect(ids(l)).toEqual([nord, hafen]);
    expect(l.channels).toEqual([
      {
        id: nord, number: 1, name: 'Nordlicht TV', logo: `/api/livetv/logos/${LOGO}`, groupId: news, groupPos: 1, running: true, epg: 'ok',
        preview: `/api/livetv/channels/${nord}/preview.jpg`,
        now: { title: 'Nachrichten am Abend', start: at(-30).toISOString(), end: at(30).toISOString(), subtitle: 'Mit Ben Muster' },
        next: { title: 'Wetter', start: at(30).toISOString(), end: at(60).toISOString() },
        favourite: false,
      },
      { id: hafen, number: 2, name: 'Hafenkanal', logo: null, groupId: news, groupPos: 1, running: false, receiving: true, epg: 'none', favourite: true },
    ]);
    expect(l.favourites).toEqual([hafen]);
    expect(l.recent).toEqual([]);
    expect(l.last).toBeNull();
    expect(l.dvrSeconds).toBe(1800);
    expect(JSON.stringify(l)).not.toContain(sternwarte);
    // a push feed that sends nothing: receiving false; the admin's own profile sees the third channel
    ingest = [{ channelId: hafen, port: 9000, state: 'idle', since: null, bitrate: null, rejected1h: 0 }];
    invalidateLiveConversions();
    expect((await list(anna)).channels.find((c: { id: string }) => c.id === hafen).receiving).toBe(false);
    expect(ids(await list(admin))).toEqual([nord, hafen, sternwarte]);
    // never a URL, a stream id or a passphrase
    expect(JSON.stringify(l)).not.toMatch(/geheim|iptv\.example|srt:|passphrase/i);
  });

  it('epg states: ok, gap, none', async () => {
    const ok = await addChannel('Nordlicht TV', { number: 1, epg: 'a' });
    const gap = await addChannel('Hafenkanal', { number: 2, epg: 'b' });
    const none = await addChannel('Leuchtfeuer', { number: 3 });
    await prog('a', -10, 20, 'Jetzt');
    await prog('b', -180, -90, 'Zu Ende'); // the last programme ended 90 minutes ago
    const l = await list(anna);
    const by = (id: string) => l.channels.find((c: { id: string }) => c.id === id);
    expect(by(ok)).toMatchObject({ epg: 'ok', now: { title: 'Jetzt' } });
    expect(by(gap).epg).toBe('gap');
    expect(by(gap)).not.toHaveProperty('now');
    expect(by(gap)).not.toHaveProperty('next');
    expect(by(none).epg).toBe('none');
  });

  it('ETag 304', async () => {
    await addChannel('Nordlicht TV', { number: 1 });
    const a = await call(anna, 'GET', '/api/livetv/channels');
    const tag = String(a.headers.etag);
    expect(tag).toMatch(/^"[0-9a-f]{40}"$/);
    const again = await call(anna, 'GET', '/api/livetv/channels', undefined, { 'if-none-match': tag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(tag);
    // a change of the list changes the tag
    await addChannel('Hafenkanal', { number: 2 });
    const changed = await call(anna, 'GET', '/api/livetv/channels', undefined, { 'if-none-match': tag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
  });

  it('a kids profile lists kid-friendly channels only', async () => {
    const nord = await addChannel('Nordlicht TV', { number: 1 });
    const maus = await addChannel('Kinderkanal', { number: 2, group: kids });
    expect(ids(await list(anna))).toEqual([nord, maus]);
    const kid = await annaKids();
    const l = await list(kid);
    expect(ids(l)).toEqual([maus]);
    expect(l.groups).toEqual([{ id: kids, name: 'Kinder' }]);
    // a favourite or a watch of a channel the kids profile cannot see is refused
    expect((await star(kid, nord)).statusCode).toBe(403);
    expect((await setLast(kid, nord)).statusCode).toBe(403);
    expect((await call(kid, 'GET', `/api/livetv/channels/${nord}/preview.jpg`)).statusCode).toBe(404);
  });
});

describe('favourites', () => {
  it('favourites per profile; hidden ones come back with the right', async () => {
    const a = await addChannel('Nordlicht TV', { number: 1 });
    const b = await addChannel('Hafenkanal', { number: 2 });
    expect((await star(anna, a)).json()).toEqual({ ok: true });
    await star(anna, b);
    await star(ben, b);
    expect((await list(anna)).favourites).toEqual([a, b]);
    expect((await list(ben)).favourites).toEqual([b]);
    expect((await list(ben)).channels.find((c: { id: string }) => c.id === a).favourite).toBe(false);

    // Anna loses the group: the favourites are hidden, not deleted
    await env.pool.query("delete from livetv_group_roles where group_id = $1 and role = 'family'", [news]);
    invalidateLivetvRights();
    const hidden = await list(anna);
    expect(hidden.channels).toEqual([]);
    expect(hidden.favourites).toEqual([]);
    expect((await env.pool.query('select 1 from livetv_favourites where profile_id = $1', [annaId])).rowCount).toBe(2);
    await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [news]);
    invalidateLivetvRights();
    expect((await list(anna)).favourites).toEqual([a, b]);
    // another profile of the same account has its own favourites (last: picking a kids profile locks the device to it)
    expect((await list(await annaKids())).favourites).toEqual([]);
  });

  it('favourites order round-trip', async () => {
    const a = await addChannel('Nordlicht TV', { number: 1 });
    const b = await addChannel('Hafenkanal', { number: 2 });
    const c = await addChannel('Leuchtfeuer', { number: 3 });
    const d = await addChannel('Sternenhimmel', { number: 4 });
    for (const x of [a, b, c]) expect((await star(anna, x)).statusCode).toBe(200);
    expect((await star(anna, a)).statusCode).toBe(200); // again: stays where it is
    expect((await list(anna)).favourites).toEqual([a, b, c]);
    const put = await call(anna, 'PUT', '/api/livetv/favourites', { ids: [c, a, b] });
    expect(put.json()).toEqual({ ok: true });
    expect((await list(anna)).favourites).toEqual([c, a, b]);
    // a new favourite goes last
    await star(anna, d);
    expect((await list(anna)).favourites).toEqual([c, a, b, d]);
    // a partial order: the ones left out keep their relative order after the given ones
    expect((await call(anna, 'PUT', '/api/livetv/favourites', { ids: [d, b] })).statusCode).toBe(200);
    expect((await list(anna)).favourites).toEqual([d, b, c, a]);
    // not a favourite (a channel without a star, an unknown id, a repeated id, a malformed body): 400, nothing changes
    const e = await addChannel('Abendrot', { number: 5 });
    for (const bad of [[e], ['0e000000-0000-4000-a000-00000000ffff'], [d, d], ['nope']]) {
      const r = await call(anna, 'PUT', '/api/livetv/favourites', { ids: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error).toBe('invalid');
    }
    expect((await call(anna, 'PUT', '/api/livetv/favourites', { ids: 'x' })).statusCode).toBe(400);
    expect((await list(anna)).favourites).toEqual([d, b, c, a]);
    // delete: the row goes; the order of the rest holds
    expect((await call(anna, 'DELETE', `/api/livetv/favourites/${b}`)).json()).toEqual({ ok: true });
    expect((await list(anna)).favourites).toEqual([d, c, a]);
  });

  it('a favourite hidden by a lost right keeps its place when the order is saved', async () => {
    const a = await addChannel('Nordlicht TV', { number: 1 });
    const b = await addChannel('Hafenkanal', { number: 2 });
    const h = await addChannel('Sternwarte 24', { number: 3, group: admins });
    await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [admins]);
    invalidateLivetvRights();
    for (const x of [a, h, b]) await star(anna, x);
    expect((await list(anna)).favourites).toEqual([a, h, b]);
    await env.pool.query("delete from livetv_group_roles where group_id = $1", [admins]);
    invalidateLivetvRights();
    expect((await list(anna)).favourites).toEqual([a, b]);
    // the hidden one is not named by the answer to a PUT either (400 like any other id that is not a favourite)
    expect((await call(anna, 'PUT', '/api/livetv/favourites', { ids: [h, b, a] })).statusCode).toBe(400);
    expect((await call(anna, 'PUT', '/api/livetv/favourites', { ids: [b, a] })).statusCode).toBe(200);
    await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [admins]);
    invalidateLivetvRights();
    expect((await list(anna)).favourites).toEqual([b, a, h]);
  });

  it('a favourite of a channel the profile cannot see is refused (403) and a delete of a stranger is harmless', async () => {
    const h = await addChannel('Sternwarte 24', { number: 3, group: admins });
    expect((await star(anna, h)).statusCode).toBe(403);
    expect((await call(anna, 'POST', '/api/livetv/favourites/not-an-id')).statusCode).toBe(404);
    expect((await call(anna, 'DELETE', `/api/livetv/favourites/${h}`)).statusCode).toBe(200);
    expect((await env.pool.query('select 1 from livetv_favourites')).rowCount).toBe(0);
  });
});

describe('recently watched and the last channel', () => {
  it('recent keeps the 10 newest', async () => {
    const chans: string[] = [];
    for (let i = 1; i <= 12; i++) chans.push(await addChannel(`Sender ${i}`, { number: i }));
    for (const c of chans) expect((await setLast(anna, c)).json()).toEqual({ ok: true });
    expect((await env.pool.query('select 1 from livetv_recent where profile_id = $1', [annaId])).rowCount).toBe(10);
    const newest = [...chans].reverse().slice(0, 10);
    expect((await list(anna)).recent).toEqual(newest);
    // re-watching the 5th moves it to the front, no duplicate, still 10
    const fifth = newest[4]!;
    await setLast(anna, fifth);
    expect((await list(anna)).recent).toEqual([fifth, ...newest.filter((x) => x !== fifth)]);
    expect((await env.pool.query('select 1 from livetv_recent where profile_id = $1', [annaId])).rowCount).toBe(10);
    // another profile has its own
    expect((await list(ben)).recent).toEqual([]);
  });

  it('last and previous', async () => {
    const a = await addChannel('Nordlicht TV', { number: 1 });
    const b = await addChannel('Hafenkanal', { number: 2 });
    expect((await list(anna)).last).toBeNull();
    await setLast(anna, a);
    expect((await list(anna)).last).toEqual({ id: a, previous: null });
    await setLast(anna, b);
    await setLast(anna, a);
    const l = await list(anna);
    expect(l.recent).toEqual([a, b]);
    expect(l.last).toEqual({ id: a, previous: b });
  });

  it('recent hides channels the profile cannot see (and shows them again with the right)', async () => {
    const a = await addChannel('Nordlicht TV', { number: 1 });
    const h = await addChannel('Sternwarte 24', { number: 3, group: admins });
    const b = await addChannel('Hafenkanal', { number: 2 });
    await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [admins]);
    invalidateLivetvRights();
    for (const x of [a, h, b]) await setLast(anna, x);
    expect((await list(anna)).recent).toEqual([b, h, a]);
    await env.pool.query('delete from livetv_group_roles where group_id = $1', [admins]);
    invalidateLivetvRights();
    const l = await list(anna);
    expect(l.recent).toEqual([b, a]);
    expect(l.last).toEqual({ id: b, previous: a }); // last and previous are of what she sees
    expect(JSON.stringify(l)).not.toContain(h);
    await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [admins]);
    invalidateLivetvRights();
    expect((await list(anna)).recent).toEqual([b, h, a]);
  });

  it('a watch of a channel outside the set is refused (403) and recorded nowhere', async () => {
    const h = await addChannel('Sternwarte 24', { number: 3, group: admins });
    const hiddenOne = await addChannel('Versteckt', { number: 4, hidden: true });
    expect((await setLast(anna, h)).statusCode).toBe(403);
    expect((await setLast(anna, hiddenOne)).statusCode).toBe(403);
    expect((await setLast(anna, '0e000000-0000-4000-a000-00000000ffff')).statusCode).toBe(403);
    expect((await call(anna, 'PUT', '/api/livetv/last', { id: 'nope' })).statusCode).toBe(400);
    expect((await call(anna, 'PUT', '/api/livetv/last', {})).statusCode).toBe(400);
    expect((await env.pool.query('select 1 from livetv_recent')).rowCount).toBe(0);
  });
});

describe('preview image', () => {
  it('preview 404 when not running', async () => {
    const a = await addChannel('Nordlicht TV', { number: 1 });
    const off = await call(anna, 'GET', `/api/livetv/channels/${a}/preview.jpg`);
    expect(off.statusCode).toBe(404);
    expect(calls.some((c) => c.path.endsWith('/preview.jpg'))).toBe(false);
    streams.set(a, view(a));
    invalidateLiveConversions();
    const on = await call(anna, 'GET', `/api/livetv/channels/${a}/preview.jpg`);
    expect(on.statusCode).toBe(200);
    expect(on.headers['content-type']).toBe('image/jpeg');
    expect(on.headers['cache-control']).toBe('private, max-age=60');
    expect(Buffer.from(on.rawPayload).equals(JPEG)).toBe(true);
    // running, but not for this profile: 404, and livetv is not asked
    const h = await addChannel('Sternwarte 24', { number: 3, group: admins });
    streams.set(h, view(h));
    invalidateLiveConversions();
    calls.length = 0;
    expect((await call(anna, 'GET', `/api/livetv/channels/${h}/preview.jpg`)).statusCode).toBe(404);
    expect(calls.some((c) => c.path.endsWith('/preview.jpg'))).toBe(false);
    expect((await call(admin, 'GET', `/api/livetv/channels/${h}/preview.jpg`)).statusCode).toBe(200);
    expect((await call(anna, 'GET', '/api/livetv/channels/not-an-id/preview.jpg')).statusCode).toBe(404);
  });
});

describe('TV start', () => {
  const deviceOf = async (userId: string) => (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id = $1', [userId])).rows[0]!.device_id;
  const me = async (s: Sess) => (await call(s, 'GET', '/api/me')).json();

  it('startLive only for TVs', async () => {
    const a = await addChannel('Nordlicht TV', { number: 1 });
    // a phone / browser device: refused
    const phone = await deviceOf(annaId);
    expect(phone.startsWith('tv-')).toBe(false);
    const no = await call(admin, 'PATCH', `/api/admin/devices/${annaId}/${phone}`, { startLive: true });
    expect(no.statusCode).toBe(400);
    expect(no.json().error).toBe('not_tv');
    expect((await me(anna)).startLive).toBe(false);

    // Carla's device becomes a paired TV (device ids of TVs start with tv-)
    const tv = 'tv-nordlicht-wohnzimmer';
    const old = await deviceOf(carlaId);
    const sid = carla.cookies.ff_sid!;
    await env.pool.query('update devices set device_id = $3 where user_id = $1 and device_id = $2', [carlaId, old, tv]);
    await env.kv.replace(`sess:${sid}`, JSON.stringify({ ...JSON.parse((await env.kv.get(`sess:${sid}`))!), deviceId: tv }), 3600);
    expect((await me(carla))).toMatchObject({ tv: true, startLive: false, features: { livetv: true } });

    // only an admin may set it; the answer and the audit carry no device id
    expect((await call(anna, 'PATCH', `/api/admin/devices/${carlaId}/${tv}`, { startLive: true })).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', `/api/admin/devices/${carlaId}/${tv}`, { startLive: 'yes' })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', `/api/admin/devices/${carlaId}/${tv}`, { startLive: true, name: 'x' })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', `/api/admin/devices/${carlaId}/tv-unbekannt`, { startLive: true })).statusCode).toBe(404);
    const ok = await call(admin, 'PATCH', `/api/admin/devices/${carlaId}/${tv}`, { startLive: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await me(carla)).startLive).toBe(true);
    const row = (await env.pool.query<{ target: string; meta: unknown }>("select target, meta from audit_log where action = 'device.start_live'")).rows;
    expect(row).toHaveLength(1);
    expect(row[0]!.target).toBe(carlaId);
    expect(JSON.stringify(row[0]!.meta)).not.toContain(tv);
    // the admin's device list says so
    const devs = (await call(admin, 'GET', '/api/admin/devices')).json().devices as Array<{ device_id: string; startLive: boolean }>;
    expect(devs.find((d) => d.device_id === tv)!.startLive).toBe(true);
    expect(devs.find((d) => d.device_id === phone)!.startLive).toBe(false);

    // ... and only while the profile sees a channel
    await env.pool.query('delete from livetv_channels where id = $1', [a]);
    invalidateLivetvRights();
    expect(await me(carla)).toMatchObject({ startLive: false, features: { livetv: false } });
    await addChannel('Hafenkanal', { number: 2 });
    expect((await me(carla)).startLive).toBe(true);
    // off again
    expect((await call(admin, 'PATCH', `/api/admin/devices/${carlaId}/${tv}`, { startLive: false })).statusCode).toBe(200);
    expect((await me(carla)).startLive).toBe(false);
  });
});
