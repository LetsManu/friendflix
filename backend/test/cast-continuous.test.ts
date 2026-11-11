// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { airplayContinuousOn } from '../src/cast.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const MS = 'b'.repeat(32);
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let n = 0;
const call = (method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf, 'x-forwarded-for': `10.2.0.${++n % 250}` }, payload: body as object });
const put = (values: Record<string, unknown>) => call('PUT', '/api/admin/settings', { values });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: {} } }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({
      json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: MS, Container: 'mkv', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: 7200 * 10_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] },
    }),
  });
  admin = await env.login(ADMIN);
});
afterAll(() => env.close());

describe('continuous AirPlay switch', () => {
  it('config reports the switch', async () => {
    expect((await call('GET', '/api/cast/config')).json()).toEqual({ enabled: true, airplayContinuous: false });
    const was = env.ctx.cfg;
    try {
      env.ctx.cfg = { ...was, CAST_AIRPLAY_CONTINUOUS: 'true' };
      expect((await call('GET', '/api/cast/config')).json().airplayContinuous).toBe(true);
      expect(airplayContinuousOn(env.ctx)).toBe(true);
    } finally { env.ctx.cfg = was; }
  });

  it('changed through the settings store without a restart', async () => {
    const r = await put({ CAST_AIRPLAY_CONTINUOUS: true });
    expect(r.statusCode, r.body).toBe(200);
    expect((await call('GET', '/api/cast/config')).json().airplayContinuous).toBe(true);
    expect((await put({ CAST_AIRPLAY_CONTINUOUS: false })).statusCode).toBe(200);
    expect((await call('GET', '/api/cast/config')).json().airplayContinuous).toBe(false);
  });

  it('continuous with the switch off is 400 continuous_off', async () => {
    const r = await call('POST', '/api/cast/session', { itemId: ID, via: 'airplay', continuous: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'continuous_off' });
  });

  it('continuous for Chromecast is 400 bad_request', async () => {
    for (const via of [undefined, 'chromecast']) {
      const r = await call('POST', '/api/cast/session', { itemId: ID, continuous: true, ...(via ? { via } : {}) });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('with the switch on a single token is still minted', async () => {
    expect((await put({ CAST_AIRPLAY_CONTINUOUS: true })).statusCode).toBe(200);
    const r = await call('POST', '/api/cast/session', { itemId: ID, via: 'airplay', continuous: true, maxEpisodes: 3 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().contentUrl).toMatch(/\/media\/c\/[\w-]{43}\//);
  });

  it('config reports the switch off on Plex, whatever the setting says', async () => {
    const px = await makeEnv({}, { server: 'plex' });
    try {
      const sess = await px.login(ADMIN);
      px.ctx.cfg = { ...px.ctx.cfg, CAST_AIRPLAY_CONTINUOUS: 'true' };
      expect(airplayContinuousOn(px.ctx)).toBe(false);
      const r = await px.app.inject({ method: 'GET', url: '/api/cast/config', cookies: sess.cookies });
      expect(r.json()).toEqual({ enabled: true, airplayContinuous: false });
    } finally { await px.close(); }
  });
});
