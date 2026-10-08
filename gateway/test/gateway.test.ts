import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, normalizePath } from '../src/gateway.js';

const ID = 'a'.repeat(32);
let jf: Server, be: Server, gw: Server;
let gwPort: number;
const seen: Array<{ url: string; auth?: string; range?: string }> = [];

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  jf = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization, range: req.headers.range });
    if (req.url!.includes('redirect')) return void res.writeHead(302, { location: 'http://evil.example/' }).end();
    const payload = Buffer.alloc(1_000_000, 1);
    if (req.headers.range) {
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99/1000000', 'content-length': '100', 'set-cookie': 'x=1' });
      return void res.end(payload.subarray(0, 100));
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'set-cookie': 'x=1' });
    res.end(payload);
  });
  be = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.headers['x-internal-secret'] !== 's3cret-s3cret-s3cret') return void res.writeHead(403).end();
      const ok = JSON.parse(b).sid === 'goodsid';
      if (!ok) return void res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ userId: 'u1', token: 'JFTOKEN', deviceId: 'ff-u1', maxBitrate: 5_000_000 }));
    });
  });
  const jfp = await listen(jf);
  const bep = await listen(be);
  const g = createGateway({ jellyfinUrl: `http://127.0.0.1:${jfp}`, backendUrl: `http://127.0.0.1:${bep}`, internalSecret: 's3cret-s3cret-s3cret' });
  gw = g.server;
  gwPort = await listen(gw);
});
afterAll(() => [jf, be, gw].forEach((s) => s.close()));

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${gwPort}${path}`, { headers: { cookie: 'ff_sid=goodsid', ...headers } });

describe('normalizePath', () => {
  it('accepts allowed paths and rejects traversal / others', () => {
    expect(normalizePath(`/Videos/${ID}/master.m3u8`)).toBe(`/Videos/${ID}/master.m3u8`);
    expect(normalizePath(`/Videos/${ID}/hls1/main/0.ts`)).toBeTruthy();
    expect(normalizePath(`/Videos/${ID}/%2e%2e/x`)).toBeNull();
    expect(normalizePath(`/Videos/${ID}/hls1/main/..%2f..%2fetc`)).toBeNull();
    expect(normalizePath('/System/Info')).toBeNull();
    expect(normalizePath('/Users/x/Policy')).toBeNull();
    expect(normalizePath(`//evil.example/Videos/${ID}/master.m3u8`)).toBeNull();
  });
});

describe('gateway', () => {
  it('requires a valid session', async () => {
    const r = await fetch(`http://127.0.0.1:${gwPort}/media/Videos/${ID}/master.m3u8`);
    expect(r.status).toBe(401);
    const r2 = await fetch(`http://127.0.0.1:${gwPort}/media/Videos/${ID}/master.m3u8`, { headers: { cookie: 'ff_sid=bad' } });
    expect(r2.status).toBe(401);
  });
  it('blocks non-allowlisted paths', async () => {
    expect((await get('/media/System/Info')).status).toBe(403);
    expect((await get('/media/Users/abc/Policy')).status).toBe(403);
  });
  it('injects the token server-side, strips api keys, clamps bitrate, drops set-cookie', async () => {
    seen.length = 0;
    const r = await get(`/media/Videos/${ID}/master.m3u8?api_key=LEAK&MaxStreamingBitrate=999999999&MediaSourceId=x`);
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect((await r.arrayBuffer()).byteLength).toBe(1_000_000);
    const u = seen[0]!;
    expect(u.auth).toContain('Token="JFTOKEN"');
    expect(u.url).not.toContain('LEAK');
    expect(u.url).toContain('MaxStreamingBitrate=5000000');
    expect(u.url).toContain('MediaSourceId=x');
  });
  it('passes HTTP Range through (206)', async () => {
    const r = await get(`/media/Videos/${ID}/stream?static=true`, { range: 'bytes=0-99' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-99/1000000');
    expect(seen.at(-1)!.range).toBe('bytes=0-99');
  });
  it('never follows upstream redirects', async () => {
    expect((await get(`/media/Videos/${ID}/master.m3u8?redirect=1`)).status).toBe(502);
  });
  it('exposes metrics', async () => {
    const t = await (await fetch(`http://127.0.0.1:${gwPort}/metrics`)).text();
    expect(t).toContain('friendflix_gateway_bytes_total');
  });
});
