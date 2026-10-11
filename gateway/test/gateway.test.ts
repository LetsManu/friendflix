import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, normalizeCastPath, normalizePath, sanitizePlaylist } from '../src/gateway.js';

const ID = 'a'.repeat(32);
let jf: Server, be: Server, gw: Server;
let gwPort: number;
const seen: Array<{ url: string; auth?: string; range?: string; acceptEncoding?: string; cookie?: string }> = [];
const authzBodies: string[] = [];
const MS = 'b'.repeat(32);
const CT = 'A'.repeat(43); // valid cast token of the fake backend
const CT_BAD = 'B'.repeat(43);
const castBase = `/media/c/${CT}`;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  jf = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization, range: req.headers.range, acceptEncoding: req.headers['accept-encoding'], cookie: req.headers.cookie });
    if (req.url!.includes('/main.m3u8')) {
      const body = req.url!.includes('evil=1')
        ? '#EXTM3U\nhttps://evil.example/seg.ts\n'
        : req.url!.includes('evil=2')
          ? '#EXTM3U\n/Videos/x/hls1/main/0.ts\n'
          : `#EXTM3U\n#EXT-X-MAP:URI="init.mp4?api_key=LEAK2&x=1"\n#EXTINF:3,\nhls1/main/0.ts?MediaSourceId=${MS}&api_key=LEAK&PlaySessionId=ps-1&ApiKey=LEAK3\n`;
      return void res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', etag: '"pl"' }).end(body);
    }
    if (req.url!.includes('/Images/')) return void res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=60', etag: '"abc"' }).end('img');
    if (req.url!.includes('/stream')) { /* falls through to range handling below */ }
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
      const j = JSON.parse(b);
      authzBodies.push(b);
      if (j.ct !== undefined) {
        if (j.ct === 'E'.repeat(43)) return void res.writeHead(500).end();
        if (j.ct !== CT) return void res.writeHead(401).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ userId: 'u1', token: 'CASTJF', deviceId: 'ff-u1', maxBitrate: 5_000_000, scope: { itemId: ID, mediaSourceId: MS, playSessionId: 'ps-1' } }));
      }
      const ok = j.sid === 'goodsid';
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

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as { allow: string[]; deny: string[] };
describe('shared allowlist vectors', () => {
  it.each(vectors.allow)('allows %s', (p) => expect(normalizePath(p)).toBeTruthy());
  it.each(vectors.deny)('denies %s', (p) => expect(normalizePath(p)).toBeNull());
});

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
  it('asks upstream for identity encoding so relayed content-length matches the body', async () => {
    seen.length = 0;
    const r = await get(`/media/Videos/${ID}/master.m3u8`);
    expect(r.status).toBe(200);
    expect(seen.at(-1)!.acceptEncoding).toBe('identity');
  });
  it('never follows upstream redirects', async () => {
    expect((await get(`/media/Videos/${ID}/master.m3u8?redirect=1`)).status).toBe(502);
  });
  it('makes images browser-cacheable but private; media stays uncacheable', async () => {
    const img = await get(`/media/Items/${ID}/Images/Backdrop?maxWidth=480&tag=t1`);
    expect(img.status).toBe(200);
    expect(img.headers.get('cache-control')).toBe('private, max-age=86400, stale-while-revalidate=604800');
    expect(img.headers.get('etag')).toBe('"abc"');
    expect(img.headers.get('vary')).toBe('Cookie');
    const pl = await get(`/media/Videos/${ID}/master.m3u8`);
    expect(pl.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects oversized queries', async () => {
    expect((await get(`/media/Videos/${ID}/master.m3u8?x=${'a'.repeat(3000)}`)).status).toBe(414);
    expect((await get(`/media/Videos/${ID}/master.m3u8?${Array.from({ length: 45 }, (_, i) => `p${i}=1`).join('&')}`)).status).toBe(414);
  });
  it('exposes metrics', async () => {
    const t = await (await fetch(`http://127.0.0.1:${gwPort}/metrics`)).text();
    expect(t).toContain('friendflix_gateway_bytes_total');
  });
});

const cget = (path: string, headers: Record<string, string> = {}, base = castBase) => fetch(`http://127.0.0.1:${gwPort}${base}${path}`, { headers });
const castVectors = (JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as { cast: { allow: string[]; deny: string[] } }).cast;

describe('cast allowlist vectors', () => {
  it.each(castVectors.allow)('allows %s', (p) => expect(normalizeCastPath(p)).toBeTruthy());
  it.each(castVectors.deny)('denies %s', (p) => expect(normalizeCastPath(p)).toBeNull());
});

describe('sanitizePlaylist', () => {
  it('strips token params and rejects absolute URIs', () => {
    expect(sanitizePlaylist('#EXTM3U\nhls1/main/0.ts?a=1&api_key=X&ApiKey=Y\n')).toBe('#EXTM3U\nhls1/main/0.ts?a=1\n');
    expect(sanitizePlaylist('#EXT-X-MAP:URI="i.mp4?api_key=X"')).toBe('#EXT-X-MAP:URI="i.mp4"');
    expect(sanitizePlaylist('http://x/y.ts')).toBeNull();
    expect(sanitizePlaylist('//x/y.ts')).toBeNull();
    expect(sanitizePlaylist('/Videos/a/b.ts')).toBeNull();
    expect(sanitizePlaylist('#EXT-X-MAP:URI="https://x/i.mp4"')).toBeNull();
  });
});

describe('cast route /media/c/<token>/', () => {
  it('streams playlist + segment with the profile token in the header and the cast token never upstream', async () => {
    seen.length = 0;
    const m = await cget(`/Videos/${ID}/master.m3u8?MediaSourceId=${MS}&PlaySessionId=ps-1&DeviceId=d`);
    expect(m.status).toBe(200);
    expect(m.headers.get('access-control-allow-origin')).toBe('*');
    expect(m.headers.get('access-control-expose-headers')).toContain('Content-Range');
    expect(m.headers.get('cache-control')).toBe('no-store');
    await m.arrayBuffer();
    const seg = await cget(`/Videos/${ID}/hls1/main/0.ts?MediaSourceId=${MS}&PlaySessionId=ps-1`, { range: 'bytes=0-99' });
    expect(seg.status).toBe(206);
    expect(seg.headers.get('access-control-allow-origin')).toBe('*');
    expect(seg.headers.get('access-control-expose-headers')).toContain('Accept-Ranges');
    for (const u of seen) {
      expect(u.auth).toContain('Token="CASTJF"');
      expect(u.url).not.toContain(CT);
      expect(u.url).not.toContain('/media/c');
      expect(u.url.startsWith(`/Videos/${ID}/`)).toBe(true);
    }
    expect(seen.at(-1)!.range).toBe('bytes=0-99');
  });
  it('clamps bitrate to the token limit', async () => {
    seen.length = 0;
    await (await cget(`/Videos/${ID}/master.m3u8?MaxStreamingBitrate=999999999&MediaSourceId=${MS}`)).arrayBuffer();
    expect(seen[0]!.url).toContain('MaxStreamingBitrate=5000000');
  });
  it('sends only the token to the backend authz (never a cookie) and ignores cookies on this path', async () => {
    authzBodies.length = 0;
    seen.length = 0;
    const r = await cget(`/Images-ignored`, { cookie: 'ff_sid=goodsid' });
    expect(r.status).toBe(403);
    const ok = await cget(`/Videos/${ID}/master.m3u8`, { cookie: 'ff_sid=goodsid' });
    await ok.arrayBuffer();
    expect(seen.every((u) => u.cookie === undefined)).toBe(true);
    expect(authzBodies.every((b) => !b.includes('goodsid'))).toBe(true);
    const bad = await cget(`/Videos/${ID}/master.m3u8`, { cookie: 'ff_sid=goodsid' }, `/media/c/${CT_BAD}`);
    expect(bad.status).toBe(401); // a valid cookie does not help with a bad token
  });
  it('denies a different item, a different MediaSourceId / PlaySessionId (403)', async () => {
    expect((await cget(`/Videos/${'c'.repeat(32)}/master.m3u8`)).status).toBe(403);
    expect((await cget(`/Items/${'c'.repeat(32)}/Images/Primary`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8?MediaSourceId=${'c'.repeat(32)}`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8?mediasourceid=${MS}&mediasourceid=${'c'.repeat(32)}`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8?playsessionid=other`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/${'c'.repeat(32)}/Subtitles/1/0/Stream.vtt`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/${MS}/Subtitles/1/0/Stream.vtt`)).status).toBe(200);
    expect((await cget(`/Items/${ID}/Images/Primary?maxWidth=600`)).status).toBe(200);
  });
  it('blocks /stream, Trickplay and other non-cast paths', async () => {
    expect((await cget(`/Videos/${ID}/stream?static=true`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/Trickplay/320/0.jpg`)).status).toBe(403);
    expect((await cget(`/Items/${ID}/Images/Logo`)).status).toBe(403);
    expect((await cget(`/System/Info`)).status).toBe(403);
  });
  it('401 for bad/unknown tokens, 403 for malformed ones, 503 (not 401) when the backend fails', async () => {
    expect((await cget(`/Videos/${ID}/master.m3u8`, {}, `/media/c/${CT_BAD}`)).status).toBe(401);
    expect((await cget(`/Videos/${ID}/master.m3u8`, {}, `/media/c/short`)).status).toBe(403);
    expect((await cget(`/Videos/${ID}/master.m3u8`, {}, `/media/c/${'E'.repeat(43)}`)).status).toBe(503);
  });
  it('answers CORS preflight on the cast path only (no credentials), cookie path stays without CORS', async () => {
    const o = await fetch(`http://127.0.0.1:${gwPort}${castBase}/Videos/${ID}/master.m3u8`, { method: 'OPTIONS', headers: { origin: 'https://x', 'access-control-request-method': 'GET' } });
    expect(o.status).toBe(204);
    expect(o.headers.get('access-control-allow-origin')).toBe('*');
    expect(o.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    expect(o.headers.get('access-control-allow-headers')).toBe('Range, Content-Type');
    expect(o.headers.get('access-control-max-age')).toBe('600');
    expect(o.headers.get('access-control-allow-credentials')).toBeNull();
    const c = await get(`/media/Videos/${ID}/master.m3u8`, { origin: 'https://x' });
    expect(c.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`http://127.0.0.1:${gwPort}/media/Videos/${ID}/master.m3u8`, { method: 'OPTIONS' })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${gwPort}${castBase}/Videos/${ID}/master.m3u8`, { method: 'POST' })).status).toBe(405);
  });
  it('sanitizes playlists: strips api_key params, keeps the rest', async () => {
    const r = await cget(`/Videos/${ID}/main.m3u8?MediaSourceId=${MS}`);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).not.toMatch(/LEAK|api_key|ApiKey/i);
    expect(t).toContain(`hls1/main/0.ts?MediaSourceId=${MS}&PlaySessionId=ps-1`);
    expect(t).toContain('URI="init.mp4?x=1"');
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(t)));
  });
  it('502 for playlists with absolute URIs', async () => {
    expect((await cget(`/Videos/${ID}/main.m3u8?evil=1`)).status).toBe(502);
    expect((await cget(`/Videos/${ID}/main.m3u8?evil=2`)).status).toBe(502);
  });
  it('exposes a cast metric without the token', async () => {
    const t = await (await fetch(`http://127.0.0.1:${gwPort}/metrics`)).text();
    expect(t).toContain('friendflix_gateway_cast_requests_total{code="200"}');
    expect(t).not.toContain(CT);
  });
});

describe('cast failed-auth rate limit', () => {
  it('blocks a client address after >30 failures/min with 429 (even for a valid token)', async () => {
    const h = { 'x-real-ip': '198.51.100.7' };
    const bad = `/media/c/${CT_BAD}`;
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await cget(`/Videos/${ID}/master.m3u8`, h, bad)).status;
    expect(last).toBe(429);
    const r = await cget(`/Videos/${ID}/master.m3u8`, h);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('300');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    // other addresses are unaffected
    expect((await cget(`/Videos/${ID}/master.m3u8`, { 'x-real-ip': '198.51.100.8' })).status).toBe(200);
  });
});
