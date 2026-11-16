// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { setInstanceLanguage } from '../src/i18n.js';
import { setMailTestCa } from '../src/mail/transport.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';
import { SMTP_CERT, startSmtp, type SmtpFake, type SmtpFakeOptions } from './smtpfake.js';

// Mail stage B, Task 5: POST /api/admin/invites with `email` sends the invitation at once (single-use invites only), against a real
// SMTP server on 127.0.0.1. The audit row carries the masked address and a state, never the address or the token.
type Sess = { cookies: Record<string, string>; csrf: string };
const BEN = 'ben@friend.example.com';
const FROM = 'kino@friend.example.com';

describe('invitation mail', () => {
  let env: TestEnv;
  let admin: Sess;
  let adminId: string;
  let fake: SmtpFake | undefined;
  let n = 0;

  const post = (body: Record<string, unknown>) =>
    env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, remoteAddress: `192.0.2.${(n = (n % 200) + 1)}`, payload: body });
  const useFake = async (o: Partial<SmtpFakeOptions> = {}, patch: Partial<Config> = {}) => {
    fake = await startSmtp({ mode: 'starttls', ...o });
    env.ctx.cfg = { ...cfg, MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: fake.port, MAIL_SMTP_TLS: 'starttls', MAIL_FROM: FROM, PUBLIC_URL: 'https://friend.example.com', ...patch };
    return fake;
  };
  const text = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  const invites = async () => (await env.pool.query('select id from invites')).rows;
  const outbox = async () => (await env.pool.query<{ id: string; kind: string; user_id: string | null; dedupe: string; lang: string }>('select * from mail_outbox')).rows;

  beforeAll(async () => {
    setMailTestCa(SMTP_CERT);
    env = await makeEnv();
    admin = await env.login(ADMIN);
    adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
  });
  afterAll(async () => {
    setMailTestCa(null);
    await env.close();
  });
  beforeEach(async () => {
    await env.pool.query('delete from mail_outbox');
    await env.pool.query('delete from invites');
    await env.pool.query("delete from audit_log where action = 'invite.create'");
    await env.pool.query("delete from app_settings where key like '%anguage%'");
    for (const k of ['mail:transport', 'mail:transport:fails', `mail:invite:${adminId}`]) await env.kv.del(k);
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    env.ctx.cfg = cfg;
  });

  it('invite with email sends the mail and answers sent', async () => {
    const f = await useFake();
    const r = await post({ role: 'friend', email: BEN, lang: 'en' });
    expect(r.statusCode).toBe(200);
    const b = r.json<{ id: string; link: string; mail: { state: string } }>();
    expect(b.mail).toEqual({ state: 'sent' });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.to).toEqual([BEN]);
    expect(text(f.messages[0]!.raw)).toContain(b.link);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'invite', user_id: null, dedupe: `invite:${b.id}`, lang: 'en' });
    const audit = (await env.pool.query<{ meta: { mail: { to: string; state: string } } }>("select meta from audit_log where action = 'invite.create'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta.mail).toEqual({ to: 'b…@friend.example.com', state: 'sent' });
    const token = b.link.split('/invite/')[1]!;
    const all = JSON.stringify((await env.pool.query('select * from audit_log')).rows);
    expect(all).not.toContain(BEN);
    expect(all).not.toContain(token);
  });

  it('invite mail defaults to the instance language', async () => {
    await useFake();
    await setInstanceLanguage(env.ctx, 'fr');
    const r = await post({ role: 'friend', email: BEN });
    expect(r.statusCode).toBe(200);
    expect((await outbox())[0]!.lang).toBe('fr');
  });

  it('multi-use invite with email answers invite_mail_single_use and creates no invite', async () => {
    await useFake();
    const r = await post({ role: 'friend', email: BEN, maxUses: 3 });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invite_mail_single_use' });
    expect(await invites()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it('not configured answers mail_not_configured and creates no invite', async () => {
    const r = await post({ role: 'friend', email: BEN });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'mail_not_configured' });
    expect(await invites()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it('the 21st invite mail of the day answers rate_limited', async () => {
    const f = await useFake();
    // 20 different recipients (the outbox allows one address 10 mails an hour)
    for (let i = 0; i < 20; i++) expect((await post({ role: 'friend', email: `gast${i}@friend.example.com` })).statusCode).toBe(200);
    expect(f.messages).toHaveLength(20);
    const r = await post({ role: 'friend', email: BEN });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'rate_limited' });
    expect(await invites()).toHaveLength(20);
  });

  it('a failed send still creates the invite and answers the code', async () => {
    await useFake({ rcpt: () => 550 });
    const r = await post({ role: 'friend', email: BEN });
    expect(r.statusCode).toBe(200);
    expect(r.json().mail).toEqual({ state: 'failed', code: 'recipient_refused', smtp: 550 });
    expect(r.json().link).toContain('/invite/');
    expect(await invites()).toHaveLength(1);
  });

  it('invite without email is unchanged', async () => {
    await useFake();
    const r = await post({ role: 'friend' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).not.toHaveProperty('mail');
    expect(await outbox()).toHaveLength(0);
    expect(fake!.messages).toHaveLength(0);
  });
});
