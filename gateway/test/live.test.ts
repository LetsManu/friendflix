// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV: `/media/l/<token>/<file>` (spec §7.3). A fake backend answers `/internal/authz/live`, a fake `livetv` serves
 * `/s/<streamKey>/<file>` (shaped like livetv/src/routes/files.ts), and the REAL gateway sits in front, without a media server.
 */
import { connect } from 'node:net';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway } from '../src/gateway.js';

const SECRET = 'internal-secret-for-tests';
const KEY = '0123456789abcdef0123456789abcdef'; // livetv stream key (STREAM_KEY_RE)
const KEY_BADTYPE = 'badc0ffee0ddf00dbadc0ffee0ddf00d'; // livetv answers text/html
const KEY_HOSTILE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // playlist with a foreign URI
const KEY_BIG = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // playlist over 2 MB
const KEY_DOWN = 'cccccccccccccccccccccccccccccccc'; // livetv closes the connection
const KEY_500 = 'dddddddddddddddddddddddddddddddd'; // livetv answers 500
const KEY_HANG = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // livetv sends part of a segment and stalls
const tok = (c: string) => c.repeat(43);
const T_OK = tok('A');
const T_GONE = tok('G'); // revoked: 410
const T_FORB = tok('F'); // 403 (pinned to another address)
const T_UNKNOWN = tok('U'); // 401
const T_DOWN = tok('D'); // backend 500
const T_BADKEY = tok('K'); // backend answers a stream key that is not 32 hex
const T_BADTYPE = tok('T');
const T_HOSTILE = tok('H');
const T_BIG = tok('B');
const T_LVDOWN = tok('L');
const T_500 = tok('E');
const T_MEMO = tok('M'); // memo test only
const T_NOSETUP = tok('N');
const T_SLOW = tok('S'); // the backend answers this one only when released
const T_HANG = tok('P');
const STREAM: Record<string, string> = { [T_OK]: KEY, [T_BADTYPE]: KEY_BADTYPE, [T_HOSTILE]: KEY_HOSTILE, [T_BIG]: KEY_BIG, [T_LVDOWN]: KEY_DOWN, [T_500]: KEY_500, [T_MEMO]: KEY, [T_NOSETUP]: KEY, [T_SLOW]: KEY, [T_HANG]: KEY_HANG, [T_BADKEY]: '../v1/streams' };
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

const PLAYLIST = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-DISCONTINUITY-SEQUENCE:0',
  '#EXT-X-MAP:URI="init-1.mp4"', '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T20:15:00.000Z', '#EXTINF:4.000,', '5.m4s',
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-12T20:15:04.000Z', '#EXTINF:4.000,', '6.m4s', ''].join('\n');
const SEGMENT = Buffer.alloc(188 * 50, 0x47);

let be: Server, lv: Server, gw: Server, gwPort = 0, lvPort = 0;
const authz: Array<{ token: string; ip: string; secret: string | undefined }> = [];
const lvSeen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
let releaseSlow: (() => void) | null = null;
let hangClosed = 0;
let mediaServer: string | null = null;
let gwMetrics: () => string;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

/** a raw request (no URL normalisation by the client): `..` and odd paths reach the gateway as written */
function raw(path: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: gwPort, path, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const L = (t: string, file: string) => `/media/l/${t}/${file}`;

beforeAll(async () => {
  be = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/internal/authz/live') { res.writeHead(404); return void res.end(); }
      const b = JSON.parse(body) as { token: string; ip: string };
      authz.push({ token: b.token, ip: b.ip, secret: req.headers['x-internal-secret'] as string | undefined });
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (b.token === T_SLOW) {
        const key = STREAM[b.token];
        const gate = new Promise<void>((r) => { releaseSlow = r; });
        return void gate.then(() => send(200, { streamKey: key, kind: 'live', maxAgeS: 2 }));
      }
      if (b.token === T_GONE) return send(410, { error: 'gone' });
      if (b.token === T_FORB) return send(403, { error: 'forbidden' });
      if (b.token === T_DOWN) return send(500, { error: 'internal' });
      const key = STREAM[b.token];
      if (!key) return send(401, { error: 'unauthenticated' });
      return send(200, { streamKey: key, kind: 'live', maxAgeS: 2 });
    });
  });
  lv = createServer((req, res) => {
    lvSeen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const m = /^\/s\/([0-9a-f]{32})\/(.+)$/.exec(req.url ?? '');
    if (!m || req.method !== 'GET') { res.writeHead(404, { 'content-type': 'application/json' }); return void res.end('{"error":"not_found"}'); }
    const [, key, name] = m as unknown as [string, string, string];
    if (key === KEY_HANG) {
      res.on('close', () => { hangClosed++; });
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return void res.write(SEGMENT);
    }
    if (key === KEY_DOWN) return void req.socket.destroy();
    if (key === KEY_500) { res.writeHead(500, { 'content-type': 'application/json' }); return void res.end('{"error":"internal"}'); }
    if (key === KEY_BADTYPE) { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<script>x</script>'); }
    if (key === KEY_HOSTILE && name === 'index.m3u8') {
      const p = PLAYLIST.replace('6.m4s', 'https://iptv.example.com/6.m4s');
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': Buffer.byteLength(p) });
      return void res.end(p);
    }
    if (key === KEY_HOSTILE && name === 'init-1.mp4') { // a hostile URI in a tag attribute is not reachable this way; served plainly
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return void res.end('init');
    }
    if (key === KEY_BIG && name === 'index.m3u8') {
      const big = `#EXTM3U\n${'#EXT-X-PROGRAM-DATE-TIME:2026-11-12T20:15:00.000Z\n'.repeat(Math.ceil((2 * 1024 * 1024) / 47) + 10)}`;
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); // no content-length: the cap is enforced while reading
      return void res.end(big);
    }
    if (key !== KEY) { res.writeHead(404, { 'content-type': 'application/json' }); return void res.end('{"error":"not_found"}'); }
    const send = (type: string, body: Buffer | string, cache: string) => {
      res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': cache, 'x-content-type-options': 'nosniff', etag: '"lv"', 'set-cookie': 'x=1' });
      res.end(body);
    };
    if (name === 'index.m3u8') return send('application/vnd.apple.mpegurl', PLAYLIST, 'no-cache');
    if (name === 'init-1.mp4') return send('video/mp4', 'ftypinit', 'max-age=3600');
    if (name === '5.m4s') return send('video/mp4', SEGMENT, 'max-age=3600');
    if (name === '7.ts') return send('video/mp2t', SEGMENT, 'max-age=3600');
    if (name === '8.ts') return send('video/mp4', SEGMENT, 'max-age=3600'); // a type that does not fit the name
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  const bePort = await listen(be);
  lvPort = await listen(lv);
  const g = createGateway({
    upstreamUrl: () => mediaServer,
    backendUrl: `http://127.0.0.1:${bePort}`,
    livetvUrl: `http://127.0.0.1:${lvPort}`,
    internalSecret: SECRET,
  });
  gw = g.server;
  gwMetrics = g.metrics;
  gwPort = await listen(gw);
});
afterAll(() => { gw?.close(); be?.close(); lv?.close(); });
afterEach(() => { vi.useRealTimers(); });

describe('/media/l/<token>/<file>', () => {
  it('path allowlist', async () => {
    const n = lvSeen.length;
    const a = authz.length;
    const refused = [
      `/media/l/${T_OK}/../x`,
      `/media/l/${T_OK}/../../s/${KEY}/index.m3u8`,
      `${L(T_OK, 'index.m3u8')}?x=1`,
      `${L(T_OK, 'index.m3u8')}?`,
      L(T_OK, '12345678901.ts'),
      L(T_OK, 'seg.ts'),
      L(T_OK, 'index.m3u'),
      L(T_OK, '5.mp4'),
      L(T_OK, 'init-.mp4'),
      L(T_OK, 'init.mp4'), // R16: only init-<n>.mp4
      L(T_OK, '007.ts'), // R16: no leading zeros
      L(T_OK, '00.m4s'),
      L(T_OK, '%35.ts'),
      L(T_OK, 'sub/5.ts'),
      `/media/l/${T_OK}x/index.m3u8`, // 44 chars
      `/media/l/${'A'.repeat(42)}/index.m3u8`,
      `/media/l/${'A'.repeat(42)}./index.m3u8`,
      `/media/l/${T_OK}`,
      '/media/l/',
    ];
    for (const p of refused) {
      const r = await raw(p);
      expect([403, 404], p).toContain(r.status);
      expect(r.headers['access-control-allow-origin'], p).toBe('*');
    }
    expect(lvSeen.length).toBe(n); // nothing forwarded
    expect(authz.length).toBe(a); // and no authz for a refused path
  });

  it('GET, HEAD and OPTIONS only', async () => {
    const n = lvSeen.length;
    const pre = await raw(L(T_OK, 'index.m3u8'), { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(pre.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await raw(L(T_OK, 'index.m3u8'), { method });
      expect(r.status, method).toBe(405);
      expect(r.headers['access-control-allow-origin']).toBe('*');
    }
    expect(lvSeen.length).toBe(n);
    const h = await raw(L(T_OK, '5.m4s'), { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.body.length).toBe(0);
    expect(h.headers['content-type']).toBe('video/mp4');
    expect(h.headers['content-length']).toBe(String(SEGMENT.length));
    expect(lvSeen.slice(n).map((s) => s.method)).toEqual(['GET']); // livetv only answers GET
  });

  it('the token never reaches livetv', async () => {
    const n = lvSeen.length;
    const r = await raw(L(T_OK, '5.m4s'), { headers: {
      cookie: `ff_sid=s; t=${T_OK}`, authorization: `Bearer ${T_OK}`, referer: `https://friend.example.com${L(T_OK, 'index.m3u8')}`,
      range: 'bytes=0-10', 'x-forwarded-for': '192.0.2.7', 'x-real-ip': '192.0.2.7', 'user-agent': 'ReceiverTV/1', 'if-none-match': '"lv"',
    } });
    expect(r.status).toBe(200);
    expect(r.body.equals(SEGMENT)).toBe(true);
    const seen = lvSeen.slice(n);
    expect(seen.map((s) => s.url)).toEqual([`/s/${KEY}/5.m4s`]);
    const h = seen[0]!.headers;
    for (const [k, v] of Object.entries(h)) {
      expect(String(v), k).not.toContain(T_OK);
      expect(String(v), k).not.toContain(sha(T_OK));
    }
    for (const k of ['cookie', 'authorization', 'referer', 'range', 'x-forwarded-for', 'x-real-ip', 'if-none-match', 'x-internal-secret']) expect(h[k], k).toBeUndefined();
    expect(h['user-agent']).not.toBe('ReceiverTV/1');
    // the backend got the token (it is the one that checks it), with the secret and the client address
    expect(authz.filter((a) => a.token === T_OK).pop()).toEqual({ token: T_OK, ip: '192.0.2.7', secret: SECRET });
  });

  it('authz memo 2 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const calls = () => authz.filter((a) => a.token === T_MEMO).length;
    expect((await raw(L(T_MEMO, 'index.m3u8'))).status).toBe(200);
    vi.setSystemTime(Date.now() + 1_900);
    expect((await raw(L(T_MEMO, '5.m4s'))).status).toBe(200);
    expect(calls()).toBe(1);
    // per token AND address: another client of the same token is checked on its own (the backend pins addresses)
    expect((await raw(L(T_MEMO, '5.m4s'), { headers: { 'x-real-ip': '192.0.2.44' } })).status).toBe(200);
    expect(calls()).toBe(2);
    vi.setSystemTime(Date.now() + 2_100);
    expect((await raw(L(T_MEMO, '5.m4s'))).status).toBe(200);
    expect(calls()).toBe(3);
  });

  it('a failing backend answers 503 and is not memoised', async () => {
    const calls = () => authz.filter((a) => a.token === T_DOWN).length;
    const r = await raw(L(T_DOWN, 'index.m3u8'));
    expect(r.status).toBe(503);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect((await raw(L(T_DOWN, 'index.m3u8'))).status).toBe(503);
    expect(calls()).toBe(2);
    // an answer whose stream key is not one never builds a livetv path
    const n = lvSeen.length;
    expect((await raw(L(T_BADKEY, 'index.m3u8'))).status).toBe(503);
    expect(lvSeen.length).toBe(n);
  });

  it('headers per file type', async () => {
    const pl = await raw(L(T_OK, 'index.m3u8'));
    expect(pl.status).toBe(200);
    expect(pl.body.toString()).toBe(PLAYLIST);
    expect(pl.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(pl.headers['cache-control']).toBe('no-store');
    expect(pl.headers['content-length']).toBe(String(Buffer.byteLength(PLAYLIST)));
    for (const [file, type] of [['5.m4s', 'video/mp4'], ['7.ts', 'video/mp2t'], ['init-1.mp4', 'video/mp4']] as const) {
      const r = await raw(L(T_OK, file));
      expect(r.status, file).toBe(200);
      expect(r.headers['content-type'], file).toBe(type);
      expect(r.headers['cache-control'], file).toBe('private, max-age=600');
    }
    for (const r of [pl, await raw(L(T_OK, '7.ts'))]) {
      expect(r.headers['access-control-allow-origin']).toBe('*');
      expect(r.headers['access-control-expose-headers']).toBe('Content-Length, Content-Range, Accept-Ranges');
      expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['set-cookie']).toBeUndefined(); // nothing else of livetv's answer passes
      expect(r.headers.etag).toBeUndefined();
    }
    const hp = await raw(L(T_OK, 'index.m3u8'), { method: 'HEAD' });
    expect(hp.status).toBe(200);
    expect(hp.headers['cache-control']).toBe('no-store');
    expect(hp.body.length).toBe(0);
  });

  it('answer types are allowlisted and must fit the file', async () => {
    const bad = await raw(L(T_BADTYPE, 'index.m3u8'));
    expect(bad.status).toBe(502);
    expect(bad.body.toString()).not.toContain('<script>');
    expect(bad.headers['access-control-allow-origin']).toBe('*');
    expect((await raw(L(T_OK, '8.ts'))).status).toBe(502);
  });

  it('playlists stay at most 2 MB and name only files of the route', async () => {
    expect((await raw(L(T_BIG, 'index.m3u8'))).status).toBe(502);
    expect((await raw(L(T_HOSTILE, 'index.m3u8'))).status).toBe(502);
  });

  it('livetv 404 → 404, unreachable or failing → 503 / 502', async () => {
    const nf = await raw(L(T_OK, '9.ts'));
    expect(nf.status).toBe(404);
    expect(nf.headers['access-control-allow-origin']).toBe('*');
    expect(nf.headers['cache-control']).toBe('no-store');
    const down = await raw(L(T_LVDOWN, 'index.m3u8'));
    expect(down.status).toBe(503);
    expect(down.headers['access-control-allow-origin']).toBe('*');
    expect((await raw(L(T_500, '5.ts'))).status).toBe(502);
  });

  it('410 passes through', async () => {
    const n = lvSeen.length;
    const r = await raw(L(T_GONE, 'index.m3u8'));
    expect(r.status).toBe(410);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await raw(L(T_FORB, 'index.m3u8'))).status).toBe(403);
    expect((await raw(L(T_UNKNOWN, 'index.m3u8'))).status).toBe(401);
    expect(lvSeen.length).toBe(n);
  });

  it('works while the media server is not set up', async () => {
    mediaServer = null;
    expect((await raw(`/media/c/${T_OK}/Videos/${'a'.repeat(32)}/main.m3u8`)).status).toBe(503); // the media paths wait for setup
    const r = await raw(L(T_NOSETUP, 'index.m3u8'));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe(PLAYLIST);
    mediaServer = 'http://192.0.2.20:8096';
    expect((await raw(L(T_NOSETUP, '5.m4s'))).status).toBe(200);
    mediaServer = null;
  });

  it('distinct failing tokens from one address are blocked like cast tokens', async () => {
    const ip = '192.0.2.99';
    const gwIp = '192.0.2.97';
    for (let i = 0; i < 31; i++) { // 403 / 410 are no guessing signal: they never fill the limiter
      expect((await raw(L(i % 2 ? T_GONE : T_FORB, 'index.m3u8'), { headers: { 'x-real-ip': gwIp } })).status).toBe(i % 2 ? 410 : 403);
    }
    expect((await raw(L(T_OK, 'index.m3u8'), { headers: { 'x-real-ip': gwIp } })).status).toBe(200);
    for (let i = 0; i < 31; i++) {
      const t = `Z${String(i).padStart(2, '0')}`.padEnd(43, 'z');
      expect((await raw(L(t, 'index.m3u8'), { headers: { 'x-real-ip': ip } })).status).toBe(401);
    }
    const n = authz.length;
    const r = await raw(L(T_OK, 'index.m3u8'), { headers: { 'x-real-ip': ip } });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('300');
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(authz.length).toBe(n);
    expect((await raw(L(T_OK, 'index.m3u8'), { headers: { 'x-real-ip': '192.0.2.98' } })).status).toBe(200);
  });

  it('a client leaving during authz or mid-segment leaks neither a livetv request nor the gauge', async () => {
    const active = () => Number(/^friendflix_gateway_active_streams (\d+)$/m.exec(gwMetrics())![1]);
    const before = active();
    const n = lvSeen.length;
    const sock = connect(gwPort, '127.0.0.1');
    sock.write(`GET ${L(T_SLOW, '5.m4s')} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await vi.waitFor(() => expect(releaseSlow).not.toBeNull());
    sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
    releaseSlow!();
    await new Promise((r) => setTimeout(r, 150));
    expect(lvSeen.length).toBe(n);
    expect(active()).toBe(before);

    // mid-segment: the gauge returns and livetv's request is aborted
    const closed = hangClosed;
    const s2 = connect(gwPort, '127.0.0.1');
    let got = 0;
    s2.on('data', (c) => { got += c.length; });
    s2.write(`GET ${L(T_HANG, '5.m4s')} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await vi.waitFor(() => { expect(got).toBeGreaterThan(0); expect(active()).toBe(before + 1); });
    s2.destroy();
    await vi.waitFor(() => { expect(active()).toBe(before); expect(hangClosed).toBe(closed + 1); });
  });

  it('metrics carry only code labels', async () => {
    const text = gwMetrics();
    const lines = text.split('\n').filter((l) => l.startsWith('friendflix_gateway_live_requests_total'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^friendflix_gateway_live_requests_total\{code="\d{3}"\} \d+$/);
    for (const code of ['200', '403', '404', '405', '410', '429', '502', '503']) expect(text).toContain(`friendflix_gateway_live_requests_total{code="${code}"}`);
    for (const t of [T_OK, T_GONE, KEY, sha(T_OK)]) expect(text).not.toContain(t);
    expect(text).not.toContain('/media/l/');
  });

  it('the gateway prints nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    try {
      for (const p of [L(T_OK, 'index.m3u8'), L(T_OK, '5.m4s'), L(T_GONE, '5.ts'), L(T_DOWN, '5.ts'), L(T_LVDOWN, '5.ts'), L(T_BADTYPE, '5.ts'), L(T_OK, 'seg.ts'), `${L(T_OK, '5.ts')}?a=1`]) await raw(p);
      await raw(L(T_OK, '5.ts'), { method: 'POST' });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(out.mock.calls.map((c) => String(c[0])).join('')).not.toContain('/media/l');
      expect(err.mock.calls.map((c) => String(c[0])).join('')).not.toContain('/media/l');
      for (const c of [...out.mock.calls, ...err.mock.calls]) expect(String(c[0])).not.toContain(T_OK);
    } finally {
      for (const s of spies) s.mockRestore();
      out.mockRestore();
      err.mockRestore();
    }
  });
});
