// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto.js';
import type { Config } from '../src/config.js';
import { setMailTestCa } from '../src/mail/transport.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';
import { SMTP_CERT, startSmtp, type SmtpFake, type SmtpFakeOptions } from './smtpfake.js';

// Mail stage A, Task 4: the admin's test mail and the mail status, against a real SMTP server on 127.0.0.1.
type Sess = { cookies: Record<string, string>; csrf: string };
const ANNA = 'anna@friend.example.com';
const FROM = 'kino@friend.example.com';
const PASS = 'pw-geheim-77';
const FRIEND = { sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] as string[] };

describe('mail admin routes', () => {
  let env: TestEnv;
  let admin: Sess, friend: Sess;
  let adminId: string;
  let fake: SmtpFake | undefined;
  const logs: string[] = [];

  // every call comes from its own address, so the route's per-IP limit (tested on its own) does not count the other tests
  let n = 0;
  const as = (s: Sess, method: string, url: string, ip = `192.0.2.${(n = (n % 200) + 1)}`) =>
    env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: ip });
  const useFake = async (o: Partial<SmtpFakeOptions> = {}, patch: Partial<Config> = {}) => {
    fake = await startSmtp({ mode: 'starttls', user: 'kino', pass: PASS, ...o });
    env.ctx.cfg = { ...cfg, MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: fake.port, MAIL_SMTP_TLS: 'starttls', MAIL_SMTP_USER: 'kino', MAIL_SMTP_PASSWORD: PASS, MAIL_FROM: FROM, ...patch };
    return fake;
  };
  const outbox = async () => (await env.pool.query('select * from mail_outbox')).rows;

  beforeAll(async () => {
    setMailTestCa(SMTP_CERT);
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
    admin = await env.login(ADMIN);
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend','jffritz','Fritz',$1)", [encrypt(env.ctx.encKey, 'pw')]);
    friend = await env.login(FRIEND);
    adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
  });
  afterAll(async () => {
    setMailTestCa(null);
    await env.close();
  });
  beforeEach(async () => {
    await env.pool.query('delete from mail_outbox');
    await env.pool.query('delete from audit_log where action = $1', ['mail.test']);
    await env.pool.query('update users set email = $1 where id = $2', [ANNA, adminId]);
    await env.pool.query("delete from profile_prefs where profile_id = $1", [adminId]);
    for (const k of ['mail:transport', 'mail:transport:fails', `mail:test:${adminId}`]) await env.kv.del(k);
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    env.ctx.cfg = cfg;
  });

  it('non-admin gets 403', async () => {
    expect((await as(friend, 'GET', '/api/admin/mail/status')).statusCode).toBe(403);
    expect((await as(friend, 'POST', '/api/admin/mail/test')).statusCode).toBe(403);
  });

  it('status is no-store and shows the state', async () => {
    const r = await as(admin, 'GET', '/api/admin/mail/status');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.json()).toMatchObject({ configured: false, queued: 0, failed24h: 0, lastSentAt: null, lastFailure: null, transport: null });
  });

  it('test mail unconfigured answers mail_not_configured and queues nothing', async () => {
    const r = await as(admin, 'POST', '/api/admin/mail/test');
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'mail_not_configured' });
    expect(await outbox()).toHaveLength(0);
  });

  it('test mail without address answers no_address', async () => {
    await useFake();
    await env.pool.query('update users set email = null where id = $1', [adminId]);
    const r = await as(admin, 'POST', '/api/admin/mail/test');
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'no_address' });
    expect(await outbox()).toHaveLength(0);
  });

  it('test mail is delivered and audited', async () => {
    const f = await useFake();
    await env.pool.query("insert into profile_prefs(profile_id, data) values ($1, '{\"language\":\"en\"}')", [adminId]);
    const r = await as(admin, 'POST', '/api/admin/mail/test');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ state: 'sent' });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.to).toEqual([ANNA]);
    expect(f.messages[0]!.raw).toMatch(/^Subject: Test mail from /im);
    const meta = (await env.pool.query<{ meta: unknown }>("select meta from audit_log where action = 'mail.test'")).rows.map((x) => JSON.stringify(x.meta));
    expect(meta).toEqual(['{"state":"sent"}']);
    expect(meta[0]).not.toContain('@');
  });

  it('test mail failure answers the code', async () => {
    await useFake({ rcpt: () => 550 });
    const r = await as(admin, 'POST', '/api/admin/mail/test');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ state: 'failed', code: 'recipient_refused', smtp: 550 });
    const meta = (await env.pool.query<{ meta: { state: string; code: string } }>("select meta from audit_log where action = 'mail.test'")).rows[0]!.meta;
    expect(meta).toEqual({ state: 'failed', code: 'recipient_refused' });
  });

  it('a failed test mail is logged through the app logger, not the console', async () => {
    await useFake({ rcpt: () => 550 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logs.length = 0;
    await as(admin, 'POST', '/api/admin/mail/test');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(logs.join('')).toContain('"code":"recipient_refused"');
  });

  it('fourth test mail in 10 minutes is rate limited', async () => {
    await useFake();
    for (let i = 0; i < 3; i++) expect((await as(admin, 'POST', '/api/admin/mail/test')).statusCode).toBe(200);
    const r = await as(admin, 'POST', '/api/admin/mail/test');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'rate_limited' });
    expect(await outbox()).toHaveLength(3);
  });

  it('status carries no address or password', async () => {
    await useFake({ rcpt: () => 550 });
    await as(admin, 'POST', '/api/admin/mail/test');
    const r = await as(admin, 'GET', '/api/admin/mail/status');
    expect(r.json()).toMatchObject({ configured: true, failed24h: 1, lastFailure: { kind: 'test', code: 'recipient_refused', smtp: 550 } });
    expect(r.body).not.toContain('@friend.example.com');
    expect(r.body).not.toContain(PASS);
  });

  it('a successful settings test clears the stale transport failure', async () => {
    await useFake();
    await env.kv.set('mail:transport', JSON.stringify({ code: 'unreachable', at: new Date().toISOString() }), 600);
    await env.kv.incr('mail:transport:fails', 600);
    expect((await as(admin, 'GET', '/api/admin/mail/status')).json().transport).toMatchObject({ code: 'unreachable' });
    const r = await env.app.inject({ method: 'POST', url: '/api/admin/settings/test', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { group: 'mail' } });
    expect(r.statusCode).toBe(200);
    expect(await env.kv.get('mail:transport')).toBeNull();
    expect(await env.kv.get('mail:transport:fails')).toBeNull();
    expect((await as(admin, 'GET', '/api/admin/mail/status')).json().transport).toBeNull();
  });

  const failure = () => env.kv.set('mail:transport', JSON.stringify({ code: 'unreachable', at: new Date().toISOString() }), 600);
  const testMail = (values?: Record<string, unknown>) => env.app.inject({ method: 'POST', url: '/api/admin/settings/test', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { group: 'mail', ...(values ? { values } : {}) } });

  it('a test of unsaved values that probe ok keeps the failure of the saved settings', async () => {
    const f = await useFake();
    // the password is saved as a setting (not env-locked, so the test route may overlay it) and wrong
    await env.ctx.settings.save({ MAIL_SMTP_PASSWORD: 'broken-saved' }, adminId);
    expect(env.ctx.cfg.MAIL_SMTP_PASSWORD).toBe('broken-saved');
    await failure();
    await env.kv.incr('mail:transport:fails', 600);
    const r = await testMail({ MAIL_SMTP_PASSWORD: PASS });
    expect(r.json()).toMatchObject({ ok: true });
    expect(r.json()).not.toHaveProperty('saved');
    expect(f.auths).toBeGreaterThan(0);
    expect(await env.kv.get('mail:transport')).not.toBeNull();
    expect(await env.kv.get('mail:transport:fails')).not.toBeNull();
  });

  it('a test body that repeats the saved values clears the failure', async () => {
    await useFake();
    await env.ctx.settings.save({ MAIL_SMTP_PASSWORD: PASS }, adminId);
    await failure();
    const r = await testMail({ MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: env.ctx.cfg.MAIL_SMTP_PORT, MAIL_SMTP_USER: 'kino', MAIL_SMTP_PASSWORD: PASS });
    expect(r.json()).toMatchObject({ ok: true });
    expect(await env.kv.get('mail:transport')).toBeNull();
  });

  it('a queued test mail is audited with its code', async () => {
    await useFake({}, { MAIL_SMTP_PASSWORD: undefined, MAIL_SMTP_USER: undefined });
    await fake!.close();
    const r = await as(admin, 'POST', '/api/admin/mail/test');
    const body = r.json(); 
    expect(body.state).toBe('queued');
    expect(typeof body.code).toBe('string');
    const meta = (await env.pool.query<{ meta: unknown }>("select meta from audit_log where action = 'mail.test'")).rows[0]!.meta;
    expect(meta).toEqual({ state: 'queued', code: body.code });
  });

  it('a failed settings test keeps the transport failure', async () => {
    await useFake({}, { MAIL_SMTP_PASSWORD: 'wrong' });
    await env.kv.set('mail:transport', JSON.stringify({ code: 'unreachable', at: new Date().toISOString() }), 600);
    await env.app.inject({ method: 'POST', url: '/api/admin/settings/test', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { group: 'mail' } });
    expect(await env.kv.get('mail:transport')).not.toBeNull();
  });

  it('the test mail route is limited to 10 per minute', async () => {
    await useFake();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      await env.kv.del(`mail:test:${adminId}`); // the per-admin allowance is not what is tested here
      last = (await as(admin, 'POST', '/api/admin/mail/test', '198.51.100.7')).statusCode;
    }
    expect(last).toBe(429);
  });
});
