// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config.js';
import { inTransaction, longQuery, migrate, poolOptions, probeQuery, PROBE_GRACE_MS } from '../src/db.js';
import { buildSnapshot } from '../src/health.js';
import { cfg, makeEnv, resetDb, TEST_DB, type TestEnv } from './helpers.js';

// Database pool limits (DB_*_TIMEOUT_MS) and probes that cancel their query instead of only giving up waiting for it.

const limits = (o: Partial<Pick<typeof cfg, 'DB_CONNECT_TIMEOUT_MS' | 'DB_STATEMENT_TIMEOUT_MS' | 'DB_IDLE_TX_TIMEOUT_MS'>> = {}) =>
  ({ DATABASE_URL: TEST_DB, DB_CONNECT_TIMEOUT_MS: 5_000, DB_STATEMENT_TIMEOUT_MS: 30_000, DB_IDLE_TX_TIMEOUT_MS: 300_000, ...o });
const pools: pg.Pool[] = [];
const open = (o: Parameters<typeof limits>[0] = {}, max = 2) => {
  const p = new pg.Pool(poolOptions(limits(o), max));
  pools.push(p);
  return p;
};
const idle = (p: pg.Pool) => p.idleCount === p.totalCount && p.waitingCount === 0;
const elapsed = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  const r = await fn().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  return { ...r, ms: performance.now() - t0 };
};
const setting = async (c: pg.Pool | pg.PoolClient, name: string) => (await c.query<{ s: string }>('select current_setting($1) s', [name])).rows[0]!.s;

beforeAll(async () => {
  (await resetDb()).end();
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe('config', () => {
  it('defaults: connect 5 s, statement 30 s, idle in transaction 5 min, long statements 10 min; empty = default; 0 = no limit', () => {
    const sh = configSchema.shape;
    const parse = (k: 'DB_CONNECT_TIMEOUT_MS' | 'DB_STATEMENT_TIMEOUT_MS' | 'DB_IDLE_TX_TIMEOUT_MS' | 'DB_LONG_STATEMENT_TIMEOUT_MS', v?: string) => sh[k].safeParse(v);
    expect(['DB_CONNECT_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS', 'DB_IDLE_TX_TIMEOUT_MS', 'DB_LONG_STATEMENT_TIMEOUT_MS'].map((k) => parse(k as 'DB_CONNECT_TIMEOUT_MS').data))
      .toEqual([5000, 30000, 300000, 600000]);
    expect(parse('DB_STATEMENT_TIMEOUT_MS', '').data).toBe(30000); // compose passes '' for an unset variable
    expect(parse('DB_STATEMENT_TIMEOUT_MS', '0').data).toBe(0);
    expect(parse('DB_IDLE_TX_TIMEOUT_MS', '1500').data).toBe(1500);
    expect(parse('DB_STATEMENT_TIMEOUT_MS', '-1').success).toBe(false);
    expect(parse('DB_CONNECT_TIMEOUT_MS', 'soon').success).toBe(false);
    expect(parse('DB_LONG_STATEMENT_TIMEOUT_MS', '1.5').success).toBe(false);
  });

  it('poolOptions: limits as pg options; 0 leaves the server default (no limit)', () => {
    expect(poolOptions(limits(), 7)).toEqual({
      connectionString: TEST_DB, max: 7, connectionTimeoutMillis: 5000, statement_timeout: 30000, idle_in_transaction_session_timeout: 300000,
    });
    const off = poolOptions(limits({ DB_STATEMENT_TIMEOUT_MS: 0, DB_IDLE_TX_TIMEOUT_MS: 0 }));
    expect(off).not.toHaveProperty('statement_timeout');
    expect(off).not.toHaveProperty('idle_in_transaction_session_timeout');
  });
});

describe('pool limits', () => {
  it('Postgres cancels a statement past DB_STATEMENT_TIMEOUT_MS and the connection goes back to the pool', async () => {
    const p = open({ DB_STATEMENT_TIMEOUT_MS: 200, DB_IDLE_TX_TIMEOUT_MS: 1500 });
    expect(await setting(p, 'statement_timeout')).toBe('200ms');
    expect(await setting(p, 'idle_in_transaction_session_timeout')).toBe('1500ms');
    const r = await elapsed(() => p.query('select pg_sleep(5)'));
    expect(r.ok).toBe(false);
    expect((r as { e: { code?: string } }).e.code).toBe('57014'); // query_canceled
    expect(r.ms).toBeLessThan(2000);
    expect(idle(p)).toBe(true);
    expect((await p.query('select 1 as one')).rows[0].one).toBe(1);
  });

  it('a session left idle inside a transaction is ended by the server after DB_IDLE_TX_TIMEOUT_MS', async () => {
    const p = open({ DB_IDLE_TX_TIMEOUT_MS: 200 });
    const c = await p.connect();
    c.on('error', () => undefined); // the server's FATAL arrives as a client error event
    await c.query('begin');
    await new Promise((r) => setTimeout(r, 600));
    await expect(c.query('select 1')).rejects.toThrow();
    c.release(true);
    expect((await p.query('select 1 as one')).rows[0].one).toBe(1);
  });

  it('a full pool answers after DB_CONNECT_TIMEOUT_MS instead of waiting forever', async () => {
    const p = open({ DB_CONNECT_TIMEOUT_MS: 200 }, 1);
    const held = await p.connect();
    const r = await elapsed(() => p.query('select 1'));
    expect(r.ok).toBe(false);
    expect(r.ms).toBeLessThan(1500);
    held.release();
    expect(idle(p)).toBe(true);
  });
});

describe('probeQuery', () => {
  it('a probe against pg_sleep(5) returns within its bound and its connection is back in the pool (idle, pool limit restored)', async () => {
    const p = open({}, 2);
    const r = await elapsed(() => probeQuery(p, 'select pg_sleep(5)', [], 300));
    expect(r.ok).toBe(false);
    expect(r.ms).toBeLessThan(300 + PROBE_GRACE_MS);
    expect(p.totalCount).toBe(1);
    expect(idle(p)).toBe(true);
    // the same connection, healthy and back on the pool's own statement limit (SET LOCAL ended with the transaction)
    const c = await p.connect();
    try {
      expect(await setting(c, 'statement_timeout')).toBe('30s');
      expect(await setting(c, 'transaction_isolation')).toBeTruthy();
      expect((await c.query('select 1 as one')).rows[0].one).toBe(1);
    } finally {
      c.release();
    }
    // nothing keeps running on the server
    const active = await p.query("select count(*)::int n from pg_stat_activity where datname = current_database() and query like 'select pg_sleep(5)%' and state = 'active'");
    expect(active.rows[0].n).toBe(0);
  });

  it('a probe that answers in time returns its rows', async () => {
    const p = open();
    const r = await probeQuery<{ n: number }>(p, 'select $1::int + 1 as n', [41], 1000);
    expect(r.rows[0]!.n).toBe(42);
    expect(idle(p)).toBe(true);
  });

  it('repeated probes against a stalled table never exhaust the pool; a normal query still runs', async () => {
    const p = open({}, 2);
    const locker = new pg.Client({ connectionString: TEST_DB });
    await locker.connect();
    try {
      await locker.query('create table if not exists probe_stall(x int)');
      await locker.query('begin');
      await locker.query('lock table probe_stall in access exclusive mode');
      // more refreshes than the pool has connections ("Jetzt prüfen" 6/min + the snapshot tick)
      for (let i = 0; i < 3; i++) {
        const rs = await Promise.all([1, 2].map(() => elapsed(() => probeQuery(p, 'select count(*) from probe_stall', [], 200))));
        for (const r of rs) {
          expect(r.ok).toBe(false);
          expect(r.ms).toBeLessThan(200 + PROBE_GRACE_MS);
        }
        await vi.waitFor(() => expect(idle(p)).toBe(true), { timeout: 1000 });
      }
      const r = await elapsed(() => p.query('select 1'));
      expect(r.ok).toBe(true);
      expect(r.ms).toBeLessThan(500);
      const waiting = await p.query("select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      expect(waiting.rows[0].n).toBe(0);
    } finally {
      await locker.query('rollback').catch(() => undefined);
      await locker.end();
    }
  });

  it('a connection that only frees up after the bound is handed back unused', async () => {
    const p = open({}, 1);
    const held = await p.connect();
    setTimeout(() => held.release(), 300);
    const r = await elapsed(() => probeQuery(p, 'select 1', [], 100));
    expect(r.ok).toBe(false);
    expect(idle(p)).toBe(true);
    expect(p.totalCount).toBe(1);
  });

  it('a server that does not answer at all: the probe gives up after the grace and its connection is dropped, not pooled', async () => {
    const released: Array<unknown> = [];
    const client = {
      query: (sql: string) => (sql.includes('pg_sleep') ? new Promise(() => undefined) : Promise.resolve({ rows: [] })),
      release: (err?: unknown) => { released.push(err); },
    };
    const fake = { query: () => Promise.reject(new Error('unused')), connect: async () => client } as unknown as pg.Pool;
    vi.useFakeTimers();
    try {
      const pr = probeQuery(fake, 'select pg_sleep(5)', [], 100).then(() => 'ok', () => 'failed');
      await vi.advanceTimersByTimeAsync(100 + PROBE_GRACE_MS + 1);
      expect(await pr).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error); // pg-pool closes a connection released with an error
  });

  it('a Db without connect() (a test double) runs the query as is', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ n: 1 }] })) } as unknown as pg.Pool;
    expect((await probeQuery(db, 'select 1 n', [], 100)).rows).toEqual([{ n: 1 }]);
  });
});

describe('long statements and migrations', () => {
  it('longQuery runs with DB_LONG_STATEMENT_TIMEOUT_MS past the pool limit; the connection goes back with the pool limit', async () => {
    const p = open({ DB_STATEMENT_TIMEOUT_MS: 100 }, 1);
    await expect(p.query('select pg_sleep(0.4)')).rejects.toMatchObject({ code: '57014' });
    const ctx = { db: p, cfg: { DB_LONG_STATEMENT_TIMEOUT_MS: 5000 } };
    await expect(longQuery(ctx, 'select pg_sleep(0.4)')).resolves.toBeTruthy();
    expect((await longQuery<{ s: string }>(ctx, 'select current_setting($1) s', ['statement_timeout'])).rows[0]!.s).toBe('5s');
    expect(await setting(p, 'statement_timeout')).toBe('100ms');
    // 0 = no limit
    expect((await longQuery<{ s: string }>({ db: p, cfg: { DB_LONG_STATEMENT_TIMEOUT_MS: 0 } }, 'select current_setting($1) s', ['statement_timeout'])).rows[0]!.s).toBe('0');
    expect(idle(p)).toBe(true);
  });

  it('inTransaction: commits, rolls back on a throw, and applies its own statement limit', async () => {
    const p = open({ DB_STATEMENT_TIMEOUT_MS: 100 }, 1);
    await p.query('create table if not exists tx_probe(x int)');
    await p.query('truncate tx_probe');
    await inTransaction(p, async (c) => { await c.query('select pg_sleep(0.3)'); await c.query('insert into tx_probe values (1)'); }, { statementTimeoutMs: 5000 });
    await expect(inTransaction(p, async (c) => { await c.query('insert into tx_probe values (2)'); throw new Error('no'); })).rejects.toThrow('no');
    expect((await p.query('select array_agg(x) xs from tx_probe')).rows[0].xs).toEqual([1]);
    expect(idle(p)).toBe(true);
  });

  it('migrate runs without the pool statement limit (it may wait for another instance\'s migration lock) and restores it', async () => {
    const p = open({ DB_STATEMENT_TIMEOUT_MS: 150 }, 1);
    const other = new pg.Client({ connectionString: TEST_DB });
    await other.connect();
    try {
      await other.query('select pg_advisory_lock(727274)');
      setTimeout(() => void other.query('select pg_advisory_unlock(727274)'), 500);
      const r = await elapsed(() => migrate(p));
      expect(r.ok).toBe(true);
      expect(r.ms).toBeGreaterThanOrEqual(400);
    } finally {
      await other.end();
    }
    expect(await setting(p, 'statement_timeout')).toBe('150ms');
    expect(idle(p)).toBe(true);
  });
});

describe('health snapshot against a stalled database', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.close();
  });
  afterEach(() => vi.useRealTimers());

  it('returns within the probe bound and leaves no connection or query behind', async () => {
    const locker = new pg.Client({ connectionString: TEST_DB });
    await locker.connect();
    try {
      await locker.query('begin');
      // every table a snapshot counts in Postgres is locked: its queries wait (as with a stalled database)
      await locker.query('lock table approval_requests, download_jobs, preview_clips, playback_checks in access exclusive mode');
      const statfs = async () => ({ bsize: 4096, blocks: 1000, bavail: 500 });
      const stat = async () => ({ dev: 1 });
      for (let i = 0; i < 3; i++) {
        const r = await elapsed(() => buildSnapshot(env.ctx, { fetchImpl: async () => new Response('{}'), statfs, stat, timeoutMs: 300 }));
        expect(r.ok).toBe(true);
        expect(r.ms).toBeLessThan(300 + PROBE_GRACE_MS + 500);
        const s = (r as { v: Awaited<ReturnType<typeof buildSnapshot>> }).v;
        expect(s.services.find((x) => x.id === 'postgres')?.level).toBe('ok'); // select 1 needs no lock
        expect(s.services.find((x) => x.id === 'playbackCheck')).toMatchObject({ level: 'off', reason: 'unavailable' });
        await vi.waitFor(() => expect(idle(env.pool)).toBe(true), { timeout: 1500 });
      }
      const waiting = await env.pool.query("select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      expect(waiting.rows[0].n).toBe(0);
    } finally {
      await locker.query('rollback').catch(() => undefined);
      await locker.end();
    }
  });
});
