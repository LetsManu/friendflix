// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { forgetLibraries } from '../src/libraries.js';
import { MATRIX_FIELDS } from '../src/perms.js';
import { roleLimitFor } from '../src/requestlimit.js';
import { accountsWithout } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { writeRole } from '../src/roleWrite.js';
import { TEST_DB, makeEnv, type TestEnv } from './helpers.js';

// Users & permissions Task 3: GET /api/admin/roles (legacy fields + the role matrix) and PUT /api/admin/roles/:role (partial writes into
// role_settings.template / perms, dual-written old columns, one role.update audit entry, policy re-apply only for media-enforced fields).
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, admin2: Sess;
let folders = [{ Id: 'f1', Name: 'Filme' }, { Id: 'f2', Name: 'Serien' }];
let failFor = '';

const ANNA = '0a000000-0000-4000-a000-000000000001';
const BEN = '0a000000-0000-4000-a000-000000000002';
const KIDS = '0a000000-0000-4000-a000-000000000003';
const JF = { anna: 'anna'.padEnd(32, '0'), ben: 'ben'.padEnd(32, '0'), kids: 'kids'.padEnd(32, '0') };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Library/MediaFolders': () => ({ json: { Items: folders } }),
    'POST /Users/[^/]+/Policy': (u) => (failFor && u.pathname.includes(failFor) ? { status: 500, raw: 'nope' } : { status: 204 }),
  });
  admin = await env.login();
  admin2 = await env.login({ sub: 'sub-admin-2', email: 'carla@example.com', name: 'Carla Probe', groups: ['friendflix-admins'] });
  // two family accounts, one of them with a kids profile (its own media server identity)
  await env.pool.query(
    `insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values
       ($1, 'sub-anna', 'Anna Beispiel', 'family', $3, 'anna', 'x'), ($2, 'sub-ben', 'Ben Muster', 'family', $4, 'ben', 'x')`,
    [ANNA, BEN, JF.anna, JF.ben]);
  await env.pool.query("insert into profiles(id, user_id, name, is_owner) values ($1, $1, 'Anna', true), ($2, $2, 'Ben', true)", [ANNA, BEN]);
  await env.pool.query("insert into profiles(id, user_id, name, kids, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, 'Kind', true, $3, 'kids', 'x')", [KIDS, ANNA, JF.kids]);
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from role_settings; delete from audit_log');
  await env.pool.query("update roles set label = null, invitable = (key <> 'admin')");
  await env.pool.query("delete from roles where origin = 'admin'");
  invalidateRoles(env.ctx);
  folders = [{ Id: 'f1', Name: 'Filme' }, { Id: 'f2', Name: 'Serien' }];
  forgetLibraries(env.ctx);
  failFor = '';
});

const call = (s: Sess, method: 'GET' | 'PUT', url: string, payload?: object) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, ...(payload ? { payload } : {}) });
const put = (role: string, body: object, s: Sess = admin) => call(s, 'PUT', `/api/admin/roles/${role}`, body);
const get = async () => (await call(admin, 'GET', '/api/admin/roles')).json();
const roleOf = async (key: string) => (await get()).matrix.roles.find((r: { key: string }) => r.key === key);
const row = async (role: string) => (await env.pool.query('select * from role_settings where role=$1', [role])).rows[0];
const policies = () => env.jfCalls.filter((c) => c.method === 'POST' && /\/Policy$/.test(c.path));
const audits = async (role: string) => (await env.pool.query("select actor, meta from audit_log where action='role.update' and target=$1 order by id", [role])).rows;

describe('GET /api/admin/roles', () => {
  it('matrix lists fields, roles and sources', async () => {
    const m = (await get()).matrix;
    expect(m.fields.map((f: { key: string }) => f.key)).toEqual(MATRIX_FIELDS.map((f) => f.key));
    expect(m.fields.find((f: { key: string }) => f.key === 'maxStreams')).toMatchObject({ group: 'playback', kind: 'int', min: 1, max: 50 });
    expect(m.features).toMatchObject({ livetv: false });
    expect(typeof m.features.requests).toBe('boolean');
    expect(typeof m.features.cast).toBe('boolean');
    expect(m.libraries).toEqual([{ id: 'f1', name: 'Filme' }, { id: 'f2', name: 'Serien' }]);
    expect(m.roles.map((r: { key: string }) => r.key)).toEqual(['admin', 'family', 'friend', 'guest']);
    const fam = m.roles.find((r: { key: string }) => r.key === 'family');
    expect(fam).toMatchObject({ label: 'Familie', builtinLabel: true, origin: 'code', invitable: true, position: 1, accounts: 2, profiles: 3, kidsProfiles: 1, missingLibraries: [] });
    expect(Object.keys(fam.values).sort()).toEqual(MATRIX_FIELDS.map((f) => f.key).sort());
    expect(Object.keys(fam.sources).sort()).toEqual(MATRIX_FIELDS.map((f) => f.key).sort());
    expect(fam.values).toMatchObject({ maxStreams: 4, maxHeight: null, requestsPerMonth: 2, comments: true, partySchedule: false });
    expect(fam.sources.maxStreams).toBe('default');
    expect(m.roles.find((r: { key: string }) => r.key === 'admin')).toMatchObject({ accounts: 2, invitable: false, sources: { party: 'admin' } });
    expect(m.roles.find((r: { key: string }) => r.key === 'guest')).toMatchObject({ accounts: 0, profiles: 0, kidsProfiles: 0 });

    expect((await put('family', { maxStreams: 3 })).statusCode).toBe(200);
    const after = await roleOf('family');
    expect(after.values.maxStreams).toBe(3);
    expect(after.sources.maxStreams).toBe('role');
    expect(after.sources.maxBitrate).toBe('default');
  });

  it('libraries answer [] while the media server cannot list them', async () => {
    folders = null as never; // the fake answers garbage: the list fails
    forgetLibraries(env.ctx);
    const m = (await get()).matrix;
    expect(m.libraries).toEqual([]);
    expect(m.roles.find((r: { key: string }) => r.key === 'family').missingLibraries).toEqual([]);
  });

  it('legacy fields stay', async () => {
    const g = await get();
    expect(g.invitable).toEqual(['family', 'friend', 'guest']);
    expect(g.roles.friend).toMatchObject({ label: 'Freund', builtinLabel: true, maxStreams: 2 });
    const friend = g.limits.find((l: { role: string }) => l.role === 'friend');
    expect(friend).toMatchObject({ requestsPerMonth: 2, isDefault: true, remoteDefault: 8_000_000, remoteIsDefault: true, maxHeight: null });
    await put('friend', { remoteMaxBitrate: 12_000_000 });
    expect((await get()).limits.find((l: { role: string }) => l.role === 'friend')).toMatchObject({ remoteMaxBitrate: 12_000_000, remoteDefault: 8_000_000, remoteIsDefault: false });
  });
});

describe('requestsPerMonth source', () => {
  it('reads as inherited unless the stored value differs from the default', async () => {
    const limit = async () => (await get()).limits.find((l: { role: string }) => l.role === 'family');
    // an unrelated first write stores the default (null would mean unlimited), the field still reads inherited
    await put('family', { maxStreams: 3 });
    expect((await row('family')).requests_per_month).toBe(2);
    expect((await roleOf('family')).sources.requestsPerMonth).toBe('default');
    expect(await limit()).toMatchObject({ requestsPerMonth: 2, isDefault: true });
    await put('family', { requestsPerMonth: 5 });
    expect((await roleOf('family')).sources.requestsPerMonth).toBe('role');
    expect(await limit()).toMatchObject({ requestsPerMonth: 5, isDefault: false });
    await put('family', { requestsPerMonth: 'unlimited' });
    expect((await roleOf('family')).sources.requestsPerMonth).toBe('role');
    // back to the inherited value
    await put('family', { requestsPerMonth: null });
    expect((await roleOf('family')).sources.requestsPerMonth).toBe('default');
    expect(await limit()).toMatchObject({ requestsPerMonth: 2, isDefault: true });
  });

  it('a catalogue role defaults to the limit of its base', async () => {
    // an admin-created role on base admin (unlimited wishes), no role_settings row yet
    await env.pool.query("insert into roles(key, label, base, origin, position) values ('kino', 'Kino', 'admin', 'admin', 9)");
    invalidateRoles(env.ctx);
    const kino = await roleOf('kino');
    expect(kino.values.requestsPerMonth).toBeNull();
    expect(kino.sources.requestsPerMonth).toBe('default');
    expect(await roleLimitFor(env.ctx, 'kino')).toBeNull();
    await put('kino', { maxStreams: 3 });
    expect((await row('kino')).requests_per_month).toBeNull();
    expect((await audits('kino')).map((a) => a.meta)).toEqual([{ from: { maxStreams: 6 }, to: { maxStreams: 3 } }]);
    expect((await roleOf('kino')).sources.requestsPerMonth).toBe('default');
  });
});

describe('PUT /api/admin/roles/:role', () => {
  it('partial write merges and audits once', async () => {
    const r = await put('guest', { maxParentalRating: 16, perms: { cast: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect(await row('guest')).toMatchObject({ template: { maxParentalRating: 16 }, perms: { cast: false }, requests_per_month: 2 });
    const a = await audits('guest');
    expect(a).toHaveLength(1);
    expect(a[0].meta).toEqual({ from: { maxParentalRating: 12, cast: true }, to: { maxParentalRating: 16, cast: false } });
    // the same values again: nothing changed, no audit
    expect((await put('guest', { maxParentalRating: 16, perms: { cast: false } })).statusCode).toBe(200);
    expect(await audits('guest')).toHaveLength(1);
    // a perms key back to inherit: the others stay
    await put('guest', { perms: { cast: null, comments: true } });
    expect((await row('guest')).perms).toEqual({ comments: true });
    expect((await roleOf('guest')).values).toMatchObject({ cast: true, comments: true, maxParentalRating: 16 });
  });

  it("two partial writes keep each other's fields", async () => {
    // two admins save different fields of the same role at the same time
    const [a, b] = await Promise.all([put('family', { maxStreams: 3 }, admin), put('family', { downloadDays: 14 }, admin2)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const r = await row('family');
    expect(r.template).toEqual({ maxStreams: 3, downloadDays: 14 });
    expect(r).toMatchObject({ download_days: 14, max_height: null, transcoding: null, requests_per_month: 2 });
    // one after the other, too
    await put('family', { transcoding: false });
    await put('family', { maxHeight: 1080 });
    expect((await row('family')).template).toEqual({ maxStreams: 3, downloadDays: 14, transcoding: false, maxHeight: 1080 });
    expect(await row('family')).toMatchObject({ download_days: 14, transcoding: false, max_height: 1080 });
    expect((await roleOf('family')).values).toMatchObject({ maxStreams: 3, downloadDays: 14, transcoding: false, maxHeight: 1080 });
  });

  it("null inherits, 'unlimited' lifts", async () => {
    expect((await put('guest', { maxHeight: 'unlimited' })).statusCode).toBe(200);
    expect(await row('guest')).toMatchObject({ template: { maxHeight: null }, max_height: 0 });
    expect((await roleOf('guest')).values.maxHeight).toBeNull();
    expect((await put('guest', { maxHeight: null })).statusCode).toBe(200);
    expect((await row('guest')).template).toEqual({});
    expect((await row('guest')).max_height).toBeNull();
    expect((await roleOf('guest')).values.maxHeight).toBe(1080);
    expect((await put('guest', { maxParentalRating: 'unlimited' })).statusCode).toBe(200);
    expect((await roleOf('guest')).values.maxParentalRating).toBeNull();
    expect((await put('guest', { requestsPerMonth: 'unlimited' })).statusCode).toBe(200);
    expect((await row('guest')).requests_per_month).toBeNull();
    expect((await roleOf('guest')).values.requestsPerMonth).toBeNull();
    expect((await put('guest', { requestsPerMonth: null })).statusCode).toBe(200);
    expect((await row('guest')).requests_per_month).toBe(2);
    expect((await put('guest', { requestsPerMonth: 5 })).statusCode).toBe(200);
    expect((await row('guest')).requests_per_month).toBe(5);
    // a write of another field keeps the stored limit; the first write of a role writes the code default
    await put('guest', { maxStreams: 2 });
    expect((await row('guest')).requests_per_month).toBe(5);
    await put('admin', { maxStreams: 8 });
    expect((await row('admin')).requests_per_month).toBeNull();
  });

  it('admin perms are locked', async () => {
    const r = await put('admin', { perms: { party: false } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'admin_perms_locked' });
    const inv = await put('admin', { invitable: true });
    expect(inv.statusCode).toBe(400);
    expect(inv.json()).toEqual({ error: 'admin_not_invitable' });
    expect((await put('admin', { maxStreams: 8 })).statusCode).toBe(200);
    expect((await roleOf('admin')).values).toMatchObject({ maxStreams: 8, party: true });
  });

  it('label and invitable go to the catalogue', async () => {
    expect((await put('friend', { label: 'Kumpel', invitable: false })).statusCode).toBe(200);
    expect((await env.pool.query("select label, invitable from roles where key='friend'")).rows[0]).toEqual({ label: 'Kumpel', invitable: false });
    const g = await get();
    expect(g.invitable).toEqual(['family', 'guest']);
    expect(g.matrix.roles.find((r: { key: string }) => r.key === 'friend')).toMatchObject({ label: 'Kumpel', builtinLabel: false, invitable: false });
    expect((await audits('friend'))[0].meta).toEqual({ from: { label: null, invitable: true }, to: { label: 'Kumpel', invitable: false } });
    expect((await put('friend', { label: null })).statusCode).toBe(200);
    expect((await roleOf('friend')).label).toBe('Freund');
    expect((await row('friend'))).toBeUndefined(); // catalogue fields only: no role_settings row
  });

  it('validation and unknown roles', async () => {
    expect((await put('nobody', { maxStreams: 2 })).statusCode).toBe(404);
    for (const body of [{ maxStreams: 0 }, { maxStreams: 51 }, { maxHeight: 100 }, { maxHeight: 'none' }, { maxParentalRating: 22 }, { requestsPerMonth: 101 },
      { libraries: [] }, { libraries: 'some' }, { label: '' }, { label: 'x'.repeat(31) }, { perms: { telepathy: true } }, { colour: 'red' }, { maxBitrate: 100 }]) {
      expect((await put('friend', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await row('friend')).toBeUndefined();
  });

  it('media fields re-apply, others do not', async () => {
    let n = policies().length;
    const r = await put('family', { transcoding: false });
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 3, failed: 0 } });
    const sent = policies().slice(n);
    expect(sent.map((c) => c.path).sort()).toEqual([JF.anna, JF.ben, JF.kids].map((id) => `/Users/${id}/Policy`).sort());
    expect(sent.every((c) => c.body.EnableVideoPlaybackTranscoding === false)).toBe(true);
    n = policies().length;
    expect((await put('family', { downloadDays: 14 })).json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect((await put('family', { perms: { comments: false } })).statusCode).toBe(200);
    expect((await put('family', { requestsPerMonth: 4 })).statusCode).toBe(200);
    expect(policies()).toHaveLength(n);
    // one identity's policy write fails: 502, the value is stored anyway
    failFor = JF.ben;
    const bad = await put('family', { maxStreams: 2 });
    expect(bad.statusCode).toBe(502);
    expect(bad.json()).toEqual({ error: 'policy_partial', failed: 1, identities: 3 });
    expect((await row('family')).template).toMatchObject({ maxStreams: 2 });
  });

  it('pinning or unpinning an inherited value is audited once and re-applies nothing', async () => {
    const n = policies().length;
    const r = await put('family', { maxStreams: 4 }); // the family default
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect((await roleOf('family')).sources.maxStreams).toBe('role');
    expect((await put('family', { maxStreams: null })).statusCode).toBe(200);
    expect((await roleOf('family')).sources.maxStreams).toBe('default');
    expect((await audits('family')).map((a) => a.meta)).toEqual([
      { from: { maxStreams: 4 }, to: { maxStreams: 4 }, layer: { maxStreams: { from: 'default', to: 'role' } } },
      { from: { maxStreams: 4 }, to: { maxStreams: 4 }, layer: { maxStreams: { from: 'role', to: 'default' } } },
    ]);
    expect(policies()).toHaveLength(n);
  });

  it('the audit entry is part of the write: no entry, no change', async () => {
    await env.pool.query("alter table audit_log add constraint t3_no_role_audit check (action <> 'role.update') not valid");
    try {
      expect((await put('family', { maxStreams: 3 })).statusCode).toBe(500);
      expect(await row('family')).toBeUndefined();
    } finally {
      await env.pool.query('alter table audit_log drop constraint t3_no_role_audit');
    }
  });

  it('download re-applies; maxDownloads and downloadMaxHeight do not', async () => {
    let n = policies().length;
    expect((await put('family', { download: false })).json()).toEqual({ ok: true, reapplied: { identities: 3, failed: 0 } });
    expect(policies().slice(n).every((c) => c.body.EnableContentDownloading === false)).toBe(true);
    expect(policies()).toHaveLength(n + 3);
    n = policies().length;
    expect((await put('family', { maxDownloads: 3 })).json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect((await put('family', { downloadMaxHeight: 480 })).json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect(policies()).toHaveLength(n);
  });

  it('a switch change reaches accountsWithout at once', async () => {
    expect(await accountsWithout(env.ctx, 'comments')).toEqual([]); // primed (cached 30 s)
    await put('family', { perms: { comments: false } });
    expect((await accountsWithout(env.ctx, 'comments')).sort()).toEqual([ANNA, BEN].sort());
  });

  it('a write needs no second database connection while it holds the role lock', async () => {
    // one connection only: two writers on one role, the second resolves the role with a cold catalogue cache inside its transaction
    const one = new pg.Pool({ connectionString: TEST_DB, max: 1 });
    const ctx1 = Object.create(env.ctx, { db: { value: one } }) as Ctx;
    try {
      const both = Promise.all([writeRole(ctx1, null, 'family', { maxDownloads: 3 }), writeRole(ctx1, null, 'family', { downloadDays: 9 })]);
      const late = new Promise((_, reject) => setTimeout(() => reject(new Error('pool starved')), 5000));
      await Promise.race([both, late]);
      expect((await row('family')).template).toEqual({ maxDownloads: 3, downloadDays: 9 });
    } finally {
      await one.end().catch(() => undefined);
    }
  });

  it('unknown library refused', async () => {
    const r = await put('family', { libraries: ['Nirgendwo'] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'unknown_library' });
    // a library added since the list was cached is found (one fresh look)
    folders = [...folders, { Id: 'f3', Name: 'Kinder' }];
    expect((await put('family', { libraries: ['Kinder'] })).statusCode).toBe(200);
    expect((await row('family')).template).toEqual({ libraries: ['Kinder'] });
    expect((await put('family', { libraries: 'all' })).statusCode).toBe(200);
    expect((await row('family')).template).toEqual({ libraries: 'all' });
  });

  it('stale library names are skipped and reported', async () => {
    folders = [{ Id: 'f1', Name: 'Filme' }, { Id: 'f9', Name: 'Archiv' }];
    forgetLibraries(env.ctx);
    expect((await put('family', { libraries: ['Filme', 'Archiv'] })).statusCode).toBe(200);
    folders = [{ Id: 'f1', Name: 'Filme' }]; // Archiv was removed on the media server
    forgetLibraries(env.ctx);
    const n = policies().length;
    const r = await put('family', { transcoding: false });
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 3, failed: 0 } });
    for (const c of policies().slice(n)) expect(c.body).toMatchObject({ EnableAllFolders: false, EnabledFolders: ['f1'] });
    expect((await roleOf('family')).missingLibraries).toEqual(['Archiv']);
  });
});
