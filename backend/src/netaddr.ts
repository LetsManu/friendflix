// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isIP } from 'node:net';

/** Parses IPv4 / IPv6 (incl. IPv4-mapped ::ffff:a.b.c.d and a zone id) into 16 bytes (IPv4 as ::ffff:a.b.c.d); null = not an address. */
function toBytes(raw: string): Uint8Array | null {
  let s = raw.trim();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v = isIP(s);
  if (!v) return null;
  const out = new Uint8Array(16);
  if (v === 4) {
    out[10] = out[11] = 0xff;
    s.split('.').forEach((p, i) => (out[12 + i] = Number(p)));
    return out;
  }
  let tail: number[] = [];
  const dot = s.lastIndexOf('.');
  if (dot >= 0) { // ::ffff:1.2.3.4 -> two trailing hextets
    const c = s.lastIndexOf(':');
    const q = s.slice(c + 1).split('.').map(Number);
    tail = [(q[0]! << 8) | q[1]!, (q[2]! << 8) | q[3]!];
    s = s.slice(0, c + 1) + '0:0';
  }
  const [head = '', rest] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = [...a, ...Array(rest === undefined ? 0 : 8 - a.length - b.length).fill('0'), ...b].map((g) => parseInt(g, 16));
  if (tail.length) groups.splice(6, 2, ...tail);
  groups.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 0xff; });
  return out;
}

function inCidr(ip: Uint8Array, cidr: string): boolean {
  const [base, lenRaw] = cidr.trim().split('/');
  const b = toBytes(base ?? '');
  if (!b) return false;
  const v4 = isIP((base ?? '').trim()) === 4;
  const max = v4 ? 32 : 128;
  const len = lenRaw === undefined ? max : /^\d{1,3}$/.test(lenRaw) ? Number(lenRaw) : -1;
  if (len < 0 || len > max) return false;
  let bits = v4 ? len + 96 : len; // IPv4 is compared in its mapped form
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip[i]! & mask) !== (b[i]! & mask)) return false;
  }
  return true;
}

/** true for a parseable address or CIDR (IPv4 /0-32, IPv6 /0-128); used to fail fast on a bad HOME_NETWORKS entry */
export function isValidCidr(cidr: string): boolean {
  const [base, lenRaw, extra] = cidr.trim().split('/');
  if (extra !== undefined || !base) return false;
  const v = isIP(base.trim());
  if (!v) return false;
  if (lenRaw === undefined) return true;
  return /^\d{1,3}$/.test(lenRaw) && Number(lenRaw) <= (v === 4 ? 32 : 128);
}

/** true when ip lies in one of the CIDRs (IPv4, IPv6, IPv4-mapped IPv6). Unparseable or unknown addresses and broken CIDRs never match: ambiguous = remote. */
export function isHomeAddress(ip: string, cidrs: string[]): boolean {
  const b = toBytes(ip);
  return b !== null && cidrs.some((c) => inCidr(b, c));
}

/**
 * Peers whose X-Forwarded-For Fastify believes (`trustProxy`): loopback, link-local and private (RFC 1918 / unique-local) addresses, i.e. the
 * documented setups (the reverse proxy on the host, or in a bridge container, reaches the backend on BIND_ADDR). Anything else that connects
 * directly is taken at its socket address, so a spoofed X-Forwarded-For cannot pick another rate-limit bucket. A proxy that reaches the
 * backend from a public address is not supported (docs/setup.md). `req.ip` is then the first address, walking back from the peer, that is not
 * one of these: the client the proxy appended.
 */
export const TRUSTED_PROXY_RANGES: readonly string[] = ['loopback', 'linklocal', 'uniquelocal'];

interface AddrReq { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }
const hdr = (req: AddrReq, k: string) => {
  const v = req.headers[k];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : '';
};

/** true when the direct peer is a proxy we trust: loopback, link-local or private (the same rule as [TRUSTED_PROXY_RANGES]) */
export function isTrustedPeer(ip: string | undefined): boolean {
  return !!ip && isHomeAddress(ip, TRUSTED_PEER_CIDRS);
}
const TRUSTED_PEER_CIDRS = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'];

/**
 * The caller's address: from a trusted proxy peer (see [isTrustedPeer]) X-Real-IP, else the LAST X-Forwarded-For entry (the one our proxy
 * appended); from any other peer, or without a usable header, the socket address. Headers a direct (non-proxy) client sends are never
 * believed. Same address as Fastify's `req.ip` in the documented setup, where the proxy sends exactly one entry.
 */
export function clientAddress(req: AddrReq): string {
  return (forwardedAddress(req) || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

/** The address a trusted proxy's header names (X-Real-IP, else the last X-Forwarded-For entry); '' when the peer is not trusted or neither carries a usable value (e.g. "X-Forwarded-For: ,"). */
function forwardedAddress(req: AddrReq): string {
  if (!isTrustedPeer(req.socket?.remoteAddress)) return '';
  const real = hdr(req, 'x-real-ip').trim();
  if (real) return real;
  return hdr(req, 'x-forwarded-for').split(',').pop()?.trim() ?? '';
}

let noted = false;
/** test hook: allows the one-time warning of [noteUntrustedForwarding] again */
export function resetUntrustedForwardingNote(): void { noted = false; }
/**
 * Once per process: a request carried X-Forwarded-For but its peer is not loopback/private, so the header is ignored. Usually a proxy
 * reaching the backend over a public address, Tailscale (100.64.0.0/10) or public IPv6, which is not supported (all users would then share
 * one client address). Names no address.
 */
export function noteUntrustedForwarding(req: AddrReq, log: { warn: (msg: string) => void }): void {
  if (noted || !hdr(req, 'x-forwarded-for') || isTrustedPeer(req.socket?.remoteAddress)) return;
  noted = true;
  log.warn('X-Forwarded-For from a peer that is not loopback or private was ignored; a reverse proxy must reach the backend from a private address (docs/setup.md). Logged once.');
}

/** Home network check for a request: without a usable forwarding header only a loopback peer is home (a docker bridge peer is not). */
export function isHomeRequest(req: AddrReq, cidrs: string[]): boolean {
  if (!forwardedAddress(req)) return isHomeAddress(req.socket?.remoteAddress ?? '', ['127.0.0.0/8', '::1/128']);
  return isHomeAddress(clientAddress(req), cidrs);
}
