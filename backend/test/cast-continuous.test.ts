// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { airplayContinuousOn } from '../src/cast.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const MS = 'b'.repeat(32);
type Sess = { cookies: Record<string, string>; csrf: string };
let n = 0;

/** Each describe owns its env: makeEnv resets the shared database, so two live envs in one file would invalidate each other's sessions. */
function useEnv(server?: 'plex') {
  const h = {
    env: undefined as unknown as TestEnv,
    admin: undefined as unknown as Sess,
    call: (method: string, url: string, body?: unknown) =>
      h.env.app.inject({ method: method as 'GET', url, cookies: h.admin.cookies, headers: { 'x-csrf-token': h.admin.csrf, 'x-forwarded-for': `10.2.0.${++n % 250}` }, payload: body as object }),
    put: (values: Record<string, unknown>) => h.call('PUT', '/api/admin/settings', { values }),
  };
  beforeAll(async () => {
    h.env = await makeEnv({
      'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: {} } }),
      'POST /Items/[^/]+/PlaybackInfo': () => ({
        json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: MS, Container: 'mkv', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: 7200 * 10_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] },
      }),
    }, server ? { server } : {});
    h.admin = await h.env.login(ADMIN);
  });
  afterAll(() => h.env.close());
  return h;
}

describe('continuous AirPlay switch', () => {
  const h = useEnv();
  const session = (body: Record<string, unknown>) => h.call('POST', '/api/cast/session', { itemId: ID, ...body });

  it('config reports the switch', async () => {
    expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: true, airplayContinuous: false });
    const was = h.env.ctx.cfg;
    try {
      h.env.ctx.cfg = { ...was, CAST_AIRPLAY_CONTINUOUS: 'true' };
      expect((await h.call('GET', '/api/cast/config')).json().airplayContinuous).toBe(true);
      expect(airplayContinuousOn(h.env.ctx)).toBe(true);
      // casting off wins over the switch
      h.env.ctx.cfg = { ...was, CAST_AIRPLAY_CONTINUOUS: 'true', CAST_ENABLED: 'false' };
      expect(airplayContinuousOn(h.env.ctx)).toBe(false);
      expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: false, airplayContinuous: false });
    } finally { h.env.ctx.cfg = was; }
  });

  it('changed through the settings store without a restart', async () => {
    const r = await h.put({ CAST_AIRPLAY_CONTINUOUS: true });
    expect(r.statusCode, r.body).toBe(200);
    expect((await h.call('GET', '/api/cast/config')).json().airplayContinuous).toBe(true);
    expect((await h.put({ CAST_AIRPLAY_CONTINUOUS: false })).statusCode).toBe(200);
    expect((await h.call('GET', '/api/cast/config')).json().airplayContinuous).toBe(false);
  });

  it('continuous with the switch off is 400 continuous_off', async () => {
    const r = await session({ via: 'airplay', continuous: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'continuous_off' });
  });

  it('continuous for Chromecast is 400 bad_request', async () => {
    for (const via of [undefined, 'chromecast']) {
      const r = await session({ continuous: true, ...(via ? { via } : {}) });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('maxEpisodes without continuous AirPlay is 400 bad_request', async () => {
    for (const body of [{ maxEpisodes: 2 }, { via: 'chromecast', maxEpisodes: 2 }, { via: 'airplay', maxEpisodes: 2 }, { via: 'airplay', continuous: false, maxEpisodes: 2 }]) {
      const r = await session(body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('with the switch on a single token is still minted; maxEpisodes is 1 to 3', async () => {
    expect((await h.put({ CAST_AIRPLAY_CONTINUOUS: true })).statusCode).toBe(200);
    try {
      const r = await session({ via: 'airplay', continuous: true, maxEpisodes: 3 });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().contentUrl).toMatch(/\/media\/c\/[\w-]{43}\//);
      for (const maxEpisodes of [0, 4]) expect((await session({ via: 'airplay', continuous: true, maxEpisodes })).statusCode, String(maxEpisodes)).toBe(400);
    } finally { await h.put({ CAST_AIRPLAY_CONTINUOUS: false }); }
  });
});

describe('continuous AirPlay switch on Plex', () => {
  const h = useEnv('plex');

  it('is never offered, whatever the setting says', async () => {
    h.env.ctx.cfg = { ...h.env.ctx.cfg, CAST_AIRPLAY_CONTINUOUS: 'true' };
    expect(airplayContinuousOn(h.env.ctx)).toBe(false);
    expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: true, airplayContinuous: false });
  });
});

describe('after the Plex block', () => {
  const h = useEnv();

  it('a fresh Jellyfin env is unaffected by the Plex one (each describe owns its database state)', async () => {
    expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: true, airplayContinuous: false });
  });
});
