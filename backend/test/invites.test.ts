// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../src/crypto.js';
import { DEFAULT_ROLES, invalidateRoles } from '../src/roles.js';
import { claimInvite, releaseInvite } from '../src/invites.js';
import { deleteRole, syncRoles } from '../src/rolecat.js';
import { provisionUser } from '../src/users.js';

// the sign-in path calls the real provisionUser; a test can run a step (a role delete) just before it, after the invite was claimed
const hook: { before?: () => Promise<void> } = {};
vi.mock('../src/users.js', async (orig) => {
  const real = await orig<typeof import('../src/users.js')>();
  return { ...real, provisionUser: vi.fn(async (...a: Parameters<typeof real.provisionUser>) => { await hook.before?.(); return real.provisionUser(...a); }) };
});
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const AK = { AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 't', AUTHENTIK_ENROLL_FLOW: 'enroll' };
const FLOW_PK = '0f3c9a4e-0000-4000-8000-000000000001';

/** Fake Authentik API; `ak.mode` switches the failure path under test. */
const ak = {
  mode: 'ok' as 'ok' | 'flow404' | 'forbidden' | 'down',
  calls: [] as Array<{ method: string; url: string; auth: string | null; body: any }>,
};
const akFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  ak.calls.push({ method, url, auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : undefined });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (ak.mode === 'down') throw new TypeError('fetch failed');
  if (method === 'GET' && url === 'https://auth.example.com/api/v3/flows/instances/enroll/') {
    return ak.mode === 'flow404' ? json({ detail: 'No Flow matches the given query.' }, 404) : json({ pk: FLOW_PK, slug: 'enroll' });
  }
  if (method === 'POST' && url === 'https://auth.example.com/api/v3/stages/invitation/invitations/') {
    return ak.mode === 'forbidden' ? json({ detail: 'You do not have permission to perform this action.' }, 403) : json({ pk: 'ak-inv-1', name: 'x' }, 201);
  }
  if (method === 'DELETE' && url.startsWith('https://auth.example.com/api/v3/stages/invitation/invitations/')) return new Response(null, { status: 204 });
  return json({ detail: 'not found' }, 404);
}) as unknown as typeof fetch;

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
beforeAll(async () => {
  env = await makeEnv({}, {
    ctxPatch: (c) => {
      c.fetchImpl = akFetch;
      c.cfg = { ...cfg, ...AK };
      // realistic authorize request on the Authentik host (path + query becomes the enrollment `next`)
      c.oidc.start = async () => {
        const state = 's' + Math.random().toString(36).slice(2);
        return { url: `https://auth.example.com/application/o/authorize/?client_id=ff&response_type=code&state=${state}`, state, nonce: 'n', codeVerifier: 'v' };
      };
    },
  });
  admin = await env.login();
});
beforeEach(() => { ak.mode = 'ok'; ak.calls.length = 0; });
afterAll(() => env.close());

const adm = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });

async function inviteLogin(token: string | undefined, sub: string, headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  env.claims.current = { sub, email: `${sub}@x.de`, name: `Freund ${sub}`, groups: [] };
  // the classic redirect login (the Authentik API is configured here, so plain /auth/login leads to the in-app /login)
  const l = await env.app.inject(`/auth/login?classic=1${token ? `&invite=${token}` : ''}`);
  if (l.statusCode !== 302) return l;
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  return env.app.inject({ url: `/auth/callback?state=${st}&code=c`, headers, cookies: { ...cookies, ff_oidc: st } });
}

describe('invites', () => {
  it('only admins can create invites; token is stored hashed', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24, note: 'Max' });
    expect(r.statusCode).toBe(200);
    const inv = r.json();
    expect(inv.link).toMatch(/^https:\/\/portal\.example\.com\/invite\/[\w-]{30,}$/);
    const token = inv.link.split('/').pop();
    expect(inv.authentik).toBe('ok');
    expect(inv.enrollUrl).toBe(`https://portal.example.com/auth/enroll?invite=${token}`);
    const row = (await env.pool.query('select token_hash from invites')).rows[0];
    expect(row.token_hash).not.toContain(token);
    await expect(env.app.inject({ method: 'POST', url: '/api/admin/invites', payload: { role: 'friend' } })).resolves.toMatchObject({ statusCode: 401 });
  });

  it('invite info is public but reveals nothing for invalid tokens', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'guest', ttlHours: 1 })).json().link.split('/').pop();
    const ok = await env.app.inject(`/api/invite/${token}`);
    expect(ok.json()).toMatchObject({ role: 'guest', roleLabel: 'Gast' });
    expect((await env.app.inject('/api/invite/' + 'x'.repeat(30))).statusCode).toBe(404);
  });

  it('redeeming creates user + jellyfin account with role policy and is single use', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'guest', ttlHours: 1 })).json().link.split('/').pop();
    env.jfCalls.length = 0;
    const cb = await inviteLogin(token, 'guest1');
    expect(cb.statusCode).toBe(302);
    const u = (await env.pool.query("select * from users where authentik_sub='guest1'")).rows[0];
    expect(u.role).toBe('guest');
    const pol = env.jfCalls.filter((c) => c.path.endsWith('/Policy')).at(-1)!.body;
    expect(pol).toMatchObject({ MaxParentalRating: 12, EnableVideoPlaybackTranscoding: true, MaxActiveSessions: 1, RemoteClientBitrateLimit: 8_000_000, EnableContentDownloading: false });
    // second use fails
    expect((await inviteLogin(token, 'guest2')).statusCode).toBe(410);
    expect((await env.pool.query("select 1 from users where authentik_sub='guest2'")).rowCount).toBe(0);
    const inv = (await adm('GET', '/api/admin/invites')).json().invites.find((i: any) => i.used_by_name);
    expect(inv.used_by_name).toBe('Freund guest1');
  });

  it('expired invites are rejected and unknown users without an invite wait for approval', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    await env.pool.query("update invites set expires_at = now() - interval '1 minute' where used_at is null");
    expect((await inviteLogin(token, 'late')).statusCode).toBe(410);
    const cb = await inviteLogin(undefined, 'noinvite');
    expect([cb.statusCode, cb.headers.location]).toEqual([302, '/pending']);
    expect((await env.pool.query("select 1 from users where authentik_sub='noinvite'")).rowCount).toBe(0);
  });

  it('a failed provisioning releases the invite', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const orig = env.ctx.jf.admin.createIdentity;
    env.ctx.jf.admin.createIdentity = async () => { throw new Error('jellyfin down'); };
    expect((await inviteLogin(token, 'f1')).statusCode).toBe(401);
    env.ctx.jf.admin.createIdentity = orig;
    expect((await inviteLogin(token, 'f1')).statusCode).toBe(302);
  });

  it('creates a single-use Authentik invitation bound to the enrollment flow', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24 });
    expect(r.json().authentik).toBe('ok');
    expect(ak.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://auth.example.com/api/v3/flows/instances/enroll/',
      'POST https://auth.example.com/api/v3/stages/invitation/invitations/',
    ]);
    const post = ak.calls[1]!;
    expect(post.auth).toBe('Bearer t');
    expect(post.body).toMatchObject({ single_use: false, flow: FLOW_PK, fixed_data: {} });
    expect(post.body.name).toMatch(/^ff-[a-z0-9]+$/); // Authentik validates the name as a slug
    expect(Math.abs(new Date(post.body.expires).getTime() - new Date(r.json().expiresAt).getTime())).toBeLessThan(1000);
  });

  it('enrollment link: portal login -> Authentik enrollment -> authorize -> callback, one pass', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'family', ttlHours: 24 })).json().link.split('/').pop();
    // in-app sign-in (LOGIN_UI app): the invite page links to the app's own sign-up; otherwise to /auth/enroll (preflight T8-a)
    expect((await env.app.inject(`/api/invite/${token}`)).json().enrollUrl).toBe(`/login?invite=${token}&enroll=1`);
    const before = env.ctx.cfg;
    env.ctx.cfg = { ...before, LOGIN_UI: 'authentik' };
    try {
      expect((await env.app.inject(`/api/invite/${token}`)).json().enrollUrl).toBe(`/auth/enroll?invite=${token}`);
    } finally {
      env.ctx.cfg = before;
    }

    // in-app sign-in (LOGIN_UI app): the button leads to the app's own enrolment screens
    expect((await env.app.inject(`/auth/enroll?invite=${token}`)).headers.location).toBe(`/login?invite=${token}&enroll=1`);
    // 1. invite page button (classic) -> portal starts the OIDC login and hands over to the enrollment flow
    const e = await env.app.inject(`/auth/enroll?invite=${token}&classic=1`);
    expect(e.statusCode).toBe(302);
    const loc = new URL(e.headers.location as string);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://auth.example.com/if/flow/enroll/');
    expect(loc.searchParams.get('itoken')).toBe('ak-inv-1');
    const cookie = e.cookies.find((c) => c.name === 'ff_oidc')!;
    expect(cookie.maxAge).toBe(1800); // enough time for sign-up + MFA setup
    // 2. Authentik only follows a relative `next`: the authorize request the portal just started
    const next = loc.searchParams.get('next')!;
    expect(next.startsWith('/application/o/authorize/?')).toBe(true);
    expect(new URLSearchParams(next.split('?')[1]).get('state')).toBe(cookie.value);

    // 3. after enrollment Authentik continues `next` and redirects to /auth/callback (same browser)
    env.claims.current = { sub: 'enrolled1', email: 'e1@x.de', name: 'Neu Eins', groups: [] };
    const cb = await env.app.inject({ url: `/auth/callback?state=${cookie.value}&code=c`, cookies: { ff_oidc: cookie.value } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
    expect(cb.cookies.find((c) => c.name === 'ff_sid')).toBeTruthy();
    const u = (await env.pool.query("select role from users where authentik_sub='enrolled1'")).rows[0];
    expect(u.role).toBe('family');
    expect((await env.app.inject(`/auth/enroll?invite=${token}`)).statusCode).toBe(410); // used up
  });

  it('enrollment callback needs an auth_time from after the start: a leftover IdP session of an existing account gets no session through an invite', async () => {
    const mkToken = async () => (await adm('POST', '/api/admin/invites', { role: 'family', ttlHours: 24 })).json().link.split('/').pop() as string;
    const token = await mkToken();
    const sub = 'sub-admin'; // an existing account
    const run = async (offsetS: number | undefined) => {
      const e = await env.app.inject(`/auth/enroll?invite=${token}&classic=1`);
      const state = e.cookies.find((c) => c.name === 'ff_oidc')!.value;
      const saved = JSON.parse((await env.kv.get(`oidc:${state}`))!);
      expect(saved.enroll).toBe(true);
      expect(typeof saved.startedAt).toBe('number');
      const authTime = offsetS === undefined ? undefined : Math.floor(saved.startedAt / 1000) + offsetS;
      env.claims.current = { sub, email: 'admin@example.com', name: 'Admin', groups: ['friendflix-admins'], authTime } as typeof env.claims.current;
      return env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ff_oidc: state } });
    };
    for (const off of [-3600, -31, undefined]) {
      const cb = await run(off);
      expect([cb.statusCode, cb.headers.location]).toEqual([302, `/login?stale=1&invite=${token}`]);
      expect(cb.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    }
    // an auth_time from after the start (the enrollment flow's own login) passes
    const ok = await run(5);
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).not.toMatch(/stale/);
    expect(ok.cookies.find((c) => c.name === 'ff_sid')).toBeTruthy();
  });

  it('a stale sign-in keeps the invite for the retry', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'family', ttlHours: 24, enroll: false })).json().link.split('/').pop() as string;
    const l = await env.app.inject(`/auth/login?invite=${token}&classic=1`);
    const st = l.cookies.find((c) => c.name === 'ff_oidc')!.value;
    const saved = JSON.parse((await env.kv.get(`oidc:${st}`))!);
    env.claims.current = { ...env.claims.current, authTime: Math.floor(saved.startedAt / 1000) - 3600 } as typeof env.claims.current;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
    expect([cb.statusCode, cb.headers.location]).toEqual([302, `/login?stale=1&invite=${token}`]);
  });

  it('invite for an existing Authentik user skips enrollment', async () => {
    const r = (await adm('POST', '/api/admin/invites', { role: 'guest', ttlHours: 1, enroll: false })).json();
    expect(r.authentik).toBe('skipped');
    expect(r.enrollUrl).toBeUndefined();
    expect(ak.calls).toHaveLength(0);
    const token = r.link.split('/').pop();
    expect((await env.app.inject(`/api/invite/${token}`)).json().enrollUrl).toBeUndefined();
    const e = await env.app.inject(`/auth/enroll?invite=${token}`);
    expect(e.statusCode).toBe(302);
    expect(e.headers.location).toBe(`/auth/login?invite=${token}`);
    expect((await env.app.inject('/auth/enroll?invite=' + 'x'.repeat(30))).statusCode).toBe(410);
  });

  it('Authentik failures are logged and fall back to a portal-only invite', async () => {
    const { createInvite } = await import('../src/invites.js');
    const user = (await env.pool.query("select id from users where role='admin' limit 1")).rows[0].id;
    const run = async (mode: typeof ak.mode, c = env.ctx) => {
      ak.mode = mode; ak.calls.length = 0;
      const warnings: string[] = [];
      const inv = await createInvite(c, user, { role: 'friend', ttlHours: 1 }, { warn: (_o, msg) => warnings.push(msg) });
      return { inv, warnings };
    };

    const forbidden = await run('forbidden');
    expect(forbidden.inv).toMatchObject({ authentik: 'failed', enrollUrl: undefined });
    expect(forbidden.warnings.join()).toMatch(/invitation creation failed.*Can add Invitation/);

    const flow404 = await run('flow404');
    expect(flow404.inv.authentik).toBe('failed');
    expect(flow404.warnings.join()).toMatch(/enrollment flow "enroll" not found/);
    expect(ak.calls.filter((x) => x.method === 'POST')).toHaveLength(0);

    const down = await run('down');
    expect(down.inv.authentik).toBe('failed');
    expect(down.warnings.join()).toMatch(/Authentik unreachable/);

    const partial = await run('ok', { ...env.ctx, cfg: { ...env.ctx.cfg, AUTHENTIK_API_TOKEN: undefined } });
    expect(partial.inv.authentik).toBe('off');
    expect(partial.warnings.join()).toMatch(/AUTHENTIK_API_TOKEN not set/);
    expect(ak.calls).toHaveLength(0);

    // the portal invite still works for someone with an existing Authentik account
    expect((await env.app.inject(`/api/invite/${forbidden.inv.token}`)).json().enrollUrl).toBeUndefined();
    expect((await inviteLogin(forbidden.inv.token, 'fallback1')).statusCode).toBe(302);
  });

  it('concurrent redemption only succeeds once', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const { claimInvite } = await import('../src/invites.js');
    const res = await Promise.all([claimInvite(env.ctx, token), claimInvite(env.ctx, token), claimInvite(env.ctx, token)]);
    expect(res.filter(Boolean)).toHaveLength(1);
  });
});

describe('multi-use invites', () => {
  const tokenOf = (inv: { link: string }) => inv.link.split('/').pop()!;

  it('an invite with maxUses 2 is claimable twice, the third claim fails', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24, maxUses: 2, note: 'Paar' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ uses: 0, maxUses: 2 });
    const token = tokenOf(r.json());
    ak.calls.length = 0;
    expect((await inviteLogin(token, 'multi-1')).statusCode).toBe(302);
    // not used up yet: the Authentik invitation must stay for the second person
    await new Promise((res) => setTimeout(res, 20));
    expect(ak.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect((await env.app.inject(`/api/invite/${token}`)).statusCode).toBe(200);
    expect((await inviteLogin(token, 'multi-2')).statusCode).toBe(302);
    await vi.waitFor(() => expect(ak.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)); // used up: deleted
    const third = await inviteLogin(token, 'multi-3');
    expect(third.statusCode).toBe(410);
    expect((await env.pool.query("select 1 from users where authentik_sub='multi-3'")).rowCount).toBe(0);

    const row = (await env.pool.query('select uses, max_uses, used_at, used_by from invites where id=$1', [r.json().id])).rows[0];
    const first = (await env.pool.query("select id from users where authentik_sub='multi-1'")).rows[0].id;
    expect(row).toMatchObject({ uses: 2, max_uses: 2, used_by: first });
    expect(row.used_at).toBeInstanceOf(Date);
    const uses = (await adm('GET', `/api/admin/invites/${r.json().id}/uses`)).json().uses;
    expect(uses.map((u: any) => u.name)).toEqual(['Freund multi-1', 'Freund multi-2']);
    const listed = (await adm('GET', '/api/admin/invites?status=used')).json().invites.find((i: any) => i.id === r.json().id);
    expect(listed).toMatchObject({ uses: 2, max_uses: 2 });
  });

  it('two parallel claims of the last use: exactly one succeeds', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1, maxUses: 2 })).json();
    const { claimInvite } = await import('../src/invites.js');
    expect(await claimInvite(env.ctx, tokenOf(inv))).toBeTruthy();
    const res = await Promise.all([claimInvite(env.ctx, tokenOf(inv)), claimInvite(env.ctx, tokenOf(inv))]);
    expect(res.filter(Boolean)).toHaveLength(1);
    expect((await env.pool.query('select uses from invites where id=$1', [inv.id])).rows[0].uses).toBe(2);
  });

  it('accessDays sets access_until on the new account', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1, accessDays: 30 })).json();
    expect((await inviteLogin(tokenOf(inv), 'days-1')).statusCode).toBe(302);
    const u = (await env.pool.query("select access_until from users where authentik_sub='days-1'")).rows[0];
    expect(Math.abs(u.access_until.getTime() - (Date.now() + 30 * 86400_000))).toBeLessThan(60_000);
    // without accessDays the account has no end
    const open = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1, accessDays: null })).json();
    expect((await inviteLogin(tokenOf(open), 'days-2')).statusCode).toBe(302);
    expect((await env.pool.query("select access_until from users where authentik_sub='days-2'")).rows[0].access_until).toBeNull();
    // bounds
    for (const bad of [{ maxUses: 0 }, { maxUses: 51 }, { accessDays: 0 }, { accessDays: 3651 }]) {
      expect((await adm('POST', '/api/admin/invites', { role: 'friend', ...bad })).statusCode).toBe(400);
    }
  });

  it('release returns the use', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1, maxUses: 2 })).json();
    const { claimInvite, releaseInvite } = await import('../src/invites.js');
    expect((await inviteLogin(tokenOf(inv), 'rel-1')).statusCode).toBe(302);
    const user = (await env.pool.query("select id from users where authentik_sub='rel-1'")).rows[0].id;
    const c = await claimInvite(env.ctx, tokenOf(inv));
    expect(c).toBeTruthy();
    expect(await claimInvite(env.ctx, tokenOf(inv))).toBeNull(); // used up
    await releaseInvite(env.ctx, c!.id);
    let row = (await env.pool.query('select uses, used_by from invites where id=$1', [inv.id])).rows[0];
    expect(row).toEqual({ uses: 1, used_by: user }); // the first use stays recorded
    // releasing a recorded use also removes its invite_uses row; the last release reopens the invite completely
    await releaseInvite(env.ctx, inv.id, user);
    row = (await env.pool.query('select uses, used_at, used_by from invites where id=$1', [inv.id])).rows[0];
    expect(row).toEqual({ uses: 0, used_at: null, used_by: null });
    expect((await env.pool.query('select 1 from invite_uses where invite_id=$1', [inv.id])).rowCount).toBe(0);
    expect(await claimInvite(env.ctx, tokenOf(inv))).toBeTruthy();
  });

  it('revoking a partly used invite closes it and keeps its history', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24, maxUses: 3 })).json();
    expect((await inviteLogin(tokenOf(inv), 'revoke-1')).statusCode).toBe(302);
    ak.calls.length = 0;
    expect((await adm('DELETE', `/api/admin/invites/${inv.id}`)).statusCode).toBe(200);
    expect(ak.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect((await env.pool.query('select uses, max_uses from invites where id=$1', [inv.id])).rows[0]).toEqual({ uses: 1, max_uses: 1 });
    expect((await env.app.inject(`/api/invite/${tokenOf(inv)}`)).statusCode).toBe(404);
    expect((await adm('GET', `/api/admin/invites/${inv.id}/uses`)).json().uses).toHaveLength(1);
    expect((await adm('GET', '/api/admin/invites/00000000-0000-4000-8000-000000000000/uses')).statusCode).toBe(404);
  });
});

describe('devices', () => {
  it('first device is trusted, second needs approval, approval unlocks the pending session', async () => {
    const u1 = await inviteLogin((await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop(), 'dev-user');
    const c1 = Object.fromEntries(u1.cookies.map((c) => [c.name, c.value]));
    expect((await env.app.inject({ url: '/api/library/views', cookies: c1 })).statusCode).not.toBe(403);

    // login again from another browser (no ff_dev cookie)
    const u2 = await inviteLogin(undefined, 'dev-user');
    const c2 = Object.fromEntries(u2.cookies.map((c) => [c.name, c.value]));
    expect(c2.ff_dev).not.toBe(c1.ff_dev);
    const me2 = await env.app.inject({ url: '/api/me', cookies: c2 });
    expect(me2.json().deviceApproved).toBe(false);
    expect((await env.app.inject({ url: '/api/library/views', cookies: c2 })).json()).toEqual({ error: 'device_pending' });
    // gateway authz also refuses the pending session
    const authz = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid: c2.ff_sid } });
    expect(authz.statusCode).toBe(401);

    // the user is told about the waiting device (bell notification linking to the approval list)
    const note = (await env.pool.query("select link, title from notifications where kind='device_pending' order by id desc limit 1")).rows[0];
    expect(note).toMatchObject({ link: '/devices' });

    // approve from the first device
    const me1 = (await env.app.inject({ url: '/api/me', cookies: c1 })).json();
    const list = (await env.app.inject({ url: '/api/devices', cookies: c1 })).json().devices;
    const pending = list.find((d: any) => !d.approved);
    const ap = await env.app.inject({ method: 'POST', url: `/api/devices/${pending.id}/approve`, cookies: c1, headers: { 'x-csrf-token': me1.csrfToken } });
    expect(ap.statusCode).toBe(200);
    // the waiting screen only polls /api/me: it must see the approval without any other request first
    expect((await env.app.inject({ url: '/api/me', cookies: c2 })).json().deviceApproved).toBe(true);
    expect((await env.app.inject({ url: '/api/library/views', cookies: c2 })).statusCode).not.toBe(403);
  });
});

describe('admin user management', () => {
  it('role change re-applies the jellyfin policy; disabling blocks and revokes sessions', async () => {
    const sub = 'managed';
    const u = await inviteLogin((await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop(), sub);
    const c = Object.fromEntries(u.cookies.map((x) => [x.name, x.value]));
    const row = (await env.pool.query('select id from users where authentik_sub=$1', [sub])).rows[0];
    env.jfCalls.length = 0;
    expect((await adm('PATCH', `/api/admin/users/${row.id}`, { role: 'family' })).statusCode).toBe(200);
    expect(env.jfCalls.filter((x) => x.path.endsWith('/Policy')).at(-1)!.body).toMatchObject({ EnableContentDownloading: true, MaxActiveSessions: 4 });
    expect((await adm('PATCH', `/api/admin/users/${row.id}`, { disabled: true })).statusCode).toBe(200);
    expect(env.jfCalls.filter((x) => x.path.endsWith('/Policy')).at(-1)!.body).toMatchObject({ IsDisabled: true });
    expect((await env.app.inject({ url: '/api/me', cookies: c })).statusCode).toBe(401);
    const audit = (await adm('GET', '/api/admin/audit')).json().entries.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['user.role', 'user.disable', 'invite.create', 'user.provisioned']));
  });
  it('non-admins are forbidden; admins cannot lock themselves out', async () => {
    const me = (await adm('GET', '/api/admin/users')).json().users.find((x: any) => x.role === 'admin');
    expect((await adm('PATCH', `/api/admin/users/${me.id}`, { disabled: true })).statusCode).toBe(400);
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const u = await inviteLogin(token, 'plain');
    const c = Object.fromEntries(u.cookies.map((x) => [x.name, x.value]));
    expect((await env.app.inject({ url: '/api/admin/users', cookies: c })).statusCode).toBe(403);
  });

  it('the Authentik invitation is reusable until the portal invite is redeemed, then deleted', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24 })).json();
    expect(ak.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ single_use: false });
    ak.calls.length = 0;
    const token = inv.link.split('/').pop();
    expect((await inviteLogin(token, 'reuse-1')).statusCode).toBe(302);
    await vi.waitFor(() => expect(ak.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)); // deletion is fire-and-forget
    expect(ak.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['https://auth.example.com/api/v3/stages/invitation/invitations/ak-inv-1/']);
  });
  it('revoking an invite deletes its Authentik invitation', async () => {
    const inv = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24 })).json();
    ak.calls.length = 0;
    expect((await adm('DELETE', `/api/admin/invites/${inv.id}`)).statusCode).toBe(200);
    expect(ak.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
  it('a claim taken before the delete ends on the target role, and a released invite carries it', async () => {
    const key = (await adm('POST', '/api/admin/roles', { label: 'Mitte', from: 'friend' })).json().key as string;
    const token = 'claimed-before-delete-token-0123456789abcdef';
    await env.pool.query("insert into invites(id, token_hash, role, expires_at, max_uses) values (gen_random_uuid(), $1, $2, now() + interval '1 hour', 1)", [sha256(token), key]);
    const claimed = (await claimInvite(env.ctx, token))!;
    expect(claimed.role).toBe(key);
    expect((await adm('DELETE', `/api/admin/roles/${key}`, { moveTo: 'guest' })).statusCode).toBe(200);
    expect((await env.pool.query('select role from invites where id=$1', [claimed.id])).rows).toEqual([{ role: 'guest' }]);
    // provisioning with the stale role of the claim: the invite's current role wins
    const user = await provisionUser(env.ctx, { sub: 'claimed1', email: 'c1@x.de', name: 'Freund c1', groups: [] }, claimed.role, null, undefined, claimed.id);
    expect(user.role).toBe('guest');
    await releaseInvite(env.ctx, claimed.id);
    expect((await env.pool.query('select role, uses from invites where id=$1', [claimed.id])).rows).toEqual([{ role: 'guest', uses: 0 }]);
  });

  it('a delete between provisioning steps cannot leave the account on the deleted role', async () => {
    const key = (await adm('POST', '/api/admin/roles', { label: 'Mitte2', from: 'friend' })).json().key as string;
    const token = 'claimed-during-provision-token-0123456789ab';
    await env.pool.query("insert into invites(id, token_hash, role, expires_at, max_uses) values (gen_random_uuid(), $1, $2, now() + interval '1 hour', 1)", [sha256(token), key]);
    const claimed = (await claimInvite(env.ctx, token))!;
    // the delete holds the role lock exclusively and has moved the invite when the redemption reaches its insert
    const c = await env.pool.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`role:${key}`]);
      const p = provisionUser(env.ctx, { sub: 'claimed2', email: 'c2@x.de', name: 'Freund c2', groups: [] }, claimed.role, null, undefined, claimed.id);
      await new Promise((r) => setTimeout(r, 400));
      await c.query('update invites set role=$2 where id=$1', [claimed.id, 'guest']);
      await c.query('commit');
      expect((await p).role).toBe('guest');
    } finally {
      c.release();
    }
  });

  const mkInvite = async (label: string, from: string, token: string) => {
    const key = (await adm('POST', '/api/admin/roles', { label, from })).json().key as string;
    await env.pool.query("insert into invites(id, token_hash, role, expires_at, max_uses) values (gen_random_uuid(), $1, $2, now() + interval '1 hour', 1)", [sha256(token), key]);
    return key;
  };

  it('a delete without a target moves the claimed and the used-up invites to the base role', async () => {
    const key = await mkInvite('Ohne Ziel', 'family', 'no-target-claimed-token-0123456789abcdef');
    const claimed = (await claimInvite(env.ctx, 'no-target-claimed-token-0123456789abcdef'))!;
    await env.pool.query("insert into invites(id, token_hash, role, expires_at, max_uses, uses) values (gen_random_uuid(), 'x-used', $1, now() + interval '1 hour', 1, 1)", [key]);
    const r = await adm('DELETE', `/api/admin/roles/${key}`);
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true, accounts: 0, invites: 0 }]);
    expect((await env.pool.query("select role from invites where token_hash in ($1, 'x-used')", [sha256('no-target-claimed-token-0123456789abcdef')])).rows.map((x) => x.role)).toEqual(['family', 'family']);
    const user = await provisionUser(env.ctx, { sub: 'notarget1', email: 'n1@x.de', name: 'Freund n1', groups: [] }, claimed.role, null, undefined, claimed.id);
    expect(user.role).toBe('family');
    await releaseInvite(env.ctx, claimed.id);
    expect((await env.pool.query('select role, uses from invites where id=$1', [claimed.id])).rows).toEqual([{ role: 'family', uses: 0 }]);
    await env.pool.query("delete from invites where token_hash='x-used'");
  });

  it('a second delete during one redemption (T to U) still ends on an existing role', async () => {
    const t = await mkInvite('Erste', 'friend', 'double-delete-token-0123456789abcdefghij');
    const u = (await adm('POST', '/api/admin/roles', { label: 'Zweite', from: 'friend' })).json().key as string;
    const claimed = (await claimInvite(env.ctx, 'double-delete-token-0123456789abcdefghij'))!;
    const [c1, c2] = [await env.pool.connect(), await env.pool.connect()];
    try {
      for (const [c, k] of [[c1, t], [c2, u]] as const) {
        await c.query('begin');
        await c.query('select pg_advisory_xact_lock(hashtext($1))', [`role:${k}`]);
      }
      const p = provisionUser(env.ctx, { sub: 'double1', email: 'd1@x.de', name: 'Freund d1', groups: [] }, claimed.role, null, undefined, claimed.id);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('update invites set role=$2 where id=$1', [claimed.id, u]);
      await c1.query('delete from role_settings where role=$1', [t]);
      await c1.query('delete from roles where key=$1', [t]);
      await c1.query('commit');
      await new Promise((r) => setTimeout(r, 300)); // now waiting for U
      await c2.query('update invites set role=$2 where id=$1', [claimed.id, 'guest']);
      await c2.query('delete from role_settings where role=$1', [u]);
      await c2.query('delete from roles where key=$1', [u]);
      await c2.query('commit');
      expect((await p).role).toBe('guest');
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('provisioning refuses a role that no longer exists instead of inserting on it', async () => {
    const t = await mkInvite('Weg', 'friend', 'missing-role-token-0123456789abcdefghijk');
    const claimed = (await claimInvite(env.ctx, 'missing-role-token-0123456789abcdefghijk'))!;
    await env.pool.query('delete from roles where key=$1', [t]);
    invalidateRoles(env.ctx);
    await expect(provisionUser(env.ctx, { sub: 'missing1', email: 'm1@x.de', name: 'Freund m1', groups: [] }, claimed.role, null, undefined, claimed.id)).rejects.toMatchObject({ statusCode: 503 });
    expect((await env.pool.query("select 1 from users where authentik_sub='missing1'")).rowCount).toBe(0);
  });

  it('the sign-in passes the claimed invite on to provisioning: a role deleted meanwhile leaves the account on the target', async () => {
    const key = await mkInvite('Login', 'friend', 'login-level-token-0123456789abcdefghijklm');
    hook.before = async () => { await deleteRole(env.ctx, null, key, 'guest'); };
    try {
      expect((await inviteLogin('login-level-token-0123456789abcdefghijklm', 'loginlvl')).statusCode).toBe(302);
    } finally {
      hook.before = undefined;
    }
    const calls = vi.mocked(provisionUser).mock.calls;
    const inviteId = (await env.pool.query('select id from invites where token_hash=$1', [sha256('login-level-token-0123456789abcdefghijklm')])).rows[0].id;
    expect(calls.at(-1)![5]).toBe(inviteId);
    expect((await env.pool.query("select role from users where authentik_sub='loginlvl'")).rows).toEqual([{ role: 'guest' }]);
  });

  it('a delete between the first policy apply and the role lock leaves the account on the target with its policy', async () => {
    const key = await mkInvite('Schmal', 'guest', 'narrow-window-token-0123456789abcdefabcdef');
    expect((await adm('PUT', `/api/admin/roles/${key}`, { maxStreams: 7 })).statusCode).toBe(200);
    const claimed = (await claimInvite(env.ctx, 'narrow-window-token-0123456789abcdefabcdef'))!;
    const jfAdmin = env.ctx.jf.admin as unknown as { applyPolicy: (id: string, pol: { template?: { maxStreams?: number } }) => Promise<unknown> };
    const orig = jfAdmin.applyPolicy;
    const seen: Array<{ id: string; maxStreams?: number }> = [];
    let fired = false;
    jfAdmin.applyPolicy = async (id, pol) => {
      seen.push({ id, maxStreams: pol.template?.maxStreams });
      if (!fired) { fired = true; await deleteRole(env.ctx, null, key); } // commits after this first apply, before the insert transaction
      return orig.call(jfAdmin, id, pol);
    };
    let user;
    try {
      user = await provisionUser(env.ctx, { sub: 'narrow1', email: 'nw1@x.de', name: 'Freund nw1', groups: [] }, claimed.role, null, undefined, claimed.id);
    } finally {
      jfAdmin.applyPolicy = orig;
    }
    expect(user.role).toBe('guest');
    const guest = (await adm('GET', '/api/admin/roles')).json().matrix.roles.find((r: { key: string }) => r.key === 'guest').values.maxStreams;
    expect(guest).not.toBe(7);
    expect(seen.filter((x) => x.id === user.jellyfin_user_id).at(-1)!.maxStreams).toBe(guest);
  });

  it('an invite redeemed after its role was deleted gets the new role', async () => {
    const key = (await adm('POST', '/api/admin/roles', { label: 'Kino-Gast', from: 'friend' })).json().key as string;
    // an open invite for the custom role, stored directly
    const token = 'custom-role-invite-token-0123456789abcdef';
    await env.pool.query("insert into invites(id, token_hash, role, expires_at, max_uses) values (gen_random_uuid(), $1, $2, now() + interval '1 hour', 1)", [sha256(token), key]);
    expect((await adm('DELETE', `/api/admin/roles/${key}`, { moveTo: 'guest' })).statusCode).toBe(200);
    expect((await inviteLogin(token, 'moved1')).statusCode).toBe(302);
    expect((await env.pool.query("select role from users where authentik_sub='moved1'")).rows).toEqual([{ role: 'guest' }]);
  });
});

describe('invites and approvals for any invitable role', () => {
  const addOma = async () => {
    env.ctx.roles.oma = { ...DEFAULT_ROLES.friend!, label: 'Oma' };
    await syncRoles(env.ctx);
    await env.pool.query("update roles set invitable=true where key='oma'");
    invalidateRoles(env.ctx);
  };
  const setInvitable = async (v: boolean) => { await env.pool.query('update roles set invitable=$1 where key=$2', [v, 'oma']); invalidateRoles(env.ctx); };
  beforeEach(addOma);
  afterEach(async () => { await setInvitable(true); });

  it('invite for an env role: the redeemed account holds it', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'oma', ttlHours: 1 });
    expect(r.statusCode).toBe(200);
    const token = r.json().link.split('/').pop();
    expect((await inviteLogin(token, 'omauser')).statusCode).toBe(302);
    expect((await env.pool.query("select role from users where authentik_sub='omauser'")).rows).toEqual([{ role: 'oma' }]);
  });

  it('a role switched to not invitable is refused', async () => {
    await setInvitable(false);
    const r = await adm('POST', '/api/admin/invites', { role: 'oma', ttlHours: 1 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('role_not_invitable');
  });

  it('an invite created before its role was made not invitable still redeems', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'oma', ttlHours: 1 })).json().link.split('/').pop();
    await setInvitable(false);
    expect((await inviteLogin(token, 'omalate')).statusCode).toBe(302);
    expect((await env.pool.query("select role from users where authentik_sub='omalate'")).rows).toEqual([{ role: 'oma' }]);
  });

  it('admin is never invitable, approval may grant admin', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'admin', ttlHours: 1 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('role_not_invitable');
    const ids: string[] = [];
    for (const sub of ['ap1', 'ap2', 'ap3']) {
      ids.push((await env.pool.query("insert into approval_requests(id, authentik_sub, email, name) values (gen_random_uuid(), $1, $2, $1) returning id", [sub, `${sub}@x.de`])).rows[0].id);
    }
    expect((await adm('POST', `/api/admin/approvals/${ids[0]}/approve`, { role: 'admin' })).statusCode).toBe(200);
    expect((await adm('POST', `/api/admin/approvals/${ids[1]}/approve`, { role: 'oma' })).statusCode).toBe(200);
    await setInvitable(false);
    const bad = await adm('POST', `/api/admin/approvals/${ids[2]}/approve`, { role: 'oma' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('role_not_invitable');
    expect((await env.pool.query("select authentik_sub, role from users where authentik_sub in ('ap1','ap2') order by 1")).rows).toEqual([{ authentik_sub: 'ap1', role: 'admin' }, { authentik_sub: 'ap2', role: 'oma' }]);
  });

  it('a role deleted while the invite is being created leaves no invite behind', async () => {
    const key = (await adm('POST', '/api/admin/roles', { label: 'Flucht', from: 'friend' })).json().key as string;
    const before = (await env.pool.query('select count(*) n from invites')).rows[0].n;
    // the delete lands inside the (fake) Authentik call, between the invitable check and the insert
    const realFetch = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/invitations/') && init?.method === 'POST') await deleteRole(env.ctx, null, key, 'guest');
      return (realFetch as typeof fetch)(input, init);
    }) as typeof fetch;
    let r;
    try { r = await adm('POST', '/api/admin/invites', { role: key, ttlHours: 1 }); } finally { env.ctx.fetchImpl = realFetch; }
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('role_not_invitable');
    expect((await env.pool.query('select count(*) n from invites')).rows[0].n).toBe(before);
    expect(ak.calls.some((c) => c.method === 'DELETE')).toBe(true); // the Authentik invitation made meanwhile is removed again
  });

  it('the invite insert waits for a role delete in flight (the shared role lock)', async () => {
    const key = (await adm('POST', '/api/admin/roles', { label: 'Sperre', from: 'friend' })).json().key as string;
    const before = (await env.pool.query('select count(*) n from invites')).rows[0].n;
    const holder = await env.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtext($1))', [`role:${key}`]); // what deleteRole holds
      const post = adm('POST', '/api/admin/invites', { role: key, ttlHours: 1 });
      // the insert is parked on the lock: the role still exists and is invitable, so without the lock it would go through
      for (let i = 0; i < 100; i++) {
        if ((await env.pool.query("select 1 from pg_locks where locktype='advisory' and not granted")).rowCount) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await env.pool.query("select 1 from pg_locks where locktype='advisory' and not granted")).rowCount).toBe(1);
      await holder.query('delete from roles where key=$1', [key]);
      await holder.query('commit');
      const r = await post;
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('role_not_invitable');
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      invalidateRoles(env.ctx);
    }
    expect((await env.pool.query('select count(*) n from invites')).rows[0].n).toBe(before);
  });

  it('an approval whose role is deleted during provisioning is refused cleanly', async () => {
    const key = (await adm('POST', '/api/admin/roles', { label: 'Flucht2', from: 'friend' })).json().key as string;
    const id = (await env.pool.query("insert into approval_requests(id, authentik_sub, name) values (gen_random_uuid(), 'apgone', 'Gone') returning id")).rows[0].id;
    const admin_ = env.ctx.jf.admin;
    const realApply = admin_.applyPolicy.bind(admin_);
    admin_.applyPolicy = (async (...a: Parameters<typeof realApply>) => { await realApply(...a); await deleteRole(env.ctx, null, key, 'guest'); }) as typeof realApply;
    let r;
    try { r = await adm('POST', `/api/admin/approvals/${id}/approve`, { role: key }); } finally { admin_.applyPolicy = realApply; }
    expect(r.statusCode).toBe(400);
    expect((await env.pool.query("select 1 from users where authentik_sub='apgone'")).rowCount).toBe(0);
  });
});
