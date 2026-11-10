// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearLive, getLive, listLive, setLive, type Live } from '../src/live.js';
import { UPLOAD_FLOOR, uploadCap } from '../src/uploadcap.js';
import { makeEnv, type TestEnv } from './helpers.js';

const M = 1_000_000;
const base = { uploadMbps: 30, remote: true, ceiling: 8 * M, others: [] as Array<{ bitrate?: number; remote?: boolean; deviceId?: string }> };
const remote = (mbps: number, deviceId = 'd') => ({ bitrate: mbps * M, remote: true, deviceId });

describe('uploadCap (the rule)', () => {
  it('off without an upload figure, never for home viewers', () => {
    expect(uploadCap({ ...base, uploadMbps: undefined, others: [remote(30)] })).toEqual({ cap: 8 * M, limited: false });
    expect(uploadCap({ ...base, uploadMbps: 0, others: [remote(30)] })).toEqual({ cap: 8 * M, limited: false });
    expect(uploadCap({ ...base, remote: false, others: [remote(30)] })).toEqual({ cap: 8 * M, limited: false });
  });
  it('a free link keeps the normal ceiling (0.85 × 30 = 25.5 Mbit/s budget)', () => {
    expect(uploadCap({ ...base, others: [remote(8), remote(8)] })).toEqual({ cap: 8 * M, limited: false }); // 9.5 free
  });
  it('a busy link snaps to the highest rung that fits: 8, 4, 1.5 Mbit/s, never below 1.5', () => {
    expect(uploadCap({ ...base, others: [remote(8), remote(8), remote(4)] })).toEqual({ cap: 4 * M, limited: true }); // 5.5 free
    expect(uploadCap({ ...base, others: [remote(8), remote(8), remote(8)] })).toEqual({ cap: 1.5 * M, limited: true }); // 1.5 free
    expect(uploadCap({ ...base, others: [remote(12), remote(12), remote(8)] })).toEqual({ cap: UPLOAD_FLOOR, limited: true }); // over budget
    expect(uploadCap({ ...base, ceiling: 12 * M, others: [remote(8), remote(8)] })).toEqual({ cap: 8 * M, limited: true }); // 9.5 free < 12
  });
  it('home streams, streams without a known bitrate and the requesting device itself are not counted; paused ones are', () => {
    const others = [{ bitrate: 20 * M, remote: false }, { remote: true }, remote(20, 'me'), { ...remote(20), isPaused: true }];
    expect(uploadCap({ ...base, deviceId: 'me', others })).toEqual({ cap: 4 * M, limited: true }); // 25.5 - 20 = 5.5
  });
  it('a ceiling below the floor stays as it is', () => {
    expect(uploadCap({ ...base, ceiling: M, others: [remote(30)] })).toEqual({ cap: M, limited: false });
  });
});

const ID = 'a'.repeat(32);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: { PlaybackPositionTicks: 0 } } }),
    'GET /Items': () => ({ json: { Items: [{ Id: ID, Name: 'Film', Type: 'Movie' }], TotalRecordCount: 1 } }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: 'ps-upload01', MediaSources: [{ Id: 'ms1', Container: 'mp4', SupportsDirectPlay: true, Bitrate: 15_000_000, RunTimeTicks: 1e9, MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] } }),
    'POST /Sessions/Playing': () => ({ status: 204 }),
  });
  s = await env.login();
});
afterAll(() => env.close());
afterEach(async () => {
  await env.ctx.settings.save({ UPLOAD_MBPS: null }, null);
  for (const l of await listLive(env.ctx)) await clearLive(env.ctx, l.userId, l.playSessionId);
});

const info = (ip: string) => env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-real-ip': ip }, payload: { itemId: ID } });
const other = (ps: string, mbps: number, isRemote = true): Live => ({
  userId: '00000000-0000-4000-8000-000000000001', userName: 'Other', itemId: ID, title: 'Film', positionTicks: 0, isPaused: false, playSessionId: ps,
  updatedAt: Date.now(), source: 'portal', deviceId: `dev-${ps}`, bitrate: mbps * M, remote: isRemote,
});

describe('POST /api/playback/info with UPLOAD_MBPS', () => {
  it('unset: the remote cap as before (admin: 12 Mbit/s)', async () => {
    await setLive(env.ctx, other('ps-a', 12)); await setLive(env.ctx, other('ps-b', 12));
    expect((await info('203.0.113.9')).json().maxBitrate).toBe(12 * M);
  });
  it('a busy upload lowers a new remote stream and names the reason; a home viewer is not touched', async () => {
    await env.ctx.settings.save({ UPLOAD_MBPS: 30 }, null);
    await setLive(env.ctx, other('ps-a', 8)); await setLive(env.ctx, other('ps-b', 8)); await setLive(env.ctx, other('ps-c', 4)); await setLive(env.ctx, other('ps-h', 40, false));
    const away = (await info('203.0.113.9')).json();
    expect(away.maxBitrate).toBe(4 * M);
    expect(away.transcodeReason).toBe('uploadCap');
    expect(away.roleMaxBitrate).toBe(12 * M); // the quality menu keeps the normal ceiling; the server caps each new start
    expect((await info('192.168.1.10')).json().maxBitrate).toBe(60 * M);
  });
  it('the start report keeps the granted cap and the remote flag on the live record (the next request counts it)', async () => {
    await env.ctx.settings.save({ UPLOAD_MBPS: 30 }, null);
    const r = (await info('203.0.113.9')).json();
    const st = await env.app.inject({ method: 'POST', url: '/api/playback/start', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf },
      payload: { itemId: ID, playSessionId: r.playSessionId, mediaSourceId: 'ms1', positionTicks: 0, playMethod: 'DirectStream' } });
    expect(st.statusCode).toBe(200);
    const me = (await listLive(env.ctx)).find((l) => l.playSessionId === r.playSessionId)!;
    expect(await getLive(env.ctx, me.userId, r.playSessionId)).toMatchObject({ bitrate: 12 * M, remote: true });
  });
});
