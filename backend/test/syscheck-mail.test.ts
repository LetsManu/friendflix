// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { setMailTestCa } from '../src/mail/transport.js';
import { mailCheck } from '../src/syscheck/checks/mail.js';
import { buildSystemcheck, registerChecks, resetChecksForTests } from '../src/syscheck/engine.js';
import type { CheckLine } from '../src/syscheck/types.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';
import { SMTP_CERT, startSmtp, type SmtpFake, type SmtpFakeOptions } from './smtpfake.js';

// Mail stage A, Task 4: the Systemcheck line core.mail (probe cached for 10 minutes, outbox failures and a stuck queue as warnings).
const FROM = 'kino@friend.example.com';
const PASS = 'pw-geheim-77';
const HOUR_MS = 3_600_000;

describe('core.mail', () => {
  let env: TestEnv;
  let fake: SmtpFake | undefined;

  const useFake = async (o: Partial<SmtpFakeOptions> = {}, patch: Partial<Config> = {}) => {
    fake = await startSmtp({ mode: 'starttls', user: 'kino', pass: PASS, ...o });
    env.ctx.cfg = { ...cfg, MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: fake.port, MAIL_SMTP_TLS: 'starttls', MAIL_SMTP_USER: 'kino', MAIL_SMTP_PASSWORD: PASS, MAIL_FROM: FROM, ...patch };
    return fake;
  };
  const line = async (fresh = false): Promise<CheckLine> => {
    const r = await buildSystemcheck(env.ctx, { fresh });
    expect(r.lines.map((l) => l.id)).toEqual(['core.mail']);
    return r.lines[0]!;
  };
  const insert = (state: 'queued' | 'failed', ageMs: number, code?: string, smtp?: number) => env.pool.query(
    `insert into mail_outbox (id, kind, rcpt_enc, rcpt_mask, rcpt_key, params_enc, lang, state, last_code, last_smtp, created_at, finished_at)
     values (gen_random_uuid(), 'test', 'x', 'a…@friend.example.com', 'k', 'x', 'de', $1, $2, $3, now() - $4 * interval '1 millisecond', $5)`,
    [state, code ?? null, smtp ?? null, ageMs, state === 'failed' ? new Date(Date.now() - ageMs) : null]);

  beforeAll(async () => {
    setMailTestCa(SMTP_CERT);
    env = await makeEnv();
    resetChecksForTests();
    registerChecks([mailCheck]);
  });
  afterAll(async () => {
    setMailTestCa(null);
    await env.close();
  });
  beforeEach(async () => {
    await env.pool.query('delete from mail_outbox');
    for (const k of ['mail:probe', 'mail:transport', 'mail:transport:fails']) await env.kv.del(k);
    for (const k of await env.kv.keys('syscheck:')) await env.kv.del(k);
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    env.ctx.cfg = cfg;
  });

  it('not set up is neutral', async () => {
    expect(await line()).toMatchObject({ id: 'core.mail', status: 'not_set_up', cause: 'mail_not_set', settingKey: 'MAIL_SMTP_HOST', settingGroup: 'mail', docs: 'mail.md' });
  });

  it('wrong password is a problem pointing at the password', async () => {
    await useFake({}, { MAIL_SMTP_PASSWORD: 'wrong' });
    expect(await line()).toMatchObject({ status: 'problem', cause: 'mail_auth', settingKey: 'MAIL_SMTP_PASSWORD', docs: 'mail.md' });
  });

  it('unreachable host points at the host, a password without a user at the user, a login without TLS at the TLS setting', async () => {
    await useFake();
    await fake!.close();
    expect(await line()).toMatchObject({ status: 'problem', cause: 'mail_unreachable', settingKey: 'MAIL_SMTP_HOST' });
    fake = undefined;
    env.ctx.cfg = { ...cfg, MAIL_SMTP_HOST: '127.0.0.1', MAIL_FROM: FROM, MAIL_SMTP_PASSWORD: PASS };
    expect(await line(true)).toMatchObject({ status: 'problem', cause: 'mail_no_user', settingKey: 'MAIL_SMTP_USER' });
    await useFake({ mode: 'none' }, { MAIL_SMTP_TLS: 'none' });
    expect(await line(true)).toMatchObject({ status: 'problem', cause: 'mail_insecure_auth', settingKey: 'MAIL_SMTP_TLS' });
  });

  it('recent final failure is a warning with codes only', async () => {
    await useFake();
    await insert('failed', 2 * HOUR_MS, 'recipient_refused', 550);
    const l = await line();
    expect(l).toMatchObject({ status: 'warning', cause: 'mail_last_failed', params: { code: 'recipient_refused', smtp: 550 }, href: '/admin/settings?tab=notifications', docs: 'mail.md' });
    expect(JSON.stringify(l)).not.toContain('@');
  });

  it('a failure older than 24 hours is not shown', async () => {
    await useFake();
    await insert('failed', 30 * HOUR_MS, 'recipient_refused', 550);
    expect((await line()).status).toBe('ok');
  });

  it('old queued mail is a warning', async () => {
    await useFake();
    await insert('queued', 2 * HOUR_MS);
    expect(await line()).toMatchObject({ status: 'warning', cause: 'mail_queue_stuck', href: '/admin/settings?tab=notifications', docs: 'mail.md' });
  });

  it('probe result is cached', async () => {
    const f = await useFake();
    await line();
    const first = f.connections;
    expect(first).toBeGreaterThan(0);
    await line();
    expect(f.connections).toBe(first);
    await line(true);
    expect(f.connections).toBeGreaterThan(first);
  });

  it('a changed setting is not answered from the cache', async () => {
    await useFake();
    expect((await line()).status).toBe('ok');
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_SMTP_PASSWORD: 'wrong' };
    expect(await line()).toMatchObject({ status: 'problem', cause: 'mail_auth' });
  });

  it('a changed host is not answered from the cache', async () => {
    const a = await useFake();
    expect((await line()).status).toBe('ok');
    await fake!.close();
    const old = a.connections;
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_SMTP_HOST: 'localhost' };
    expect(a.connections).toBe(old);
    // nothing listens on the port any more: a fresh probe (not the cached ok) answers unreachable
    expect(await line()).toMatchObject({ status: 'problem', cause: 'mail_unreachable' });
  });

  it('a good probe clears the stale transport failure', async () => {
    await useFake();
    await env.kv.set('mail:transport', JSON.stringify({ code: 'unreachable', at: new Date().toISOString() }), 600);
    await env.kv.incr('mail:transport:fails', 600);
    await line(true);
    expect(await env.kv.get('mail:transport')).toBeNull();
    expect(await env.kv.get('mail:transport:fails')).toBeNull();
  });

  it('ok', async () => {
    await useFake();
    const l = await line();
    expect(l).toMatchObject({ id: 'core.mail', group: 'core', status: 'ok' });
    expect(l.cause).toBeUndefined();
  });
});
