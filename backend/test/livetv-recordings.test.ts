// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 3, Task 1: the recording rows, who sees a recording (spec §15.6), the admin's metadata list and the recording settings
 * (spec §6.4). Fictional people (Anna Beispiel, Ben Muster) and channels only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { adminListRecordings, listRecordings, progKey, recordSettings, setKeep, setVisibility, visibleRecording, type Visibility } from '../src/livetv/recordings.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

vi.mock('../src/livetv/detect.js', async (orig) => ({
  ...(await orig<typeof import('../src/livetv/detect.js')>()),
  livetvInstalled: vi.fn(() => true),
}));

type Who = { user: { id: string; role: string }; profile: { id: string; kids: boolean } };
let env: TestEnv;
const key = keyFromBase64(ENC_KEY);
const ANNA = '0e000000-0000-4000-a000-000000000001';
const ANNA_2 = '0e000000-0000-4000-a000-000000000002';
const ANNA_KIDS = '0e000000-0000-4000-a000-000000000003';
const BEN = '0e000000-0000-4000-a000-000000000004';
const GUEST = '0e000000-0000-4000-a000-000000000005';
let adminId = '';
const who = {
  anna: (): Who => ({ user: { id: ANNA, role: 'family' }, profile: { id: ANNA, kids: false } }),
  anna2: (): Who => ({ user: { id: ANNA, role: 'family' }, profile: { id: ANNA_2, kids: false } }),
  annaKids: (): Who => ({ user: { id: ANNA, role: 'family' }, profile: { id: ANNA_KIDS, kids: true } }),
  ben: (): Who => ({ user: { id: BEN, role: 'friend' }, profile: { id: BEN, kids: false } }),
  admin: (): Who => ({ user: { id: adminId, role: 'admin' }, profile: { id: adminId, kids: false } }),
};

let src = '';
let news = '';
let kids = '';
let nordlicht = '';
let hafen = '';

async function account(id: string, role: string, name: string, jf: string): Promise<void> {
  const sub = name.split(' ')[0]!.toLowerCase();
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, `${sub}-sub`, `${sub}@friend.example.com`, name, role, jf, encrypt(key, 'pw')]);
  await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name.split(' ')[0]]);
}
async function channel(name: string, group: string): Promise<string> {
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, group_override)
     values (gen_random_uuid(), $1, $2, $3, 'hls', $2, $4) returning id`, [src, name, encrypt(key, `https://iptv.example.com/${encodeURIComponent(name)}.m3u8`), group])).rows[0]!.id;
}
async function rec(o: { profile: string; user?: string; channel?: string | null; state?: string; visibility?: Visibility; title?: string; start?: string }): Promise<string> {
  const id = randomUUID();
  const start = new Date(o.start ?? '2026-11-14T19:00:00Z');
  await env.pool.query(
    `insert into livetv_recordings(id, profile_id, user_id, channel_id, channel_name, title, start_at, end_at, pad_before_s, pad_after_s, state, storage, dir, visibility, bytes, duration_s)
     values ($1, $2, $3, $4, 'Nordlicht TV', $5, $6, $7, 120, 300, $8, 'ff', gen_random_uuid(), $9, 1000, 3600)`,
    [id, o.profile, o.user ?? o.profile, o.channel === undefined ? nordlicht : o.channel, o.title ?? 'Sternstunde Physik', start, new Date(start.getTime() + 3_600_000),
      o.state ?? 'done', o.visibility ?? 'private']);
  return id;
}
const sees = async (w: Who, id: string) => (await visibleRecording(env.ctx, w.user, w.profile, id)) !== null;
const listed = async (w: Who) => (await listRecordings(env.ctx, w.user, w.profile)).map((r) => r.id).sort();

beforeAll(async () => {
  env = await makeEnv();
  await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
  await account(ANNA, 'family', 'Anna Beispiel', 'a'.repeat(32));
  await account(BEN, 'friend', 'Ben Muster', 'b'.repeat(32));
  await account(GUEST, 'guest', 'Gast Probe', 'c'.repeat(32));
  await env.pool.query(
    `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, 'Zweit', $3, 'anna-zweit', $4)`,
    [ANNA_2, ANNA, 'd'.repeat(32), encrypt(key, 'pw')]);
  await env.pool.query(
    `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating) values ($1, $2, 'Kiddo', $3, 'anna-kiddo', $4, true, 6)`,
    [ANNA_KIDS, ANNA, 'e'.repeat(32), encrypt(key, 'pw')]);
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  await env.pool.query('delete from livetv_recordings; delete from livetv_recording_purges; delete from livetv_recording_rules; delete from livetv_channels; delete from livetv_group_roles; delete from livetv_groups; delete from livetv_sources');
  src = (await env.pool.query<{ id: string }>(`insert into livetv_sources(id, kind, name, url_enc) values (gen_random_uuid(), 'm3u', 'Anbieter A', 'x') returning id`)).rows[0]!.id;
  news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released) values (gen_random_uuid(), 'Nachrichten', true) returning id")).rows[0]!.id;
  kids = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, kid_friendly) values (gen_random_uuid(), 'Kinder', true, true) returning id")).rows[0]!.id;
  // Anna's role sees both groups, Ben's (friend) only the news
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family'), ($1, 'friend'), ($2, 'family')", [news, kids]);
  nordlicht = await channel('Nordlicht TV', news);
  hafen = await channel('Hafenkanal', kids);
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
});

describe('visibility (spec §15.6)', () => {
  it('private recording visible only to the owner profile', async () => {
    const id = await rec({ profile: ANNA });
    expect(await sees(who.anna(), id)).toBe(true);
    expect(await sees(who.anna2(), id)).toBe(false);
    expect(await sees(who.annaKids(), id)).toBe(false);
    expect(await sees(who.ben(), id)).toBe(false);
    expect(await listed(who.anna())).toEqual([id]);
    expect(await listed(who.anna2())).toEqual([]);
    // the owner's own plan is listed too; a cancelled one never
    const plan = await rec({ profile: ANNA, state: 'scheduled', start: '2026-11-20T19:00:00Z' });
    const gone = await rec({ profile: ANNA, state: 'cancelled', start: '2026-11-21T19:00:00Z' });
    expect(await listed(who.anna())).toEqual([id, plan].sort());
    expect(await sees(who.anna(), gone)).toBe(false);
    expect((await listRecordings(env.ctx, who.anna().user, who.anna().profile, { state: 'scheduled' })).map((r) => r.id)).toEqual([plan]);
    expect((await listRecordings(env.ctx, who.anna().user, who.anna().profile, { state: 'done' })).map((r) => r.id)).toEqual([id]);
  });

  it('account share reaches every profile of the account, not other accounts', async () => {
    const id = await rec({ profile: ANNA, visibility: 'account' });
    expect(await sees(who.anna2(), id)).toBe(true);
    expect(await sees(who.ben(), id)).toBe(false);
    expect(await listed(who.anna2())).toEqual([id]);
    expect(await listed(who.ben())).toEqual([]);
    // somebody else's plan is not shown, even shared
    const plan = await rec({ profile: ANNA, visibility: 'account', state: 'scheduled', start: '2026-11-20T19:00:00Z' });
    expect(await sees(who.anna2(), plan)).toBe(false);
  });

  it('everyone share needs the channel in the profile\'s set', async () => {
    const news1 = await rec({ profile: ANNA, visibility: 'everyone' });
    const kids1 = await rec({ profile: ANNA, visibility: 'everyone', channel: hafen, start: '2026-11-15T10:00:00Z' });
    expect(await sees(who.ben(), news1)).toBe(true);
    expect(await sees(who.ben(), kids1)).toBe(false); // Ben's role does not see the kids group
    expect(await listed(who.ben())).toEqual([news1]);
    // a recording whose channel was deleted is the owner's only
    const orphan = await rec({ profile: ANNA, visibility: 'everyone', channel: null, start: '2026-11-16T10:00:00Z' });
    expect(await sees(who.ben(), orphan)).toBe(false);
    expect(await sees(who.anna(), orphan)).toBe(true);
  });

  it('kids see only shared recordings of kid-friendly groups', async () => {
    const own = await rec({ profile: ANNA, channel: hafen });
    const accNews = await rec({ profile: ANNA, visibility: 'account', start: '2026-11-15T10:00:00Z' });
    const accKids = await rec({ profile: ANNA, visibility: 'account', channel: hafen, start: '2026-11-15T11:00:00Z' });
    const allKids = await rec({ profile: BEN, visibility: 'everyone', channel: hafen, start: '2026-11-15T12:00:00Z' });
    const allNews = await rec({ profile: BEN, visibility: 'everyone', start: '2026-11-15T13:00:00Z' });
    expect(await sees(who.annaKids(), own)).toBe(false);
    expect(await sees(who.annaKids(), accNews)).toBe(false);
    expect(await sees(who.annaKids(), accKids)).toBe(true);
    expect(await sees(who.annaKids(), allKids)).toBe(true);
    expect(await sees(who.annaKids(), allNews)).toBe(false);
    expect(await listed(who.annaKids())).toEqual([accKids, allKids].sort());
    // an unreleased kids group is out
    await env.pool.query('update livetv_groups set released = false where id = $1', [kids]);
    invalidateLivetvRights();
    expect(await sees(who.annaKids(), accKids)).toBe(false);
  });

  it('admin list shows metadata but visibleRecording refuses an unshared one', async () => {
    const id = await rec({ profile: ANNA, title: 'Die Leuchtturmwärter' });
    expect(await sees(who.admin(), id)).toBe(false);
    const list = await adminListRecordings(env.ctx);
    expect(list.total).toBe(1);
    expect(list.items[0]).toEqual({ id, profile: 'Anna', channel: 'Nordlicht TV', start: '2026-11-14T19:00:00.000Z', end: '2026-11-14T20:00:00.000Z', mode: null, state: 'done', error: null, bytes: 1000, keep: false });
    expect(JSON.stringify(list)).not.toContain('Leuchtturm');
    // a share makes it playable for the admin like for anybody whose set has the channel (the admin role sees every group)
    await env.pool.query("update livetv_recordings set visibility = 'everyone' where id = $1", [id]);
    expect(await sees(who.admin(), id)).toBe(true);
  });

  it('without liveTv nothing is visible, not even the own recordings', async () => {
    const id = await rec({ profile: ANNA });
    await env.pool.query(`insert into role_settings(role, perms) values ('family', '{"liveTv": false}') on conflict (role) do update set perms = role_settings.perms || excluded.perms`);
    invalidateRoles(env.ctx);
    invalidateRights();
    try {
      expect(await sees(who.anna(), id)).toBe(false);
      expect(await listed(who.anna())).toEqual([]);
    } finally {
      await env.pool.query(`update role_settings set perms = perms - 'liveTv' where role = 'family'`);
      invalidateRoles(env.ctx);
      invalidateRights();
    }
  });
});

describe('keep and share', () => {
  it('keep and visibility: owner or admin only; keep calls off a pending deletion', async () => {
    const id = await rec({ profile: ANNA });
    await env.pool.query("update livetv_recordings set delete_after = now() + interval '1 day' where id = $1", [id]);
    expect(await setKeep(env.ctx, { userId: BEN, profileId: BEN, admin: false }, id, true)).toBeNull();
    expect(await setKeep(env.ctx, { userId: ANNA, profileId: ANNA_2, admin: false }, id, true)).toBeNull(); // another profile of the account
    const kept = await setKeep(env.ctx, { userId: ANNA, profileId: ANNA, admin: false }, id, true);
    expect([kept?.keep, kept?.delete_after]).toEqual([true, null]);
    expect(await setVisibility(env.ctx, { userId: BEN, profileId: BEN, admin: false }, id, 'everyone')).toBeNull();
    const shared = await setVisibility(env.ctx, { userId: adminId, profileId: adminId, admin: true }, id, 'everyone');
    expect([shared?.visibility, shared?.shared_by]).toEqual(['everyone', adminId]);
    const back = await setVisibility(env.ctx, { userId: ANNA, profileId: ANNA, admin: false }, id, 'private');
    expect([back?.visibility, back?.shared_by]).toEqual(['private', null]);
  });
});

describe('data', () => {
  it('profile delete cascades recordings, rules and progress', async () => {
    const id = await rec({ profile: ANNA_2, user: ANNA });
    const rule = randomUUID();
    await env.pool.query("insert into livetv_recording_rules(id, profile_id, user_id, kind, channel_id, series_key, title) values ($1, $2, $3, 'series', $4, 'leuchtturm', 'Die Leuchtturmwärter')", [rule, ANNA_2, ANNA, nordlicht]);
    const other = await rec({ profile: ANNA, visibility: 'account' });
    await env.pool.query('insert into livetv_recording_progress(profile_id, recording_id, position_s) values ($1, $2, 60), ($1, $3, 10)', [ANNA_2, id, other]);
    await env.pool.query('delete from profiles where id = $1', [ANNA_2]);
    const n = async (sql: string, args: unknown[]) => Number((await env.pool.query(`select count(*)::int n from ${sql}`, args)).rows[0].n);
    expect(await n('livetv_recordings where id = $1', [id])).toBe(0);
    expect(await n('livetv_recording_rules where id = $1', [rule])).toBe(0);
    expect(await n('livetv_recording_progress where profile_id = $1', [ANNA_2])).toBe(0);
    expect(await n('livetv_recordings where id = $1', [other])).toBe(1); // another profile's recording stays
    await env.pool.query(
      `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, 'Zweit', $3, 'anna-zweit', $4)`,
      [ANNA_2, ANNA, 'd'.repeat(32), encrypt(key, 'pw')]);
  });

  it('recordSettings defaults are ff, 200 GB, 30 days, 2/5 min, 4', () => {
    expect(recordSettings(env.ctx)).toEqual({
      storage: 'ff', libraryId: null, libraryJfPath: '/media/Aufnahmen', limitBytes: 200_000_000_000, retentionDays: 30, padBeforeS: 120, padAfterS: 300, maxParallel: 4,
    });
  });

  it('progKey: normalised title and episode or sub-title', () => {
    expect(progKey({ title: '  Die  Leuchtturmwärter ', episode: 'S01E02' })).toBe('die leuchtturmwärter\ns01e02');
    expect(progKey({ title: 'Die Leuchtturmwärter', subtitle: 'Sturm' })).toBe('die leuchtturmwärter\nsturm');
    expect(progKey({ title: 'Sternstunde Physik' })).toBe('sternstunde physik\n');
  });
});
