// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReplayCache, deriveKey, sign, type Verifier } from '../src/protocol.js';
import { createApp, start, type AppDeps, type Route } from '../src/server.js';
import type { SystemView } from '../src/system.js';

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/livetv-hmac.json', import.meta.url), 'utf8')) as {
  secret: string; cases: Array<{ method: string; path: string; body: string; ts: string; nonce: string; signature: string }>;
};
const key = deriveKey('server-test-secret-0123456789');
const SYSTEM: SystemView = {
  cpu: { model: 'Fictional CPU 9000', cores: 4, loadPct: 12 },
  gpu: { devices: ['/dev/dri/renderD128'], driver: 'i915', readable: true, busyPct: null },
  encoders: ['h264_qsv', 'h264_vaapi', 'libx264'],
  cache: { usedBytes: 1024, maxBytes: 6 * 1024 ** 3 },
  recordings: null,
  srt: { ports: [9000, 9001] },
};
/** a route only this test registers: shows how later tasks add theirs (JSON body parsed, path parameters) */
const echo: Route = { method: 'POST', path: /^\/v1\/echo\/([a-z0-9-]{1,40})$/, handle: async (c) => ({ status: 200, json: { id: c.params[0], body: c.json } }) };
const quiet: Route = { method: 'DELETE', path: '/v1/quiet', handle: async () => ({ status: 204 }) };
const own: Route = { method: 'GET', path: '/v1/own', handle: async (c) => { c.res.writeHead(200, { 'content-type': 'text/plain' }); c.res.end('raw'); } };
const boom: Route = { method: 'GET', path: '/v1/boom', handle: async () => { throw new Error('secret detail'); } };

let server: Server, base: string, verifier: Verifier, warnings: string[];
const deps = (): AppDeps => ({
  get verifier() { return verifier; },
  version: '3.4.0', bootId: '0123456789abcdef',
  system: async () => SYSTEM,
  routes: [echo, quiet, own, boom],
  warn: (m) => warnings.push(m),
});

beforeAll(async () => {
  const app = createApp(deps());
  server = createServer((req, res) => { void app(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  warnings = [];
  verifier = { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 };
});

const call = (method: string, path: string, body = '', o: { headers?: Record<string, string>; unsigned?: boolean } = {}) =>
  fetch(base + path, { method, body: method === 'GET' ? undefined : body, headers: { ...(o.unsigned ? {} : sign(key, method, path, body)), ...(body ? { 'content-type': 'application/json' } : {}), ...o.headers } });

describe('livetv HTTP API', () => {
  it('/healthz is open: ok, api 1, version and a 16-hex boot id', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await r.json() as Record<string, unknown>;
    expect(b).toEqual({ ok: true, api: 1, version: '3.4.0', bootId: '0123456789abcdef' });
    expect(b.bootId).toMatch(/^[0-9a-f]{16}$/);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
  });

  it('unsigned /v1/system is refused (401, code only, logged without detail)', async () => {
    const r = await call('GET', '/v1/system', '', { unsigned: true });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'missing' });
    expect(warnings).toEqual(['refused GET /v1/system: missing']);
  });

  it('signed /v1/system answers cpu, gpu, encoders, cache, srt ports and recordings null', async () => {
    const r = await call('GET', '/v1/system');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual(SYSTEM);
  });

  it('a request signed with the shared vector passes inside its window (same file as the backend client test)', async () => {
    const c = vectors.cases[0]!;
    verifier = { key: deriveKey(vectors.secret), cache: new ReplayCache(), notBefore: 0, now: () => Number(c.ts) };
    const headers = { 'x-ff-livetv-ts': c.ts, 'x-ff-livetv-nonce': c.nonce, 'x-ff-livetv-signature': c.signature };
    expect((await fetch(base + c.path, { headers })).status).toBe(200);
    expect((await fetch(base + c.path, { headers })).status).toBe(401); // replay
  });

  it('the query string is part of what is signed', async () => {
    const h = sign(key, 'GET', '/v1/system', '');
    expect((await fetch(`${base}/v1/system?x=1`, { headers: h })).status).toBe(401);
    expect((await fetch(`${base}/v1/system?x=1`, { headers: sign(key, 'GET', '/v1/system?x=1', '') })).status).toBe(200);
  });

  it('a body over 64 KB is refused with 413 before the signature is checked', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
    const r = await call('POST', '/v1/echo/a', big);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'too_large' });
    // also without a content-length header (chunked)
    const chunked = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/v1/echo/a`);
      const q = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      q.on('error', reject);
      for (let i = 0; i < 70; i++) q.write('x'.repeat(1024));
      q.end();
    });
    expect(chunked).toBe(413);
    // just under the cap passes
    const ok = await call('POST', '/v1/echo/a', JSON.stringify({ pad: 'x'.repeat(60 * 1024) }));
    expect(ok.status).toBe(200);
  });

  it('JSON only: another content type is 415, broken JSON 400; a route gets the parsed body and its path parameters', async () => {
    expect((await call('POST', '/v1/echo/a', 'a=1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    const bad = await call('POST', '/v1/echo/a', '{nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_body' });
    const r = await call('POST', '/v1/echo/nordlicht-tv', '{"channelId":"ch-1"}');
    expect(await r.json()).toEqual({ id: 'nordlicht-tv', body: { channelId: 'ch-1' } });
    const empty = await call('POST', '/v1/echo/b', '');
    expect(await empty.json()).toEqual({ id: 'b', body: null });
  });

  it('unknown paths are 404, a known path with another method 405', async () => {
    expect((await call('GET', '/v1/nothing')).status).toBe(404);
    expect(await (await call('GET', '/v1/nothing', '', { unsigned: true })).json()).toEqual({ error: 'not_found' });
    expect((await call('GET', '/nothing')).status).toBe(404);
    expect((await call('GET', '/v1/echo/UPPER')).status).toBe(404);
    expect((await call('PUT', '/v1/system', '{}')).status).toBe(405);
  });

  it('/s/* is unsigned and has no files yet (404)', async () => {
    const r = await fetch(`${base}/s/0123456789abcdef0123456789abcdef/index.m3u8`);
    expect(r.status).toBe(404);
    expect(warnings).toEqual([]);
  });

  it('a route may answer without a body or write the response itself; a failing route is a bare 500', async () => {
    const q = await call('DELETE', '/v1/quiet');
    expect(q.status).toBe(204);
    const own = await call('GET', '/v1/own');
    expect(await own.text()).toBe('raw');
    const b = await call('GET', '/v1/boom');
    expect(b.status).toBe(500);
    expect(await b.json()).toEqual({ error: 'internal' });
    expect(warnings).toEqual(['route GET /v1/boom failed']);
  });
});

describe('start', () => {
  it('listens on PORT with the secret from the environment and answers /healthz with a random boot id', async () => {
    const port = await new Promise<number>((r) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
    const logs: string[] = [];
    const s = await start({ PORT: String(port), INTERNAL_SECRET: 'start-test-secret-0123456789', APP_VERSION: '3.4.0', LIVETV_SRT_PORTS: '9000' }, { log: (m) => logs.push(m), host: '127.0.0.1' });
    try {
      const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as { bootId: string; version: string };
      expect(h.bootId).toMatch(/^[0-9a-f]{16}$/);
      expect(h.version).toBe('3.4.0');
      const k = deriveKey('start-test-secret-0123456789');
      const r = await fetch(`http://127.0.0.1:${port}/v1/system`, { headers: sign(k, 'GET', '/v1/system', '') });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ srt: { ports: [9000] }, recordings: null, cache: { maxBytes: 6 * 1024 ** 3 } });
      expect(logs.join('\n')).toContain(`listening on :${port}`);
      expect(logs.join('\n')).not.toContain('start-test-secret');
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
