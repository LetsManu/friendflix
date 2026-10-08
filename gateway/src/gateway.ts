import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export interface GatewayOptions {
  jellyfinUrl: string;
  backendUrl: string;
  internalSecret: string;
  metricsToken?: string;
  fetchImpl?: typeof fetch;
}

interface Authz {
  userId: string;
  token: string;
  deviceId: string;
  maxBitrate: number;
}

const ID = '[0-9a-fA-F]{32}';
/**
 * Allowlist of upstream paths. Anything else is rejected, so the gateway can never be used as
 * a general proxy to Jellyfin (or any other host: the upstream origin is fixed anyway).
 */
export const ALLOWED_PATHS: RegExp[] = [
  new RegExp(`^/Videos/${ID}/(master|main)\\.m3u8$`),
  new RegExp(`^/Videos/${ID}/(hls1?|hls)/[\\w.-]+/[\\w.-]+$`),
  new RegExp(`^/Videos/${ID}/stream(\\.\\w{2,5})?$`),
  new RegExp(`^/Videos/${ID}/${ID}/Subtitles/\\d{1,3}/\\d{1,10}/Stream\\.(vtt|srt)$`),
  new RegExp(`^/Items/${ID}/Images/(Primary|Backdrop|Logo|Thumb|Banner)(/\\d{1,3})?$`),
];

const STRIP_QUERY = new Set(['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token', 'token']);
const CLAMP_QUERY = ['maxstreamingbitrate', 'videobitrate'];
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition'];

/** Returns a safe normalized path or null. Rejects traversal, encoded slashes, backslashes, control chars. */
export function normalizePath(raw: string): string | null {
  if (/%2f|%5c|%00|%2e%2e/i.test(raw)) return null;
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes('..') || p.includes('\\') || p.includes('//') || /[\x00-\x1f]/.test(p)) return null;
  return ALLOWED_PATHS.some((re) => re.test(p)) ? p : null;
}

export function mediaBrowserHeader(deviceId: string, token: string) {
  const esc = (v: string) => v.replace(/["\\\r\n]/g, '');
  return `MediaBrowser Client="FriendFlix", Device="Gateway", DeviceId="${esc(deviceId)}", Version="0.1.0", Token="${esc(token)}"`;
}

export function createGateway(opts: GatewayOptions): { server: Server; metrics: () => string } {
  const f = opts.fetchImpl ?? fetch;
  const base = new URL(opts.jellyfinUrl);
  const authCache = new Map<string, { exp: number; v: Authz | null }>();
  const m = { bytes: 0, active: 0, req: new Map<string, number>() };
  const count = (k: string) => m.req.set(k, (m.req.get(k) ?? 0) + 1);

  const metrics = () =>
    [
      '# TYPE friendflix_gateway_bytes_total counter',
      `friendflix_gateway_bytes_total ${m.bytes}`,
      '# TYPE friendflix_gateway_active_streams gauge',
      `friendflix_gateway_active_streams ${m.active}`,
      '# TYPE friendflix_gateway_requests_total counter',
      ...[...m.req].map(([k, v]) => `friendflix_gateway_requests_total{code="${k}"} ${v}`),
    ].join('\n') + '\n';

  async function authorize(cookie: string | undefined): Promise<Authz | null> {
    const sid = /(?:^|;\s*)ff_sid=([\w-]+)/.exec(cookie ?? '')?.[1];
    if (!sid) return null;
    const hit = authCache.get(sid);
    if (hit && hit.exp > Date.now()) return hit.v;
    let v: Authz | null = null;
    try {
      const r = await f(new URL('/internal/authz', opts.backendUrl), {
        method: 'POST',
        headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ sid }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) v = (await r.json()) as Authz;
    } catch {
      v = null;
    }
    authCache.set(sid, { exp: Date.now() + (v ? 5_000 : 2_000), v });
    if (authCache.size > 5000) authCache.clear();
    return v;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return end(res, 200, '{"status":"ok"}', 'application/json');
    if (url.pathname === '/metrics') {
      if (opts.metricsToken && req.headers.authorization !== `Bearer ${opts.metricsToken}`) return end(res, 401, 'unauthorized');
      return end(res, 200, metrics(), 'text/plain; version=0.0.4');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
    if (!url.pathname.startsWith('/media/')) return end(res, 404, 'not found');

    const path = normalizePath(url.pathname.slice('/media'.length));
    if (!path) {
      count('403');
      return end(res, 403, 'forbidden');
    }
    const auth = await authorize(req.headers.cookie);
    if (!auth) {
      count('401');
      return end(res, 401, 'unauthorized');
    }

    const target = new URL(path, base);
    if (target.origin !== base.origin) return end(res, 403, 'forbidden'); // SSRF guard (defence in depth)
    for (const [k, v] of url.searchParams) {
      const lk = k.toLowerCase();
      if (STRIP_QUERY.has(lk)) continue;
      if (CLAMP_QUERY.includes(lk)) {
        const n = Number(v);
        target.searchParams.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, auth.maxBitrate) : auth.maxBitrate));
        continue;
      }
      target.searchParams.append(k, v);
    }

    const headers: Record<string, string> = { Authorization: mediaBrowserHeader(auth.deviceId, auth.token) };
    for (const h of ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }

    const ac = new AbortController();
    res.on('close', () => ac.abort());
    let up: Response;
    try {
      up = await f(target, { method: req.method, headers, signal: ac.signal, redirect: 'manual' });
    } catch {
      count('502');
      return end(res, 502, 'bad gateway');
    }
    count(String(up.status));
    if (up.status >= 300 && up.status < 400 && up.status !== 304) return end(res, 502, 'bad gateway');

    const out: Record<string, string> = {};
    for (const h of PASS_RESPONSE_HEADERS) {
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    out['x-content-type-options'] = 'nosniff';
    out['cache-control'] ??= 'private, no-store';
    res.writeHead(up.status, out);
    if (!up.body || req.method === 'HEAD') return void res.end();

    m.active++;
    const body = Readable.fromWeb(up.body as never);
    body.on('data', (c: Buffer) => (m.bytes += c.length));
    const done = () => {
      m.active--;
    };
    res.once('close', done);
    body.on('error', () => res.destroy());
    body.pipe(res); // streamed, no buffering; backpressure handled by pipe
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) end(res, 500, 'error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65_000;
  return { server, metrics };
}

function end(res: ServerResponse, code: number, body: string, type = 'text/plain') {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}
