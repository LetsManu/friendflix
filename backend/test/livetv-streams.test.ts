// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 31: start, join and stop of the shared streams (spec §7.4), `livetvTick`, the `live` source of the conversion
 * budget (F8) and the watch routes (spec §7.2, F11). livetv is a fake (`ctx.fetchImpl`): it records every POST / DELETE of
 * `/v1/streams` and lists what it runs.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/cast.js';
import { __resetConvMemo, admitConversion, countConversions } from '../src/convbudget.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { setLive } from '../src/live.js';
import { toEffective, CHANNEL_SELECT, type EffectiveRow, type ProbeRec } from '../src/livetv/channels.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { resolveEncoder } from '../src/livetv/encoder.js';
import { listEvents } from '../src/livetv/events.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import {
  expectedMode, invalidateLiveConversions, liveConversions, livetvTick, startOrJoin, streamKeyFor, viewerCounts,
} from '../src/livetv/streams.js';
import { liveViewKey } from '../src/livetv/tokens.js';
import type { Encoder, StreamView } from '../src/livetv/wire.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const key = keyFromBase64(ENC_KEY);
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
const ORIGIN = 'https://portal.example.com';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const LOGO = 'c'.repeat(64);

let env: TestEnv;
let admin: Sess;
let anna: Sess;
let ben: Sess;
let annaId = '';
let benId = '';

// ---- the fake livetv ----
const calls: Call[] = [];
const streams = new Map<string, StreamView>();
let posts: Array<Record<string, unknown>> = [];
let dels: string[] = [];
/** what a POST does: list the stream at once (with a first segment, or without) or not list it at all */
let onPost: 'segment' | 'starting' | 'unlisted' = 'segment';
/** the mode livetv reports after its own probe (undefined = the mode the backend asked for) */
let reportMode: StreamView['mode'] | undefined;
let ingest: Array<Record<string, unknown>> = [];
let ingestPuts = 0;
let bootId = '0123456789abcdef';
let keyN = 0;
const hexKey = () => (++keyN).toString(16).padStart(32, '0');

const view = (channelId: string, o: Partial<StreamView> = {}): StreamView => ({
  channelId, streamKey: hexKey(), mode: 'remux', since: Date.now(), state: 'running', bitrate: 4_000_000, errors: [], lastSegmentAt: Date.now(), segments: 'ts', ...o,
});
const system = () => ({
  cpu: { model: 'Testprozessor', cores: 4, loadPct: 10 }, gpu: { devices: ['/dev/dri/renderD128'], driver: 'iHD', readable: true, busyPct: null },
  encoders: ['h264_qsv', 'h264_vaapi', 'libx264'], cache: { usedBytes: 0, maxBytes: 6_000_000_000 }, recordings: null, srt: { ports: [9000, 9001] },
});
const streamCalls = (method: string) => calls.filter((c) => c.method === method && c.path === '/v1/streams');

function fakeLivetv() {
  env.ctx.fetchImpl = fakeHttp({
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '3.3.0', bootId } }),
    'GET /v1/system': () => ({ json: system() }),
    'GET /v1/streams': () => ({ json: [...streams.values()] }),
    'POST /v1/streams': (_u, _i, b: Record<string, unknown>) => {
      posts.push(b);
      const id = String(b.channelId);
      const had = streams.get(id);
      if (had && had.state !== 'failed') return { json: { streamKey: had.streamKey, state: had.state } };
      const v = view(id, { mode: reportMode ?? (b.mode as StreamView['mode']), state: onPost === 'segment' ? 'running' : 'starting', lastSegmentAt: onPost === 'segment' ? Date.now() : null });
      if (onPost !== 'unlisted') streams.set(id, v);
      return { json: { streamKey: v.streamKey, state: v.state } };
    },
    'DELETE /v1/streams/[\\w-]+': (u) => { const id = u.pathname.split('/').pop()!; dels.push(id); streams.delete(id); return { status: 204 }; },
    'GET /v1/ingest': () => ({ json: ingest }),
    'PUT /v1/ingest': () => { ingestPuts++; return { json: { ok: true, listening: [9000] } }; },
  }, calls);
}

// ---- data ----
let src = '';
let news = '';
let hidden = '';

async function addSource(o: { maxStreams?: number; kind?: 'm3u' | 'manual' } = {}): Promise<string> {
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_sources(id, kind, name, url_enc, max_streams) values (gen_random_uuid(), $1, 'Anbieter A', $2, $3) returning id`,
    [o.kind ?? 'm3u', o.kind === 'manual' ? null : encrypt(key, 'https://iptv.example.com/get.php?username=anna&password=geheim'), o.maxStreams ?? null])).rows[0]!.id;
}
async function addChannel(name: string, o: { source?: string; kind?: 'hls' | 'ts' | 'srt'; group?: string | null; number?: number; probe?: ProbeRec; push?: number; logo?: string } = {}): Promise<string> {
  const kind = o.kind ?? 'hls';
  const url = kind === 'srt' ? 'srt://192.0.2.10:9000?streamid=geheim' : `https://iptv.example.com/live/anna/geheim/${encodeURIComponent(name)}.${kind === 'hls' ? 'm3u8' : 'ts'}`;
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, import_number, group_override, probe, ingest, push_port,
       push_stream_id_enc, push_passphrase_enc, logo_override_hash)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [o.source ?? src, `k-${name}`, o.push ? null : encrypt(key, url), o.push ? 'srt' : kind, name, o.number ?? null, o.group === undefined ? news : o.group,
      o.probe ? JSON.stringify(o.probe) : null, o.push ? 'push' : 'pull', o.push ?? null,
      o.push ? encrypt(key, 'ff-ABCDEFGHIJKLMNOP') : null, o.push ? encrypt(key, 'passphrase-geheim-1234567890abcd') : null, o.logo ?? null])).rows[0]!.id;
}
const effective = async (id: string) => toEffective((await env.pool.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = $1`, [id])).rows[0]!);

let addr = 0;
const call = (s: Sess, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${(++addr % 200) + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });
const watch = (s: Sess, id: string, body: Record<string, unknown> = {}) => call(s, 'POST', `/api/livetv/channels/${id}/watch`, body);
const authz = (token: string, ip = '192.0.2.250') => env.app.inject({ method: 'POST', url: '/internal/authz/live', headers: H, payload: { token, ip } });

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** drives a promise that waits on (faked) timers: 500-ms steps of the fake clock, with real I/O turns in between */
async function drive<T>(p: Promise<T>, stepMs = 500, max = 200): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < max && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
    for (let j = 0; j < 5 && !done; j++) await new Promise((r) => setImmediate(r));
  }
  return p;
}

async function person(id: string, sub: string, name: string, role: string): Promise<Sess> {
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, sub, `${sub}@friend.example.com`, name, role, id.replace(/-/g, '').slice(0, 32), encrypt(key, 'pw')]);
  const s = await env.login({ sub, email: `${sub}@friend.example.com`, name, groups: [] });
  await env.pool.query('update devices set approved = true where user_id = $1', [id]);
  return s;
}

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  annaId = '0d000000-0000-4000-a000-0000000000a1';
  benId = '0d000000-0000-4000-a000-0000000000b1';
  anna = await person(annaId, 'anna', 'Anna Beispiel', 'family');
  ben = await person(benId, 'ben', 'Ben Muster', 'friend');
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  __resetConvMemo();
  await env.pool.query('delete from livetv_channels; delete from livetv_group_roles; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from livetv_logos');
  for (const p of ['ltv', 'conv:', 'play:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  streams.clear();
  posts = []; dels = []; calls.length = 0; ingest = []; ingestPuts = 0;
  onPost = 'segment'; reportMode = undefined; bootId = '0123456789abcdef';
  fakeLivetv();
  await detectLivetv(env.ctx, 0);
  invalidateLiveConversions();
  src = await addSource();
  news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), 'Nachrichten', true, 0) returning id")).rows[0]!.id;
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family'), ($1, 'friend')", [news]);
  hidden = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), 'Nur Admins', true, 1) returning id")).rows[0]!.id;
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
});
afterEach(() => { vi.useRealTimers(); });

describe('pure rules', () => {
  it('resolveEncoder table (spec §5.4)', () => {
    const sys = (encoders: Encoder[], readable: boolean) => ({ encoders, gpu: { readable } });
    const all = sys(['h264_qsv', 'h264_vaapi', 'h264_nvenc', 'libx264'], true);
    // auto: the media server's hardware when livetv can use it
    expect(resolveEncoder('auto', 'qsv', all)).toBe('h264_qsv');
    expect(resolveEncoder('auto', 'vaapi', all)).toBe('h264_vaapi');
    expect(resolveEncoder('auto', 'nvenc', all)).toBe('h264_nvenc');
    // ... else VA-API when /dev/dri is usable
    expect(resolveEncoder('auto', 'none', all)).toBe('h264_vaapi');
    expect(resolveEncoder('auto', null, all)).toBe('h264_vaapi');
    expect(resolveEncoder('auto', 'amf', all)).toBe('h264_vaapi');
    expect(resolveEncoder('auto', 'qsv', sys(['h264_qsv', 'h264_vaapi', 'h264_nvenc', 'libx264'], false))).toBe('h264_nvenc'); // no readable device
    // ... else NVENC when present, else software
    expect(resolveEncoder('auto', null, sys(['h264_qsv', 'h264_vaapi', 'libx264'], false))).toBe('libx264');
    expect(resolveEncoder('auto', 'nvenc', sys(['libx264'], false))).toBe('libx264');
    // an explicit choice that is not available -> libx264
    expect(resolveEncoder('qsv', null, all)).toBe('h264_qsv');
    expect(resolveEncoder('qsv', 'qsv', sys(['h264_qsv', 'libx264'], false))).toBe('libx264');
    expect(resolveEncoder('vaapi', 'qsv', all)).toBe('h264_vaapi');
    expect(resolveEncoder('nvenc', 'nvenc', sys(['h264_qsv', 'libx264'], true))).toBe('libx264');
    expect(resolveEncoder('software', 'qsv', all)).toBe('libx264');
  });

  it('expectedMode: hls passthrough, ts by its probe, srt by a fresh probe else transcode', () => {
    const now = Date.parse('2026-11-12T20:00:00Z');
    const probe = (needs: ProbeRec['needs'], hoursAgo: number, ok = true): ProbeRec => ({ at: new Date(now - hoursAgo * 3_600_000).toISOString(), ok, needs });
    expect(expectedMode({ streamKind: 'hls', probe: null }, now)).toBe('passthrough');
    expect(expectedMode({ streamKind: 'hls', probe: probe('transcode', 1) }, now)).toBe('passthrough');
    expect(expectedMode({ streamKind: 'ts', probe: null }, now)).toBe('remux');
    expect(expectedMode({ streamKind: 'ts', probe: probe('transcode', 100) }, now)).toBe('transcode');
    expect(expectedMode({ streamKind: 'srt', probe: null }, now)).toBe('transcode');
    expect(expectedMode({ streamKind: 'srt', probe: probe('remux', 23) }, now)).toBe('remux');
    expect(expectedMode({ streamKind: 'srt', probe: probe('remux', 25) }, now)).toBe('transcode'); // ruling 29: older than 24 h
    expect(expectedMode({ streamKind: 'srt', probe: probe(null, 1, false) }, now)).toBe('transcode');
  });
});

describe('start and join', () => {
  it('concurrent first viewers start one stream and take one slot (Review Focus 1)', async () => {
    const ch = await addChannel('Hafenkanal', { kind: 'srt' }); // SRT without a fresh probe: expected transcode
    const [a, b] = await Promise.all([watch(admin, ch), watch(anna, ch)]);
    expect([a.statusCode, b.statusCode], `${a.body} ${b.body}`).toEqual([200, 200]);
    expect(streamCalls('POST')).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channelId: ch, mode: 'transcode', input: { url: 'srt://192.0.2.10:9000?streamid=geheim', kind: 'srt', allowLan: false } });
    expect((await env.kv.keys('conv:grant:')).filter((k) => k.includes(ch))).toEqual([`conv:grant:live:${ch}`]);
    expect(a.json().token).not.toBe(b.json().token);
    const ka = (await authz(a.json().token, '192.0.2.201')).json();
    const kb = (await authz(b.json().token, '192.0.2.202')).json();
    expect(ka.streamKey).toMatch(/^[0-9a-f]{32}$/);
    expect(ka.streamKey).toBe(kb.streamKey);
    expect(a.json()).toMatchObject({ url: `/media/l/${a.json().token}/index.m3u8`, mode: 'transcode', dvrSeconds: 1800, channel: { id: ch, name: 'Hafenkanal', logo: null }, now: null, next: null });
    expect(a.headers['cache-control']).toBe('no-store');
    // the conversion counts once: the bound grant and livetv's listing share the key live:<id> (F8)
    invalidateLiveConversions();
    expect((await countConversions(env.ctx))?.filter((e) => e.kind === 'live').map((e) => e.key)).toEqual([`live:${ch}`]);
  });

  it('a join never touches the budget', async () => {
    const ch = await addChannel('Hafenkanal', { kind: 'srt' });
    streams.set(ch, view(ch, { mode: 'transcode' }));
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    // the running live transcode already fills a budget of 1: nothing new converts
    expect(await admitConversion(env.ctx, { kind: 'film', userId: benId, hint: 'film-dunmoor', label: 'Dunmoor' })).toEqual({ ok: false, why: 'full' });
    const r = await watch(anna, ch);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().mode).toBe('transcode');
    expect(streamCalls('POST')).toHaveLength(0);
    expect(await env.kv.get(`conv:grant:live:${ch}`)).toBeNull();
  });

  it('the watch answer passes on the segment format livetv reports; TS when it does not say (bughunt M2)', async () => {
    const cmaf = await addChannel('Nordlicht TV');
    const ts = await addChannel('Hafenkanal');
    const old = await addChannel('Sternwarte 24');
    streams.set(cmaf, view(cmaf, { mode: 'passthrough', segments: 'fmp4' }));
    streams.set(ts, view(ts, { segments: 'ts' }));
    const { segments: _gone, ...noField } = view(old); // a livetv from before the field
    streams.set(old, noField as StreamView);
    expect((await watch(anna, cmaf)).json()).toMatchObject({ mode: 'passthrough', segments: 'fmp4' });
    expect((await watch(anna, ts)).json()).toMatchObject({ segments: 'ts' });
    expect((await watch(anna, old)).json()).toMatchObject({ segments: 'ts' });
    // a garbled value is not passed on
    streams.set(cmaf, { ...view(cmaf), segments: 'mp4' as never });
    expect((await watch(anna, cmaf)).json()).toMatchObject({ segments: 'ts' });
  });

  it('full budget → live_full with only channels this profile may see', async () => {
    const nord = await addChannel('Nordlicht TV', { number: 1, logo: LOGO });
    const admins = await addChannel('Sternwarte 24', { number: 2, group: hidden }); // running, but not for Anna
    const ch = await addChannel('Hafenkanal', { kind: 'srt', number: 3 });
    streams.set(nord, view(nord, { mode: 'transcode' }));
    streams.set(admins, view(admins, { mode: 'remux' }));
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const r = await watch(anna, ch);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'live_full', running: [{ id: nord, number: 1, name: 'Nordlicht TV', logo: `/api/livetv/logos/${LOGO}` }] });
    expect(streamCalls('POST')).toHaveLength(0);
    expect(await env.kv.keys('conv:grant:')).toEqual([]);
    expect((await listEvents(env.ctx)).map((e) => [e.code, e.channelId])).toEqual([['start_refused_full', ch]]);
    // the admin's own profile sees both running channels
    const a = await watch(admin, ch);
    expect(a.json().running.map((x: { id: string }) => x.id).sort()).toEqual([nord, admins].sort());
  });

  it('a budget that did not answer is not a full budget: 502, no start_refused_full, no grant (review M2)', async () => {
    const ch = await addChannel('Hafenkanal', { kind: 'srt' });
    await env.kv.set('conv:gate', 'someone-else', 30); // the budget lock stays taken: admitConversion answers why 'unknown' after its wait
    const r = await watch(anna, ch);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'channel_unreachable' });
    expect(streamCalls('POST')).toHaveLength(0);
    expect(await env.kv.get(`conv:grant:live:${ch}`)).toBeNull();
    expect(await listEvents(env.ctx)).toEqual([]);
    await env.kv.del('conv:gate');
  });

  it('a start that lost its lock during a slow admission does not POST (review M3)', async () => {
    const id = await addChannel('Hafenkanal', { kind: 'srt' });
    const ch = await effective(id);
    const set = env.kv.set.bind(env.kv);
    const spy = vi.spyOn(env.kv, 'set').mockImplementation(async (k: string, v: string, ttl?: number) => {
      await set(k, v, ttl as number);
      if (k === `conv:grant:live:${id}`) await set(`ltv:start:${id}`, 'another-starter', 20); // the admission was slow: the lock lapsed and another starter has it
    });
    const r = await startOrJoin(env.ctx, { userId: annaId, deviceId: 'dev-anna-1', role: 'family' }, ch, { id: annaId, kids: false });
    expect(r).toEqual({ status: 502, error: 'channel_unreachable' });
    expect(streamCalls('POST')).toHaveLength(0);
    // the other starter admitted under the same per-channel key: its grant must stay counted
    expect(await env.kv.get(`conv:grant:live:${id}`)).not.toBeNull();
    spy.mockRestore();
    expect(await env.kv.get(`ltv:start:${id}`)).toBe('another-starter'); // never deleted by the one that lost it
  });

  it('a start whose lock lapsed with nobody else holding it gives its grant back (review M3)', async () => {
    const id = await addChannel('Hafenkanal', { kind: 'srt' });
    const ch = await effective(id);
    const set = env.kv.set.bind(env.kv);
    const spy = vi.spyOn(env.kv, 'set').mockImplementation(async (k: string, v: string, ttl?: number) => {
      await set(k, v, ttl as number);
      if (k === `conv:grant:live:${id}`) await env.kv.del(`ltv:start:${id}`); // the lock lapsed, nobody took it
    });
    const r = await startOrJoin(env.ctx, { userId: annaId, deviceId: 'dev-anna-1', role: 'family' }, ch, { id: annaId, kids: false });
    spy.mockRestore();
    expect(r).toEqual({ status: 502, error: 'channel_unreachable' });
    expect(streamCalls('POST')).toHaveLength(0);
    expect(await env.kv.get(`conv:grant:live:${id}`)).toBeNull();
  });

  it('remux after all releases the slot', async () => {
    const ch = await addChannel('Hafenkanal', { kind: 'srt' });
    reportMode = 'remux'; // livetv's probe at start: H.264 + AAC
    const r = await watch(anna, ch);
    expect(r.statusCode, r.body).toBe(200);
    expect(posts[0]!.mode).toBe('transcode');
    expect(r.json().mode).toBe('remux');
    expect(await env.kv.get(`conv:grant:live:${ch}`)).toBeNull();
    invalidateLiveConversions();
    expect(await countConversions(env.ctx)).toEqual([]);
  });

  it('no first segment within 15 s → 502 and the stream is stopped (fake clock)', async () => {
    const id = await addChannel('Hafenkanal', { kind: 'srt' });
    const ch = await effective(id);
    onPost = 'starting';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t0 = Date.now();
    const r = await drive(startOrJoin(env.ctx, { userId: annaId, deviceId: 'dev-anna-1', role: 'family' }, ch, { id: annaId, kids: false }));
    expect(r).toEqual({ status: 502, error: 'channel_unreachable' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15_000);
    expect(streamCalls('POST')).toHaveLength(1);
    expect(dels).toEqual([id]);
    expect(await env.kv.get(`conv:grant:live:${id}`)).toBeNull();
    expect(await env.kv.get(`ltv:start:${id}`)).toBeNull();
    expect((await listEvents(env.ctx)).map((e) => [e.code, e.channelId, e.reason])).toEqual([['start_failed', id, 'no_segment']]);
  });

  it('livetv refusing the start → 502 channel_unreachable, the slot is given back', async () => {
    const ch = await addChannel('Hafenkanal', { kind: 'srt' });
    const ok = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (init?.method === 'POST' && u.pathname === '/v1/streams') return new Response(JSON.stringify({ error: 'unsupported_mode' }), { status: 422 });
      return ok(input, init);
    }) as typeof fetch;
    const r = await watch(anna, ch);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'channel_unreachable' });
    expect(await env.kv.get(`conv:grant:live:${ch}`)).toBeNull();
    expect((await listEvents(env.ctx)).map((e) => [e.code, e.reason])).toEqual([['start_failed', 'unsupported_mode']]);
  });

  it('push feed not sending → 409 not_receiving', async () => {
    const feeds = await addSource({ kind: 'manual' });
    const ch = await addChannel('Kanal Wolkenlos', { source: feeds, push: 9000 });
    ingest = [{ channelId: ch, port: 9000, state: 'idle', since: null, bitrate: null, rejected1h: 0 }];
    const r = await watch(anna, ch);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'not_receiving' });
    expect(streamCalls('POST')).toHaveLength(0);
    // receiving: it starts, and the input is the feed, never a URL
    ingest = [{ channelId: ch, port: 9000, state: 'receiving', since: Date.now(), bitrate: 3_000_000, rejected1h: 0 }];
    const ok = await watch(anna, ch);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(posts[0]!.input).toEqual({ push: ch });
  });

  it('provider limit: max_streams 1 with one running → 503 provider_limit', async () => {
    const one = await addSource({ maxStreams: 1 });
    const a = await addChannel('Nordlicht TV', { source: one, number: 1 });
    const b = await addChannel('Hafenkanal', { source: one, number: 2 });
    const other = await addChannel('Bergblick Sport', { number: 3 }); // another source: no limit
    streams.set(a, view(a, { mode: 'passthrough' }));
    const r = await watch(anna, b);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'provider_limit', max: 1, running: [{ id: a, number: 1, name: 'Nordlicht TV', logo: null }] });
    expect(streamCalls('POST')).toHaveLength(0);
    expect((await watch(anna, other)).statusCode).toBe(200);
    // the running one itself is a join
    expect((await watch(anna, a)).statusCode).toBe(200);
  });

  it('max_streams: two film records → 429; the same device switching channel → 200 and its old token 410', async () => {
    const a = await addChannel('Nordlicht TV');
    const b = await addChannel('Hafenkanal');
    const film = (ps: string) => setLive(env.ctx, { userId: benId, userName: 'Ben Muster', itemId: 'a'.repeat(32), title: 'Dunmoor', positionTicks: 0, isPaused: false, playSessionId: ps, updatedAt: Date.now(), source: 'portal', deviceId: 'tv-elsewhere' });
    await film('ps-film-1');
    await film('ps-film-2');
    const r = await watch(ben, a);
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'max_streams', max: 2 });
    await env.kv.del(`play:${benId}:ps-film-2`);
    const first = await watch(ben, a);
    expect(first.statusCode, first.body).toBe(200);
    expect((await authz(first.json().token)).statusCode).toBe(200); // the first fetch writes the live record: 2 streams now
    expect((await env.kv.keys(`play:${benId}:`)).length).toBe(2);
    const second = await watch(ben, b); // the device's own live view is replaced, not counted
    expect(second.statusCode, second.body).toBe(200);
    expect((await authz(first.json().token)).statusCode).toBe(410);
    expect((await authz(second.json().token)).statusCode).toBe(200);
  });

  it('max_streams (review L1): tokens minted but not fetched yet count too, so minting first cannot get past the limit', async () => {
    const a = await addChannel('Nordlicht TV');
    const b = await addChannel('Hafenkanal');
    await setLive(env.ctx, { userId: benId, userName: 'Ben Muster', itemId: 'a'.repeat(32), title: 'Dunmoor', positionTicks: 0, isPaused: false, playSessionId: 'ps-film-1', updatedAt: Date.now(), source: 'portal', deviceId: 'tv-elsewhere' });
    const local = await watch(ben, a); // 1 film + 0 → allowed; nothing fetched yet
    expect(local.statusCode, local.body).toBe(200);
    // a cast is another slot (R14): the unfetched local token is a stream already, 1 film + 1 = 2 = maxStreams
    const cast = await watch(ben, b, { via: 'chromecast' });
    expect(cast.statusCode).toBe(429);
    expect(cast.json()).toEqual({ error: 'max_streams', max: 2 });
    // the same slot is a channel switch: the token it replaces is not counted
    const sw = await watch(ben, b);
    expect(sw.statusCode, sw.body).toBe(200);
    expect((await authz(local.json().token)).statusCode).toBe(410);
    // once fetched it counts through its live record, exactly once
    expect((await authz(sw.json().token)).statusCode).toBe(200);
    expect((await watch(ben, a, { via: 'chromecast' })).statusCode).toBe(429);
    await env.kv.del(`play:${benId}:ps-film-1`);
    expect((await watch(ben, a, { via: 'chromecast' })).statusCode).toBe(200);
  });

  it('403 without the right, 404 for livetv off, 400 for a bad body', async () => {
    const admins = await addChannel('Sternwarte 24', { group: hidden });
    expect((await watch(anna, admins)).json()).toEqual({ error: 'forbidden' });
    expect((await watch(anna, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(403);
    expect((await watch(anna, admins, { via: 'teleport' })).statusCode).toBe(400);
    expect((await watch(admin, admins)).statusCode).toBe(200);
    bootId = 'nope';
    await detectLivetv(env.ctx, 0, { strict: true }); // livetv gone (strict: no grace for one missed check, bughunt M1)
    expect((await watch(admin, admins)).json()).toEqual({ error: 'livetv_off' });
  });
});

describe('beat and stop watching', () => {
  it('beat slides the token, stop revokes it', async () => {
    const ch = await addChannel('Nordlicht TV');
    const w = (await watch(anna, ch)).json();
    const beat = await call(anna, 'POST', '/api/livetv/beat', { token: w.token });
    expect(beat.statusCode).toBe(200);
    expect(beat.json()).toEqual({ ok: true, expiresAt: w.expiresAt });
    // another account cannot use it
    expect((await call(ben, 'POST', '/api/livetv/beat', { token: w.token })).statusCode).toBe(410);
    expect((await call(ben, 'DELETE', '/api/livetv/watch', { token: w.token })).statusCode).toBe(204);
    expect((await call(anna, 'POST', '/api/livetv/beat', { token: w.token })).statusCode).toBe(200); // Ben's DELETE did nothing
    expect((await call(anna, 'DELETE', '/api/livetv/watch', { token: w.token })).statusCode).toBe(204);
    const gone = await call(anna, 'POST', '/api/livetv/beat', { token: w.token });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toEqual({ error: 'gone' });
    expect(await env.kv.get(liveViewKey(hashToken(w.token)))).toBeNull();
    expect((await call(anna, 'POST', '/api/livetv/beat', { token: 'x' })).statusCode).toBe(400);
  });
});

describe('livetvTick', () => {
  it('the tick stops 60 s after the last viewer', async () => {
    const ch = await addChannel('Nordlicht TV');
    const w = (await watch(anna, ch)).json();
    vi.useFakeTimers({ toFake: ['Date'] });
    await livetvTick(env.ctx);
    expect(dels).toEqual([]);
    expect(await env.kv.get(`ltv:zero:${ch}`)).toBeNull();
    expect((await viewerCounts(env.ctx)).get(ch)).toBe(1);
    expect((await viewerCounts(env.ctx, { exceptHash: hashToken(w.token) })).get(ch) ?? 0).toBe(0);
    await env.kv.del(liveViewKey(hashToken(w.token))); // the viewer left at t
    await livetvTick(env.ctx);
    vi.setSystemTime(Date.now() + 59_000);
    await livetvTick(env.ctx);
    expect(dels).toEqual([]);
    vi.setSystemTime(Date.now() + 2_000);
    await livetvTick(env.ctx);
    expect(dels).toEqual([ch]);
    expect(await env.kv.get(`ltv:zero:${ch}`)).toBeNull();
  });

  it('a join after the tick looked is not stopped under its viewer (review M1)', async () => {
    const ch = await effective(await addChannel('Nordlicht TV'));
    streams.set(ch.id, view(ch.id));
    await env.kv.set(`ltv:zero:${ch.id}`, String(Date.now() - 120_000), 3600); // idle for two minutes: due
    const r = await startOrJoin(env.ctx, { userId: annaId, deviceId: 'dev-anna-1', role: 'family' }, ch, { id: annaId, kids: false });
    expect('streamKey' in r).toBe(true); // joined; its token is not minted yet, so no viewer key
    await livetvTick(env.ctx);
    expect(dels).toEqual([]);
    expect(await env.kv.get(`ltv:zero:${ch.id}`)).toBeNull();
  });

  it('the tick lock lasts through a slow tick (review M5)', async () => {
    const ids = [await addChannel('A'), await addChannel('B'), await addChannel('C')];
    vi.useFakeTimers({ toFake: ['Date'] });
    const alive: boolean[] = [];
    const base = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        alive.push((await env.kv.get('ltv:tick')) !== null);
        vi.setSystemTime(Date.now() + 10_000); // each stop takes 10 s
      }
      return base(input, init);
    }) as typeof fetch;
    for (const id of ids) {
      streams.set(id, view(id));
      await env.kv.set(`ltv:zero:${id}`, String(Date.now() - 120_000), 3600);
    }
    await livetvTick(env.ctx);
    expect(dels).toHaveLength(3);
    expect(alive).toEqual([true, true, true]);
  });

  it('a viewer coming back clears the countdown; a stream nobody ever watched stops after 60 s too', async () => {
    const a = await addChannel('Nordlicht TV');
    const b = await addChannel('Hafenkanal');
    streams.set(b, view(b)); // running in livetv, but no viewer known to this backend (e.g. after a restart)
    const w = (await watch(anna, a)).json();
    vi.useFakeTimers({ toFake: ['Date'] });
    await env.kv.del(liveViewKey(hashToken(w.token)));
    await livetvTick(env.ctx);
    vi.setSystemTime(Date.now() + 30_000);
    expect((await call(anna, 'POST', '/api/livetv/beat', { token: w.token })).statusCode).toBe(200); // back
    await livetvTick(env.ctx);
    vi.setSystemTime(Date.now() + 31_000);
    await livetvTick(env.ctx);
    expect(dels).toEqual([b]);
  });

  it('bootId change re-syncs the ingest', async () => {
    await livetvTick(env.ctx); // the first look after install sends it
    const first = ingestPuts;
    expect(first).toBe(1);
    await livetvTick(env.ctx);
    expect(ingestPuts).toBe(first);
    bootId = 'fedcba9876543210';
    await detectLivetv(env.ctx, 0);
    await livetvTick(env.ctx);
    expect(ingestPuts).toBe(first + 1);
  });

  it('rejected push attempts → one push_rejected event per feed per 10 min; new stream errors → events', async () => {
    const feeds = await addSource({ kind: 'manual' });
    const feed = await addChannel('Kanal Wolkenlos', { source: feeds, push: 9000 });
    const ch = await addChannel('Nordlicht TV');
    ingest = [{ channelId: feed, port: 9000, state: 'idle', since: null, bitrate: null, rejected1h: 3 }];
    await watch(anna, ch);
    streams.get(ch)!.errors = [{ at: Date.now() - 5000, code: 'input_lost' }, { at: Date.now() - 1000, code: 'input_back', seconds: 4 }];
    vi.useFakeTimers({ toFake: ['Date'] });
    await livetvTick(env.ctx);
    await livetvTick(env.ctx);
    const codes = () => listEvents(env.ctx).then((l) => l.map((e) => `${e.code}:${e.channelId === feed ? 'feed' : 'ch'}:${e.n ?? ''}`).reverse());
    expect(await codes()).toEqual(['push_rejected:feed:3', 'input_lost:ch:', 'input_back:ch:4']);
    vi.setSystemTime(Date.now() + 601_000);
    streams.get(ch)!.errors.push({ at: Date.now(), code: 'input_lost' });
    await livetvTick(env.ctx);
    expect(await codes()).toEqual(['push_rejected:feed:3', 'input_lost:ch:', 'input_back:ch:4', 'push_rejected:feed:3', 'input_lost:ch:']);
  });
});

describe('the live budget source', () => {
  it('the budget counts live transcodes', async () => {
    const a = await addChannel('Nordlicht TV');
    const b = await addChannel('Hafenkanal');
    streams.set(a, view(a, { mode: 'transcode' }));
    streams.set(b, view(b, { mode: 'remux' }));
    expect(await liveConversions(env.ctx)).toEqual([{ kind: 'live', key: `live:${a}`, label: 'Nordlicht TV', since: streams.get(a)!.since, device: null, userId: null }]);
    expect(streamCalls('GET')).toHaveLength(1);
    await liveConversions(env.ctx);
    expect(streamCalls('GET')).toHaveLength(1); // cached 5 s
    invalidateLiveConversions();
    await liveConversions(env.ctx);
    expect(streamCalls('GET')).toHaveLength(2);
    expect((await countConversions(env.ctx))?.map((e) => e.key)).toEqual([`live:${a}`]);
  });

  it('a starting live stream counts once (F8)', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 2 };
    const id = await addChannel('Hafenkanal', { kind: 'srt' });
    onPost = 'unlisted';
    const p = startOrJoin(env.ctx, { userId: annaId, deviceId: 'dev-anna-1', role: 'family' }, await effective(id), { id: annaId, kids: false });
    for (let i = 0; i < 100 && posts.length === 0; i++) await realSleep(10);
    expect(posts).toHaveLength(1);
    // livetv does not list it yet: the bound grant counts, under the key livetv will list
    invalidateLiveConversions();
    expect(await countConversions(env.ctx)).toEqual([expect.objectContaining({ kind: 'live', key: `live:${id}`, pending: true })]);
    // livetv lists it as transcode while the grant is still alive: still exactly one entry
    streams.set(id, view(id, { mode: 'transcode', state: 'starting', lastSegmentAt: null }));
    invalidateLiveConversions();
    const both = await countConversions(env.ctx);
    expect(both).toHaveLength(1);
    expect(both![0]).toMatchObject({ kind: 'live', key: `live:${id}`, label: 'Hafenkanal' });
    expect(both![0]!.pending).toBeUndefined();
    streams.get(id)!.lastSegmentAt = Date.now();
    expect(await p).toEqual({ streamKey: streams.get(id)!.streamKey, mode: 'transcode', segments: 'ts' });
    expect(await env.kv.get(`conv:grant:live:${id}`)).not.toBeNull();
    // a film right after the start is admitted: no double count
    expect(await admitConversion(env.ctx, { kind: 'film', userId: benId, hint: 'film-dunmoor' })).toEqual({ ok: true });
  });

  it('a miss in streamKeyFor is remembered for 2 s (review M6)', async () => {
    const ch = await addChannel('Hafenkanal');
    expect(await streamKeyFor(env.ctx, ch)).toBeNull();
    const n = streamCalls('GET').length;
    expect(await streamKeyFor(env.ctx, ch)).toBeNull();
    expect(streamCalls('GET')).toHaveLength(n);
  });

  it('streamKeyFor answers only a running stream', async () => {
    const a = await addChannel('Nordlicht TV');
    expect(await streamKeyFor(env.ctx, a)).toBeNull();
    streams.set(a, view(a));
    expect(await streamKeyFor(env.ctx, a)).toBeNull(); // the miss is remembered for 2 s
    invalidateLiveConversions(); // what a start does
    expect(await streamKeyFor(env.ctx, a)).toBe(streams.get(a)!.streamKey); // not listed in the cache: asked again
    streams.get(a)!.state = 'failed';
    invalidateLiveConversions();
    expect(await streamKeyFor(env.ctx, a)).toBeNull();
  });
});

describe('logos and settings', () => {
  it('a chromecast watch carries a signed absolute logo URL (F11)', async () => {
    await env.pool.query("insert into livetv_logos(hash, mime, bytes) values ($1, 'image/png', $2)", [LOGO, PNG]);
    const ch = await addChannel('Nordlicht TV', { logo: LOGO });
    const cast = await watch(anna, ch, { via: 'chromecast' });
    expect(cast.statusCode, cast.body).toBe(200);
    const logo = cast.json().channel.logo as string;
    expect(logo.startsWith(`${ORIGIN}/api/livetv/logos/${LOGO}?`)).toBe(true);
    const u = new URL(logo);
    expect(u.searchParams.get('exp')).toMatch(/^\d+$/);
    expect(u.searchParams.get('sig')).toMatch(/^[\w-]{20,}$/);
    // no cookie: the signature is the credential
    const img = await env.app.inject({ url: u.pathname + u.search });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(img.rawPayload, PNG)).toBe(0);
    const bad = new URL(logo);
    bad.searchParams.set('sig', 'A'.repeat(43));
    expect((await env.app.inject({ url: bad.pathname + bad.search })).statusCode).toBe(403);
    expect((await env.app.inject({ url: `/api/livetv/logos/${LOGO}?exp=${u.searchParams.get('exp')}` })).statusCode).toBe(403);
    expect((await env.app.inject({ url: `/api/livetv/logos/${LOGO}` })).statusCode).toBe(401); // the cookie route is unchanged
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Number(u.searchParams.get('exp')) + 1);
    expect((await env.app.inject({ url: u.pathname + u.search })).statusCode).toBe(403);
    vi.useRealTimers();
    const local = await watch(anna, ch, { via: 'local' });
    expect(local.json().channel.logo).toBe(`/api/livetv/logos/${LOGO}`);
    expect((await watch(anna, ch)).json().channel.logo).toBe(`/api/livetv/logos/${LOGO}`);
  });

  it('the DVR setting reaches livetv', async () => {
    const put = (v: number) => call(admin, 'PUT', '/api/admin/settings', { values: { LIVETV_DVR_MINUTES: v } });
    expect((await put(120)).statusCode).toBe(200);
    try {
      const ch = await addChannel('Nordlicht TV');
      const r = await watch(anna, ch);
      expect(r.json().dvrSeconds).toBe(7200);
      expect(posts[0]).toMatchObject({ dvrSeconds: 7200, maxBitrate: 10_000_000, encoder: expect.any(String) });
      expect((await put(121)).statusCode).toBe(400);
    } finally {
      await put(30);
    }
  });
});

describe('module graph (review I1)', () => {
  it('convbudget imports nothing of livetv; livetv/tokens.ts loads first in a fresh graph', async () => {
    expect(readFileSync(new URL('../src/convbudget.ts', import.meta.url), 'utf8')).not.toMatch(/from '\.\/livetv\//);
    vi.resetModules();
    await expect(import('../src/livetv/tokens.js')).resolves.toHaveProperty('liveViewKey');
    vi.resetModules();
    await expect(import('../src/livetv/streams.js')).resolves.toHaveProperty('livetvTick');
  });
});

describe('wire.ts (F4)', () => {
  it('StartBody is the declaration of livetv/src/streams.ts; BenchAnswer has the fields livetv answers', () => {
    const ours = readFileSync(new URL('../src/livetv/wire.ts', import.meta.url), 'utf8');
    const theirs = readFileSync(new URL('../../livetv/src/streams.ts', import.meta.url), 'utf8');
    const bench = readFileSync(new URL('../../livetv/src/routes/benchmark.ts', import.meta.url), 'utf8');
    const line = (src: string, from: string) => { const i = src.indexOf(from); expect(i, from).toBeGreaterThanOrEqual(0); return src.slice(i, src.indexOf('\n', i)).replace(/\s+/g, ' ').trim(); };
    expect(line(ours, 'export interface StartBody')).toBe(line(theirs, 'export interface StartBody'));
    expect(line(ours, 'export interface BenchAnswer')).toBe('export interface BenchAnswer { speed: number; encoder: Encoder; seconds: number }');
    expect(bench).toMatch(/json: \{ speed: [^,]+, encoder: enc, seconds: [^}]+\}/);
  });
});
