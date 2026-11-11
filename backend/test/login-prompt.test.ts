// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthentikProvider, AUTH_SKEW_S, RESET_PIN_MAX_AGE, SIGNIN_MAX_AGE, signedInAfter } from '../src/oidc.js';
import { REAUTH_MAX_AGE } from '../src/reauth.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => { vi.unstubAllGlobals(); const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

type StartOpts = { forceLogin?: boolean; silent?: boolean; maxAge?: number } | undefined;
type FinishOpts = { maxAge?: number } | undefined;
/** records every start/finish the routes make */
function spy() {
  const starts: StartOpts[] = [];
  const finishes: FinishOpts[] = [];
  const start = env.ctx.oidc.start;
  const finish = env.ctx.oidc.finish;
  env.ctx.oidc.start = (o) => { starts.push(o); return start(o); };
  env.ctx.oidc.finish = (u, s, o) => { finishes.push(o); return finish(u, s, o); };
  return { starts, finishes };
}
const callback = (state: string) => env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ff_oidc: state } });

describe('interactive sign-in through the identity provider', () => {
  /** starts a sign-in at `url`, pins its start time to a whole second, and answers the callback with auth_time = start + offsetS */
  async function signIn(url: string, offsetS: number | undefined, claims: Partial<typeof env.claims.current> = {}) {
    const l = await env.app.inject(url);
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const saved = JSON.parse((await env.kv.get(`oidc:${st}`))!);
    saved.startedAt = Math.floor(saved.startedAt / 1000) * 1000;
    await env.kv.set(`oidc:${st}`, JSON.stringify(saved), 600);
    env.claims.current = { ...env.claims.current, ...claims, authTime: offsetS === undefined ? undefined : saved.startedAt / 1000 + offsetS } as typeof env.claims.current;
    return callback(st);
  }

  it('every sign-in through the identity provider sends a positive max_age and no prompt', async () => {
    env = await makeEnv();
    const s = spy();
    for (const url of ['/auth/login', '/auth/login?classic=1', '/auth/login?setup=1', '/auth/login?resetPin=1']) {
      expect((await env.app.inject(url)).statusCode).toBe(302);
      expect(s.starts.at(-1), url).toEqual({ maxAge: SIGNIN_MAX_AGE });
    }
    expect(SIGNIN_MAX_AGE).toBe(30); // = the clock skew: an IdP login older than that is never answered without the login page
    expect(SIGNIN_MAX_AGE).toBe(AUTH_SKEW_S);
  });

  it('the callback binds freshness to the start of the sign-in: auth_time 30 s before the start passes, 31 s fails', async () => {
    env = await makeEnv();
    const s = spy();
    const ok = await signIn('/auth/login?classic=1', -30);
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/');
    expect(ok.cookies.find((c) => c.name === 'ff_sid')).toBeDefined();
    expect(s.finishes.at(-1)).toBeUndefined(); // the check is ours, not relative to "now"
    const stale = await signIn('/auth/login?classic=1', -31);
    expect([stale.statusCode, stale.headers.location]).toEqual([302, '/login?stale=1']);
    expect(stale.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
  });

  it('a missing, long past or far future auth_time ends on the sign-in page with the stale notice, never on JSON, and makes no session', async () => {
    env = await makeEnv();
    for (const off of [undefined, -3600, -(RESET_PIN_MAX_AGE + 60), 3600]) {
      const cb = await signIn('/auth/login?classic=1', off);
      expect([cb.statusCode, cb.headers.location], String(off)).toEqual([302, '/login?stale=1']);
      expect(cb.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    }
    expect(await env.kv.keys('sess:')).toEqual([]);
  });

  it('a callback long after a start (a leftover session whose login is older than the cap) is stale even when it follows the start', async () => {
    env = await makeEnv();
    const l = await env.app.inject('/auth/login?classic=1');
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const saved = JSON.parse((await env.kv.get(`oidc:${st}`))!);
    saved.startedAt = Date.now() - 600_000; // the sign-in began 10 minutes ago, the IdP login came right after it
    await env.kv.set(`oidc:${st}`, JSON.stringify(saved), 600);
    env.claims.current = { ...env.claims.current, authTime: Math.floor(saved.startedAt / 1000) + 5 } as typeof env.claims.current;
    expect((await callback(st)).headers.location).toBe('/login?stale=1');
  });

  it('a stale forgotten-PIN sign-in ends on the profile screen\'s stale notice', async () => {
    env = await makeEnv();
    const cb = await signIn('/auth/login?resetPin=1', -3600);
    expect([cb.statusCode, cb.headers.location]).toEqual([302, '/profiles?pinReset=stale']);
    expect(cb.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
  });

  it('re-authentication is start-bound too: auth_time 100 s or 31 s before the start is refused (no stamp), 30 s before passes', async () => {
    env = await makeEnv();
    const sess = await env.login();
    const run = async (offsetS: number) => {
      const r = await env.app.inject({ url: '/auth/reauth?next=/me/account', cookies: sess.cookies });
      const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
      const saved = JSON.parse((await env.kv.get(`oidc:${st}`))!);
      expect(typeof saved.startedAt).toBe('number');
      saved.startedAt = Math.floor(saved.startedAt / 1000) * 1000;
      await env.kv.set(`oidc:${st}`, JSON.stringify(saved), 600);
      env.claims.current = { ...env.claims.current, authTime: saved.startedAt / 1000 + offsetS } as typeof env.claims.current;
      return env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ...sess.cookies, ff_oidc: st } });
    };
    const stamp = async () => JSON.parse((await env.kv.get(`sess:${sess.cookies.ff_sid}`))!).reauthAt;
    for (const off of [-100, -31]) {
      const cb = await run(off);
      expect([cb.statusCode, cb.headers.location], String(off)).toEqual([302, '/me/account?reauth=failed']);
      expect(await stamp()).toBeUndefined();
    }
    const ok = await run(-30);
    expect(ok.headers.location).toBe('/me/account');
    expect(await stamp()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('re-authentication and the silent authorize are unchanged: forceLogin and REAUTH_MAX_AGE', async () => {
    env = await makeEnv();
    const sess = await env.login();
    const s = spy();
    const r = await env.app.inject({ url: '/auth/reauth?next=/me/account', cookies: sess.cookies });
    expect(s.starts.at(-1)).toEqual({ forceLogin: true, maxAge: SIGNIN_MAX_AGE });
    const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ...sess.cookies, ff_oidc: st } });
    expect(cb.headers.location).toBe('/me/account');
    expect(s.finishes.at(-1)).toEqual({ maxAge: REAUTH_MAX_AGE });
  });

  it('signedInAfter: boundaries (start - 30 s, now + 30 s)', () => {
    const start = 1_800_000_000_000;
    const now = start + 5_000;
    expect(signedInAfter(start / 1000 - 30, start, now)).toBe(true);
    expect(signedInAfter(start / 1000 - 31, start, now)).toBe(false);
    expect(signedInAfter(start / 1000 - 30.5, start, now)).toBe(false);
    expect(signedInAfter(now / 1000 + 30, start, now)).toBe(true);
    expect(signedInAfter(now / 1000 + 31, start, now)).toBe(false);
    expect(signedInAfter(undefined, start, now)).toBe(false);
    expect(signedInAfter(Number.NaN, start, now)).toBe(false);
    expect(signedInAfter(start / 1000 + 1, undefined, now)).toBe(false); // a saved login without a start time is never accepted
  });
});

describe('the authorize URL', () => {
  const issuer = 'https://auth.example.com/application/o/friendflix/';
  async function provider() {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        issuer, authorization_endpoint: 'https://auth.example.com/application/o/authorize/', token_endpoint: 'https://auth.example.com/application/o/token/',
        jwks_uri: `${issuer}jwks/`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      }), { headers: { 'content-type': 'application/json' } });
    });
    return createAuthentikProvider({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'ff', OIDC_CLIENT_SECRET: 'x', PUBLIC_URL: 'https://friend.example.com', OIDC_ALLOW_INSECURE: 'false' } as never);
  }
  it('maxAge sends max_age and no prompt; forceLogin sends prompt=login and max_age=0; silent sends prompt=none only', async () => {
    const p = await provider();
    const forced = new URL((await p.start({ forceLogin: true })).url);
    expect(forced.searchParams.get('prompt')).toBe('login');
    expect(forced.searchParams.get('max_age')).toBe('0');
    const reauth = new URL((await p.start({ forceLogin: true, maxAge: SIGNIN_MAX_AGE })).url);
    expect(reauth.searchParams.get('prompt')).toBe('login');
    expect(reauth.searchParams.get('max_age')).toBe(String(SIGNIN_MAX_AGE));
    const plain = new URL((await p.start({ maxAge: SIGNIN_MAX_AGE })).url);
    expect(plain.searchParams.get('max_age')).toBe(String(SIGNIN_MAX_AGE));
    expect(plain.searchParams.has('prompt')).toBe(false);
    expect(new URL((await p.start()).url).searchParams.has('max_age')).toBe(false);
    const silent = new URL((await p.start({ silent: true })).url);
    expect(silent.searchParams.get('prompt')).toBe('none');
    expect(silent.searchParams.has('max_age')).toBe(false);
  });
});
