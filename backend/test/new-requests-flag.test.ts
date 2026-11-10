// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

/**
 * "Neu & demnächst": the page shows "Demnächst" and the inline request feature only while a request service is set up. The client learns
 * it from GET /api/me -> features.requests, which is derived from the live settings on every call (no rebuild, no restart).
 */
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };

beforeAll(async () => {
  env = await makeEnv();
  s = await env.login();
});
afterAll(() => env.close());

const me = () => env.app.inject({ url: '/api/me', cookies: s.cookies });
const restore = () => env.ctx.settings.save({ REQUESTS_URL: cfg.REQUESTS_URL, REQUESTS_API_KEY: cfg.REQUESTS_API_KEY }, null);

describe('features.requests in /api/me', () => {
  it('is true while URL and key are stored, and carries neither of them', async () => {
    const r = await me();
    expect(r.json().features.requests).toBe(true);
    expect(r.body).not.toContain(cfg.REQUESTS_API_KEY);
    expect(r.body).not.toContain('requests:5055');
  });

  it('turns false when the admin removes the service and true again when it is connected, without a restart', async () => {
    try {
      await env.ctx.settings.save({ REQUESTS_URL: null }, null);
      expect((await me()).json().features.requests).toBe(false);
      await restore();
      expect((await me()).json().features.requests).toBe(true);
      await env.ctx.settings.save({ REQUESTS_API_KEY: null }, null);
      expect((await me()).json().features.requests).toBe(false); // a URL without a key is no service either
    } finally {
      await restore();
    }
  });

  it('a kids profile sees the same flag (the page decides with it, whoever looks)', async () => {
    const k = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { name: 'Mia', kids: true, maxRating: 6 } });
    expect(k.statusCode).toBe(201);
    const sw = await env.app.inject({ method: 'POST', url: `/api/profiles/${k.json().profile.id}/select`, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: {} });
    expect(sw.statusCode).toBe(200);
    const cookies = { ff_sid: sw.cookies.find((c) => c.name === 'ff_sid')?.value ?? s.cookies.ff_sid! };
    try {
      const on = (await env.app.inject({ url: '/api/me', cookies })).json();
      expect([on.kids, on.features.requests]).toEqual([true, true]);
      await env.ctx.settings.save({ REQUESTS_URL: null }, null);
      expect((await env.app.inject({ url: '/api/me', cookies })).json().features.requests).toBe(false);
    } finally {
      await restore();
    }
  });
});
