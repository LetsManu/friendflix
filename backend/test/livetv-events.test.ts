// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 16 (pre-flight F20): the event ring `ltv:events` (newest 200, 7 days, codes only) and its first emitter, the
 * failing source refresh.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { LIVE_EVENT_CODES, listEvents, pushEvent } from '../src/livetv/events.js';
import { refreshSource } from '../src/livetv/refresh.js';
import { ENC_KEY, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
const WEEK_S = 7 * 24 * 3600;

beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from livetv_sources');
  for (const k of await env.kv.keys('ltv:')) await env.kv.del(k);
  vi.restoreAllMocks();
});

describe('event ring', () => {
  it('events keep the newest 200 for 7 days', async () => {
    const set = vi.spyOn(env.kv, 'set');
    for (let n = 1; n <= 201; n++) await pushEvent(env.ctx, { level: 'info', code: 'input_back', n });
    const list = await listEvents(env.ctx);
    expect(list).toHaveLength(200);
    expect(list[0]!.n).toBe(201);
    expect(list[199]!.n).toBe(2);
    expect(set.mock.calls.filter((c) => c[0] === 'ltv:events').every((c) => c[2] === WEEK_S)).toBe(true);
    // an event older than 7 days is not listed (and dropped by the next push)
    const old = { at: Date.now() - (WEEK_S + 60) * 1000, level: 'warn', code: 'input_lost' };
    await env.kv.set('ltv:events', JSON.stringify([...list.slice(0, 199), old]), WEEK_S);
    expect((await listEvents(env.ctx)).some((e) => e.code === 'input_lost')).toBe(false);
    await pushEvent(env.ctx, { level: 'info', code: 'input_back', n: 202 });
    expect(await env.kv.get('ltv:events')).not.toContain('input_lost');
  });

  it('listEvents honours the limit', async () => {
    for (let n = 1; n <= 5; n++) await pushEvent(env.ctx, { level: 'warn', code: 'start_failed', n });
    expect((await listEvents(env.ctx, 2)).map((e) => e.n)).toEqual([5, 4]);
    expect(await listEvents(env.ctx, 0)).toEqual([]);
    expect(await listEvents(env.ctx, 1000)).toHaveLength(5);
  });

  it('an event never stores text: a reason that is not a code is left out', async () => {
    await pushEvent(env.ctx, { level: 'warn', code: 'start_failed', reason: 'http://iptv.example.com/x' });
    expect(await listEvents(env.ctx)).toEqual([{ at: expect.any(Number), level: 'warn', code: 'start_failed' }]);
  });

  it('a failing refresh pushes source_refresh_failed', async () => {
    const id = randomUUID();
    await env.pool.query("insert into livetv_sources(id, kind, name, url_enc, url_hint) values ($1, 'm3u', 'Anbieter', $2, 'https://iptv.example.com/…')",
      [id, encrypt(keyFromBase64(ENC_KEY), 'https://anna:geheim@iptv.example.com/get.php?password=geheim')]);
    env.ctx.fetchImpl = fakeHttp({ 'POST /v1/fetch/m3u': () => ({ status: 422, json: { error: 'unreachable' } }) });
    await refreshSource(env.ctx, id, 'tick');
    expect(await listEvents(env.ctx)).toEqual([{ at: expect.any(Number), level: 'warn', code: 'source_refresh_failed', sourceId: id, reason: 'unreachable' }]);
    const raw = (await env.kv.get('ltv:events'))!;
    for (const l of ['iptv.example.com', 'geheim', 'Anbieter']) expect(raw).not.toContain(l);
  });

  it('the code list is the Phase 1 set', () => {
    expect([...LIVE_EVENT_CODES]).toEqual(['source_refresh_failed', 'ingest_sync_pending', 'stopped_by_admin', 'start_refused_full', 'start_failed',
      'input_lost', 'input_back', 'push_rejected', 'released_on_switch']);
  });
});
