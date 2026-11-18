// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Docker, StepError, execRunner, type ImageInfo, type ServiceState } from './docker.js';
import type { StackInfo } from './stack.js';
import { Updater, type Ops } from './job.js';
import { BACKUP_DIR, UPLOAD_MAX, decodePassphrase, download, removeStaleParts, upload } from './mediaserver/backup.js';
import { Engine } from './mediaserver/engine.js';
import { readFacts } from './mediaserver/facts.js';
import { runHelper } from './mediaserver/helpers.js';
import { MediaJobs, type JobDeps, type MediaJobOp } from './mediaserver/jobs.js';
import { parseMediaBody } from './mediaserver/parse.js';
import { readPins, type PinRead } from './mediaserver/pins.js';
import { MediaService } from './mediaserver/service.js';
import { STARTING_VIEW, mediaStatusView, type MediaStatusView } from './mediaserver/status.js';
import { Supervisor } from './mediaserver/supervise.js';
import { BACKUP_ID_RE, type MediaOp } from './mediaserver/types.js';
import { FF_SERVICES, HEALTH_SERVICES, LIVETV_SERVICE, SELF_SERVICE, channelTag, expectedImage, imageRepo, isDigest, parseChannelBody, parseLivetvBody, shaTag } from './policy.js';
import { ReplayCache, deriveKey, precheck, streamBindingAsync, verify, type Verifier } from './protocol.js';
import { cachedRegistry, registryDigest, type CachedRegistry } from './registry.js';
import { fileStore } from './state.js';

type Route = 'status' | 'channel' | 'update' | 'rollback' | 'self-update' | 'livetv' | 'mediaserver';
/** the whole API: seven fixed actions (and the two backup streams below) */
export const ROUTES: Record<string, { method: 'GET' | 'POST'; route: Route }> = {
  '/v1/status': { method: 'GET', route: 'status' },
  '/v1/channel': { method: 'POST', route: 'channel' },
  '/v1/update': { method: 'POST', route: 'update' },
  '/v1/rollback': { method: 'POST', route: 'rollback' },
  '/v1/self-update': { method: 'POST', route: 'self-update' },
  '/v1/livetv': { method: 'POST', route: 'livetv' },
  '/v1/mediaserver': { method: 'POST', route: 'mediaserver' },
};
/** body limits: 8 KB for the media route (20 folders), 1 KB for the others */
export const MAX_BODY_FOR: Record<Route, number> = { status: 1024, channel: 1024, update: 1024, rollback: 1024, 'self-update': 1024, livetv: 1024, mediaserver: 8192 };
/** a JSON body must arrive within this time (the server's own request timeout is long for the upload stream) */
const BODY_DEADLINE_MS = 10_000;
/** a backup stream that moves no byte for this long is cut (an upload holds the one-scrypt-at-a-time lock until its header is read) */
const STREAM_IDLE_MS = 60_000;
/** stream signature derivations (scrypt, 16 MB each) in flight at once; one more is answered 409 busy before it is derived */
export const MAX_DERIVING = 2;
const DOWNLOAD_RE = new RegExp(`^/v1/mediaserver/backups/(${BACKUP_ID_RE.source.slice(1, -1)})/download$`);
const UPLOAD_PATH = '/v1/mediaserver/backups/upload';
const PASSPHRASE_HEADER = 'x-ff-backup-passphrase';
/** the ops that only read or narrow: allowed while the managed media server is not available */
const ALWAYS_OPS: ReadonlySet<MediaOp['op']> = new Set(['logs', 'gpu', 'base-clear', 'stop', 'remove']);
const JOB_OPS: ReadonlySet<MediaOp['op']> = new Set(['apply', 'finish-setup', 'start', 'stop', 'restart', 'update', 'hdr-test', 'backup', 'restore', 'remove']);
export type LivetvContainerState = 'running' | 'exited' | null;

/**
 * what a service runs, as /v1/status reports it: `sha` the sha-<7> of its image commit (what older backends read), `commit` that
 * commit (40 hex), `version` the backend's only, `digest` the own-repository digest its image carries, `registry` the digest of
 * the channel's tag in the registry (cached; null when unknown), `changed` whether they differ (null unless both are known)
 */
export interface ServiceView {
  service: string; state: string; health: string; sha: string | null; version: string | null;
  commit: string | null; digest: string | null; registry: string | null; changed: boolean | null;
}
/** what servicesView reads: every own-repository digest the image carries (the registry's may be any of them), never sent */
export type ServiceRead = Omit<ServiceView, 'digest' | 'registry' | 'changed'> & { digests: string[] };
/** the registry digest of a service's image at a tag; null when the lookup failed (registry.ts cachedRegistry) */
export type RegistryLookup = (service: string, tag: string) => Promise<string | null>;
export interface AppDeps {
  updater: Updater;
  verifier: Verifier;
  /** what runs now, per service (cached by the caller) */
  services: () => Promise<ServiceRead[]>;
  /** the registry digest of the channel's tag, cached by the caller; absent in tests = unknown (null) */
  registry?: RegistryLookup;
  self: { version: string | null; sha: string | null };
  /** own / foreign and why (stack.ts; null = could not tell), cached by the caller; absent in tests = null */
  stack?: () => Promise<StackInfo | null>;
  /** the livetv container (running / exited / none), cached by the caller; absent in tests = null */
  livetv?: () => Promise<LivetvContainerState>;
  /** auth refusals etc. (codes only) */
  warn?: (msg: string) => void;
  /** the managed media server (Task 3–8 parts bound to their deps); absent in tests = the media routes are not found */
  media?: MediaApi;
  /** shorter deadlines for tests: a JSON body (10 s), an idle backup stream (60 s), the media status and the registry digests (2 s each) */
  limits?: { bodyMs?: number; streamIdleMs?: number; mediaStatusMs?: number; registryMs?: number };
  /** the backup streams' signed content (protocol.ts streamBindingAsync); replaced in tests */
  streamBinding?: (passphraseHeader: string) => Promise<string>;
}

export interface MediaApi {
  service: Pick<MediaService, 'request' | 'confirm' | 'clear' | 'browse' | 'gpu' | 'logs'>;
  jobs: Pick<MediaJobs, 'start'>;
  status(): Promise<MediaStatusView>;
  download(id: string, passphrase: string, res: ServerResponse): Promise<void>;
  upload(req: IncomingMessage, passphrase: string): ReturnType<typeof upload>;
}

/** a JSON answer; `close` ends the connection after it (a request whose body was not read) */
function send(res: ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent || res.destroyed) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s), ...(close ? { connection: 'close' } : {}) });
  res.end(s);
}

type Body = { ok: true; body: string } | { ok: false; status: 408 | 413; error: 'timeout' | 'too_large' };

/** the whole body up to `max` bytes (more: the request is cut) within the deadline (else 408, connection closed) */
function readBody(req: IncomingMessage, max: number, deadlineMs: number): Promise<Body> {
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    const finish = (b: Body): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      resolve(b);
    };
    const timer = setTimeout(() => finish({ ok: false, status: 408, error: 'timeout' }), deadlineMs);
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > max) { finish({ ok: false, status: 413, error: 'too_large' }); req.destroy(); return; }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, status: 413, error: 'too_large' }));
  });
}

/** how long /v1/status and a media op's availability check wait for the media status (a slow pin verify must not hide the updater) */
const MEDIA_STATUS_MS = 2_000;
const lastMediaView = new WeakMap<MediaApi, MediaStatusView>();

/** the media status within the bound; past it the last view this updater read (STARTING_VIEW before the first), the read goes on */
async function mediaStatus(m: MediaApi, ms = MEDIA_STATUS_MS): Promise<MediaStatusView | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), ms); });
  const fresh = m.status().then((v) => { lastMediaView.set(m, v); return v; }, () => null);
  try {
    const v = await Promise.race([fresh, late]);
    return v === 'late' ? lastMediaView.get(m) ?? STARTING_VIEW : v;
  } finally {
    clearTimeout(timer);
  }
}

/** one media status read at start (start() fires it after the supervisor's startup), so /v1/status has a view before anyone asks; never throws */
export async function warmMediaStatus(m: MediaApi): Promise<void> {
  await m.status().then((v) => { lastMediaView.set(m, v); }, () => undefined);
}

/** how long /v1/status waits for the registry digests (the first lookup after the 10-min cache expired may be slow) */
const REGISTRY_STATUS_MS = 2_000;
const lastRegistry = new WeakMap<RegistryLookup, Map<string, string | null>>();

/**
 * the registry digest of each service's image at `tag`, all within one bound; past it (or on a failure) the last answer for that
 * service and tag (null before the first), while the lookup goes on and fills the cache for the next read
 */
async function registryDigests(lookup: RegistryLookup | undefined, services: readonly string[], tag: string | null, ms = REGISTRY_STATUS_MS): Promise<Record<string, string | null>> {
  if (!lookup || !tag) return {};
  let last = lastRegistry.get(lookup);
  if (!last) { last = new Map(); lastRegistry.set(lookup, last); }
  const seen = last;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), ms); });
  try {
    const out = await Promise.all(services.map(async (svc) => {
      const key = `${svc}:${tag}`;
      const fresh = lookup(svc, tag).then((v) => { const d = isDigest(v) ? v : null; seen.set(key, d); return d; }, () => { seen.set(key, null); return null; });
      const v = await Promise.race([fresh, late]);
      return [svc, v === 'late' ? seen.get(key) ?? null : v] as const;
    }));
    return Object.fromEntries(out);
  } finally {
    clearTimeout(timer);
  }
}

/** a service as /v1/status sends it: the registry digest set against every own digest its image carries */
function serviceView({ digests, ...v }: ServiceRead, registry: string | null): ServiceView {
  const own = Array.isArray(digests) ? digests.filter(isDigest) : [];
  const digest = registry && own.includes(registry) ? registry : own[0] ?? null;
  return { ...v, commit: v.commit ?? null, digest, registry, changed: digest && registry ? digest !== registry : null };
}

export async function status(d: AppDeps) {
  const s = d.updater.snapshot();
  const tag = channelTag(s.channel, s.version);
  // the registry lookups run beside the service read (by name: what servicesView lists), each within the same 2-s bound as the media status
  const names = [...FF_SERVICES, SELF_SERVICE, ...(s.livetv === 'enabled' ? [LIVETV_SERVICE] : [])];
  const [read, registry, stack, livetv, mediaserver] = await Promise.all([d.services().catch(() => []), registryDigests(d.registry, names, tag, d.limits?.registryMs),
    d.stack ? d.stack().catch(() => null) : Promise.resolve(null),
    d.livetv ? d.livetv().catch(() => null) : Promise.resolve(null), d.media ? mediaStatus(d.media, d.limits?.mediaStatusMs) : Promise.resolve(null)]);
  const services = read.map((v) => serviceView(v, registry[v.service] ?? null));
  return {
    updater: d.self,
    channel: s.channel, version: s.version, targetTag: tag,
    // before the first job of this updater: the build the backend runs now (its sha-<7> tag)
    current: s.current ?? services.find((v) => v.service === 'backend')?.sha ?? null, previous: s.previous, busy: d.updater.busy,
    // whether a rollback has something to go back to (the recorded digests, or a legacy sha tag); never the digests themselves
    rollback: { available: Boolean((s.previousDigests && tag) || s.previous) },
    // job.services: per service what the last update or rollback did (updated / unchanged)
    job: s.lastJob, log: d.updater.log.tail(30),
    services,
    // foreign: started by another tool (Portainer) or from another directory; the updater refuses to recreate it, the backend
    // redeploys through Portainer when it is set up. stackDir / projectDir (host paths, no secret) let the page name the fix.
    stack: stack?.stack ?? null, stackReason: stack?.reason ?? null, stackDir: stack?.workingDir ?? null, projectDir: stack?.projectDir ?? null,
    // the optional livetv service: what the updater did (enabled / disabled / absent) and whether its container runs
    // error: why an update or rollback disabled it on its own (pull_failed / verify_failed / restart_failed / unhealthy)
    livetv: { state: s.livetv, container: livetv, error: s.livetvError },
    // the managed media server (status.ts): never a code, a password or a path below the base
    mediaserver,
  };
}

/** a JSON body (content type and syntax); a send()-ready refusal otherwise */
function jsonBody(req: IncomingMessage, body: string): { ok: true; value: unknown } | { ok: false; status: number; error: string } {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return { ok: false, status: 415, error: 'json_required' };
  try { return { ok: true, value: JSON.parse(body) as unknown }; } catch { return { ok: false, status: 400, error: 'invalid_body' }; }
}

/** what a media op answers (codes only, never Docker or server text) */
async function mediaOp(m: MediaApi, op: MediaOp): Promise<{ status: number; body: unknown }> {
  if (JOB_OPS.has(op.op)) {
    const started = m.jobs.start(op as MediaJobOp);
    if (!started.ok) return { status: started.error === 'busy' ? 409 : 400, body: { error: started.error } };
    return { status: 202, body: { job: started.job } };
  }
  switch (op.op) {
    case 'base-request': {
      const r = await m.service.request(op.path);
      return r.ok ? { status: 200, body: { pending: true, expiresAt: r.expiresAt, warning: r.warning } } : { status: r.status, body: { error: r.error } };
    }
    case 'base-confirm': {
      const r = await m.service.confirm(op.code);
      return 'error' in r ? { status: 409, body: { error: r.error } } : { status: 200, body: r };
    }
    case 'base-clear': {
      const r = await m.service.clear();
      return 'error' in r ? { status: 409, body: { error: r.error } } : { status: 200, body: { ok: true } };
    }
    case 'browse': {
      const r = await m.service.browse(op.rel);
      if ('error' in r) return { status: r.error === 'invalid_body' ? 400 : 409, body: { error: r.error } };
      return { status: 200, body: { entries: r.entries, truncated: r.truncated } };
    }
    case 'gpu': {
      const r = await m.service.gpu();
      return { status: 200, body: { dri: r.dri, nvidia: r.nvidia } };
    }
    case 'logs': {
      const r = await m.service.logs(op.tail);
      return 'error' in r ? { status: 409, body: { error: r.error } } : { status: 200, body: { lines: r.lines } };
    }
    default:
      return { status: 400, body: { error: 'invalid_body' } };
  }
}

/**
 * The two backup streams (spec "Backup and restore"): the signature covers a scrypt derivation of the `x-ff-backup-passphrase`
 * header as sent (base64url; protocol.ts streamBinding) in place of the body, so it is checked before a byte of the stream is read
 * or written. The derivation (async, at most MAX_DERIVING at once) runs only after the checks that cost nothing passed. Answers
 * carry codes only.
 */
async function stream(d: AppDeps, gate: { deriving: number }, req: IncomingMessage, res: ServerResponse, path: string, id: string | null): Promise<void> {
  const want = id === null ? 'POST' : 'GET';
  // the upload's body is never read on a refusal: the connection is closed after the answer
  const refuse = (status: number, error: string): void => send(res, status, { error }, id === null);
  const unauthorized = (error: string): void => {
    d.warn?.(`refused mediaserver-backup: ${error}`);
    refuse(401, error);
  };
  if (req.method !== want) return refuse(405, 'method_not_allowed');
  // every cheap check before the scrypt derivation: signature headers, time window, a used nonce, the passphrase rule
  const pre = precheck(d.verifier, req.headers);
  if (!pre.ok) return unauthorized(pre.error);
  const raw = req.headers[PASSPHRASE_HEADER];
  const header = typeof raw === 'string' ? raw : '';
  const passphrase = decodePassphrase(header);
  if (passphrase === null) return refuse(400, 'invalid_passphrase');
  // a bounded number of derivations at a time: a flood is answered, never queued
  if (gate.deriving >= MAX_DERIVING) return refuse(409, 'busy');
  gate.deriving++;
  let binding: string;
  try { binding = await (d.streamBinding ?? streamBindingAsync)(header); } finally { gate.deriving--; }
  const auth = verify(d.verifier, { method: want, path, headers: req.headers, body: binding });
  if (!auth.ok) return unauthorized(auth.error);
  const m = d.media;
  if (!m) return refuse(404, 'not_found');
  if (id === null) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > UPLOAD_MAX) return refuse(413, 'too_large');
  }
  // a stalled client is cut (the socket is destroyed when it moves no byte for STREAM_IDLE_MS)
  req.socket.setTimeout(d.limits?.streamIdleMs ?? STREAM_IDLE_MS);
  try {
    if (id !== null) return await m.download(id, passphrase, res);
    const r = await m.upload(req, passphrase);
    // an upload over the limit was cut inside upload(): there is no connection left to answer on
    if (req.socket.destroyed) return;
    if (r.ok) return send(res, 200, { backup: r.backup });
    return refuse(r.status, r.error);
  } finally {
    if (!req.socket.destroyed) req.socket.setTimeout(0);
  }
}

export function handler(d: AppDeps) {
  const gate = { deriving: 0 };
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0]!;
    if (path === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
    if (path === UPLOAD_PATH) return stream(d, gate, req, res, path, null);
    const dl = DOWNLOAD_RE.exec(path);
    if (dl) return stream(d, gate, req, res, path, dl[1]!);
    const r = ROUTES[path];
    if (!r) return send(res, 404, { error: 'not_found' });
    if (req.method !== r.method) return send(res, 405, { error: 'method_not_allowed' });
    const read = await readBody(req, MAX_BODY_FOR[r.route], d.limits?.bodyMs ?? BODY_DEADLINE_MS);
    if (!read.ok) return send(res, read.status, { error: read.error }, true);
    const body = read.body;
    const auth = verify(d.verifier, { method: req.method, path, headers: req.headers, body });
    if (!auth.ok) {
      d.warn?.(`refused ${r.route}: ${auth.error}`);
      return send(res, 401, { error: auth.error });
    }
    if (r.route === 'status') return send(res, 200, await status(d));
    if (r.route === 'mediaserver') {
      const m = d.media;
      if (!m) return send(res, 404, { error: 'not_found' });
      const parsed = jsonBody(req, body);
      if (!parsed.ok) return send(res, parsed.status, { error: parsed.error });
      // exactly one op with exactly its keys: no image, path outside the base, device, port or variable can be named
      const op = parseMediaBody(parsed.value);
      if (!op) return send(res, 400, { error: 'invalid_body' });
      if (!ALWAYS_OPS.has(op.op)) {
        const view = await mediaStatus(m, d.limits?.mediaStatusMs);
        if (!view?.available) return send(res, 409, { error: view?.reason ?? 'not_available' });
      }
      const a = await mediaOp(m, op);
      return send(res, a.status, a.body);
    }
    if (r.route === 'livetv') {
      const parsed = jsonBody(req, body);
      if (!parsed.ok) return send(res, parsed.status, { error: parsed.error });
      // exactly {op: 'enable'}, {op: 'disable'} or {op: 'remove', data: boolean}: no image, service, tag or volume can be named
      const op = parseLivetvBody(parsed.value);
      if (!op) return send(res, 400, { error: 'invalid_body' });
      const started = d.updater.startLivetv(op);
      if (!started.ok) return send(res, started.error === 'busy' ? 409 : 400, { error: started.error });
      return send(res, 202, { job: started.job });
    }
    if (r.route === 'channel') {
      const parsed = jsonBody(req, body);
      if (!parsed.ok) return send(res, parsed.status, { error: parsed.error });
      const c = parseChannelBody(parsed.value);
      if (!c) return send(res, 400, { error: 'invalid_body' });
      if (d.updater.busy) return send(res, 409, { error: 'busy' });
      const s = d.updater.setChannel(c.channel, c.version);
      return send(res, 200, { channel: s.channel, version: s.version, targetTag: channelTag(s.channel, s.version) });
    }
    // the job actions take no parameters at all
    if (body !== '' && body.trim() !== '{}') return send(res, 400, { error: 'invalid_body' });
    const started = d.updater.start(r.route);
    if (!started.ok) return send(res, started.error === 'busy' ? 409 : 400, { error: started.error });
    return send(res, 202, { job: started.job });
  };
}

export function healthProbe(docker: Pick<Docker, 'ps'>, url: string, fetchImpl: typeof fetch = fetch): Ops['healthy'] {
  return async (commit7) => {
    const ps = await docker.ps();
    for (const svc of HEALTH_SERVICES) {
      const st = ps.find((p) => p.service === svc);
      if (!st || st.state !== 'running' || (st.health !== '' && st.health !== 'healthy')) return false;
    }
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
    if (!r.ok) return false;
    const b = (await r.json().catch(() => null)) as { version?: unknown } | null;
    return commit7 === null || b?.version === commit7;
  };
}

/** the digests of `repoDigests` that belong to this repository's image of `service` (a foreign repository's never count) */
function ownDigests(repo: string, service: string, repoDigests: readonly string[]): string[] {
  const own = imageRepo(expectedImage(repo, service, 'latest'));
  return repoDigests.flatMap((d) => {
    const at = d.lastIndexOf('@');
    const digest = d.slice(at + 1);
    return at > 0 && d.slice(0, at) === own && isDigest(digest) ? [digest] : [];
  });
}

/**
 * what each FriendFlix service runs (the updater's own, and livetv while it is enabled); cached a few seconds (every status poll
 * would otherwise cost several Docker calls). On a stack whose compose files the updater cannot read (Portainer) from the
 * containers' labels, so the page can follow a redeploy.
 */
export function servicesView(docker: Pick<Docker, 'psView' | 'containerImage' | 'imageInfo'>, repo: string, livetv: () => boolean, ttlMs = 10_000, now: () => number = Date.now): () => Promise<ServiceRead[]> {
  let cache: { at: number; livetv: boolean; v: ServiceRead[] } | null = null;
  return async () => {
    const withLivetv = livetv();
    if (cache && cache.livetv === withLivetv && now() - cache.at < ttlMs) return cache.v;
    const ps: ServiceState[] = await docker.psView();
    const v = await Promise.all([...FF_SERVICES, SELF_SERVICE, ...(withLivetv ? [LIVETV_SERVICE] : [])].map(async (service) => {
      const st = ps.find((p) => p.service === service);
      const id = st ? await docker.containerImage(st.name) : null;
      const info: ImageInfo | null = id ? await docker.imageInfo(id) : null;
      return {
        service, state: st?.state ?? 'missing', health: st?.health ?? '', sha: shaTag(info?.commit),
        version: service === 'backend' ? info?.version ?? null : null, commit: info?.commit ?? null, digests: ownDigests(repo, service, info?.repoDigests ?? []),
      };
    }));
    cache = { at: now(), livetv: withLivetv, v };
    return v;
  };
}

/** whether the livetv container runs (any other state: exited; none: null), cached like the service view; null when Docker does not answer */
export function livetvView(docker: Pick<Docker, 'livetvContainer'>, ttlMs = 10_000, now: () => number = Date.now): () => Promise<LivetvContainerState> {
  let cache: { at: number; v: LivetvContainerState } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.v;
    const c = await docker.livetvContainer().catch(() => null);
    const v: LivetvContainerState = c ? (c.state === 'running' ? 'running' : 'exited') : null;
    cache = { at: now(), v };
    return v;
  };
}

/**
 * the job's view of Docker: the fixed command lines of docker.ts, the registry (uncached) and the health probe; `fetchImpl` serves
 * both. Every registry digest the job resolves also goes into the status page's cache (`statusRegistry`; a failure drops its
 * entry): after an update the status compares with what the job installed, never with an older cached digest.
 */
export function dockerOps(docker: Docker, healthUrl: string, fetchImpl: typeof fetch = fetch, statusRegistry?: CachedRegistry): Ops {
  return {
    images: (t, s) => docker.images(t, s),
    registryDigest: async (s, t) => {
      try {
        const d = await registryDigest(docker.repo, s, t, fetchImpl);
        statusRegistry?.set(s, t, d);
        return d;
      } catch (e) {
        statusRegistry?.drop(s, t);
        throw e;
      }
    },
    pullDigest: (r) => docker.pullDigest(r), tag: (r, i) => docker.tag(r, i), verify: (r) => docker.verify(r), up: (t, s) => docker.up(t, s),
    imageInfo: (r) => docker.imageInfo(r), running: (s) => docker.running(s), spawnSelfUpdate: (t) => docker.spawnSelfUpdate(t),
    healthy: healthProbe(docker, healthUrl, fetchImpl), composeFiles: () => docker.files,
    ownStack: async () => { await docker.refreshFiles(); },
    stop: (s) => docker.stop(s), rm: (s) => docker.rm(s), livetvContainer: () => docker.livetvContainer(), livetvNetwork: (t) => docker.livetvNetwork(t),
    imageRm: (ids) => docker.removeLivetvImages(ids),
    volumeRm: async () => {
      const name = await docker.cacheVolume();
      if (!name) throw new StepError('remove_failed', 'livetv no_project');
      await docker.volumeRm(name);
    },
  };
}

/** own / foreign and why, cached like the service view (each probe costs a compose ps and an inspect) */
export function stackView(docker: Pick<Docker, 'stackInfo'>, ttlMs = 10_000, now: () => number = Date.now): () => Promise<StackInfo | null> {
  let cache: { at: number; v: StackInfo | null } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.v;
    const v = await docker.stackInfo().catch(() => null);
    cache = { at: now(), v };
    return v;
  };
}

export function start(env: NodeJS.ProcessEnv = process.env): Server {
  const cfg = loadConfig(env);
  // the livetv profile follows the updater's state (set below; read on every compose command)
  let livetvEnabled = (): boolean => false;
  const docker = new Docker({ projectDir: cfg.projectDir, files: cfg.composeFiles, autoFiles: cfg.composeFilesAuto, projectName: cfg.projectName, repo: cfg.repo, dockerHost: cfg.dockerHost,
    livetv: () => livetvEnabled(), self: cfg.self }, execRunner);
  // the media jobs need the updater and the update job needs their phase: bound once both exist
  let jobs: MediaJobs | null = null;
  // the registry digests for the status page: 10 min per image and tag (a failure 1 min); the job always asks anew and primes it
  const registry = cachedRegistry(cfg.repo);
  const updater = new Updater(dockerOps(docker, cfg.backendHealthUrl, fetch, registry), fileStore(cfg.stateDir), { mediaPhase: (job) => (jobs ? jobs.phase(job) : Promise.resolve(null)) });
  // plain archives an interrupted media server backup or upload left behind (they hold password hashes and keys)
  void removeStaleParts(BACKUP_DIR);
  livetvEnabled = () => updater.livetv === 'enabled';
  const verifier: Verifier = { key: deriveKey(cfg.secret), cache: new ReplayCache(), notBefore: Date.now() };
  const services = servicesView(docker, cfg.repo, () => updater.livetv === 'enabled');
  const log = (msg: string) => console.log(`${new Date().toISOString()} updater: ${msg}`);
  const media = mediaParts(cfg, docker, updater);
  jobs = media.jobs;
  const app = handler({ updater, verifier, services, registry, stack: stackView(docker), livetv: livetvView(docker), self: { version: cfg.version, sha: cfg.gitSha }, warn: log, media: media.api });
  const server = createServer((req, res) => { void app(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal' }); }); });
  // the upload stream may take long (20 GiB); JSON bodies have their own 10-s deadline (readBody), streams an idle limit
  server.requestTimeout = 3 * 3600_000;
  server.headersTimeout = 5_000;
  server.listen(cfg.port, '0.0.0.0', () => log(`listening on :${cfg.port} (project ${cfg.projectDir}, files ${cfg.composeFilesAuto ? `as started (fallback ${cfg.composeFiles.join(',')})` : cfg.composeFiles.join(',')}, repo ${cfg.repo})`));
  // supervision (supervise.ts): once at start, then every 60 s while no job runs
  // then the media status, read once: until it ends /v1/status answers STARTING_VIEW
  void media.supervisor.startup().catch(() => undefined).then(() => warmMediaStatus(media.api));
  const tick = setInterval(() => { if (!updater.busy) void media.supervisor.tick().catch(() => undefined); }, 60_000);
  tick.unref();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { clearInterval(tick); server.close(); process.exit(0); });
  return server;
}

/** the managed media server's parts, bound to the engine (through the socket proxy), the updater and the backup volume */
function mediaParts(cfg: ReturnType<typeof loadConfig>, docker: Docker, updater: Updater): { jobs: MediaJobs; supervisor: Supervisor; api: MediaApi } {
  const engine = new Engine(cfg.dockerHost);
  const facts = () => readFacts(engine, cfg.self);
  const verifyImage = (ref: string) => docker.verifyPulled(ref);
  const deps: JobDeps = {
    engine, updater, facts, helper: runHelper, repo: cfg.repo, now: Date.now, verify: verifyImage,
    // the base code goes to stdout only (one line), never to the job log
    print: (line) => console.log(line),
    pins: async (): Promise<PinRead> => {
      const project = (await facts()).project;
      return project ? readPins({ engine, project, verify: verifyImage, repo: cfg.repo }) : { error: 'no_backend' };
    },
  };
  const jobs = new MediaJobs(deps);
  const service = new MediaService(deps, jobs);
  const supervisor = new Supervisor({ ...deps, jobs });
  const status = mediaStatusView({ updater, engine, jobs, facts, pins: deps.pins, templateState: () => supervisor.templateState() });
  const backups = { dir: BACKUP_DIR, updater, now: Date.now };
  return {
    jobs, supervisor,
    api: { service, jobs, status, download: (id, passphrase, res) => download(backups, id, passphrase, res), upload: (req, passphrase) => upload(backups, req, passphrase) },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) start();
