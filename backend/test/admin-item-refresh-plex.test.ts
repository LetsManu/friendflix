// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * *Neu einlesen* on Plex: Plex has no per-item equivalent of "scan for new and changed files" (its scans run per library section and
 * folder), so the capability stays off: the route answers 501 and /api/me tells the web to hide the entry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';
import { PlexFake } from './plexfake.js';

let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
beforeAll(async () => {
  env = await makeEnv({}, { server: 'plex', plexFake: new PlexFake() });
  admin = await env.login();
});
afterAll(() => env.close());

describe('item rescan on Plex', () => {
  it('501 unsupported, and the capability is off in /api/me', async () => {
    const r = await env.app.inject({ method: 'POST', url: `/api/admin/items/${'1'.repeat(32)}/refresh`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { mode: 'scan' } });
    expect(r.statusCode).toBe(501);
    expect(r.json()).toEqual({ error: 'unsupported' });
    const me = await env.app.inject({ method: 'GET', url: '/api/me', cookies: admin.cookies });
    expect(me.json().server.capabilities.itemRefresh).toBe(false);
  });
});
