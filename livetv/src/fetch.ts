// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { checkUrl, resolveChecked, type Cidr } from './netguard.js';

/**
 * The guarded fetch (spec §3.4, plan ruling 3): every HTTP(S) input livetv reads (M3U, XMLTV, logos, HLS playlists and segments,
 * MPEG-TS streams, probe bytes) goes through here. Each URL passes `checkUrl` and `resolveChecked`, and the socket connects to
 * that checked address through the request's `lookup` option, so no second DNS answer is ever used. Redirects are followed by
 * hand (at most 3, each target checked again, a change of scheme refused); the body is a stream with the byte cap enforced while
 * it flows. Every failure is a `FetchError` whose message is its code: never the URL, host or credentials.
 */
export type FetchErrorCode = 'unreachable' | 'denied' | 'timeout' | 'too_big' | 'address_refused' | 'scheme' | 'redirects' | 'not_found' | 'http_error';
export class FetchError extends Error {
  constructor(readonly code: FetchErrorCode) {
    super(code);
    this.name = 'FetchError';
  }
}

/** `dial` is a test hook only: it maps the checked address to the one actually connected to (a local test server) */
export type GuardDeps = { lookup(h: string): Promise<string[]>; own: readonly Cidr[]; dial?(ip: string, port: number): string };
/**
 * `url`: the URL of the last hop (after redirects), the base for resolving relative references in the body (HLS playlists).
 * Internal only: never put it in an error, a log line or an answer.
 */
export type GuardedResponse = { status: number; url: string; headers: Record<string, string>; body: AsyncIterable<Uint8Array> };
/**
 * `signal`: the caller's own abort (its client went away); it ends the fetch and its body at once, like the timeout does. `pool`:
 * the connections of one run (createPool); without it every request is a connection of its own, as before.
 */
export type FetchOptions = { allowLan: boolean; userAgent?: string; timeoutMs: number; connectTimeoutMs?: number; maxBytes: number; signal?: AbortSignal; pool?: Pool };

/**
 * The connections of one run of a live input (H1 item 4): one kept-alive connection per host, to the address checked once for the
 * run, so its playlist polls and segment fetches stay on one CDN edge instead of a new connection (and DNS answer) for each, where
 * consecutive reads land on different nodes and one of them is behind. The guard is the same: each host is checked by
 * `resolveChecked` before its first connection, and only that checked address is ever connected to (no second DNS answer for the
 * whole run, so no rebinding either). A body not read to its end closes its connection; `destroy()` closes the rest (the run's
 * end). One pool serves one input, so the input's `allowLan` holds for every request through it.
 */
export interface Pool {
  readonly http: http.Agent;
  readonly https: https.Agent;
  /** `<allowLan>|<host>` → the checked address */
  readonly ips: Map<string, string>;
  destroy(): void;
}
export function createPool(): Pool {
  const o = { keepAlive: true, keepAliveMsecs: 1_000, maxFreeSockets: 4, scheduling: 'lifo' as const };
  const pool: Pool = {
    http: new http.Agent(o), https: new https.Agent(o), ips: new Map(),
    destroy: () => { pool.http.destroy(); pool.https.destroy(); pool.ips.clear(); },
  };
  return pool;
}

export const CONNECT_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** a checked URL, or the fixed error for it: a single-label host counts as a refused address, garbage as unreachable */
function checked(raw: string): URL {
  const c = checkUrl(raw, ['http:', 'https:']);
  if ('url' in c) return c.url;
  throw new FetchError(c.error === 'scheme' ? 'scheme' : c.error === 'host' ? 'address_refused' : 'unreachable');
}

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const failure = (e: unknown, signal: AbortSignal) => (e instanceof FetchError ? e : new FetchError(signal.aborted ? 'timeout' : 'unreachable'));

/** `p`, unless the whole-fetch budget runs out first (a hanging DNS lookup): then `timeout` */
async function withinBudget<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new FetchError('timeout'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** one GET to the checked address of `url`; resolves with the response head */
async function requestOnce(url: URL, o: FetchOptions, deps: GuardDeps, signal: AbortSignal): Promise<http.IncomingMessage> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  // a run's pool checks each host once and keeps that address for the run (one edge); without one, every request resolves anew
  const key = `${o.allowLan}|${host}`;
  const ip = o.pool?.ips.get(key) ?? await withinBudget(resolveChecked(host, o.allowLan, deps), signal);
  o.pool?.ips.set(key, ip);
  const secure = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const target = deps.dial ? deps.dial(ip, port) : ip;
  const family = isIP(target) === 6 ? 6 : 4;
  // the only answer the socket ever gets: the checked address (Node asks with `all: true` when it races families)
  const lookup = ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    if (opts?.all) cb(null, [{ address: target, family }]);
    else cb(null, target, family);
  }) as unknown as LookupFunction;
  const headers: Record<string, string> = { host: url.host, accept: '*/*' };
  if (o.userAgent) headers['user-agent'] = o.userAgent;
  const options: https.RequestOptions = {
    method: 'GET', port, path: `${url.pathname}${url.search}`, headers, agent: o.pool ? (secure ? o.pool.https : o.pool.http) : false, signal,
    // a literal never goes through `lookup`, so it is replaced directly (equal to `host` unless the test hook maps it)
    ...(isIP(host) ? { hostname: target } : { hostname: host, lookup }),
    ...(url.username || url.password ? { auth: `${decode(url.username)}:${decode(url.password)}` } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(options, resolve);
    req.on('error', (e) => reject(failure(e, signal)));
    req.on('socket', (s) => {
      if (!s.connecting) return;
      const t = setTimeout(() => req.destroy(new FetchError('timeout')), o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      s.once('connect', () => clearTimeout(t));
      s.once('close', () => clearTimeout(t));
    });
    req.end();
  });
}

/**
 * the body as a stream that stops at `maxBytes` (`too_big`) and fails with fixed codes only. A body read to its end leaves its
 * connection open (a pool then reuses it); any other end closes it.
 */
async function* readBody(res: http.IncomingMessage, maxBytes: number, signal: AbortSignal, done: () => void): AsyncGenerator<Uint8Array> {
  let n = 0;
  let complete = false;
  try {
    for await (const c of res as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > maxBytes) throw new FetchError('too_big');
      yield c;
    }
    complete = res.complete;
  } catch (e) {
    throw failure(e, signal);
  } finally {
    done();
    if (!complete) res.destroy();
  }
}

/**
 * The body as given to callers: `return()` closes the connection even when nothing was read yet (a generator that never started
 * would otherwise skip its `finally` and keep the socket open until the fetch timeout).
 */
function closable(gen: AsyncGenerator<Uint8Array>, close: () => void): AsyncIterableIterator<Uint8Array> {
  let started = false;
  const it: AsyncIterableIterator<Uint8Array> = {
    next: () => { started = true; return gen.next(); },
    return: (v?: unknown) => {
      if (!started) { started = true; close(); }
      return gen.return(v as undefined);
    },
    [Symbol.asyncIterator]: () => it,
  };
  return it;
}

function flatHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/**
 * GET `raw` safely. `timeoutMs` covers the whole fetch including reading the body; the connect phase of each hop has its own
 * `connectTimeoutMs` (default 10 s). 401/403 → `denied`, 404 → `not_found`, any other status ≥ 300 that is not a followed
 * redirect → `http_error`; a declared `content-length` over `maxBytes` → `too_big` before any body is read.
 */
export async function guardedFetch(raw: string, o: FetchOptions, deps: GuardDeps): Promise<GuardedResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  const outer = () => ac.abort();
  if (o.signal?.aborted) ac.abort();
  else o.signal?.addEventListener('abort', outer, { once: true });
  try {
    let url = checked(raw);
    const scheme = url.protocol;
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(url, o, deps, ac.signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECT.has(status) && location) {
        res.destroy();
        if (hop === MAX_REDIRECTS) throw new FetchError('redirects');
        let next: string;
        try {
          next = new URL(location, url).href;
        } catch {
          throw new FetchError('unreachable');
        }
        url = checked(next);
        if (url.protocol !== scheme) throw new FetchError('scheme');
        continue;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        throw new FetchError(status === 401 || status === 403 ? 'denied' : status === 404 ? 'not_found' : 'http_error');
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy();
        throw new FetchError('too_big');
      }
      const onAbort = () => res.destroy(new FetchError('timeout'));
      ac.signal.addEventListener('abort', onAbort, { once: true });
      const done = () => { clearTimeout(timer); ac.signal.removeEventListener('abort', onAbort); o.signal?.removeEventListener('abort', outer); };
      const body = closable(readBody(res, o.maxBytes, ac.signal, done), () => { done(); res.destroy(); });
      return { status, url: url.href, headers: flatHeaders(res.headers), body };
    }
  } catch (e) {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', outer);
    throw failure(e, ac.signal);
  }
}
