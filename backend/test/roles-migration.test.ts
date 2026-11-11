// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db.js';
import { catalogueLabel, invalidateCatalogue, invitableRoles, listRoles, roleExists, syncRoles } from '../src/rolecat.js';
import { DEFAULT_ROLES, loadRoles } from '../src/roles.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { ENC_KEY, makeEnv, resetDb, type TestEnv } from './helpers.js';

// Users & permissions Task 1: migration 47 (roles catalogue, role_settings.template/perms, user_limits overrides, audit indexes) is tested
// against the real migration: rewind past 46, seed old-shape rows, migrate again. Then the catalogue (rolecat.ts) on top of it.
let pool: pg.Pool;
beforeAll(async () => { pool = await resetDb(); });
afterAll(async () => { await pool.end(); });

/** drops everything migration 47 creates and forgets it ran; `seed` writes old-shape rows before it runs again */
async function rewind(seed?: () => Promise<void>) {
  await pool.query(`
    drop index if exists audit_log_target;
    drop index if exists audit_log_action;
    drop table if exists roles;
    alter table role_settings drop column if exists template, drop column if exists perms;
    alter table user_limits drop column if exists transcoding, drop column if exists max_height, drop column if exists download,
      drop column if exists max_bitrate, drop column if exists max_parental_rating, drop column if exists libraries,
      drop column if exists perms, drop column if exists note;
    delete from schema_migrations where version >= 47;`);
  await seed?.();
  await migrate(pool);
}

const addUser = async (sub: string, name: string, role: string) =>
  (await pool.query(
    `insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,$2,$3,$4,$2,$2,'x') returning id`,
    [randomUUID(), sub, name, role],
  )).rows[0].id as string;

describe('migration 47', () => {
  it('is the 47th migration', () => {
    expect(MIGRATIONS.length).toBe(47);
  });

  it('seeds the four built-ins', async () => {
    const r = (await pool.query('select key, base, origin, invitable, position, label from roles order by position')).rows;
    expect(r).toEqual([
      { key: 'admin', base: 'admin', origin: 'code', invitable: false, position: 0, label: null },
      { key: 'family', base: 'family', origin: 'code', invitable: true, position: 1, label: null },
      { key: 'friend', base: 'friend', origin: 'code', invitable: true, position: 2, label: null },
      { key: 'guest', base: 'guest', origin: 'code', invitable: true, position: 3, label: null },
    ]);
  });

  it('rejects invalid role keys and labels', async () => {
    await expect(pool.query("insert into roles(key, base, origin) values ('Oma','friend','env')")).rejects.toThrow(/check/);
    await expect(pool.query("insert into roles(key, base, origin) values ('x','friend','env')")).rejects.toThrow(/check/);
    await expect(pool.query("insert into roles(key, base, origin) values ('oma','friend','nowhere')")).rejects.toThrow(/check/);
    await expect(pool.query("insert into roles(key, label, base, origin) values ('oma','','friend','env')")).rejects.toThrow(/check/);
  });

  it('backfills template from every column combination', async () => {
    await rewind(async () => {
      await pool.query('delete from role_settings');
      await pool.query(`insert into role_settings(role, requests_per_month, transcoding, max_height, download, max_downloads, download_max_height, download_days, remote_max_bitrate)
        values ('family', 7, true, 1080, true, 10, 720, 14, 5000000)`);
      await pool.query("insert into role_settings(role, max_height) values ('guest', 0)");
      await pool.query("insert into role_settings(role, requests_per_month) values ('friend', 5)");
      await pool.query("insert into role_settings(role, transcoding, download) values ('admin', false, false)");
    });
    const t = Object.fromEntries((await pool.query('select role, template, perms, requests_per_month from role_settings')).rows.map((r) => [r.role, r]));
    expect(t.family.template).toEqual({ transcoding: true, maxHeight: 1080, download: true, maxDownloads: 10, downloadMaxHeight: 720, downloadDays: 14, remoteMaxBitrate: 5000000 });
    expect(t.guest.template).toEqual({ maxHeight: null });
    expect(t.friend.template).toEqual({});
    expect(t.friend.requests_per_month).toBe(5); // stays its column
    expect(t.admin.template).toEqual({ transcoding: false, download: false });
    for (const r of Object.values(t) as Array<{ perms: unknown }>) expect(r.perms).toEqual({});

    // a template that is already filled (a role written by the new editor) is never overwritten by a rerun
    await pool.query(`update role_settings set template = '{"maxStreams": 9}' where role = 'family'`);
    await pool.query('delete from schema_migrations where version = 47');
    await migrate(pool);
    expect((await pool.query("select template from role_settings where role='family'")).rows[0].template).toEqual({ maxStreams: 9 });
  });

  it('user_limits gains the columns, existing rows untouched', async () => {
    let uid = '';
    await rewind(async () => {
      uid = await addUser('anna', 'Anna Beispiel', 'friend');
      await pool.query('insert into user_limits(user_id, max_streams, requests_per_month) values ($1, 3, 4)', [uid]);
    });
    const r = (await pool.query('select * from user_limits where user_id=$1', [uid])).rows[0];
    expect(r).toMatchObject({ max_streams: 3, requests_per_month: 4, perms: {}, transcoding: null, max_height: null, download: null, max_bitrate: null, max_parental_rating: null, libraries: null, note: null });
    await expect(pool.query('update user_limits set max_parental_rating = 22 where user_id=$1', [uid])).rejects.toThrow(/check/);
    await expect(pool.query('update user_limits set max_bitrate = 1000 where user_id=$1', [uid])).rejects.toThrow(/check/);
    await expect(pool.query("update user_limits set note = repeat('x', 201) where user_id=$1", [uid])).rejects.toThrow(/check/);
    await pool.query("update user_limits set max_parental_rating = -1, libraries = '\"all\"', note = 'Urlaub' where user_id=$1", [uid]);
  });

  it('audit indexes exist', async () => {
    const r = (await pool.query("select indexname from pg_indexes where tablename = 'audit_log'")).rows.map((x) => x.indexname);
    expect(r).toEqual(expect.arrayContaining(['audit_log_target', 'audit_log_action']));
  });

  it('migration 47 is rerunnable', async () => {
    await rewind();
    await rewind();
    // and once more over the objects that already exist
    await pool.query('delete from schema_migrations where version = 47');
    await migrate(pool);
    expect((await pool.query('select count(*)::int n from roles')).rows[0].n).toBe(4);
    expect((await pool.query('select max(version) v from schema_migrations')).rows[0].v).toBe(47);
  });
});

describe('role catalogue', () => {
  const ctx = { db: undefined as unknown as pg.Pool, roles: loadRoles('{"oma":{"label":"Oma"},"order":{"label":"Reihenfolge"}}') };
  beforeAll(() => { ctx.db = pool; });

  it('syncRoles adds env roles once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await syncRoles(ctx)).toEqual({ added: ['oma'] });
      expect((await pool.query("select key, base, origin, invitable, position, label from roles where key='oma'")).rows)
        .toEqual([{ key: 'oma', base: 'friend', origin: 'env', invitable: true, position: 4, label: null }]);
      expect((await pool.query("select 1 from roles where key='order'")).rowCount).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual(['role key skipped']); // never the key itself
      expect(await syncRoles(ctx)).toEqual({ added: [] });
      expect((await pool.query('select count(*)::int n from roles')).rows[0].n).toBe(5);
    } finally { warn.mockRestore(); }
  });

  it('roleExists and invitableRoles', async () => {
    expect(await roleExists(ctx, 'oma')).toBe(true);
    expect(await roleExists(ctx, 'admin')).toBe(true);
    expect(await roleExists(ctx, 'nobody')).toBe(false);
    expect(await invitableRoles(ctx)).toEqual(['family', 'friend', 'guest', 'oma']);
  });

  it('listRoles is in catalogue order and fills env keys without a row in memory', async () => {
    const fresh = { db: pool, roles: { ...ctx.roles, kino: DEFAULT_ROLES.friend! } };
    const rows = await listRoles(fresh);
    expect(rows.map((r) => [r.key, r.origin, r.position])).toEqual([
      ['admin', 'code', 0], ['family', 'code', 1], ['friend', 'code', 2], ['guest', 'code', 3], ['oma', 'env', 4],
      // not persisted: `order` is reserved (it keeps resolving for accounts that hold it, but is never offered in a picker)
      ['order', 'env', 5], ['kino', 'env', 6],
    ]);
    expect(rows.find((r) => r.key === 'order')!.invitable).toBe(false);
    expect(rows.find((r) => r.key === 'kino')).toMatchObject({ base: 'friend', invitable: true, label: null });
    expect(typeof rows[0]!.createdAt).toBe('string');
    expect((await pool.query("select 1 from roles where key='kino'")).rowCount).toBe(0);
  });

  it('a role that left ROLE_TEMPLATES stays in the catalogue', async () => {
    const without = { db: pool, roles: DEFAULT_ROLES };
    expect(await roleExists(without, 'oma')).toBe(true);
  });

  it('catalogueLabel: row label, else env label, else the built-in label of the base', async () => {
    expect(await catalogueLabel(ctx, 'friend')).toBe('Freund');
    expect(await catalogueLabel(ctx, 'oma')).toBe('Oma');
    expect(await catalogueLabel(ctx, 'nobody')).toBeUndefined();
    await pool.query("update roles set label = 'Kumpel' where key = 'friend'");
    await pool.query("insert into roles(key, base, origin, position) values ('opa', 'family', 'env', 9)");
    invalidateCatalogue(ctx);
    try {
      expect(await catalogueLabel(ctx, 'friend')).toBe('Kumpel');
      expect(await catalogueLabel(ctx, 'opa')).toBe('Familie'); // left ROLE_TEMPLATES: the label of its base
    } finally {
      await pool.query("update roles set label = null where key = 'friend'");
      await pool.query("delete from roles where key = 'opa'");
      invalidateCatalogue(ctx);
    }
  });
});

describe('role existence in the admin API', () => {
  let env: TestEnv;
  let admin: { cookies: Record<string, string>; csrf: string };
  let ben = '';
  beforeAll(async () => {
    env = await makeEnv({}, { ctxPatch: (c) => { c.roles = loadRoles('{"oma":{"label":"Oma"}}'); } });
    admin = await env.login();
    ben = (await env.pool.query(
      `insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'ben', 'Ben Muster', 'friend', $1, 'ben', $2) returning id`,
      ['ben'.padEnd(32, '0'), encrypt(keyFromBase64(ENC_KEY), 'pw')],
    )).rows[0].id;
  });
  afterAll(async () => { await env?.close(); });

  const patch = (payload: object) => env.app.inject({ method: 'PATCH', url: `/api/admin/users/${ben}`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload });

  it('makeEnv synced the env role into the catalogue', async () => {
    expect((await env.pool.query("select origin, base from roles where key='oma'")).rows).toEqual([{ origin: 'env', base: 'friend' }]);
  });

  it('PATCH /api/admin/users/:id role: catalogue roles succeed, unknown ones are 400 unknown_role', async () => {
    expect((await patch({ role: 'oma' })).statusCode).toBe(200);
    expect((await env.pool.query('select role from users where id=$1', [ben])).rows[0].role).toBe('oma');
    const r = await patch({ role: 'nobody' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('unknown_role');
  });
});
