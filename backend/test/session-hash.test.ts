// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sessions at rest: Redis now writes its append-only file to disk, so a session lives under the SHA-256 of its id
 * (`sess:<64 hex>`), never under the cookie value. A session of an older build (`sess:<raw id>`) is moved to the hashed key with
 * its remaining ttl on first use, so an update signs nobody out; every revoke removes a legacy key too.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryKV } from '../src/kv.js';
import { hashOfSessionKey, sessionHash, sessionKey } from '../src/session.js';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const call = (s: Sess, method: string, url: string, csrf = s.csrf) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': csrf } });
/** the remaining ttl of a key in the in-memory store (ms) */
const ttlMs = (kv: MemoryKV, key: string) => (kv as unknown as { m: Map<string, { exp: number }> }).m.get(key)!.exp - Date.now();
/** turns a signed-in session back into one an older build stored (raw id as the key), with this ttl */
async function makeLegacy(s: Sess, ttl: number): Promise<string> {
  const sid = s.cookies.ff_sid!;
  const raw = (await env.kv.get(sessionKey(sid)))!;
  await env.kv.del(sessionKey(sid));
  await env.kv.set(`sess:${sid}`, raw, ttl);
  return sid;
}

describe('session keys are hashed at rest', () => {
  it('a sign-in writes sess:<sha256(sid)>; no key anywhere in the store carries the raw session id', async () => {
    env = await makeEnv();
    const s = await env.login();
    const sid = s.cookies.ff_sid!;
    expect(sessionKey(sid)).toBe(`sess:${sha(sid)}`);
    expect(sessionHash(sid)).toBe(sha(sid));
    expect(await env.kv.get(sessionKey(sid))).not.toBeNull();
    expect((await call(s, 'GET', '/api/me')).statusCode).toBe(200);
    const all = await env.kv.keys('');
    expect(all.filter((k) => k.includes(sid))).toEqual([]);
    expect((await env.kv.keys('sess:')).every((k) => /^sess:[0-9a-f]{64}$/.test(k))).toBe(true);
  });

  it('a cookie holding a session\'s hash is not a session (a copied store gives no way in)', async () => {
    env = await makeEnv();
    const s = await env.login();
    const stolen = { cookies: { ff_sid: sha(s.cookies.ff_sid!) }, csrf: s.csrf };
    expect((await call(stolen, 'GET', '/api/me')).statusCode).toBe(401);
    // nothing was created or moved under the hash of the hash
    expect(await env.kv.keys('sess:')).toEqual([sessionKey(s.cookies.ff_sid!)]);
  });

  it('a legacy session (raw id as the key) still signs in: moved once to the hashed key with its remaining ttl, the raw key gone', async () => {
    env = await makeEnv();
    const s = await env.login();
    const sid = await makeLegacy(s, 250);
    expect(await env.kv.get(sessionKey(sid))).toBeNull();
    expect((await call(s, 'GET', '/api/me')).statusCode).toBe(200);
    expect(await env.kv.get(`sess:${sid}`)).toBeNull();
    expect(await env.kv.get(sessionKey(sid))).not.toBeNull();
    // the remaining ttl (250 s), not a fresh idle ttl (300 s): the session was touched less than a minute ago, so nothing refreshed it
    expect(ttlMs(env.kv, sessionKey(sid))).toBeLessThanOrEqual(250_000);
    expect(ttlMs(env.kv, sessionKey(sid))).toBeGreaterThan(240_000);
    expect((await env.kv.keys('')).filter((k) => k.includes(sid))).toEqual([]);
    expect((await call(s, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('the CSRF check holds for a legacy session too (it is moved before the check, never skipped)', async () => {
    env = await makeEnv();
    const s = await env.login();
    await makeLegacy(s, 250);
    expect((await call(s, 'POST', '/api/sessions/revoke-others', 'wrong')).statusCode).toBe(403);
    expect((await call(s, 'POST', '/api/sessions/revoke-others')).statusCode).toBe(200);
  });

  it('revoking ends hashed and legacy sessions alike (sign out everywhere, logout)', async () => {
    env = await makeEnv();
    const here = await env.login();
    const a = await env.login();
    const b = await env.login();
    const legacy = await makeLegacy(a, 250);
    const r = await call(here, 'POST', '/api/sessions/revoke-others');
    expect(r.json()).toEqual({ revoked: 2 });
    expect(await env.kv.get(`sess:${legacy}`)).toBeNull();
    expect(await env.kv.get(sessionKey(legacy))).toBeNull();
    expect(await env.kv.get(sessionKey(b.cookies.ff_sid!))).toBeNull();
    expect((await call(a, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await call(b, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await call(here, 'GET', '/api/me')).statusCode).toBe(200);

    // logout removes both keys of the session (a raw copy written back by an old process included)
    const sid = here.cookies.ff_sid!;
    await env.kv.set(`sess:${sid}`, (await env.kv.get(sessionKey(sid)))!, 250);
    expect((await call(here, 'POST', '/auth/logout')).statusCode).toBeLessThan(400);
    expect(await env.kv.get(sessionKey(sid))).toBeNull();
    expect(await env.kv.get(`sess:${sid}`)).toBeNull();
  });
});

describe('kv move and the key helpers', () => {
  it('move keeps the ttl, never overwrites a newer key, and says whether it moved', async () => {
    const kv = new MemoryKV();
    await kv.set('a', '1', 100);
    expect(await kv.move('a', 'b')).toBe(true);
    expect(await kv.get('a')).toBeNull();
    expect(await kv.get('b')).toBe('1');
    expect(ttlMs(kv, 'b')).toBeGreaterThan(90_000);
    expect(ttlMs(kv, 'b')).toBeLessThanOrEqual(100_000);
    await kv.set('c', 'old', 100);
    expect(await kv.move('c', 'b')).toBe(false);
    expect(await kv.get('b')).toBe('1');
    expect(await kv.get('c')).toBeNull();
    expect(await kv.move('missing', 'b')).toBe(false);
  });

  it('hashOfSessionKey: a hashed key gives its hash, a legacy one the hash of its raw id', () => {
    expect(hashOfSessionKey(sessionKey('abc'))).toBe(sha('abc'));
    expect(hashOfSessionKey('sess:abc')).toBe(sha('abc'));
  });
});
