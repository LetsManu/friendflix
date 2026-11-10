// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setLive } from '../src/live.js';
import { makeEnv, type TestEnv } from './helpers.js';

// The next-episode warm-up (web/src/lib/player/prefetch.ts): an unused warmed transcode is stopped through this route.
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
let userId = '';

beforeAll(async () => {
  env = await makeEnv({ 'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }) });
  s = await env.login();
  userId = (await env.app.inject({ url: '/api/me', cookies: s.cookies })).json().id;
});
afterAll(() => env.close());
beforeEach(() => { env.jfCalls.length = 0; });

const stop = (payload: unknown, csrf = true) => env.app.inject({ method: 'POST', url: '/api/playback/warm/stop', cookies: s.cookies, headers: csrf ? { 'x-csrf-token': s.csrf } : {}, payload: payload as object });
const deletes = () => env.jfCalls.filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings');

describe('POST /api/playback/warm/stop', () => {
  it('stops the warmed transcode of the caller\'s own device and play session', async () => {
    const r = await stop({ playSessionId: 'ps-warm-0001' });
    expect(r.json()).toEqual({ ok: true, stopped: true });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]!.search).toContain('playSessionId=ps-warm-0001');
    expect(deletes()[0]!.search).toContain('deviceId=');
  });
  it('never stops a session that started playing (the player took the warm-up)', async () => {
    await setLive(env.ctx, { userId, userName: 'A', itemId: 'a'.repeat(32), title: 'x', positionTicks: 0, isPaused: false, playSessionId: 'ps-warm-live', updatedAt: Date.now(), source: 'portal' });
    expect((await stop({ playSessionId: 'ps-warm-live' })).json()).toEqual({ ok: true, stopped: false });
    expect(deletes()).toHaveLength(0);
  });
  it('needs a session, the csrf header and a valid id', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/playback/warm/stop', payload: { playSessionId: 'ps-warm-0001' } })).statusCode).toBe(401);
    expect((await stop({ playSessionId: 'ps-warm-0001' }, false)).statusCode).toBe(403);
    expect((await stop({ playSessionId: '../x' })).statusCode).toBe(400);
    expect(deletes()).toHaveLength(0);
  });
});
