// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Request signing between the backend and the updater (docs/security.md "Updater"). The backend keeps a copy of `sign` in
 * backend/src/updater.ts; test-vectors/updater-hmac.json pins both to the same bytes.
 *
 *   key       = HMAC-SHA256(INTERNAL_SECRET, "friendflix-updater/v1")   (domain separation: never the raw shared secret)
 *   canonical = METHOD "\n" PATH "\n" TS "\n" NONCE "\n" hex(SHA256(body))
 *   headers   x-ff-updater-ts (unix ms), x-ff-updater-nonce (32 hex), x-ff-updater-signature ("v1=" + hex HMAC(key, canonical))
 *
 * The updater accepts a request only inside a 60 s window around its own clock, never one signed before it started (a replay
 * cache cannot outlive the process), and every nonce once.
 *
 * The two media server backup streams (`GET /v1/mediaserver/backups/<id>/download`, `POST /v1/mediaserver/backups/upload`) sign the
 * `streamBinding` of the `x-ff-backup-passphrase` header value exactly as sent (base64url of the UTF-8 passphrase; empty when
 * absent) in place of the body: a scrypt derivation, never a fast hash of the passphrase. The request is verified before a byte of
 * the stream is read or written.
 */
export const KEY_LABEL = 'friendflix-updater/v1';
export const HEADER_TS = 'x-ff-updater-ts';
export const HEADER_NONCE = 'x-ff-updater-nonce';
export const HEADER_SIG = 'x-ff-updater-signature';
export const WINDOW_MS = 60_000;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIG_RE = /^v1=[0-9a-f]{64}$/;
const TS_RE = /^[0-9]{13}$/;

const STREAM_SALT = 'friendflix-updater-stream/v1';

const STREAM_SCRYPT = { N: 2 ** 14, r: 8, p: 1 } as const;

/** what the backup streams sign in place of the body: scrypt of the passphrase header as sent (hex); backend/src/updater.ts has the same */
export function streamBinding(passphraseHeader: string): string {
  return scryptSync(passphraseHeader, STREAM_SALT, 32, STREAM_SCRYPT).toString('hex');
}

/** streamBinding off the event loop (the same bytes): what the server derives, only after precheck() passed */
export function streamBindingAsync(passphraseHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(passphraseHeader, STREAM_SALT, 32, STREAM_SCRYPT, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

export function deriveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

export function canonical(method: string, path: string, ts: string, nonce: string, body: string): string {
  return [method.toUpperCase(), path, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
}

export function sign(key: Buffer, method: string, path: string, body = '', ts = String(Date.now()), nonce = randomBytes(16).toString('hex')): Record<string, string> {
  const sig = createHmac('sha256', key).update(canonical(method, path, ts, nonce, body)).digest('hex');
  return { [HEADER_TS]: ts, [HEADER_NONCE]: nonce, [HEADER_SIG]: `v1=${sig}` };
}

export type AuthError = 'missing' | 'malformed' | 'expired' | 'bad_signature' | 'replay';

/** Remembers each nonce until its request can no longer pass the time window; refuses (fails closed) when full. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}
  /** true when the nonce was new (and is now remembered) */
  claim(nonce: string, expiresAt: number, now: number): boolean {
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.max) {
      for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
      if (this.seen.size >= this.max) return false;
    }
    this.seen.set(nonce, expiresAt);
    return true;
  }
  /** whether the nonce was already used (without claiming it) */
  has(nonce: string): boolean { return this.seen.has(nonce); }
  get size(): number { return this.seen.size; }
}

export interface Verifier {
  key: Buffer;
  cache: ReplayCache;
  /** requests signed before this instant (process start) are refused */
  notBefore: number;
  now?: () => number;
}

type Headers = Record<string, string | string[] | undefined>;
type Screened = { ok: true; ts: string; nonce: string; sig: string; t: number; now: number } | { ok: false; error: AuthError };

/** the checks that need no key: headers present and well-formed, inside the time window */
function screen(v: Verifier, headers: Headers): Screened {
  const h = (k: string) => { const x = headers[k]; return Array.isArray(x) ? undefined : x; };
  const ts = h(HEADER_TS), nonce = h(HEADER_NONCE), sig = h(HEADER_SIG);
  if (!ts || !nonce || !sig) return { ok: false, error: 'missing' };
  if (!TS_RE.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig)) return { ok: false, error: 'malformed' };
  const now = (v.now ?? Date.now)();
  const t = Number(ts);
  if (Math.abs(now - t) > WINDOW_MS || t < v.notBefore) return { ok: false, error: 'expired' };
  return { ok: true, ts, nonce, sig, t, now };
}

/**
 * The cheap part of verify() for a request whose signed content is costly to derive (the backup streams): headers, time window
 * and an already used nonce, without claiming it. verify() still runs in full afterwards.
 */
export function precheck(v: Verifier, headers: Headers): { ok: true } | { ok: false; error: AuthError } {
  const s = screen(v, headers);
  if (!s.ok) return s;
  return v.cache.has(s.nonce) ? { ok: false, error: 'replay' } : { ok: true };
}

/** Checks one request; the signature is compared in constant time before the nonce is claimed (an invalid request burns no nonce). */
export function verify(v: Verifier, req: { method: string; path: string; headers: Headers; body: string }): { ok: true } | { ok: false; error: AuthError } {
  const s = screen(v, req.headers);
  if (!s.ok) return s;
  const { ts, nonce, sig, t, now } = s;
  const want = createHmac('sha256', v.key).update(canonical(req.method, req.path, ts, nonce, req.body)).digest();
  const got = Buffer.from(sig.slice(3), 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, error: 'bad_signature' };
  if (!v.cache.claim(nonce, t + WINDOW_MS, now)) return { ok: false, error: 'replay' };
  return { ok: true };
}
