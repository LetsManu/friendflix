// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchError, createPool, guardedFetch, type GuardDeps } from '../src/fetch.js';
import { openInput } from '../src/inputs.js';

/**
 * H1 (item 4): the polls and segment fetches of one run reuse one kept-alive connection per host, to the address checked once
 * for the run, so they stay on one CDN edge (a new connection with a fresh DNS answer for every request made consecutive reads
 * land on different nodes, one of them behind). The guard is unchanged: every host is checked before its first connection.
 */
type Server = { port: number; connections: number; close(): Promise<void> };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Server> {
  const srv = http.createServer(handler);
  srv.keepAliveTimeout = 5_000;
  const s: Server = { port: 0, connections: 0, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
  srv.on('connection', () => { s.connections++; });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  s.port = (srv.address() as AddressInfo).port;
  servers.push(s);
  return s;
}
/** a resolver that answers another edge address each time (round-robin DNS); dial connects every address to the test server */
function edges(): GuardDeps & { lookups: string[]; dialed: string[] } {
  const lookups: string[] = [];
  const dialed: string[] = [];
  return {
    lookups, dialed, own: [],
    lookup: async (h) => { lookups.push(h); return [`192.0.2.${10 + lookups.length}`]; },
    dial: (ip) => { dialed.push(ip); return '127.0.0.1'; },
  };
}
const O = { allowLan: false, timeoutMs: 5_000, maxBytes: 1_000_000 };
async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}

describe('a connection pool for a run', () => {
  it('requests through one pool share one connection and one checked address per host', async () => {
    const s = await serve((_req, res) => res.end('ok'));
    const d = edges();
    const pool = createPool();
    try {
      for (let i = 0; i < 4; i++) expect(await text((await guardedFetch(`http://iptv.example.com:${s.port}/live/${i}.ts`, { ...O, pool }, d)).body)).toBe('ok');
    } finally {
      pool.destroy();
    }
    expect(s.connections).toBe(1);
    expect(d.lookups).toEqual(['iptv.example.com']);
    expect([...new Set(d.dialed)]).toEqual(['192.0.2.11']);
  });

  it('without a pool every request is a new connection, as before (lists, guides, logos)', async () => {
    const s = await serve((_req, res) => res.end('ok'));
    const d = edges();
    for (let i = 0; i < 3; i++) await text((await guardedFetch(`http://iptv.example.com:${s.port}/x`, O, d)).body);
    expect(s.connections).toBe(3);
    expect(d.lookups).toHaveLength(3);
  });

  it('a body not read to its end closes its connection (never handed back half-read); the guard still refuses a bad host', async () => {
    const s = await serve((_req, res) => { res.write('a'.repeat(1000)); setTimeout(() => res.end('b'), 50); });
    const d = edges();
    const pool = createPool();
    try {
      const r = await guardedFetch(`http://iptv.example.com:${s.port}/x`, { ...O, pool }, d);
      const it = r.body[Symbol.asyncIterator]();
      await it.next();
      await it.return?.();
      await text((await guardedFetch(`http://iptv.example.com:${s.port}/y`, { ...O, pool }, d)).body);
      expect(s.connections).toBe(2);
      const refused = await guardedFetch(`http://localhost:${s.port}/z`, { ...O, pool }, d).then(() => 'ok', (e: unknown) => (e as FetchError).code);
      expect(refused).toBe('address_refused');
    } finally {
      pool.destroy();
    }
  });

  it('openInput reads every playlist poll and segment of a run over one connection, and closes it with the run', async () => {
    let seg = 0;
    const s = await serve((req, res) => {
      if (req.url === '/live/index.m3u8') {
        res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${seg}`, '#EXTINF:1.0,', `${seg}.ts`, ''].join('\n'));
        seg++;
      } else res.end(`[${req.url}]`);
    });
    const d = edges();
    const o = await openInput({ url: `http://iptv.example.com:${s.port}/live/index.m3u8`, kind: 'hls', allowLan: false }, { guard: d });
    if (o.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const it = o.ffInput.stdin[Symbol.asyncIterator]();
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push(Buffer.from((await it.next()).value as Uint8Array).toString());
    o.close();
    await it.return?.();
    expect(got).toEqual(['[/live/0.ts]', '[/live/1.ts]', '[/live/2.ts]']);
    expect(s.connections).toBe(1);
    expect(d.lookups).toEqual(['iptv.example.com']);
  }, 10_000);
});
