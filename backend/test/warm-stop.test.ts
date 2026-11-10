// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setLive } from '../src/live.js';
import { makeEnv, type TestEnv } from './helpers.js';

// The next-episode warm-up (web/src/lib/player/prefetch.ts): an unused warmed transcode is stopped through this route.
type Sess = { cookies: Record<string, string>; csrf: string };
const ID = 'a'.repeat(32);
let env: TestEnv;
let a: Sess, b: Sess;
let aId = '';
let psSeq = 0;

beforeAll(async () => {
  env = await makeEnv({
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
    'GET /Items': () => ({ json: { Items: [{ Id: ID, Name: 'Film', Type: 'Movie' }], TotalRecordCount: 1 } }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: `ps-warm-${String(++psSeq).padStart(4, '0')}`, MediaSources: [{ Id: 'ms1', Container: 'mkv', SupportsDirectPlay: false, Bitrate: 6_000_000, RunTimeTicks: 1e9, MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Height: 1080 }] }] } }),
  });
  a = await env.login();
  b = await env.login({ sub: 'sub-other', email: 'o@example.com', name: 'Other', groups: ['friendflix-admins'] });
  aId = (await env.app.inject({ url: '/api/me', cookies: a.cookies })).json().id;
});
afterAll(() => env.close());
beforeEach(() => { env.jfCalls.length = 0; });

const as = (s: Sess, payload: unknown, csrf = true) => env.app.inject({ method: 'POST', url: '/api/playback/warm/stop', cookies: s.cookies, headers: csrf ? { 'x-csrf-token': s.csrf } : {}, payload: payload as object });
/** a play session of `s` the way the warm-up gets one: /api/playback/info (it writes the caller's pbinfo record) */
const session = async (s: Sess) => (await env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { itemId: ID } })).json().playSessionId as string;
const deletes = () => env.jfCalls.filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings');

describe('POST /api/playback/warm/stop', () => {
  it("stops the warmed transcode of the caller's own play session", async () => {
    const ps = await session(a);
    expect((await as(a, { playSessionId: ps })).json()).toEqual({ ok: true, stopped: true });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]!.search).toContain(`playSessionId=${ps}`);
    expect(deletes()[0]!.search).toContain('deviceId=');
  });
  it("another user cannot stop it (Jellyfin would kill by the play session id alone); an unknown id stops nothing", async () => {
    const ps = await session(a);
    expect((await as(b, { playSessionId: ps })).json()).toEqual({ ok: true, stopped: false });
    expect((await as(a, { playSessionId: 'ps-never-issued' })).json()).toEqual({ ok: true, stopped: false });
    expect(deletes()).toHaveLength(0);
  });
  it('never stops a session that started playing (the player took the warm-up)', async () => {
    const ps = await session(a);
    await setLive(env.ctx, { userId: aId, userName: 'A', itemId: ID, title: 'x', positionTicks: 0, isPaused: false, playSessionId: ps, updatedAt: Date.now(), source: 'portal' });
    expect((await as(a, { playSessionId: ps })).json()).toEqual({ ok: true, stopped: false });
    expect(deletes()).toHaveLength(0);
  });
  it('needs a session, the csrf header and a valid id', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/playback/warm/stop', payload: { playSessionId: 'ps-warm-0001' } })).statusCode).toBe(401);
    expect((await as(a, { playSessionId: 'ps-warm-0001' }, false)).statusCode).toBe(403);
    expect((await as(a, { playSessionId: '../x' })).statusCode).toBe(400);
    expect(deletes()).toHaveLength(0);
  });
});
