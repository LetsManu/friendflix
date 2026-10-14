// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '../config.js';
import type { Ctx } from '../ctx.js';
import { akBase } from '../invites.js';
import { mediaProbeRequest, mediaSettings } from '../media/index.js';
import { SeerrClient, SeerrError } from '../seerr/client.js';
import { testSourceKey } from '../sources/omdb.js';
import type { ProbeId } from './registry.js';

/**
 * Live checks of a candidate configuration (Admin -> Settings "Test" and every save, spec Part I). A probe calls the service with the
 * candidate values and answers a code only: an upstream body or error text (which may quote a URL with a token) never leaves this module.
 * Probes that send a credential never follow a redirect (`redirect: 'manual'`), so a key is only ever sent to the host the admin entered.
 */
export type ProbeCode = 'ok' | 'unreachable' | 'timeout' | 'unauthorized' | 'invalid' | 'not_admin' | 'issuer_mismatch' | 'wizard_pending' | 'warning';
/** `detail` is an i18n code, never an upstream body */
export interface ProbeResult { ok: boolean; code: ProbeCode; detail?: string }

export const PROBE_TIMEOUT_MS = 5_000;
const MEDIA_KEYS = mediaSettings().map((d) => d.key);
const OK: ProbeResult = { ok: true, code: 'ok' };
const fail = (code: ProbeCode, detail?: string): ProbeResult => ({ ok: false, code, ...(detail ? { detail } : {}) });

/** Hard failures block a save even with force; unreachable / timeout block unless the admin chose "Save anyway". */
const HARD: ReadonlySet<ProbeCode> = new Set(['unauthorized', 'invalid', 'not_admin', 'issuer_mismatch', 'wizard_pending']);
export function probeBlocks(r: ProbeResult, force: boolean): boolean {
  if (r.ok) return false;
  return HARD.has(r.code) || !force;
}

/** Whether the candidate holds anything for the probe to test; an unconfigured optional service is not probed on save. */
export function probeConfigured(id: ProbeId, cfg: Config): boolean {
  const c = cfg as Record<string, unknown>;
  const any = (...keys: string[]) => keys.some((k) => Boolean(c[k]));
  switch (id) {
    case 'publicUrl': return any('PUBLIC_URL');
    case 'media': return any(...MEDIA_KEYS);
    case 'oidc': return any('OIDC_ISSUER');
    case 'authentik': return any('AUTHENTIK_URL', 'AUTHENTIK_API_TOKEN');
    case 'requests': return any('REQUESTS_URL', 'REQUESTS_API_KEY');
    case 'tmdb': return any('TMDB_API_KEY');
    case 'omdb': return any('OMDB_API_KEY');
    case 'portainer': return any('PORTAINER_WEBHOOK_URL', 'PORTAINER_URL', 'PORTAINER_API_KEY');
    case 'github': return any('GITHUB_TOKEN');
  }
}

const isTimeout = (e: unknown) => {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};

/** An http(s) URL, or undefined (the caller answers invalid_url). */
function httpUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/** base + path without a double slash; the base may carry a path (a reverse-proxy prefix) */
const join = (base: URL, path: string) => new URL(base.pathname.replace(/\/+$/, '') + path, base.origin);

interface Runner {
  /** a fetch that never follows redirects and is aborted at the probe's deadline */
  fetch: typeof fetch;
  /** runs fn within the deadline: a timeout or a thrown error becomes a code */
  within(fn: () => Promise<ProbeResult>): Promise<ProbeResult>;
}

function runner(fetchImpl: typeof fetch, timeoutMs: number): Runner {
  const ac = new AbortController();
  const f = ((input: RequestInfo | URL, init: RequestInit = {}) =>
    fetchImpl(input, { ...init, redirect: 'manual', signal: ac.signal })) as typeof fetch;
  return {
    fetch: f,
    async within(fn) {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<ProbeResult>((res) => {
        timer = setTimeout(() => { ac.abort(); res(fail('timeout')); }, timeoutMs);
      });
      const run = fn().catch((e: unknown) => fail(isTimeout(e) ? 'timeout' : 'unreachable'));
      try {
        return await Promise.race([run, limit]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Maps an HTTP status; 401/403 to `denied`. */
function byCode(status: number, denied: ProbeCode = 'unauthorized'): ProbeResult {
  if (status >= 200 && status < 300) return OK;
  if (status >= 300 && status < 400) return fail('invalid', 'redirect');
  if (status === 401 || status === 403) return fail(denied);
  if (status === 404) return fail('invalid', 'not_found');
  return fail('unreachable', 'upstream_error');
}

/** byCode for an answer whose body is not needed (it is cancelled, never read). */
function byStatus(r: Response, denied?: ProbeCode): ProbeResult {
  void r.body?.cancel().catch(() => undefined);
  return byCode(r.status, denied);
}

async function media(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  // the media module knows the request (Task 12: MEDIA_SETUP[kind].probe); an admin-level key gets 2xx
  const req = mediaProbeRequest(cfg);
  if (!req) return fail('invalid', 'incomplete');
  const base = httpUrl(req.base);
  if (!base) return fail('invalid', 'invalid_url');
  return byStatus(await f(join(base, req.path), { headers: req.headers }), 'not_admin');
}

async function oidc(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const issuer = cfg.OIDC_ISSUER;
  if (!cfg.OIDC_CLIENT_ID || !cfg.OIDC_CLIENT_SECRET) return fail('invalid', 'incomplete');
  const u = httpUrl(issuer);
  if (!u) return fail('invalid', 'invalid_url');
  if (u.protocol === 'http:' && cfg.OIDC_ALLOW_INSECURE !== 'true') return fail('invalid', 'insecure_issuer');
  // discovery carries no credential (the client secret is only sent to the token endpoint at sign-in)
  const r = await f(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
  if (!r.ok) return byStatus(r);
  let doc: { issuer?: unknown };
  try {
    doc = (await r.json()) as { issuer?: unknown };
  } catch {
    return fail('invalid', 'bad_response');
  }
  return doc?.issuer === issuer ? OK : fail('issuer_mismatch');
}

/** With the candidate token (never authentik.ts's call(), which uses the saved AUTHENTIK_API_TOKEN). */
async function authentik(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const { AUTHENTIK_URL: url, AUTHENTIK_API_TOKEN: token, AUTHENTIK_ENROLL_FLOW: flow } = cfg;
  if (!url || !token) return fail('invalid', 'incomplete');
  if (!httpUrl(url)) return fail('invalid', 'invalid_url');
  const base = akBase(url);
  const headers = { Authorization: `Bearer ${token}`, accept: 'application/json' };
  const me = byStatus(await f(`${base}/api/v3/core/users/me/`, { headers }));
  if (!me.ok || !flow) return me;
  const r = byStatus(await f(`${base}/api/v3/flows/instances/${encodeURIComponent(flow)}/`, { headers }));
  return r.detail === 'not_found' ? fail('invalid', 'enroll_flow_missing') : r;
}

/** The request service's request-count call (the admin overview's status call) with the candidate URL and key. */
async function requests(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  if (!cfg.REQUESTS_URL || !cfg.REQUESTS_API_KEY) return fail('invalid', 'incomplete');
  if (!httpUrl(cfg.REQUESTS_URL)) return fail('invalid', 'invalid_url');
  try {
    await new SeerrClient(cfg.REQUESTS_URL, cfg.REQUESTS_API_KEY, f).requestCount();
    return OK;
  } catch (e) {
    if (e instanceof SeerrError) return byCode(e.status);
    if (e instanceof SyntaxError) return fail('invalid', 'bad_response');
    throw e;
  }
}

async function source(ctx: Ctx, f: typeof fetch, name: 'tmdb' | 'omdb', key: string | undefined): Promise<ProbeResult> {
  if (!key) return fail('invalid', 'not_set');
  // the source test functions with the guarded fetch (they read ctx.fetchImpl; kv for the OMDb budget)
  const r = await testSourceKey(Object.assign(Object.create(ctx) as Ctx, { fetchImpl: f }), name, key);
  if (r.ok) return OK;
  if (r.error === 'invalid_key') return fail('unauthorized');
  if (r.error === 'budget') return { ok: true, code: 'warning', detail: 'budget' }; // cannot test today; not a reason to refuse the key
  return fail('unreachable');
}

async function portainer(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  const { PORTAINER_WEBHOOK_URL: hook, PORTAINER_URL: url, PORTAINER_API_KEY: key, PORTAINER_STACK_ID: stack } = cfg;
  if (url || key) {
    if (!url || !key || !stack) return fail('invalid', 'incomplete');
    const base = httpUrl(url);
    if (!base) return fail('invalid', 'invalid_url');
    return byStatus(await f(join(base, `/api/stacks/${encodeURIComponent(stack)}`), { headers: { 'x-api-key': key } }));
  }
  // the webhook would start an update: only its form is checked
  return hook && httpUrl(hook) ? OK : fail('invalid', 'invalid_url');
}

async function github(f: typeof fetch, cfg: Config): Promise<ProbeResult> {
  if (!cfg.GITHUB_TOKEN) return fail('invalid', 'not_set');
  const r = await f(`https://api.github.com/repos/${cfg.UPDATE_REPO}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'friendflix', authorization: `Bearer ${cfg.GITHUB_TOKEN}` },
  });
  // 403/429 without a 401 is GitHub's rate limit, not a verdict on the token
  if (r.status === 403 || r.status === 429) {
    void r.body?.cancel().catch(() => undefined);
    return fail('unreachable', 'rate_limited');
  }
  return byStatus(r);
}

/** Runs one probe against `cfg` (the candidate: the current config merged with the submitted values). Never throws. */
export async function runProbe(ctx: Ctx, id: ProbeId, cfg: Config, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ProbeResult> {
  if (id === 'publicUrl') return OK; // Task 11: the echo through the public URL (a warning at most, never a blocker)
  if (!probeConfigured(id, cfg)) return fail('invalid', 'not_set');
  const r = runner(opts.fetchImpl ?? ctx.fetchImpl, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  return r.within(async () => {
    switch (id) {
      case 'media': return media(r.fetch, cfg);
      case 'oidc': return oidc(r.fetch, cfg);
      case 'authentik': return authentik(r.fetch, cfg);
      case 'requests': return requests(r.fetch, cfg);
      case 'tmdb': return source(ctx, r.fetch, 'tmdb', cfg.TMDB_API_KEY);
      case 'omdb': return source(ctx, r.fetch, 'omdb', cfg.OMDB_API_KEY);
      case 'portainer': return portainer(r.fetch, cfg);
      case 'github': return github(r.fetch, cfg);
    }
  });
}
