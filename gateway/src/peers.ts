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

const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/** a compose service name (single label, not a number): a dotted name or an address may be the Docker host, whose bridge address can also be the reverse proxy's */
const isServiceName = (host: string) => SERVICE_NAME.test(host) && !/^\d+$/.test(host);
/** the single-label hosts (compose service names, lower case, once each) of the given URLs; anything else is left out */
export function serviceHosts(urls: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u || !URL.canParse(u)) continue;
    const h = new URL(u).hostname.toLowerCase();
    if (isServiceName(h)) out.add(h);
  }
  return [...out];
}

/**
 * Keeps the untrusted set at the addresses of the containers that never proxy a client: livetv, the media server and the bundled request
 * service. `hosts` is read again on every refresh (now, then every `intervalMs`), so a media server URL from the backend's settings is
 * followed. Each name counts on its own: a name that does not resolve (that container is off) adds nothing, any other failure keeps
 * that name's last answer. Only single-label hosts are followed (see [serviceHosts]).
 */
export function watchUntrustedHosts(hosts: () => Iterable<string>, o: { lookup?: Lookup; intervalMs?: number } = {}): { ready: Promise<void>; refresh(): Promise<void>; stop(): void } {
  const lookup = o.lookup ?? defaultLookup;
  const known = new Map<string, string[]>();
  const refresh = async () => {
    const want = [...new Set([...hosts()].map((h) => h.toLowerCase()).filter(isServiceName))];
    for (const h of [...known.keys()]) if (!want.includes(h)) known.delete(h);
    let unsure = false; // a name failed (not ENOTFOUND) before its first answer: keep the set as it is this round
    await Promise.all(want.map(async (h) => {
      try {
        known.set(h, await lookup(h));
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOTFOUND') known.set(h, []);
        else if (!known.has(h)) unsure = true;
      }
    }));
    if (!unsure) setUntrustedPeers([...known.values()].flat());
  };
  const ready = refresh();
  const t = setInterval(() => void refresh(), o.intervalMs ?? 15_000);
  t.unref();
  return { ready, refresh, stop: () => clearInterval(t) };
}

/** [watchUntrustedHosts] for one fixed host; a host that is no compose service name is not followed at all (the set stays as it is) */
export function watchUntrustedHost(host: string, o: { lookup?: Lookup; intervalMs?: number } = {}): { ready: Promise<void>; stop(): void } {
  if (!isServiceName(host)) return { ready: Promise.resolve(), stop: () => {} };
  return watchUntrustedHosts(() => [host], o);
}
