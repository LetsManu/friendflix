// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 3, Task 6: storage modes (spec §15.3), space and retention (§15.5). livetv is a fake (`ctx.fetchImpl`), the media
 * server's library seam a stub on `ctx.jf.admin`. Fictional people, channels and titles only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { listEvents } from '../src/livetv/events.js';
import { effectiveStorage, getRecording } from '../src/livetv/recordings.js';
import { insertScheduled, livetvRecordTick } from '../src/livetv/recsched.js';
import { exportToLibrary, livetvStoreTick, spaceTick, stamp, usage } from '../src/livetv/recstore.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import { resolveRecToken } from '../src/livetv/tokens.js';
import { invalidateLiveConversions, invalidateRecordingUses } from '../src/livetv/streams.js';
import type { MediaAdmin } from '../src/media/types.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const key = keyFromBase64(ENC_KEY);
let env: TestEnv;
let admin: Sess;
let anna: Sess;
let adminId = '';
const annaId = '0c000000-0000-4000-a000-0000000000a1';
const GB = 1_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const calls: Call[] = [];
let exportAnswer: { status?: number; json: unknown } = { json: { path: 'Sternstunde Physik/Sternstunde Physik – x.ts', bytes: 7000 } };
const recorders = new Map<string, Record<string, unknown>>();
function fakeLivetv() {
  env.ctx.fetchImpl = fakeHttp({
    'GET /v1/system': () => ({ json: { cpu: { model: 'x', cores: 4, loadPct: 1 }, gpu: { devices: [], driver: null, readable: false, busyPct: null, nvidia: false }, encoders: ['libx264'], cache: { usedBytes: 0, maxBytes: 1 }, recordings: { usedBytes: 0, freeBytes: 500 * GB }, srt: { ports: [9000] }, library: { mounted: true, writable: true, dedicated: true, freeBytes: 900 * GB } } }),
    'GET /v1/streams': () => ({ json: [] }),
    'GET /v1/recordings': () => ({ json: [...recorders.values()] }),
    'POST /v1/recordings/[0-9a-f-]+/export': () => exportAnswer,
    'POST /v1/recordings/[0-9a-f-]+/delete': () => ({ status: 204 }),
    'POST /v1/recordings/[0-9a-f-]+/library-delete': () => ({ status: 204 }),
    'DELETE /v1/recordings/[0-9a-f-]+': () => ({ status: 204 }),
  }, calls);
}
/** the library seam of the media server (Jellyfin): a stub that records what it was asked */
const asked: string[] = [];
let foundItem: string | null = 'f'.repeat(32);
const seam: Pick<MediaAdmin, 'refreshLibrary' | 'libraryFolders' | 'createLibrary' | 'itemByPath'> = {
  refreshLibrary: async (id) => { asked.push(`refresh ${id}`); },
  libraryFolders: async () => [{ id: 'lib-aufnahmen', name: 'Aufnahmen', paths: ['/media/Aufnahmen/'] }, { id: 'lib-filme', name: 'Filme', paths: ['/media/Filme'] }],
  createLibrary: async (name, path, kind) => { asked.push(`create ${name} ${path} ${kind}`); return { id: 'lib-neu' }; },
  itemByPath: async (lib, path) => { asked.push(`find ${lib} ${path}`); return foundItem; },
};
const withSeam = () => Object.assign(env.ctx.jf.admin, seam);
const withoutSeam = () => { for (const k of Object.keys(seam)) delete (env.ctx.jf.admin as unknown as Record<string, unknown>)[k]; };

let src = '';
let nordlicht = '';
async function row(o: Record<string, unknown>): Promise<string> {
  const r = {
    id: randomUUID(), profile_id: annaId, user_id: annaId, channel_id: nordlicht, channel_name: 'Nordlicht TV', title: 'Sternstunde Physik',
    start_at: new Date(Date.now() - 10 * DAY), end_at: new Date(Date.now() - 10 * DAY + HOUR), pad_before_s: 120, pad_after_s: 300, storage: 'ff', dir: randomUUID(),
    state: 'done', bytes: 1000, mode: 'passthrough', duration_s: 3600, ...o,
  };
  const keys = Object.keys(r);
  await env.pool.query(`insert into livetv_recordings(${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
  return r.id;
}
const state = async (id: string) => (await env.pool.query('select state, delete_after, keep, library_path, bytes, jellyfin_item_id from livetv_recordings where id = $1', [id])).rows[0] ?? null;
const notices = async (kind: string) => (await env.pool.query('select user_id, title from notifications where kind = $1 order by id', [kind])).rows;
let addr = 0;
const call = (s: Sess, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${(++addr % 200) + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, 'anna', 'anna@friend.example.com', 'Anna Beispiel', 'family', $2, 'anna', $3)`,
    [annaId, 'a'.repeat(32), encrypt(key, 'pw')]);
  anna = await env.login({ sub: 'anna', email: 'anna@friend.example.com', name: 'Anna Beispiel', groups: [] });
  await env.pool.query('update devices set approved = true where user_id = $1', [annaId]);
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  await env.pool.query(`delete from notifications; delete from audit_log; delete from livetv_recordings; delete from livetv_recording_purges; delete from livetv_recording_rules; delete from livetv_channels;
    delete from livetv_group_roles; delete from livetv_groups; delete from livetv_sources`);
  for (const p of ['ltv', 'conv:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  calls.length = 0;
  asked.length = 0;
  recorders.clear();
  foundItem = 'f'.repeat(32);
  exportAnswer = { json: { path: 'Sternstunde Physik/Sternstunde Physik – x.ts', bytes: 7000 } };
  withSeam();
  fakeLivetv();
  await detectLivetv(env.ctx, 0, { strict: true });
  invalidateLiveConversions();
  src = (await env.pool.query<{ id: string }>(`insert into livetv_sources(id, kind, name, url_enc) values (gen_random_uuid(), 'm3u', 'Anbieter A', $1) returning id`, [encrypt(key, 'https://iptv.example.com/x')])).rows[0]!.id;
  const news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released) values (gen_random_uuid(), 'Nachrichten', true) returning id")).rows[0]!.id;
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [news]);
  nordlicht = (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, group_override) values (gen_random_uuid(), $1, 'n', $2, 'hls', 'Nordlicht TV', $3) returning id`,
    [src, encrypt(key, 'https://iptv.example.com/n.m3u8'), news])).rows[0]!.id;
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
  invalidateRecordingUses();
});

describe('space and retention (spec §15.5)', () => {
  it('usage over 90 % schedules the oldest unprotected for deletion with a 24-h notice', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_LIMIT_GB: 1 };
    const now = Date.now();
    const a = await row({ bytes: 0.4 * GB, start_at: new Date(now - 9 * DAY), end_at: new Date(now - 9 * DAY + HOUR), title: 'Die Leuchtturmwärter' });
    const kept = await row({ bytes: 0.3 * GB, keep: true, start_at: new Date(now - 8 * DAY), end_at: new Date(now - 8 * DAY + HOUR) });
    const c = await row({ bytes: 0.3 * GB, start_at: new Date(now - 7 * DAY), end_at: new Date(now - 7 * DAY + HOUR) });
    const d = await row({ bytes: 0.1 * GB, start_at: new Date(now - 6 * DAY), end_at: new Date(now - 6 * DAY + HOUR) });
    expect(await usage(env.ctx)).toBe(1.1 * GB);
    await spaceTick(env.ctx, now);
    // 1.1 GB > 0.9: the oldest unprotected (A, 0.4) brings the forecast to 0.7 ≤ 0.8; the kept one is never chosen
    expect((await state(a)).delete_after.getTime()).toBe(now + DAY);
    for (const x of [kept, c, d]) expect((await state(x)).delete_after).toBeNull();
    expect(await notices('livetv.rec.deleting')).toEqual([{ user_id: annaId, title: 'Die Leuchtturmwärter wird morgen gelöscht, um Platz zu schaffen. Behalten?' }]);
    expect(await notices('livetv.rec.storage')).toEqual([{ user_id: adminId, title: 'Aufnahmespeicher fast voll: 1 GB von 1 GB' }]);
    // again within the day: nothing new, nothing more scheduled
    await spaceTick(env.ctx, now + HOUR);
    expect((await notices('livetv.rec.deleting')).length + (await notices('livetv.rec.storage')).length).toBe(2);
    expect((await state(c)).delete_after).toBeNull();
    // 24 h later it goes, through livetv
    await spaceTick(env.ctx, now + DAY + 1000);
    expect(await state(a)).toBeNull();
    expect(calls.filter((x) => x.path === `/v1/recordings/${a}/delete`)).toHaveLength(1);
    // Behalten during the notice calls the deletion off (PATCH keep): see livetv-recordings.test.ts
  });

  it('keep protects; new recordings then fail storage_full', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_LIMIT_GB: 1 };
    const a = await row({ bytes: 0.7 * GB, keep: true });
    const b = await row({ bytes: 0.5 * GB, keep: true });
    await spaceTick(env.ctx);
    expect([(await state(a)).delete_after, (await state(b)).delete_after]).toEqual([null, null]);
    const due = await insertScheduled(env.ctx, {
      profileId: annaId, userId: annaId, ruleId: null, channelId: nordlicht, channelName: 'Nordlicht TV', title: 'Sternstunde Physik',
      start: Date.now() + 60_000, end: Date.now() + HOUR, padBeforeS: 120, padAfterS: 300, followEpg: false,
    });
    await livetvRecordTick(env.ctx);
    const r = await getRecording(env.ctx, due!);
    expect([r!.state, r!.error]).toEqual(['failed', 'storage_full']);
    expect((await notices('livetv.rec.failed')).map((n) => n.title)).toEqual(['Aufnahme fehlgeschlagen: Sternstunde Physik (Speicher voll)']);
  });

  it('retention deletes N days after watched', async () => {
    const now = Date.now();
    const old = await row({ watched_at: new Date(now - 31 * DAY) });
    const fresh = await row({ watched_at: new Date(now - 29 * DAY) });
    const kept = await row({ watched_at: new Date(now - 60 * DAY), keep: true });
    const unwatched = await row({ start_at: new Date(now - 300 * DAY), end_at: new Date(now - 300 * DAY + HOUR) });
    await spaceTick(env.ctx, now);
    expect(await state(old)).toBeNull();
    for (const x of [fresh, kept, unwatched]) expect(await state(x)).not.toBeNull();
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_RETENTION_DAYS: 0 }; // 0 = never
    await env.pool.query("update livetv_recordings set watched_at = now() - interval '400 days'");
    await spaceTick(env.ctx, now);
    expect((await env.pool.query('select count(*)::int n from livetv_recordings')).rows[0].n).toBe(3);
  });

  it('a deletion livetv did not confirm is finished by the next space tick', async () => {
    const id = await row({ state: 'deleting', delete_after: new Date() });
    await spaceTick(env.ctx);
    expect(await state(id)).toBeNull();
  });
});

describe('storage modes (spec §15.3)', () => {
  it('library mode exports, deletes the HLS folder and links the item', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'library', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
    expect(effectiveStorage(env.ctx)).toBe('library');
    // a running recording in mode library is collected by the tick, then exported
    const id = await row({ storage: 'library', state: 'recording', bytes: 5000, start_at: new Date(Date.now() - 2 * HOUR), end_at: new Date(Date.now() - HOUR) });
    const dir = (await getRecording(env.ctx, id))!.dir;
    recorders.set(id, { id, channelId: nordlicht, dir: '0f000000-0000-4000-a000-0000000000d1', state: 'done', segments: 'ts', bytes: 6000, durationS: 3600, gaps: [], error: null, since: 1 });
    await livetvRecordTick(env.ctx);
    // A-I2: the recording tick only collects; the export waits for the store job
    expect(calls.filter((c) => c.path.endsWith('/export'))).toEqual([]);
    expect((await env.pool.query('select export_state from livetv_recordings where id = $1', [id])).rows[0].export_state).toBe('pending');
    await livetvStoreTick(env.ctx);
    const exp = calls.find((c) => c.path === `/v1/recordings/${id}/export`)!;
    expect(exp.body).toEqual({ dir, folder: 'Sternstunde Physik', file: `Sternstunde Physik – ${stamp((await getRecording(env.ctx, id))!.start_at)}` });
    expect(calls.filter((c) => c.path === `/v1/recordings/${id}/delete`).map((c) => c.body)).toEqual([{ dir }]);
    expect(await state(id)).toMatchObject({ state: 'done', library_path: 'Sternstunde Physik/Sternstunde Physik – x.ts', bytes: '7000', jellyfin_item_id: 'f'.repeat(32) });
    expect(asked).toEqual(['refresh lib-aufnahmen', 'find lib-aufnahmen /media/Aufnahmen/Sternstunde Physik/Sternstunde Physik – x.ts']);
    // its playback through /media/r is over: the recording lives in the library now
    expect((await call(anna, 'POST', `/api/livetv/recordings/${id}/play`, {})).json()).toEqual({ error: 'in_library' });
    // a delete removes the library file too, through livetv by its stored path
    await call(anna, 'POST', `/api/livetv/recordings/${id}/progress`, { positionS: 1 });
    const del = await env.app.inject({ method: 'DELETE', url: `/api/livetv/recordings/${id}`, cookies: anna.cookies, headers: { 'x-csrf-token': anna.csrf } });
    expect(del.statusCode).toBe(204);
    expect(calls.filter((c) => c.path === `/v1/recordings/${id}/library-delete`).map((c) => c.body)).toEqual([{ path: 'Sternstunde Physik/Sternstunde Physik – x.ts' }]);
  });

  it('a scan that has not found the item yet is linked by a later space tick', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'library', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
    foundItem = null;
    const id = await row({ storage: 'library', start_at: new Date(Date.now() - 2 * HOUR), end_at: new Date(Date.now() - HOUR) });
    expect(await exportToLibrary(env.ctx, id)).toBe('exported');
    expect((await state(id)).jellyfin_item_id).toBeNull();
    foundItem = 'e'.repeat(32);
    await spaceTick(env.ctx);
    expect((await state(id)).jellyfin_item_id).toBe('e'.repeat(32));
  });

  it('export failure keeps the recording in the FriendFlix folder', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'library', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
    exportAnswer = { status: 409, json: { error: 'library_not_dedicated' } };
    const id = await row({ storage: 'library' });
    expect(await exportToLibrary(env.ctx, id)).toBe('failed');
    expect(await state(id)).toMatchObject({ state: 'done', library_path: null, bytes: '1000' });
    expect(calls.filter((c) => c.path.endsWith('/delete'))).toEqual([]);
    expect((await listEvents(env.ctx)).filter((e) => e.code === 'rec_export_failed').map((e) => [e.recordingId, e.reason])).toEqual([[id, 'library_not_dedicated']]);
    // still playable from the FriendFlix folder
    const p = await call(anna, 'POST', `/api/livetv/recordings/${id}/play`, {});
    expect(p.statusCode, p.body).toBe(200);
    expect((await resolveRecToken(env.ctx, p.json().token, '192.0.2.9')).status).toBe(200);
  });

  it('both: Behalten → in Bibliothek copies it, keeps the FriendFlix folder and protects it', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'both', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
    const id = await row({ delete_after: new Date(Date.now() + DAY) });
    const r = await call(anna, 'POST', `/api/livetv/recordings/${id}/library`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().recording).toMatchObject({ keep: true, deleteAfter: null });
    expect(await state(id)).toMatchObject({ keep: true, library_path: 'Sternstunde Physik/Sternstunde Physik – x.ts', bytes: '8000' });
    expect(calls.filter((c) => c.path === `/v1/recordings/${id}/delete`)).toEqual([]);
    // only in mode both
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'ff', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
    expect((await call(anna, 'POST', `/api/livetv/recordings/${await row({})}/library`)).json()).toEqual({ error: 'not_available' });
  });

  it('Plex: library mode not offered', async () => {
    withoutSeam();
    try {
      env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'library', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
      expect(effectiveStorage(env.ctx)).toBe('ff');
      const id = await insertScheduled(env.ctx, {
        profileId: annaId, userId: annaId, ruleId: null, channelId: nordlicht, channelName: 'Nordlicht TV', title: 'Sternstunde Physik',
        start: Date.now() + DAY, end: Date.now() + DAY + HOUR, padBeforeS: 0, padAfterS: 0, followEpg: false,
      });
      expect((await getRecording(env.ctx, id!))!.storage).toBe('ff');
      expect((await call(admin, 'GET', '/api/admin/livetv/recordings/libraries')).json()).toEqual({ supported: false, jfPath: '/media/Aufnahmen', selected: 'lib-aufnahmen', libraries: [] });
      expect((await call(admin, 'POST', '/api/admin/livetv/recordings/libraries', {})).json()).toEqual({ error: 'not_available' });
    } finally { withSeam(); }
  });

  it('the libraries with their folders, the one that fits, and *Bibliothek „Aufnahmen“ anlegen*', async () => {
    const l = await call(admin, 'GET', '/api/admin/livetv/recordings/libraries');
    expect(l.json()).toEqual({
      supported: true, jfPath: '/media/Aufnahmen', selected: null,
      libraries: [{ id: 'lib-aufnahmen', name: 'Aufnahmen', paths: ['/media/Aufnahmen/'], fits: true }, { id: 'lib-filme', name: 'Filme', paths: ['/media/Filme'], fits: false }],
    });
    const c = await call(admin, 'POST', '/api/admin/livetv/recordings/libraries', {});
    expect([c.statusCode, c.json()]).toEqual([201, { id: 'lib-neu' }]);
    expect(asked).toEqual(['create Aufnahmen /media/Aufnahmen homevideos']);
    expect((await env.pool.query("select action from audit_log where action like 'livetv.rec.%'")).rows).toEqual([{ action: 'livetv.rec.library_create' }]);
    expect((await call(anna, 'GET', '/api/admin/livetv/recordings/libraries')).statusCode).toBe(403);
    const st = (await call(admin, 'GET', '/api/admin/livetv/recordings/storage')).json();
    expect(st.library).toEqual({ mounted: true, writable: true, dedicated: true, freeBytes: 900 * GB });
  });
});

describe('the store job (fix round 1)', () => {
  it('A-I2: a finished recording does not run the space sweep inside the recording tick; the store job does', async () => {
    const due = await row({ delete_after: new Date(Date.now() - 1000) });
    const id = await row({ state: 'recording', bytes: 5000, start_at: new Date(Date.now() - 2 * HOUR), end_at: new Date(Date.now() - HOUR) });
    recorders.set(id, { id, channelId: nordlicht, dir: '0f000000-0000-4000-a000-0000000000d1', state: 'done', segments: 'ts', bytes: 6000, durationS: 3600, gaps: [], error: null, since: 1 });
    await livetvRecordTick(env.ctx);
    expect((await state(id)).state).toBe('done');
    expect(await state(due)).not.toBeNull();
    await livetvStoreTick(env.ctx);
    expect(await state(due)).toBeNull();
  });

  it('A-M7: two exports of one recording at once export once', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'both', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
    const id = await row({});
    const [a, b] = await Promise.all([exportToLibrary(env.ctx, id, { keep: true }), exportToLibrary(env.ctx, id, { keep: true })]);
    expect([a, b].sort()).toEqual(['busy', 'exported']);
    expect(calls.filter((c) => c.path.endsWith('/export'))).toHaveLength(1);
    expect((await state(id)).bytes).toBe('8000');
  });

  it('A-M1: past cancelled airings without pending files are pruned', async () => {
    const old = await row({ state: 'cancelled', bytes: 0, mode: null, start_at: new Date(Date.now() - 3 * DAY), end_at: new Date(Date.now() - 3 * DAY + HOUR) });
    const future = await row({ state: 'cancelled', bytes: 0, mode: null, start_at: new Date(Date.now() + DAY), end_at: new Date(Date.now() + DAY + HOUR) });
    await spaceTick(env.ctx);
    expect(await state(old)).toBeNull();
    expect(await state(future)).not.toBeNull();
  });
});

describe('deleting (fix round 1)', () => {
  it('A-I8: a failing revocation keeps the row deleting (tokens 410) until the job completes it', async () => {
    const { recHooks, deleteRecording } = await import('../src/livetv/recordings.js');
    const id = await row({ bytes: 4000 });
    const saved = recHooks.onRecordingDeleted;
    let fail = true;
    recHooks.onRecordingDeleted = async () => { if (fail) throw new Error('licence store down'); };
    try {
      expect(await deleteRecording(env.ctx, id, 'owner')).toBe('pending');
      expect((await state(id)).state).toBe('deleting');
      expect(calls.filter((c) => c.path.startsWith(`/v1/recordings/${id}`))).toEqual([]); // nothing removed before the revocation held
      fail = false;
      await spaceTick(env.ctx);
      expect(await state(id)).toBeNull();
      expect(calls.filter((c) => c.path === `/v1/recordings/${id}`).map((c) => c.method)).toEqual(['DELETE']); // the retry stops a recorder too (A-M5)
      expect(calls.filter((c) => c.path === `/v1/recordings/${id}/delete`)).toHaveLength(1);
    } finally { recHooks.onRecordingDeleted = saved; }
  });

  it('A-I9: deleting a library recording rescans its library', async () => {
    env.ctx.cfg = { ...cfg, LIVETV_RECORD_STORAGE: 'library', LIVETV_RECORD_LIBRARY_ID: 'lib-aufnahmen' };
    const { deleteRecording } = await import('../src/livetv/recordings.js');
    const id = await row({ storage: 'library', library_path: 'Sternstunde Physik/Sternstunde Physik – x.ts' });
    expect(await deleteRecording(env.ctx, id, 'owner')).toBe('deleted');
    expect(calls.filter((c) => c.path === `/v1/recordings/${id}/library-delete`)).toHaveLength(1);
    expect(asked).toEqual(['refresh lib-aufnahmen']);
  });

  it('A-I4: deleting a profile queues its recordings\' files; usage counts them until the job removed them', async () => {
    const kid = '0c000000-0000-4000-a000-0000000000a9';
    await env.pool.query(`insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, 'Zweit', $3, 'anna-zweit', $4)`,
      [kid, annaId, 'b'.repeat(32), encrypt(key, 'pw')]);
    const done = await row({ profile_id: kid, bytes: 3000 });
    const running = await row({ profile_id: kid, state: 'recording', bytes: 1000, start_at: new Date(Date.now() - HOUR), end_at: new Date(Date.now() + HOUR) });
    const plan = await row({ profile_id: kid, state: 'scheduled', bytes: 0, mode: null, start_at: new Date(Date.now() + DAY), end_at: new Date(Date.now() + DAY + HOUR) });
    await env.pool.query('delete from profiles where id = $1', [kid]);
    for (const x of [done, running, plan]) expect(await state(x)).toBeNull();
    expect((await env.pool.query('select recording_id from livetv_recording_purges order by bytes')).rows.map((r) => r.recording_id)).toEqual([running, done]);
    expect(await usage(env.ctx)).toBe(4000);
    await spaceTick(env.ctx);
    expect((await env.pool.query('select count(*)::int n from livetv_recording_purges')).rows[0].n).toBe(0);
    expect(await usage(env.ctx)).toBe(0);
    expect(calls.filter((c) => c.path === `/v1/recordings/${running}`).map((c) => c.method)).toEqual(['DELETE']);
    expect(calls.filter((c) => c.path.endsWith('/delete')).map((c) => c.path.split('/')[3]).sort()).toEqual([done, running].sort());
  });
});
