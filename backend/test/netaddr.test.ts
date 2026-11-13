// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientAddress, isHomeAddress, isHomeRequest, isTrustedPeer, isValidCidr, noteUntrustedForwarding, resetUntrustedForwardingNote, setUntrustedPeers, watchUntrustedHost } from '../src/netaddr.js';
import { loadConfig } from '../src/config.js';

const HOME = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'];
const req = (headers: Record<string, string>, peer?: string) => ({ headers, socket: { remoteAddress: peer } });

describe('isHomeAddress', () => {
  it.each(['10.1.2.3', '192.168.0.5', '127.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.2', '::ffff:c0a8:0102', '172.31.255.1'])('%s is home', (ip) => {
    expect(isHomeAddress(ip, HOME)).toBe(true);
  });
  it.each(['8.8.8.8', '2001:db8::1', '', 'unknown', '172.32.0.1', '::ffff:8.8.8.8', '999.1.1.1', 'not-an-ip'])('%s is remote', (ip) => {
    expect(isHomeAddress(ip, HOME)).toBe(false);
  });
  it('ignores broken CIDRs and an empty list', () => {
    expect(isHomeAddress('10.0.0.1', ['garbage', '10.0.0.0/99', '10.0.0.0/8'])).toBe(true);
    expect(isHomeAddress('10.0.0.1', [])).toBe(false);
  });
});

describe('clientAddress', () => {
  it('prefers x-real-ip, then the LAST x-forwarded-for entry, then the socket peer', () => {
    expect(clientAddress(req({ 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '10.0.0.1'))).toBe('203.0.113.1');
    expect(clientAddress(req({ 'x-forwarded-for': '192.168.1.10, 203.0.113.9' }, '10.0.0.1'))).toBe('203.0.113.9');
    expect(clientAddress(req({}, '10.0.0.1'))).toBe('10.0.0.1');
    expect(clientAddress(req({}))).toBe('unknown');
  });
});

describe('isHomeRequest', () => {
  it('without a forwarding header only loopback is home (a docker bridge peer is remote)', () => {
    expect(isHomeRequest(req({}, '127.0.0.1'), HOME)).toBe(true);
    expect(isHomeRequest(req({}, '::1'), HOME)).toBe(true);
    expect(isHomeRequest(req({}, '172.18.0.5'), HOME)).toBe(false);
    expect(isHomeRequest(req({}, '192.168.1.5'), HOME)).toBe(false);
  });
  it('with a forwarding header the derived address decides', () => {
    expect(isHomeRequest(req({ 'x-real-ip': '192.168.1.10' }, '172.18.0.5'), HOME)).toBe(true);
    expect(isHomeRequest(req({ 'x-forwarded-for': '192.168.1.10, 203.0.113.9' }, '127.0.0.1'), HOME)).toBe(false);
  });
});

describe('unusable forwarding headers', () => {
  it('a header without a usable value is the no-header case: loopback only', () => {
    expect(isHomeRequest(req({ 'x-forwarded-for': ',' }, '192.168.1.5'), HOME)).toBe(false);
    expect(isHomeRequest(req({ 'x-forwarded-for': ' , ' }, '172.18.0.5'), HOME)).toBe(false);
    expect(isHomeRequest(req({ 'x-real-ip': '  ' }, '10.0.0.7'), HOME)).toBe(false);
    expect(isHomeRequest(req({ 'x-forwarded-for': ',' }, '127.0.0.1'), HOME)).toBe(true);
  });
});

describe('HOME_NETWORKS config', () => {
  const BASE = {
    PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20), OIDC_ISSUER: 'https://a.example.com',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', REQUESTS_URL: 'http://s', REQUESTS_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20),
  };
  it('defaults to RFC1918 + loopback + ULA + link-local', () => {
    expect(loadConfig(BASE).HOME_NETWORKS).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10']);
  });
  it('accepts a custom list and fails at startup on an invalid entry', () => {
    expect(loadConfig({ ...BASE, HOME_NETWORKS: ' 203.0.113.0/24 , 2001:db8::/32 ' }).HOME_NETWORKS).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    expect(() => loadConfig({ ...BASE, HOME_NETWORKS: '10.0.0.0/8,192.168.0.0/33' })).toThrow(/HOME_NETWORKS: invalid CIDR '192\.168\.0\.0\/33'/);
    expect(() => loadConfig({ ...BASE, HOME_NETWORKS: 'lan' })).toThrow(/invalid CIDR 'lan'/);
  });
  it('HEALTH_DISK_WARN_PCT at or above HEALTH_DISK_CRIT_PCT falls back to 85 / 95 with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadConfig({ ...BASE, HEALTH_DISK_WARN_PCT: '90', HEALTH_DISK_CRIT_PCT: '80' })).toMatchObject({ HEALTH_DISK_WARN_PCT: 85, HEALTH_DISK_CRIT_PCT: 95 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/HEALTH_DISK_WARN_PCT \(90\) must be below HEALTH_DISK_CRIT_PCT \(80\)/));
      expect(loadConfig({ ...BASE, HEALTH_DISK_WARN_PCT: '70', HEALTH_DISK_CRIT_PCT: '90' })).toMatchObject({ HEALTH_DISK_WARN_PCT: 70, HEALTH_DISK_CRIT_PCT: 90 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  it('isValidCidr', () => {
    for (const c of ['10.0.0.0/8', '1.2.3.4', 'fc00::/7', '::1/128']) expect(isValidCidr(c)).toBe(true);
    for (const c of ['10.0.0.0/33', 'fc00::/129', '10.0.0.0/8/1', 'x', '', '10.0.0.0/-1']) expect(isValidCidr(c)).toBe(false);
  });
});

describe('trustProxy: the client address behind the proxy (req.ip, the rate-limit key)', () => {
  const build = async () => {
    const { default: Fastify } = await import('fastify');
    const { default: rateLimit } = await import('@fastify/rate-limit');
    const { TRUSTED_PROXY_RANGES } = await import('../src/netaddr.js');
    const app = Fastify({ trustProxy: [...TRUSTED_PROXY_RANGES] });
    await app.register(rateLimit, { global: true, max: 2, timeWindow: '1 minute' });
    app.get('/ip', async (r) => r.ip);
    return app;
  };
  const get = (app: Awaited<ReturnType<typeof build>>, remoteAddress: string, xff?: string) =>
    app.inject({ method: 'GET', url: '/ip', remoteAddress, headers: xff ? { 'x-forwarded-for': xff } : {} });

  it('a proxy on loopback or a private address: req.ip is the client it appended, whatever the client put in front', async () => {
    const app = await build();
    expect((await get(app, '127.0.0.1', '203.0.113.9')).body).toBe('203.0.113.9');
    expect((await get(app, '172.17.0.1', '198.51.100.1, 203.0.113.10')).body).toBe('203.0.113.10');
    expect((await get(app, '192.168.1.2', '10.9.9.9, 203.0.113.11')).body).toBe('203.0.113.11'); // a spoofed private entry in front changes nothing
    expect((await get(app, '::ffff:127.0.0.1', '203.0.113.12')).body).toBe('203.0.113.12');
    expect((await get(app, 'fd00::5', '203.0.113.13')).body).toBe('203.0.113.13');
    await app.close();
  });
  it('a direct connection from a public address: X-Forwarded-For is ignored', async () => {
    const app = await build();
    expect((await get(app, '198.51.100.77', '203.0.113.9')).body).toBe('198.51.100.77');
    expect((await get(app, '198.51.100.77', '10.0.0.1, 203.0.113.9')).body).toBe('198.51.100.77');
    await app.close();
  });
  it('rate limiting: rotating X-Forwarded-For from a public peer shares one bucket; behind the proxy each client has its own', async () => {
    const app = await build();
    const codes = [];
    for (let i = 1; i <= 3; i++) codes.push((await get(app, '198.51.100.88', `203.0.113.${i}`)).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    const behind = [];
    for (const [peerHeader, n] of [['198.51.100.200, 203.0.113.50', 3], ['198.51.100.201, 203.0.113.51', 1]] as const) {
      for (let i = 0; i < n; i++) behind.push((await get(app, '127.0.0.1', peerHeader)).statusCode);
    }
    expect(behind).toEqual([200, 200, 429, 200]); // a spoofed leftmost entry does not buy a new bucket; another real client has its own
    await app.close();
  });
});

describe('forwarding headers are believed only from a trusted (loopback / private) peer', () => {
  it('isTrustedPeer', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.2', '169.254.1.1', 'fd12::3', 'fe80::1']) expect(isTrustedPeer(ip), ip).toBe(true);
    for (const ip of ['203.0.113.5', '100.64.1.2', '2001:db8::1', '', undefined, 'nope']) expect(isTrustedPeer(ip), String(ip)).toBe(false);
  });
  it('a direct public peer claiming a home address is not home, and its address is the socket address', () => {
    const r = req({ 'x-real-ip': '192.168.1.10', 'x-forwarded-for': '192.168.1.10' }, '203.0.113.1');
    expect(isHomeRequest(r, HOME)).toBe(false);
    expect(clientAddress(r)).toBe('203.0.113.1');
  });
  it('a trusted proxy peer forwarding a client address still works', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '198.51.100.9, 192.168.1.10' }, '172.18.0.5'))).toBe('192.168.1.10');
    expect(isHomeRequest(req({ 'x-real-ip': '192.168.1.10' }, '127.0.0.1'), HOME)).toBe(true);
    expect(isHomeRequest(req({ 'x-real-ip': '198.51.100.9' }, '127.0.0.1'), HOME)).toBe(false);
  });
});

describe('noteUntrustedForwarding', () => {
  it('warns once per process, only for X-Forwarded-For from an untrusted peer, and never names an address', () => {
    resetUntrustedForwardingNote();
    const warn = vi.fn();
    noteUntrustedForwarding(req({ 'x-forwarded-for': '1.1.1.1' }, '127.0.0.1'), { warn });
    noteUntrustedForwarding(req({}, '203.0.113.5'), { warn });
    expect(warn).not.toHaveBeenCalled();
    noteUntrustedForwarding(req({ 'x-forwarded-for': '198.51.100.9' }, '203.0.113.5'), { warn });
    noteUntrustedForwarding(req({ 'x-forwarded-for': '198.51.100.8' }, '203.0.113.6'), { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe('review L3: the livetv container is no trusted proxy', () => {
  afterEach(() => setUntrustedPeers([]));
  const build = async () => {
    const { default: Fastify } = await import('fastify');
    const { trustProxy } = await import('../src/netaddr.js');
    const app = Fastify({ trustProxy });
    app.get('/ip', async (r) => r.ip);
    return app;
  };
  const get = (app: Awaited<ReturnType<typeof build>>, remoteAddress: string, xff: string) =>
    app.inject({ method: 'GET', url: '/ip', remoteAddress, headers: { 'x-forwarded-for': xff } });

  it("livetv's X-Forwarded-For picks neither a rate-limit bucket (req.ip) nor a home address; other private proxies still work", async () => {
    const app = await build();
    expect((await get(app, '172.20.0.4', '203.0.113.9')).body).toBe('203.0.113.9'); // before the lookup: a private peer
    const w = watchUntrustedHost('livetv', { lookup: async () => ['172.20.0.4'], intervalMs: 60_000 });
    await w.ready;
    w.stop();
    expect((await get(app, '172.20.0.4', '203.0.113.9')).body).toBe('172.20.0.4');
    expect((await get(app, '::ffff:172.20.0.4', '203.0.113.9')).body).toBe('::ffff:172.20.0.4');
    expect(isTrustedPeer('172.20.0.4')).toBe(false);
    const r = req({ 'x-real-ip': '192.168.1.10', 'x-forwarded-for': '192.168.1.10' }, '172.20.0.4');
    expect(clientAddress(r)).toBe('172.20.0.4');
    expect(isHomeRequest(r, HOME)).toBe(false);
    // the reverse proxy (another private address, or loopback) is still believed
    expect((await get(app, '172.18.0.1', '203.0.113.10')).body).toBe('203.0.113.10');
    expect((await get(app, '127.0.0.1', '203.0.113.11')).body).toBe('203.0.113.11');
    await app.close();
  });

  it('only a compose service name is followed; loopback is never excluded; a vanished name clears the set', async () => {
    setUntrustedPeers(['127.0.0.1', '::1']);
    expect(isTrustedPeer('127.0.0.1')).toBe(true);
    expect(isTrustedPeer('::1')).toBe(true);
    for (const host of ['livetv.example.com', '192.0.2.10', '']) await watchUntrustedHost(host, { lookup: async () => ['172.20.0.7'] }).ready;
    expect(isTrustedPeer('172.20.0.7')).toBe(true);
    const w = watchUntrustedHost('livetv', { lookup: async () => ['172.20.0.7'], intervalMs: 60_000 });
    await w.ready;
    w.stop();
    expect(isTrustedPeer('172.20.0.7')).toBe(false);
    const gone = watchUntrustedHost('livetv', { lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); }, intervalMs: 60_000 });
    await gone.ready;
    gone.stop();
    expect(isTrustedPeer('172.20.0.7')).toBe(true);
  });
});
