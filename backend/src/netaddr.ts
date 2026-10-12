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

/** true when ip lies in one of the CIDRs (IPv4, IPv6, IPv4-mapped IPv6). Unparseable or unknown addresses and broken CIDRs never match: ambiguous = remote. */
export function isHomeAddress(ip: string, cidrs: string[]): boolean {
  const b = toBytes(ip);
  return b !== null && cidrs.some((c) => inCidr(b, c));
}

interface AddrReq { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }
const hdr = (req: AddrReq, k: string) => {
  const v = req.headers[k];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : '';
};

/**
 * The caller's address, derived like the gateway's clientKey: X-Real-IP, else the LAST X-Forwarded-For entry (the one our proxy appended),
 * else the socket peer. Never req.ip: Fastify's trustProxy takes the leftmost (client-controlled) entry.
 */
export function clientAddress(req: AddrReq): string {
  const real = hdr(req, 'x-real-ip').trim();
  if (real) return real.slice(0, 64);
  const last = hdr(req, 'x-forwarded-for').split(',').pop()?.trim();
  return (last || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

/** Home network check for a request: without any forwarding header only a loopback peer is home (a docker bridge peer is not). */
export function isHomeRequest(req: AddrReq, cidrs: string[]): boolean {
  if (!hdr(req, 'x-real-ip').trim() && !hdr(req, 'x-forwarded-for').trim()) return isHomeAddress(req.socket?.remoteAddress ?? '', ['127.0.0.0/8', '::1/128']);
  return isHomeAddress(clientAddress(req), cidrs);
}
