// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.js';

/** The Samsung TV app's local setup page (another origin) reads GET /api/version cross-origin: public data, no credentials. */
describe('/api/version CORS', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeEnv(); });
  afterAll(() => env.close());

  it('GET answers with Access-Control-Allow-Origin: * and no credentials header', async () => {
    const r = await env.app.inject('/api/version');
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('other /api routes carry no CORS header', async () => {
    for (const url of ['/api/admin/update', '/api/me', '/health']) {
      const r = await env.app.inject(url);
      expect(r.headers['access-control-allow-origin'], url).toBeUndefined();
    }
  });
});
