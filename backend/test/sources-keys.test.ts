import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt, encrypt, keyFromBase64 } from '../src/crypto.js';
import { getSourceKey, INVALID_KEY, PAUSE_KEY } from '../src/sources/keys.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

const KEY = 'tmdbsecretkey1234';
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
const call = (e: TestEnv, a: typeof admin | null, method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown) =>
  e.app.inject({ method, url, cookies: a?.cookies, headers: a ? { 'x-csrf-token': a.csrf } : {}, payload: payload as object });

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
});
afterAll(() => env.close());

describe('source keys', () => {
  it('PUT stores the key encrypted', async () => {
    const r = await call(env, admin, 'PUT', '/api/admin/sources/tmdb', { key: KEY });
    expect(r.statusCode).toBe(200);
    const row = (await env.pool.query("select * from app_settings where key='source.tmdb'")).rows[0];
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(decrypt(keyFromBase64(ENC_KEY), row.value.enc)).toBe(KEY);
    expect(row.value.last4).toBe(KEY.slice(-4));
  });

  it('responses never contain the key', async () => {
    const bodies = [
      (await call(env, admin, 'PUT', '/api/admin/sources/tmdb', { key: KEY })).body,
      (await call(env, admin, 'GET', '/api/admin/sources/tmdb')).body,
      (await call(env, admin, 'GET', '/api/admin/sources')).body,
    ];
    for (const b of bodies) expect(b).not.toContain(KEY);
    const j = JSON.parse(bodies[1]!);
    expect(j).toMatchObject({ name: 'tmdb', set: true, last4: KEY.slice(-4), from: 'db', invalid: false });
    const all = JSON.parse(bodies[2]!).sources;
    expect(all.map((s: any) => s.name)).toEqual(['tmdb', 'omdb']);
    expect(all[1]).toMatchObject({ set: false, last4: null, from: null, usedToday: 0, budget: 900 });
    const del = await call(env, admin, 'DELETE', '/api/admin/sources/tmdb');
    expect(del.body).not.toContain(KEY);
    expect(del.json()).toMatchObject({ set: false, from: null });
    expect(await getSourceKey(env.ctx, 'tmdb')).toBeNull();
  });

  it('a key from the environment/file wins: 409 and getSourceKey returns it', async () => {
    const orig = env.ctx.cfg; // same app and database: the routes read ctx.cfg live
    try {
      env.ctx.cfg = { ...orig, TMDB_API_KEY: 'filekey-abcdef99' };
      const a = admin;
      const fileEnv = env;
      await fileEnv.pool.query("insert into app_settings(key, value) values ('source.tmdb', $1)", [JSON.stringify({ enc: encrypt(fileEnv.ctx.encKey, 'dbkey-zzzzzzzz'), last4: 'zzzz', updatedAt: 'x' })]);
      const put = await call(fileEnv, a, 'PUT', '/api/admin/sources/tmdb', { key: KEY });
      expect(put.statusCode).toBe(409);
      expect(put.json()).toEqual({ error: 'from_file' });
      expect((await call(fileEnv, a, 'DELETE', '/api/admin/sources/tmdb')).statusCode).toBe(409);
      expect(await getSourceKey(fileEnv.ctx, 'tmdb')).toEqual({ key: 'filekey-abcdef99', from: 'file' });
      const st = await call(fileEnv, a, 'GET', '/api/admin/sources/tmdb');
      expect(st.json()).toMatchObject({ set: true, from: 'file', last4: 'ef99' });
      expect(st.body).not.toContain('filekey-abcdef99');
      await env.pool.query("delete from app_settings where key='source.tmdb'");
    } finally {
      env.ctx.cfg = orig;
      await env.pool.query("delete from app_settings where key='source.tmdb'");
    }
  });

  it('a stored key that no longer decrypts is reported as invalid, not as set', async () => {
    const other = Buffer.alloc(32, 9);
    await env.pool.query("delete from app_settings where key='source.omdb'");
    await env.pool.query("insert into app_settings(key, value) values ('source.omdb', $1)", [JSON.stringify({ enc: encrypt(other, 'omdbkey-12345678'), last4: '5678', updatedAt: 'x' })]);
    try {
      const j = (await call(env, admin, 'GET', '/api/admin/sources/omdb')).json();
      expect(j).toMatchObject({ set: false, from: null, last4: null, invalid: true });
    } finally {
      await env.pool.query("delete from app_settings where key='source.omdb'");
      await call(env, admin, 'DELETE', '/api/admin/sources/omdb');
    }
  });

  it('is admin only: friend 403, no session 401', async () => {
    const id = (await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'bob', 'b@x.de', 'Bob', 'guest', $1, 'bob', $2) returning id`,
      ['1'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')],
    )).rows[0].id;
    const sid = `bob-session-${'x'.repeat(30)}`;
    await env.kv.set(`sess:${sid}`, JSON.stringify({ userId: id, csrf: 'bobcsrf', deviceId: 'd', deviceApproved: true, createdAt: Date.now(), touchedAt: Date.now() }), 600);
    const friend = { cookies: { ff_sid: sid }, csrf: 'bobcsrf' };
    const reqs: Array<['GET' | 'PUT' | 'DELETE' | 'POST', string, unknown?]> = [
      ['GET', '/api/admin/sources'], ['GET', '/api/admin/sources/tmdb'], ['PUT', '/api/admin/sources/tmdb', { key: KEY }],
      ['DELETE', '/api/admin/sources/tmdb'], ['POST', '/api/admin/sources/tmdb/test', {}],
    ];
    for (const [m, u, p] of reqs) {
      expect((await call(env, friend, m, u, p)).statusCode, `${m} ${u} friend`).toBe(403);
      expect((await call(env, null, m, u, p)).statusCode, `${m} ${u} anon`).toBe(401);
    }
  });

  it('audits source.set / source.remove without the key', async () => {
    await env.pool.query('delete from audit_log');
    await call(env, admin, 'PUT', '/api/admin/sources/omdb', { key: 'omdbsecret9876' });
    await call(env, admin, 'DELETE', '/api/admin/sources/omdb');
    const rows = (await env.pool.query("select action, meta from audit_log where action like 'source.%' order by id")).rows;
    expect(rows.map((r) => r.action)).toEqual(['source.set', 'source.remove']);
    for (const r of rows) expect(r.meta).toEqual({ name: 'omdb' });
    expect(JSON.stringify(rows)).not.toContain('omdbsecret9876');
  });

  it('PUT and DELETE clear pause, invalid flag and cached answers', async () => {
    for (const method of ['PUT', 'DELETE'] as const) {
      await env.kv.set(PAUSE_KEY('tmdb'), '1', 600);
      await env.kv.set(INVALID_KEY('tmdb'), '1', 600);
      await env.kv.set('ext:tmdb:movie:1', '{}', 600);
      await env.kv.set('ext:omdb:tt1', '{}', 600);
      await call(env, admin, method, '/api/admin/sources/tmdb', method === 'PUT' ? { key: KEY } : undefined);
      expect(await env.kv.get(PAUSE_KEY('tmdb'))).toBeNull();
      expect(await env.kv.get(INVALID_KEY('tmdb'))).toBeNull();
      expect(await env.kv.keys('ext:tmdb:')).toEqual([]);
      expect(await env.kv.get('ext:omdb:tt1')).toBe('{}');
    }
  });

  it('validates name and key', async () => {
    expect((await call(env, admin, 'GET', '/api/admin/sources/imdb')).statusCode).toBe(400);
    expect((await call(env, admin, 'PUT', '/api/admin/sources/imdb', { key: KEY })).statusCode).toBe(400);
    expect((await call(env, admin, 'PUT', '/api/admin/sources/tmdb', { key: 'has space1234' })).statusCode).toBe(400);
    expect((await call(env, admin, 'PUT', '/api/admin/sources/tmdb', { key: '1234567' })).statusCode).toBe(400);
  });

  it('test endpoint: not_set without any key', async () => {
    await call(env, admin, 'DELETE', '/api/admin/sources/tmdb');
    expect((await call(env, admin, 'POST', '/api/admin/sources/tmdb/test', {})).json()).toEqual({ ok: false, error: 'not_set' });
  });
});
