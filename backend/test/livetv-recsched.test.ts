// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 3, Task 3: the recording scheduler (spec §15): rules, EPG follow, due starts and stops, the reconcile with livetv's
 * recorders, budget reservations and the notifications of §16. livetv is a fake (`ctx.fetchImpl`): it records every stream and recorder
 * call and lists what it runs. Fictional people, channels and titles only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetConvMemo, admitConversion, countConversions, dropConvGrant } from '../src/convbudget.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { listEvents } from '../src/livetv/events.js';
import { afterEpgImport, expandRules, followEpg, livetvRecordTick, timeOccurrences } from '../src/livetv/recsched.js';
import { getRecording, progKey } from '../src/livetv/recordings.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import { invalidateLiveConversions, invalidateRecordingUses } from '../src/livetv/streams.js';
import type { RecorderView, StreamView } from '../src/livetv/wire.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

const key = keyFromBase64(ENC_KEY);
let env: TestEnv;
const ANNA = '0a000000-0000-4000-a000-0000000000a1';
const BEN = '0a000000-0000-4000-a000-0000000000b1';
const GUEST = '0a000000-0000-4000-a000-0000000000c1';
const MIN = 60_000;
const HOUR = 3_600_000;

// ---- the fake livetv ----
const calls: Call[] = [];
const streams = new Map<string, StreamView>();
const recorders = new Map<string, RecorderView>();
let up = true;
let recPostStatus = 200;
let closeAnswer: Omit<RecorderView, 'id' | 'dir' | 'since'> | null = null;
let free = 100 * 1024 ** 3;
let keyN = 0;
const view = (channelId: string, o: Partial<StreamView> = {}): StreamView => ({
  channelId, streamKey: (++keyN).toString(16).padStart(32, '0'), mode: 'passthrough', since: Date.now(), state: 'running', bitrate: 4_000_000, errors: [],
  lastSegmentAt: Date.now(), segments: 'ts', ...o,
});
const rec = (id: string, channelId: string, o: Partial<RecorderView> = {}): RecorderView => ({
  id, channelId, dir: '0f000000-0000-4000-a000-00000000d0d0', state: 'recording', segments: 'ts', bytes: 0, durationS: 0, gaps: [], error: null, since: Date.now(), ...o,
});
const of = (method: string, path: RegExp | string) => calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));
function fakeLivetv() {
  env.ctx.fetchImpl = fakeHttp({
    'GET /healthz': () => (up ? { json: { ok: true, api: 1, version: '3.4.0', bootId: '0123456789abcdef' } } : { status: 503, json: { error: 'down' } }),
    'GET /v1/system': () => ({ json: { cpu: { model: 'x', cores: 4, loadPct: 1 }, gpu: { devices: [], driver: null, readable: false, busyPct: null, nvidia: false }, encoders: ['libx264'], cache: { usedBytes: 0, maxBytes: 1 }, recordings: { usedBytes: 0, freeBytes: free }, srt: { ports: [9000] } } }),
    'GET /v1/streams': () => ({ json: [...streams.values()] }),
    'POST /v1/streams': (_u, _i, b: Record<string, unknown>) => {
      const id = String(b.channelId);
      const v = streams.get(id) ?? view(id, { mode: b.mode as StreamView['mode'] });
      streams.set(id, v);
      return { json: { streamKey: v.streamKey, state: v.state } };
    },
    'DELETE /v1/streams/[\\w-]+': (u) => { streams.delete(u.pathname.split('/').pop()!); return { status: 204 }; },
    'GET /v1/ingest': () => ({ json: [] }),
    'GET /v1/recordings': () => ({ json: [...recorders.values()] }),
    'POST /v1/recordings': (_u, _i, b: Record<string, unknown>) => {
      if (recPostStatus !== 200) return { status: recPostStatus, json: { error: recPostStatus === 507 ? 'storage_full' : 'stream_not_running' } };
      const id = String(b.id);
      if (!recorders.has(id) || recorders.get(id)!.state !== 'recording') recorders.set(id, rec(id, String(b.channelId)));
      return { json: { state: 'recording', segments: 'ts' } };
    },
    'PATCH /v1/recordings/[0-9a-f-]+': () => ({ json: { ok: true } }),
    'DELETE /v1/recordings/[0-9a-f-]+': (u) => {
      const r = recorders.get(u.pathname.split('/').pop()!);
      if (!r) return { status: 404, json: { error: 'not_found' } };
      r.state = r.bytes ? 'done' : 'failed';
      return { status: 204 };
    },
    'POST /v1/recordings/[0-9a-f-]+/delete': (u) => { recorders.delete(u.pathname.split('/')[3]!); return { status: 204 }; },
    'POST /v1/recordings/[0-9a-f-]+/close': (u, _i, b: { dir: string }) => (closeAnswer ? { json: { ...closeAnswer, id: u.pathname.split('/')[3], dir: b.dir } } : { status: 404, json: { error: 'not_found' } }),
  }, calls);
}

// ---- data ----
let src = '';
let news = '';
let nordlicht = '';
let hafen = '';
let sternwarte = '';

async function person(id: string, role: string, name: string): Promise<void> {
  const sub = name.split(' ')[0]!.toLowerCase();
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, `${sub}-sub`, `${sub}@friend.example.com`, name, role, id.replace(/-/g, '').slice(0, 32), encrypt(key, 'pw')]);
  await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name.split(' ')[0]]);
}
async function channel(name: string, o: { kind?: 'hls' | 'srt'; xml?: string } = {}): Promise<string> {
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, group_override, epg_source_id, epg_channel_id)
     values (gen_random_uuid(), $1, $2, $3, $4, $2, $5, $1, $6) returning id`,
    [src, name, encrypt(key, o.kind === 'srt' ? 'srt://192.0.2.10:9000?streamid=geheim' : `https://iptv.example.com/live/anna/geheim/${encodeURIComponent(name)}.m3u8`), o.kind ?? 'hls', news, o.xml ?? `${name}.de`])).rows[0]!.id;
}
async function prog(xml: string, start: number, o: { minutes?: number; title?: string; episode?: string; subtitle?: string; series?: string; isNew?: boolean; prev?: boolean } = {}): Promise<void> {
  await env.pool.query(
    `insert into livetv_programmes(source_id, xml_channel, start_at, end_at, title, subtitle, episode, series_key, is_new, previously_shown)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [src, xml, new Date(start), new Date(start + (o.minutes ?? 60) * MIN), o.title ?? 'Die Leuchtturmwärter', o.subtitle ?? null, o.episode ?? null, o.series ?? null, o.isNew ?? null, o.prev ?? null]);
}
async function rule(o: Record<string, unknown>): Promise<string> {
  const row = { id: randomUUID(), profile_id: ANNA, user_id: ANNA, kind: 'series', title: 'Die Leuchtturmwärter', ...o };
  const keys = Object.keys(row);
  await env.pool.query(`insert into livetv_recording_rules(${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return row.id;
}
async function recording(o: Record<string, unknown>): Promise<string> {
  const row = {
    id: randomUUID(), profile_id: ANNA, user_id: ANNA, channel_id: nordlicht, channel_name: 'Nordlicht TV', title: 'Sternstunde Physik',
    start_at: new Date(Date.now() + MIN), end_at: new Date(Date.now() + HOUR), pad_before_s: 120, pad_after_s: 300, storage: 'ff', dir: randomUUID(), state: 'scheduled', ...o,
  };
  const keys = Object.keys(row);
  await env.pool.query(`insert into livetv_recordings(${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  invalidateRecordingUses();
  return row.id;
}
const rows = async (where = 'true', args: unknown[] = []) => (await env.pool.query(`select * from livetv_recordings where ${where} order by start_at, channel_name`, args)).rows;
const notices = async (kind: string) => (await env.pool.query('select user_id, title from notifications where kind = $1 order by id', [kind])).rows;
const tick = async (now = Date.now()) => { await env.kv.del('ltv:rectick'); invalidateLiveConversions(); invalidateRecordingUses(); await livetvRecordTick(env.ctx, now); };
let adminId = '';

beforeAll(async () => {
  env = await makeEnv();
  await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
  await person(ANNA, 'family', 'Anna Beispiel');
  await person(BEN, 'friend', 'Ben Muster');
  await person(GUEST, 'guest', 'Gast Probe');
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  __resetConvMemo();
  await env.pool.query(`delete from notifications; delete from livetv_recordings; delete from livetv_recording_rules; delete from livetv_programmes;
    delete from livetv_channels; delete from livetv_group_roles; delete from livetv_groups; delete from livetv_sources`);
  for (const p of ['ltv', 'conv:', 'play:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  streams.clear(); recorders.clear(); calls.length = 0;
  up = true; recPostStatus = 200; free = 100 * 1024 ** 3; closeAnswer = null;
  fakeLivetv();
  await detectLivetv(env.ctx, 0, { strict: true });
  invalidateLiveConversions();
  src = (await env.pool.query<{ id: string }>(`insert into livetv_sources(id, kind, name, url_enc) values (gen_random_uuid(), 'm3u', 'Anbieter A', $1) returning id`, [encrypt(key, 'https://iptv.example.com/get.php')])).rows[0]!.id;
  news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released) values (gen_random_uuid(), 'Nachrichten', true) returning id")).rows[0]!.id;
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family'), ($1, 'friend'), ($1, 'guest')", [news]);
  nordlicht = await channel('Nordlicht TV');
  hafen = await channel('Hafenkanal', { kind: 'srt' });
  sternwarte = await channel('Sternwarte 24');
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
  invalidateRecordingUses();
});

describe('rules', () => {
  const t0 = () => Math.ceil(Date.now() / HOUR) * HOUR + 2 * HOUR;

  it('series rule schedules only new episodes on this channel / all channels', async () => {
    const t = t0();
    await prog('Nordlicht TV.de', t, { episode: 'S01E01', isNew: true });
    await prog('Nordlicht TV.de', t + 2 * HOUR, { episode: 'S01E02' }); // the source uses <new/>: this one is not new
    await prog('Nordlicht TV.de', t + 4 * HOUR, { episode: 'S01E03', isNew: true, prev: true }); // previously shown
    await prog('Nordlicht TV.de', t + 6 * HOUR, { episode: 'S01E04', isNew: true });
    await prog('Sternwarte 24.de', t + HOUR, { episode: 'S01E05', isNew: true });
    await prog('Nordlicht TV.de', t + 8 * HOUR, { title: 'Sternstunde Physik', isNew: true }); // another series
    await prog('Nordlicht TV.de', t + 9 * 24 * HOUR, { episode: 'S01E06', isNew: true }); // beyond 8 days
    const r = await rule({ channel_id: nordlicht, series_key: 'die leuchtturmwärter' });
    // an episode recorded before by this rule is not new for it
    await recording({ rule_id: r, episode: 'S01E04', state: 'done', start_at: new Date(t - 30 * 24 * HOUR), end_at: new Date(t - 30 * 24 * HOUR + HOUR) });
    expect(await expandRules(env.ctx)).toBe(1);
    expect((await rows("state = 'scheduled'")).map((x) => [x.episode, x.channel_id, x.follow_epg, x.prog_key, x.pad_before_s, x.pad_after_s]))
      .toEqual([['S01E01', nordlicht, true, progKey({ title: 'Die Leuchtturmwärter', episode: 'S01E01' }), 120, 300]]);
    // running again plans nothing twice
    expect(await expandRules(env.ctx)).toBe(0);
    // all channels: the airing on Sternwarte 24 too; a rule without "only new" takes the repeats
    await env.pool.query('update livetv_recording_rules set channel_id = null, only_new = false where id = $1', [r]);
    await expandRules(env.ctx);
    expect((await rows("state = 'scheduled'")).map((x) => x.episode)).toEqual(['S01E01', 'S01E05', 'S01E02', 'S01E03', 'S01E04']);
    // a series id of the guide wins over the title
    await prog('Hafenkanal.de', t, { title: 'Leuchtturm (Wh.)', series: 'EP0042', episode: 'S02E01', isNew: true });
    await rule({ channel_id: hafen, series_key: 'EP0042', title: 'Leuchtturm' });
    await expandRules(env.ctx);
    expect((await rows('channel_id = $1', [hafen])).map((x) => x.title)).toEqual(['Leuchtturm (Wh.)']);
  });

  it('keep_max deletes the oldest unprotected of the rule', async () => {
    const r = await rule({ channel_id: nordlicht, series_key: 'die leuchtturmwärter', keep_max: 2 });
    const day = (d: number) => ({ start_at: new Date(Date.now() - d * 24 * HOUR), end_at: new Date(Date.now() - d * 24 * HOUR + HOUR) });
    const oldest = await recording({ rule_id: r, state: 'done', bytes: 10, mode: 'passthrough', ...day(5) });
    const kept = await recording({ rule_id: r, state: 'done', bytes: 10, mode: 'passthrough', keep: true, ...day(4) });
    const old = await recording({ rule_id: r, state: 'partial', bytes: 10, mode: 'passthrough', ...day(3) });
    const b = await recording({ rule_id: r, state: 'done', bytes: 10, mode: 'passthrough', ...day(2) });
    const c = await recording({ rule_id: r, state: 'done', bytes: 10, mode: 'passthrough', ...day(1) });
    const other = await recording({ state: 'done', bytes: 10, mode: 'passthrough', ...day(6) });
    await expandRules(env.ctx);
    expect((await rows()).map((x) => x.id).sort()).toEqual([kept, b, c, other].sort());
    expect(of('POST', /\/v1\/recordings\/[0-9a-f-]+\/delete$/).map((x) => x.path.split('/')[3]).sort()).toEqual([oldest, old].sort());
  });

  it('time rule expands weekdays in its time zone across DST', () => {
    // Europe/Berlin leaves summer time on Sunday 2026-10-25: 20:15 local is 18:15Z before, 19:15Z after
    const now = Date.parse('2026-10-21T12:00:00Z'); // a Wednesday
    const occ = timeOccurrences({ weekdays: [6, 7, 1], start_time: '20:15:00', duration_min: 45, tz: 'Europe/Berlin' }, now);
    expect(occ.map(([s, e]) => [new Date(s).toISOString(), (e - s) / MIN])).toEqual([
      ['2026-10-24T18:15:00.000Z', 45], // Saturday, summer time
      ['2026-10-25T19:15:00.000Z', 45], // Sunday, winter time
      ['2026-10-26T19:15:00.000Z', 45], // Monday
    ]);
    // New York: a rule on every weekday, 08:00, spans its own switch (2026-11-01)
    const ny = timeOccurrences({ weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: '08:00', duration_min: 30, tz: 'America/New_York' }, Date.parse('2026-10-30T20:00:00Z'));
    expect(ny.slice(0, 3).map(([s]) => new Date(s).toISOString())).toEqual(['2026-10-31T12:00:00.000Z', '2026-11-01T13:00:00.000Z', '2026-11-02T13:00:00.000Z']);
    expect(timeOccurrences({ weekdays: [1], start_time: '08:00', duration_min: 30, tz: 'Mars/Olympus' }, now)).toEqual([]);
  });

  it('a time rule plans its occurrences as rows without EPG follow', async () => {
    await rule({ kind: 'time', series_key: null, channel_id: sternwarte, title: 'Hafenrunde', weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: '06:00', duration_min: 30, tz: 'Europe/Berlin' });
    expect(await expandRules(env.ctx)).toBeGreaterThanOrEqual(8);
    const r = (await rows())[0]!;
    expect([r.title, r.channel_name, r.follow_epg, r.prog_key, (r.end_at - r.start_at) / MIN]).toEqual(['Hafenrunde', 'Sternwarte 24', false, null, 30]);
  });
});

describe('EPG follow', () => {
  const t0 = () => Math.ceil(Date.now() / HOUR) * HOUR + 5 * HOUR;

  it('EPG re-import moves a scheduled recording to its programme\'s new time', async () => {
    const t = t0();
    await prog('Nordlicht TV.de', t, { episode: 'S01E01' });
    await prog('Nordlicht TV.de', t + HOUR, { title: 'Sternstunde Physik' });
    await rule({ channel_id: nordlicht, series_key: 'die leuchtturmwärter', only_new: false });
    await expandRules(env.ctx);
    const [r] = await rows();
    // the guide is imported again: the episode now starts 25 minutes later and runs 70 minutes; another programme sits at the old time
    await env.pool.query('delete from livetv_programmes');
    await prog('Nordlicht TV.de', t, { title: 'Sternstunde Physik', minutes: 25 });
    await prog('Nordlicht TV.de', t + 25 * MIN, { episode: 'S01E01', minutes: 70 });
    await afterEpgImport(env.ctx, src);
    const moved = await getRecording(env.ctx, r!.id);
    expect([moved!.start_at.getTime() - t, moved!.end_at.getTime() - t]).toEqual([25 * MIN, 95 * MIN]);
    expect((await listEvents(env.ctx)).filter((e) => e.code === 'rec_moved').map((e) => e.recordingId)).toEqual([r!.id]);
    // a programme more than 3 h away is another airing: the recording keeps its time
    await env.pool.query('delete from livetv_programmes');
    await prog('Nordlicht TV.de', t + 4 * HOUR, { episode: 'S01E01' });
    await followEpg(env.ctx);
    expect((await getRecording(env.ctx, r!.id))!.start_at.getTime() - t).toBe(25 * MIN);
  });

  it('a channel EPG offset change moves scheduled recordings', async () => {
    const t = t0();
    await prog('Nordlicht TV.de', t, { episode: 'S01E01' });
    await rule({ channel_id: nordlicht, series_key: 'die leuchtturmwärter', only_new: false });
    await expandRules(env.ctx);
    const [r] = await rows();
    expect(r!.start_at.getTime()).toBe(t);
    await env.pool.query('update livetv_channels set epg_shift_override_min = 60 where id = $1', [nordlicht]);
    expect(await followEpg(env.ctx)).toBe(1);
    expect((await getRecording(env.ctx, r!.id))!.start_at.getTime()).toBe(t + HOUR);
    // the source's offset applies to the channel without its own
    await env.pool.query('update livetv_channels set epg_shift_override_min = null where id = $1', [nordlicht]);
    await env.pool.query('update livetv_sources set epg_shift_min = -30 where id = $1', [src]);
    await followEpg(env.ctx);
    expect((await getRecording(env.ctx, r!.id))!.start_at.getTime()).toBe(t - 30 * MIN);
  });

  it('a started recording grows when the programme end moves later, never shrinks', async () => {
    const start = Date.now() - 10 * MIN;
    await prog('Nordlicht TV.de', start, { episode: 'S01E01', minutes: 60 });
    const id = await recording({ state: 'recording', mode: 'passthrough', follow_epg: true, prog_key: progKey({ title: 'Die Leuchtturmwärter', episode: 'S01E01' }), start_at: new Date(start), end_at: new Date(start + HOUR) });
    streams.set(nordlicht, view(nordlicht));
    recorders.set(id, rec(id, nordlicht));
    await env.pool.query("update livetv_programmes set end_at = end_at + interval '20 minutes'");
    await tick();
    expect((await getRecording(env.ctx, id))!.end_at.getTime()).toBe(start + 80 * MIN);
    expect(of('PATCH', `/v1/recordings/${id}`).map((c) => c.body)).toEqual([{ endAt: start + 80 * MIN + 300_000 }]);
    // an earlier end never shortens it; more than 3 h later is not followed
    await env.pool.query("update livetv_programmes set end_at = end_at - interval '40 minutes'");
    await tick();
    await env.pool.query("update livetv_programmes set end_at = end_at + interval '5 hours'");
    await tick();
    expect((await getRecording(env.ctx, id))!.end_at.getTime()).toBe(start + 80 * MIN);
    expect(of('PATCH', `/v1/recordings/${id}`)).toHaveLength(1);
  });
});

describe('replicas (fix round 1, A-C1)', () => {
  it('two schedulers racing one row: exactly one recorder, nothing deleted', async () => {
    const start = Date.now() + 60_000;
    const id = await recording({ start_at: new Date(start), end_at: new Date(start + HOUR) });
    // the first scheduler's stream start hangs (a slow provider) long enough for its tick lock to lapse
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let waiting = 0;
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (init?.method === 'POST' && u.pathname === '/v1/streams') { waiting++; await gate; }
      return inner(input, init);
    }) as typeof fetch;
    const a = livetvRecordTick(env.ctx);
    await vi.waitFor(() => expect(waiting).toBe(1));
    await env.kv.del('ltv:rectick'); // its lock lapsed: a second replica ticks
    invalidateLiveConversions();
    const b = livetvRecordTick(env.ctx);
    await new Promise((r) => setTimeout(r, 100));
    release();
    await Promise.all([a, b]);
    expect((await getRecording(env.ctx, id))?.state).toBe('recording');
    expect(of('POST', /\/v1\/recordings\/[0-9a-f-]+\/delete$/)).toEqual([]);
    expect(of('DELETE', /\/v1\/recordings\//)).toEqual([]);
    expect(of('POST', '/v1/streams')).toHaveLength(1);
    expect([...recorders.keys()]).toEqual([id]);
  });
});

describe('finalisation and orphans (fix round 1)', () => {
  it('B-I2: a recorder lost after the end is finalised from its folder: done, no failure notice', async () => {
    const id = await recording({ state: 'recording', mode: 'passthrough', bytes: 4000, start_at: new Date(Date.now() - 2 * HOUR), end_at: new Date(Date.now() - HOUR), pad_after_s: 60 });
    // livetv restarted after the end: it lists no recorder, but the folder is complete
    closeAnswer = { channelId: '', state: 'done', segments: 'ts', bytes: 9000, durationS: 3600, gaps: [], error: null };
    await tick();
    const r = await getRecording(env.ctx, id);
    expect([r!.state, r!.bytes, r!.duration_s, r!.error]).toEqual(['done', '9000', 3600, null]);
    expect(of('POST', `/v1/recordings/${id}/close`).map((c) => c.body)).toEqual([{ dir: r!.dir }]);
    expect(await notices('livetv.rec.failed')).toEqual([]);
    // no folder at all: failed, the owner told once
    const gone = await recording({ channel_id: sternwarte, channel_name: 'Sternwarte 24', state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 2 * HOUR), end_at: new Date(Date.now() - HOUR), pad_after_s: 60 });
    closeAnswer = null;
    await tick();
    await tick();
    expect((await getRecording(env.ctx, gone))!.state).toBe('failed');
    expect(await notices('livetv.rec.failed')).toHaveLength(1);
  });

  it('A-I3/B-I3: the reconcile stops recorders whose row is not recording, and removes the folder of a cancelled or gone one', async () => {
    const cancelled = await recording({ state: 'cancelled', start_at: new Date(Date.now() - 10 * 60_000) });
    const finished = await recording({ channel_id: sternwarte, channel_name: 'Sternwarte 24', state: 'done', bytes: 10, start_at: new Date(Date.now() - 3 * HOUR), end_at: new Date(Date.now() - 2 * HOUR) });
    const starting = await recording({ channel_id: hafen, channel_name: 'Hafenkanal', state: 'starting', claim_token: randomUUID(), claim_until: new Date(Date.now() + 60_000) });
    const orphan = randomUUID();
    const dirOf = async (id: string) => (await getRecording(env.ctx, id))?.dir ?? `${id.slice(0, 34)}d0`;
    for (const id of [cancelled, finished, starting, orphan]) recorders.set(id, rec(id, nordlicht, { dir: await dirOf(id) }));
    const cancelledDir = await dirOf(cancelled);
    await tick();
    expect(of('DELETE', /^\/v1\/recordings\/[0-9a-f-]+$/).map((c) => c.path.split('/')[3]).sort()).toEqual([cancelled, finished, orphan].sort());
    expect(of('POST', /\/delete$/).map((c) => [c.path.split('/')[3], c.body.dir]).sort()).toEqual([[cancelled, cancelledDir], [orphan, `${orphan.slice(0, 34)}d0`]].sort());
    expect((await getRecording(env.ctx, finished))!.state).toBe('done');
    expect(recorders.has(starting)).toBe(true);
  });

  it('A-I3: a resume racing a delete leaves no recorder behind', async () => {
    const id = await recording({ state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 10 * 60_000), end_at: new Date(Date.now() + HOUR) });
    // livetv lost the recorder; the owner deletes the recording while the resume posts it again
    const inner = env.ctx.fetchImpl;
    let once = true;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (once && init?.method === 'POST' && u.pathname === '/v1/recordings') {
        once = false;
        const { deleteRecording } = await import('../src/livetv/recordings.js');
        await deleteRecording(env.ctx, id, 'owner');
      }
      return inner(input, init);
    }) as typeof fetch;
    await tick();
    await tick();
    expect(await getRecording(env.ctx, id)).toBeNull();
    expect([...recorders.values()].filter((r) => r.state === 'recording')).toEqual([]);
  });
});

describe('the tick', () => {
  it('due start posts the stream then the recording with padding', async () => {
    const start = Date.now() + MIN;
    const id = await recording({ start_at: new Date(start), end_at: new Date(start + HOUR) });
    await tick();
    const order = calls.filter((c) => c.method === 'POST' && (c.path === '/v1/streams' || c.path === '/v1/recordings')).map((c) => c.path);
    expect(order).toEqual(['/v1/streams', '/v1/recordings']);
    const r = await getRecording(env.ctx, id);
    expect(of('POST', '/v1/recordings')[0]!.body).toEqual({ id, channelId: nordlicht, dir: r!.dir, endAt: start + HOUR + 300_000 });
    expect([r!.state, r!.mode, r!.segments, r!.gaps]).toEqual(['recording', 'passthrough', 'ts', []]);
    expect((await listEvents(env.ctx)).map((e) => e.code)).toContain('rec_started');
    // not due yet (start − padding in the future): nothing
    calls.length = 0;
    await recording({ channel_id: sternwarte, channel_name: 'Sternwarte 24', start_at: new Date(Date.now() + 10 * MIN), end_at: new Date(Date.now() + HOUR) });
    await tick();
    expect(of('POST', '/v1/streams')).toEqual([]);
  });

  it('two recordings of one channel share one stream and one record slot', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 2 };
    const start = Date.now() + MIN;
    const a = await recording({ channel_id: hafen, channel_name: 'Hafenkanal', start_at: new Date(start), end_at: new Date(start + HOUR) });
    const b = await recording({ profile_id: BEN, user_id: BEN, channel_id: hafen, channel_name: 'Hafenkanal', start_at: new Date(start), end_at: new Date(start + HOUR) });
    await tick();
    expect(of('POST', '/v1/streams')).toHaveLength(1);
    expect(of('POST', '/v1/streams')[0]!.body.mode).toBe('transcode');
    expect(of('POST', '/v1/recordings').map((c) => c.body.id).sort()).toEqual([a, b].sort());
    invalidateLiveConversions();
    const conv = (await countConversions(env.ctx))!;
    expect(conv.map((e) => [e.kind, e.key])).toEqual([['record', `live:${hafen}`]]);
  });

  it('reservation keeps a new viewer\'s transcode out 5 minutes ahead; its own reservation is not counted against the recording\'s start', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const start = Date.now() + 6 * MIN; // start − 2 min padding − 5 min lead: inside the window
    await recording({ channel_id: hafen, channel_name: 'Hafenkanal', start_at: new Date(start), end_at: new Date(start + HOUR) });
    await tick();
    expect(of('POST', '/v1/streams')).toEqual([]); // not due yet
    expect((await countConversions(env.ctx))!.map((e) => [e.kind, e.key])).toEqual([['record', `resv:${hafen}`]]);
    expect(await admitConversion(env.ctx, { kind: 'live', userId: BEN, hint: 'live:x', label: 'x' })).toEqual({ ok: false, why: 'full' });
    expect(await admitConversion(env.ctx, { kind: 'film', userId: BEN, deviceId: 'd1', hint: 'f1' })).toEqual({ ok: false, why: 'full' });
    // the recording itself is admitted: its own reservation is left out
    const own = await admitConversion(env.ctx, { kind: 'record', userId: ANNA, hint: `live:${hafen}`, exceptResv: hafen });
    expect(own).toEqual({ ok: true });
    await dropConvGrant(env.ctx, `live:${hafen}`);
    // a passthrough channel reserves nothing
    await recording({ channel_id: nordlicht, start_at: new Date(start), end_at: new Date(start + HOUR) });
    await tick();
    expect((await countConversions(env.ctx))!.map((e) => e.key)).toEqual([`resv:${hafen}`]);
  });

  it('a refused start retries every 60 s and ends no_slot', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    streams.set(sternwarte, view(sternwarte, { mode: 'transcode' })); // somebody watches a transcode: the one slot is taken
    const start = Date.now() + MIN;
    const id = await recording({ channel_id: hafen, channel_name: 'Hafenkanal', start_at: new Date(start), end_at: new Date(start + 20 * MIN), pad_after_s: 0 });
    await tick();
    expect(of('POST', '/v1/streams')).toEqual([]);
    expect(await env.kv.get(`ltv:recretry:${id}`)).toBe('1');
    await tick(); // within the 60 s: not asked again
    expect((await listEvents(env.ctx)).filter((e) => e.code === 'rec_no_slot').map((e) => e.recordingId)).toEqual([id]);
    await env.kv.del(`ltv:recretry:${id}`); // a minute later
    await tick();
    expect((await listEvents(env.ctx)).filter((e) => e.code === 'rec_no_slot')).toHaveLength(1); // the event once
    expect((await getRecording(env.ctx, id))!.state).toBe('scheduled');
    // past its end: failed no_slot, the owner is told
    await tick(start + 21 * MIN);
    const r = await getRecording(env.ctx, id);
    expect([r!.state, r!.error]).toEqual(['failed', 'no_slot']);
    expect(await notices('livetv.rec.failed')).toEqual([{ user_id: ANNA, title: 'Aufnahme fehlgeschlagen: Sternstunde Physik (kein Platz frei)' }]);
  });

  it('a slot that frees up later starts the recording late: the delay is a gap and it ends partial', async () => {
    const start = Date.now() - 10 * MIN; // started ten minutes ago, but the backend was not there
    const id = await recording({ start_at: new Date(start), end_at: new Date(start + HOUR) });
    await tick();
    const r = await getRecording(env.ctx, id);
    expect(r!.state).toBe('recording');
    expect(r!.gaps).toHaveLength(1);
    expect(r!.gaps[0]!.from).toBe(start);
    recorders.get(id)!.state = 'done';
    recorders.get(id)!.bytes = 1000;
    await tick();
    expect((await getRecording(env.ctx, id))!.state).toBe('partial');
  });

  it('livetv restart resumes recording rows into the same dir', async () => {
    const id = await recording({ state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 10 * MIN), end_at: new Date(Date.now() + HOUR) });
    const dir = (await getRecording(env.ctx, id))!.dir;
    // livetv restarted: no stream, no recorder
    await tick();
    expect(of('POST', '/v1/streams')).toHaveLength(1);
    expect(of('POST', '/v1/recordings').map((c) => [c.body.id, c.body.dir])).toEqual([[id, dir]]);
    expect((await getRecording(env.ctx, id))!.state).toBe('recording');
    // its gaps survive the restart: the earlier ones are kept in the row
    recorders.get(id)!.gaps = [{ from: 1, to: 2 }];
    await tick();
    recorders.set(id, rec(id, nordlicht, { gaps: [{ from: 3, to: 4 }] }));
    await tick();
    expect((await getRecording(env.ctx, id))!.gaps).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }]);
  });

  it('backend restart: the tick adopts running recorders and starts nothing twice', async () => {
    const a = await recording({ state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 10 * MIN), end_at: new Date(Date.now() + HOUR) });
    const b = await recording({ profile_id: BEN, user_id: BEN, state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 10 * MIN), end_at: new Date(Date.now() + HOUR) });
    streams.set(nordlicht, view(nordlicht));
    recorders.set(a, rec(a, nordlicht, { bytes: 500, durationS: 600 }));
    recorders.set(b, rec(b, nordlicht));
    await tick();
    await tick();
    expect(of('POST', '/v1/streams')).toEqual([]);
    expect(of('POST', '/v1/recordings')).toEqual([]);
    const r = await getRecording(env.ctx, a);
    expect([r!.state, r!.bytes, r!.duration_s]).toEqual(['recording', '500', 600]);
    // its end passes: the recorder ends itself; the tick collects it, notices once, and leaves no orphan
    recorders.get(a)!.state = 'done';
    await tick();
    expect((await getRecording(env.ctx, a))!.state).toBe('done');
    expect((await listEvents(env.ctx)).filter((e) => e.code === 'rec_done').map((e) => e.recordingId)).toEqual([a]);
    expect(await notices('livetv.rec.failed')).toEqual([]);
  });

  it('due stops: a recorder running past its end is stopped', async () => {
    const id = await recording({ state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 2 * HOUR), end_at: new Date(Date.now() - HOUR), pad_after_s: 60 });
    streams.set(nordlicht, view(nordlicht));
    recorders.set(id, rec(id, nordlicht, { bytes: 10 }));
    await tick();
    expect(of('DELETE', `/v1/recordings/${id}`)).toHaveLength(1);
    await tick();
    expect((await getRecording(env.ctx, id))!.state).toBe('done');
  });

  it('storage_full from livetv ends partial and notifies owner and admins once', async () => {
    const rid = await rule({ channel_id: nordlicht, series_key: 'sternstunde physik', title: 'Sternstunde Physik' });
    const id = await recording({ rule_id: rid, state: 'recording', mode: 'passthrough', start_at: new Date(Date.now() - 10 * MIN), end_at: new Date(Date.now() + HOUR) });
    streams.set(nordlicht, view(nordlicht));
    recorders.set(id, rec(id, nordlicht, { state: 'failed', error: 'storage_full', bytes: 4096, durationS: 300 }));
    await tick();
    await tick();
    const r = await getRecording(env.ctx, id);
    expect([r!.state, r!.error, r!.bytes]).toEqual(['partial', 'storage_full', '4096']);
    expect(await notices('livetv.rec.failed')).toEqual([{ user_id: ANNA, title: 'Aufnahme fehlgeschlagen: Sternstunde Physik (Speicher voll)' }]);
    const admins = await notices('livetv.rec.storage');
    expect(admins).toEqual([{ user_id: adminId, title: 'Aufnahmespeicher voll: eine Aufnahme wurde beendet' }]);
    expect(JSON.stringify(admins)).not.toContain('Sternstunde');
    expect(await notices('livetv.rec.episode')).toEqual([{ user_id: ANNA, title: 'Neue Folge aufgenommen: Sternstunde Physik – Sternstunde Physik' }]);
    expect((await listEvents(env.ctx)).map((e) => e.code)).toEqual(expect.arrayContaining(['rec_partial', 'rec_storage_full']));
    // the stream is free: no recording uses the channel any more
    invalidateRecordingUses();
    const { recordingUses } = await import('../src/livetv/streams.js');
    expect(await recordingUses(env.ctx, nordlicht)).toBe(false);
  });

  it('a new recording fails storage_full while less than 2 GiB are free, or over the limit with nothing deletable', async () => {
    free = 1024 ** 3;
    const a = await recording({});
    await tick();
    expect([(await getRecording(env.ctx, a))!.state, (await getRecording(env.ctx, a))!.error]).toEqual(['failed', 'storage_full']);
    free = 100 * 1024 ** 3;
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_LIMIT_GB: 1 };
    await recording({ state: 'done', keep: true, bytes: 2_000_000_000, start_at: new Date(Date.now() - 48 * HOUR), end_at: new Date(Date.now() - 47 * HOUR) });
    const b = await recording({ channel_id: sternwarte, channel_name: 'Sternwarte 24' });
    await tick();
    expect((await getRecording(env.ctx, b))!.error).toBe('storage_full');
    expect(of('POST', '/v1/streams')).toEqual([]);
    expect(await notices('livetv.rec.storage')).toHaveLength(2);
  });

  it('owner without liveRecord at start: cancelled forbidden', async () => {
    const id = await recording({ profile_id: GUEST, user_id: GUEST });
    await tick();
    const r = await getRecording(env.ctx, id);
    expect([r!.state, r!.error]).toEqual(['cancelled', 'forbidden']);
    expect(of('POST', '/v1/streams')).toEqual([]);
  });

  it('livetv disabled: scheduled recordings fail livetv_off, owners notified once', async () => {
    up = false;
    await detectLivetv(env.ctx, 0, { strict: true });
    const a = await recording({});
    const b = await recording({ profile_id: BEN, user_id: BEN, title: 'Die Leuchtturmwärter' });
    const later = await recording({ start_at: new Date(Date.now() + 2 * HOUR), end_at: new Date(Date.now() + 3 * HOUR) });
    await tick();
    await tick();
    expect((await rows()).map((r) => [r.id, r.state, r.error])).toEqual(expect.arrayContaining([[a, 'failed', 'livetv_off'], [b, 'failed', 'livetv_off'], [later, 'scheduled', null]]));
    expect((await notices('livetv.rec.failed')).map((n) => [n.user_id, n.title]).sort()).toEqual([
      [ANNA, 'Aufnahme fehlgeschlagen: Sternstunde Physik (Live-TV ist aus)'],
      [BEN, 'Aufnahme fehlgeschlagen: Die Leuchtturmwärter (Live-TV ist aus)'],
    ]);
    expect(calls.filter((c) => c.path.startsWith('/v1/'))).toEqual([]);
  });

  it('no request to livetv or any answer carries a title; stream URLs stay in the start call', async () => {
    const id = await recording({});
    await tick();
    for (const c of calls.filter((x) => x.path.startsWith('/v1/recordings'))) expect(JSON.stringify(c.body ?? {})).not.toMatch(/Sternstunde|iptv\.example\.com/);
    expect((await getRecording(env.ctx, id))!.state).toBe('recording');
    expect(JSON.stringify(await listEvents(env.ctx))).not.toMatch(/Sternstunde|iptv/);
  });
});
