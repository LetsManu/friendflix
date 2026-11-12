// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { log as defaultLog, type Log } from './log.js';
import { ReplayCache, verify, type Verifier } from './protocol.js';
import { createRun } from './run.js';
import { systemView, type SystemView } from './system.js';

/**
 * livetv's internal API (spec §3.2; only on the internal `livetv` network, port 8090). `/healthz` is open; every `/v1/*` request
 * is signed (protocol.ts), JSON only, at most 64 KB; `/s/*` (stream files for the gateway, Task 27) is unsigned and addressed by
 * a random stream key. Later tasks add their routes to the table (`AppDeps.routes`).
 */
export const API_VERSION = 1;
export const MAX_BODY = 64 * 1024;

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface RouteCall {
  req: IncomingMessage;
  res: ServerResponse;
  /** the capture groups of a RegExp path */
  params: string[];
  /** the parsed JSON body (null when there is none) */
  json: unknown;
}
/** a JSON answer; a route that streams (NDJSON, images, segments) writes `res` itself and returns nothing */
export interface Answer { status: number; json?: unknown }
export interface Route {
  method: Method;
  /** exact path, or a pattern anchored with ^...$ (its groups become `params`) */
  path: string | RegExp;
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
 * The body as text; `too_large` when it passes MAX_BODY (the rest is read and dropped, so the 413 still reaches the caller);
 * `broken` when the request stream fails (the caller aborted).
 */
function readBody(req: IncomingMessage): Promise<{ body: string } | { error: 'too_large' | 'broken' }> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { req.resume(); resolve({ error: 'too_large' }); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) { chunks.push(c); return; }
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
        return send(res, 200, { ok: true, api: API_VERSION, version: deps.version, bootId: deps.bootId });
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
      let json: unknown = null;
      if (signed) {
        const read = await readBody(req);
        if ('error' in read) return read.error === 'too_large' ? send(res, 413, { error: 'too_large' }) : send(res, 400, { error: 'bad_request' });
        const body = read.body;
        // the whole request target is signed: a query string cannot be changed or added on the way
        const auth = verify(deps.verifier, { method, path: target, headers: req.headers, body });
        if (!auth.ok) {
          deps.warn?.(`refused ${method} ${logPath(route, path)}: ${auth.error}`);
          return send(res, 401, { error: auth.error });
        }
        if (body !== '') {
          if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json_required' });
          try { json = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_body' }); }
        }
      }
      const answer = await route.handle({ req, res, params, json });
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
  const verifier: Verifier = { key: cfg.key, cache: new ReplayCache(), notBefore: Date.now() };
  const system = systemView({ fs, run: createRun(), cacheDir: cfg.cacheDir, cacheMaxBytes: cfg.cacheMaxBytes, srtPorts: cfg.srtPorts });
  const app = createApp({ verifier, version: cfg.version, bootId: randomBytes(8).toString('hex'), system, warn: log });
  const server = createServer((req, res) => { void app(req, res); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve) => server.listen(cfg.port, o.host ?? '0.0.0.0', resolve));
  const srt = cfg.srtPorts.length === 1 ? `${cfg.srtPorts[0]}` : `${cfg.srtPorts[0]}-${cfg.srtPorts.at(-1)}`;
  // never read: livetv signs with its own key only (config.ts). A value here would be the backend's key within reach of ffmpeg.
  if (env.INTERNAL_SECRET || env.INTERNAL_SECRET_FILE) log('INTERNAL_SECRET is set in the environment of livetv but never used: remove it there');
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
