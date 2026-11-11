// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthentikProvider, RESET_PIN_MAX_AGE } from '../src/oidc.js';
import { REAUTH_MAX_AGE } from '../src/reauth.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => { vi.unstubAllGlobals(); const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

type StartOpts = { forceLogin?: boolean; silent?: boolean } | undefined;
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
const now = () => Math.floor(Date.now() / 1000);

describe('interactive sign-in always asks the identity provider again', () => {
  it('/auth/login and /auth/login?classic=1 force prompt=login + max_age (forceLogin)', async () => {
    env = await makeEnv();
    const s = spy();
    expect((await env.app.inject('/auth/login?classic=1')).statusCode).toBe(302);
    expect(s.starts.at(-1)).toEqual({ forceLogin: true });
    const r = await env.app.inject('/auth/login');
    expect(r.headers.location).toMatch(/^https:\/\/idp\//);
    expect(s.starts.at(-1)).toEqual({ forceLogin: true });
  });

  it('the setup sign-in (?setup=1) and the reset-PIN login also force it', async () => {
    env = await makeEnv();
    const s = spy();
    await env.app.inject('/auth/login?setup=1');
    expect(s.starts.at(-1)).toEqual({ forceLogin: true });
    await env.app.inject('/auth/login?resetPin=1');
    expect(s.starts.at(-1)).toEqual({ forceLogin: true });
  });

  it('the callback checks the id_token for a fresh auth_time (maxAge) on a normal sign-in', async () => {
    env = await makeEnv();
    const s = spy();
    const l = await env.app.inject('/auth/login?classic=1');
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await callback(st);
    expect(cb.statusCode).toBe(302);
    expect(s.finishes.at(-1)).toEqual({ maxAge: RESET_PIN_MAX_AGE });
  });

  it('callback rejects a missing or stale auth_time and creates no session', async () => {
    env = await makeEnv();
    for (const authTime of [undefined, now() - 3600, now() - (RESET_PIN_MAX_AGE + 60), now() + 3600]) {
      env.claims.current = { ...env.claims.current, authTime } as typeof env.claims.current;
      const l = await env.app.inject('/auth/login?classic=1');
      const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
      const cb = await callback(st);
      expect(cb.statusCode).toBe(401);
      expect(cb.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    }
    expect(await env.kv.keys('sess:')).toEqual([]);
  });

  it('callback accepts a fresh auth_time (inside the skew bound)', async () => {
    env = await makeEnv();
    for (const authTime of [now(), now() - 60, now() - 5]) {
      env.claims.current = { ...env.claims.current, authTime } as typeof env.claims.current;
      const l = await env.app.inject('/auth/login?classic=1');
      const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
      const cb = await callback(st);
      expect(cb.statusCode).toBe(302);
      expect(cb.cookies.find((c) => c.name === 'ff_sid')).toBeDefined();
    }
  });

  it('re-authentication is unchanged: forceLogin and REAUTH_MAX_AGE', async () => {
    env = await makeEnv();
    const sess = await env.login();
    const s = spy();
    const r = await env.app.inject({ url: '/auth/reauth?next=/me/account', cookies: sess.cookies });
    expect(s.starts.at(-1)).toEqual({ forceLogin: true });
    const st = r.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ...sess.cookies, ff_oidc: st } });
    expect(cb.headers.location).toBe('/me/account');
    expect(s.finishes.at(-1)).toEqual({ maxAge: REAUTH_MAX_AGE });
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
  it('forceLogin sends prompt=login and max_age=0; silent sends prompt=none only', async () => {
    const p = await provider();
    const forced = new URL((await p.start({ forceLogin: true })).url);
    expect(forced.searchParams.get('prompt')).toBe('login');
    expect(forced.searchParams.get('max_age')).toBe('0');
    const silent = new URL((await p.start({ silent: true })).url);
    expect(silent.searchParams.get('prompt')).toBe('none');
    expect(silent.searchParams.has('max_age')).toBe(false);
  });
});
