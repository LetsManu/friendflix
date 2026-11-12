// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 20: own feeds (spec §3.5, §9.1). Pulled feeds are checked like provider URLs (`srt:` allowed) and stored
 * encrypted; pushed feeds get the lowest free port of LIVETV_SRT_PORTS and a stream id + passphrase that are stored encrypted, answered
 * once and synced to livetv with `PUT /v1/ingest`. No credential ever reaches a log, the audit log or a later answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt, keyFromBase64 } from '../src/crypto.js';
import type { LiveEvent } from '../src/livetv/events.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { INGEST_DIRTY_KEY, forgetSrtPorts, livetvIngestTick, syncIngest } from '../src/livetv/ownfeeds.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

const events: Array<Omit<LiveEvent, 'at'>> = [];
vi.mock('../src/livetv/events.js', async (orig) => ({
  ...(await orig<typeof import('../src/livetv/events.js')>()),
  pushEvent: async (_c: unknown, e: Omit<LiveEvent, 'at'>) => { events.push(e); },
}));

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);
const logs: string[] = [];

const STREAM_ID_RE = /^ff-[A-Z2-7]{16}$/;
const PASSPHRASE_RE = /^[A-Za-z0-9_-]{32}$/;
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

let addr = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, s: Sess = admin) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });
const push = (name = 'Hafenkanal Live', extra: Record<string, unknown> = {}) => call('POST', '/api/admin/livetv/channels', { ingest: 'push', name, ...extra });
const pull = (url: string, extra: Record<string, unknown> = {}) => call('POST', '/api/admin/livetv/channels', { ingest: 'pull', name: 'Nordlicht TV', url, ...extra });
const row = async (id: string) => (await env.pool.query('select * from livetv_channels where id = $1', [id])).rows[0];

// ---- the fake livetv ----
const calls: Call[] = [];
let ports: number[];
let ingest: Handler;
let ingestState: Handler;
let health: Handler;
const ingestBodies = () => calls.filter((c) => c.method === 'PUT' && c.path === '/v1/ingest').map((c) => c.body as { feeds: Array<{ channelId: string; port: number; streamId: string; passphrase: string }> });
const lastIngest = () => ingestBodies().at(-1)!;
let encoders: unknown[];
const system = () => ({
  cpu: { model: 'Testprozessor', cores: 4, loadPct: 3 }, gpu: { devices: [], driver: null, readable: false, busyPct: null }, encoders,
  cache: { usedBytes: 0, maxBytes: 1 }, recordings: null, srt: { ports },
});

beforeAll(async () => {
  env = await makeEnv({}, { logger: { stream: { write: (l: string) => { logs.push(l); } }, level: 'trace' } });
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from livetv_channels; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from audit_log');
  calls.length = 0;
  logs.length = 0;
  events.length = 0;
  ports = range(9000, 10);
  encoders = ['libx264'];
  ingest = () => ({ json: { ok: true, listening: ports } });
  ingestState = () => ({ json: [] });
  health = () => ({ json: { ok: true, api: 1, version: '3.3.0', bootId: '0123456789abcdef' } });
  await env.kv.del(INGEST_DIRTY_KEY);
  forgetSrtPorts(env.ctx);
  env.ctx.fetchImpl = fakeHttp({ 'GET /v1/system': () => ({ json: system() }), 'PUT /v1/ingest': (...a) => ingest(...a), 'GET /v1/ingest': (...a) => ingestState(...a), 'GET /healthz': (...a) => health(...a) }, calls);
});

describe('push credentials (spec §3.5)', () => {
  it('credentials have the spec format', async () => {
    const r = await push();
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().synced).toBe(true);
    const { channel, push: p } = r.json();
    expect(p.streamId).toMatch(STREAM_ID_RE);
    expect(p.passphrase).toMatch(PASSPHRASE_RE);
    expect(p).toEqual({
      host: 'portal.example.com', port: 9000, streamId: p.streamId, passphrase: p.passphrase,
      url: `srt://portal.example.com:9000?streamid=${p.streamId}&passphrase=${p.passphrase}&pbkeylen=32&mode=caller&latency=200000`,
    });
    expect(channel).toMatchObject({ name: 'Hafenkanal Live', ingest: 'push', streamKind: 'srt', number: null, groupId: null, hidden: false, missing: false, now: null });
    expect(channel.push).toEqual({ port: 9000, hint: p.streamId.slice(0, 9), portInRange: true });
    expect(channel.push.hint).toMatch(/^ff-[A-Z2-7]{6}$/);

    // stored encrypted, the raw row holds neither value
    const stored = await row(channel.id);
    expect(decrypt(key, stored.push_stream_id_enc)).toBe(p.streamId);
    expect(decrypt(key, stored.push_passphrase_enc)).toBe(p.passphrase);
    expect(stored).toMatchObject({ push_port: 9000, push_stream_id_hint: p.streamId.slice(0, 9), stream_url_enc: null, stream_kind: 'srt', ingest: 'push' });
    expect(JSON.stringify(stored)).not.toContain(p.passphrase);
    expect(JSON.stringify(stored)).not.toContain(p.streamId);

    // livetv learned the feed
    expect(lastIngest()).toEqual({ feeds: [{ channelId: channel.id, port: 9000, streamId: p.streamId, passphrase: p.passphrase }] });

    // the own-feeds source was created on first use: kind 'feeds' on the wire, 'manual' stored, no URL
    const sources = (await call('GET', '/api/admin/livetv/sources')).json();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: channel.sourceId, kind: 'feeds', name: 'Eigene Streams', urlHint: null, channelCount: 1 });
    expect((await env.pool.query('select kind, url_enc from livetv_sources')).rows).toEqual([{ kind: 'manual', url_enc: null }]);

    // a second GET shows only the hint and the port
    const again = await call('GET', `/api/admin/livetv/channels/${channel.id}`);
    expect(again.statusCode).toBe(200);
    expect(again.body).not.toContain(p.passphrase);
    expect(again.body).not.toContain(p.streamId);
    expect(again.json().push).toEqual({ port: 9000, hint: p.streamId.slice(0, 9), portInRange: true });

    // a second feed goes into the same source, with other credentials
    const second = (await push('Bergblick Sport Kamera')).json();
    expect(second.channel.sourceId).toBe(channel.sourceId);
    expect(second.push.streamId).not.toBe(p.streamId);
    expect(second.push.passphrase).not.toBe(p.passphrase);
    expect((await env.pool.query('select count(*)::int as n from livetv_sources')).rows[0].n).toBe(1);
  });

  it('a livetv that reports an encoder this backend does not know still takes push feeds', async () => {
    encoders = ['h264_qsv', 'av1_qsv', 'libx264'];
    const r = await push();
    expect(r.statusCode).toBe(201);
    expect(r.json().channel.push).toMatchObject({ port: 9000, portInRange: true });
    expect(lastIngest().feeds).toHaveLength(1);
  });

  it('no host is shown before PUBLIC_URL is known; LIVETV_SRT_HOST wins', async () => {
    const saved = env.ctx.cfg;
    try {
      env.ctx.cfg = { ...saved, PUBLIC_URL: '', LIVETV_SRT_HOST: undefined };
      const p = (await push()).json().push;
      expect(p).toMatchObject({ host: null, url: null, port: 9000 });
      env.ctx.cfg = { ...saved, LIVETV_SRT_HOST: '192.0.2.10' };
      const q = (await push('Sternwarte 24')).json().push;
      expect(q.host).toBe('192.0.2.10');
      expect(q.url).toMatch(/^srt:\/\/192\.0\.2\.10:9001\?streamid=ff-/);
    } finally {
      env.ctx.cfg = saved;
    }
  });

  it('an IPv6 SRT host is bracketed in the URL', async () => {
    const saved = env.ctx.cfg;
    try {
      env.ctx.cfg = { ...saved, LIVETV_SRT_HOST: '2001:db8::10' };
      const p = (await push()).json().push;
      expect(p.host).toBe('[2001:db8::10]');
      expect(p.url).toMatch(/^srt:\/\/\[2001:db8::10\]:9000\?streamid=ff-/);
    } finally {
      env.ctx.cfg = saved;
    }
  });

  it('two feeds created at once get different ports', async () => {
    const [a, b] = await Promise.all([push('Kamera 1'), push('Kamera 2')]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect([a.json().push.port, b.json().push.port].sort()).toEqual([9000, 9001]);
    expect((await env.pool.query('select push_port from livetv_channels order by push_port')).rows).toEqual([{ push_port: 9000 }, { push_port: 9001 }]);
    expect((await env.pool.query('select count(*)::int as n from livetv_sources')).rows[0].n).toBe(1);
  });

  it('ports are the lowest free', async () => {
    const a = (await push('Hafenkanal Live')).json();
    const b = (await push('Kinderinsel Live')).json();
    expect([a.push.port, b.push.port]).toEqual([9000, 9001]);
    const del = await call('DELETE', `/api/admin/livetv/channels/${a.channel.id}`);
    expect([del.statusCode, del.json()]).toEqual([200, { ok: true, synced: true }]);
    // the freed port is gone from livetv's set at once
    expect(lastIngest().feeds.map((f) => f.channelId)).toEqual([b.channel.id]);
    const c = (await push('Sternwarte 24')).json();
    expect(c.push.port).toBe(9000);
    expect(lastIngest().feeds.map((f) => f.port)).toEqual([9000, 9001]);
    expect((await call('DELETE', `/api/admin/livetv/channels/${a.channel.id}`)).statusCode).toBe(404);
  });

  it('the range can be full', async () => {
    for (let i = 0; i < 10; i++) expect((await push(`Kamera ${i + 1}`)).json().push.port).toBe(9000 + i);
    const r = await push('Kamera 11');
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'srt_ports_full', n: 10 }]);
    expect((await env.pool.query("select count(*)::int as n from livetv_channels where ingest = 'push'")).rows[0].n).toBe(10);
  });

  it('livetv not answering refuses a push feed with 503', async () => {
    env.ctx.fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const r = await push();
    expect([r.statusCode, r.json()]).toEqual([503, { error: 'livetv_unreachable' }]);
    expect((await env.pool.query('select count(*)::int as n from livetv_channels')).rows[0].n).toBe(0);
  });

  it('the port range is cached for a minute', async () => {
    await push('Kamera 1');
    await push('Kamera 2');
    expect(calls.filter((c) => c.path === '/v1/system')).toHaveLength(1);
  });

  it('regenerate replaces both and syncs', async () => {
    const first = (await push()).json();
    const id = first.channel.id as string;
    const r = await call('POST', `/api/admin/livetv/channels/${id}/push-credentials`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().synced).toBe(true);
    const p = r.json().push;
    expect(p.streamId).toMatch(STREAM_ID_RE);
    expect(p.passphrase).toMatch(PASSPHRASE_RE);
    expect(p.streamId).not.toBe(first.push.streamId);
    expect(p.passphrase).not.toBe(first.push.passphrase);
    expect(p.port).toBe(9000);
    expect(r.json().channel.push).toEqual({ port: 9000, hint: p.streamId.slice(0, 9), portInRange: true });
    expect(lastIngest()).toEqual({ feeds: [{ channelId: id, port: 9000, streamId: p.streamId, passphrase: p.passphrase }] });
    const stored = await row(id);
    expect([decrypt(key, stored.push_stream_id_enc), decrypt(key, stored.push_passphrase_enc)]).toEqual([p.streamId, p.passphrase]);

    // only push feeds have credentials
    const pulled = (await pull('https://iptv.example.com/live/nordlicht.m3u8')).json().channel.id;
    const notPush = await call('POST', `/api/admin/livetv/channels/${pulled}/push-credentials`);
    expect([notPush.statusCode, notPush.json()]).toEqual([409, { error: 'not_push' }]);
    expect((await call('POST', '/api/admin/livetv/channels/00000000-0000-4000-8000-000000000000/push-credentials')).statusCode).toBe(404);
    expect((await call('POST', '/api/admin/livetv/channels/kaputt/push-credentials')).statusCode).toBe(404);
  });

  it('a port that left the range', async () => {
    const first = (await push()).json();
    const id = first.channel.id as string;
    const before = await row(id);
    // LIVETV_SRT_PORTS is now 9100-9109
    ports = range(9100, 10);
    forgetSrtPorts(env.ctx);
    expect((await call('GET', `/api/admin/livetv/channels/${id}`)).json().push).toEqual({ port: 9000, hint: first.push.streamId.slice(0, 9), portInRange: false });
    // a feed outside the range is not sent to livetv
    expect(await syncIngest(env.ctx)).toBe('ok');
    expect(lastIngest()).toEqual({ feeds: [] });

    const r = await call('POST', `/api/admin/livetv/channels/${id}/push-port`);
    expect([r.statusCode, r.json()]).toEqual([200, { port: 9100, synced: true }]);
    expect(r.body).not.toContain(first.push.passphrase);
    const after = await row(id);
    expect(after.push_port).toBe(9100);
    // credentials kept
    expect([after.push_stream_id_enc, after.push_passphrase_enc]).toEqual([before.push_stream_id_enc, before.push_passphrase_enc]);
    expect(lastIngest()).toEqual({ feeds: [{ channelId: id, port: 9100, streamId: first.push.streamId, passphrase: first.push.passphrase }] });
    expect((await call('GET', `/api/admin/livetv/channels/${id}`)).json().push.portInRange).toBe(true);
    // a port still in the range is never moved (a working encoder would be cut off)
    const inRange = await call('POST', `/api/admin/livetv/channels/${id}/push-port`);
    expect([inRange.statusCode, inRange.json()]).toEqual([409, { error: 'port_in_range' }]);
    expect((await row(id)).push_port).toBe(9100);

    // a full new range refuses the move
    ports = [9100];
    forgetSrtPorts(env.ctx);
    const other = (await env.pool.query(
      `insert into livetv_channels(id, source_id, source_key, stream_kind, ingest, import_name, push_port, push_stream_id_enc, push_stream_id_hint, push_passphrase_enc)
       values (gen_random_uuid(), $1, 'x', 'srt', 'push', 'Kanal Wolkenlos', 9005, $2, 'ff-ABCDEF', $3) returning id`,
      [first.channel.sourceId, encrypt(key, 'ff-ABCDEFGHIJKLMNOP'), encrypt(key, 'p'.repeat(32))])).rows[0].id;
    const full = await call('POST', `/api/admin/livetv/channels/${other}/push-port`);
    expect([full.statusCode, full.json()]).toEqual([409, { error: 'srt_ports_full', n: 1 }]);
  });
});

describe('pull feeds', () => {
  it('pull feeds validate like sources', async () => {
    const srt = await pull('srt://192.0.2.10:9000?streamid=nordlicht&passphrase=geheimgeheimgeheim');
    expect(srt.statusCode).toBe(201);
    expect(srt.json().push).toBeUndefined();
    expect(srt.json().channel).toMatchObject({ ingest: 'pull', streamKind: 'srt', name: 'Nordlicht TV' });
    expect(srt.body).not.toContain('192.0.2.10');
    expect(srt.body).not.toContain('geheim');
    const stored = await row(srt.json().channel.id);
    expect(decrypt(key, stored.stream_url_enc)).toBe('srt://192.0.2.10:9000?streamid=nordlicht&passphrase=geheimgeheimgeheim');
    expect(stored).toMatchObject({ allow_lan: false, push_port: null, ingest: 'pull' });

    const lan = await pull('srt://192.168.1.5:9000');
    expect([lan.statusCode, lan.json()]).toEqual([400, { error: 'lan_required', field: 'url' }]);
    const lanOk = await pull('srt://192.168.1.5:9000', { allowLan: true });
    expect(lanOk.statusCode).toBe(201);
    expect((await row(lanOk.json().channel.id)).allow_lan).toBe(true);

    // the kind follows the URL unless the admin names one that fits
    expect((await pull('https://iptv.example.com/live/nordlicht.m3u8')).json().channel.streamKind).toBe('hls');
    expect((await pull('http://iptv.example.com/live/7.ts')).json().channel.streamKind).toBe('ts');
    expect((await pull('http://iptv.example.com/live/7', { kind: 'ts' })).json().channel.streamKind).toBe('ts');

    const bad = async (b: Record<string, unknown>, status: number, json: unknown) => {
      const r = await call('POST', '/api/admin/livetv/channels', b);
      expect([r.statusCode, r.json()]).toEqual([status, json]);
    };
    await bad({ ingest: 'pull', name: 'X', url: 'ftp://iptv.example.com/x' }, 400, { error: 'invalid', field: 'url' });
    await bad({ ingest: 'pull', name: 'X', url: 'http://localhost:8090/x' }, 400, { error: 'refused', field: 'url' });
    await bad({ ingest: 'pull', name: 'X', url: 'srt://127.0.0.1:9000', allowLan: true }, 400, { error: 'refused', field: 'url' });
    await bad({ ingest: 'pull', name: 'X', url: 'https://iptv.example.com/x.m3u8', kind: 'srt' }, 400, { error: 'invalid', field: 'kind' });
    await bad({ ingest: 'pull', name: 'X', url: 'srt://192.0.2.10:9000', kind: 'hls' }, 400, { error: 'invalid', field: 'kind' });
    await bad({ ingest: 'pull', name: 'X', url: 'https://iptv.example.com/x.m3u8', groupId: '00000000-0000-4000-8000-000000000000' }, 400, { error: 'invalid', field: 'groupId' });
    await bad({ ingest: 'pull', name: '', url: 'https://iptv.example.com/x.m3u8' }, 400, { error: 'invalid', field: 'name' });
    // a push body takes no URL (an unknown key: the shared parse answers field 'body')
    await bad({ ingest: 'push', name: 'X', url: 'https://iptv.example.com/x.m3u8' }, 400, { error: 'invalid', field: 'body' });
    await bad({ ingest: 'rtmp', name: 'X' }, 400, { error: 'invalid', field: 'ingest' });
    await bad({ ingest: 'push', name: 'X', number: 0 }, 400, { error: 'invalid', field: 'number' });

    // number and group land on the channel
    const g = (await env.pool.query("insert into livetv_groups(id, name) values (gen_random_uuid(), 'Eigene') returning id")).rows[0].id;
    const withGroup = await pull('https://iptv.example.com/live/hafen.m3u8', { number: 801, groupId: g });
    expect(withGroup.json().channel).toMatchObject({ number: 801, groupId: g });

    // pull feeds never touch the port range or the ingest set
    expect(calls).toEqual([]);
  });

  it('only own feeds can be deleted', async () => {
    const src = (await env.pool.query(`insert into livetv_sources(id, kind, name, url_enc) values (gen_random_uuid(), 'm3u', 'Anbieter', $1) returning id`, [encrypt(key, 'https://iptv.example.com/get.php')])).rows[0].id;
    const ch = (await env.pool.query(`insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name) values (gen_random_uuid(), $1, 'k1', $2, 'hls', 'Hafenkanal') returning id`,
      [src, encrypt(key, 'https://iptv.example.com/live/1.m3u8')])).rows[0].id;
    const r = await call('DELETE', `/api/admin/livetv/channels/${ch}`);
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'not_own_feed' }]);
    const own = (await pull('https://iptv.example.com/live/nordlicht.m3u8')).json().channel.id;
    expect((await call('DELETE', `/api/admin/livetv/channels/${own}`)).statusCode).toBe(200);
    expect(await row(own)).toBeUndefined();
  });
});

describe('ingest sync', () => {
  it('a livetv without the ingest endpoint is pending, with one event', async () => {
    ingest = () => ({ status: 404, json: { error: 'not_found' } });
    const r = await push();
    expect(r.statusCode).toBe(201);
    expect(r.json().synced).toBe(false);
    expect(events).toEqual([{ level: 'info', code: 'ingest_sync_pending' }]);
    // the flag is already set: no second event while it stays
    expect(await syncIngest(env.ctx)).toBe('pending');
    ingest = () => ({ status: 500, json: { error: 'boom' } });
    expect(await syncIngest(env.ctx)).toBe('failed');
    expect(events).toHaveLength(1);
    expect(await env.kv.get(INGEST_DIRTY_KEY)).not.toBeNull();
    ingest = () => ({ json: { ok: true, listening: [9000] } });
    expect(await syncIngest(env.ctx)).toBe('ok');
    expect(await env.kv.get(INGEST_DIRTY_KEY)).toBeNull();
    expect(events).toHaveLength(1);
  });

  it('a failed sync on rotate leaves the flag set; the next tick re-syncs and clears it', async () => {
    await detectLivetv(env.ctx, 0);
    const first = (await push()).json();
    ingest = () => ({ status: 503, json: { error: 'busy' } });
    const r = await call('POST', `/api/admin/livetv/channels/${first.channel.id}/push-credentials`);
    expect(r.statusCode).toBe(200);
    expect(r.json().synced).toBe(false);
    const p = r.json().push;
    expect(await env.kv.get(INGEST_DIRTY_KEY)).not.toBeNull();
    expect(events).toEqual([{ level: 'info', code: 'ingest_sync_pending' }]);
    // still failing: the tick tries and keeps the flag
    const before = ingestBodies().length;
    await livetvIngestTick(env.ctx);
    expect(ingestBodies()).toHaveLength(before + 1);
    expect(await env.kv.get(INGEST_DIRTY_KEY)).not.toBeNull();
    ingest = () => ({ json: { ok: true, listening: [9000] } });
    await livetvIngestTick(env.ctx);
    expect(lastIngest()).toEqual({ feeds: [{ channelId: first.channel.id, port: 9000, streamId: p.streamId, passphrase: p.passphrase }] });
    expect(await env.kv.get(INGEST_DIRTY_KEY)).toBeNull();
    // nothing to do without the flag
    const n = ingestBodies().length;
    await livetvIngestTick(env.ctx);
    expect(ingestBodies()).toHaveLength(n);
  });

  it('a delete whose sync failed is retried, and the old credentials disappear', async () => {
    await detectLivetv(env.ctx, 0);
    const a = (await push()).json();
    ingest = () => ({ status: 500, json: { error: 'boom' } });
    const del = await call('DELETE', `/api/admin/livetv/channels/${a.channel.id}`);
    expect([del.statusCode, del.json()]).toEqual([200, { ok: true, synced: false }]);
    expect(await row(a.channel.id)).toBeUndefined();
    ingest = () => ({ json: { ok: true, listening: [] } });
    await livetvIngestTick(env.ctx);
    expect(lastIngest()).toEqual({ feeds: [] });
    expect(await env.kv.get(INGEST_DIRTY_KEY)).toBeNull();
  });

  it('the retry waits while livetv is not installed', async () => {
    await push();
    await env.kv.set(INGEST_DIRTY_KEY, '1', 60);
    health = () => ({ status: 404 });
    await detectLivetv(env.ctx, 0);
    const n = ingestBodies().length;
    await livetvIngestTick(env.ctx);
    expect(ingestBodies()).toHaveLength(n);
    expect(await env.kv.get(INGEST_DIRTY_KEY)).not.toBeNull();
  });

  it('a disabled source or a hidden feed leaves the ingest set', async () => {
    const a = (await push('Hafenkanal Live')).json();
    const b = (await push('Kinderinsel Live')).json();
    const src = a.channel.sourceId as string;
    const off = await call('PATCH', `/api/admin/livetv/sources/${src}`, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(lastIngest()).toEqual({ feeds: [] });
    expect((await call('GET', '/api/admin/livetv/ingest')).json().feeds.map((f: { state: string }) => f.state)).toEqual(['off', 'off']);
    expect((await call('PATCH', `/api/admin/livetv/sources/${src}`, { enabled: true })).statusCode).toBe(200);
    expect(lastIngest().feeds.map((f) => f.channelId)).toEqual([a.channel.id, b.channel.id]);
    // a renamed source does not re-send
    const n = ingestBodies().length;
    await call('PATCH', `/api/admin/livetv/sources/${src}`, { name: 'Meine Streams' });
    expect(ingestBodies()).toHaveLength(n);
    // a hidden feed is withdrawn (Task 19's hide paths must call syncIngest)
    await env.pool.query('update livetv_channels set hidden = true where id = $1', [a.channel.id]);
    expect(await syncIngest(env.ctx)).toBe('ok');
    expect(lastIngest().feeds.map((f) => f.channelId)).toEqual([b.channel.id]);
  });

  it('deleting the own-feeds source drops its push feeds from livetv', async () => {
    const a = (await push()).json();
    expect(lastIngest().feeds).toHaveLength(1);
    const r = await call('DELETE', `/api/admin/livetv/sources/${a.channel.sourceId}`);
    expect([r.statusCode, r.json()]).toEqual([200, { channels: 1 }]);
    expect(lastIngest()).toEqual({ feeds: [] });
  });
});

describe('the Eigene Streams card', () => {
  it('answers host, range and the state of each push feed', async () => {
    const empty = await call('GET', '/api/admin/livetv/ingest');
    expect([empty.statusCode, empty.json()]).toEqual([200, { host: 'portal.example.com', ports: { from: 9000, to: 9009 }, feeds: [] }]);
    expect(empty.headers['cache-control']).toBe('no-store');

    const a = (await push('Hafenkanal Live')).json();
    const b = (await push('Kinderinsel Live')).json();
    await pull('https://iptv.example.com/live/nordlicht.m3u8');
    ingestState = () => ({ json: [{ channelId: a.channel.id, port: 9000, state: 'receiving', since: 1, bitrate: 4_000_000, rejected1h: 3 }] });
    const r = await call('GET', '/api/admin/livetv/ingest');
    expect(r.json()).toEqual({
      host: 'portal.example.com', ports: { from: 9000, to: 9009 },
      feeds: [{ channelId: a.channel.id, state: 'receiving', rejected1h: 3 }, { channelId: b.channel.id, state: 'pending', rejected1h: 0 }],
    });
    for (const s of [a.push.streamId, a.push.passphrase, b.push.streamId, b.push.passphrase]) expect(r.body).not.toContain(s);

    ingestState = () => ({ json: [{ channelId: a.channel.id, port: 9000, state: 'idle', since: null, bitrate: 0, rejected1h: 0 }, { channelId: b.channel.id, port: 9001, state: 'idle', since: null, bitrate: 0, rejected1h: 0 }] });
    expect((await call('GET', '/api/admin/livetv/ingest')).json().feeds.map((f: { state: string }) => f.state)).toEqual(['idle', 'idle']);
    // before PR 1d livetv has no ingest endpoint
    ingestState = () => ({ status: 404, json: { error: 'not_found' } });
    expect((await call('GET', '/api/admin/livetv/ingest')).json().feeds.map((f: { state: string }) => f.state)).toEqual(['pending', 'pending']);
    // a port that left the range
    ports = [9001, 9002];
    forgetSrtPorts(env.ctx);
    ingestState = () => ({ json: [] });
    expect((await call('GET', '/api/admin/livetv/ingest')).json()).toMatchObject({ ports: { from: 9001, to: 9002 }, feeds: [{ state: 'out_of_range' }, { state: 'pending' }] });
    // livetv not answering; no host before setup
    const saved = env.ctx.cfg;
    try {
      env.ctx.cfg = { ...saved, PUBLIC_URL: '', LIVETV_SRT_HOST: undefined };
      forgetSrtPorts(env.ctx);
      env.ctx.fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
      expect((await call('GET', '/api/admin/livetv/ingest')).json()).toEqual({
        host: null, ports: null, feeds: [{ channelId: a.channel.id, state: 'error', rejected1h: 0 }, { channelId: b.channel.id, state: 'error', rejected1h: 0 }],
      });
    } finally {
      env.ctx.cfg = saved;
    }
  });
});

describe('secrets (F13)', () => {
  it('no credential in audit or logs', async () => {
    const secrets: string[] = [];
    const keep = (p: { streamId: string; passphrase: string }) => { secrets.push(p.streamId, p.passphrase); };
    const a = (await push()).json();
    keep(a.push);
    keep((await call('POST', `/api/admin/livetv/channels/${a.channel.id}/push-credentials`)).json().push);
    // a failing sync is logged with its code only
    ingest = () => ({ status: 500, json: { error: 'boom' } });
    keep((await push('Kinderinsel Live')).json().push);
    keep((await call('POST', `/api/admin/livetv/channels/${a.channel.id}/push-credentials`)).json().push);
    ingest = () => ({ json: { ok: true, listening: [] } });
    ports = range(9100, 10);
    forgetSrtPorts(env.ctx);
    await call('POST', `/api/admin/livetv/channels/${a.channel.id}/push-port`);
    // a pull URL with credentials in its query, valid and refused
    const PULL = 'srt://192.0.2.10:9000?streamid=geheimkennung&passphrase=geheimpassphrase';
    await pull(PULL);
    await pull(PULL.replace('192.0.2.10', '10.0.0.8'));
    await call('POST', '/api/admin/livetv/channels', { ingest: 'pull', name: 'X', url: PULL, unknown: PULL });
    // a database failure on the insert is logged by type and code only (its `detail` would quote the row)
    await env.pool.query("alter table livetv_channels add constraint t20_fail check (import_name <> 'Kaputt')");
    try {
      const r = await call('POST', '/api/admin/livetv/channels', { ingest: 'pull', name: 'Kaputt', url: PULL });
      expect([r.statusCode, r.json()]).toEqual([500, { error: 'internal' }]);
    } finally {
      await env.pool.query('alter table livetv_channels drop constraint t20_fail');
    }
    await call('DELETE', `/api/admin/livetv/channels/${a.channel.id}`);

    expect(secrets.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    const log = logs.join('\n');
    expect(log).toContain('livetv ingest sync failed');
    expect(log).toContain('unhandled error');
    const audit = (await env.pool.query('select action, meta::text as meta from audit_log order by id')).rows as Array<{ action: string; meta: string }>;
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['livetv.source.create', 'livetv.channel.create', 'livetv.channel.credentials', 'livetv.channel.port', 'livetv.channel.delete']));
    const auditText = audit.map((x) => x.meta).join('\n');
    for (const hay of [log, auditText]) {
      for (const s of secrets) expect(hay).not.toContain(s);
      expect(hay).not.toContain('geheim');
      expect(hay).not.toContain('192.0.2.10');
    }
  });

  it('non-admin 403', async () => {
    const id = (await push()).json().channel.id;
    calls.length = 0;
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), 'sub-ben', 'ben@friend.example.com', 'Ben Muster', 'family', $1, 'Ben', $2)`, ['2'.repeat(32), encrypt(key, 'pw')]);
    const ben = await env.login({ sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] });
    for (const [m, u, b] of [
      ['POST', '/api/admin/livetv/channels', { ingest: 'push', name: 'X' }], ['GET', `/api/admin/livetv/channels/${id}`, undefined],
      ['POST', `/api/admin/livetv/channels/${id}/push-credentials`, undefined], ['POST', `/api/admin/livetv/channels/${id}/push-port`, undefined],
      ['DELETE', `/api/admin/livetv/channels/${id}`, undefined], ['GET', '/api/admin/livetv/ingest', undefined],
    ] as const) {
      const r = await call(m, u, b, ben);
      expect([m, u, r.statusCode]).toEqual([m, u, 403]);
    }
    expect(calls).toEqual([]);
  });
});
