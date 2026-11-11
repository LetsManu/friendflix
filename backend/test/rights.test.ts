// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { migrate } from '../src/db.js';
import { effectiveLimits, getUserOverrides, setUserLimits, setUserOverrides } from '../src/limits.js';
import { DEFAULT_PERMS, KIDS_OFF, MATRIX_FIELDS, PERM_KEYS, permsPatch, readPerms } from '../src/perms.js';
import { defaultLimit } from '../src/requestlimit.js';
import { syncRoles } from '../src/rolecat.js';
import { DEFAULT_ROLES, effectiveRole, loadRoles } from '../src/roles.js';
import { accountsWithout, effectiveRights, invalidateRights, roleRights } from '../src/rights.js';
import { applyRole } from '../src/users.js';
import { resetDb } from './helpers.js';

// Users & permissions Task 2: the permission registry (perms.ts) and the one resolver (rights.ts): code default ← ROLE_TEMPLATES ←
// role row ← user override ← kids overlay, with the source of every field. effectiveLimits() is its thin wrapper.
let pool: pg.Pool;
beforeAll(async () => { pool = await resetDb(); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query("delete from user_limits; delete from role_settings; delete from users; delete from roles where origin <> 'code'");
  invalidateRights();
});

/** a fresh ctx (no cached role rows) over the test database */
const mk = (rolesJson?: string) => ({ db: pool, roles: loadRoles(rolesJson) });
const addUser = async (name: string, role: string, disabled = false) => {
  const id = randomUUID();
  await pool.query("insert into users(id, authentik_sub, name, role, disabled, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,$2,$2,$3,$4,$2,$2,'x')", [id, name, role, disabled]);
  return id;
};
const BUILTIN = ['admin', 'family', 'friend', 'guest'] as const;
const TEMPLATE_KEYS = ['libraries', 'maxParentalRating', 'maxBitrate', 'remoteMaxBitrate', 'maxStreams', 'transcoding', 'maxHeight', 'download', 'maxDownloads', 'downloadMaxHeight', 'downloadDays'] as const;

const SNAPSHOT_33 = {
  users: {
    'Anna Beispiel': { label: 'Admin', libraries: 'all', maxParentalRating: null, maxBitrate: 60000000, remoteMaxBitrate: 12000000, maxStreams: 6, transcoding: false, maxHeight: null, download: true, maxDownloads: 50, downloadMaxHeight: 1080, downloadDays: 30, requestsPerMonth: null },
    'Ben Muster': { label: 'Familie', libraries: 'all', maxParentalRating: null, maxBitrate: 40000000, remoteMaxBitrate: 5000000, maxStreams: 4, transcoding: false, maxHeight: 1080, download: true, maxDownloads: 10, downloadMaxHeight: 720, downloadDays: 14, requestsPerMonth: 7 },
    'Carla Probe': { label: 'Freund', libraries: 'all', maxParentalRating: null, maxBitrate: 20000000, remoteMaxBitrate: 12000000, maxStreams: 4, transcoding: true, maxHeight: null, download: false, maxDownloads: 15, downloadMaxHeight: 720, downloadDays: 30, requestsPerMonth: 0 },
    'Gast': { label: 'Gast', libraries: 'all', maxParentalRating: 12, maxBitrate: 8000000, remoteMaxBitrate: 4000000, maxStreams: 1, transcoding: true, maxHeight: null, download: false, maxDownloads: 0, downloadMaxHeight: 0, downloadDays: 30, requestsPerMonth: 5 },
    'Oma': { label: 'Oma', libraries: 'all', maxParentalRating: null, maxBitrate: 20000000, remoteMaxBitrate: 8000000, maxStreams: 3, transcoding: true, maxHeight: null, download: true, maxDownloads: 3, downloadMaxHeight: 720, downloadDays: 30, requestsPerMonth: null },
    'Friend Overrides': { label: 'Freund', libraries: 'all', maxParentalRating: null, maxBitrate: 20000000, remoteMaxBitrate: 3000000, maxStreams: 7, transcoding: true, maxHeight: null, download: false, maxDownloads: 2, downloadMaxHeight: 480, downloadDays: 30, requestsPerMonth: 9 },
    'Guest Requests': { label: 'Gast', libraries: 'all', maxParentalRating: 12, maxBitrate: 8000000, remoteMaxBitrate: 4000000, maxStreams: 1, transcoding: true, maxHeight: null, download: false, maxDownloads: 0, downloadMaxHeight: 0, downloadDays: 30, requestsPerMonth: 1 },
    'Family NoDl': { label: 'Familie', libraries: 'all', maxParentalRating: null, maxBitrate: 40000000, remoteMaxBitrate: 5000000, maxStreams: 4, transcoding: false, maxHeight: 1080, download: true, maxDownloads: 10, downloadMaxHeight: 0, downloadDays: 14, requestsPerMonth: 7 },
  },
  roles: {
    admin: { label: 'Admin', libraries: 'all', maxParentalRating: null, maxBitrate: 60000000, remoteMaxBitrate: 12000000, maxStreams: 6, transcoding: false, maxHeight: null, download: true, maxDownloads: 50, downloadMaxHeight: 1080, downloadDays: 30 },
    family: { label: 'Familie', libraries: 'all', maxParentalRating: null, maxBitrate: 40000000, remoteMaxBitrate: 5000000, maxStreams: 4, transcoding: false, maxHeight: 1080, download: true, maxDownloads: 10, downloadMaxHeight: 720, downloadDays: 14 },
    friend: { label: 'Freund', libraries: 'all', maxParentalRating: null, maxBitrate: 20000000, remoteMaxBitrate: 12000000, maxStreams: 4, transcoding: true, maxHeight: null, download: false, maxDownloads: 15, downloadMaxHeight: 720, downloadDays: 30 },
    guest: { label: 'Gast', libraries: 'all', maxParentalRating: 12, maxBitrate: 8000000, remoteMaxBitrate: 4000000, maxStreams: 1, transcoding: true, maxHeight: null, download: false, maxDownloads: 0, downloadMaxHeight: 0, downloadDays: 30 },
    oma: { label: 'Oma', libraries: 'all', maxParentalRating: null, maxBitrate: 20000000, remoteMaxBitrate: 8000000, maxStreams: 3, transcoding: true, maxHeight: null, download: true, maxDownloads: 3, downloadMaxHeight: 720, downloadDays: 30 },
  },
};

describe('permission registry', () => {
  it('defaults are the spec table', () => {
    const all = Object.fromEntries(PERM_KEYS.map((k) => [k, true]));
    expect(PERM_KEYS).toEqual(['requests', 'cast', 'party', 'partySchedule', 'comments', 'liveTv', 'liveRecord']);
    expect(DEFAULT_PERMS.admin).toEqual(all);
    expect(DEFAULT_PERMS.family).toEqual({ ...all, partySchedule: false });
    expect(DEFAULT_PERMS.friend).toEqual({ ...all, partySchedule: false });
    expect(DEFAULT_PERMS.guest).toEqual({ ...all, partySchedule: false, comments: false, liveRecord: false });
    expect(KIDS_OFF).toEqual(['requests', 'party', 'partySchedule', 'comments', 'liveRecord']);
  });

  it('readPerms keeps known boolean keys; permsPatch rejects unknown keys', () => {
    expect(readPerms({ cast: false, telepathy: true, party: 'yes', comments: null })).toEqual({ cast: false });
    expect(readPerms(null)).toEqual({});
    expect(readPerms([true])).toEqual({});
    expect(permsPatch.parse({ cast: false, party: null })).toEqual({ cast: false, party: null });
    expect(permsPatch.safeParse({ telepathy: true }).success).toBe(false);
    expect(permsPatch.safeParse({ cast: 1 }).success).toBe(false);
  });

  it('matrix fields: every template field, requests and every switch, in editor order', () => {
    expect(MATRIX_FIELDS.map((f) => `${f.group}.${f.key}`)).toEqual([
      'access.libraries', 'access.maxParentalRating',
      'playback.maxStreams', 'playback.maxBitrate', 'playback.remoteMaxBitrate', 'playback.transcoding', 'playback.maxHeight',
      'downloads.download', 'downloads.maxDownloads', 'downloads.downloadMaxHeight', 'downloads.downloadDays',
      'requests.requests', 'requests.requestsPerMonth', 'together.party', 'together.partySchedule', 'together.comments', 'cast.cast',
      'livetv.liveTv', 'livetv.liveRecord',
    ]);
    const f = Object.fromEntries(MATRIX_FIELDS.map((x) => [x.key, x]));
    expect(f.maxParentalRating).toMatchObject({ kind: 'rating', options: [null, 0, 6, 12, 16, 18] });
    expect(f.maxStreams).toMatchObject({ kind: 'int', min: 1, max: 50 });
    expect(f.maxBitrate).toMatchObject({ kind: 'bitrate', min: 300_000, max: 200_000_000 });
    expect(f.maxHeight).toMatchObject({ kind: 'height', options: [null, 720, 1080, 1440, 2160] });
    expect(f.downloadMaxHeight).toMatchObject({ kind: 'height', options: [480, 720, 1080, 2160] });
    expect(f.requestsPerMonth).toMatchObject({ kind: 'int', min: 0, max: 100, options: [null], requires: 'requests' });
    expect(f.cast).toMatchObject({ kind: 'bool', requires: 'cast' });
    expect(f.liveRecord).toMatchObject({ kind: 'bool', requires: 'livetv' });
    expect(f.party!.requires).toBeUndefined();
  });
});

describe('effectiveRights', () => {
  it('defaults reproduce today', async () => {
    const ctx = mk();
    for (const role of BUILTIN) {
      const r = (await roleRights(ctx, role))!;
      const { label: _label, ...t } = DEFAULT_ROLES[role]!;
      expect(r.template).toEqual({ ...DEFAULT_ROLES[role], requestsPerMonth: defaultLimit(role) });
      expect(r.perms).toEqual(DEFAULT_PERMS[role]);
      for (const k of [...Object.keys(t), 'requestsPerMonth']) expect(r.sources[k as keyof typeof r.sources]).toBe('default');
      // the admin role's switches are locked on
      for (const k of PERM_KEYS) expect(r.sources[k]).toBe(role === 'admin' ? 'admin' : 'default');
      const id = await addUser(`u-${role}`, role);
      expect(await effectiveRights(ctx, { id, role })).toEqual(r);
      expect(await effectiveLimits(ctx, { id, role })).toEqual(r.template);
    }
    expect(await roleRights(ctx, 'nobody')).toBeUndefined();
    expect(await effectiveRights(ctx, { id: randomUUID(), role: 'nobody' })).toBeUndefined();
  });

  it('layer order and sources', async () => {
    // (a role_settings row whose requests_per_month is null means unlimited, as in 3.3: the fixtures write the column explicitly)
    const ctx = mk('{"friend":{"maxStreams":3}}');
    await pool.query(`insert into role_settings(role, requests_per_month, template, perms) values ('friend', 2, '{"maxHeight": 1080}', '{"cast": false}')`);
    const id = await addUser('Carla Probe', 'friend');
    await pool.query("insert into user_limits(user_id, max_streams, perms) values ($1, 5, '{\"comments\": false}')", [id]);
    const r = (await effectiveRights(ctx, { id, role: 'friend' }))!;
    expect([r.template.maxStreams, r.sources.maxStreams]).toEqual([5, 'user']);
    expect([r.template.maxHeight, r.sources.maxHeight]).toEqual([1080, 'role']);
    expect([r.perms.cast, r.sources.cast]).toEqual([false, 'role']);
    expect([r.perms.comments, r.sources.comments]).toEqual([false, 'user']);
    expect([r.perms.party, r.sources.party]).toEqual([true, 'default']);
    expect([r.template.downloadDays, r.sources.downloadDays]).toEqual([30, 'default']);
    expect([r.template.requestsPerMonth, r.sources.requestsPerMonth]).toEqual([2, 'role']);

    await pool.query('delete from user_limits where user_id=$1', [id]);
    invalidateRights(id);
    const r2 = (await effectiveRights(ctx, { id, role: 'friend' }))!;
    expect([r2.template.maxStreams, r2.sources.maxStreams]).toEqual([3, 'env']);
    expect([r2.perms.comments, r2.sources.comments]).toEqual([true, 'default']);
  });

  it('every user override field, with its encodings', async () => {
    const ctx = mk();
    await pool.query("insert into role_settings(role, requests_per_month) values ('guest', 4)");
    const id = await addUser('Ben Muster', 'guest');
    await setUserOverrides(ctx, id, {
      maxStreams: 2, remoteBitrate: 3_000_000, maxDownloads: 5, downloadMaxHeight: 480, requestsPerMonth: 9,
      transcoding: false, maxHeight: 0, download: true, maxBitrate: 6_000_000, maxParentalRating: -1, libraries: ['Filme'], perms: { cast: false }, note: 'Urlaub',
    });
    const r = (await effectiveRights(ctx, { id, role: 'guest' }))!;
    expect(r.template).toEqual({
      ...DEFAULT_ROLES.guest, maxStreams: 2, remoteMaxBitrate: 3_000_000, maxDownloads: 5, downloadMaxHeight: 480, requestsPerMonth: 9,
      transcoding: false, maxHeight: null, download: true, maxBitrate: 6_000_000, maxParentalRating: null, libraries: ['Filme'],
    });
    for (const k of [...TEMPLATE_KEYS.filter((k) => k !== 'downloadDays'), 'requestsPerMonth', 'cast'] as const) expect(r.sources[k]).toBe('user');
    expect(r.sources.downloadDays).toBe('default');
    expect(await getUserOverrides(ctx, id)).toMatchObject({ maxHeight: 0, maxParentalRating: -1, libraries: ['Filme'], perms: { cast: false }, note: 'Urlaub' });
    // the old limits editor keeps the new override columns (the row is not deleted while one is set)
    await setUserLimits(ctx, id, { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null });
    expect(await getUserOverrides(ctx, id)).toMatchObject({ maxStreams: null, transcoding: false, perms: { cast: false }, note: 'Urlaub' });
    await setUserOverrides(ctx, id, {
      maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null,
      transcoding: null, maxHeight: null, download: null, maxBitrate: null, maxParentalRating: null, libraries: null, perms: {}, note: null,
    });
    expect((await pool.query('select 1 from user_limits where user_id=$1', [id])).rowCount).toBe(0);
    expect((await effectiveLimits(ctx, { id, role: 'guest' }))).toEqual({ ...DEFAULT_ROLES.guest, requestsPerMonth: 4 });
  });

  it('admin perms are locked', async () => {
    const ctx = mk();
    await pool.query(`insert into role_settings(role, perms) values ('admin', '{"comments": false}')`);
    const id = await addUser('Anna Beispiel', 'admin');
    await pool.query(`insert into user_limits(user_id, perms) values ($1, '{"cast": false}')`, [id]);
    const r = (await effectiveRights(ctx, { id, role: 'admin' }))!;
    expect([r.perms.comments, r.sources.comments]).toEqual([true, 'admin']);
    expect([r.perms.cast, r.sources.cast]).toEqual([true, 'admin']);
  });

  it('kids overlay', async () => {
    const ctx = mk();
    const guest = await addUser('Gast', 'guest');
    const k = (await effectiveRights(ctx, { id: guest, role: 'guest' }, { kids: true, kids_max_rating: 6 }))!;
    expect([k.template.maxParentalRating, k.sources.maxParentalRating]).toEqual([6, 'kids']);
    for (const p of KIDS_OFF) expect([p, k.perms[p], k.sources[p]]).toEqual([p, false, 'kids']);
    expect([k.perms.cast, k.perms.liveTv]).toEqual([true, true]);
    // a cap the kids profile does not lower keeps its source
    const same = (await effectiveRights(ctx, { id: guest, role: 'guest' }, { kids: true, kids_max_rating: 12 }))!;
    expect([same.template.maxParentalRating, same.sources.maxParentalRating]).toEqual([12, 'default']);
    // a normal profile and the account itself: no overlay, and the overlay never leaks into the cached account value
    expect((await effectiveRights(ctx, { id: guest, role: 'guest' }, { kids: false, kids_max_rating: 6 }))!.perms.requests).toBe(true);
    expect((await effectiveRights(ctx, { id: guest, role: 'guest' }))!.template.maxParentalRating).toBe(12);
    const family = await addUser('Ben Muster', 'family');
    const f = (await effectiveRights(ctx, { id: family, role: 'family' }, { kids: true, kids_max_rating: 12 }))!;
    expect([f.template.maxParentalRating, f.sources.maxParentalRating]).toEqual([12, 'kids']);
    // the admin lock does not open a kids profile
    const admin = await addUser('Anna Beispiel', 'admin');
    expect((await effectiveRights(ctx, { id: admin, role: 'admin' }, { kids: true, kids_max_rating: 0 }))!.perms.party).toBe(false);
  });

  it('effective values identical before and after migration 47', async () => {
    // rewind 47, seed 3.3-shape rows (every old role_settings column combination, user_limits), migrate: the backfilled template must
    // give the values the 3.3 code computed from the old columns (SNAPSHOT_33, recorded with the pre-Task-2 resolver)
    await pool.query(`
      drop index if exists audit_log_target;
      drop index if exists audit_log_action;
      drop table if exists roles;
      alter table role_settings drop column if exists template, drop column if exists perms;
      alter table user_limits drop column if exists transcoding, drop column if exists max_height, drop column if exists download,
        drop column if exists max_bitrate, drop column if exists max_parental_rating, drop column if exists libraries,
        drop column if exists perms, drop column if exists note;
      delete from schema_migrations where version >= 47;
      insert into role_settings(role, requests_per_month, transcoding, max_height, download, max_downloads, download_max_height, download_days, remote_max_bitrate)
        values ('family', 7, false, 1080, true, 10, 720, 14, 5000000);
      insert into role_settings(role, requests_per_month, max_height) values ('guest', 5, 0);
      insert into role_settings(role, requests_per_month, remote_max_bitrate) values ('friend', 0, 12000000);
      insert into role_settings(role, transcoding) values ('admin', false);
      insert into role_settings(role, download, max_downloads) values ('oma', true, 3);`);
    const users: Array<[string, string, string | null]> = [
      ['Anna Beispiel', 'admin', null], ['Ben Muster', 'family', null], ['Carla Probe', 'friend', null], ['Gast', 'guest', null], ['Oma', 'oma', null],
      ['Friend Overrides', 'friend', '7, 3000000, 2, 480, 9'], ['Guest Requests', 'guest', 'null, null, null, null, 1'], ['Family NoDl', 'family', 'null, null, null, 0, null'],
    ];
    const ids: Record<string, string> = {};
    for (const [name, role, lim] of users) {
      ids[name] = await addUser(name, role);
      if (lim) await pool.query(`insert into user_limits(user_id, max_streams, remote_bitrate, max_downloads, download_max_height, requests_per_month) values ($1, ${lim})`, [ids[name]]);
    }
    await migrate(pool);
    const ctx = mk('{"oma":{"label":"Oma","maxStreams":3},"friend":{"maxStreams":4}}');
    await syncRoles(ctx);
    const got: Record<string, unknown> = {};
    for (const [name, role] of users) got[name] = await effectiveLimits(ctx, { id: ids[name]!, role });
    expect(got).toEqual(SNAPSHOT_33.users);
    const roles: Record<string, unknown> = {};
    for (const r of Object.keys(SNAPSHOT_33.roles)) roles[r] = await effectiveRole(ctx, r);
    expect(roles).toEqual(SNAPSHOT_33.roles);
  });

  it('a role that left ROLE_TEMPLATES still resolves', async () => {
    await syncRoles(mk('{"oma":{"label":"Oma","maxStreams":3}}'));
    await pool.query(`insert into role_settings(role, requests_per_month, template, perms) values ('oma', 2, '{"download": true}', '{"party": false}')`);
    const id = await addUser('Oma', 'oma');
    const ctx = mk(); // ROLE_TEMPLATES without oma
    const r = (await effectiveRights(ctx, { id, role: 'oma' }))!;
    expect(r).toBeDefined();
    expect(r.template).toEqual({ ...DEFAULT_ROLES.friend, download: true, requestsPerMonth: 2 });
    expect([r.sources.download, r.sources.maxStreams]).toEqual(['role', 'default']);
    expect([r.perms.party, r.sources.party, r.perms.partySchedule]).toEqual([false, 'role', false]);
    const applied: unknown[] = [];
    const jfCtx = { ...ctx, jf: { admin: { applyPolicy: async (jid: string, p: unknown) => { applied.push([jid, p]); } } } } as unknown as Ctx;
    await expect(applyRole(jfCtx, 'Oma', 'oma', false, { userId: id })).resolves.toBeUndefined();
    expect(applied).toHaveLength(1);
  });

  it('admin-created role resolves from base and full template', async () => {
    const full = { libraries: ['Filme', 'Kinder'], maxParentalRating: 16, maxBitrate: 30_000_000, remoteMaxBitrate: 6_000_000, maxStreams: 3, transcoding: false, maxHeight: 1440, download: true, maxDownloads: 7, downloadMaxHeight: 1080, downloadDays: 21 };
    await pool.query("insert into roles(key, label, base, origin, position) values ('kino', 'Kino', 'family', 'admin', 4)");
    await pool.query("insert into role_settings(role, requests_per_month, template, perms) values ('kino', 3, $1, '{\"comments\": false}')", [JSON.stringify(full)]);
    const ctx = mk();
    expect(await effectiveRole(ctx, 'kino')).toEqual({ label: 'Kino', ...full });
    const r = (await roleRights(ctx, 'kino'))!;
    expect(r.template).toEqual({ label: 'Kino', ...full, requestsPerMonth: 3 });
    for (const k of TEMPLATE_KEYS) expect(r.sources[k]).toBe('role');
    expect(r.sources.requestsPerMonth).toBe('role');
    expect([r.perms.comments, r.perms.partySchedule, r.sources.partySchedule]).toEqual([false, false, 'default']); // family defaults below
    // an admin role without a label shows the label of its base
    await pool.query("update roles set label = null where key = 'kino'");
    expect((await effectiveRole(mk(), 'kino'))!.label).toBe('Familie');
  });

  it('stored values of the wrong shape are ignored, explicit null means unlimited', async () => {
    await pool.query(`insert into role_settings(role, requests_per_month, template) values ('guest', 2, '{"maxHeight": null, "maxParentalRating": null, "maxStreams": "x", "download": null, "label": "Hack"}')`);
    const r = (await roleRights(mk(), 'guest'))!;
    expect(r.template).toEqual({ ...DEFAULT_ROLES.guest, maxHeight: null, maxParentalRating: null, requestsPerMonth: 2 });
    expect([r.sources.maxHeight, r.sources.maxParentalRating, r.sources.maxStreams, r.sources.download]).toEqual(['role', 'role', 'default', 'default']);
  });

  it('accountsWithout(comments)', async () => {
    const ctx = mk();
    const guest = await addUser('Gast', 'guest');
    await addUser('Gast gesperrt', 'guest', true);
    const friend = await addUser('Carla Probe', 'friend');
    await pool.query(`insert into user_limits(user_id, perms) values ($1, '{"comments": false}')`, [friend]);
    const admin = await addUser('Anna Beispiel', 'admin');
    await pool.query(`insert into user_limits(user_id, perms) values ($1, '{"comments": false}')`, [admin]); // locked on
    await addUser('Ben Muster', 'family');
    expect((await accountsWithout(ctx, 'comments')).sort()).toEqual([guest, friend].sort());
    const later = await addUser('Friend 2', 'friend');
    await pool.query(`insert into user_limits(user_id, perms) values ($1, '{"comments": false}')`, [later]);
    expect(await accountsWithout(ctx, 'comments')).not.toContain(later); // cached
    invalidateRights();
    expect(await accountsWithout(ctx, 'comments')).toContain(later);
    expect(await accountsWithout(ctx, 'cast')).toEqual([]);
  });

  it('unknown perm keys in stored JSON are ignored', async () => {
    await pool.query(`insert into role_settings(role, perms) values ('friend', '{"telepathy": true, "cast": false}')`);
    const id = await addUser('Carla Probe', 'friend');
    await pool.query(`insert into user_limits(user_id, perms) values ($1, '{"telepathy": false}')`, [id]);
    const r = (await effectiveRights(mk(), { id, role: 'friend' }))!;
    expect(Object.keys(r.perms).sort()).toEqual([...PERM_KEYS].sort());
    expect(r.perms.cast).toBe(false);
    expect(Object.keys(r.sources)).not.toContain('telepathy');
  });
});
