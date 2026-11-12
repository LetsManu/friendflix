// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchError, guardedFetch, type GuardDeps } from '../src/fetch.js';

// A local test server stands in for every provider: `dial` maps the checked address onto it (plan pre-flight F14 allows the
// private and loopback literals used here).
type Server = { port: number; connections: number; paths: string[]; close(): Promise<void> };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Server> {
  const srv = http.createServer((req, res) => { s.paths.push(req.url ?? ''); handler(req, res); });
  const s: Server = {
    port: 0, connections: 0, paths: [],
    close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
  srv.on('connection', () => { s.connections++; });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  s.port = (srv.address() as AddressInfo).port;
  servers.push(s);
  return s;
}

/** fake resolver: answers in turn (the last one repeats); dial records every checked address and connects to 127.0.0.1 */
function deps(...answers: string[][]): GuardDeps & { lookups: string[]; dialed: string[] } {
  const lookups: string[] = [];
  const dialed: string[] = [];
  let i = 0;
  return {
    lookups, dialed, own: [],
    lookup: async (h) => { lookups.push(h); return answers[Math.min(i++, answers.length - 1)] ?? []; },
    dial: (ip) => { dialed.push(ip); return '127.0.0.1'; },
  };
}
const O = { allowLan: false, timeoutMs: 5_000, maxBytes: 1_000_000 };
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof FetchError ? e.code : `other:${String(e)}`));
async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}

describe('guardedFetch', () => {
  it('fetches through the checked address with the original Host, the user agent and the userinfo as Basic auth', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const s = await serve((req, res) => { seen = req.headers; res.setHeader('x-list', 'm3u'); res.end('#EXTM3U\n'); });
    const d = deps(['192.0.2.10']);
    const r = await guardedFetch(`http://anna:geheim@iptv.example.com:${s.port}/get.php?type=m3u`, { ...O, userAgent: 'Hafenkanal-Box/1.0' }, d);
    expect(r.status).toBe(200);
    expect(r.headers['x-list']).toBe('m3u');
    expect(await text(r.body)).toBe('#EXTM3U\n');
    expect(seen.host).toBe(`iptv.example.com:${s.port}`);
    expect(seen['user-agent']).toBe('Hafenkanal-Box/1.0');
    expect(seen.authorization).toBe(`Basic ${Buffer.from('anna:geheim').toString('base64')}`);
    expect(s.paths).toEqual(['/get.php?type=m3u']);
    expect(d.dialed).toEqual(['192.0.2.10']);
  });

  it('rebinding cannot switch the address', async () => {
    const s = await serve((_req, res) => res.end('ok'));
    const d = deps(['192.0.2.10'], ['10.0.0.5']);
    const r = await guardedFetch(`http://iptv.example.com:${s.port}/list.m3u`, O, d);
    expect(await text(r.body)).toBe('ok');
    expect(d.lookups).toEqual(['iptv.example.com']);
    expect(d.dialed).toEqual(['192.0.2.10']);
    expect(s.connections).toBe(1);
  });

  it('LAN switch', async () => {
    const s = await serve((_req, res) => res.end('lan'));
    expect(await codeOf(guardedFetch(`http://tv.example.com:${s.port}/`, O, deps(['192.168.1.5'])))).toBe('address_refused');
    const r = await guardedFetch(`http://tv.example.com:${s.port}/`, { ...O, allowLan: true }, deps(['192.168.1.5']));
    expect(await text(r.body)).toBe('lan');
    expect(await codeOf(guardedFetch(`http://127.0.0.1:${s.port}/`, { ...O, allowLan: true }, deps()))).toBe('address_refused');
    expect(s.connections).toBe(1);
  });

  it('refuses before connecting: other schemes, single-label hosts, garbage', async () => {
    const d = deps(['192.0.2.10']);
    expect(await codeOf(guardedFetch('srt://iptv.example.com:9000', O, d))).toBe('scheme');
    expect(await codeOf(guardedFetch('file:///etc/passwd', O, d))).toBe('scheme');
    expect(await codeOf(guardedFetch('http://backend:8080/api/me', O, d))).toBe('address_refused');
    expect(await codeOf(guardedFetch('::not a url', O, d))).toBe('unreachable');
    expect(d.lookups).toEqual([]);
    expect(d.dialed).toEqual([]);
  });

  it('redirect re-checks', async () => {
    const s = await serve((req, res) => {
      const to: Record<string, string> = { '/loop': 'http://127.0.0.1/', '/srt': 'srt://iptv.example.com:9000?streamid=x', '/up': 'https://iptv.example.com/x' };
      const n = /^\/r([1-4])$/.exec(req.url ?? '');
      if (n) { res.writeHead(302, { location: `/r${Number(n[1]) + 1}` }); res.end(); return; }
      if (to[req.url ?? '']) { res.writeHead(302, { location: to[req.url ?? ''] }); res.end(); return; }
      res.end('end');
    });
    const url = (p: string) => `http://iptv.example.com:${s.port}${p}`;
    expect(await codeOf(guardedFetch(url('/loop'), { ...O, allowLan: true }, deps(['192.0.2.10'])))).toBe('address_refused');
    expect(await codeOf(guardedFetch(url('/srt'), O, deps(['192.0.2.10'])))).toBe('scheme');
    expect(await codeOf(guardedFetch(url('/up'), O, deps(['192.0.2.10'])))).toBe('scheme');
    // r2 -> r3 -> r4 -> r5 is three redirects: allowed; r1 -> ... -> r5 is four: refused
    const three = deps(['192.0.2.10'], ['192.0.2.11']);
    const followed = await guardedFetch(url('/r2'), O, three);
    // the last hop's URL is the base for relative references in the body
    expect(followed.url).toBe(url('/r5'));
    expect(await text(followed.body)).toBe('end');
    expect((await guardedFetch(url('/plain?x=1'), O, deps(['192.0.2.10']))).url).toBe(url('/plain?x=1'));
    expect(three.dialed).toEqual(['192.0.2.10', '192.0.2.11', '192.0.2.11', '192.0.2.11']);
    expect(await codeOf(guardedFetch(url('/r1'), O, deps(['192.0.2.10'])))).toBe('redirects');
    // each hop is resolved and checked again: a rebinding answer on the second hop is refused
    expect(await codeOf(guardedFetch(url('/r4'), O, deps(['192.0.2.10'], ['10.0.0.5'])))).toBe('address_refused');
  });

  it('return() on a body that was never read closes the connection at once', async () => {
    let closedAt = 0;
    const s = await serve((_req, res) => { res.on('close', () => { closedAt = Date.now(); }); res.writeHead(200); res.write('x'); });
    const r = await guardedFetch(`http://iptv.example.com:${s.port}/live.ts`, { ...O, timeoutMs: 30_000 }, deps(['192.0.2.10']));
    const t = Date.now();
    await r.body[Symbol.asyncIterator]().return?.();
    for (let i = 0; i < 100 && !closedAt; i++) await new Promise((res) => setTimeout(res, 20));
    expect(closedAt).toBeGreaterThan(0);
    expect(closedAt - t).toBeLessThan(2_000);
    // a body read to its end still closes cleanly
    const done = await guardedFetch(`http://iptv.example.com:${s.port}/x`, { ...O, timeoutMs: 30_000 }, deps(['192.0.2.10']));
    const it = done.body[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    expect((await it.return?.())?.done).toBe(true);
  });

  it('status codes map to fixed errors', async () => {
    const s = await serve((req, res) => { res.statusCode = Number((req.url ?? '/500').slice(1)); res.end('nope'); });
    const at = (code: number) => codeOf(guardedFetch(`http://iptv.example.com:${s.port}/${code}`, O, deps(['192.0.2.10'])));
    expect([await at(401), await at(403), await at(404), await at(410), await at(500), await at(304)])
      .toEqual(['denied', 'denied', 'not_found', 'http_error', 'http_error', 'http_error']);
  });

  it('byte cap', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const s = await serve((req, res) => {
      if (req.url === '/sized') res.setHeader('content-length', String(16 * chunk.length));
      for (let i = 0; i < 16; i++) res.write(chunk);
      res.end();
    });
    const o = { ...O, maxBytes: 512_000 };
    const streamed = await guardedFetch(`http://iptv.example.com:${s.port}/chunked`, o, deps(['192.0.2.10']));
    let got = 0;
    const err = await (async () => { for await (const c of streamed.body) got += c.length; })().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('too_big');
    expect(got).toBeLessThanOrEqual(512_000);
    expect(await codeOf(guardedFetch(`http://iptv.example.com:${s.port}/sized`, o, deps(['192.0.2.10'])))).toBe('too_big');
  });

  it('times out on a server that never answers, and on a body that stalls', async () => {
    const s = await serve((req, res) => { if (req.url === '/stall') res.write('part'); });
    expect(await codeOf(guardedFetch(`http://iptv.example.com:${s.port}/hang`, { ...O, timeoutMs: 200 }, deps(['192.0.2.10'])))).toBe('timeout');
    const r = await guardedFetch(`http://iptv.example.com:${s.port}/stall`, { ...O, timeoutMs: 300 }, deps(['192.0.2.10']));
    expect(await codeOf(text(r.body))).toBe('timeout');
  });

  it('a DNS lookup that never answers is bounded by timeoutMs', async () => {
    const t = Date.now();
    const hang: GuardDeps = { lookup: () => new Promise<string[]>(() => {}), own: [] };
    expect(await codeOf(guardedFetch('http://iptv.example.com/list.m3u', { ...O, timeoutMs: 200 }, hang))).toBe('timeout');
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it('credentials never in errors', async () => {
    const closed = await serve(() => {});
    const port = closed.port;
    await closed.close();
    servers.splice(servers.indexOf(closed), 1);
    const s = await serve((_req, res) => { res.statusCode = 404; res.end(); });
    const raws = [
      [`https://anna:geheim@iptv.example.com:${port}/x`, deps(['192.0.2.10'])],
      [`http://anna:geheim@iptv.example.com:${s.port}/x`, deps(['192.0.2.10'])],
      ['https://anna:geheim@iptv.example.com/x', deps(['10.0.0.5'])],
      ['https://anna:geheim@iptv.example.com/x', { lookup: async () => { throw new Error('getaddrinfo ENOTFOUND iptv.example.com'); }, own: [] }],
    ] as const;
    const codes: string[] = [];
    for (const [raw, d] of raws) {
      const err = await guardedFetch(raw, O, d).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(FetchError);
      codes.push((err as FetchError).code);
      for (const shown of [String(err), (err as Error).message, (err as Error).stack ?? '', JSON.stringify(err)]) {
        expect(shown).not.toContain('geheim');
        expect(shown).not.toContain('iptv.example.com');
      }
    }
    expect(codes).toEqual(['unreachable', 'not_found', 'address_refused', 'unreachable']);
  });
});
