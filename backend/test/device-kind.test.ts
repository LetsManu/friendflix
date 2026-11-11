// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { clientKind } from '../src/deviceKind.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

const LG = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0 Safari/537.36 WebAppManager';
const TIZEN = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 FriendFlixDesktop/1.2.0';

describe('clientKind', () => {
  it('maps every shell', () => {
    const rows: [string, string][] = [
      ['Mozilla/5.0 (Linux; Android 9; AFTMM) AppleWebKit/537.36 Chrome/110.0 Safari/537.36 FriendFlixAndroid/2.0.0 FriendFlixFireTV/1.4.0', 'firetv'],
      [TIZEN, 'tizen'],
      ['Mozilla/5.0 (Linux; Tizen 7.0) AppleWebKit/537.36 FriendFlixTizen/2.0', 'tizen'],
      [LG, 'webos'],
      [DESKTOP, 'desktop'],
      ['Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 FriendFlixAndroid/2.0.0', 'android'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'web'],
      ['', 'web'],
    ];
    for (const [ua, kind] of rows) expect(clientKind(ua), ua).toBe(kind);
  });
});

describe('device client kind in the database', () => {
  // log in through the callback only (no /api/me), with the given user agent and device cookie
  const callbackLogin = async (ua: string, dev?: string) => {
    const l = await env.app.inject('/auth/login?classic=1');
    const state = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${state}&code=c`, headers: { 'user-agent': ua }, cookies: { ...(dev ? { ff_dev: dev } : {}), ff_oidc: state } });
    expect(cb.statusCode).toBe(302);
    return cb.cookies.find((x) => x.name === 'ff_dev')!.value;
  };

  it('registration stores the kind (new device and existing device)', async () => {
    env = await makeEnv();
    const dev = await callbackLogin(LG); // new device branch, nothing else touched the row yet
    expect((await env.pool.query('select client from devices')).rows).toEqual([{ client: 'webos' }]);
    await callbackLogin(DESKTOP, dev); // the same device registers again (existing branch)
    expect((await env.pool.query('select client from devices')).rows).toEqual([{ client: 'desktop' }]);
  });

  it('/api/me never downgrades a stored kind to web, but fills an empty one', async () => {
    env = await makeEnv();
    const s = await env.login();
    const me = (ua?: string) => env.app.inject({ url: '/api/me', cookies: s.cookies, ...(ua === undefined ? {} : { headers: { 'user-agent': ua } }) });
    const stored = async () => (await env.pool.query('select client from devices')).rows[0].client;
    await env.pool.query("update devices set client = 'firetv'");
    for (const ua of ['okhttp/4.12.0', '']) {
      expect((await me(ua)).statusCode).toBe(200);
      expect(await stored()).toBe('firetv');
    }
    await me(DESKTOP); // a specific kind may still correct a specific kind
    expect(await stored()).toBe('desktop');
    await env.pool.query('update devices set client = null');
    await me('okhttp/4.12.0'); // nothing stored yet: set, even to web
    expect(await stored()).toBe('web');
  });

  it('TV claim stores the kind', async () => {
    env = await makeEnv();
    const s = await env.login();
    const c = (await env.app.inject({ method: 'POST', url: '/api/tv/code' })).json();
    const pair = await env.app.inject({ method: 'POST', url: '/api/tv/pair', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { code: c.code } });
    expect(pair.statusCode).toBe(200);
    const claim = await env.app.inject({ method: 'POST', url: '/api/tv/claim', headers: { 'user-agent': TIZEN }, payload: { code: c.code, pollToken: c.pollToken } });
    expect(claim.statusCode).toBe(200);
    expect((await env.pool.query("select client from devices where device_id like 'tv-%'")).rows).toEqual([{ client: 'tizen' }]);
  });

  it('/api/me corrects a stored kind', async () => {
    env = await makeEnv();
    const s = await env.login();
    await env.pool.query("update devices set client = 'web'");
    const me = await env.app.inject({ url: '/api/me', cookies: s.cookies, headers: { 'user-agent': DESKTOP } });
    expect(me.statusCode).toBe(200);
    expect((await env.pool.query('select client from devices')).rows).toEqual([{ client: 'desktop' }]);
  });

  it('migration 46 is rerunnable', async () => {
    env = await makeEnv();
    await env.pool.query('delete from schema_migrations where version >= 46');
    await migrate(env.pool);
    const cols = await env.pool.query("select column_name from information_schema.columns where table_name='devices' and column_name in ('client','name')");
    expect(cols.rowCount).toBe(2);
    expect((await env.pool.query("select to_regclass('handoff_recent') r")).rows[0].r).not.toBeNull();
  });
});
