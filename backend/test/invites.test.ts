import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
beforeAll(async () => {
  env = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = (async () => new Response(JSON.stringify({ pk: 'ak-inv-1' }), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch; c.cfg = { ...cfg, AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 't', AUTHENTIK_ENROLL_FLOW: 'enroll' }; } });
  admin = await env.login();
});
afterAll(() => env.close());

const adm = (method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: body as object });

async function inviteLogin(token: string | undefined, sub: string, headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  env.claims.current = { sub, email: `${sub}@x.de`, name: `Freund ${sub}`, groups: [] };
  const l = await env.app.inject(`/auth/login${token ? `?invite=${token}` : ''}`);
  if (l.statusCode !== 302) return l;
  const key = (await env.kv.keys('oidc:')).at(-1)!;
  return env.app.inject({ url: `/auth/callback?state=${key.slice(5)}&code=c`, headers, cookies });
}

describe('invites', () => {
  it('only admins can create invites; token is stored hashed', async () => {
    const r = await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 24, note: 'Max' });
    expect(r.statusCode).toBe(200);
    const inv = r.json();
    expect(inv.link).toMatch(/^https:\/\/portal\.example\.com\/invite\/[\w-]{30,}$/);
    expect(inv.enrollUrl).toBe('https://auth.example.com/if/flow/enroll/?itoken=ak-inv-1');
    const token = inv.link.split('/').pop();
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
    expect(pol).toMatchObject({ MaxParentalRating: 12, EnableVideoPlaybackTranscoding: false, MaxActiveSessions: 1, RemoteClientBitrateLimit: 8_000_000, EnableContentDownloading: false });
    // second use fails
    expect((await inviteLogin(token, 'guest2')).statusCode).toBe(410);
    expect((await env.pool.query("select 1 from users where authentik_sub='guest2'")).rowCount).toBe(0);
    const inv = (await adm('GET', '/api/admin/invites')).json().invites.find((i: any) => i.used_by_name);
    expect(inv.used_by_name).toBe('Freund guest1');
  });

  it('expired invites are rejected and unknown users need an invite', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    await env.pool.query("update invites set expires_at = now() - interval '1 minute' where used_at is null");
    expect((await inviteLogin(token, 'late')).statusCode).toBe(410);
    expect((await inviteLogin(undefined, 'noinvite')).statusCode).toBe(403);
  });

  it('a failed provisioning releases the invite', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const orig = env.ctx.jf.client.createUser.bind(env.ctx.jf.client);
    env.ctx.jf.client.createUser = async () => { throw new Error('jellyfin down'); };
    expect((await inviteLogin(token, 'f1')).statusCode).toBe(401);
    env.ctx.jf.client.createUser = orig;
    expect((await inviteLogin(token, 'f1')).statusCode).toBe(302);
  });

  it('concurrent redemption only succeeds once', async () => {
    const token = (await adm('POST', '/api/admin/invites', { role: 'friend', ttlHours: 1 })).json().link.split('/').pop();
    const { claimInvite } = await import('../src/invites.js');
    const res = await Promise.all([claimInvite(env.ctx, token), claimInvite(env.ctx, token), claimInvite(env.ctx, token)]);
    expect(res.filter(Boolean)).toHaveLength(1);
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

    // approve from the first device
    const me1 = (await env.app.inject({ url: '/api/me', cookies: c1 })).json();
    const list = (await env.app.inject({ url: '/api/devices', cookies: c1 })).json().devices;
    const pending = list.find((d: any) => !d.approved);
    const ap = await env.app.inject({ method: 'POST', url: `/api/devices/${pending.id}/approve`, cookies: c1, headers: { 'x-csrf-token': me1.csrfToken } });
    expect(ap.statusCode).toBe(200);
    expect((await env.app.inject({ url: '/api/library/views', cookies: c2 })).statusCode).not.toBe(403);
    expect((await env.app.inject({ url: '/api/me', cookies: c2 })).json().deviceApproved).toBe(true);
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
});
