import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import { jobFailed, listErrors, recentCount, recordError, resetErrorLogForTests } from '../src/errorlog.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// Block 22 Task 1: migration 35, the aggregated error log (server 5xx + job failures in Redis, client + playback reports in
// process memory only) and GET /api/admin/errors.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let adminId = '';
const ID = '0123456789abcdef0123456789abcdef';

const as = (s: Sess, method: string, url: string) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });
let ipSeq = 0;
const beacon = (payload: unknown) =>
  env.app.inject({ method: 'POST', url: '/api/client-errors', payload: JSON.stringify(payload), headers: { 'content-type': 'text/plain;charset=UTF-8' }, remoteAddress: `10.9.0.${++ipSeq}` });

beforeAll(async () => {
  env = await makeEnv({}, {
    register: [(app) => {
      app.get('/api/boom/:id', async () => { throw new Error('kaputt http://jellyfin:8096/x?api_key=abc'); });
    }],
  });
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend','jffritz','Fritz',$1)", [encrypt(env.ctx.encKey, 'pw')]);
});
afterAll(() => env.close());
beforeEach(async () => {
  resetErrorLogForTests();
  for (const k of await env.kv.keys('errlog:')) await env.kv.del(k);
});

describe('migration 35', () => {
  const TABLES = ['play_daily', 'hygiene_items', 'hygiene_ignored', 'health_dismissals'];
  const INDEXES = ['play_daily_day', 'hygiene_items_issues', 'hygiene_items_type', 'hygiene_items_series', 'hygiene_items_ids', 'hygiene_items_title', 'hygiene_items_episode'];
  const present = async () => {
    const t = await env.pool.query<{ t: string }>("select table_name t from information_schema.tables where table_schema='public' and table_name = any($1)", [TABLES]);
    const i = await env.pool.query<{ i: string }>("select indexname i from pg_indexes where schemaname='public' and indexname = any($1)", [INDEXES]);
    return { tables: t.rows.map((r) => r.t).sort(), indexes: i.rows.map((r) => r.i).sort() };
  };
  it('applies on a fresh db and on a db at 34 (tables + indexes exist)', async () => {
    expect(await present()).toEqual({ tables: [...TABLES].sort(), indexes: [...INDEXES].sort() });
    // back to 34, then migrate again
    await env.pool.query(`drop table ${TABLES.join(', ')}; delete from schema_migrations where version = 35`);
    expect((await present()).tables).toEqual([]);
    await migrate(env.pool as never);
    expect(await present()).toEqual({ tables: [...TABLES].sort(), indexes: [...INDEXES].sort() });
    expect((await env.pool.query('select max(version) v from schema_migrations')).rows[0].v).toBe(35);
  });
});

describe('server errors', () => {
  it('a 500 from a route with an id param records "GET /api/boom/:id 500", never the concrete id or query', async () => {
    const r = await env.app.inject({ url: `/api/boom/${ID}?token=secret123` });
    expect(r.statusCode).toBe(500);
    await new Promise((res) => setTimeout(res, 20)); // onResponse records after the reply
    const { entries } = await listErrors(env.ctx, {});
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'server', code: 'GET /api/boom/:id 500', count: 1 });
    const json = JSON.stringify(entries);
    expect(json).not.toContain(ID);
    expect(json).not.toContain('secret123');
    expect(json).not.toContain('jellyfin:8096');
    expect((await env.kv.keys('errlog:server:')).length).toBe(1); // server errors may live in Redis
  });

  it('kv ttl of an entry is about 604800 s; recentCount(server, 15) counts only the last 15 min', async () => {
    const now = Date.now();
    await recordError(env.ctx, { source: 'server', code: 'GET /api/a 500' }, now - 20 * 60_000);
    await recordError(env.ctx, { source: 'server', code: 'GET /api/a 500' }, now - 10 * 60_000);
    await recordError(env.ctx, { source: 'server', code: 'GET /api/b 502' }, now - 60_000);
    const key = (await env.kv.keys('errlog:server:'))[0]!;
    const exp = (env.kv as unknown as { m: Map<string, { exp: number }> }).m.get(key)!.exp;
    expect(Math.abs((exp - Date.now()) / 1000 - 604800)).toBeLessThan(5);
    expect(await recentCount(env.ctx, 'server', 15, now)).toBe(2);
    expect(await recentCount(env.ctx, 'server', 60, now)).toBe(3);
  });

  it('301st fingerprint is not stored, overflow 1', async () => {
    for (let i = 0; i < 300; i++) await recordError(env.ctx, { source: 'server', code: `GET /api/r${i} 500` });
    await recordError(env.ctx, { source: 'server', code: 'GET /api/r300 500' });
    await recordError(env.ctx, { source: 'server', code: 'GET /api/r0 500' }); // a known one still counts
    const { entries, overflow } = await listErrors(env.ctx, { limit: 1000 });
    expect(entries).toHaveLength(300);
    expect(overflow).toBe(1);
    expect(entries.find((e) => e.code === 'GET /api/r0 500')!.count).toBe(2);
  });
});

describe('job failures', () => {
  it('a job failure in a tick catch records source job with the job name', async () => {
    const warned: unknown[] = [];
    jobFailed(env.ctx, { warn: (o: unknown) => warned.push(o) }, 'preview-warm', 'preview warm failed')(new Error('fetch failed http://jellyfin:8096/?api_key=zz'));
    await new Promise((res) => setTimeout(res, 10));
    expect(warned).toHaveLength(1);
    const { entries } = await listErrors(env.ctx, { source: 'job' });
    expect(entries).toEqual([expect.objectContaining({ source: 'job', code: 'preview-warm', count: 1 })]);
    expect(JSON.stringify(entries)).not.toContain('api_key');
  });
});

describe('client and playback reports (memory only)', () => {
  const body = (over: Record<string, unknown> = {}) => ({ message: 'x is not a function', url: '/item/abc', userAgent: 'UA-Secret/1', kind: 'error', release: 'abc1234', ...over });

  it('two identical client errors → one entry with count 2; a message with ?token=abc and an e-mail is scrubbed in sample', async () => {
    const msg = 'failed GET /api/x?token=abc for max@example.com';
    expect((await beacon(body({ message: msg }))).statusCode).toBe(204);
    expect((await beacon(body({ message: msg }))).statusCode).toBe(204);
    const { entries } = await listErrors(env.ctx, { source: 'client' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'client', count: 2, release: 'abc1234' });
    const json = JSON.stringify(entries);
    expect(json).not.toContain('token=abc');
    expect(json).not.toContain('max@example.com');
    expect(entries[0]!.sample).toContain('[email]');
    // never written to Redis
    expect(await env.kv.keys('errlog:client')).toEqual([]);
  });

  it('playback report {kind:"playback", itemId, code} → 204 and an entry of source playback with itemId; bad itemId → 400', async () => {
    expect((await beacon(body({ kind: 'playback', itemId: ID, code: 'bufferStalledError', message: 'fatal media error' }))).statusCode).toBe(204);
    const { entries } = await listErrors(env.ctx, { source: 'playback' });
    expect(entries).toEqual([expect.objectContaining({ source: 'playback', itemId: ID, code: 'bufferStalledError', count: 1 })]);
    expect((await beacon(body({ kind: 'playback', itemId: 'not-an-id', code: 'x' }))).statusCode).toBe(400);
    expect((await beacon(body({ kind: 'playback', itemId: ID, code: 'bad code!' }))).statusCode).toBe(400);
    expect((await beacon(body({ kind: 'playback', itemId: ID, code: 'x'.repeat(61) }))).statusCode).toBe(400);
    expect(await env.kv.keys('errlog:playback')).toEqual([]);
    expect(await recentCount(env.ctx, 'playback', 60)).toBe(1);
  });

  it('an entry has no user id, ip or user agent (JSON contains none of the test values)', async () => {
    const me = await env.login(ADMIN);
    await env.app.inject({ method: 'POST', url: '/api/client-errors', payload: JSON.stringify(body()), headers: { 'content-type': 'text/plain' }, cookies: me.cookies, remoteAddress: '10.77.66.55' });
    const { entries } = await listErrors(env.ctx, {});
    expect(entries).toHaveLength(1);
    const json = JSON.stringify(entries);
    for (const v of [adminId, '10.77.66.55', 'UA-Secret', 'userId', 'ip', 'userAgent']) expect(json).not.toContain(v);
  });
});

describe('GET /api/admin/errors', () => {
  it('admin 200 sorted by lastAt desc, filter by source and hours', async () => {
    const now = Date.now();
    await recordError(env.ctx, { source: 'server', code: 'GET /api/old 500' }, now - 3 * 3600_000);
    await recordError(env.ctx, { source: 'job', code: 'digest' }, now - 60_000);
    await recordError(env.ctx, { source: 'client', code: 'error boom', sample: 'boom' }, now - 30_000);
    const r = await as(admin, 'GET', '/api/admin/errors');
    expect(r.statusCode).toBe(200);
    expect(r.json().entries.map((e: { code: string }) => e.code)).toEqual(['error boom', 'digest', 'GET /api/old 500']);
    expect(r.json().overflow).toBe(0);
    expect((await as(admin, 'GET', '/api/admin/errors?hours=1')).json().entries).toHaveLength(2);
    expect((await as(admin, 'GET', '/api/admin/errors?source=job')).json().entries.map((e: { code: string }) => e.code)).toEqual(['digest']);
    expect((await as(admin, 'GET', '/api/admin/errors?hours=0')).statusCode).toBe(400);
    expect((await as(admin, 'GET', '/api/admin/errors?hours=169')).statusCode).toBe(400);
    expect((await as(admin, 'GET', '/api/admin/errors?source=nope')).statusCode).toBe(400);
  });

  it('friend 403; admin on a non-owner profile 403; no session 401', async () => {
    const fritz = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
    expect((await as(fritz, 'GET', '/api/admin/errors')).statusCode).toBe(403);
    const s = await env.login(ADMIN);
    const pid = randomUUID();
    await env.pool.query('insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, $3, false, false, $4)', [pid, adminId, 'Gast', 'f'.repeat(32)]);
    const raw = JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!);
    await env.kv.set(`sess:${s.cookies.ff_sid}`, JSON.stringify({ ...raw, profileId: pid }), 600);
    expect((await as(s, 'GET', '/api/admin/errors')).statusCode).toBe(403);
    await env.pool.query('delete from profiles where id=$1', [pid]);
    expect((await env.app.inject({ url: '/api/admin/errors' })).statusCode).toBe(401);
  });
});
