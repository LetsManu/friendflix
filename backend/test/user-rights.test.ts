// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetLibraries } from '../src/libraries.js';
import { getUserOverrides } from '../src/limits.js';
import { KIDS_OFF, MATRIX_FIELDS } from '../src/perms.js';
import { effectiveRights, invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { makeEnv, type TestEnv } from './helpers.js';

// the gateway memo is forgotten through devices.ts: count the calls, keep the behaviour
vi.mock('../src/devices.js', async (orig) => {
  const m = await orig<typeof import('../src/devices.js')>();
  return { ...m, forgetUserAuth: vi.fn(m.forgetUserAuth) };
});
const { forgetUserAuth } = await import('../src/devices.js');
const forgot = vi.mocked(forgetUserAuth);

// Users & permissions Task 5: GET/PUT /api/admin/users/:id/rights (every template field and switch per person) and the legacy
// PUT /:id/limits alias on the same write.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let folders = [{ Id: 'f1', Name: 'Filme' }, { Id: 'f2', Name: 'Serien' }, { Id: 'f9', Name: 'Archiv' }];
let failFor = '';

const ANNA = '0b000000-0000-4000-a000-000000000001';
const KIDS = '0b000000-0000-4000-a000-000000000002';
const GROWN = '0b000000-0000-4000-a000-000000000003';
const JF = { anna: 'anna'.padEnd(32, '0'), kids: 'kids'.padEnd(32, '0'), ben: 'ben'.padEnd(32, '0') };
const anna = { id: ANNA, role: 'friend' };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Library/MediaFolders': () => ({ json: { Items: folders } }),
    'POST /Users/[^/]+/Policy': (u) => (failFor && u.pathname.includes(failFor) ? { status: 500, raw: 'nope' } : { status: 204 }),
  });
  admin = await env.login();
  // Anna Beispiel: a friend with her owner profile, a grown-up profile and a kids profile (cap 6), each profile with its own identity
  await env.pool.query(
    "insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, 'sub-anna', 'Anna Beispiel', 'friend', $2, 'anna', 'x')",
    [ANNA, JF.anna]);
  await env.pool.query("insert into profiles(id, user_id, name, is_owner) values ($1, $1, 'Anna', true)", [ANNA]);
  await env.pool.query(
    "insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, 'Ben', $3, 'ben', 'x')", [GROWN, ANNA, JF.ben]);
  await env.pool.query(
    "insert into profiles(id, user_id, name, kids, kids_max_rating, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, 'Kind', true, 6, $3, 'kids', 'x')",
    [KIDS, ANNA, JF.kids]);
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from user_limits; delete from role_settings; delete from audit_log; delete from account_deletions');
  invalidateRoles(env.ctx);
  invalidateRights();
  folders = [{ Id: 'f1', Name: 'Filme' }, { Id: 'f2', Name: 'Serien' }, { Id: 'f9', Name: 'Archiv' }];
  forgetLibraries(env.ctx);
  failFor = '';
  forgot.mockClear();
});

const call = (method: 'GET' | 'PUT', url: string, payload?: object) =>
  env.app.inject({ method, url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, ...(payload ? { payload } : {}) });
const put = (body: object, id = ANNA) => call('PUT', `/api/admin/users/${id}/rights`, body);
const get = async (profile?: string) => (await call('GET', `/api/admin/users/${ANNA}/rights${profile ? `?profile=${profile}` : ''}`)).json();
const rowOf = (view: { rows: Array<{ key: string }> }, key: string) => view.rows.find((r) => r.key === key);
const stored = async () => (await env.pool.query('select * from user_limits where user_id=$1', [ANNA])).rows[0];
const policies = () => env.jfCalls.filter((c) => c.method === 'POST' && /\/Policy$/.test(c.path));
const audits = async () => (await env.pool.query("select actor, meta from audit_log where action='user.rights' and target=$1 order by id", [ANNA])).rows;

describe('GET /api/admin/users/:id/rights', () => {
  it('rows carry value, role value, override and source', async () => {
    expect((await put({ overrides: { cast: false } })).statusCode).toBe(200);
    const v = await get();
    expect(v).toMatchObject({ role: 'friend', note: null, profile: null, hardKids: [], missingLibraries: [] });
    expect(v.rows.map((r: { key: string }) => r.key)).toEqual(MATRIX_FIELDS.map((f) => f.key));
    expect(rowOf(v, 'cast')).toEqual({ key: 'cast', value: false, roleValue: true, override: false, source: 'user' });
    expect(rowOf(v, 'maxStreams')).toEqual({ key: 'maxStreams', value: 2, roleValue: 2, override: null, source: 'default' });
  });

  it('kids profile view', async () => {
    const v = await get(KIDS);
    expect(v.profile).toEqual({ id: KIDS, name: 'Kind', kids: true, maxRating: 6 });
    expect(v.hardKids).toEqual([...KIDS_OFF]);
    expect(rowOf(v, 'comments')).toMatchObject({ value: false, roleValue: true, override: null, source: 'kids' });
    expect(rowOf(v, 'maxParentalRating')).toMatchObject({ value: 6, roleValue: null, source: 'kids' });
    // a grown-up profile has no overlay; another account's profile is not found
    const g = await get(GROWN);
    expect(g).toMatchObject({ profile: { id: GROWN, name: 'Ben', kids: false, maxRating: null }, hardKids: [] });
    expect(rowOf(g, 'comments')).toMatchObject({ value: true, source: 'default' });
    expect((await call('GET', `/api/admin/users/${ANNA}/rights?profile=0b000000-0000-4000-a000-0000000000ff`)).statusCode).toBe(404);
  });

  it('a user override never loosens a kids profile', async () => {
    expect((await put({ overrides: { comments: true, party: true, maxParentalRating: 'unlimited' } })).statusCode).toBe(200);
    const v = await get(KIDS);
    for (const k of KIDS_OFF) expect(rowOf(v, k), k).toMatchObject({ value: false, source: 'kids' });
    expect(rowOf(v, 'maxParentalRating')).toMatchObject({ value: 6, override: null, source: 'kids' }); // 'unlimited' = the friend role: dropped
  });
});

describe('PUT /api/admin/users/:id/rights', () => {
  it('equal to role is not stored', async () => {
    const r = await put({ overrides: { maxStreams: 2 } });
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect(await stored()).toBeUndefined();
    expect(await audits()).toEqual([]);
    // an existing override set back to the role value is cleared
    await put({ overrides: { maxStreams: 3, maxHeight: 1080 } });
    await put({ overrides: { maxStreams: 2, maxHeight: 'unlimited' } });
    expect(await stored()).toBeUndefined();
  });

  it('more and less permissive', async () => {
    expect((await put({ overrides: { download: true, cast: false } })).statusCode).toBe(200);
    expect(await stored()).toMatchObject({ download: true, perms: { cast: false } });
    const r = (await effectiveRights(env.ctx, anna))!;
    expect(r.template.download).toBe(true);
    expect(r.perms.cast).toBe(false);
    expect(r.sources).toMatchObject({ download: 'user', cast: 'user' });
  });

  it('every field in its encoding', async () => {
    const r = await put({
      overrides: {
        libraries: ['filme'], maxParentalRating: 12, maxBitrate: 10_000_000, remoteMaxBitrate: 3_000_000, transcoding: false, maxHeight: 720,
        maxDownloads: 4, downloadMaxHeight: 480, requestsPerMonth: 'unlimited', partySchedule: true,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await stored()).toMatchObject({
      libraries: ['Filme'], max_parental_rating: 12, max_bitrate: 10_000_000, remote_bitrate: 3_000_000, transcoding: false, max_height: 720,
      max_downloads: 4, download_max_height: 480, requests_per_month: -1, perms: { partySchedule: true },
    });
    const t = (await effectiveRights(env.ctx, anna))!.template;
    expect(t).toMatchObject({ libraries: ['Filme'], maxParentalRating: 12, maxHeight: 720, requestsPerMonth: null });
    const v = await get();
    expect(rowOf(v, 'requestsPerMonth')).toMatchObject({ value: null, roleValue: 2, override: 'unlimited', source: 'user' });
    expect(rowOf(v, 'libraries')).toMatchObject({ value: ['Filme'], roleValue: 'all', override: ['Filme'] });
    // 'unlimited' caps of a capped role are stored as their sentinels
    await env.pool.query("update users set role='guest' where id=$1", [ANNA]);
    try {
      await put({ overrides: { maxHeight: 'unlimited', maxParentalRating: 'unlimited' } });
      expect(await stored()).toMatchObject({ max_height: 0, max_parental_rating: -1 });
      const g = await get();
      expect(rowOf(g, 'maxHeight')).toMatchObject({ value: null, roleValue: 1080, override: 'unlimited' });
      expect(rowOf(g, 'maxParentalRating')).toMatchObject({ value: null, roleValue: 12, override: 'unlimited' });
    } finally {
      await env.pool.query("update users set role='friend' where id=$1", [ANNA]);
      invalidateRights(ANNA);
    }
  });

  it('media fields re-apply the account', async () => {
    const n = policies().length;
    const r = await put({ overrides: { maxParentalRating: 12 } });
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 3, failed: 0 } });
    expect(policies().slice(n).map((c) => c.path).sort()).toEqual([JF.anna, JF.ben, JF.kids].map((j) => `/Users/${j}/Policy`).sort());
    expect(policies().slice(n).find((c) => c.path.includes(JF.anna))!.body.MaxParentalRating).toBe(12);
    expect(policies().slice(n).find((c) => c.path.includes(JF.kids))!.body.MaxParentalRating).toBe(6); // the kids cap stays
    expect(forgot).toHaveBeenCalledWith(env.ctx, ANNA);
    forgot.mockClear();
    const m = policies().length;
    expect((await put({ note: 'Darf mehr' })).json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect(policies().length).toBe(m);
    expect(forgot).not.toHaveBeenCalled();
    // download is part of the policy too
    expect((await put({ overrides: { download: true } })).json()).toEqual({ ok: true, reapplied: { identities: 3, failed: 0 } });
  });

  it('a field outside the media policy forgets the gateway memo without a re-apply', async () => {
    const n = policies().length;
    expect((await put({ overrides: { remoteMaxBitrate: 2_000_000 } })).json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect(policies().length).toBe(n);
    expect(forgot).toHaveBeenCalledWith(env.ctx, ANNA);
  });

  it('a failed identity answers 502 policy_partial, the rights stay stored', async () => {
    failFor = JF.kids;
    const r = await put({ overrides: { maxStreams: 1 } });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'policy_partial', failed: 1, identities: 3 });
    expect(await stored()).toMatchObject({ max_streams: 1 });
  });

  it('audit holds changed fields only, no note text', async () => {
    await put({ overrides: { cast: false }, note: 'Darf am Wochenende mehr' });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0].meta).toEqual({ from: { cast: true }, to: { cast: false }, note: 'changed' });
    expect(JSON.stringify(a[0].meta)).not.toContain('Wochenende');
    expect((await get()).note).toBe('Darf am Wochenende mehr');
    // the same body again changes nothing: no entry
    await put({ overrides: { cast: false }, note: 'Darf am Wochenende mehr' });
    expect(await audits()).toHaveLength(1);
    // the note cleared: an entry without fields
    await put({ note: null });
    expect((await audits()).at(-1).meta).toEqual({ from: {}, to: {}, note: 'changed' });
  });

  it('an override left equal to a changed role is unpinned with a layer entry', async () => {
    await put({ overrides: { maxStreams: 3 } });
    await env.pool.query("insert into role_settings(role, template) values ('friend', '{\"maxStreams\": 3}')");
    invalidateRoles(env.ctx);
    const n = policies().length;
    expect((await put({ overrides: { maxStreams: null } })).json()).toEqual({ ok: true, reapplied: { identities: 0, failed: 0 } });
    expect(policies().length).toBe(n); // the effective value did not change
    expect((await audits()).at(-1).meta).toEqual({ from: { maxStreams: 3 }, to: { maxStreams: 3 }, layer: { maxStreams: { from: 'user', to: 'role' } } });
    expect(await stored()).toBeUndefined();
  });

  it('stale library names are skipped and reported', async () => {
    expect((await put({ overrides: { libraries: ['Filme', 'Archiv'] } })).statusCode).toBe(200);
    folders = [{ Id: 'f1', Name: 'Filme' }, { Id: 'f2', Name: 'Serien' }]; // Archiv was removed on the media server
    forgetLibraries(env.ctx);
    const n = policies().length;
    const r = await put({ overrides: { transcoding: false } });
    expect(r.json()).toEqual({ ok: true, reapplied: { identities: 3, failed: 0 } });
    expect(policies().length - n).toBe(3);
    for (const c of policies().slice(n)) expect(c.body).toMatchObject({ EnableAllFolders: false, EnabledFolders: ['f1'] });
    const v = await get();
    expect(v.missingLibraries).toEqual(['Archiv']);
    expect(rowOf(v, 'libraries')).toMatchObject({ value: ['Filme', 'Archiv'], override: ['Filme', 'Archiv'] });
    // a write naming the removed library is refused
    expect((await put({ overrides: { libraries: ['Archiv'] } })).json()).toEqual({ error: 'unknown_library' });
  });

  it('unknown field refused', async () => {
    for (const bad of [
      { overrides: { telepathy: true } }, { overrides: { maxStreams: 0 } }, { overrides: { maxHeight: 100 } }, { overrides: { requestsPerMonth: 101 } },
      { overrides: { cast: 'yes' } }, { overrides: { perms: { cast: false } } }, { overrides: { label: 'x' } }, { overrides: {}, extra: 1 },
      { note: 'x'.repeat(201) }, { note: '\ud800' },
    ]) {
      const r = await put(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await stored()).toBeUndefined();
  });

  it('admin switches stay locked, deletion in progress and unknown accounts are refused', async () => {
    const adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id as string;
    expect((await put({ overrides: { comments: false } }, adminId)).json()).toEqual({ error: 'admin_perms_locked' });
    expect((await put({ overrides: { cast: false } }, '0b000000-0000-4000-a000-0000000000ff')).statusCode).toBe(404);
    await env.pool.query("insert into account_deletions(user_id, pseudonym) values ($1, 'gone-1')", [ANNA]);
    const r = await put({ overrides: { cast: false } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'deletion_in_progress' });
    expect(await stored()).toBeUndefined();
  });
});

describe('legacy PUT /:id/limits', () => {
  it('legacy /limits maps to rights', async () => {
    const r = await call('PUT', `/api/admin/users/${ANNA}/limits`, { remoteBitrate: 4_000_000 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ limits: { maxStreams: null, remoteBitrate: 4_000_000, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null } });
    expect((await stored()).remote_bitrate).toBe(4_000_000);
    expect((await audits()).at(-1).meta).toEqual({ from: { remoteMaxBitrate: 8_000_000 }, to: { remoteMaxBitrate: 4_000_000 } });
    // the other overrides stay
    await put({ overrides: { cast: false } });
    await call('PUT', `/api/admin/users/${ANNA}/limits`, { maxStreams: 3 });
    expect(await getUserOverrides(env.ctx, ANNA)).toMatchObject({ maxStreams: 3, remoteBitrate: 4_000_000, perms: { cast: false } });
  });
});
