// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { checkLoginFlows } from '../src/flowCheck.js';
import type { HealthSnapshot, ServiceHealth } from '../src/health.js';
import { signinCheck } from '../src/syscheck/checks/signin.js';
import { buildSystemcheck } from '../src/syscheck/engine.js';
import type { CheckId, CheckLine } from '../src/syscheck/types.js';
import { MODEL, setup, type Opts } from './akcheck-fake.js';
import { cfg, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

// Systemcheck Stage 1, Task 3: the sign-in lines from the sign-in status check (checkLoginFlows over the fake Authentik API) and the snapshot.
const TOKEN = 'ak-fake-token-0001';
const snap = (oidc: Partial<ServiceHealth> = {}): HealthSnapshot => ({
  at: new Date().toISOString(), services: [{ id: 'oidc', level: 'ok', ...oidc }], disks: [], errors: { level: 'ok', server15: 0, client15: 0, playback60: 0 }, issues: [], worst: 'ok',
});

/** the sign-in check alone over the fake Authentik (its lines as the check returns them) */
async function lines(o: Opts = {}, oidc: Partial<ServiceHealth> = {}): Promise<Record<string, CheckLine>> {
  const { ctx } = setup(o);
  const out = await signinCheck.run({ ctx: ctx as unknown as Ctx, snapshot: async () => snap(oidc), login: () => checkLoginFlows(ctx), fresh: false, timeoutMs: signinCheck.timeoutMs });
  expect(out.map((l) => l.id)).toEqual(signinCheck.ids);
  return Object.fromEntries(out.map((l) => [l.id, l]));
}

describe('sign-in lines', () => {
  it('a healthy install: every sign-in line ok, the mail line ok with mail_unverified (delivery is not tested)', async () => {
    const r = await lines();
    for (const id of ['signin.oidc', 'signin.authentik', 'signin.flows', 'signin.issuerHost', 'signin.passkeys'] as const) expect(r[id], id).toEqual({ id, group: 'signin', status: 'ok', runs: 'server' });
    expect(r['signin.mail']).toEqual({ id: 'signin.mail', group: 'signin', status: 'ok', cause: 'mail_unverified', runs: 'server' });
  });

  it('no Authentik API → signin.authentik, signin.flows, signin.mail not_set_up; signin.passkeys not_set_up when PASSKEYS_IN_APP=off', async () => {
    const r = await lines({ cfgOver: { AUTHENTIK_URL: undefined, AUTHENTIK_API_TOKEN: undefined, PASSKEYS_IN_APP: 'off' } });
    for (const id of ['signin.authentik', 'signin.flows', 'signin.mail'] as const) expect(r[id], id).toMatchObject({ status: 'not_set_up', cause: 'authentik_not_set', settingKey: 'AUTHENTIK_URL' });
    expect(r['signin.passkeys']).toMatchObject({ status: 'not_set_up', cause: 'passkeys_off', settingKey: 'PASSKEYS_IN_APP' });
    expect(r['signin.issuerHost']).toMatchObject({ status: 'not_set_up', settingKey: 'AUTHENTIK_URL' });
    expect(Object.values(r).filter((l) => l.status === 'problem' || l.status === 'warning')).toEqual([]);
    // the URL without a token: the token is what is missing
    const half = await lines({ cfgOver: { AUTHENTIK_API_TOKEN: undefined, PASSKEYS_IN_APP: 'off' } });
    expect(half['signin.authentik']).toMatchObject({ status: 'not_set_up', settingKey: 'AUTHENTIK_API_TOKEN' });
  });

  it('token refused in app mode → signin.authentik problem ak_token_invalid settingKey AUTHENTIK_API_TOKEN; JSON has no token value', async () => {
    const r = await lines({ tokenInvalid: true });
    expect(r['signin.authentik']).toMatchObject({ status: 'problem', cause: 'ak_token_invalid', settingKey: 'AUTHENTIK_API_TOKEN' });
    expect(r['signin.flows']).toMatchObject({ status: 'unknown', cause: 'flows_unchecked' }); // never a pile of "missing" flows
    expect(r['signin.mail']).toMatchObject({ status: 'unknown', cause: 'flows_unchecked' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    // the classic sign-in page does not need the token: a warning
    const classic = await lines({ tokenInvalid: true, cfgOver: { LOGIN_UI: 'authentik' } });
    expect(classic['signin.authentik']).toMatchObject({ status: 'warning', cause: 'ak_token_invalid' });
  });

  it('Authentik unreachable → ak_unreachable (problem in app mode); missing permissions → warning ak_permission with codes', async () => {
    const down = await lines({ down: true });
    expect(down['signin.authentik']).toMatchObject({ status: 'problem', cause: 'ak_unreachable', settingKey: 'AUTHENTIK_URL' });
    expect(down['signin.flows']).toMatchObject({ status: 'unknown', cause: 'flows_unchecked' });
    const perms = await lines({ missingPerms: ['view_emailstage', 'view_invitation'] });
    expect(perms['signin.authentik']).toMatchObject({ status: 'warning', cause: 'ak_permission', params: { perms: 'view_emailstage,view_invitation' }, href: '/admin/status#login' });
  });

  it('forwarded host ignored → signin.passkeys warning forwarded_host_ignored fix proxy_forward_host docs authentik.md#23-reverse-proxy-nginx-proxy-manager', async () => {
    const r = await lines({ issuer: 'https://auth.example.com/application/o/friendflix/' });
    expect(r['signin.passkeys']).toMatchObject({ status: 'warning', cause: 'forwarded_host_ignored', fix: 'proxy_forward_host', docs: 'authentik.md#23-reverse-proxy-nginx-proxy-manager' });
  });

  it('passkeys precedence: reason first, then the passkey sign-in, then user verification', async () => {
    const http = await lines({ cfgOver: { PUBLIC_URL: 'http://friend.example.com' } });
    expect(http['signin.passkeys']).toMatchObject({ status: 'warning', cause: 'passkeys_not_https', settingKey: 'PUBLIC_URL' });
    const noStage = await lines({ executor: { json: { component: 'ak-stage-identification', user_fields: ['username'] } } });
    expect(noStage['signin.passkeys']).toMatchObject({ status: 'warning', cause: 'passkeys_no_stage', href: '/admin/status#login' });
    const weak = await lines({ executor: { json: { component: 'ak-stage-identification', passkey_challenge: { challenge: 'fake-challenge-0021', rpId: 'friend.example.com', userVerification: 'preferred' } } } });
    expect(weak['signin.passkeys']).toMatchObject({ status: 'warning', cause: 'passkeys_uv_not_required', href: '/admin/status#login' });
  });

  it('recovery flow with an e-mail stage → signin.mail ok cause mail_unverified; without → warning mail_no_stage', async () => {
    expect((await lines())['signin.mail']).toMatchObject({ status: 'ok', cause: 'mail_unverified' });
    const r = await lines({ stages: { 'default-recovery-flow': [MODEL.ident, MODEL.prompt] } });
    expect(r['signin.mail']).toMatchObject({ status: 'warning', cause: 'mail_no_stage', fix: 'mail_no_stage', href: '/admin/status#login' });
  });

  it('two flows missing → signin.flows warning params.n 2 href /admin/status#login', async () => {
    const r = await lines({ stages: { 'default-recovery-flow': null, 'default-password-change': null } });
    expect(r['signin.flows']).toMatchObject({ status: 'warning', cause: 'flow_missing', params: { n: 2, flow: 'recovery' }, href: '/admin/status#login' });
    const consent = await lines({ stages: { 'default-provider-authorization-implicit-consent': [MODEL.consent] } });
    expect(consent['signin.flows']).toMatchObject({ status: 'warning', cause: 'consent', params: { n: 1 } });
  });

  it('issuer not on the Authentik address → signin.issuerHost warning settingKey OIDC_ISSUER', async () => {
    const r = await lines({ cfgOver: { OIDC_ISSUER: 'https://sso.example.com/application/o/friendflix/' } });
    expect(r['signin.issuerHost']).toMatchObject({ status: 'warning', cause: 'issuer_not_on_authentik', settingKey: 'OIDC_ISSUER' });
  });

  it('OIDC discovery down or on another issuer → signin.oidc problem settingKey OIDC_ISSUER', async () => {
    expect((await lines({}, { level: 'err', reason: 'down' }))['signin.oidc']).toMatchObject({ status: 'problem', cause: 'oidc_down', settingKey: 'OIDC_ISSUER' });
    expect((await lines({}, { level: 'err', reason: 'issuer_mismatch' }))['signin.oidc']).toMatchObject({ status: 'problem', cause: 'oidc_issuer_mismatch', settingKey: 'OIDC_ISSUER' });
  });
});

describe('a hung Authentik', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(() => env.close());

  it('Authentik never answers → sign-in lines unknown check_timeout, other groups filled, answer < 8.5 s', async () => {
    const inner = fakeHttp({ 'GET /health': () => ({ json: { status: 'ok' } }) });
    env.ctx.cfg = { ...cfg, AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: TOKEN };
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.host === 'auth.example.com') return new Promise<Response>(() => undefined); // never answers, ignores its abort signal
      if (u.pathname.startsWith('/api/setup/echo/')) return Response.json({ answer: await env.kv.get(`setup:echo:${u.pathname.split('/').pop()}`) });
      return inner(input, init);
    }) as typeof fetch;
    const ok = { level: 'ok' as const };
    await env.kv.set('health:snap', JSON.stringify({
      ...snap(), services: (['media', 'postgres', 'redis', 'gateway', 'oidc', 'requests', 'tmdb', 'omdb', 'playbackCheck', 'encoder'] as const).map((id) => ({ id, ...ok })),
      disks: [{ id: 'downloads', ...ok, usedPct: 1, ownBytes: 0 }, { id: 'previews', ...ok, usedPct: 1, ownBytes: 0 }, { id: 'database', ...ok, ownBytes: 0 }],
    }), 300);
    const t0 = performance.now();
    const r = await buildSystemcheck(env.ctx);
    expect(performance.now() - t0).toBeLessThan(8_500);
    expect(r.lines.filter((l) => l.group === 'signin').map((l) => [l.id, l.status, l.cause])).toEqual(signinCheck.ids.map((id: CheckId) => [id, 'unknown', 'check_timeout']));
    const others = r.lines.filter((l) => l.group === 'core' || l.group === 'media'); // Live TV and updates have lines of their own (Stage 3)
    expect(others.length).toBe(17); // 10 core lines (with core.redisPersistence and core.mail) + 7 media lines (with media.managed)
    // e-mail and a managed media server are optional and not set up here: neutral, not a problem
    expect(others.filter((l) => l.status !== 'ok').map((l) => [l.id, l.status])).toEqual([['core.mail', 'not_set_up'], ['media.managed', 'not_set_up']]);
  }, 15_000);
});
