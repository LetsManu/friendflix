// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBrand, resetBrand, saveBrand } from '../src/brand/repo.js';
import type { Config } from '../src/config.js';
import { HttpError } from '../src/users.js';
import { BACKOFF_S, enqueueMail, LIMITS, MAX_ATTEMPTS, mailStatus } from '../src/mail/outbox.js';
import { setMailTestCa } from '../src/mail/transport.js';
import { deliverNow, mailTick, setMailClockForTests } from '../src/mail/worker.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';
import { SMTP_CERT, startSmtp, type SmtpFake, type SmtpFakeOptions } from './smtpfake.js';

// Mail stage A, Task 3: the durable outbox (encrypted while queued, retries with backoff, rate limits, expiry, retention) and the
// background sender, against a real SMTP server (smtp-server) on 127.0.0.1.
const ANNA = 'anna@friend.example.com';
const FROM = 'kino@friend.example.com';
const SEC = 1000;

interface Row {
  id: string; kind: string; user_id: string | null; rcpt_enc: string | null; rcpt_mask: string; rcpt_key: string; params_enc: string | null;
  state: string; attempts: number; next_at: Date; lease_until: Date | null; last_code: string | null; last_smtp: number | null;
  created_at: Date; sent_at: Date | null; finished_at: Date | null;
}

describe('mail outbox and worker', () => {
  let env: TestEnv;
  let anna: string;
  let fake: SmtpFake | undefined;
  const logs: unknown[] = [];
  const log = { warn: (o: unknown) => { logs.push(o); } };

  beforeAll(async () => {
    setMailTestCa(SMTP_CERT);
    env = await makeEnv();
    anna = (await env.pool.query<{ id: string }>("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-anna', $1, 'Anna Beispiel', 'admin', $2, 'Anna', 'x') returning id", [ANNA, 'sub-anna'.padEnd(32, '0')])).rows[0]!.id;
  });
  afterAll(async () => {
    setMailTestCa(null);
    await env.close();
  });
  beforeEach(async () => {
    await env.pool.query('delete from mail_outbox');
    await env.kv.del('mail:transport');
    await env.kv.del('mail:transport:fails');
    await resetBrand(env.ctx.db, anna, (await readBrand(env.ctx.db)).rev);
    logs.length = 0;
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    env.ctx.cfg = cfg;
    setMailClockForTests(null);
    vi.restoreAllMocks();
  });

  /** starts the fake server (login kino / pw-1 over STARTTLS) and points the settings at it */
  const useFake = async (o: Partial<SmtpFakeOptions> = {}, patch: Partial<Config> = {}) => {
    fake = await startSmtp({ mode: 'starttls', user: 'kino', pass: 'pw-1', ...o });
    env.ctx.cfg = { ...cfg, MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: fake.port, MAIL_SMTP_TLS: 'starttls', MAIL_SMTP_USER: 'kino', MAIL_SMTP_PASSWORD: 'pw-1', MAIL_FROM: FROM, ...patch };
    return fake;
  };
  const enqueue = (o: { to?: string; userId?: string | null; params?: Record<string, unknown>; dedupe?: string } = {}) =>
    enqueueMail(env.ctx, { kind: 'test', to: o.to ?? ANNA, userId: o.userId === undefined ? anna : o.userId, lang: 'de', params: o.params, dedupe: o.dedupe });
  const row = async (id: string) => (await env.pool.query<Row>('select * from mail_outbox where id=$1', [id])).rows[0]!;
  const rows = async () => (await env.pool.query<Row>('select * from mail_outbox order by created_at, id')).rows;
  // rounded up to the millisecond, as the worker does: a row queued in the same millisecond is due
  const dbNow = async () => new Date(Number((await env.pool.query<{ ms: string }>('select ceil(extract(epoch from now()) * 1000)::bigint ms')).rows[0]!.ms));
  const header = (raw: string, name: string) => {
    const head = raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n[ \t]+/g, ' ');
    return head.split('\r\n').filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  };

  it('constants', () => {
    expect(BACKOFF_S).toEqual([60, 300, 1800, 7200, 21600]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect(LIMITS).toEqual({ perRcptHour: 10, perRcptDay: 50, instanceHour: 200 });
  });

  it('queued row holds no readable address or params', async () => {
    const id = await enqueue({ params: { token: 'geheim-token-42' } });
    const r = await row(id!);
    expect(r.state).toBe('queued');
    expect(r.attempts).toBe(0);
    expect(r.rcpt_enc).toBeTruthy();
    expect(r.params_enc).toBeTruthy();
    for (const v of [r.rcpt_enc!, r.params_enc!, r.rcpt_key]) {
      expect(v.toLowerCase()).not.toContain('anna');
      expect(v).not.toContain('geheim-token-42');
    }
    expect(r.rcpt_mask).toBe('a…@friend.example.com');
    expect(r.rcpt_key).toMatch(/^[0-9a-f]{64}$/);
    // an address the check refuses is never queued
    await expect(enqueue({ to: 'anna@friend.example.com\r\nBcc: x@friend.example.com' })).rejects.toThrow(HttpError);
    await expect(enqueue({ to: 'keine-adresse' })).rejects.toMatchObject({ statusCode: 400, message: 'no_address' });
    expect(await rows()).toHaveLength(1);
  });

  it('tick sends and finalises', async () => {
    const f = await useFake();
    const id = await enqueue();
    const now = await dbNow();
    expect(await mailTick(env.ctx, now)).toEqual({ sent: 1, failed: 0, deferred: 0 });
    expect(f.messages).toHaveLength(1);
    const m = f.messages[0]!;
    expect(m.to).toEqual([ANNA]);
    expect(m.from).toBe(FROM);
    expect(header(m.raw, 'To')).toEqual([`To: ${ANNA}`]);
    // nodemailer quotes a display name only when it needs it: FriendFlix is a plain atom
    expect(header(m.raw, 'From')).toHaveLength(1);
    expect(header(m.raw, 'From')[0]).toMatch(/^From: "?FriendFlix"? <kino@friend\.example\.com>$/);
    expect(header(m.raw, 'Auto-Submitted')).toEqual(['Auto-Submitted: auto-generated']);
    expect(header(m.raw, 'Content-Language')).toEqual(['Content-Language: de']);
    const r = await row(id!);
    expect(r.state).toBe('sent');
    expect(r.rcpt_enc).toBeNull();
    expect(r.params_enc).toBeNull();
    expect(r.sent_at).not.toBeNull();
    expect(r.finished_at).not.toBeNull();
    expect(r.lease_until).toBeNull();
    expect(r.attempts).toBe(1);
    expect(f.connections).toBe(1);
  });

  it('brand name with quotes is a safe From display name', async () => {
    await saveBrand(env.ctx.db, anna, (await readBrand(env.ctx.db)).rev, { name: 'Nordlicht "TV"' });
    const f = await useFake();
    await enqueue();
    await mailTick(env.ctx, await dbNow());
    expect(f.messages).toHaveLength(1);
    const m = f.messages[0]!;
    const from = header(m.raw, 'From');
    expect(from).toHaveLength(1);
    expect(from[0]).toMatch(/^From: .*Nordlicht.*TV.* <kino@friend\.example\.com>$/);
    expect(from[0]!.match(/</g)).toHaveLength(1);
    expect(from[0]!.match(/@/g)).toHaveLength(1);
    expect(m.to).toEqual([ANNA]);
    expect(header(m.raw, 'To')).toEqual([`To: ${ANNA}`]);
    expect(header(m.raw, 'Cc')).toEqual([]);
    expect(header(m.raw, 'Bcc')).toEqual([]);
  });

  it('dedupe key queues once', async () => {
    const a = await enqueue({ dedupe: 'test:anna:1' });
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(await enqueue({ dedupe: 'test:anna:1' })).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it('450 is retried with backoff', async () => {
    await useFake({ rcpt: () => 450 });
    const id = (await enqueue())!;
    const t0 = await dbNow();
    expect(await mailTick(env.ctx, t0, log)).toEqual({ sent: 0, failed: 0, deferred: 1 });
    let r = await row(id);
    expect(r.state).toBe('queued');
    expect(r.attempts).toBe(1);
    expect(r.next_at.getTime()).toBe(t0.getTime() + 60 * SEC);
    expect(r.last_code).toBe('recipient_refused');
    expect(r.last_smtp).toBe(450);
    expect(r.lease_until).toBeNull();
    expect(r.rcpt_enc).not.toBeNull();
    // not due yet: nothing happens
    await mailTick(env.ctx, new Date(t0.getTime() + 30 * SEC));
    expect((await row(id)).attempts).toBe(1);
    for (let i = 1; i <= 5; i++) {
      const at = new Date(r.next_at.getTime() + SEC);
      await mailTick(env.ctx, at, log);
      r = await row(id);
      expect(r.attempts).toBe(i + 1);
      if (i < 5) expect(r.next_at.getTime()).toBe(at.getTime() + BACKOFF_S[i]! * SEC);
    }
    expect(r.state).toBe('failed');
    expect(r.attempts).toBe(6);
    expect(r.finished_at).not.toBeNull();
    expect(r.rcpt_enc).toBeNull();
    expect(r.params_enc).toBeNull();
    expect(r.last_smtp).toBe(450);
  });

  it('550 fails at once', async () => {
    const f = await useFake({ rcpt: () => 550 });
    const id = (await enqueue())!;
    expect(await mailTick(env.ctx, await dbNow(), log)).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const r = await row(id);
    expect(r.state).toBe('failed');
    expect(r.attempts).toBe(1);
    expect(r.last_code).toBe('recipient_refused');
    expect(r.last_smtp).toBe(550);
    expect(r.rcpt_enc).toBeNull();
    expect(r.finished_at).not.toBeNull();
    expect(f.messages).toHaveLength(0);
    // the log line carries the row id and the code only
    expect(logs).toEqual([{ mail: id, code: 'recipient_refused' }]);
  });

  it('transport error gives the claimed rows back without using an attempt', async () => {
    const f = await useFake({}, { MAIL_SMTP_PASSWORD: 'falsch' });
    for (let i = 0; i < 3; i++) await enqueue();
    const t0 = await dbNow();
    expect(await mailTick(env.ctx, t0, log)).toEqual({ sent: 0, failed: 0, deferred: 3 });
    for (const r of await rows()) {
      expect(r.state).toBe('queued');
      expect(r.attempts).toBe(0);
      expect(r.next_at.getTime()).toBe(t0.getTime() + 60 * SEC);
      expect(r.lease_until).toBeNull();
    }
    expect(JSON.parse((await env.kv.get('mail:transport'))!)).toMatchObject({ code: 'auth' });
    expect(await env.kv.get('mail:transport:fails')).toBe('1');
    expect(f.connections).toBeLessThanOrEqual(1);
    expect(JSON.stringify(logs)).not.toContain('falsch');
    // the second failing tick in a row waits longer
    const t1 = new Date(t0.getTime() + 61 * SEC);
    await mailTick(env.ctx, t1);
    for (const r of await rows()) {
      expect(r.attempts).toBe(0);
      expect(r.next_at.getTime()).toBe(t1.getTime() + 300 * SEC);
    }
    // a working login sends them and clears the transport failure
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_SMTP_PASSWORD: 'pw-1' };
    expect(await mailTick(env.ctx, new Date(t1.getTime() + 301 * SEC))).toMatchObject({ sent: 3 });
    expect(await env.kv.get('mail:transport')).toBeNull();
    expect(await env.kv.get('mail:transport:fails')).toBeNull();
  });

  it('two concurrent ticks send each mail once', async () => {
    const f = await useFake();
    for (let i = 0; i < 10; i++) await enqueue({ to: `gast${i}@friend.example.com`, userId: null, params: { n: i } });
    const [a, b] = await Promise.all([mailTick(env.ctx), mailTick(env.ctx)]);
    expect(a.sent + b.sent).toBe(10);
    expect(f.messages).toHaveLength(10);
    const to = f.messages.flatMap((m) => m.to).sort();
    expect(new Set(to).size).toBe(10);
    expect(to).toEqual(Array.from({ length: 10 }, (_, i) => `gast${i}@friend.example.com`).sort());
    expect((await rows()).every((r) => r.state === 'sent' && r.attempts === 1)).toBe(true);
  });

  it('expired lease is claimed again', async () => {
    const f = await useFake();
    const id = (await enqueue())!;
    const now = await dbNow();
    await env.pool.query("update mail_outbox set state='sending', attempts=1, lease_until=$2 where id=$1", [id, new Date(now.getTime() - SEC)]);
    // a lease still running is left alone
    const other = (await enqueue({ to: 'gast@friend.example.com', userId: null }))!;
    await env.pool.query("update mail_outbox set state='sending', attempts=1, lease_until=$2 where id=$1", [other, new Date(now.getTime() + 60 * SEC)]);
    expect(await mailTick(env.ctx, now)).toMatchObject({ sent: 1 });
    expect(f.messages.map((m) => m.to)).toEqual([[ANNA]]);
    expect((await row(id)).state).toBe('sent');
    expect((await row(other)).state).toBe('sending');
  });

  it('a batch stops before its lease runs out', async () => {
    // a monotonic clock the fake server moves on: every recipient it accepts costs 40 s of the 2-minute lease
    let mono = 1_000;
    let step = 40_000;
    setMailClockForTests(() => mono);
    const f = await useFake({ rcpt: () => { mono += step; return null; } });
    for (let i = 0; i < 5; i++) await enqueue({ to: `gast${i}@friend.example.com`, userId: null });
    const before = new Map((await rows()).map((r) => [r.id, r.next_at.getTime()]));
    // 0 s and 40 s used: sent; 80 s used leaves 40 s, less than the 45 s one more send may take: the rest goes back
    expect(await mailTick(env.ctx, await dbNow())).toEqual({ sent: 2, failed: 0, deferred: 3 });
    expect(f.messages).toHaveLength(2);
    const back = (await rows()).filter((r) => r.state !== 'sent');
    expect(back).toHaveLength(3);
    for (const r of back) {
      expect(r.state).toBe('queued');
      expect(r.attempts).toBe(0);
      expect(r.lease_until).toBeNull();
      expect(r.last_code).toBeNull();
      expect(r.next_at.getTime()).toBe(before.get(r.id));
    }
    // still due: the next tick sends them
    step = 0;
    expect(await mailTick(env.ctx, await dbNow())).toEqual({ sent: 3, failed: 0, deferred: 0 });
    expect(new Set(f.messages.flatMap((m) => m.to)).size).toBe(5);
  });

  it('a reclaimed row past its last attempt fails without sending', async () => {
    const f = await useFake();
    const id = (await enqueue())!;
    const now = await dbNow();
    await env.pool.query("update mail_outbox set state='sending', attempts=$2, lease_until=$3 where id=$1", [id, MAX_ATTEMPTS, new Date(now.getTime() - SEC)]);
    expect(await mailTick(env.ctx, now, log)).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const r = await row(id);
    expect(r.state).toBe('failed');
    expect(r.last_code).toBe('unexpected');
    expect(r.attempts).toBe(MAX_ATTEMPTS + 1);
    expect(r.rcpt_enc).toBeNull();
    expect(f.messages).toHaveLength(0);
  });

  it('a sent mail stays sent when clearing the transport failure fails', async () => {
    await useFake();
    await env.kv.set('mail:transport', JSON.stringify({ code: 'auth', at: new Date().toISOString() }), 3600);
    vi.spyOn(env.kv, 'del').mockRejectedValueOnce(new Error('kv down'));
    const id = (await enqueue())!;
    expect(await deliverNow(env.ctx, id, { log })).toEqual({ state: 'sent' });
    expect((await row(id)).state).toBe('sent');
    expect(logs).toEqual([]);
  });

  it('per-day and instance limits defer', async () => {
    const f = await useFake();
    const id = (await enqueue())!;
    const now = await dbNow();
    const key = (await row(id)).rcpt_key;
    // 50 mails to Anna in the last day, the oldest 23 h ago (none in the last hour)
    await env.pool.query(`insert into mail_outbox (id, kind, rcpt_mask, rcpt_key, lang, state, sent_at, finished_at)
      select gen_random_uuid(), 'test', 'a…@friend.example.com', $1, 'de', 'sent', t, t
        from generate_series(0, 49) i, lateral (select $2::timestamptz - interval '23 hours' + i * interval '20 minutes' t) x`, [key, now]);
    expect(await mailTick(env.ctx, now)).toEqual({ sent: 0, failed: 0, deferred: 1 });
    expect((await row(id)).next_at.getTime()).toBe(now.getTime() - 23 * 3600 * SEC + 24 * 3600 * SEC);
    await env.pool.query("delete from mail_outbox where state = 'sent'");
    // 200 mails to others in the last hour, the oldest 50 min ago
    await env.pool.query(`insert into mail_outbox (id, kind, rcpt_mask, rcpt_key, lang, state, sent_at, finished_at)
      select gen_random_uuid(), 'test', 'g…@friend.example.com', md5(i::text), 'de', 'sent', $1::timestamptz - interval '50 minutes', $1
        from generate_series(1, 200) i`, [now]);
    await env.pool.query('update mail_outbox set next_at = $2 where id = $1', [id, now]); // due again
    expect(await mailTick(env.ctx, now)).toEqual({ sent: 0, failed: 0, deferred: 1 });
    expect((await row(id)).next_at.getTime()).toBe(now.getTime() + 10 * 60 * SEC);
    expect(f.messages).toHaveLength(0);
    expect((await row(id)).attempts).toBe(0);
  });

  it('per-recipient limit defers instead of dropping', async () => {
    const f = await useFake();
    for (let i = 0; i < 12; i++) await enqueue();
    const now = await dbNow();
    expect(await mailTick(env.ctx, now)).toEqual({ sent: 10, failed: 0, deferred: 2 });
    expect(f.messages).toHaveLength(10);
    const queued = (await rows()).filter((r) => r.state === 'queued');
    expect(queued).toHaveLength(2);
    for (const r of queued) {
      expect(r.attempts).toBe(0);
      expect(r.next_at.getTime()).toBeGreaterThanOrEqual(now.getTime() + 3600 * SEC);
      expect(r.last_code).toBeNull();
    }
    // the window frees up: both go out
    expect(await mailTick(env.ctx, new Date(now.getTime() + 3601 * SEC))).toMatchObject({ sent: 2 });
  });

  it('old queued mail expires', async () => {
    const f = await useFake();
    const id = (await enqueue())!;
    const now = await dbNow();
    await env.pool.query('update mail_outbox set created_at=$2 where id=$1', [id, new Date(now.getTime() - 73 * 3600 * SEC)]);
    await mailTick(env.ctx, now);
    const r = await row(id);
    expect(r.state).toBe('failed');
    expect(r.last_code).toBe('expired');
    expect(r.rcpt_enc).toBeNull();
    expect(r.params_enc).toBeNull();
    expect(r.finished_at).not.toBeNull();
    expect(f.messages).toHaveLength(0);
  });

  it('final rows are deleted after 30 days', async () => {
    await useFake();
    const now = await dbNow();
    const day = 86400 * SEC;
    const old = (await enqueue())!;
    const recent = (await enqueue())!;
    const failedOld = (await enqueue())!;
    await env.pool.query("update mail_outbox set state='sent', rcpt_enc=null, params_enc=null, sent_at=$2, finished_at=$2 where id=$1", [old, new Date(now.getTime() - 31 * day)]);
    await env.pool.query("update mail_outbox set state='sent', rcpt_enc=null, params_enc=null, sent_at=$2, finished_at=$2 where id=$1", [recent, new Date(now.getTime() - 29 * day)]);
    await env.pool.query("update mail_outbox set state='failed', last_code='expired', rcpt_enc=null, params_enc=null, finished_at=$2 where id=$1", [failedOld, new Date(now.getTime() - 31 * day)]);
    await mailTick(env.ctx, now);
    expect((await rows()).map((r) => r.id)).toEqual([recent]);
  });

  it('deleted user removes queued mail', async () => {
    const ben = (await env.pool.query<{ id: string }>("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-gast', 'gast@friend.example.com', 'Gast Nordlicht', 'user', $1, 'Gast', 'x') returning id", ['sub-gast'.padEnd(32, '0')])).rows[0]!.id;
    await enqueue({ to: 'gast@friend.example.com', userId: ben });
    const keep = await enqueue();
    await env.pool.query('delete from users where id=$1', [ben]);
    expect((await rows()).map((r) => r.id)).toEqual([keep]);
  });

  it('mail expires also while mail is not set up', async () => {
    const id = (await enqueue())!;
    const now = await dbNow();
    await env.pool.query('update mail_outbox set created_at=$2 where id=$1', [id, new Date(now.getTime() - 73 * 3600 * SEC)]);
    await mailTick(env.ctx, now);
    expect(await row(id)).toMatchObject({ state: 'failed', last_code: 'expired', rcpt_enc: null, params_enc: null });
  });

  it('unconfigured tick does nothing', async () => {
    const id = (await enqueue())!;
    expect(await mailTick(env.ctx, await dbNow())).toEqual({ sent: 0, failed: 0, deferred: 0 });
    const r = await row(id);
    expect(r.state).toBe('queued');
    expect(r.attempts).toBe(0);
    expect(r.rcpt_enc).not.toBeNull();
    expect(await deliverNow(env.ctx, id)).toEqual({ state: 'queued', code: 'not_configured' });
    expect((await row(id)).attempts).toBe(0);
  });

  it('a password without a user is recorded as no_user, nothing is claimed', async () => {
    await useFake({}, { MAIL_SMTP_USER: undefined });
    const id = (await enqueue())!;
    expect(await deliverNow(env.ctx, id)).toEqual({ state: 'queued', code: 'no_user' });
    expect(JSON.parse((await env.kv.get('mail:transport'))!)).toMatchObject({ code: 'no_user' });
    expect((await row(id)).attempts).toBe(0);
  });

  it('the lease budget counts from before the database time is read', async () => {
    // a retention delete that takes 100 s of the monotonic clock: the lease (2 min) was anchored before it, so only 20 s are left
    let mono = 1_000;
    setMailClockForTests(() => mono);
    const f = await useFake();
    const real = env.ctx.db;
    env.ctx.db = Object.assign(Object.create(real) as typeof real, {
      query: (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === 'string' && sql.startsWith('delete from mail_outbox')) mono += 100_000;
        return (real.query as (...a: unknown[]) => unknown).call(real, sql, ...rest);
      },
    });
    try {
    await enqueue();
    expect(await mailTick(env.ctx, await dbNow())).toEqual({ sent: 0, failed: 0, deferred: 1 });
    expect(f.messages).toHaveLength(0);
    } finally {
      env.ctx.db = real;
    }
  });

  it('deliverNow claims only its row and answers its state', async () => {
    const f = await useFake({ rcpt: (a) => (a.startsWith('gast') ? 550 : null) });
    const other = (await enqueue())!;
    const id = (await enqueue())!;
    expect(await deliverNow(env.ctx, id)).toEqual({ state: 'sent' });
    expect(f.messages).toHaveLength(1);
    expect((await row(other)).state).toBe('queued');
    // already final: its state, nothing sent again
    expect(await deliverNow(env.ctx, id)).toEqual({ state: 'sent' });
    expect(f.messages).toHaveLength(1);
    const refused = (await enqueue({ to: 'gast@friend.example.com', userId: null }))!;
    expect(await deliverNow(env.ctx, refused)).toEqual({ state: 'failed', code: 'recipient_refused', smtp: 550 });
    await f.close();
    fake = await startSmtp({ mode: 'starttls', user: 'kino', pass: 'pw-1', rcpt: () => 451 });
    env.ctx.cfg = { ...env.ctx.cfg, MAIL_SMTP_PORT: fake.port };
    expect(await deliverNow(env.ctx, other)).toEqual({ state: 'queued', code: 'recipient_refused', smtp: 451 });
  });

  it('mailStatus counts and last failure carry no address', async () => {
    await useFake({ rcpt: (a) => (a === ANNA ? 550 : null) });
    expect(await mailStatus(env.ctx)).toEqual({ configured: true, queued: 0, failed24h: 0, lastSentAt: null, lastFailure: null, transport: null, oldestOverdueAt: null });
    await enqueue();
    await enqueue({ to: 'gast@friend.example.com', userId: null });
    await mailTick(env.ctx, await dbNow());
    await enqueue({ params: { token: 'geheim-token-42' } });
    await env.kv.set('mail:transport', JSON.stringify({ code: 'auth', at: new Date().toISOString() }), 3600);
    const s = await mailStatus(env.ctx);
    expect(s).toMatchObject({ configured: true, queued: 1, failed24h: 1, lastFailure: { kind: 'test', code: 'recipient_refused', smtp: 550 }, transport: { code: 'auth' } });
    expect(typeof s.lastSentAt).toBe('string');
    expect(typeof s.oldestOverdueAt).toBe('string');
    expect(typeof s.lastFailure!.at).toBe('string');
    const json = JSON.stringify(s);
    expect(json).not.toContain('anna@');
    expect(json).not.toContain('gast@');
    expect(json).not.toContain('geheim');
    env.ctx.cfg = cfg;
    expect((await mailStatus(env.ctx)).configured).toBe(false);
  });
});
