// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GuardDeps } from '../src/fetch.js';
import { ReplayCache, sign } from '../src/protocol.js';
import { fetchRoutes } from '../src/routes/fetch.js';
import type { Run } from '../src/run.js';
import { createApp, start } from '../src/server.js';
import type { SystemView } from '../src/system.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
/** what the bootstrap service writes into livetv's key file; livetv itself derives nothing */
const deriveKey = (secret: string) => createHmac('sha256', secret).update('friendflix-livetv/v1').digest();
const key = deriveKey('fetch-routes-test-secret-0123');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

// The provider: a local server reached through `dial` (every checked address maps onto it).
let provider: http.Server, port = 0;
const providerRoutes: Record<string, (res: http.ServerResponse) => void> = {
  '/get.php': (res) => res.end(fixture('provider.m3u')),
  '/html.m3u': (res) => res.end('<html>Login</html>'),
  '/big.m3u': (res) => { res.writeHead(200, { 'content-length': String(60 * 1024 * 1024) }); res.end(); },
  '/epg.xml.gz': (res) => res.end(fixture('guide.xml.gz')),
  '/broken.xml': (res) => res.end(fixture('guide.xml').subarray(0, 900)),
  '/doctype.xml': (res) => res.end(fixture('doctype.xml')),
  '/logo.png': (res) => res.end(PNG),
  '/logo.svg': (res) => { res.setHeader('content-type', 'image/png'); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); },
  '/huge.png': (res) => res.end(Buffer.concat([PNG, Buffer.alloc(600 * 1024)])),
  '/stream.ts': (res) => res.end(Buffer.alloc(1000, 0x47)),
  // a guide that never ends and holds nothing for the window: the route has nothing to write while it downloads
  '/endless.xml': (res) => {
    res.writeHead(200);
    res.write('<tv>');
    const t = setInterval(() => res.write('<programme start="20200101200000" stop="20200101210000" channel="fremd"><title>Wetter am Hafen</title></programme>'), 20);
    res.on('close', () => { clearInterval(t); endlessDone(); });
    endlessStarted();
  },
  '/many-groups.m3u': (res) => {
    const out = ['#EXTM3U'];
    for (let i = 0; i <= 2000; i++) out.push(`#EXTINF:-1 group-title="Gruppe ${i}",Kanal Wolkenlos ${i}`, `http://iptv.example.com/live/${i}.ts`);
    res.end(out.join('\n'));
  },
};
let endlessStarted: () => void = () => {};
let endlessDone: () => void = () => {};
const endlessOpened = new Promise<void>((r) => { endlessStarted = r; });
const endlessClosed = new Promise<void>((r) => { endlessDone = r; });
const seen: Array<{ path: string; ua?: string }> = [];
const lookups: string[] = [];
const guard: GuardDeps = { own: [], lookup: async (h) => { lookups.push(h); return h === 'lan.example.com' ? ['192.168.1.20'] : ['192.0.2.40']; }, dial: () => '127.0.0.1' };
const runCalls: string[][] = [];
const run: Run = async (_cmd, args, o) => {
  runCalls.push(args);
  if (o.stdin) for await (const _ of o.stdin) { /* drain */ }
  return { code: 0, stdout: fixture('ffprobe-h264-aac.json'), stderr: '' };
};

let api: http.Server, base = '';
const warnings: string[] = [];
beforeAll(async () => {
  provider = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    seen.push({ path, ua: req.headers['user-agent'] });
    const h = new Map(Object.entries(providerRoutes)).get(path);
    if (h) h(res);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  port = (provider.address() as AddressInfo).port;
  const app = createApp({
    verifier: { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 }, version: null, bootId: '0123456789abcdef',
    system: async () => ({}) as SystemView, routes: fetchRoutes({ guard, run }), warn: (m) => warnings.push(m),
  });
  api = http.createServer((req, res) => { void app(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of [api, provider]) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
});
afterEach(() => { seen.length = 0; runCalls.length = 0; });

const post = (path: string, body: unknown, signal?: AbortSignal) => {
  const s = JSON.stringify(body);
  return fetch(base + path, { method: 'POST', body: s, headers: { ...sign(key, 'POST', path, s), 'content-type': 'application/json' }, signal });
};
const p = (path: string) => `http://iptv.example.com:${port}${path}`;
const ndjson = async (r: Response) => (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('POST /v1/fetch/m3u', () => {
  it('a signed call answers entries, groups, listed and skipped; the user agent is sent', async () => {
    const r = await post('/v1/fetch/m3u', { url: p('/get.php?username=anna&password=geheim'), userAgent: 'Nordlicht-Box/2.0', allowLan: false, skipGroups: ['Kinder'] });
    expect(r.status).toBe(200);
    const b = await r.json() as { entries: Array<{ name: string; pos: number }>; groups: unknown; listed: number; skipped: unknown };
    expect(b.entries.map((e) => e.name)).toEqual(['Nordlicht TV HD', 'Hafenkanal', 'Bergblick Sport', 'Sternwarte 24']);
    expect(b.entries[3]!.pos).toBe(5);
    expect(b.groups).toEqual([{ name: 'DE | Sport', channels: 3 }, { name: 'Kinder', channels: 2 }, { name: 'Nachrichten', channels: 1 }]);
    expect(b.listed).toBe(6);
    expect(b.skipped).toEqual({ vod: 2, invalid: 0, overLimit: 0, groups: 2 });
    expect(seen).toEqual([{ path: '/get.php', ua: 'Nordlicht-Box/2.0' }]);
  });

  it('a near-max skip list (2 000 names of 200 characters, over 64 KB) is accepted; other routes keep the 64 KB cap', async () => {
    const skipGroups = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, '0')}${'g'.repeat(196)}`);
    expect(JSON.stringify({ skipGroups }).length).toBeGreaterThan(400_000);
    const r = await post('/v1/fetch/m3u', { url: p('/get.php'), allowLan: false, skipGroups });
    expect(r.status).toBe(200);
    const over = await post('/v1/fetch/m3u', { url: p('/get.php'), allowLan: false, skipGroups: ['x'.repeat(520 * 1024)] });
    expect(over.status).toBe(413);
    const other = await post('/v1/fetch/xmltv', { url: p('/epg.xml.gz'), allowLan: false, channels: ['x'.repeat(70 * 1024)] });
    expect(other.status).toBe(413);
  });

  it('provider and fetch failures are 422 with a fixed code, never the URL', async () => {
    const cases: Array<[unknown, string]> = [
      [{ url: p('/html.m3u'), allowLan: false }, 'not_m3u'],
      [{ url: p('/many-groups.m3u'), allowLan: false }, 'too_big'],
      [{ url: p('/missing.m3u'), allowLan: false }, 'not_found'],
      [{ url: p('/big.m3u'), allowLan: false }, 'too_big'],
      [{ url: `http://lan.example.com:${port}/get.php`, allowLan: false }, 'address_refused'],
      [{ url: 'http://backend:3000/get.php', allowLan: false }, 'address_refused'],
      [{ url: 'ftp://iptv.example.com/list.m3u', allowLan: false }, 'scheme'],
    ];
    for (const [body, code] of cases) {
      const r = await post('/v1/fetch/m3u', body);
      const text = await r.text();
      expect([r.status, text]).toEqual([422, JSON.stringify({ error: code })]);
    }
    expect((await post('/v1/fetch/m3u', { url: `http://lan.example.com:${port}/get.php`, allowLan: true })).status).toBe(200);
  });

  it('a body that fails the schema is 400 invalid with the field', async () => {
    const cases: Array<[unknown, string]> = [
      [null, 'body'], [[], 'body'], [{ allowLan: false }, 'url'], [{ url: 'kein url', allowLan: false }, 'url'], [{ url: 'x'.repeat(9000), allowLan: false }, 'url'],
      [{ url: p('/get.php') }, 'allowLan'], [{ url: p('/get.php'), allowLan: 'ja' }, 'allowLan'],
      [{ url: p('/get.php'), allowLan: false, userAgent: 'a\r\nx-evil: 1' }, 'userAgent'], [{ url: p('/get.php'), allowLan: false, userAgent: '' }, 'userAgent'],
      [{ url: p('/get.php'), allowLan: false, skipGroups: 'Kinder' }, 'skipGroups'], [{ url: p('/get.php'), allowLan: false, skipGroups: [1] }, 'skipGroups'],
      [{ url: p('/get.php'), allowLan: false, skipGroups: new Array(2001).fill('a') }, 'skipGroups'],
    ];
    for (const [body, field] of cases) {
      const r = await post('/v1/fetch/m3u', body);
      expect([r.status, await r.json()]).toEqual([400, { error: 'invalid', field }]);
    }
    expect(seen).toEqual([]);
  });
});

describe('POST /v1/fetch/xmltv', () => {
  const window = { from: Date.UTC(2026, 10, 11), to: Date.UTC(2026, 10, 12) };

  it('answers NDJSON, one item per line (gzip source, channels filter)', async () => {
    const r = await post('/v1/fetch/xmltv', { url: p('/epg.xml.gz'), allowLan: false, channels: ['nordlicht.de'], ...window });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/x-ndjson');
    const lines = await ndjson(r);
    expect(lines.map((l) => l.t)).toEqual(['channel', 'prog', 'prog', 'end']);
    expect(lines[1]).toMatchObject({ ch: 'nordlicht.de', title: 'Die Leuchtturmwärter', start: Date.UTC(2026, 10, 11, 19, 15) });
  });

  it('a complete stream ends with the end line and its counts', async () => {
    const lines = await ndjson(await post('/v1/fetch/xmltv', { url: p('/epg.xml.gz'), allowLan: false, ...window }));
    expect(lines.at(-1)).toEqual({ t: 'end', programmes: 4, channels: 3 });
    expect(lines.filter((l) => l.t === 'end')).toHaveLength(1);
    expect(lines.some((l) => l.t === 'error')).toBe(false);
  });

  it('a broken file ends with an error line after the items already sent, and never an end line', async () => {
    const lines = await ndjson(await post('/v1/fetch/xmltv', { url: p('/broken.xml'), allowLan: false, ...window }));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.at(-1)).toEqual({ t: 'error', code: 'invalid' });
    expect(lines.filter((l) => l.t === 'error')).toHaveLength(1);
    expect(lines.some((l) => l.t === 'end')).toBe(false);
  });

  it('a caller that goes away stops the provider download at once, even while nothing is written', async () => {
    const t = Date.now();
    const ac = new AbortController();
    const r = await post('/v1/fetch/xmltv', { url: p('/endless.xml'), allowLan: false, ...window }, ac.signal);
    expect(r.status).toBe(200);
    await endlessOpened;
    ac.abort();
    await endlessClosed;
    expect(Date.now() - t).toBeLessThan(5_000);
  });

  it('a failure before the first item answers the same way: 200 and a single error line', async () => {
    for (const [path, code] of [['/doctype.xml', 'doctype'], ['/missing.xml', 'not_found']] as const) {
      const r = await post('/v1/fetch/xmltv', { url: p(path), allowLan: false, ...window });
      expect(r.status).toBe(200);
      expect(await ndjson(r)).toEqual([{ t: 'error', code }]);
    }
    const lan = await post('/v1/fetch/xmltv', { url: `http://lan.example.com:${port}/epg.xml.gz`, allowLan: false, ...window });
    expect(await ndjson(lan)).toEqual([{ t: 'error', code: 'address_refused' }]);
  });

  it('a body that fails the schema is 400 invalid with the field', async () => {
    const cases: Array<[unknown, string]> = [
      [{ url: p('/epg.xml.gz'), allowLan: false, to: window.to }, 'from'],
      [{ url: p('/epg.xml.gz'), allowLan: false, from: window.from, to: 'morgen' }, 'to'],
      [{ url: p('/epg.xml.gz'), allowLan: false, from: window.to, to: window.from }, 'to'],
      [{ url: p('/epg.xml.gz'), allowLan: false, ...window, channels: [''] }, 'channels'],
      [{ url: p('/epg.xml.gz'), allowLan: false, ...window, channels: {} }, 'channels'],
    ];
    for (const [body, field] of cases) {
      const r = await post('/v1/fetch/xmltv', body);
      expect([r.status, await r.json()]).toEqual([400, { error: 'invalid', field }]);
    }
  });
});

describe('POST /v1/fetch/logo', () => {
  it('a PNG comes back as its bytes with its sniffed type', async () => {
    const r = await post('/v1/fetch/logo', { url: p('/logo.png'), allowLan: false });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG);
  });

  it('SVG → 422 not_image (whatever the server claims); 600 KB PNG → 422 too_big; fetch failures keep their code', async () => {
    const svg = await post('/v1/fetch/logo', { url: p('/logo.svg'), allowLan: false });
    expect([svg.status, await svg.json()]).toEqual([422, { error: 'not_image' }]);
    const huge = await post('/v1/fetch/logo', { url: p('/huge.png'), allowLan: false });
    expect([huge.status, await huge.json()]).toEqual([422, { error: 'too_big' }]);
    const missing = await post('/v1/fetch/logo', { url: p('/nope.png'), allowLan: false });
    expect([missing.status, await missing.json()]).toEqual([422, { error: 'not_found' }]);
    const bad = await post('/v1/fetch/logo', { url: p('/logo.png') });
    expect([bad.status, await bad.json()]).toEqual([400, { error: 'invalid', field: 'allowLan' }]);
  });
});

describe('POST /v1/probe', () => {
  it('answers the ProbeResult; ffprobe reads from a pipe', async () => {
    const r = await post('/v1/probe', { input: { url: p('/stream.ts'), kind: 'ts', allowLan: false } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'remux' });
    expect(runCalls[0]).toContain('pipe:0');
    const push = await post('/v1/probe', { input: { push: 'ch-1' } });
    expect(await push.json()).toEqual({ ok: false, needs: 'transcode', error: 'invalid' });
  });

  it('a failed probe is still 200 with its code; a bad input is 400', async () => {
    const r = await post('/v1/probe', { input: { url: `http://lan.example.com:${port}/stream.ts`, kind: 'ts', allowLan: false } });
    expect([r.status, await r.json()]).toEqual([200, { ok: false, needs: 'transcode', error: 'address_refused' }]);
    const cases: unknown[] = [{}, { input: null }, { input: { url: p('/stream.ts'), kind: 'rtmp', allowLan: false } }, { input: { url: p('/stream.ts'), kind: 'ts' } }, { input: { push: '' } }, { input: { url: 5, kind: 'ts', allowLan: false } }];
    for (const body of cases) {
      const b = await post('/v1/probe', body);
      expect([b.status, await b.json()]).toEqual([400, { error: 'invalid', field: 'input' }]);
    }
  });
});

it('no log line names a provider URL, host or credential', () => {
  expect(warnings.join('\n')).not.toMatch(/iptv\.example|geheim|lan\.example|get\.php/);
});

describe('start', () => {
  it('registers the fetch routes in production', async () => {
    const free = await new Promise<number>((r) => { const s = netServer().listen(0, '127.0.0.1', () => { const n = (s.address() as AddressInfo).port; s.close(() => r(n)); }); });
    const k = deriveKey('start-fetch-secret-0123456789');
    const dir = mkdtempSync(join(tmpdir(), 'livetv-fetch-key-'));
    writeFileSync(join(dir, 'livetv_key'), k.toString('hex'));
    const s = await start({ PORT: String(free), LIVETV_KEY_FILE: join(dir, 'livetv_key'), LIVETV_SRT_PORTS: '9000' }, { log: () => {}, host: '127.0.0.1' });
    try {
      for (const path of ['/v1/fetch/m3u', '/v1/fetch/xmltv', '/v1/fetch/logo', '/v1/probe']) {
        const body = '{}';
        const r = await fetch(`http://127.0.0.1:${free}${path}`, { method: 'POST', body, headers: { ...sign(k, 'POST', path, body), 'content-type': 'application/json' } });
        expect(r.status).toBe(400);
      }
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
