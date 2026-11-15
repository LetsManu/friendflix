// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { lastAkFailures } from '../src/akdiag.js';
import { checkLoginFlows } from '../src/flowCheck.js';
import { IDENT_WITH_PASSKEY, MODEL, setup } from './akcheck-fake.js';
import type { Handler } from './helpers.js';

// Block 23 phase 3, Task 9: the sign-in status check over a fake Authentik API (fictional hosts, fake token).
const row = (r: Awaited<ReturnType<typeof checkLoginFlows>>, kind: string) => r.flows.find((f) => f.kind === kind)!;

describe('checkLoginFlows', () => {
  it('a healthy install: every flow ok, implicit consent, auth-code grant, same issuer origin, passkeys in-app, no warnings', async () => {
    const r = await checkLoginFlows(setup().ctx);
    expect(r).toMatchObject({
      mode: 'app', implicitConsent: true, authCodeGrant: true, issuerMatches: true, passkeys: 'in-app', passkeysReason: 'ok', unreachable: false, warnings: [],
      serviceToken: { token: 'ok', missing: [] }, executor: { ok: true }, passkeySignIn: 'ok', lastFailures: [],
    });
    expect(r.flows.map((f) => [f.kind, f.state])).toEqual([
      ['login', 'ok'], ['recovery', 'ok'], ['invalidation', 'ok'], ['setup-totp', 'ok'], ['setup-static', 'ok'], ['setup-webauthn', 'ok'], ['change-password', 'ok'], ['change-email', 'ok'],
    ]);
    expect(row(r, 'login').stages).toEqual([MODEL.ident, MODEL.password, MODEL.validate, MODEL.login]);
  });

  it('missing flow -> missing', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'default-recovery-flow': null } }).ctx);
    expect(row(r, 'recovery')).toEqual({ kind: 'recovery', slug: 'default-recovery-flow', state: 'missing', stages: [] });
    expect(r.warnings).toEqual(['flow_missing:recovery']);
    expect(r.mode).toBe('app'); // a failing check never changes the mode
  });

  it('the e-mail change flow (blueprint not imported, or a custom slug) is checked too; missing is no warning (an optional manual import)', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'friendflix-email-change': null } }).ctx);
    expect(row(r, 'change-email')).toEqual({ kind: 'change-email', slug: 'friendflix-email-change', state: 'missing', stages: [] });
    expect(r.warnings).toEqual(['optional:change-email']); // a hint (template + repair), not a broken flow
    const odd = await checkLoginFlows(setup({ stages: { 'friendflix-email-change': [MODEL.prompt, MODEL.captcha] } }).ctx);
    expect(odd.warnings).toEqual(['flow_unsupported:change-email']);
    const custom = await checkLoginFlows(setup({ stages: { 'my-email-change': [MODEL.prompt, MODEL.email, MODEL.write] }, cfgOver: { AUTHENTIK_EMAIL_CHANGE_FLOW: 'my-email-change' } }).ctx);
    expect(row(custom, 'change-email')).toMatchObject({ slug: 'my-email-change', state: 'ok', stages: [MODEL.prompt, MODEL.email, MODEL.write] });
  });

  it('a token without view_oauth2provider (403): a distinct permission warning, never a silent pass of the consent and grant checks', async () => {
    const r = await checkLoginFlows(setup({ providerForbidden: true, stages: { 'default-provider-authorization-implicit-consent': [MODEL.consent] } }).ctx);
    expect([r.implicitConsent, r.authCodeGrant, r.unreachable]).toEqual([null, null, false]);
    expect(r.warnings).toEqual(['permission:provider']);
  });

  it('a token without view_authenticatorvalidatestage (403): a permission warning; the flow rows stay ok', async () => {
    const r = await checkLoginFlows(setup({ validateForbidden: true }).ctx);
    expect(row(r, 'login').state).toBe('ok');
    expect(r.unreachable).toBe(false);
    expect(r.warnings).toEqual(['permission:validate_stage']);
  });

  it('flow with a captcha stage -> unsupported with stages listed', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'default-authentication-flow': [MODEL.ident, MODEL.captcha, MODEL.password] } }).ctx);
    expect(row(r, 'login')).toMatchObject({ state: 'unsupported', stages: [MODEL.ident, MODEL.captcha, MODEL.password] });
    expect(r.warnings).toContain('flow_unsupported:login');
  });

  it('bindings are classified by meta_model_name, not by the -form component', async () => {
    // the component says "email-form" for a stage whose model is not an e-mail stage, and the model decides
    const { ctx } = setup({ stages: { 'default-recovery-flow': [MODEL.ident, MODEL.email] } });
    const r = await checkLoginFlows(ctx);
    expect(row(r, 'recovery')).toMatchObject({ state: 'ok', stages: [MODEL.ident, MODEL.email] });
    const odd = await checkLoginFlows(setup({ stages: { 'default-recovery-flow': ['authentik_stages_email.somethingelse'] } }).ctx);
    expect(row(odd, 'recovery').state).toBe('unsupported');
  });

  it('explicit-consent authorization flow -> implicitConsent false', async () => {
    const r = await checkLoginFlows(setup({ stages: { 'default-provider-authorization-implicit-consent': [MODEL.consent] } }).ctx);
    expect(r.implicitConsent).toBe(false);
    expect(r.warnings).toContain('consent');
  });

  it('issuer on another host -> issuerMatches false', async () => {
    const r = await checkLoginFlows(setup({ cfgOver: { OIDC_ISSUER: 'https://sso.example.com/application/o/friendflix/' } }).ctx);
    expect(r.issuerMatches).toBe(false);
    expect(r.warnings).toContain('issuer');
  });

  it('provider with grant_types [] -> authCodeGrant false and a warning', async () => {
    const r = await checkLoginFlows(setup({ provider: { grant_types: [] } }).ctx);
    expect(r.authCodeGrant).toBe(false);
    expect(r.warnings).toContain('auth_code_grant');
    // objects with a name (other releases) count too; an answer without the field is unknown
    expect((await checkLoginFlows(setup({ provider: { grant_types: [{ name: 'authorization_code' }] } }).ctx)).authCodeGrant).toBe(true);
    expect((await checkLoginFlows(setup({ provider: { grant_types: undefined } }).ctx)).authCodeGrant).toBeNull();
    const none = await checkLoginFlows(setup({ provider: null }).ctx);
    expect([none.authCodeGrant, none.implicitConsent]).toEqual([null, null]);
  });

  it('discovery probe: issuer on the app host -> passkeys in-app; on Authentik\'s host -> sign-in page, forwarded_host_ignored', async () => {
    const ok = setup();
    expect(await checkLoginFlows(ok.ctx)).toMatchObject({ passkeys: 'in-app', passkeysReason: 'ok' });
    const probe = ok.calls.find((c) => c.path.endsWith('openid-configuration'))!;
    expect(probe.host).toBe('auth.example.com');
    const bad = await checkLoginFlows(setup({ issuer: 'https://auth.example.com/application/o/friendflix/' }).ctx);
    expect(bad).toMatchObject({ passkeys: 'sign-in page', passkeysReason: 'forwarded_host_ignored' });
    expect(bad.warnings).toContain('passkeys:forwarded_host_ignored');
  });

  it('PASSKEYS_IN_APP=off -> sign-in page, disabled, no probe call; http PUBLIC_URL -> not_https', async () => {
    const off = setup({ cfgOver: { PASSKEYS_IN_APP: 'off' } });
    expect(await checkLoginFlows(off.ctx)).toMatchObject({ passkeys: 'sign-in page', passkeysReason: 'disabled', warnings: [] });
    expect(off.calls.some((c) => c.path.endsWith('openid-configuration'))).toBe(false);
    const http = setup({ cfgOver: { PUBLIC_URL: 'http://friend.example.com' } });
    expect(await checkLoginFlows(http.ctx)).toMatchObject({ passkeys: 'sign-in page', passkeysReason: 'not_https' });
    expect(http.calls.some((c) => c.path.endsWith('openid-configuration'))).toBe(false);
  });

  it('passkey sign-in: no passkey challenge on the identification stage -> no_stage with its own warning, even while passkeys run in-app', async () => {
    const r = await checkLoginFlows(setup({ executor: { json: { component: 'ak-stage-identification', user_fields: ['username'], passkey_challenge: null } } }).ctx);
    expect(r).toMatchObject({ passkeys: 'in-app', passkeySignIn: 'no_stage', warnings: ['passkeys:no_stage'] });
    // the forwarded host is ignored as well: both causes are named, each with its own fix
    const both = await checkLoginFlows(setup({ issuer: 'https://auth.example.com/application/o/friendflix/', executor: { json: { component: 'ak-stage-identification', user_fields: ['username'] } } }).ctx);
    expect(both.passkeySignIn).toBe('no_stage');
    expect(both.warnings).toEqual(['passkeys:forwarded_host_ignored', 'passkeys:no_stage']);
  });

  it('passkey sign-in: a challenge for another RP ID while the host is forwarded -> rp_mismatch; host not forwarded -> off (the reason says why)', async () => {
    const other = { json: { ...IDENT_WITH_PASSKEY, passkey_challenge: { ...IDENT_WITH_PASSKEY.passkey_challenge, rpId: 'auth.example.com' } } };
    const r = await checkLoginFlows(setup({ executor: other }).ctx);
    expect(r).toMatchObject({ passkeys: 'in-app', passkeySignIn: 'rp_mismatch', warnings: ['passkeys:rp_mismatch'] });
    const off = await checkLoginFlows(setup({ executor: other, issuer: 'https://auth.example.com/application/o/friendflix/' }).ctx);
    expect(off).toMatchObject({ passkeySignIn: 'off', warnings: ['passkeys:forwarded_host_ignored'] });
    // PASSKEYS_IN_APP=off is the owner's choice: no warning at all
    const disabled = await checkLoginFlows(setup({ cfgOver: { PASSKEYS_IN_APP: 'off' }, executor: { json: { component: 'ak-stage-identification', user_fields: ['username'] } } }).ctx);
    expect(disabled).toMatchObject({ passkeySignIn: 'no_stage', warnings: [] });
  });

  it('passkey sign-in without required user verification: offered, but a warning (re-authentication with a passkey stays off)', async () => {
    const weak = { json: { ...IDENT_WITH_PASSKEY, passkey_challenge: { ...IDENT_WITH_PASSKEY.passkey_challenge, userVerification: 'preferred' } } };
    expect(await checkLoginFlows(setup({ executor: weak }).ctx)).toMatchObject({ passkeySignIn: 'ok', warnings: ['passkeys:uv_not_required'] });
    expect(await checkLoginFlows(setup().ctx)).toMatchObject({ passkeySignIn: 'ok', warnings: [] });
  });

  it('passkeyUv exposes what Authentik sends: required / preferred / discouraged, anything else or missing -> unknown, no passkey challenge -> null', async () => {
    const uv = async (v: unknown) => {
      const pk: Record<string, unknown> = { ...IDENT_WITH_PASSKEY.passkey_challenge };
      if (v === undefined) delete pk.userVerification; else pk.userVerification = v;
      return (await checkLoginFlows(setup({ executor: { json: { ...IDENT_WITH_PASSKEY, passkey_challenge: pk } } }).ctx)).passkeyUv;
    };
    expect(await uv('required')).toBe('required');
    expect(await uv('preferred')).toBe('preferred');
    expect(await uv('discouraged')).toBe('discouraged');
    expect(await uv(undefined)).toBe('unknown');
    expect(await uv('mandatory')).toBe('unknown');
    const noStage = await checkLoginFlows(setup({ executor: { json: { component: 'ak-stage-identification', user_fields: ['username'], passkey_challenge: null } } }).ctx);
    expect(noStage.passkeyUv).toBeNull();
    expect((await checkLoginFlows(setup({ executor: { status: 500, json: {} } }).ctx)).passkeyUv).toBeNull();
  });

  it('a missing or unknown userVerification is a warning too (sign-in itself may not verify the person)', async () => {
    const pk: Record<string, unknown> = { ...IDENT_WITH_PASSKEY.passkey_challenge };
    delete pk.userVerification;
    expect(await checkLoginFlows(setup({ executor: { json: { ...IDENT_WITH_PASSKEY, passkey_challenge: pk } } }).ctx)).toMatchObject({ passkeyUv: 'unknown', warnings: ['passkeys:uv_not_required'] });
  });

  it('passkey sign-in: a first stage that is no identification -> unknown, no warning; a failing executor -> null', async () => {
    expect(await checkLoginFlows(setup({ executor: { json: { component: 'ak-stage-password' } } }).ctx)).toMatchObject({ passkeySignIn: 'unknown', warnings: [] });
    const down = await checkLoginFlows(setup({ executor: { status: 500, json: {} } }).ctx);
    expect(down.passkeySignIn).toBeNull();
    expect(down.warnings.some((w) => w.startsWith('passkeys:'))).toBe(false);
  });

  it('no API -> mode authentik and flows []', async () => {
    const s = setup({ cfgOver: { AUTHENTIK_URL: undefined, AUTHENTIK_API_TOKEN: undefined } });
    expect(await checkLoginFlows(s.ctx)).toMatchObject({ mode: 'authentik', flows: [], implicitConsent: null, authCodeGrant: null, warnings: [] });
    expect(s.calls.filter((c) => c.path.startsWith('/api/v3'))).toEqual([]);
  });

  it('an unreachable Authentik is a warning, not a pile of "missing" flows', async () => {
    const r = await checkLoginFlows(setup({ down: true }).ctx);
    expect(r.unreachable).toBe(true);
    expect(r.warnings).toContain('unreachable');
    expect(r.warnings.some((w) => w.startsWith('flow_missing'))).toBe(false);
    expect(r.mode).toBe('app');
  });

  it('enrolment is checked when AUTHENTIK_ENROLL_FLOW is set; custom slugs are used', async () => {
    const r = await checkLoginFlows(setup({ cfgOver: { AUTHENTIK_ENROLL_FLOW: 'friendflix-enroll', AUTHENTIK_LOGIN_FLOW: 'my-login' }, stages: { 'friendflix-enroll': [MODEL.prompt], 'my-login': [MODEL.ident] } }).ctx);
    expect(row(r, 'enroll')).toMatchObject({ slug: 'friendflix-enroll', state: 'ok' });
    expect(row(r, 'login')).toMatchObject({ slug: 'my-login', state: 'ok' });
  });

  it('is cached for 10 minutes under a hash of its inputs', async () => {
    const s = setup();
    await checkLoginFlows(s.ctx);
    const n = s.calls.length;
    await checkLoginFlows(s.ctx);
    expect(s.calls.length).toBe(n);
    s.ctx.cfg = { ...s.ctx.cfg, AUTHENTIK_RECOVERY_FLOW: 'other-recovery' };
    await checkLoginFlows(s.ctx);
    expect(s.calls.length).toBeGreaterThan(n);
  });
});

describe('checkLoginFlows: service token and executor diagnostics (the 502 on /auth/flow/start)', () => {
  it('a token Authentik refuses: token:invalid, never "unreachable" and no missing-flow or permission noise', async () => {
    const r = await checkLoginFlows(setup({ tokenInvalid: true }).ctx);
    expect(r.serviceToken).toEqual({ token: 'invalid', missing: [] });
    expect(r.unreachable).toBe(false);
    expect(r.warnings).toEqual(['token:invalid']);
    expect(r.executor).toEqual({ ok: true }); // the sign-in itself needs no token
  });

  it('a service account without some read permissions: one permission warning each (the provider and validate reads keep their own codes)', async () => {
    const r = await checkLoginFlows(setup({ missingPerms: ['view_user', 'view_totpdevice', 'view_oauth2provider'] }).ctx);
    expect(r.serviceToken).toEqual({ token: 'ok', missing: ['view_user', 'view_totpdevice', 'view_oauth2provider'] });
    expect(r.warnings).toEqual(['permission:view_user', 'permission:view_totpdevice', 'permission:provider']);
  });

  it.each([
    ['an HTML page from a proxy', { raw: '<html>blocked</html>', type: 'text/html' }, 'non_json', 200],
    ['a 403 from a WAF', { status: 403, raw: '<html>no</html>', type: 'text/html' }, 'permission', 403],
    ['a redirect to https', { status: 301, raw: '', type: 'text/html' }, 'redirect', 301],
    ['a 500', { status: 500, json: { detail: 'x' } }, 'http_error', 500],
  ] as const)('the login flow executor fails from the server (%s): executor:<class> with status and endpoint, kept for 24 h', async (_n, answer, cls, status) => {
    const { ctx } = setup({ executor: answer as ReturnType<Handler> });
    const r = await checkLoginFlows(ctx);
    expect(r.executor).toEqual({ ok: false, cls, status, endpoint: 'api/v3/flows/executor/default-authentication-flow/' });
    expect(r.warnings).toContain(`executor:${cls}`);
    expect(await lastAkFailures(ctx)).toEqual([expect.objectContaining({ area: 'executor', cls, status, endpoint: 'api/v3/flows/executor/default-authentication-flow/' })]);
    expect(r.lastFailures).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('ak-fake-token-0001');
  });

  it('a failing check is cached briefly only, and `fresh` skips the cache', async () => {
    const { ctx, calls } = setup({ tokenInvalid: true });
    await checkLoginFlows(ctx);
    const n = calls.length;
    await checkLoginFlows(ctx);
    expect(calls.length).toBe(n); // cached
    await checkLoginFlows(ctx, { fresh: true });
    expect(calls.length).toBeGreaterThan(n);
  });
});
