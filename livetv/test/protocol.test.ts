// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/protocol.js';
import { HEADER_NONCE, HEADER_SIG, HEADER_TS, KEY_LABEL, ReplayCache, WINDOW_MS, sign, verify, type Verifier } from '../src/protocol.js';

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/livetv-hmac.json', import.meta.url), 'utf8')) as {
  secret: string; key: string; cases: Array<{ method: string; path: string; body: string; ts: string; nonce: string; signature: string }>;
};
const NOW = 1_762_900_000_000;
/** what the bootstrap service writes into livetv's key file (backend/src/bootstrap.ts); livetv itself derives nothing */
const deriveKey = (secret: string) => createHmac('sha256', secret).update('friendflix-livetv/v1').digest();
const key = deriveKey('a-long-internal-secret-value');
const mk = (o: Partial<Verifier> = {}): Verifier => ({ key, cache: new ReplayCache(), notBefore: NOW - 3_600_000, now: () => NOW, ...o });
const req = (headers: Record<string, string>, body = '', method = 'GET', path = '/v1/system') => ({ method, path, headers, body });

describe('livetv request signing', () => {
  it('uses its own key label and headers (never the updater ones)', () => {
    expect(KEY_LABEL).toBe('friendflix-livetv/v1');
    expect([HEADER_TS, HEADER_NONCE, HEADER_SIG]).toEqual(['x-ff-livetv-ts', 'x-ff-livetv-nonce', 'x-ff-livetv-signature']);
    expect(WINDOW_MS).toBe(60_000);
  });

  it('every shared vector signs to its signature and verifies with the key alone (backend/test/livetv-client.test.ts uses the same file)', () => {
    expect(vectors.cases.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/system', 'POST /v1/streams', 'PUT /v1/ingest']);
    // livetv holds `key` (its key file), the backend derives it from `secret`
    const k = Buffer.from(vectors.key, 'hex');
    expect(deriveKey(vectors.secret).toString('hex')).toBe(vectors.key);
    for (const c of vectors.cases) {
      const h = sign(k, c.method, c.path, c.body, c.ts, c.nonce);
      expect(h).toEqual({ [HEADER_TS]: c.ts, [HEADER_NONCE]: c.nonce, [HEADER_SIG]: c.signature });
      expect(verify(mk({ key: k, now: () => Number(c.ts), notBefore: 0 }), req(h, c.body, c.method, c.path))).toEqual({ ok: true });
    }
  });

  it('livetv has no way to derive a key: it never handles INTERNAL_SECRET (1b review I1)', () => {
    expect(Object.keys(protocol)).not.toContain('deriveKey');
  });

  it('a request signed with the raw secret instead of the derived key does not pass', () => {
    const c = vectors.cases[0]!;
    const v = () => mk({ key: Buffer.from(vectors.key, 'hex'), now: () => Number(c.ts), notBefore: 0 });
    // the secret as the HMAC key (no derivation), and the secret's bytes taken as a key
    for (const raw of [Buffer.from(vectors.secret, 'utf8'), Buffer.from(vectors.secret.padEnd(64, '0').slice(0, 64), 'utf8')]) {
      expect(verify(v(), req(sign(raw, c.method, c.path, c.body, c.ts, c.nonce)))).toEqual({ ok: false, error: 'bad_signature' });
    }
    // a livetv that was handed the raw secret as its key refuses what the backend signs (with the derived key)
    const backendSigned = sign(deriveKey(vectors.secret), c.method, c.path, c.body, c.ts, c.nonce);
    expect(verify(mk({ key: Buffer.from(vectors.secret, 'utf8'), now: () => Number(c.ts), notBefore: 0 }), req(backendSigned))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v(), req(backendSigned))).toEqual({ ok: true });
  });

  it('a request signed with the updater label does not pass', () => {
    const c = vectors.cases[0]!;
    const updaterKey = createHmac('sha256', vectors.secret).update('friendflix-updater/v1').digest();
    const h = sign(updaterKey, c.method, c.path, c.body, c.ts, c.nonce);
    expect(verify(mk({ key: deriveKey(vectors.secret), now: () => Number(c.ts), notBefore: 0 }), req(h))).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('accepts a fresh request once; the same nonce again is a replay', () => {
    const v = mk();
    const h = sign(key, 'GET', '/v1/system', '', String(NOW));
    expect(verify(v, req(h))).toEqual({ ok: true });
    expect(verify(v, req(h))).toEqual({ ok: false, error: 'replay' });
  });

  it('refuses a 61 s old request, a future one and one signed before the start', () => {
    const v = mk({ notBefore: NOW - 1000 });
    expect(verify(mk(), req(sign(key, 'GET', '/v1/system', '', String(NOW - 61_000))))).toEqual({ ok: false, error: 'expired' });
    expect(verify(v, req(sign(key, 'GET', '/v1/system', '', String(NOW + WINDOW_MS + 1))))).toEqual({ ok: false, error: 'expired' });
    // signed before this process started: a captured request cannot be replayed after a restart (empty replay cache)
    expect(verify(v, req(sign(key, 'GET', '/v1/system', '', String(NOW - 2000))))).toEqual({ ok: false, error: 'expired' });
    expect(verify(v, req(sign(key, 'GET', '/v1/system', '', String(NOW - 500))))).toEqual({ ok: true });
  });

  it('refuses a wrong signature, another path, method, body or key; a refused request burns no nonce', () => {
    const v = mk();
    const h = sign(key, 'POST', '/v1/streams', '{"a":1}', String(NOW));
    expect(verify(v, req(h, '{"a":1}', 'POST', '/v1/ingest'))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v, req(h, '{"a":1}', 'PUT', '/v1/streams'))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v, req(h, '{"a":2}', 'POST', '/v1/streams'))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v, req(sign(deriveKey('another-secret-value-xyz'), 'POST', '/v1/streams', '{"a":1}', String(NOW)), '{"a":1}', 'POST', '/v1/streams'))).toEqual({ ok: false, error: 'bad_signature' });
    const flipped = { ...h, [HEADER_SIG]: h[HEADER_SIG]!.replace(/.$/, (c) => (c === '0' ? '1' : '0')) };
    expect(verify(v, req(flipped, '{"a":1}', 'POST', '/v1/streams'))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v, req(h, '{"a":1}', 'POST', '/v1/streams'))).toEqual({ ok: true });
  });

  it('refuses missing and malformed headers', () => {
    const v = mk();
    const h = sign(key, 'GET', '/v1/system', '', String(NOW));
    expect(verify(v, req({}))).toEqual({ ok: false, error: 'missing' });
    expect(verify(v, req({ ...h, [HEADER_TS]: '' }))).toEqual({ ok: false, error: 'missing' });
    expect(verify(v, req({ ...h, [HEADER_TS]: '17629e0000000' }))).toEqual({ ok: false, error: 'malformed' });
    expect(verify(v, req({ ...h, [HEADER_NONCE]: 'short' }))).toEqual({ ok: false, error: 'malformed' });
    expect(verify(v, req({ ...h, [HEADER_SIG]: h[HEADER_SIG]!.slice(3) }))).toEqual({ ok: false, error: 'malformed' });
    expect(verify(v, { method: 'GET', path: '/v1/system', body: '', headers: { ...h, [HEADER_SIG]: [h[HEADER_SIG]!, h[HEADER_SIG]!] } })).toEqual({ ok: false, error: 'missing' });
  });

  it('the replay cache fails closed when full and forgets expired nonces', () => {
    const c = new ReplayCache(2);
    expect(c.claim('a', NOW + 10, NOW)).toBe(true);
    expect(c.claim('b', NOW + 10, NOW)).toBe(true);
    expect(c.claim('c', NOW + 10, NOW)).toBe(false);
    expect(c.claim('c', NOW + 10, NOW + 11)).toBe(true);
    expect(c.size).toBe(1);
  });
});
