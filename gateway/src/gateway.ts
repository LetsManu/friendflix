import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
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
  /** only present for Chromecast tokens: the one item / media source / play session the token may touch */
  scope?: { itemId: string; mediaSourceId: string; playSessionId: string };
  /** cast only: 'img' tokens may fetch poster images and nothing else (default 'media') */
  kind?: 'media' | 'img';
  /** cast only: resolution cap for the token (role limit, at most 1080) */
  maxHeight?: number;
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
  new RegExp(`^/Videos/${ID}/Trickplay/\\d{2,4}/\\d{1,5}\\.jpg$`),
  new RegExp(`^/Items/${ID}/Images/(Primary|Backdrop|Logo|Thumb|Banner)(/\\d{1,3})?$`),
];

/**
 * Chromecast subset (token in the URL path, no cookie): HLS playlists + segments, VTT subtitles, poster images.
 * No /stream (direct download), no Trickplay, no Logo/Thumb/Banner.
 */
export const CAST_PATHS: RegExp[] = [
  new RegExp(`^/Videos/${ID}/(master|main)\\.m3u8$`),
  new RegExp(`^/Videos/${ID}/(hls1?|hls)/[\\w.-]+/[\\w.-]+$`),
  new RegExp(`^/Videos/${ID}/${ID}/Subtitles/\\d{1,3}/\\d{1,10}/Stream\\.vtt$`),
  new RegExp(`^/Items/${ID}/Images/(Primary|Backdrop)$`),
];
const CAST_ROUTE = /^\/media\/c\/([A-Za-z0-9_-]{43})(\/.*)$/;
const CAST_PREFIX = '/media/c/';
const CAST_PLAYLIST_MAX = 8 * 1024 * 1024; // very long films at short segment lengths reach several MB
const CAST_DROP_QUERY = new Set(['livestreamid', 'deviceid']);
const CAST_CLAMP_HEIGHT = ['maxheight', 'height'];
const CAST_CLAMP_WIDTH = ['maxwidth', 'width'];
const CAST_FAIL_LIMIT = 30; // DISTINCT failing tokens per minute and client address
const CAST_BLOCK_MS = 5 * 60_000;
const CAST_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
  'cross-origin-resource-policy': 'cross-origin',
};

const IMAGE_PATH = /^\/Items\/[0-9a-fA-F]{32}\/Images\//;
const STRIP_QUERY = new Set(['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token', 'token']);
const CLAMP_QUERY = ['maxstreamingbitrate', 'videobitrate'];
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition'];

/** Returns a safe normalized path or null. Rejects traversal, encoded slashes, backslashes, control chars. */
export function normalizePath(raw: string, allow: RegExp[] = ALLOWED_PATHS): string | null {
  if (/%2f|%5c|%00|%2e%2e/i.test(raw)) return null;
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes('..') || p.includes('\\') || p.includes('//') || /[\x00-\x1f]/.test(p)) return null;
  return allow.some((re) => re.test(p)) ? p : null;
}

export const normalizeCastPath = (raw: string) => normalizePath(raw, CAST_PATHS);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const lc = (v: string) => v.replace(/-/g, '').toLowerCase();

/** Removes token-like parameters from one playlist URI (relative, optionally with a query). */
export function stripUriTokens(uri: string): string {
  const q = uri.indexOf('?');
  if (q === -1) return uri;
  const keep = uri.slice(q + 1).split('&').filter((kv) => {
    let k = kv.split('=')[0] ?? '';
    try { k = decodeURIComponent(k); } catch { /* keep raw */ }
    return !STRIP_QUERY.has(k.toLowerCase());
  });
  return keep.length ? `${uri.slice(0, q)}?${keep.join('&')}` : uri.slice(0, q);
}

/**
 * Cast playlist hardening: strips api_key-like params from every URI and refuses (null) any URI that does not stay inside
 * /media/c/<token>/ on the same origin once resolved against the playlist's own URL (absolute URLs, //host, /abs paths,
 * ../ escapes, backslash tricks): the receiver would otherwise fetch from another host/path and leak or bypass the gateway.
 * `requestPath` is the public path the playlist was requested at (/media/c/<token>/Videos/<id>/main.m3u8).
 */
export function sanitizePlaylist(text: string, requestPath: string): string | null {
  const m = CAST_ROUTE.exec(requestPath);
  if (!m) return null;
  const prefix = `${CAST_PREFIX}${m[1]}/`;
  const base = `https://h${requestPath.slice(0, requestPath.lastIndexOf('/') + 1)}`;
  let bad = false;
  const check = (u: string) => {
    if (u.includes('\\')) return void (bad = true);
    try {
      const r = new URL(u, base);
      if (r.origin !== 'https://h' || !r.pathname.startsWith(prefix)) bad = true;
    } catch {
      bad = true;
    }
  };
  const out = text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) {
      return line.replace(/(URI\s*=\s*["']?)([^"',]*)/gi, (_m, pre: string, u: string) => {
        check(u);
        return `${pre}${stripUriTokens(u)}`;
      });
    }
    const t = line.trim();
    if (!t) return line;
    check(t);
    return stripUriTokens(t);
  });
  return bad ? null : out.join('\n');
}

export function mediaBrowserHeader(deviceId: string, token: string) {
  const esc = (v: string) => v.replace(/["\\\r\n]/g, '');
  return `MediaBrowser Client="FriendFlix", Device="Gateway", DeviceId="${esc(deviceId)}", Version="0.1.0", Token="${esc(token)}"`;
}

export function createGateway(opts: GatewayOptions): { server: Server; metrics: () => string } {
  const f = opts.fetchImpl ?? fetch;
  const base = new URL(opts.jellyfinUrl);
  const authCache = new Map<string, { exp: number; v: Authz | null }>();
  const castCache = new Map<string, { exp: number; v: Authz | null }>();
  const castFails = new Map<string, { start: number; hashes: Set<string>; blockedUntil: number }>();
  const m = { bytes: 0, active: 0, req: new Map<string, number>(), cast: new Map<string, number>() };
  const count = (k: string) => m.req.set(k, (m.req.get(k) ?? 0) + 1);

  const metrics = () =>
    [
      '# TYPE friendflix_gateway_bytes_total counter',
      `friendflix_gateway_bytes_total ${m.bytes}`,
      '# TYPE friendflix_gateway_active_streams gauge',
      `friendflix_gateway_active_streams ${m.active}`,
      '# TYPE friendflix_gateway_requests_total counter',
      ...[...m.req].map(([k, v]) => `friendflix_gateway_requests_total{code="${k}"} ${v}`),
      '# TYPE friendflix_gateway_cast_requests_total counter',
      ...[...m.cast].map(([k, v]) => `friendflix_gateway_cast_requests_total{code="${k}"} ${v}`),
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
    if (url.pathname.startsWith(CAST_PREFIX)) return handleCast(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
    if (!url.pathname.startsWith('/media/')) return end(res, 404, 'not found');

    const path = normalizePath(url.pathname.slice('/media'.length));
    if (!path) {
      count('403');
      return end(res, 403, 'forbidden');
    }
    if (tooLong(url)) {
      count('414');
      return end(res, 414, 'query too long');
    }
    const auth = await authorize(req.headers.cookie);
    if (!auth) {
      count('401');
      return end(res, 401, 'unauthorized');
    }
    return forward(req, res, url, path, auth, count);
  }

  const tooLong = (url: URL) => url.search.length > 2049 || [...url.searchParams].length > 40;

  // ---- Chromecast: /media/c/<token>/<jellyfin path> (token in the path because the receiver sends no cookies) ----
  const castCount = (k: string) => m.cast.set(k, (m.cast.get(k) ?? 0) + 1);
  const clientKey = (req: IncomingMessage) => {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.slice(0, 64);
    const xff = req.headers['x-forwarded-for'];
    const last = (typeof xff === 'string' ? xff : '').split(',').pop()?.trim(); // the proxy appends the real peer last
    return (last || req.socket.remoteAddress || 'unknown').slice(0, 64);
  };
  const isBlocked = (ip: string) => (castFails.get(ip)?.blockedUntil ?? 0) > Date.now();
  /** counts DISTINCT failing token hashes per window: one stale/revoked token retried by a receiver is not an attack, guessing is */
  function noteFail(ip: string, tokenHash: string) {
    const now = Date.now();
    let e = castFails.get(ip);
    if (!e || now - e.start > 60_000) e = { start: now, hashes: new Set(), blockedUntil: e?.blockedUntil ?? 0 };
    if (e.hashes.size <= CAST_FAIL_LIMIT) e.hashes.add(tokenHash); // bounded memory
    if (e.hashes.size > CAST_FAIL_LIMIT) e.blockedUntil = now + CAST_BLOCK_MS;
    castFails.set(ip, e);
    if (castFails.size > 5000) castFails.clear();
  }

  /** 'error' = backend unreachable/failing (not the caller's fault: never counted as a failed auth). */
  async function authorizeCast(ct: string, client: string): Promise<Authz | null | 'error'> {
    const key = `${sha256(ct)}|${client}`; // the raw token is never used as a cache key; the answer depends on the client (first client pins the token)
    const hit = castCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    let v: Authz | null = null;
    try {
      const r = await f(new URL('/internal/authz', opts.backendUrl), {
        method: 'POST',
        headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ ct, client }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const j = (await r.json()) as Authz;
        if (!j.scope) return 'error'; // a cast answer without scope would be an unscoped token: never use it
        v = j;
      } else if (r.status !== 401) return 'error';
    } catch {
      return 'error';
    }
    castCache.set(key, { exp: Date.now() + (v ? 5_000 : 2_000), v });
    if (castCache.size > 5000) castCache.clear();
    return v;
  }

  /** item id (first 32-hex id of the path) and media source id (second one, subtitles only) must match the token's scope */
  function inScope(path: string, url: URL, scope: NonNullable<Authz['scope']>): boolean {
    const ids = path.match(/[0-9a-fA-F]{32}/g) ?? [];
    if (!ids[0] || lc(ids[0]) !== lc(scope.itemId)) return false;
    if (ids[1] && lc(ids[1]) !== lc(scope.mediaSourceId)) return false;
    for (const [k, v] of url.searchParams) {
      const lk = k.toLowerCase();
      if (lk === 'mediasourceid' && lc(v) !== lc(scope.mediaSourceId)) return false;
      if (lk === 'playsessionid' && v !== scope.playSessionId) return false;
    }
    return true;
  }

  async function handleCast(req: IncomingMessage, res: ServerResponse, url: URL) {
    const cors = (code: number, body: string) => end(res, code, body, 'text/plain', CAST_CORS);
    const mm = CAST_ROUTE.exec(url.pathname);
    if (!mm) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CAST_CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Range, Content-Type', 'access-control-max-age': '600' });
      return void res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return cors(405, 'method not allowed');
    const ip = clientKey(req);
    if (isBlocked(ip)) {
      castCount('429');
      res.setHeader('retry-after', '300');
      return cors(429, 'too many requests');
    }
    const path = normalizeCastPath(mm[2]!);
    if (!path) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (tooLong(url)) {
      castCount('414');
      return cors(414, 'query too long');
    }
    const tokenHash = sha256(mm[1]!);
    const auth = await authorizeCast(mm[1]!, ip);
    if (auth === 'error') {
      castCount('503');
      return cors(503, 'unavailable');
    }
    if (!auth || !auth.scope) {
      noteFail(ip, tokenHash);
      castCount('401');
      return cors(401, 'unauthorized');
    }
    if (auth.kind === 'img' && !IMAGE_PATH.test(path)) {
      castCount('403'); // poster tokens may fetch images only
      return cors(403, 'forbidden');
    }
    if (!inScope(path, url, auth.scope)) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    return forward(req, res, url, path, auth, castCount, true);
  }

  async function forward(req: IncomingMessage, res: ServerResponse, url: URL, path: string, auth: Authz, countCode: (k: string) => void, cast = false) {
    const target = new URL(path, base);
    if (target.origin !== base.origin) return end(res, 403, 'forbidden'); // SSRF guard (defence in depth)
    for (const [k, v] of url.searchParams) {
      const lk = k.toLowerCase();
      if (STRIP_QUERY.has(lk)) continue;
      if (cast && CAST_DROP_QUERY.has(lk)) continue; // stream/device identity comes from the token, never from the receiver's URL
      if (cast && (CAST_CLAMP_HEIGHT.includes(lk) || CAST_CLAMP_WIDTH.includes(lk))) {
        const cap = auth.maxHeight ?? 1080;
        const lim = CAST_CLAMP_WIDTH.includes(lk) ? Math.ceil((cap * 16) / 9) : cap; // widths: 16:9 equivalent of the height cap
        const n = Number(v);
        target.searchParams.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, lim) : lim));
        continue;
      }
      if (CLAMP_QUERY.includes(lk)) {
        const n = Number(v);
        target.searchParams.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, auth.maxBitrate) : auth.maxBitrate));
        continue;
      }
      target.searchParams.append(k, v);
    }
    const requestUrl = `${base.origin}${target.pathname}${target.search}`;
    const playlist = cast && /\.m3u8$/.test(path);
    const extra = cast ? CAST_CORS : undefined;

    // identity: keep upstream bytes as-is so content-length matches the body we relay
    const headers: Record<string, string> = { Authorization: mediaBrowserHeader(auth.deviceId, auth.token), 'accept-encoding': 'identity' };
    // cast playlists are rewritten, so they are always fetched whole and unconditionally
    for (const h of playlist ? ['accept'] : ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }

    const ac = new AbortController();
    res.on('close', () => ac.abort());
    let up: Response;
    try {
      up = await f(requestUrl, { method: req.method, headers, signal: ac.signal, redirect: 'manual' });
    } catch {
      countCode('502');
      return end(res, 502, 'bad gateway', 'text/plain', extra);
    }
    countCode(String(up.status));
    if (up.status >= 300 && up.status < 400 && up.status !== 304) return end(res, 502, 'bad gateway', 'text/plain', extra);

    const out: Record<string, string> = {};
    for (const h of PASS_RESPONSE_HEADERS) {
      // fetch decodes content-encoding transparently, so the upstream length no longer describes the body
      if (h === 'content-length' && up.headers.get('content-encoding')) continue;
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    out['x-content-type-options'] = 'nosniff';
    if (cast) {
      // the URL carries a credential: nothing may be cached (browser or shared), and CORS is open (the receiver has another origin)
      out['cache-control'] = 'no-store';
      Object.assign(out, CAST_CORS);
    } else if (IMAGE_PATH.test(path) && up.status < 400) {
      // Images are static per `tag`: let the browser cache them (private: never in shared caches such as NPM).
      // Everything else (playlists, segments, streams) stays uncacheable unless Jellyfin says otherwise.
      out['cache-control'] = 'private, max-age=86400, stale-while-revalidate=604800';
      out['vary'] = 'Cookie';
    } else {
      out['cache-control'] = (out['cache-control'] ?? 'no-store').replace(/\bpublic\b/i, 'private');
    }

    if (playlist && up.status === 200) {
      // buffered (<8 MB) so every URI can be checked: Jellyfin may emit api_key params or absolute URLs
      const len = Number(up.headers.get('content-length') ?? 0);
      if (len > CAST_PLAYLIST_MAX) return end(res, 502, 'bad gateway', 'text/plain', extra);
      if (req.method === 'HEAD') {
        delete out['content-length'];
        res.writeHead(200, out);
        return void res.end();
      }
      const buf = Buffer.from(await up.arrayBuffer());
      const clean = buf.length > CAST_PLAYLIST_MAX ? null : sanitizePlaylist(buf.toString('utf8'), url.pathname);
      if (clean === null) {
        countCode('502');
        return end(res, 502, 'bad gateway', 'text/plain', extra);
      }
      const body = Buffer.from(clean, 'utf8');
      out['content-length'] = String(body.length);
      delete out['etag'];
      res.writeHead(200, out);
      m.bytes += body.length;
      return void res.end(body);
    }

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

function end(res: ServerResponse, code: number, body: string, type = 'text/plain', extra: Record<string, string> = {}) {
  res.writeHead(code, { 'content-type': type, ...extra });
  res.end(body);
}
