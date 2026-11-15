// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV recordings: `/media/r/<token>/<file>` (plan Phase 3 Task 5). A fake backend answers `/internal/authz/rec`, the recordings
 * volume is a temporary folder, and the REAL gateway sits in front, without a media server.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REC_FILE, createGateway } from '../src/gateway.js';

const SECRET = 'internal-secret-for-tests';
const DIR = '0f000000-0000-4000-a000-0000000000d1';
const DIR_GROWING = '0f000000-0000-4000-a000-0000000000d2';
const DIR_LINKED = '0f000000-0000-4000-a000-0000000000d3';
const tok = (c: string) => c.repeat(43);
const T_DONE = tok('A');
const T_GROWING = tok('B');
const T_GONE = tok('G');
const T_FORB = tok('F');
const T_BADDIR = tok('X'); // the backend answers a folder that is no uuid
const T_LINKED = tok('L');
const T_DOWN = tok('D');
const DIRS: Record<string, { dir: string; growing: boolean }> = {
  [T_DONE]: { dir: DIR, growing: false }, [T_GROWING]: { dir: DIR_GROWING, growing: true }, [T_BADDIR]: { dir: '../etc', growing: false }, [T_LINKED]: { dir: DIR_LINKED, growing: false },
};
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PROGRAM-DATE-TIME:2026-11-15T19:58:00.000Z\n#EXTINF:4.000,\n0.ts\n#EXT-X-ENDLIST\n';
const SEGMENT = Buffer.from(Array.from({ length: 188 * 20 }, (_, i) => i % 251));

let root = '';
let outside = '';
let be: Server;
let gw: Server;
let gwNoDir: Server;
let gwPort = 0;
let gwNoDirPort = 0;
const authz: Array<{ token: string; ip: string }> = [];
let metrics: () => string;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
function raw(path: string, o: { method?: string; headers?: Record<string, string>; port?: number } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: o.port ?? gwPort, path, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const R = (t: string, file: string) => `/media/r/${t}/${file}`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gw-rec-'));
  outside = mkdtempSync(join(tmpdir(), 'gw-outside-'));
  for (const d of [DIR, DIR_GROWING]) {
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, 'index.m3u8'), PLAYLIST);
    writeFileSync(join(root, d, '0.ts'), SEGMENT);
    writeFileSync(join(root, d, 'init-0.mp4'), 'ftypinit');
  }
  writeFileSync(join(outside, '0.ts'), 'secret');
  symlinkSync(outside, join(root, DIR_LINKED)); // a planted link where a folder should be
  symlinkSync(join(outside, '0.ts'), join(root, DIR, '1.ts')); // and one as a segment
  be = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/internal/authz/rec' || req.headers['x-internal-secret'] !== SECRET) { res.writeHead(404); return void res.end(); }
      const b = JSON.parse(body) as { token: string; ip: string };
      authz.push(b);
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (b.token === T_GONE) return send(410, { error: 'gone' });
      if (b.token === T_FORB) return send(403, { error: 'forbidden' });
      if (b.token === T_DOWN) return send(500, { error: 'internal' });
      const d = DIRS[b.token];
      return d ? send(200, { ...d, maxAgeS: 2 }) : send(401, { error: 'unauthenticated' });
    });
  });
  const bePort = await listen(be);
  const g = createGateway({ upstreamUrl: () => null, backendUrl: `http://127.0.0.1:${bePort}`, internalSecret: SECRET, recordingsDir: root });
  gw = g.server;
  metrics = g.metrics;
  gwPort = await listen(gw);
  gwNoDir = createGateway({ upstreamUrl: () => null, backendUrl: `http://127.0.0.1:${bePort}`, internalSecret: SECRET }).server;
  gwNoDirPort = await listen(gwNoDir);
});
afterAll(async () => {
  for (const s of [gw, gwNoDir, be]) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('/media/r/<token>/<file>', () => {
  it('path allowlist refuses ../ and unknown names', async () => {
    expect(['index.m3u8', 'init-0.mp4', '0.ts', '17.m4s'].every((f) => REC_FILE.test(f))).toBe(true);
    expect(['../x', 'index.m3u8.part', 'a.ts', '0.mp4', 'init-12345.mp4', '01234567890.ts', '.ts', 'dl'].some((f) => REC_FILE.test(f))).toBe(false);
    const before = authz.length;
    for (const p of [R(T_DONE, '..%2F..%2Fetc'), `/media/r/${T_DONE}/../${DIR}/0.ts`, R(T_DONE, 'secret.txt'), R(T_DONE, 'index.m3u8.part'), `/media/r/${T_DONE}/sub/0.ts`, `/media/r/short/0.ts`]) {
      expect((await raw(p)).status, p).toBe(403);
    }
    expect((await raw(`${R(T_DONE, '0.ts')}?x=1`)).status).toBe(403); // no query
    expect(authz.length).toBe(before); // refused before the backend was asked
    // a folder the backend names must be a uuid; a planted link is never followed (folder or segment)
    expect((await raw(R(T_BADDIR, '0.ts'))).status).toBe(503);
    expect((await raw(R(T_LINKED, '0.ts'))).status).toBe(404);
    expect((await raw(R(T_DONE, '1.ts'))).status).toBe(404);
  });

  it('serves the playlist and a range of a segment; cache rules by state', async () => {
    const done = await raw(R(T_DONE, 'index.m3u8'));
    expect([done.status, done.headers['content-type'], done.headers['cache-control'], done.body.toString()]).toEqual([200, 'application/vnd.apple.mpegurl', 'private, max-age=60', PLAYLIST]);
    expect(done.headers['access-control-allow-origin']).toBe('*');
    expect(done.headers['cross-origin-resource-policy']).toBe('cross-origin');
    const growing = await raw(R(T_GROWING, 'index.m3u8'));
    expect(growing.headers['cache-control']).toBe('no-store');
    const seg = await raw(R(T_DONE, '0.ts'), { headers: { range: 'bytes=100-199' } });
    expect([seg.status, seg.headers['content-range'], seg.headers['content-length'], seg.headers['content-type'], seg.headers['cache-control']])
      .toEqual([206, `bytes 100-199/${SEGMENT.length}`, '100', 'video/mp2t', 'private, max-age=3600']);
    expect(seg.body).toEqual(SEGMENT.subarray(100, 200));
    expect((await raw(R(T_DONE, '0.ts'), { headers: { range: 'bytes=0-1,5-6' } })).status).toBe(416);
    expect((await raw(R(T_DONE, 'init-0.mp4'))).headers['content-type']).toBe('video/mp4');
    const head = await raw(R(T_DONE, '0.ts'), { method: 'HEAD' });
    expect([head.status, head.headers['content-length'], head.body.length]).toEqual([200, String(SEGMENT.length), 0]);
    expect((await raw(R(T_DONE, '0.ts'), { method: 'POST' })).status).toBe(405);
    expect((await raw(R(T_DONE, '0.ts'), { method: 'OPTIONS' })).status).toBe(204);
  });

  it('a removed file is 404, never a partial body', async () => {
    writeFileSync(join(root, DIR, '5.ts'), SEGMENT);
    expect((await raw(R(T_DONE, '5.ts'))).status).toBe(200);
    unlinkSync(join(root, DIR, '5.ts'));
    const r = await raw(R(T_DONE, '5.ts'));
    expect([r.status, r.body.toString()]).toEqual([404, 'not found']);
    expect(r.headers['content-length']).toBeUndefined();
  });

  it('refusals of the backend, a missing mount and a failing backend', async () => {
    expect((await raw(R(T_GONE, 'index.m3u8'))).status).toBe(410);
    expect((await raw(R(T_FORB, 'index.m3u8'))).status).toBe(403);
    expect((await raw(R(tok('Z'), 'index.m3u8'))).status).toBe(401);
    expect((await raw(R(T_DOWN, 'index.m3u8'))).status).toBe(503);
    expect((await raw(R(T_DONE, 'index.m3u8'), { port: gwNoDirPort })).status).toBe(503);
    expect(metrics()).toMatch(/friendflix_gateway_rec_requests_total\{code="410"\} \d+/);
  });

  it('token never in a log line or a metric', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    try {
      await raw(R(T_DONE, '0.ts'));
      await raw(R(T_GONE, '0.ts'));
      await raw(R(tok('Q'), '0.ts'));
      const all = lines.join('\n') + metrics();
      for (const t of [T_DONE, T_GONE, tok('Q'), DIR]) expect(all).not.toContain(t.slice(0, 20));
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});
