// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lookup as dnsLookupAll } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { FetchError } from './fetch.js';

/**
 * The address guard of spec §3.4: every provider URL livetv opens is checked here first. Schemes are http/https/srt only,
 * single-label hosts (Docker service names such as `backend`, `postgres`) are refused, the host is resolved once and every
 * address must be public unicast (private ranges only with the source's *LAN erlauben*), and the connection is then made to the
 * checked address itself (guardedFetch's `lookup`, or the IP-literal URL of an SRT caller input), so DNS rebinding cannot
 * switch it. Errors are fixed codes: never a URL, host or credential.
 *
 * `classifyAddress` is copied verbatim into the backend's save-time check (Task 15); both copies are pinned by
 * `test-vectors/livetv-ip-classes.json` (plan pre-flight F18). It is pure byte arithmetic on purpose, so the copy needs nothing
 * but `node:net`.
 */
export type Cidr = { addr: string; bits: number };
export type AddressClass = 'public' | 'private' | 'refused';
export type UrlScheme = 'http:' | 'https:' | 'srt:';

/** an address as bytes (4 or 16), or null when it is not an IP literal; an IPv6 zone (`%eth0`) is ignored */
function toBytes(ip: string): number[] | null {
  if (isIPv4(ip)) return ip.split('.').map(Number);
  const s = ip.replace(/%.*$/, '');
  if (!isIPv6(s)) return null;
  // an embedded dotted IPv4 tail (`::ffff:1.2.3.4`) becomes two hex groups
  let hex = s;
  const tail = s.slice(s.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const b = tail.split('.').map(Number) as [number, number, number, number];
    hex = `${s.slice(0, s.length - tail.length)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [left = '', right] = hex.split('::');
  const l = left ? left.split(':') : [];
  const r = right === undefined ? null : right ? right.split(':') : [];
  const groups = r === null ? l : [...l, ...new Array<string>(8 - l.length - r.length).fill('0'), ...r];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => { const v = parseInt(g, 16); return [v >> 8, v & 0xff]; });
}

type Range = { bytes: number[]; bits: number };
const range = (addr: string, bits: number): Range => ({ bytes: toBytes(addr)!, bits });
function inRange(a: readonly number[], r: Range): boolean {
  if (a.length !== r.bytes.length) return false;
  const bits = Math.max(0, Math.min(r.bits, a.length * 8));
  for (let i = 0; i < bits; i += 8) {
    const n = Math.min(8, bits - i);
    const mask = (0xff << (8 - n)) & 0xff;
    if ((a[i / 8]! & mask) !== (r.bytes[i / 8]! & mask)) return false;
  }
  return true;
}

const REFUSED_V4 = [range('127.0.0.0', 8), range('0.0.0.0', 8), range('169.254.0.0', 16), range('224.0.0.0', 4), range('100.64.0.0', 10), range('255.255.255.255', 32)];
const REFUSED_V6 = [range('::1', 128), range('::', 128), range('fe80::', 10), range('ff00::', 8)];
const PRIVATE_V4 = [range('10.0.0.0', 8), range('172.16.0.0', 12), range('192.168.0.0', 16)];
const PRIVATE_V6 = [range('fc00::', 7)];
/** IPv6 forms that carry an IPv4 address in their last 32 bits: IPv4-mapped and the NAT64 well-known prefix */
const EMBEDS_V4 = [range('::ffff:0:0', 96), range('64:ff9b::', 96)];

/**
 * refused: loopback, `0.0.0.0/8`, `::`, link-local (incl. cloud metadata), multicast, `100.64.0.0/10`, broadcast, the container's
 * own subnets (`own`), and anything that is not an IP literal; private: `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`;
 * IPv4-mapped and NAT64 addresses by their embedded IPv4; everything else public.
 */
export function classifyAddress(ip: string, own: readonly Cidr[]): AddressClass {
  const b = toBytes(ip);
  if (!b) return 'refused';
  const a = b.length === 16 && EMBEDS_V4.some((r) => inRange(b, r)) ? b.slice(12) : b;
  const v4 = a.length === 4;
  if ((v4 ? REFUSED_V4 : REFUSED_V6).some((r) => inRange(a, r))) return 'refused';
  for (const c of own) {
    const cb = toBytes(c.addr);
    if (cb && inRange(a, { bytes: cb, bits: c.bits })) return 'refused';
  }
  if ((v4 ? PRIVATE_V4 : PRIVATE_V6).some((r) => inRange(a, r))) return 'private';
  return 'public';
}

/** a host without brackets: `[2001:db8::1]` → `2001:db8::1` */
const bare = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);
const isLiteral = (host: string) => toBytes(host) !== null;
/** a name without a dot (trailing dot ignored) that is not an IP literal: a Docker service name, `localhost` */
const singleLabel = (host: string) => !isLiteral(host) && !host.replace(/\.$/, '').includes('.');

/** parse and check a URL's form: allowed scheme, a host that is not a single label (the address check comes later) */
export function checkUrl(raw: string, schemes: ReadonlyArray<UrlScheme>): { url: URL } | { error: 'scheme' | 'host' | 'invalid' } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid' };
  }
  if (!(schemes as readonly string[]).includes(url.protocol)) return { error: 'scheme' };
  const host = bare(url.hostname);
  if (!host || singleLabel(host)) return { error: 'host' };
  return { url };
}

/**
 * Resolve `host` once and check every answer; returns the first (the one to connect to). A literal is checked without a lookup.
 * Refused or private-without-LAN → `address_refused`; no answer or a failed lookup → `unreachable`.
 */
export async function resolveChecked(host: string, allowLan: boolean, deps: { lookup(h: string): Promise<string[]>; own: readonly Cidr[] }): Promise<string> {
  const h = bare(host);
  if (singleLabel(h)) throw new FetchError('address_refused');
  let ips: string[];
  if (isLiteral(h)) ips = [h];
  else {
    try {
      ips = await deps.lookup(h);
    } catch {
      throw new FetchError('unreachable');
    }
  }
  if (ips.length === 0) throw new FetchError('unreachable');
  for (const ip of ips) {
    const c = classifyAddress(ip, deps.own);
    if (c === 'refused' || (c === 'private' && !allowLan)) throw new FetchError('address_refused');
  }
  return ips[0]!;
}

/** the production resolver for `resolveChecked` / `GuardDeps.lookup`: every address the system resolver answers */
export async function dnsLookup(host: string): Promise<string[]> {
  return (await dnsLookupAll(host, { all: true, verbatim: true })).map((a) => a.address);
}

/** the subnets of this container's own interfaces (read once at start; refused as fetch targets) */
export function ownSubnets(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): Cidr[] {
  const out: Cidr[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      const m = i.cidr ? /^(.+)\/(\d+)$/.exec(i.cidr) : null;
      if (m && toBytes(m[1]!)) out.push({ addr: m[1]!, bits: Number(m[2]) });
    }
  }
  return out;
}

/** `url` with its host replaced by the checked address (IPv6 bracketed); userinfo, port, path and query stay */
export function ipLiteralUrl(url: URL, ip: string): string {
  const u = new URL(url.href);
  u.hostname = isIPv6(ip) ? `[${ip}]` : ip;
  return u.href;
}
