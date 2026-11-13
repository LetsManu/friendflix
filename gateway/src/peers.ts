// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Which direct peers may name the client in X-Real-IP / X-Forwarded-For (review L2). The same rule as the backend's `isTrustedPeer`
 * (backend/src/netaddr.ts): loopback, link-local and private (RFC 1918 / unique-local) addresses, i.e. the documented setups where the
 * reverse proxy reaches the gateway on BIND_ADDR from the host or a bridge container. Any other peer is taken at its socket address,
 * so a client that reaches gateway:4000 directly cannot pick the address a live token is pinned to or a fresh failure-limiter bucket.
 *
 * The livetv container sits on a private address too but never proxies anyone (it only answers the backend and the gateway): its
 * addresses (LIVETV_URL's host, resolved now and every 15 s) are never trusted, so a taken-over livetv cannot claim a viewer's address.
 */
const TRUSTED = new BlockList();
for (const [net, len] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]] as const) TRUSTED.addSubnet(net, len, 'ipv4');
for (const [net, len] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) TRUSTED.addSubnet(net, len, 'ipv6');

/** the plain form of an address: lower case, no zone id, an IPv4-mapped IPv6 address as its IPv4 address; '' when it is none */
export function bareAddress(raw: string | undefined): string {
  let s = (raw ?? '').trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1]!;
  return isIP(s) ? s : '';
}
const isLoopback = (a: string) => a === '::1' || a.startsWith('127.');

let untrusted: ReadonlySet<string> = new Set();
/** the addresses that are never a trusted proxy (the livetv container's); loopback is never among them */
export function setUntrustedPeers(addrs: Iterable<string>): void {
  untrusted = new Set([...addrs].map(bareAddress).filter((a) => a && !isLoopback(a)));
}

/** true when the direct peer is a proxy whose forwarding headers count */
export function isTrustedPeer(peer: string | undefined): boolean {
  const a = bareAddress(peer);
  if (!a || untrusted.has(a)) return false;
  return TRUSTED.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4');
}

type Lookup = (host: string) => Promise<string[]>;
const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address);

/**
 * Keeps the untrusted set at the addresses of `host` (resolved now, then every `intervalMs`); a name that does not resolve (livetv is
 * off) leaves the set empty. Only a single-label host (a compose service name such as `livetv`) is followed: a dotted name or an
 * address may be the Docker host itself, whose bridge address can also be the reverse proxy's. Returns the stop function.
 */
export function watchUntrustedHost(host: string, o: { lookup?: Lookup; intervalMs?: number } = {}): { ready: Promise<void>; stop(): void } {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host) || /^\d+$/.test(host)) return { ready: Promise.resolve(), stop: () => {} };
  const lookup = o.lookup ?? defaultLookup;
  const refresh = async () => {
    try {
      setUntrustedPeers(await lookup(host));
    } catch (e) {
      // the name is gone (the livetv profile is off): nothing to exclude; any other failure keeps the last answer
      if ((e as { code?: string }).code === 'ENOTFOUND') setUntrustedPeers([]);
    }
  };
  const ready = refresh();
  const t = setInterval(() => void refresh(), o.intervalMs ?? 15_000);
  t.unref();
  return { ready, stop: () => clearInterval(t) };
}
