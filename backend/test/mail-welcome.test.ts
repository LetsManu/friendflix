// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import * as outbox from '../src/mail/outbox.js';
import { welcomeOnce } from '../src/mail/welcome.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Mail stage B, Task 3: the welcome mail goes out once per account ever, claimed by users.welcomed_at (the outbox forgets its rows
// after 30 days, so its dedupe key alone is not "once"). Migration 58 marks every account that exists at the deploy as welcomed.
const MAIL_CFG: Partial<Config> = { MAIL_SMTP_HOST: 'mail.example.com', MAIL_FROM: 'kino@friend.example.com', PUBLIC_URL: 'https://friend.example.com' };

describe('welcome mail', () => {
  let env: TestEnv;
  let n = 0;

  /** a new account (welcomed_at null, as every account created after the deploy) */
  const account = async (o: { email?: string | null; name?: string; createdAt?: Date } = {}) => {
    const id = randomUUID();
    const sub = `sub-welcome-${++n}`;
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, created_at)
       values ($1, $2, $3, $4, 'friend', $5, $2, $6, $7)`,
      [id, sub, o.email === undefined ? `anna${n}@friend.example.com` : o.email, o.name ?? 'Anna Beispiel', sub.padEnd(32, '0'),
        encrypt(env.ctx.encKey, 'pw'), o.createdAt ?? new Date()]);
    await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, `Anna ${n}`]);
    return id;
  };
  const mails = async (userId: string) => (await env.pool.query<{ kind: string; dedupe: string; params_enc: string }>(
    'select kind, dedupe, params_enc from mail_outbox where user_id = $1', [userId])).rows;

  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(() => {
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
  });
  afterEach(() => {
    env.ctx.cfg = cfg;
    vi.restoreAllMocks();
  });

  it('migration 58 marks existing accounts as welcomed', async () => {
    // back to 57: the column does not exist yet, two accounts from before the deploy
    await env.pool.query('alter table users drop column welcomed_at; alter table downloads drop column expiry_warned_at; delete from schema_migrations where version >= 58');
    const a = await account({ createdAt: new Date('2025-03-01T10:00:00Z') });
    const b = await account({ createdAt: new Date('2026-11-01T08:30:00Z') });
    await migrate(env.pool);
    const rows = (await env.pool.query<{ id: string; welcomed_at: Date; created_at: Date }>(
      'select id, welcomed_at, created_at from users where id = any($1) order by created_at', [[a, b]])).rows;
    expect(rows.map((r) => [r.id, r.welcomed_at.toISOString()])).toEqual([[a, '2025-03-01T10:00:00.000Z'], [b, '2026-11-01T08:30:00.000Z']]);
    // the deploy mails nobody: their first sign-in after it finds the claim taken
    expect(await welcomeOnce(env.ctx, a)).toBe(false);
    expect(await mails(a)).toEqual([]);
    // rerunnable, and the licences got their column too
    await env.pool.query('delete from schema_migrations where version >= 58');
    await migrate(env.pool);
    expect((await env.pool.query("select 1 from information_schema.columns where table_name = 'downloads' and column_name = 'expiry_warned_at'")).rowCount).toBe(1);
  });

  it('welcomeOnce queues one welcome and claims once', async () => {
    const id = await account();
    expect(await welcomeOnce(env.ctx, id)).toBe(true);
    const rows = await mails(id);
    expect(rows.map((r) => [r.kind, r.dedupe])).toEqual([['welcome', `welcome:${id}`]]);
    expect(JSON.parse(decrypt(env.ctx.encKey, rows[0]!.params_enc))).toEqual({ name: 'Anna Beispiel' });
    expect((await env.pool.query('select welcomed_at from users where id = $1 and welcomed_at is not null', [id])).rowCount).toBe(1);
    expect(await welcomeOnce(env.ctx, id)).toBe(false);
    expect(await mails(id)).toHaveLength(1);
    // two sign-ins at the same moment (two instances): exactly one claims it
    const other = await account();
    expect((await Promise.all([welcomeOnce(env.ctx, other), welcomeOnce(env.ctx, other), welcomeOnce(env.ctx, other)])).filter(Boolean)).toHaveLength(1);
    expect(await mails(other)).toHaveLength(1);
  });

  it('welcome is claimed without an address or without mail set up', async () => {
    const noAddress = await account({ email: null });
    expect(await welcomeOnce(env.ctx, noAddress)).toBe(true);
    expect(await mails(noAddress)).toEqual([]);
    expect(await welcomeOnce(env.ctx, noAddress)).toBe(false);
    env.ctx.cfg = cfg;
    const notSetUp = await account();
    expect(await welcomeOnce(env.ctx, notSetUp)).toBe(true);
    expect(await mails(notSetUp)).toEqual([]);
    // mail set up later: the account was welcomed already, nothing is sent
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
    expect(await welcomeOnce(env.ctx, notSetUp)).toBe(false);
    expect(await mails(notSetUp)).toEqual([]);
  });

  // fix round 1: a database error while queueing gives the claim back, so the next sign-in welcomes again (the outbox key
  // `welcome:<id>` still stops a second mail if the row did land)
  it('a failed enqueue gives the welcome claim back', async () => {
    const id = await account();
    vi.spyOn(outbox, 'enqueueMail').mockRejectedValueOnce(new Error('outbox down'));
    await expect(welcomeOnce(env.ctx, id)).rejects.toThrow('outbox down');
    expect((await env.pool.query('select welcomed_at from users where id = $1', [id])).rows[0].welcomed_at).toBeNull();
    expect(await mails(id)).toEqual([]);
    expect(await welcomeOnce(env.ctx, id)).toBe(true);
    expect((await mails(id)).map((r) => r.dedupe)).toEqual([`welcome:${id}`]);
    expect(await welcomeOnce(env.ctx, id)).toBe(false);
  });
});
