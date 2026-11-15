// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchError, createPool, guardedFetch, type GuardDeps } from '../src/fetch.js';
import { openInput } from '../src/inputs.js';

/**
 * H1 (item 4): the polls and segment fetches of one run reuse one kept-alive connection per host, to the address checked once
 * for the run, so they stay on one CDN edge (a new connection with a fresh DNS answer for every request made consecutive reads
 * land on different nodes, one of them behind). The guard is unchanged: every host is checked before its first connection.
 */
type Server = { port: number; connections: number; closed: number; close(): Promise<void> };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Server> {
  const srv = http.createServer(handler);
  srv.keepAliveTimeout = 5_000;
  const s: Server = { port: 0, connections: 0, closed: 0, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
  srv.on('connection', (sock) => { s.connections++; sock.on('close', () => { s.closed++; }); });
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
/** waits (real time, at most 2 s) until `ok()` */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(ok()).toBe(true);
}
/** a resolver by host name; dial records every checked address and connects to the local server */
function hosts(map: Record<string, string>): GuardDeps & { lookups: string[]; dialed: string[] } {
  const lookups: string[] = [];
  const dialed: string[] = [];
  return {
    lookups, dialed, own: [],
    lookup: async (h) => { lookups.push(h); return map[h] ? [map[h]!] : []; },
    dial: (ip) => { dialed.push(ip); return '127.0.0.1'; },
  };
}
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

  it('a body not read to its end closes its connection (never handed back half-read)', async () => {
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
      } else {
        // echo only the segment number, as plain text (never the raw request path)
        const n = /^\/live\/(\d+)\.ts$/.exec(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/plain' }).end(n ? `[/live/${Number(n[1])}.ts]` : '[?]');
      }
    });
    const d = edges();
    const o = await openInput({ url: `http://iptv.example.com:${s.port}/live/index.m3u8`, kind: 'hls', allowLan: false }, { guard: d });
    if (o.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const it = o.ffInput.stdin[Symbol.asyncIterator]();
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push(Buffer.from((await it.next()).value as Uint8Array).toString());
    expect(s.closed).toBe(0);
    o.close();
    await it.return?.();
    expect(got).toEqual(['[/live/0.ts]', '[/live/1.ts]', '[/live/2.ts]']);
    expect(s.connections).toBe(1);
    expect(d.lookups).toEqual(['iptv.example.com']);
    // the run's end closes its kept-alive connection
    await until(() => s.closed === 1);
  }, 10_000);

  it('pool.destroy() closes the kept-alive sockets (the server sees them close)', async () => {
    const s = await serve((_req, res) => res.end('ok'));
    const pool = createPool();
    await text((await guardedFetch(`http://iptv.example.com:${s.port}/x`, { ...O, pool }, edges())).body);
    await new Promise((r) => setTimeout(r, 50));
    expect([s.connections, s.closed]).toEqual([1, 0]);
    pool.destroy();
    await until(() => s.closed === 1);
  });

  it('a redirect through the pool to another host is checked again: a private address is refused, never dialled', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/a') { res.writeHead(302, { location: `http://cdn.example.net:${s.port}/b` }); res.end(); } else res.end('b');
    });
    const d = hosts({ 'iptv.example.com': '192.0.2.10', 'cdn.example.net': '10.0.0.1' });
    const pool = createPool();
    try {
      const code = await guardedFetch(`http://iptv.example.com:${s.port}/a`, { ...O, pool }, d).then(() => 'ok', (e: unknown) => (e as FetchError).code);
      expect(code).toBe('address_refused');
      expect(d.lookups).toEqual(['iptv.example.com', 'cdn.example.net']);
      expect(d.dialed).not.toContain('10.0.0.1');
      // the refused host is not pinned: asked again, it is checked (and refused) again
      const again = await guardedFetch(`http://cdn.example.net:${s.port}/b`, { ...O, pool }, d).then(() => 'ok', (e: unknown) => (e as FetchError).code);
      expect(again).toBe('address_refused');
      expect(d.lookups).toEqual(['iptv.example.com', 'cdn.example.net', 'cdn.example.net']);
      // a public second host gets its own checked address, not the first host's
      const ok = hosts({ 'iptv.example.com': '192.0.2.10', 'cdn.example.net': '198.51.100.7' });
      const pool2 = createPool();
      expect(await text((await guardedFetch(`http://iptv.example.com:${s.port}/a`, { ...O, pool: pool2 }, ok)).body)).toBe('b');
      expect(ok.dialed).toEqual(['192.0.2.10', '198.51.100.7']);
      pool2.destroy();
    } finally {
      pool.destroy();
    }
  });

  it('review M4: the first concurrent requests to one host resolve it once (one pinned address, never two)', async () => {
    const s = await serve((_req, res) => res.end('ok'));
    const d = edges();
    const pool = createPool();
    try {
      await Promise.all([0, 1, 2].map(async (i) => text((await guardedFetch(`http://iptv.example.com:${s.port}/${i}`, { ...O, pool }, d)).body)));
    } finally {
      pool.destroy();
    }
    expect(d.lookups).toEqual(['iptv.example.com']);
    expect([...new Set(d.dialed)]).toEqual(['192.0.2.11']);
  });

  it('TLS through a pinned address still checks the real host name (SNI and certificate)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livetv-tls-'));
    const cert = (cn: string) => {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', `/CN=${cn}`,
        '-addext', `subjectAltName=DNS:${cn}`, '-keyout', join(dir, `${cn}.key`), '-out', join(dir, `${cn}.crt`)], { stdio: 'ignore' });
      return { key: readFileSync(join(dir, `${cn}.key`)), cert: readFileSync(join(dir, `${cn}.crt`)) };
    };
    const right = cert('iptv.example.com');
    const wrong = cert('other.example.org');
    const names: string[] = [];
    const tls = (c: { key: Buffer; cert: Buffer }) => new Promise<{ port: number; srv: https.Server }>((resolve) => {
      const srv = https.createServer({ ...c, SNICallback: (n, cb) => { names.push(n); cb(null, null as never); } }, (_req, res) => res.end('secure'));
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as AddressInfo).port, srv }));
    });
    const a = await tls(right);
    const b = await tls(wrong);
    try {
      for (const [srv, expected] of [[a, 'secure'], [b, 'unreachable']] as const) {
        const d = edges();
        const pool = createPool();
        // the test trusts both self-signed certificates; only the host name check can refuse one
        (pool.https as unknown as { options: Record<string, unknown> }).options.ca = [right.cert, wrong.cert];
        const got = await guardedFetch(`https://iptv.example.com:${srv.port}/x`, { ...O, pool }, d)
          .then(async (r) => text(r.body), (e: unknown) => (e as FetchError).code);
        pool.destroy();
        expect(got).toBe(expected);
        expect(d.dialed).toEqual(['192.0.2.11']);
      }
      expect(names).toEqual(['iptv.example.com', 'iptv.example.com']);
    } finally {
      a.srv.closeAllConnections(); a.srv.close();
      b.srv.closeAllConnections(); b.srv.close();
    }
  });
});
