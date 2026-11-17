// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Security audit G5: METRICS_TOKEN is compared in constant time and /metrics is rate limited per client.
const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>();
  return { ...real, timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { spy.calls++; return real.timingSafeEqual(a, b); } };
});

import { makeEnv, type TestEnv } from './helpers.js';

const TOKEN = 'metrics-token-0123456789abcdef';
let env: TestEnv;
beforeAll(async () => { env = await makeEnv({}, { settingsEnv: { METRICS_TOKEN: TOKEN } }); });
afterAll(async () => { await env.close(); });
beforeEach(() => { spy.calls = 0; });

const get = (auth?: string, ip = '192.0.2.10') => env.app.inject({ url: '/metrics', remoteAddress: ip, headers: auth === undefined ? {} : { authorization: auth } });

describe('/metrics bearer token', () => {
  it('answers only the right token, compared in constant time', async () => {
    expect((await get(`Bearer ${TOKEN}`)).statusCode).toBe(200);
    expect(spy.calls).toBeGreaterThan(0);
    for (const bad of [undefined, '', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `bearer ${TOKEN}`, TOKEN, 'Bearer ']) {
      expect((await get(bad, '192.0.2.11')).statusCode).toBe(401);
    }
  });
  it('is rate limited per client (60 a minute)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await get(`Bearer ${TOKEN}`, '192.0.2.20')).statusCode);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes[60]).toBe(429);
    // another client keeps its own budget
    expect((await get(`Bearer ${TOKEN}`, '192.0.2.21')).statusCode).toBe(200);
  });
});
