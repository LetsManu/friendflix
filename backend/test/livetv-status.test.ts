// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 26: `GET /api/admin/livetv/status` and `POST /api/admin/livetv/streams/:channelId/stop` (spec §9.5, §10).
 * Streams and ingest come from livetv (`GET /v1/streams`, `GET /v1/ingest`); a 404 from either means "none yet" (ruling 24). Nothing in
 * the answer is a URL, a stream key or a stream id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { pushEvent } from '../src/livetv/events.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);

let addr = 0;
const call = (method: 'GET' | 'POST', url: string, payload?: unknown, s: Sess = admin) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });

const calls: Call[] = [];
let streams: Handler;
let ingest: Handler;
let del: Handler;
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const system = () => ({
  cpu: { model: 'Testprozessor', cores: 4, loadPct: 17 }, gpu: { devices: ['/dev/dri/renderD128'], driver: 'iHD', readable: true, busyPct: 42 }, encoders: ['h264_qsv', 'libx264'],
  cache: { usedBytes: 3_100_000_000, maxBytes: 6_000_000_000 }, recordings: null, srt: { ports: [9000, 9001] },
});

async function channel(name: string, opts: { kind?: 'm3u' | 'manual'; ingest?: 'pull' | 'push'; port?: number } = {}): Promise<string> {
  const src = (await env.pool.query(`insert into livetv_sources(id, kind, name, url_enc) values (gen_random_uuid(), $1, 'Anbieter A', $2) returning id`, [opts.kind ?? 'm3u', (opts.kind ?? 'm3u') === 'm3u' ? encrypt(key, 'https://iptv.example.com/get.php?username=anna&password=geheim') : null])).rows[0].id;
  const push = opts.ingest === 'push';
  return (await env.pool.query(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, import_number, ingest, push_port, push_stream_id_enc, push_passphrase_enc)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 7, $6, $7, $8, $9) returning id`,
    [src, `k-${name}`, push ? null : encrypt(key, 'https://iptv.example.com/live/secret-token/1.m3u8'), push ? 'srt' : 'hls', name, opts.ingest ?? 'pull', opts.port ?? null,
      push ? encrypt(key, 'ff-ABCDEFGHIJKLMNOP') : null, push ? encrypt(key, 'passphrase-geheim-1234567890abcd') : null])).rows[0].id;
}

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from livetv_channels; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from audit_log');
  await env.kv.del('ltv:events');
  calls.length = 0;
  streams = () => ({ status: 404 });
  ingest = () => ({ status: 404 });
  del = () => ({ status: 204 });
  env.ctx.fetchImpl = fakeHttp({
    'GET /v1/system': () => ({ json: system() }),
    'GET /v1/streams': (...a) => streams(...a),
    'GET /v1/ingest': (...a) => ingest(...a),
    'DELETE /v1/streams/[0-9a-f-]+': (...a) => del(...a),
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '3.3.0', bootId: '0123456789abcdef' } }),
  }, calls);
  await detectLivetv(env.ctx, 0);
});

describe('GET /api/admin/livetv/status', () => {
  it('status tolerates a livetv without stream endpoints', async () => {
    const r = await call('GET', '/api/admin/livetv/status');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const b = r.json();
    expect(b.streams).toEqual([]);
    expect(b.ingest).toEqual([]);
    expect(b.version).toBe('3.3.0');
    expect(b.budget).toMatchObject({ limit: expect.any(Number), used: 0 });
    expect(b.system).toEqual({ cpuPct: 17, gpuPct: 42, cache: { usedBytes: 3_100_000_000, maxBytes: 6_000_000_000 } });
    expect(b.events).toEqual([]);
    expect(b.gpu).toHaveProperty('advice');
  });

  it('livetv not answering gives empty lists, not an error', async () => {
    streams = () => ({ status: 500 });
    ingest = () => ({ status: 500 });
    const r = await call('GET', '/api/admin/livetv/status');
    expect(r.statusCode).toBe(200);
    expect([r.json().streams, r.json().ingest]).toEqual([[], []]);
  });

  it('lists the running streams with the channel name, mode, input state and the number of lost inputs', async () => {
    const a = await channel('Nordlicht TV');
    const b = await channel('Hafenkanal');
    streams = () => ({ json: [
      { channelId: a, streamKey: KEY, mode: 'remux', since: 1_700_000_000_000, state: 'running', bitrate: 4_200_000, errors: [{ at: 1, code: 'input_lost' }, { at: 2, code: 'input_back', seconds: 4 }, { at: 3, code: 'input_lost' }], lastSegmentAt: 1_700_000_100_000 },
      { channelId: b, streamKey: KEY.replace(/a/g, 'b'), mode: 'passthrough', since: 1_700_000_050_000, state: 'reconnecting', bitrate: null, errors: [], lastSegmentAt: null },
      { channelId: '00000000-0000-4000-8000-000000000000', streamKey: KEY, mode: 'passthrough', since: 1, state: 'failed', bitrate: null, errors: [], lastSegmentAt: null },
      { channelId: 7, streamKey: KEY, mode: 'nope', since: 'x' },
    ] });
    const r = await call('GET', '/api/admin/livetv/status');
    expect(r.json().streams).toEqual([
      { channelId: b, name: 'Hafenkanal', logoHash: null, mode: 'passthrough', viewers: 0, since: 1_700_000_050_000, bitrate: null, input: 'reconnecting', reconnects: 0 },
      { channelId: a, name: 'Nordlicht TV', logoHash: null, mode: 'remux', viewers: 0, since: 1_700_000_000_000, bitrate: 4_200_000, input: 'ok', reconnects: 2 },
    ].sort((x, y) => x.name.localeCompare(y.name)));
  });

  it('lists push feeds with name, port, state and rejected attempts', async () => {
    const c = await channel('Hafenkanal Live', { kind: 'manual', ingest: 'push', port: 9001 });
    ingest = () => ({ json: [
      { channelId: c, port: 9001, state: 'receiving', since: 1_700_000_000_000, bitrate: 2_000_000, rejected1h: 3 },
      { channelId: '00000000-0000-4000-8000-000000000000', port: 9002, state: 'idle', since: null, bitrate: null, rejected1h: 0 },
    ] });
    const r = await call('GET', '/api/admin/livetv/status');
    expect(r.json().ingest).toEqual([{ channelId: c, name: 'Hafenkanal Live', port: 9001, state: 'receiving', since: 1_700_000_000_000, bitrate: 2_000_000, rejected1h: 3 }]);
  });

  it('carries the events, newest first', async () => {
    await pushEvent(env.ctx, { level: 'warn', code: 'start_refused_full' });
    await pushEvent(env.ctx, { level: 'info', code: 'stopped_by_admin' });
    const ev = (await call('GET', '/api/admin/livetv/status')).json().events;
    expect(ev.map((e: { code: string }) => e.code)).toEqual(['stopped_by_admin', 'start_refused_full']);
  });

  it('names every channel an event names, running or not (ids and names only)', async () => {
    const stopped = await channel('Hafenkanal');
    const other = await channel('Nordlicht TV');
    await pushEvent(env.ctx, { level: 'info', code: 'stopped_by_admin', channelId: stopped });
    await pushEvent(env.ctx, { level: 'warn', code: 'start_refused_full' });
    await pushEvent(env.ctx, { level: 'warn', code: 'input_lost', channelId: '00000000-0000-4000-8000-000000000000' });
    const r = await call('GET', '/api/admin/livetv/status');
    // no stream is running: the name still comes with the event; a channel that is gone and a channel without an event are not in the map
    expect(r.json().streams).toEqual([]);
    expect(r.json().channels).toEqual({ [stopped]: 'Hafenkanal' });
    expect(r.json().channels).not.toHaveProperty(other);
  });

  it('asks Jellyfin for its encoder settings at most every 10 s, however often the tab polls', async () => {
    const spy = vi.spyOn(env.ctx.jf.admin, 'encoderSettings').mockResolvedValue({ hwAccel: 'vaapi' } as never);
    try {
      const sample = vi.spyOn(Date, 'now');
      const t0 = Date.now();
      sample.mockReturnValue(t0 + 20_000);
      await call('GET', '/api/admin/livetv/status');
      await call('GET', '/api/admin/livetv/status');
      await call('GET', '/api/admin/livetv/status');
      expect(spy).toHaveBeenCalledTimes(1);
      sample.mockReturnValue(t0 + 31_000);
      await call('GET', '/api/admin/livetv/status');
      expect(spy).toHaveBeenCalledTimes(2);
      sample.mockRestore();
    } finally { spy.mockRestore(); }
  });

  it('no URL in the status answer', async () => {
    const a = await channel('Nordlicht TV');
    const p = await channel('Hafenkanal Live', { kind: 'manual', ingest: 'push', port: 9000 });
    streams = () => ({ json: [{ channelId: a, streamKey: KEY, mode: 'remux', since: 1, state: 'running', bitrate: 1, errors: [], lastSegmentAt: 1 }] });
    ingest = () => ({ json: [{ channelId: p, port: 9000, state: 'idle', since: null, bitrate: null, rejected1h: 0 }] });
    await pushEvent(env.ctx, { level: 'error', code: 'source_refresh_failed', reason: 'unreachable' });
    const r = await call('GET', '/api/admin/livetv/status');
    const text = r.body;
    expect(text).not.toMatch(/https?:|srt:|iptv\.example|geheim|secret-token|streamKey|stream_key|passphrase|[Uu]rl/);
    expect(text).not.toContain(KEY);
  });

  it('is for admins only', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/admin/livetv/status' });
    expect([401, 403]).toContain(r.statusCode);
  });
});

describe('POST /api/admin/livetv/streams/:channelId/stop', () => {
  it('stop calls DELETE and audits', async () => {
    const c = await channel('Nordlicht TV');
    const r = await call('POST', `/api/admin/livetv/streams/${c}/stop`);
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true }]);
    expect(calls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual([`/v1/streams/${c}`]);
    const rows = (await env.pool.query("select actor, target, meta from audit_log where action = 'livetv.stream.stop'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe(c);
    expect(JSON.stringify(rows[0].meta)).not.toMatch(/https?:|iptv/);
    // and says so in the event ring
    const ev = (await call('GET', '/api/admin/livetv/status')).json().events;
    expect(ev).toEqual([expect.objectContaining({ code: 'stopped_by_admin', level: 'info', channelId: c })]);
  });

  it('a failing event ring does not turn a done stop into a 500 without an audit entry', async () => {
    const c = await channel('Nordlicht TV');
    const real = env.ctx.kv.setnx.bind(env.ctx.kv);
    // only the event ring's lock fails (the session and the limiter use the same store)
    const spy = vi.spyOn(env.ctx.kv, 'setnx').mockImplementation(async (k, v, ttl) => { if (k === 'ltv:events:lock') throw new Error('kv down'); return real(k, v, ttl); });
    try {
      const r = await call('POST', `/api/admin/livetv/streams/${c}/stop`);
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true }]);
    } finally { spy.mockRestore(); }
    expect(calls.filter((x) => x.method === 'DELETE')).toHaveLength(1);
    expect((await env.pool.query("select 1 from audit_log where action = 'livetv.stream.stop'")).rowCount).toBe(1);
  });

  it('a 404 from livetv is tolerated (nothing was running)', async () => {
    const c = await channel('Nordlicht TV');
    del = () => ({ status: 404 });
    const r = await call('POST', `/api/admin/livetv/streams/${c}/stop`);
    expect(r.statusCode).toBe(200);
    expect((await env.pool.query("select 1 from audit_log where action = 'livetv.stream.stop'")).rowCount).toBe(1);
  });

  it('livetv not reached: 503 livetv_unreachable, no event, no audit', async () => {
    const c = await channel('Nordlicht TV');
    env.ctx.fetchImpl = (async () => { throw new Error('down'); }) as typeof fetch;
    const r = await call('POST', `/api/admin/livetv/streams/${c}/stop`);
    expect([r.statusCode, r.json()]).toEqual([503, { error: 'livetv_unreachable' }]);
    expect((await env.pool.query("select 1 from audit_log where action = 'livetv.stream.stop'")).rowCount).toBe(0);
  });

  it('a channel id that is not an id is a 404 and calls nothing', async () => {
    const r = await call('POST', '/api/admin/livetv/streams/not-an-id/stop');
    expect([r.statusCode, r.json()]).toEqual([404, { error: 'not_found' }]);
    expect(calls.filter((x) => x.method === 'DELETE')).toEqual([]);
  });
});
