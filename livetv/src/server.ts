// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { log as defaultLog, type Log } from './log.js';
import { dnsLookup, ownSubnets } from './netguard.js';
import { HEADER_BODY_SHA, ReplayCache, healthProof, isBodySha, isNonce, verify, type Verifier } from './protocol.js';
import { clearStale } from './cache.js';
import { passthroughDriver } from './passthrough.js';
import { Previews } from './preview.js';
import { remuxDriver } from './remux.js';
import { benchmarkRoutes } from './routes/benchmark.js';
import { fetchRoutes } from './routes/fetch.js';
import { fileRoutes } from './routes/files.js';
import { ingestRoutes } from './routes/ingest.js';
import { parseRoutes } from './routes/parse.js';
import { streamRoutes } from './routes/streams.js';
import { createRun } from './run.js';
import { IngestHub, srtgateSpawner } from './srtingest.js';
import { Streams } from './streams.js';
import { encoders, systemView, type Encoder, type SystemView } from './system.js';

/**
 * livetv's internal API (spec §3.2; only on the internal `livetv` network, port 8090). `/healthz` is open (with `?n=<nonce>` it
 * adds the proof of key, protocol.ts); every `/v1/*` request
 * is signed (protocol.ts), JSON only, at most 64 KB (one route takes a streamed file instead, `rawBody`); `/s/*` (stream files for the gateway, Task 27) is unsigned and addressed by
 * a random stream key. Later tasks add their routes to the table (`AppDeps.routes`). `start()` also runs the SRT push ingest
 * (Task 29): one `srtgate` helper on LIVETV_SRT_PORTS, its set from `PUT /v1/ingest`, its feeds readable by the stream drivers.
 */
export const API_VERSION = 1;
export const MAX_BODY = 64 * 1024;
/** the one route with a larger cap: POST /v1/fetch/m3u carries the skip list (2 000 names of up to 200 characters) */
export const MAX_BODY_M3U = 512 * 1024;
/**
 * a request must be received completely within this (from the moment it is routed), unless its route says otherwise
 * (`bodyTimeoutMs`); a request still sending after that is cut off. The answer may take longer (an XMLTV stream runs for minutes).
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface RouteCall {
  req: IncomingMessage;
  res: ServerResponse;
  /** the capture groups of a RegExp path */
  params: string[];
  /** the parsed JSON body (null when there is none, and for a `rawBody` route) */
  json: unknown;
  /** `rawBody` routes: the body's SHA-256 the signature covers; the route reads `req` itself and must compare the bytes with it */
  bodySha256?: string;
}
/** a JSON answer; a route that streams (NDJSON, images, segments) writes `res` itself and returns nothing */
export interface Answer { status: number; json?: unknown }
export interface Route {
  method: Method;
  /** exact path, or a pattern anchored with ^...$ (its groups become `params`) */
  path: string | RegExp;
  /** the signed body cap in bytes when it is not MAX_BODY */
  maxBody?: number;
  /**
   * the body is a stream (`application/octet-stream`), not JSON, and is not read before the route runs: the signature covers its
   * declared SHA-256 (protocol.ts HEADER_BODY_SHA), a declared length over `maxBody` is refused with 413 first
   */
  rawBody?: true;
  /** how long receiving the request may take when it is not REQUEST_TIMEOUT_MS (a streamed body is read as fast as it is parsed) */
  bodyTimeoutMs?: number;
  handle(c: RouteCall): Promise<Answer | void>;
}

export interface AppDeps {
  verifier: Verifier;
  version: string | null;
  /** 16 hex, random per process: a change tells the backend that livetv restarted (and lost its ingest set) */
  bootId: string;
  system: () => Promise<SystemView>;
  /** the routes of later tasks (streams, fetch, ingest, `/s/*`) */
  routes?: Route[];
  /** refusals and failures: method, path and a code, never a header or body */
  warn?: Log;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/**
 * The body as text; `too_large` when it passes the cap (MAX_BODY, or the route's own) (the rest is read and dropped, so the 413 still reaches the caller);
 * `broken` when the request stream fails (the caller aborted).
 */
function readBody(req: IncomingMessage, max: number = MAX_BODY): Promise<{ body: string } | { error: 'too_large' | 'broken' }> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > max) { req.resume(); resolve({ error: 'too_large' }); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= max) { chunks.push(c); return; }
      req.off('data', onData);
      chunks.length = 0;
      req.resume();
      resolve({ error: 'too_large' });
    };
    req.on('data', onData);
    req.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ error: 'broken' }));
  });
}

/**
 * What a log line may show of a path: an exact route as it is; otherwise the prefix (`/v1/<area>`, `/s`) with every later
 * segment replaced by `*`. Never the raw path: segments may be stream keys (`/s/<streamKey>/…`, a credential) or input.
 */
export function logPath(route: Route | undefined, path: string): string {
  if (route && typeof route.path === 'string') return route.path;
  const seg = path.split('/').slice(1);
  const keep = seg[0] === 'v1' ? 2 : 1;
  return '/' + seg.map((x, i) => (i < keep && /^[a-z0-9-]{1,40}$/.test(x) ? x : '*')).join('/');
}

/** a refused signature: 401 with the code, logged with method, path (logPath) and code only */
function refuse(res: ServerResponse, route: Route, method: string, path: string, error: string, warn?: Log): void {
  warn?.(`refused ${method} ${logPath(route, path)}: ${error}`);
  res.req.resume(); // a body nobody reads (a streamed one) is dropped, so the answer still reaches the caller
  send(res, 401, { error });
}

/** a request not received completely within `ms` is cut off (Node's own requestTimeout is only the outer bound, start()) */
function cutOffAfter(req: IncomingMessage, ms: number): void {
  if (req.complete) return;
  const t = setTimeout(() => { if (!req.complete) req.destroy(); }, ms);
  const clear = () => clearTimeout(t);
  req.once('end', clear);
  req.once('close', clear);
}

const matches = (r: Route, path: string): string[] | null => {
  if (typeof r.path === 'string') return r.path === path ? [] : null;
  const m = r.path.exec(path);
  return m ? m.slice(1) : null;
};

export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes: Route[] = [{ method: 'GET', path: '/v1/system', handle: async () => ({ status: 200, json: await deps.system() }) }, ...(deps.routes ?? [])];
  return async (req, res) => {
    const target = req.url ?? '/';
    const path = target.split('?')[0]!;
    const method = req.method ?? 'GET';
    let route: Route | undefined;
    try {
      if (path === '/healthz') {
        if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
        const health = { ok: true, api: API_VERSION, version: deps.version, bootId: deps.bootId };
        // the Docker health check asks without a nonce; the backend's detection asks with one and checks the proof (1b review I2)
        const q = new URLSearchParams(target.slice(path.length + 1));
        if (!q.has('n')) return send(res, 200, health);
        const n = q.getAll('n');
        if (n.length !== 1 || !isNonce(n[0]!)) return send(res, 400, { error: 'invalid_nonce' });
        return send(res, 200, { ...health, proof: healthProof(deps.verifier.key, n[0]!) });
      }
      const signed = path.startsWith('/v1/');
      if (!signed && !path.startsWith('/s/')) return send(res, 404, { error: 'not_found' });
      let params: string[] | null = null;
      let known = false;
      for (const r of routes) {
        const p = matches(r, path);
        if (!p) continue;
        known = true;
        if (r.method === method) { route = r; params = p; break; }
      }
      if (!known) return send(res, 404, { error: 'not_found' });
      if (!route || !params) return send(res, 405, { error: 'method_not_allowed' });
      cutOffAfter(req, route.bodyTimeoutMs ?? REQUEST_TIMEOUT_MS);
      let json: unknown = null;
      let bodySha256: string | undefined;
      if (signed && route.rawBody) {
        if (Number(req.headers['content-length'] ?? 0) > (route.maxBody ?? MAX_BODY)) { req.resume(); return send(res, 413, { error: 'too_large' }); }
        const declared = req.headers[HEADER_BODY_SHA];
        if (declared === undefined) return refuse(res, route, method, path, 'missing', deps.warn);
        if (!isBodySha(declared)) return refuse(res, route, method, path, 'malformed', deps.warn);
        const auth = verify(deps.verifier, { method, path: target, headers: req.headers, bodySha256: declared });
        if (!auth.ok) return refuse(res, route, method, path, auth.error, deps.warn);
        if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) { req.resume(); return send(res, 415, { error: 'binary_required' }); }
        bodySha256 = declared;
      } else if (signed) {
        const read = await readBody(req, route.maxBody);
        if ('error' in read) return read.error === 'too_large' ? send(res, 413, { error: 'too_large' }) : send(res, 400, { error: 'bad_request' });
        const body = read.body;
        // the whole request target is signed: a query string cannot be changed or added on the way
        const auth = verify(deps.verifier, { method, path: target, headers: req.headers, body });
        if (!auth.ok) return refuse(res, route, method, path, auth.error, deps.warn);
        if (body !== '') {
          if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json_required' });
          try { json = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_body' }); }
        }
      }
      const answer = await route.handle({ req, res, params, json, ...(bodySha256 ? { bodySha256 } : {}) });
      if (answer) send(res, answer.status, answer.json);
    } catch {
      deps.warn?.(`route ${method} ${logPath(route, path)} failed`);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
      else res.destroy();
    }
  };
}

/** Reads the config (throws on a wrong value), listens on PORT. The signal handlers are installed by the entry point below. */
export async function start(env: NodeJS.ProcessEnv = process.env, o: { log?: Log; host?: string } = {}): Promise<Server> {
  const cfg = loadConfig(env);
  const log = o.log ?? defaultLog;
  // never read: livetv signs with its own key only (config.ts). A value here would be the backend's key within reach of ffmpeg.
  // Said first, before the SRT ingest's helper can log anything.
  if (env.INTERNAL_SECRET || env.INTERNAL_SECRET_FILE) log('INTERNAL_SECRET is set in the environment of livetv but never used: remove it there');
  const verifier: Verifier = { key: cfg.key, cache: new ReplayCache(), notBefore: Date.now() };
  const run = createRun();
  const system = systemView({ fs, run, cacheDir: cfg.cacheDir, cacheMaxBytes: cfg.cacheMaxBytes, srtPorts: cfg.srtPorts });
  // the encoders /v1/system lists, asked once (a failed or empty answer is asked again next time)
  let encoderList: Encoder[] | null = null;
  const listEncoders = async (): Promise<Encoder[]> => {
    if (!encoderList) {
      const l = await encoders(run);
      if (l.length) encoderList = l;
    }
    return encoderList ?? [];
  };
  // the production guard: the system resolver and this container's own subnets, read once here (never a test `dial`)
  const guard = { lookup: dnsLookup, own: ownSubnets() };
  // the DVR cache: directories of a previous process are left over (its streams are gone)
  void clearStale(cfg.cacheDir);
  // the SRT push ingest: srtgate listens on every port of the range; its feed set arrives with PUT /v1/ingest
  const ingest = new IngestHub({ spawn: srtgateSpawner(cfg.srtPorts), now: Date.now, log });
  const previews = new Previews({ run, log });
  const media = remuxDriver({ run, guard, log, ingest });
  const streams = new Streams({
    root: cfg.cacheDir, maxBytes: cfg.cacheMaxBytes, drivers: { passthrough: passthroughDriver({ guard }), remux: media, transcode: media }, log,
    onSegment: (id, path) => previews.segment(id, path), onStop: (id) => previews.drop(id),
  });
  const routes = [
    ...fetchRoutes({ guard, run, ingest }), ...parseRoutes(), ...streamRoutes(streams, { encoders: listEncoders, previews }),
    ...benchmarkRoutes({ run, encoders: listEncoders, log }), ...fileRoutes(streams), ...ingestRoutes(ingest, { ports: cfg.srtPorts }),
  ];
  const app = createApp({ verifier, version: cfg.version, bootId: randomBytes(8).toString('hex'), system, routes, warn: log });
  const server = createServer((req, res) => { void app(req, res); });
  // the outer bound for receiving a request: the longest route's own (createApp cuts every other request off after REQUEST_TIMEOUT_MS)
  server.requestTimeout = Math.max(REQUEST_TIMEOUT_MS, ...routes.map((r) => r.bodyTimeoutMs ?? 0)) + 5_000;
  server.headersTimeout = 5_000;
  server.on('close', () => ingest.close());
  await new Promise<void>((resolve) => server.listen(cfg.port, o.host ?? '0.0.0.0', resolve));
  const srt = cfg.srtPorts.length === 1 ? `${cfg.srtPorts[0]}` : `${cfg.srtPorts[0]}-${cfg.srtPorts.at(-1)}`;
  log(`listening on :${cfg.port} (api ${API_VERSION}, version ${cfg.version ?? 'dev'}, SRT ports ${srt}, cache ${(cfg.cacheMaxBytes / 1024 ** 3).toFixed(1)} GB)`);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  start().then((server) => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { server.close(); process.exit(0); });
  }, (err: unknown) => {
    // config errors name the variable, never its value
    console.error(`livetv: ${(err as Error).message}`);
    process.exit(1);
  });
}
