// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { livetvDetectTick } from '../src/livetv/detect.js';
import { livetvCheck } from '../src/syscheck/checks/livetv.js';
import { updatesCheck } from '../src/syscheck/checks/updates.js';
import { buildSystemcheck, registerChecks, resetChecksForTests } from '../src/syscheck/engine.js';
import type { CheckId, SystemcheckResult } from '../src/syscheck/types.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Systemcheck Stage 3, Task 7: the Live-TV lines (container, encoder, lists, guides) and the update lines (updater, update path, Portainer).
const SECRET = cfg.INTERNAL_SECRET;
const SYSTEM = {
  cpu: { model: 'Fictional CPU', cores: 4, loadPct: 3 }, gpu: { devices: ['renderD128'], driver: 'iHD', readable: true, busyPct: null, nvidia: false },
  encoders: ['h264_qsv', 'libx264'], cache: { usedBytes: 0, maxBytes: 1000 }, recordings: null, srt: { ports: [9000] },
};
const fake = {
  livetv: 'down' as 'down' | 'up',
  readable: true,
  hwAccel: 'qsv',
  /** updater: absent (no answer), 401, or its status with this stack */
  updater: 'up' as 'up' | 'absent' | 'unauthorized',
  stack: 'own' as 'own' | 'foreign' | null,
  portainer: 200,
  reset() { Object.assign(this, { livetv: 'down', readable: true, hwAccel: 'qsv', updater: 'up', stack: 'own', portainer: 200 }); },
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fakeFetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const u = new URL(String(input));
  if (u.host === 'livetv:8090') {
    if (fake.livetv === 'down') throw new TypeError('fetch failed');
    if (u.pathname === '/healthz') {
      const key = createHmac('sha256', SECRET).update('friendflix-livetv/v1').digest();
      const proof = createHmac('sha256', key).update(`healthz:${u.searchParams.get('n') ?? ''}`).digest('hex');
      return json({ ok: true, api: 1, version: '1.0.0', bootId: '0123456789abcdef', proof });
    }
    if (u.pathname === '/v1/system') return json({ ...SYSTEM, gpu: { ...SYSTEM.gpu, readable: fake.readable } });
    return json({ error: 'not_found' }, 404);
  }
  if (u.host === 'updater:7070') {
    if (fake.updater === 'absent') throw new TypeError('fetch failed');
    if (fake.updater === 'unauthorized') return json({ error: 'bad_signature' }, 401);
    return json({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false,
      job: null, log: [], services: [], ...(fake.stack ? { stack: fake.stack } : {}) });
  }
  if (u.host === 'portainer.example.com') {
    // an upstream that echoes the key it was sent: the answer must never carry it on
    return new Response(`{"message":"Invalid API key sekret-pt-0000 for ${u.href}"}`, { status: fake.portainer });
  }
  return json({}, 404);
}) as typeof fetch;

let env: TestEnv;
const setCfg = (patch: Record<string, unknown>) => { env.ctx.cfg = { ...cfg, ...patch } as typeof env.ctx.cfg; };
const run = (): Promise<SystemcheckResult> => buildSystemcheck(env.ctx, { fresh: true });
const get = (r: SystemcheckResult, id: CheckId) => r.lines.find((l) => l.id === id)!;
/** two missed checks in a row: an earlier test's livetv counts as gone (detect.ts keeps it over a single miss) */
async function livetvGone() { fake.livetv = 'down'; await livetvDetectTick(env.ctx); await livetvDetectTick(env.ctx); }
async function livetvUp() { fake.livetv = 'up'; await livetvDetectTick(env.ctx); }
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
async function addList(o: { refresh?: string; lastOk?: Date | null; lastError?: string | null; epg?: boolean; epgOk?: Date | null; epgError?: string | null; enabled?: boolean } = {}) {
  await env.pool.query(
    `insert into livetv_sources(id, kind, name, url_enc, url_hint, epg_url_enc, refresh, enabled, last_refresh_at, last_ok_at, last_error, epg_last_refresh_at, epg_last_ok_at, epg_last_error)
     values ($1, 'm3u', 'Liste', 'x', 'iptv.example.com', $2, $3, $4, now(), $5, $6, $7, $8, $9)`,
    [randomUUID(), o.epg ? 'y' : null, o.refresh ?? '24h', o.enabled ?? true, o.lastOk === undefined ? hoursAgo(1) : o.lastOk, o.lastError ?? null,
      o.epg ? new Date() : null, o.epg ? (o.epgOk === undefined ? hoursAgo(1) : o.epgOk) : null, o.epgError ?? null]);
}

beforeAll(async () => {
  env = await makeEnv({ 'GET /System/Configuration/encoding': () => ({ json: { HardwareAccelerationType: fake.hwAccel } }) }, { ctxPatch: (c) => { c.fetchImpl = fakeFetch; } });
  await env.login(ADMIN);
  resetChecksForTests();
  registerChecks([livetvCheck, updatesCheck]);
});
afterAll(() => env.close());
beforeEach(async () => {
  fake.reset();
  setCfg({});
  env.ctx.fetchImpl = fakeFetch;
  await env.pool.query('delete from livetv_sources');
  for (const k of await env.kv.keys('syscheck:')) await env.kv.del(k);
});

describe('Live TV lines', () => {
  it('Live TV never enabled → all four livetv lines not_set_up, none counted as problem', async () => {
    await livetvGone();
    const r = await run();
    const mine = r.lines.filter((l) => l.group === 'livetv');
    expect(mine.map((l) => [l.id, l.status])).toEqual([
      ['livetv.container', 'not_set_up'], ['livetv.encoder', 'not_set_up'], ['livetv.sources', 'not_set_up'], ['livetv.guides', 'not_set_up'],
    ]);
    expect(get(r, 'livetv.container')).toMatchObject({ cause: 'livetv_not_set', href: '/admin/livetv' });
    expect(r.counts.problem + r.counts.warning).toBe(0);
  });

  it('LIVETV_WANTED and livetv not answering → livetv.container problem livetv_down; encoder/sources/guides unknown', async () => {
    await livetvGone();
    setCfg({ LIVETV_WANTED: 'true' });
    await addList({ lastError: 'unreachable' });
    const r = await run();
    expect(get(r, 'livetv.container')).toMatchObject({ status: 'problem', cause: 'livetv_down', href: '/admin/livetv' });
    for (const id of ['livetv.encoder', 'livetv.sources', 'livetv.guides'] as const) expect(get(r, id)).toMatchObject({ status: 'unknown', cause: 'livetv_needed' });
    // a single missed check after it ran (kept as installed, not reachable) is down too
    await livetvUp();
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx);
    expect(get(await run(), 'livetv.container')).toMatchObject({ status: 'problem', cause: 'livetv_down' });
  });

  it('installed and answering, nothing configured yet → container and encoder ok, lists and guides not_set_up', async () => {
    await livetvUp();
    const r = await run();
    expect(get(r, 'livetv.container').status).toBe('ok');
    expect(get(r, 'livetv.encoder').status).toBe('ok');
    expect(get(r, 'livetv.sources')).toMatchObject({ status: 'not_set_up', cause: 'sources_none', href: '/admin/livetv' });
    expect(get(r, 'livetv.guides')).toMatchObject({ status: 'not_set_up', cause: 'guides_none' });
  });

  it('a list with last_error → livetv.sources warning params.n 1', async () => {
    await livetvUp();
    await addList();
    await addList({ lastError: 'http_404' });
    await addList({ lastError: 'http_500', enabled: false }); // switched off: not counted
    expect(get(await run(), 'livetv.sources')).toMatchObject({ status: 'warning', cause: 'sources_failed', params: { n: 1 } });
  });

  it('last ok 3 days ago on a 24h list → sources_stale; a manual list is never stale', async () => {
    await livetvUp();
    await addList({ refresh: 'manual', lastOk: hoursAgo(24 * 30) });
    expect(get(await run(), 'livetv.sources').status).toBe('ok');
    await addList({ lastOk: hoursAgo(72) });
    expect(get(await run(), 'livetv.sources')).toMatchObject({ status: 'warning', cause: 'sources_stale', params: { n: 1 } });
  });

  it('guides: a failed guide → warning n; one older than twice the EPG age → guides_stale; fresh → ok', async () => {
    await livetvUp();
    await addList({ epg: true });
    expect(get(await run(), 'livetv.guides').status).toBe('ok');
    await addList({ epg: true, epgOk: hoursAgo(60) });
    expect(get(await run(), 'livetv.guides')).toMatchObject({ status: 'warning', cause: 'guides_stale', params: { n: 1 } });
    await addList({ epg: true, epgError: 'http_404' });
    expect(get(await run(), 'livetv.guides')).toMatchObject({ status: 'warning', cause: 'guides_failed', params: { n: 1 } });
  });

  it('gpu advice needsRenderGid → livetv.encoder warning gpu_needs_render_gid settingKey LIVETV_ENCODER settingGroup livetv', async () => {
    fake.readable = false;
    await livetvUp();
    expect(get(await run(), 'livetv.encoder')).toMatchObject({
      status: 'warning', cause: 'gpu_needs_render_gid', fix: 'gpu_needs_render_gid', settingKey: 'LIVETV_ENCODER', settingGroup: 'livetv', docs: 'livetv.md#gpu',
    });
  });
});

describe('Update lines', () => {
  it('no UPDATER_URL → updates.updater not_set_up; updates.path still evaluated from portainer settings', async () => {
    const r = await run();
    expect(get(r, 'updates.updater')).toMatchObject({ status: 'not_set_up', cause: 'updater_not_set', docs: 'setup.md#updater' });
    expect(get(r, 'updates.path')).toMatchObject({ status: 'not_set_up', cause: 'path_manual' });
    expect(get(r, 'updates.portainer')).toMatchObject({ status: 'not_set_up', cause: 'portainer_not_used' });
    expect(r.lines.filter((l) => l.group === 'updates' && (l.status === 'problem' || l.status === 'warning'))).toEqual([]);
    setCfg({ PORTAINER_WEBHOOK_URL: 'https://portainer.example.com/api/stacks/webhooks/x' });
    expect(get(await run(), 'updates.path')).toMatchObject({ status: 'ok', cause: 'path_portainer' });
    setCfg({ PORTAINER_URL: 'https://portainer.example.com' });
    expect(get(await run(), 'updates.path')).toMatchObject({ status: 'problem', cause: 'portainer_missing', params: { keys: 'PORTAINER_API_KEY,PORTAINER_STACK_ID' } });
  });

  it('stack own → updates.path ok path_compose; updates.portainer not_set_up', async () => {
    setCfg({ UPDATER_URL: 'http://updater:7070' });
    const r = await run();
    expect(get(r, 'updates.updater').status).toBe('ok');
    expect(get(r, 'updates.path')).toMatchObject({ status: 'ok', cause: 'path_compose' });
    expect(get(r, 'updates.portainer')).toMatchObject({ status: 'not_set_up' });
  });

  it('stack foreign, PORTAINER_URL only → updates.path problem portainer_missing params.keys … settingKey PORTAINER_API_KEY', async () => {
    setCfg({ UPDATER_URL: 'http://updater:7070', PORTAINER_URL: 'https://portainer.example.com' });
    fake.stack = 'foreign';
    expect(get(await run(), 'updates.path')).toMatchObject({
      status: 'problem', cause: 'portainer_missing', params: { keys: 'PORTAINER_API_KEY,PORTAINER_STACK_ID' }, settingKey: 'PORTAINER_API_KEY',
    });
    setCfg({ UPDATER_URL: 'http://updater:7070' });
    expect(get(await run(), 'updates.path')).toMatchObject({ status: 'problem', cause: 'portainer_not_set', settingKey: 'PORTAINER_URL' });
    setCfg({ UPDATER_URL: 'http://updater:7070', PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: 'sekret-pt-0000', PORTAINER_STACK_ID: '7' });
    expect(get(await run(), 'updates.path')).toMatchObject({ status: 'ok', cause: 'path_portainer' });
  });

  it('stack null (old updater) → updates.path warning stack_unknown', async () => {
    setCfg({ UPDATER_URL: 'http://updater:7070' });
    fake.stack = null;
    expect(get(await run(), 'updates.path')).toMatchObject({ status: 'warning', cause: 'stack_unknown' });
  });

  it('Portainer answers 401 → updates.portainer problem portainer_key_invalid; JSON never contains sekret-pt-0000', async () => {
    setCfg({ PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: 'sekret-pt-0000', PORTAINER_STACK_ID: '7' });
    fake.portainer = 401;
    const r = await run();
    expect(get(r, 'updates.portainer')).toMatchObject({ status: 'problem', cause: 'portainer_key_invalid', settingKey: 'PORTAINER_API_KEY' });
    expect(JSON.stringify(r)).not.toContain('sekret-pt-0000');
    expect(JSON.stringify(r)).not.toContain('portainer.example.com');
    fake.portainer = 404;
    expect(get(await run(), 'updates.portainer')).toMatchObject({ status: 'problem', cause: 'portainer_stack_missing', settingKey: 'PORTAINER_STACK_ID' });
    fake.portainer = 200;
    expect(get(await run(), 'updates.portainer').status).toBe('ok');
    // the webhook way is never fired from here: ok, with a note that it was not tried
    setCfg({ PORTAINER_WEBHOOK_URL: 'https://portainer.example.com/api/stacks/webhooks/sekret-pt-0000' });
    const w = await run();
    expect(get(w, 'updates.portainer')).toMatchObject({ status: 'ok', cause: 'portainer_webhook' });
    expect(JSON.stringify(w)).not.toContain('sekret-pt-0000');
  });
  // last: an updater that did not answer is remembered as absent for 30 s per ctx (updater.ts)
  it('updater refusing the signature → problem updater_secret; set but not answering → warning updater_down', async () => {
    setCfg({ UPDATER_URL: 'http://updater:7070' });
    fake.updater = 'unauthorized';
    expect(get(await run(), 'updates.updater')).toMatchObject({ status: 'problem', cause: 'updater_secret', docs: 'setup.md#updater' });
    fake.updater = 'absent';
    const r = await run();
    expect(get(r, 'updates.updater')).toMatchObject({ status: 'warning', cause: 'updater_down', docs: 'setup.md#updater' });
    expect(get(r, 'updates.path')).toMatchObject({ status: 'unknown', cause: 'updater_needed' });
    // the Portainer way still decides the path while the updater is away
    setCfg({ UPDATER_URL: 'http://updater:7070', PORTAINER_WEBHOOK_URL: 'https://portainer.example.com/api/stacks/webhooks/x' });
    expect(get(await run(), 'updates.path')).toMatchObject({ status: 'ok', cause: 'path_portainer' });
  });
});
