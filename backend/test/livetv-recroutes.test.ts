// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 3, Task 4: the recording routes (spec §15.8), the conflict forecast (§15.4) and `liveRecord` enforced on every recording
 * write. livetv is a fake (`ctx.fetchImpl`). Fictional people, channels and titles only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetConvMemo } from '../src/convbudget.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { forecast } from '../src/livetv/recsched.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import { invalidateLiveConversions, invalidateRecordingUses } from '../src/livetv/streams.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const key = keyFromBase64(ENC_KEY);
let env: TestEnv;
let admin: Sess;
let anna: Sess;
let ben: Sess;
let gast: Sess;
const annaId = '0b000000-0000-4000-a000-0000000000a1';
const benId = '0b000000-0000-4000-a000-0000000000b1';
const gastId = '0b000000-0000-4000-a000-0000000000c1';
const annaKidsId = '0b000000-0000-4000-a000-0000000000a2';
const MIN = 60_000;
const HOUR = 3_600_000;

const calls: Call[] = [];
const recorders = new Set<string>();
function fakeLivetv() {
  env.ctx.fetchImpl = fakeHttp({
    'GET /v1/system': () => ({ json: { cpu: { model: 'x', cores: 4, loadPct: 1 }, gpu: { devices: [], driver: null, readable: false, busyPct: null, nvidia: false }, encoders: ['libx264'], cache: { usedBytes: 0, maxBytes: 1 }, recordings: { usedBytes: 0, freeBytes: 54_000_000_000 }, srt: { ports: [9000] } } }),
    'GET /v1/streams': () => ({ json: [] }),
    'GET /v1/recordings': () => ({ json: [] }),
    'DELETE /v1/recordings/[0-9a-f-]+': (u) => (recorders.has(u.pathname.split('/').pop()!) ? { status: 204 } : { status: 404, json: { error: 'not_found' } }),
    'POST /v1/recordings/[0-9a-f-]+/delete': (u) => { const id = u.pathname.split('/')[3]!; return recorders.delete(id) ? { status: 204 } : { status: 404, json: { error: 'not_found' } }; },
  }, calls);
}

let src = '';
let news = '';
let nordlicht = '';
let hafen = '';
let geheim = '';
let addr = 0;
const call = (s: Sess, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${(++addr % 200) + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });

async function person(id: string, sub: string, name: string, role: string): Promise<Sess> {
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, sub, `${sub}@friend.example.com`, name, role, id.replace(/-/g, '').slice(0, 32), encrypt(key, 'pw')]);
  const s = await env.login({ sub, email: `${sub}@friend.example.com`, name, groups: [] });
  await env.pool.query('update devices set approved = true where user_id = $1', [id]);
  return s;
}
async function annaKids(): Promise<Sess> {
  const s = await env.login({ sub: 'anna', email: 'anna@friend.example.com', name: 'Anna Beispiel', groups: [] });
  const sel = await call(s, 'POST', `/api/profiles/${annaKidsId}/select`, {});
  expect(sel.statusCode, sel.body).toBe(200);
  return { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: s.csrf };
}
async function channel(name: string, o: { kind?: 'hls' | 'srt'; group?: string; source?: string } = {}): Promise<string> {
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, group_override, epg_source_id, epg_channel_id)
     values (gen_random_uuid(), $1, $2, $3, $4, $2, $5, $1, $6) returning id`,
    [o.source ?? src, name, encrypt(key, o.kind === 'srt' ? 'srt://192.0.2.10:9000?streamid=geheim' : `https://iptv.example.com/live/anna/geheim/${encodeURIComponent(name)}.m3u8`), o.kind ?? 'hls', o.group ?? news, `${name}.de`])).rows[0]!.id;
}
const T = () => Math.ceil(Date.now() / HOUR) * HOUR + 3 * HOUR;
async function prog(xml: string, start: number, o: { minutes?: number; title?: string; episode?: string; subtitle?: string } = {}): Promise<void> {
  await env.pool.query(
    'insert into livetv_programmes(source_id, xml_channel, start_at, end_at, title, subtitle, episode, description) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [src, xml, new Date(start), new Date(start + (o.minutes ?? 60) * MIN), o.title ?? 'Die Leuchtturmwärter', o.subtitle ?? null, o.episode ?? null, 'Eine Nacht auf der Insel.']);
}
async function row(o: Record<string, unknown>): Promise<string> {
  const r = {
    id: randomUUID(), profile_id: annaId, user_id: annaId, channel_id: nordlicht, channel_name: 'Nordlicht TV', title: 'Sternstunde Physik',
    start_at: new Date(T()), end_at: new Date(T() + HOUR), pad_before_s: 120, pad_after_s: 300, storage: 'ff', dir: randomUUID(), state: 'scheduled', ...o,
  };
  const keys = Object.keys(r);
  await env.pool.query(`insert into livetv_recordings(${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
  return r.id;
}
const iso = (t: number) => new Date(t).toISOString();

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  anna = await person(annaId, 'anna', 'Anna Beispiel', 'family');
  ben = await person(benId, 'ben', 'Ben Muster', 'friend');
  gast = await person(gastId, 'gast', 'Gast Probe', 'guest');
  await env.pool.query(
    `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating) values ($1, $2, 'Kiddo', $3, 'anna-kiddo', $4, true, 6)`,
    [annaKidsId, annaId, 'f'.repeat(32), encrypt(key, 'kpw')]);
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  __resetConvMemo();
  await env.pool.query('update devices set kids_profile_id = null'); // a kids test locks its device to the kids profile
  await env.pool.query(`delete from audit_log; delete from livetv_recordings; delete from livetv_recording_purges; delete from livetv_recording_rules; delete from livetv_programmes; delete from livetv_channels;
    delete from livetv_group_roles; delete from livetv_groups; delete from livetv_sources`);
  for (const p of ['ltv', 'conv:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  calls.length = 0;
  recorders.clear();
  fakeLivetv();
  await detectLivetv(env.ctx, 0, { strict: true });
  invalidateLiveConversions();
  src = (await env.pool.query<{ id: string }>(`insert into livetv_sources(id, kind, name, url_enc) values (gen_random_uuid(), 'm3u', 'Anbieter A', $1) returning id`, [encrypt(key, 'https://iptv.example.com/get.php')])).rows[0]!.id;
  news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, kid_friendly) values (gen_random_uuid(), 'Nachrichten', true, true) returning id")).rows[0]!.id;
  const secret = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released) values (gen_random_uuid(), 'Nur Admins', true) returning id")).rows[0]!.id;
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family'), ($1, 'friend'), ($1, 'guest')", [news]);
  nordlicht = await channel('Nordlicht TV');
  hafen = await channel('Hafenkanal', { kind: 'srt' });
  geheim = await channel('Sternwarte 24', { group: secret });
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
  invalidateRecordingUses();
});

describe('rights', () => {
  it('guest (liveRecord off) gets 403 record_forbidden on POST', async () => {
    await prog('Nordlicht TV.de', T());
    const r = await call(gast, 'POST', '/api/livetv/recordings', { channelId: nordlicht, start: iso(T()) });
    expect([r.statusCode, r.json()]).toEqual([403, { error: 'record_forbidden' }]);
    expect((await call(gast, 'POST', '/api/livetv/rules', { kind: 'series', channelId: nordlicht, seriesKey: 'x', title: 'x', onlyNew: true })).statusCode).toBe(403);
    // the programme detail says so
    expect((await call(gast, 'GET', `/api/livetv/programme/${nordlicht}/${iso(T())}`)).json().canRecord).toBe(false);
  });

  it('kids profile cannot schedule or delete', async () => {
    await prog('Nordlicht TV.de', T());
    const kid = await annaKids();
    expect((await call(kid, 'POST', '/api/livetv/recordings', { channelId: nordlicht, start: iso(T()) })).json()).toEqual({ error: 'record_forbidden' });
    const shared = await row({ state: 'done', visibility: 'account' });
    expect((await call(kid, 'DELETE', `/api/livetv/recordings/${shared}`)).statusCode).toBe(403);
    expect((await call(kid, 'PATCH', `/api/livetv/recordings/${shared}`, { keep: true })).statusCode).toBe(403);
    // but it sees and watches the shared kid-friendly recording
    expect((await call(kid, 'GET', '/api/livetv/recordings')).json().recordings.map((r: { id: string }) => r.id)).toEqual([shared]);
    expect((await call(kid, 'POST', `/api/livetv/recordings/${shared}/progress`, { positionS: 30 })).statusCode).toBe(200);
  });

  it('a channel outside the profile\'s set is 404', async () => {
    await prog('Sternwarte 24.de', T());
    expect((await call(anna, 'POST', '/api/livetv/recordings', { channelId: geheim, start: iso(T()) })).statusCode).toBe(404);
    expect((await call(anna, 'GET', `/api/livetv/programme/${geheim}/${iso(T())}`)).statusCode).toBe(404);
    expect((await call(anna, 'POST', '/api/livetv/rules', { kind: 'series', channelId: geheim, seriesKey: 'x', title: 'x', onlyNew: true })).statusCode).toBe(404);
    // no programme at that time and no end + title: nothing to record
    expect((await call(anna, 'POST', '/api/livetv/recordings', { channelId: nordlicht, start: iso(T() + 7 * MIN) })).statusCode).toBe(404);
  });
});

describe('scheduling', () => {
  it('programme route applies the channel\'s EPG offset', async () => {
    await prog('Nordlicht TV.de', T(), { episode: 'S01E02', subtitle: 'Sturm' });
    await env.pool.query('update livetv_channels set epg_shift_override_min = 30 where id = $1', [nordlicht]);
    const r = await call(anna, 'GET', `/api/livetv/programme/${nordlicht}/${iso(T() + 30 * MIN)}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      channelId: nordlicht, start: iso(T() + 30 * MIN), end: iso(T() + 90 * MIN), title: 'Die Leuchtturmwärter', subtitle: 'Sturm', description: 'Eine Nacht auf der Insel.',
      episode: 'S01E02', seriesKey: 'die leuchtturmwärter', canRecord: true,
    });
    expect((await call(anna, 'GET', `/api/livetv/programme/${nordlicht}/${iso(T())}`)).statusCode).toBe(404); // the stored time is not the shown one
    // a recording and a rule of this profile are named
    const p = await call(anna, 'POST', '/api/livetv/recordings', { channelId: nordlicht, start: iso(T() + 30 * MIN) });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json().recording).toMatchObject({ title: 'Die Leuchtturmwärter', start: iso(T() + 30 * MIN), end: iso(T() + 90 * MIN), state: 'scheduled', padBefore: 2, padAfter: 5, mine: true });
    const r2 = (await call(anna, 'GET', `/api/livetv/programme/${nordlicht}/${iso(T() + 30 * MIN)}`)).json();
    expect(r2.recording).toEqual({ id: p.json().recording.id, state: 'scheduled' });
  });

  it('time-based with end + title; duplicate POST returns the existing recording', async () => {
    const body = { channelId: nordlicht, start: iso(T()), end: iso(T() + 45 * MIN), title: 'Hafenrunde', padBefore: 0, padAfter: 10 };
    const a = await call(anna, 'POST', '/api/livetv/recordings', body);
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().recording).toMatchObject({ title: 'Hafenrunde', padBefore: 0, padAfter: 10, state: 'scheduled' });
    const b = await call(anna, 'POST', '/api/livetv/recordings', body);
    expect(b.statusCode).toBe(200);
    expect(b.json().recording.id).toBe(a.json().recording.id);
    expect((await env.pool.query('select count(*)::int n from livetv_recordings')).rows[0].n).toBe(1);
    // the past cannot be recorded; nonsense is refused by field
    expect((await call(anna, 'POST', '/api/livetv/recordings', { ...body, start: iso(Date.now() - 2 * HOUR), end: iso(Date.now() - HOUR) })).json()).toEqual({ error: 'invalid', field: 'start' });
    expect((await call(anna, 'POST', '/api/livetv/recordings', { ...body, padBefore: 31 })).json()).toEqual({ error: 'invalid', field: 'padBefore' });
    expect((await call(anna, 'POST', '/api/livetv/recordings', { ...body, end: iso(T() - 1) })).json()).toEqual({ error: 'invalid', field: 'end' });
  });

  it('conflict answers the forecast; force plans anyway', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const sat = await channel('Satkanal', { kind: 'srt' });
    invalidateLivetvRights();
    await row({ channel_id: hafen, channel_name: 'Hafenkanal' });
    const body = { channelId: sat, start: iso(T()), end: iso(T() + HOUR), title: 'Sternstunde Physik' };
    const r = await call(anna, 'POST', '/api/livetv/recordings', body);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'conflict', forecast: { slots: { used: 2, limit: 1 }, parallel: { used: 2, max: 4 }, provider: null, conflict: true } });
    const f = await call(anna, 'POST', '/api/livetv/recordings', { ...body, force: true });
    expect(f.statusCode).toBe(201);
    expect(f.json().forecast.conflict).toBe(true);
  });

  it('forecast counts a channel once for two recordings', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    await row({ channel_id: hafen, channel_name: 'Hafenkanal' });
    const fc = await forecast(env.ctx, { channelId: hafen, from: T(), to: T() + HOUR });
    expect(fc).toEqual({ slots: { used: 1, limit: 1 }, parallel: { used: 1, max: 4 }, provider: null, conflict: false });
    const r = await call(ben, 'POST', '/api/livetv/recordings', { channelId: hafen, start: iso(T()), end: iso(T() + HOUR), title: 'Hafenrunde' });
    expect(r.statusCode, r.body).toBe(201);
  });

  it('parallel and provider limits conflict', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_MAX_PARALLEL: 2 };
    await row({});
    await row({ channel_id: geheim, channel_name: 'Sternwarte 24' });
    const extra = await channel('Testkanal');
    const fc = await forecast(env.ctx, { channelId: extra, from: T(), to: T() + HOUR });
    expect([fc.parallel, fc.conflict]).toEqual([{ used: 3, max: 2 }, true]);
    // later rows only overlap partly: the busiest moment counts
    env.ctx.cfg = { ...cfg };
    await env.pool.query('update livetv_sources set max_streams = 2 where id = $1', [src]);
    const fc2 = await forecast(env.ctx, { channelId: extra, from: T() + 30 * MIN, to: T() + 2 * HOUR });
    expect([fc2.provider, fc2.conflict]).toEqual([{ used: 3, max: 2 }, true]);
    expect((await forecast(env.ctx, { channelId: extra, from: T() + 2 * HOUR, to: T() + 3 * HOUR })).conflict).toBe(false);
  });

  it('copy-mode never conflicts on slots', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    await row({ channel_id: hafen, channel_name: 'Hafenkanal' });
    const fc = await forecast(env.ctx, { channelId: nordlicht, from: T(), to: T() + HOUR });
    expect(fc).toEqual({ slots: { used: 1, limit: 1 }, parallel: { used: 2, max: 4 }, provider: null, conflict: false });
  });

  it('rules: a series rule plans its airings and answers the forecast of the first; delete cancels its plans', async () => {
    await prog('Nordlicht TV.de', T(), { episode: 'S01E01' });
    await prog('Nordlicht TV.de', T() + 24 * HOUR, { episode: 'S01E02' });
    const r = await call(anna, 'POST', '/api/livetv/rules', { kind: 'series', channelId: nordlicht, seriesKey: 'die leuchtturmwärter', title: 'Die Leuchtturmwärter', onlyNew: true, keepMax: 5 });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().forecast).toMatchObject({ conflict: false });
    const list = (await call(anna, 'GET', '/api/livetv/recordings?state=scheduled')).json();
    expect(list.recordings.map((x: { episode: string }) => x.episode)).toEqual(['S01E02', 'S01E01']);
    expect(list.rules).toEqual([expect.objectContaining({ kind: 'series', seriesKey: 'die leuchtturmwärter', keepMax: 5, onlyNew: true })]);
    const t = await call(anna, 'POST', '/api/livetv/rules', { kind: 'time', channelId: nordlicht, weekdays: [1, 2, 3, 4, 5], startTime: '06:30', durationMin: 30, tz: 'Europe/Berlin', title: 'Frühnachrichten' });
    expect(t.statusCode, t.body).toBe(201);
    expect((await call(anna, 'POST', '/api/livetv/rules', { kind: 'time', channelId: nordlicht, weekdays: [1], startTime: '06:30', durationMin: 30, tz: 'Mars/Olympus', title: 'x' })).json()).toEqual({ error: 'invalid', field: 'tz' });
    const pr = await call(anna, 'PATCH', `/api/livetv/rules/${r.json().rule.id}`, { keepMax: null, padAfter: 15 });
    expect(pr.json().rule).toMatchObject({ keepMax: null, padAfter: 15 });
    expect((await call(ben, 'DELETE', `/api/livetv/rules/${r.json().rule.id}`)).statusCode).toBe(404);
    expect((await call(anna, 'DELETE', `/api/livetv/rules/${r.json().rule.id}`)).statusCode).toBe(204);
    expect((await env.pool.query("select count(*)::int n from livetv_recordings where state = 'scheduled' and series_key is not null")).rows[0].n).toBe(0);
  });
});

describe('changing and deleting', () => {
  it('DELETE of a running recording stops it then removes its files', async () => {
    const id = await row({ state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 10 * MIN), end_at: new Date(Date.now() + HOUR), bytes: 5000 });
    recorders.add(id);
    expect((await call(ben, 'DELETE', `/api/livetv/recordings/${id}`)).statusCode).toBe(404);
    const r = await call(anna, 'DELETE', `/api/livetv/recordings/${id}`);
    expect(r.statusCode).toBe(204);
    const order = calls.filter((c) => c.path.startsWith(`/v1/recordings/${id}`)).map((c) => `${c.method} ${c.path.slice(15 + 36) || '/'}`);
    expect(order).toEqual(['DELETE /', 'POST /delete']);
    expect(calls.find((c) => c.path.endsWith('/delete'))!.body).toEqual({ dir: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((await env.pool.query('select count(*)::int n from livetv_recordings where id = $1', [id])).rows[0].n).toBe(0);
    // a scheduled one is cancelled, nothing is asked of livetv
    calls.length = 0;
    const s = await row({});
    expect((await call(anna, 'DELETE', `/api/livetv/recordings/${s}`)).statusCode).toBe(204);
    expect((await env.pool.query('select state from livetv_recordings where id = $1', [s])).rows[0].state).toBe('cancelled');
    expect(calls.filter((c) => c.path.startsWith('/v1/recordings'))).toEqual([]);
  });

  it('PATCH visibility only by owner or admin', async () => {
    const id = await row({ state: 'done', visibility: 'account', bytes: 10 });
    // another profile sees it (shared with the account) but may not change it
    expect((await call(ben, 'PATCH', `/api/livetv/recordings/${id}`, { visibility: 'everyone' })).statusCode).toBe(404);
    const own = await call(anna, 'PATCH', `/api/livetv/recordings/${id}`, { visibility: 'everyone', keep: true });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().recording).toMatchObject({ visibility: 'everyone', keep: true });
    expect((await call(ben, 'PATCH', `/api/livetv/recordings/${id}`, { visibility: 'private' })).statusCode).toBe(403);
    const ad = await call(admin, 'PATCH', `/api/livetv/recordings/${id}`, { visibility: 'private' });
    expect(ad.statusCode).toBe(200);
    expect((await env.pool.query('select visibility from livetv_recordings where id = $1', [id])).rows[0].visibility).toBe('private');
    expect((await env.pool.query("select action, target from audit_log where action like 'livetv.rec.%'")).rows).toEqual([{ action: 'livetv.rec.share', target: id }]);
    // padding only while scheduled
    expect((await call(anna, 'PATCH', `/api/livetv/recordings/${id}`, { padAfter: 10 })).json()).toEqual({ error: 'not_scheduled' });
  });

  it('progress: the owner\'s 90 % marks it watched', async () => {
    const id = await row({ state: 'done', duration_s: 1000, bytes: 10 });
    await call(anna, 'POST', `/api/livetv/recordings/${id}/progress`, { positionS: 500 });
    expect((await call(anna, 'GET', `/api/livetv/recordings/${id}`)).json().recording).toMatchObject({ positionS: 500, watched: false });
    await call(anna, 'POST', `/api/livetv/recordings/${id}/progress`, { positionS: 950 });
    expect((await call(anna, 'GET', `/api/livetv/recordings/${id}`)).json().recording).toMatchObject({ positionS: 950, watched: true });
    expect((await call(ben, 'POST', `/api/livetv/recordings/${id}/progress`, { positionS: 1 })).statusCode).toBe(404);
  });

  it('admin list shows metadata only; delete-all needs LÖSCHEN', async () => {
    const a = await row({ state: 'done', bytes: 10, title: 'Die Leuchtturmwärter' });
    await row({ state: 'scheduled', channel_id: hafen, channel_name: 'Hafenkanal' });
    const l = await call(admin, 'GET', '/api/admin/livetv/recordings');
    expect(l.statusCode).toBe(200);
    expect(l.json().total).toBe(2);
    expect(l.body).not.toContain('Leuchtturm');
    expect(Object.keys(l.json().items[0]).sort()).toEqual(['bytes', 'channel', 'end', 'error', 'id', 'keep', 'mode', 'profile', 'start', 'state']);
    expect((await call(anna, 'GET', '/api/admin/livetv/recordings')).statusCode).toBe(403);
    expect((await call(admin, 'POST', '/api/admin/livetv/recordings/delete-all', { confirm: 'loeschen' })).json()).toEqual({ error: 'invalid', field: 'confirm' });
    recorders.add(a);
    const d = await call(admin, 'POST', '/api/admin/livetv/recordings/delete-all', { confirm: 'LÖSCHEN' });
    expect(d.json()).toEqual({ deleted: 2, pending: 0 });
    expect((await env.pool.query("select count(*)::int n from livetv_recordings where state <> 'cancelled'")).rows[0].n).toBe(0);
    expect((await env.pool.query("select action from audit_log where action like 'livetv.rec.%'")).rows).toEqual([{ action: 'livetv.rec.delete_all' }]);
    const s = await call(admin, 'GET', '/api/admin/livetv/recordings/storage');
    expect(s.json()).toEqual({ usedBytes: 0, limitBytes: 200_000_000_000, freeBytes: 54_000_000_000, hoursLeftHd: 20, library: null });
  });

  it('no answer or log line contains a stream URL', async () => {
    await prog('Nordlicht TV.de', T());
    const answers: string[] = [];
    const p = await call(anna, 'POST', '/api/livetv/recordings', { channelId: nordlicht, start: iso(T()) });
    answers.push(p.body);
    answers.push((await call(anna, 'GET', '/api/livetv/recordings')).body);
    answers.push((await call(anna, 'GET', `/api/livetv/programme/${nordlicht}/${iso(T())}`)).body);
    answers.push((await call(admin, 'GET', '/api/admin/livetv/recordings')).body);
    for (const a of answers) expect(a).not.toMatch(/iptv\.example\.com|geheim|\/recordings\/[0-9a-f]{8}-/);
    expect(answers.join('')).not.toContain((await env.pool.query('select dir from livetv_recordings')).rows[0].dir);
  });
});
