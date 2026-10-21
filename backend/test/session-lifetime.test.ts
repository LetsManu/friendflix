// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Stay signed in like a streaming service: 90-day session defaults, and migration 42 that moves stored old defaults (8 h / 2 h,
// e.g. copied from the environment with "Move to settings") to the new ones, while a value an admin chose stays.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import { migrate, MIGRATIONS } from '../src/db.js';
import { ENC_KEY, makeEnv, resetDb, type TestEnv } from './helpers.js';
import { keyFromBase64 } from '../src/crypto.js';
import { readRows, writeRows } from '../src/settings/repo.js';

const DAYS_90 = 90 * 86400;

describe('session defaults', () => {
  it('absolute lifetime and idle timeout are 90 days unless set', () => {
    expect(configSchema.shape.SESSION_TTL_SECONDS.parse(undefined)).toBe(DAYS_90);
    expect(configSchema.shape.SESSION_IDLE_SECONDS.parse(undefined)).toBe(DAYS_90);
  });
});

describe('migration 42: old session defaults', () => {
  let pool: pg.Pool;
  const encKey = keyFromBase64(ENC_KEY);
  beforeAll(async () => { pool = await resetDb(); });
  afterAll(async () => { await pool.end(); });

  const rewind = () => pool.query('delete from schema_migrations where version >= 42');
  const stored = async () => Object.fromEntries((await readRows(pool)).rows.map((r) => [r.key, r.value]));

  it('is migration 42 and names both keys', () => {
    expect(MIGRATIONS[41]).toContain('SESSION_TTL_SECONDS');
    expect(MIGRATIONS[41]).toContain('SESSION_IDLE_SECONDS');
  });

  it('a stored value equal to the old default (8 h / 2 h) is removed, so the new default applies; rev is bumped', async () => {
    await writeRows(pool, encKey, { SESSION_TTL_SECONDS: 28800, SESSION_IDLE_SECONDS: 7200, CAST_ENABLED: false }, null);
    const before = (await readRows(pool)).rev;
    await rewind();
    await migrate(pool);
    expect(await stored()).toEqual({ CAST_ENABLED: false });
    expect((await readRows(pool)).rev).toBeGreaterThan(before);
    // audited like a save, by the system (no actor), key names only
    expect((await pool.query("select actor, target, meta from audit_log where action = 'settings.update'")).rows)
      .toEqual([{ actor: null, target: null, meta: { keys: ['SESSION_IDLE_SECONDS', 'SESSION_TTL_SECONDS'], reason: 'session_defaults' } }]);
  });

  it('a value the admin chose stays (also the other key\'s old default, and a string form is matched exactly)', async () => {
    await pool.query('delete from settings; delete from audit_log');
    await writeRows(pool, encKey, { SESSION_TTL_SECONDS: 7200, SESSION_IDLE_SECONDS: 28800 }, null);
    const rev = (await readRows(pool)).rev;
    await rewind();
    await migrate(pool);
    expect(await stored()).toEqual({ SESSION_TTL_SECONDS: 7200, SESSION_IDLE_SECONDS: 28800 });
    // nothing removed: no revision, no audit entry
    expect((await readRows(pool)).rev).toBe(rev);
    expect((await pool.query("select 1 from audit_log where action = 'settings.update'")).rowCount).toBe(0);

    await pool.query('delete from settings');
    await writeRows(pool, encKey, { SESSION_TTL_SECONDS: 28801, SESSION_IDLE_SECONDS: 3600 }, null);
    await pool.query(`insert into settings(key, value) values ('HEALTH_DB_WARN_GB', '28800')`);
    await rewind();
    await migrate(pool);
    expect(await stored()).toEqual({ SESSION_TTL_SECONDS: 28801, SESSION_IDLE_SECONDS: 3600, HEALTH_DB_WARN_GB: 28800 });

    await pool.query('delete from settings');
    await pool.query(`insert into settings(key, value) values ('SESSION_TTL_SECONDS', '"28800"'), ('SESSION_IDLE_SECONDS', '"7200"')`);
    await rewind();
    await migrate(pool);
    expect(await stored()).toEqual({});
  });

  it('runs once: an admin who sets 8 h again afterwards keeps it', async () => {
    await writeRows(pool, encKey, { SESSION_TTL_SECONDS: 28800 }, null);
    await migrate(pool);
    expect(await stored()).toEqual({ SESSION_TTL_SECONDS: 28800 });
  });
});

describe('the session cookie and the stored session follow the effective settings', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(() => env.close());

  it('a sign-in uses the saved lifetime for the cookie (absolute) and the kv entry (idle)', async () => {
    await env.ctx.settings.save({ SESSION_TTL_SECONDS: DAYS_90, SESSION_IDLE_SECONDS: 5 * 86400 }, null);
    const ttls: Array<[string, number | undefined]> = [];
    const set = env.kv.set.bind(env.kv);
    env.kv.set = async (k: string, v: string, ttl?: number) => { ttls.push([k, ttl]); return set(k, v, ttl); };
    const l = await env.app.inject('/auth/login?classic=1');
    const state = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, cookies: { ff_oidc: state } });
    expect(cb.statusCode).toBe(302);
    const sid = cb.cookies.find((x) => x.name === 'ff_sid')!;
    expect(sid.maxAge).toBe(DAYS_90);
    expect(ttls.find(([k]) => k === `sess:${sid.value}`)?.[1]).toBe(5 * 86400);
  });
});
