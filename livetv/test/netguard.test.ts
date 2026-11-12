// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FetchError } from '../src/fetch.js';
import { checkUrl, classifyAddress, ipLiteralUrl, ownSubnets, resolveChecked, type Cidr } from '../src/netguard.js';

// Private, loopback and link-local literals are the subject of these tests (plan pre-flight F14).
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/livetv-ip-classes.json', import.meta.url), 'utf8')) as {
  rows: Array<{ ip: string; class: 'public' | 'private' | 'refused' }>;
};
const fixed = (...answers: string[][]) => {
  const calls: string[] = [];
  let i = 0;
  return { calls, lookup: async (h: string) => { calls.push(h); return answers[Math.min(i++, answers.length - 1)]!; } };
};
const refusedCode = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof FetchError ? e.code : 'other'));

describe('classifyAddress', () => {
  it('refused ranges', () => {
    const refused = [
      '127.0.0.1', '127.8.9.10', '::1', '0.0.0.0', '0.1.2.3', '::', '169.254.169.254', '169.254.10.1', 'fe80::1', 'febf::ab',
      '224.0.0.1', '239.1.2.3', 'ff02::1', 'ff05::2', '100.64.0.1', '100.127.255.255', '255.255.255.255',
      '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', 'fe80::1%eth0',
    ];
    expect(refused).toHaveLength(20);
    for (const ip of refused) expect([ip, classifyAddress(ip, [])]).toEqual([ip, 'refused']);
    expect(classifyAddress('::ffff:192.168.1.5', [])).toBe('private');
    expect(classifyAddress('192.0.2.10', [])).toBe('public');
  });

  it('the shared vectors classify alike (the backend copy asserts the same file)', () => {
    expect(vectors.rows.length).toBeGreaterThan(30);
    for (const r of vectors.rows) expect([r.ip, classifyAddress(r.ip, [])]).toEqual([r.ip, r.class]);
  });

  it('the container networks own subnets are refused even when private, in every form', () => {
    const own: Cidr[] = [{ addr: '172.18.0.2', bits: 16 }, { addr: 'fd00:ff::5', bits: 64 }, { addr: '192.0.2.0', bits: 28 }];
    expect(classifyAddress('172.18.200.1', own)).toBe('refused');
    expect(classifyAddress('::ffff:172.18.0.9', own)).toBe('refused');
    expect(classifyAddress('fd00:ff::1234', own)).toBe('refused');
    expect(classifyAddress('192.0.2.10', own)).toBe('refused');
    expect(classifyAddress('192.0.2.20', own)).toBe('public');
    expect(classifyAddress('172.19.0.1', own)).toBe('private');
    expect(classifyAddress('fd00:fe::1', own)).toBe('private');
  });
});

describe('ownSubnets', () => {
  it('reads every interface address with its prefix', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
      eth0: [
        { address: '172.18.0.2', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:ac:12:00:02', internal: false, cidr: '172.18.0.2/16' },
        { address: 'fe80::42:acff:fe12:2', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:42:ac:12:00:02', internal: false, cidr: 'fe80::42:acff:fe12:2/64', scopeid: 2 },
        { address: '10.1.2.3', netmask: '255.0.0.0', family: 'IPv4', mac: '02:42:ac:12:00:02', internal: false, cidr: null },
      ],
    } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
    expect(ownSubnets(ifaces)).toEqual([{ addr: '127.0.0.1', bits: 8 }, { addr: '172.18.0.2', bits: 16 }, { addr: 'fe80::42:acff:fe12:2', bits: 64 }]);
    expect(Array.isArray(ownSubnets())).toBe(true);
  });
});

describe('checkUrl', () => {
  it('single-label hosts', () => {
    expect(checkUrl('http://backend/x', ['http:', 'https:'])).toEqual({ error: 'host' });
    expect(checkUrl('http://postgres/', ['http:', 'https:'])).toEqual({ error: 'host' });
    expect(checkUrl('http://localhost./', ['http:', 'https:'])).toEqual({ error: 'host' });
    expect(checkUrl('srt://livetv:9000', ['srt:'])).toEqual({ error: 'host' });
  });

  it('schemes, garbage and the hosts that pass', () => {
    expect(checkUrl('ftp://iptv.example.com/list.m3u', ['http:', 'https:'])).toEqual({ error: 'scheme' });
    expect(checkUrl('srt://iptv.example.com:9000', ['http:', 'https:'])).toEqual({ error: 'scheme' });
    expect(checkUrl('not a url', ['http:'])).toEqual({ error: 'invalid' });
    expect(checkUrl('srt:nohost', ['srt:'])).toEqual({ error: 'host' });
    const ok = checkUrl('https://anna:geheim@iptv.example.com/get.php?type=m3u', ['http:', 'https:']);
    expect('url' in ok && ok.url.hostname).toBe('iptv.example.com');
    const srt = checkUrl('srt://iptv.example.com:9000?streamid=ff', ['srt:']);
    expect('url' in srt && srt.url.port).toBe('9000');
    // IP literals pass here; the address check decides on them
    expect('url' in checkUrl('http://192.0.2.10/x', ['http:'])).toBe(true);
    expect('url' in checkUrl('http://[2001:db8::10]/x', ['http:'])).toBe(true);
  });
});

describe('resolveChecked', () => {
  it('LAN switch', async () => {
    const lan = fixed(['192.168.1.5']);
    expect(await refusedCode(resolveChecked('tv.example.com', false, { lookup: lan.lookup, own: [] }))).toBe('address_refused');
    expect(await resolveChecked('tv.example.com', true, { lookup: lan.lookup, own: [] })).toBe('192.168.1.5');
    const loop = fixed(['127.0.0.1']);
    expect(await refusedCode(resolveChecked('tv.example.com', false, { lookup: loop.lookup, own: [] }))).toBe('address_refused');
    expect(await refusedCode(resolveChecked('tv.example.com', true, { lookup: loop.lookup, own: [] }))).toBe('address_refused');
  });

  it('every address must pass; literals are checked without a lookup', async () => {
    const mixed = fixed(['192.0.2.10', '169.254.169.254']);
    expect(await refusedCode(resolveChecked('iptv.example.com', true, { lookup: mixed.lookup, own: [] }))).toBe('address_refused');
    const pub = fixed(['192.0.2.10', '2001:db8::10']);
    expect(await resolveChecked('iptv.example.com', false, { lookup: pub.lookup, own: [] })).toBe('192.0.2.10');
    const none = fixed();
    expect(await resolveChecked('192.0.2.10', false, { lookup: none.lookup, own: [] })).toBe('192.0.2.10');
    expect(await resolveChecked('[2001:db8::10]', false, { lookup: none.lookup, own: [] })).toBe('2001:db8::10');
    expect(await refusedCode(resolveChecked('[::1]', true, { lookup: none.lookup, own: [] }))).toBe('address_refused');
    expect(await refusedCode(resolveChecked('postgres', true, { lookup: none.lookup, own: [] }))).toBe('address_refused');
    expect(none.calls).toEqual([]);
    expect(await refusedCode(resolveChecked('iptv.example.com', false, { lookup: fixed([]).lookup, own: [] }))).toBe('unreachable');
    const fails = { lookup: async () => { throw new Error('getaddrinfo ENOTFOUND iptv.example.com'); }, own: [] };
    const err = await resolveChecked('iptv.example.com', false, fails).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(String(err)).not.toContain('iptv.example.com');
  });
});

describe('ipLiteralUrl', () => {
  it('replaces only the host, IPv6 bracketed', () => {
    const u = new URL('srt://anna:geheim@iptv.example.com:9000?streamid=ff-AB12&passphrase=x');
    expect(ipLiteralUrl(u, '192.0.2.10')).toBe('srt://anna:geheim@192.0.2.10:9000?streamid=ff-AB12&passphrase=x');
    expect(ipLiteralUrl(u, '2001:db8::10')).toBe('srt://anna:geheim@[2001:db8::10]:9000?streamid=ff-AB12&passphrase=x');
    expect(u.hostname).toBe('iptv.example.com');
    expect(ipLiteralUrl(new URL('http://iptv.example.com/live/101.ts'), '192.0.2.10')).toBe('http://192.0.2.10/live/101.ts');
  });
});
