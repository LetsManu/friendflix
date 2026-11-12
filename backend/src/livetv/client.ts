// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Ctx } from '../ctx.js';

/**
 * Client of the optional livetv container (livetv/, compose profile `livetv`, spec §3.2). Every `/v1/*` request is HMAC-signed
 * with a key derived from INTERNAL_SECRET under its own label (never the updater key): timestamp + nonce, livetv refuses replays
 * and anything outside 60 s. Signing must match livetv/src/protocol.ts byte for byte (test-vectors/livetv-hmac.json). What is
 * signed is the request target exactly as fetch sends it: `new URL(path, LIVETV_URL)` pathname + search (percent-encoded, dot
 * segments resolved), never the raw argument. The backend never imports from livetv/ (separate image).
 *
 * Errors are fixed codes: livetv's `{ error }` only when it looks like a code, never its text (it may come from a provider).
 */
const KEY_LABEL = 'friendflix-livetv/v1';
const CODE_RE = /^[a-z_]{1,40}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const BOOT_ID_RE = /^[0-9a-f]{16}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;

export function livetvKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

export function signLivetv(key: Buffer, method: string, path: string, body = '', ts = String(Date.now()), nonce = randomBytes(16).toString('hex')): Record<string, string> {
  const canonical = [method.toUpperCase(), path, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  return { 'x-ff-livetv-ts': ts, 'x-ff-livetv-nonce': nonce, 'x-ff-livetv-signature': `v1=${createHmac('sha256', key).update(canonical).digest('hex')}` };
}

/** status null = livetv not reached (network, DNS, timeout): code `unreachable` */
export class LivetvError extends Error {
  constructor(readonly status: number | null, readonly code: string) {
    super(`livetv ${status ?? '-'} ${code}`);
    this.name = 'LivetvError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** an abort after `ms` (a plain timer, so the deadline also covers reading the body; `clear` once it is read) */
function deadline(ms: number): { signal: AbortSignal; clear(): void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new DOMException('livetv timeout', 'TimeoutError')), ms);
  t.unref?.();
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

/** one signed request; network errors and timeouts become LivetvError(null, 'unreachable'), a path off livetv `invalid_path` */
async function signedFetch(ctx: Ctx, method: Method, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const base = new URL(ctx.cfg.LIVETV_URL);
  const url = new URL(path, base);
  // a path is a path: `//host/…` or a full URL would leave livetv (and take the signature with it)
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== base.origin) throw new LivetvError(null, 'invalid_path');
  const headers = signLivetv(livetvKey(ctx.cfg.INTERNAL_SECRET), method, url.pathname + url.search, raw);
  if (raw) headers['content-type'] = 'application/json';
  try {
    return await ctx.fetchImpl(url.href, { method, headers, body: raw || undefined, signal, redirect: 'error' });
  } catch {
    throw new LivetvError(null, 'unreachable');
  }
}

/** a refused answer as an error: livetv's code when it is one, else livetv_error */
async function refusal(r: Response): Promise<LivetvError> {
  const j = (await r.json().catch(() => null)) as { error?: unknown } | null;
  const code = typeof j?.error === 'string' && CODE_RE.test(j.error) ? j.error : 'livetv_error';
  return new LivetvError(r.status, code);
}

/** A signed JSON call (default 10 s). An empty answer (204) is undefined; a 2xx that is not JSON is `invalid_answer`. */
export async function livetvCall<T>(ctx: Ctx, method: Method, path: string, body?: unknown, o: { timeoutMs?: number } = {}): Promise<T> {
  const d = deadline(o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const r = await signedFetch(ctx, method, path, body, d.signal);
    if (!r.ok) throw await refusal(r);
    let text: string;
    try { text = await r.text(); } catch { throw new LivetvError(null, 'unreachable'); } // the body stopped (reset, timeout)
    if (text === '') return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new LivetvError(r.status, 'invalid_answer'); }
  } finally {
    d.clear();
  }
}

/**
 * A signed POST whose answer is streamed (NDJSON, image bytes); the timeout keeps running while the caller reads it. Refusals
 * throw like livetvCall.
 */
export async function livetvStream(ctx: Ctx, path: string, body: unknown, o: { timeoutMs: number }): Promise<Response> {
  const d = deadline(o.timeoutMs);
  try {
    const r = await signedFetch(ctx, 'POST', path, body, d.signal);
    if (!r.ok) throw await refusal(r);
    return r;
  } catch (e) {
    d.clear(); // a refusal or a failed request leaves nobody to read the answer: the timer must not outlive the call
    throw e;
  }
}

/** `GET /healthz` (unsigned, 3 s): null when livetv is not there or answers something else (spec §4.1; installed = api 1). */
export async function livetvHealth(ctx: Ctx): Promise<{ api: number; version: string | null; bootId: string } | null> {
  try {
    const r = await ctx.fetchImpl(`${ctx.cfg.LIVETV_URL}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'error' });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown> | null;
    if (!j || j.ok !== true || !Number.isInteger(j.api) || typeof j.bootId !== 'string' || !BOOT_ID_RE.test(j.bootId)) return null;
    return { api: j.api as number, version: typeof j.version === 'string' && VERSION_RE.test(j.version) ? j.version : null, bootId: j.bootId };
  } catch {
    return null;
  }
}
