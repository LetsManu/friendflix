// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * POST /api/admin/items/:id/refresh (*Neu einlesen* on the detail page): admin on the owner profile + CSRF, a strict body, only films,
 * series and seasons (looked up with the admin key), the Jellyfin query of each mode through the real service over the fake server,
 * the audit row, 501 without the capability, the rate limit. Ids are fictional.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const MOVIE = '1'.repeat(32), SERIES = '2'.repeat(32), SEASON = '3'.repeat(32), EPISODE = '4'.repeat(32), GONE = '9'.repeat(32), BROKEN = 'b'.repeat(32);
const TYPES: Record<string, string> = { [MOVIE]: 'Movie', [SERIES]: 'Series', [SEASON]: 'Season', [EPISODE]: 'Episode', [BROKEN]: 'Series' };

let env: TestEnv;
let admin: Sess, friend: Sess;
let adminId = '';
const as = (s: Sess, url: string, payload?: unknown, headers: Record<string, string> = { 'x-csrf-token': s.csrf }) =>
  env.app.inject({ method: 'POST', url, cookies: s.cookies, headers, payload: payload as object });
const refreshCalls = () => env.jfCalls.filter((c) => c.method === 'POST' && /^\/Items\/[0-9a-f]+\/Refresh$/.test(c.path));
const resetLimit = async () => { for (const k of await env.kv.keys('rl:item-refresh:')) await env.kv.del(k); };

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const id = u.searchParams.get('ids');
      const type = id ? TYPES[id] : undefined;
      return { json: { Items: type ? [{ Id: id, Name: `Titel ${type}`, Type: type, Path: '/mnt/media/secret' }] : [], TotalRecordCount: type ? 1 : 0 } };
    },
    'POST /Items/[0-9a-f]+/Refresh': (u) => ({ status: u.pathname.includes(BROKEN) ? 500 : 204 }),
  });
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend','jffritz','Fritz',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  friend = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
});
afterAll(() => env.close());
beforeEach(async () => {
  env.jfCalls.length = 0;
  await env.pool.query('delete from audit_log');
  await resetLimit();
});

describe('POST /api/admin/items/:id/refresh', () => {
  it('only an admin: a friend gets 403 and nothing reaches the server', async () => {
    const r = await as(friend, `/api/admin/items/${SERIES}/refresh`, { mode: 'scan' });
    expect(r.statusCode).toBe(403);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('without the CSRF header: 403, nothing reaches the server', async () => {
    const r = await as(admin, `/api/admin/items/${SERIES}/refresh`, { mode: 'scan' }, {});
    expect(r.statusCode).toBe(403);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('the body is strict: a missing, unknown or extra field is 400 bad_request', async () => {
    for (const body of [undefined, {}, { mode: 'full' }, { mode: 'SCAN' }, { mode: 'scan', recursive: false }, { mode: 1 }]) {
      const r = await as(admin, `/api/admin/items/${SERIES}/refresh`, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error).toBe('bad_request');
    }
    expect(refreshCalls()).toHaveLength(0);
  });

  it('the id is checked like other item routes: no item id is 400; a dashed UUID is normalised', async () => {
    expect((await as(admin, '/api/admin/items/not-an-id/refresh', { mode: 'scan' })).statusCode).toBe(400);
    const dashed = `${'1'.repeat(8)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(12)}`;
    expect((await as(admin, `/api/admin/items/${dashed}/refresh`, { mode: 'scan' })).json()).toEqual({ ok: true });
    expect(refreshCalls().map((c) => c.path)).toEqual([`/Items/${MOVIE}/Refresh`]);
  });

  it('films, series and seasons are read in again with the query of their mode', async () => {
    const want = {
      scan: { metadataRefreshMode: 'Default', imageRefreshMode: 'Default', replaceAllMetadata: 'false', replaceAllImages: 'false' },
      missing: { metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'false', replaceAllImages: 'false' },
      replace: { metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'true', replaceAllImages: 'true' },
    } as const;
    const cases = [[MOVIE, 'missing'], [SERIES, 'scan'], [SEASON, 'replace']] as const;
    for (const [id, mode] of cases) {
      env.jfCalls.length = 0;
      const r = await as(admin, `/api/admin/items/${id}/refresh`, { mode });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ ok: true });
      const calls = refreshCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe(`/Items/${id}/Refresh`);
      expect(Object.fromEntries(new URLSearchParams(calls[0]!.search))).toEqual({ recursive: 'true', ...want[mode] });
      expect(calls[0]!.auth).toContain('Token="adminkey"');
    }
  });

  it('an episode (or any other kind) is 400 unsupported_type; nothing is refreshed', async () => {
    const r = await as(admin, `/api/admin/items/${EPISODE}/refresh`, { mode: 'scan' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'unsupported_type' });
    expect(refreshCalls()).toHaveLength(0);
  });

  it('an id the server does not know is 404 not_found', async () => {
    const r = await as(admin, `/api/admin/items/${GONE}/refresh`, { mode: 'scan' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
    expect(refreshCalls()).toHaveLength(0);
  });

  it('a failing server is 502 refresh_failed without its message; no audit row', async () => {
    const r = await as(admin, `/api/admin/items/${BROKEN}/refresh`, { mode: 'scan' });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'refresh_failed' });
    expect((await env.pool.query("select count(*)::int n from audit_log where action = 'media.item_refresh'")).rows[0].n).toBe(0);
  });

  it('writes the audit row media.item_refresh with mode and type, never the title or a path', async () => {
    await as(admin, `/api/admin/items/${SEASON}/refresh`, { mode: 'missing' });
    const rows = (await env.pool.query("select actor, action, target, meta from audit_log where action = 'media.item_refresh'")).rows;
    expect(rows).toEqual([{ actor: adminId, action: 'media.item_refresh', target: SEASON, meta: { mode: 'missing', type: 'Season' } }]);
    expect(JSON.stringify(rows)).not.toMatch(/Titel|mnt/);
  });

  it('a server without the capability: 501 unsupported (also before any lookup), and /api/me says so', async () => {
    const jf = env.ctx.jf as { refreshItem?: unknown };
    const fn = jf.refreshItem;
    jf.refreshItem = undefined;
    try {
      const r = await as(admin, `/api/admin/items/${SERIES}/refresh`, { mode: 'scan' });
      expect(r.statusCode).toBe(501);
      expect(r.json()).toEqual({ error: 'unsupported' });
      expect(env.jfCalls.filter((c) => c.path === '/Items')).toHaveLength(0);
    } finally {
      jf.refreshItem = fn;
    }
    const me = await env.app.inject({ method: 'GET', url: '/api/me', cookies: admin.cookies });
    expect(me.json().server.capabilities.itemRefresh).toBe(true);
  });

  it('rate limit: 10 per minute and admin', async () => {
    for (let i = 0; i < 10; i++) expect((await as(admin, `/api/admin/items/${MOVIE}/refresh`, { mode: 'scan' })).statusCode).toBe(200);
    expect((await as(admin, `/api/admin/items/${MOVIE}/refresh`, { mode: 'scan' })).statusCode).toBe(429);
    expect(refreshCalls()).toHaveLength(10);
  });
});
