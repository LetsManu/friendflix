// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isIPv4, isIPv6 } from 'node:net';

/**
 * The backend's save-time check of provider URLs (spec §3.4 "mirrored by backend validation on save") and the masked form an admin
 * sees (spec §6.1 `url_hint`, F13). The backend never resolves a provider name and never connects to one: it judges the URL's form
 * (scheme, a host that is not a single label) and IP literals only; livetv checks every resolved address again before it connects.
 *
 * Between the two `---- copied` markers the code is livetv/src/netguard.ts verbatim (`Cidr` … `singleLabel`), with one
 * difference: `own` defaults to none. Both copies are pinned by `test-vectors/livetv-ip-classes.json` (plan pre-flight F18), and
 * test/livetv-sources.test.ts compares the text, so they cannot drift apart. The backend passes no own subnets: the container
 * networks are livetv's, and livetv refuses them after DNS.
 */

// ---- copied from livetv/src/netguard.ts (keep verbatim; test-vectors/livetv-ip-classes.json) ----
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

// 240.0.0.0/4 (reserved) includes the broadcast address 255.255.255.255
const REFUSED_V4 = [
  range('127.0.0.0', 8), range('0.0.0.0', 8), range('169.254.0.0', 16), range('224.0.0.0', 4), range('100.64.0.0', 10), range('240.0.0.0', 4),
  range('192.0.0.0', 24), range('198.18.0.0', 15),
];
const REFUSED_V6 = [range('::1', 128), range('::', 128), range('fe80::', 10), range('ff00::', 8)];
const PRIVATE_V4 = [range('10.0.0.0', 8), range('172.16.0.0', 12), range('192.168.0.0', 16)];
const PRIVATE_V6 = [range('fc00::', 7)];
/**
 * IPv6 forms that carry an IPv4 address, with the byte offset of that address: IPv4-mapped `::ffff:0:0/96`, SIIT
 * `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96` and local-use NAT64 `64:ff9b:1::/48`, IPv4-compatible `::/96` (`::` and `::1` are
 * refused before this) in the last 32 bits; 6to4 `2002::/16` in bits 16-47.
 */
const EMBEDS_V4: Array<[Range, number]> = [
  [range('::ffff:0:0', 96), 12], [range('::ffff:0:0:0', 96), 12], [range('64:ff9b::', 96), 12], [range('64:ff9b:1::', 48), 12],
  [range('::', 96), 12], [range('2002::', 16), 2],
];
/** the IPv4 inside an embedding IPv6 form, else the address itself */
function effective(b: number[]): number[] {
  if (b.length !== 16) return b;
  const e = EMBEDS_V4.find(([r]) => inRange(b, r));
  return e ? b.slice(e[1], e[1] + 4) : b;
}

/**
 * refused: loopback, `0.0.0.0/8`, `::`, link-local (incl. cloud metadata), multicast, `100.64.0.0/10`, `240.0.0.0/4` (incl.
 * broadcast), `192.0.0.0/24`, `198.18.0.0/15`, the container's own subnets (`own`), and anything that is not an IP literal;
 * private: `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`; the IPv6 forms of EMBEDS_V4 by their embedded IPv4; everything
 * else public.
 */
export function classifyAddress(ip: string, own: readonly Cidr[] = []): AddressClass {
  const b = toBytes(ip);
  if (!b) return 'refused';
  if (b.length === 16 && REFUSED_V6.some((r) => inRange(b, r))) return 'refused';
  const a = effective(b);
  const v4 = a.length === 4;
  if ((v4 ? REFUSED_V4 : REFUSED_V6).some((r) => inRange(a, r))) return 'refused';
  for (const c of own) {
    const cb = toBytes(c.addr);
    if (cb && (inRange(a, { bytes: cb, bits: c.bits }) || inRange(b, { bytes: cb, bits: c.bits }))) return 'refused';
  }
  if ((v4 ? PRIVATE_V4 : PRIVATE_V6).some((r) => inRange(a, r))) return 'private';
  return 'public';
}

/** a host without brackets: `[2001:db8::1]` → `2001:db8::1` */
const bare = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);
const isLiteral = (host: string) => toBytes(host) !== null;
/** a name without a dot (trailing dot ignored) that is not an IP literal: a Docker service name, `localhost` */
const singleLabel = (host: string) => !isLiteral(host) && !host.replace(/\.$/, '').includes('.');
// ---- end of the copy ----

export type SourceUrlCode = 'scheme' | 'host' | 'lan_required' | 'refused' | 'invalid';

/**
 * The save-time check (spec §3.4): `invalid` = not a URL, `scheme` = not one of `schemes`, `host` = no host or a single-label name
 * (a Docker service name such as `backend`, `localhost`), `refused` = an IP literal that is never allowed (loopback, link-local,
 * multicast, …), `lan_required` = a private IP literal while the source does not allow the LAN. A host name passes: it is resolved
 * and checked by livetv, never here. The URL parser has already normalised IPv4 forms (`0x7f.1`, `2130706433` → `127.0.0.1`).
 */
export function checkSourceUrl(raw: string, o: { allowLan: boolean; schemes: Array<'http:' | 'https:' | 'srt:'> }): { ok: true } | { ok: false; code: SourceUrlCode } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid' };
  }
  if (!(o.schemes as readonly string[]).includes(url.protocol)) return { ok: false, code: 'scheme' };
  const host = bare(url.hostname);
  if (!host || singleLabel(host)) return { ok: false, code: 'host' };
  if (!isLiteral(host)) return { ok: true };
  const c = classifyAddress(host);
  if (c === 'refused') return { ok: false, code: 'refused' };
  if (c === 'private' && !o.allowLan) return { ok: false, code: 'lan_required' };
  return { ok: true };
}

/** a failed save-time check as the fixed refusal code a route answers: a wrong scheme or no URL is `invalid` (as the schema answers it), a single-label host `refused` */
export function urlRefusal(code: SourceUrlCode): 'invalid' | 'lan_required' | 'refused' {
  const map: Record<SourceUrlCode, 'invalid' | 'lan_required' | 'refused'> = { invalid: 'invalid', scheme: 'invalid', host: 'refused', lan_required: 'lan_required', refused: 'refused' };
  return map[code];
}

/**
 * The only form of a provider URL a browser ever sees (F13): scheme, host (with a port when the URL names one), then "/…" — never
 * userinfo, a path, a query or a fragment. Something that is not a URL is "…".
 */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host ? `${u.protocol}//${u.host}/…` : '…';
  } catch {
    return '…';
  }
}
