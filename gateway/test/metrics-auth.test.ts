// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Security audit G5: the gateway compares METRICS_TOKEN in constant time and rate limits /metrics per client.
const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>();
  return { ...real, timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { spy.calls++; return real.timingSafeEqual(a, b); } };
});

import { createGateway, METRICS_PER_MINUTE } from '../src/gateway.js';

const TOKEN = 'metrics-token-0123456789abcdef';
let server: Server;
let base = '';
beforeAll(async () => {
  const g = createGateway({ upstreamUrl: 'http://jf.invalid:8096', backendUrl: 'http://be.invalid:3000', internalSecret: 's3cret-s3cret-s3cret', metricsToken: TOKEN, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch });
  server = g.server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { spy.calls = 0; });

// the test peer is loopback, so X-Forwarded-For names the client (as behind the reverse proxy)
const get = (auth: string | undefined, ip: string) => fetch(`${base}/metrics`, { headers: { 'x-forwarded-for': ip, ...(auth === undefined ? {} : { authorization: auth }) } });

describe('gateway /metrics', () => {
  it('answers only the right token, compared in constant time', async () => {
    expect((await get(`Bearer ${TOKEN}`, '192.0.2.10')).status).toBe(200);
    expect(spy.calls).toBeGreaterThan(0);
    for (const bad of [undefined, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `bearer ${TOKEN}`, TOKEN, 'Bearer ']) {
      expect((await get(bad, '192.0.2.11')).status).toBe(401);
    }
  });
  it('is rate limited per client', async () => {
    expect(METRICS_PER_MINUTE).toBe(60);
    const codes: number[] = [];
    for (let i = 0; i <= METRICS_PER_MINUTE; i++) codes.push((await get(`Bearer ${TOKEN}`, '192.0.2.20')).status);
    expect(codes.slice(0, METRICS_PER_MINUTE).every((c) => c === 200)).toBe(true);
    const last = await get(`Bearer ${TOKEN}`, '192.0.2.20');
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
    expect((await get(`Bearer ${TOKEN}`, '192.0.2.21')).status).toBe(200);
  });
});
