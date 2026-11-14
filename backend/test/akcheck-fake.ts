// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { checkLoginFlows } from '../src/flowCheck.js';
import { MemoryKV } from '../src/kv.js';
import { cfg, fakeHttp, type Call, type Handler } from './helpers.js';

/** A fake Authentik API for the sign-in status check (flow-check.test.ts, syscheck-signin.test.ts): fictional hosts, fake token. */
export const MODEL = {
  ident: 'authentik_stages_identification.identificationstage', password: 'authentik_stages_password.passwordstage',
  validate: 'authentik_stages_authenticator_validate.authenticatorvalidatestage', login: 'authentik_stages_user_login.userloginstage',
  email: 'authentik_stages_email.emailstage', prompt: 'authentik_stages_prompt.promptstage', consent: 'authentik_stages_consent.consentstage',
  captcha: 'authentik_stages_captcha.captchastage', logout: 'authentik_stages_user_logout.userlogoutstage',
  write: 'authentik_stages_user_write.userwritestage',
};
export const OK_STAGES: Record<string, string[]> = {
  'default-authentication-flow': [MODEL.ident, MODEL.password, MODEL.validate, MODEL.login],
  'default-recovery-flow': [MODEL.ident, MODEL.email, MODEL.prompt],
  'default-invalidation-flow': [MODEL.logout],
  'default-authenticator-totp-setup': [MODEL.prompt],
  'default-authenticator-static-setup': [MODEL.prompt],
  'default-authenticator-webauthn-setup': [MODEL.prompt],
  'default-password-change': [MODEL.prompt],
  'friendflix-email-change': [MODEL.prompt, MODEL.email, MODEL.write],
  'default-provider-authorization-implicit-consent': [],
};

export interface Opts {
  stages?: Record<string, string[] | null>; // null = flow missing
  provider?: { grant_types?: unknown; authorization_flow_obj?: { slug: string } } | null;
  issuer?: string; // what the discovery answers
  cfgOver?: Record<string, unknown>;
  down?: boolean;
  /** the token lacks view_oauth2provider / view_authenticatorvalidatestage: Authentik answers 403 */
  providerForbidden?: boolean;
  validateForbidden?: boolean;
  /** the service token: refused by Authentik altogether, or without some read permissions (403 on their list endpoints) */
  tokenInvalid?: boolean;
  missingPerms?: string[];
  /** the login flow's executor answer (default: the identification challenge) */
  executor?: ReturnType<Handler>;
}
/** the identification stage with a WebAuthn validation stage set: Authentik sends a passkey challenge for the forwarded app host */
export const IDENT_WITH_PASSKEY = {
  component: 'ak-stage-identification', user_fields: ['username', 'email'],
  passkey_challenge: { challenge: 'fake-challenge-0021', rpId: 'friend.example.com', allowCredentials: [], userVerification: 'required', timeout: 60000 },
};
export const PERM_PATHS: Record<string, string> = {
  view_user: '/api/v3/core/users/', view_flow: '/api/v3/flows/instances/', view_flowstagebinding: '/api/v3/flows/bindings/',
  view_emailstage: '/api/v3/stages/email/', view_invitation: '/api/v3/stages/invitation/invitations/', view_totpdevice: '/api/v3/authenticators/admin/totp/',
  view_staticdevice: '/api/v3/authenticators/admin/static/', view_webauthndevice: '/api/v3/authenticators/admin/webauthn/',
  view_authenticatorvalidatestage: '/api/v3/stages/authenticator/validate/', view_oauth2provider: '/api/v3/providers/oauth2/',
};
export function setup(o: Opts = {}) {
  const calls: Call[] = [];
  const stages = { ...OK_STAGES, ...o.stages };
  const denied = new Set(o.missingPerms ?? []);
  const perm = (name: string): ReturnType<Handler> => (denied.has(name) ? { status: 403, json: { detail: 'You do not have permission to perform this action.' } } : undefined);
  const lists: Record<string, Handler> = Object.fromEntries(Object.entries(PERM_PATHS)
    .filter(([n]) => !['view_flowstagebinding', 'view_oauth2provider'].includes(n))
    .map(([n, path]) => [`GET ${path}`, () => perm(n) ?? { json: { pagination: { next: 0 }, results: [] } }]));
  const routes: Record<string, Handler> = {
    ...lists,
    'GET /api/v3/core/users/me/': () => (o.tokenInvalid ? { status: 403, json: { detail: 'Token invalid/expired' } } : { json: { user: { pk: 9, username: 'friendflix-invites' } } }),
    'GET /api/v3/flows/executor/default-authentication-flow/': () => o.executor ?? { json: IDENT_WITH_PASSKEY },
    'GET /api/v3/flows/instances/[^/]+/': (u) => {
      const slug = decodeURIComponent(u.pathname.split('/')[5]!);
      return stages[slug] ? { json: { pk: `pk-${slug}`, slug } } : { status: 404, json: { detail: 'no' } };
    },
    'GET /api/v3/flows/bindings/': (u) => {
      if (denied.has('view_flowstagebinding')) return perm('view_flowstagebinding');
      if (!u.searchParams.get('target')) return { json: { pagination: { next: 0 }, results: [] } };
      const slug = (u.searchParams.get('target') ?? '').replace(/^pk-/, '');
      return { json: { pagination: { next: 0 }, results: (stages[slug] ?? []).map((m, i) => ({ order: i * 10, stage: `s${i}`, stage_obj: { component: `ak-stage-${i}-form`, meta_model_name: m } })) } };
    },
    'GET /api/v3/stages/authenticator/validate/[^/]+/': () => (o.validateForbidden ? { status: 403, json: { detail: 'no' } } : { json: { not_configured_action: 'configure' } }),
    'GET /api/v3/providers/oauth2/': () => (o.providerForbidden || denied.has('view_oauth2provider') ? { status: 403, json: { detail: 'no' } } : {
      json: { pagination: { next: 0 }, results: o.provider === null ? [] : [{ authorization_flow_obj: { slug: 'default-provider-authorization-implicit-consent' }, grant_types: ['authorization_code', 'refresh_token'], ...o.provider }] },
    }),
    'GET /application/o/friendflix/.well-known/openid-configuration': () => ({ json: { issuer: o.issuer ?? 'https://friend.example.com/application/o/friendflix/' } }),
  };
  const inner = fakeHttp(routes, calls);
  const fetchImpl = (o.down ? async () => { throw new Error('boom'); } : o.tokenInvalid ? (async (input: RequestInfo | URL, init?: RequestInit) => {
    // a refused token: every API call with it answers 403 (the executor and discovery need no token)
    const u = new URL(String(input));
    if (u.pathname.startsWith('/api/v3/') && !u.pathname.startsWith('/api/v3/flows/executor/')) {
      calls.push({ method: 'GET', path: u.pathname, search: u.search, body: undefined });
      return new Response(JSON.stringify({ detail: 'Token invalid/expired' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    return inner(input, init);
  }) : inner) as typeof fetch;
  const ctx = {
    cfg: {
      ...cfg, AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 'ak-fake-token-0001', OIDC_ISSUER: 'https://auth.example.com/application/o/friendflix/',
      OIDC_CLIENT_ID: 'friendflix', PUBLIC_URL: 'https://friend.example.com', LOGIN_UI: undefined, AUTHENTIK_ENROLL_FLOW: undefined, ...o.cfgOver,
    },
    kv: new MemoryKV(), db: null, fetchImpl,
  } as unknown as Parameters<typeof checkLoginFlows>[0];
  return { ctx, calls };
}
