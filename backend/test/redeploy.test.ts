// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { MemoryKV } from '../src/kv.js';
import { REDEPLOY_KEY, REDEPLOY_LOCK, REDEPLOY_TIMEOUT_MS, abandonRedeploy, beginRedeploy, claimRedeploy, redeployView, settleRedeploy, type ServiceSeen } from '../src/redeploy.js';

// The phase of an update handed to Portainer (redeploy.ts), worked out from what runs afterwards: Portainer gives no progress
// and recreates this backend halfway through, so the record lives in the kv store and every read judges it again.
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const T0 = 1_800_000_000_000;
const BEFORE = T0 - 60_000; // this backend ran before the redeploy
const ctxOf = (sha = OLD, kv = new MemoryKV()) => ({ kv, cfg: { GIT_SHA: sha } }) as unknown as Ctx;
const svc = (service: string, sha: string, state = 'running', health = 'healthy'): ServiceSeen => ({ service, state, health, sha });
const all = (sha: string, over: Partial<Record<string, ServiceSeen>> = {}) => ['backend', 'gateway', 'web', 'updater'].map((s) => over[s] ?? svc(s, sha));
async function start(ctx: Ctx, mode: 'api' | 'webhook' = 'api', updater = true, at = T0) {
  const id = (await claimRedeploy(ctx, at))!;
  expect(id).toMatch(/^[0-9a-f]{16}$/);
  expect(await beginRedeploy(ctx, id, mode, 'latest', updater, at)).toBe(true);
  return id;
}

describe('Portainer redeploy phases', () => {
  it('pulling -> recreating (n of 3) -> health -> done on the new backend; the end is kept and frees the slot', async () => {
    const kv = new MemoryKV();
    const old = ctxOf(OLD, kv);
    const id = await start(old);
    expect(await redeployView(old, all('sha-aaaaaaa'), T0 + 1_000, BEFORE)).toMatchObject({ id, mode: 'api', tag: 'latest', phase: 'pulling', running: true, services: { updated: 0, total: 3 } });
    const mid = all('sha-aaaaaaa', { gateway: svc('gateway', 'sha-bbbbbbb'), web: svc('web', 'sha-aaaaaaa', 'exited', '') });
    expect(await redeployView(old, mid, T0 + 60_000, BEFORE)).toMatchObject({ phase: 'recreating', services: { updated: 1, total: 3 } });
    const fresh = ctxOf(NEW, kv);
    // the new backend answers while the updater is being recreated too: no listing now, so it waits (never done from the backend alone)
    expect(await redeployView(fresh, null, T0 + 80_000, T0 + 70_000)).toMatchObject({ phase: 'health', running: true });
    const starting = all('sha-bbbbbbb', { web: svc('web', 'sha-bbbbbbb', 'running', 'starting') });
    expect(await redeployView(fresh, starting, T0 + 90_000, T0 + 70_000)).toMatchObject({ phase: 'health', running: true, services: { updated: 3, total: 3 } });
    expect(await kv.get(REDEPLOY_LOCK)).toBe(id);
    const done = await redeployView(fresh, all('sha-bbbbbbb'), T0 + 100_000, T0 + 70_000);
    expect(done).toMatchObject({ phase: 'done', running: false, finishedAt: new Date(T0 + 100_000).toISOString() });
    expect(await kv.get(REDEPLOY_LOCK)).toBeNull();
    expect(await redeployView(fresh, null, T0 + 999_999_999, T0 + 70_000)).toMatchObject({ phase: 'done', finishedAt: done!.finishedAt });
  });

  it('one at a time: a second claim while one runs is refused and the record stays', async () => {
    const kv = new MemoryKV();
    const ctx = ctxOf(OLD, kv);
    const id = await start(ctx, 'api', true, Date.now());
    expect(await claimRedeploy(ctx)).toBeNull();
    expect(JSON.parse((await kv.get(REDEPLOY_KEY))!).id).toBe(id);
    // a refusal ends it and frees the slot
    await settleRedeploy(ctx, id, { ok: false, error: 'portainer', step: 'redeploy', status: 500 });
    expect(await claimRedeploy(ctx)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('without an updater: the new build alone decides; a restart of the same build without any change seen is not done', async () => {
    const kv = new MemoryKV();
    await start(ctxOf(OLD, kv), 'webhook', false);
    expect(await redeployView(ctxOf(OLD, kv), undefined, T0 + 5_000, BEFORE)).toMatchObject({ phase: 'pulling', services: null });
    // a crash or reboot of this backend (same build) proves nothing
    expect(await redeployView(ctxOf(OLD, kv), undefined, T0 + 50_000, T0 + 40_000)).toMatchObject({ phase: 'pulling', running: true });
    expect(await redeployView(ctxOf(NEW, kv), undefined, T0 + 60_000, T0 + 55_000)).toMatchObject({ phase: 'done' });
    // set up but absent from the start (compose.no-updater.yaml keeps UPDATER_URL): null counts as no updater for this redeploy
    const kv2 = new MemoryKV();
    await start(ctxOf(OLD, kv2), 'webhook', false);
    expect(await redeployView(ctxOf(NEW, kv2), null, T0 + 60_000, T0 + 55_000)).toMatchObject({ phase: 'done' });
  });

  it('a same-build restart counts once a change was seen (a forced redeploy recreated the services)', async () => {
    const kv = new MemoryKV();
    await start(ctxOf(OLD, kv));
    expect(await redeployView(ctxOf(OLD, kv), all('sha-aaaaaaa', { web: svc('web', 'sha-aaaaaaa', 'exited', '') }), T0 + 20_000, BEFORE)).toMatchObject({ phase: 'recreating' });
    expect(await redeployView(ctxOf(OLD, kv), all('sha-aaaaaaa'), T0 + 40_000, T0 + 30_000)).toMatchObject({ phase: 'done' });
  });

  it('a refusal, also one after "started" went out, ends it as failed with the status and step only; an older answer changes nothing', async () => {
    const ctx = ctxOf();
    const id = await start(ctx);
    await settleRedeploy(ctx, id, { ok: false, error: 'portainer', step: 'redeploy', status: 500 }, T0 + 90_000);
    expect(await redeployView(ctx, null, T0 + 91_000, BEFORE)).toMatchObject({ phase: 'failed', running: false, error: 'portainer', step: 'redeploy', status: 500, code: null });
    const next = await start(ctx, 'api', true, T0 + 100_000);
    await settleRedeploy(ctx, id, { ok: false, error: 'portainer', step: 'redeploy', status: 404 });
    expect(await redeployView(ctx, null, T0 + 101_000, BEFORE)).toMatchObject({ id: next, phase: 'pulling' });
  });

  it('the API answered "done" (not deploying) and nothing changed: unchanged at once; a "deploying" or webhook answer waits', async () => {
    const ctx = ctxOf();
    const id = await start(ctx);
    await settleRedeploy(ctx, id, { ok: true, sync: true }, T0 + 2_000);
    expect(await redeployView(ctx, all('sha-aaaaaaa'), T0 + 3_000, BEFORE)).toMatchObject({ phase: 'unchanged', running: false });
    const quick = ctxOf();
    const q = await start(quick, 'webhook');
    await settleRedeploy(quick, q, { ok: true, sync: false }, T0 + 300);
    expect(await redeployView(quick, all('sha-aaaaaaa'), T0 + 60_000, BEFORE)).toMatchObject({ phase: 'pulling' });
    expect(await redeployView(quick, all('sha-aaaaaaa'), T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE)).toMatchObject({ phase: 'unchanged' });
  });

  it('timeout: unchanged only when it never got past pulling; stuck later (or no answer at all) is a timeout naming the phase', async () => {
    const ctx = ctxOf();
    const id = await start(ctx);
    await settleRedeploy(ctx, id, { ok: true, sync: false }, T0 + 1_000);
    const stuck = all('sha-aaaaaaa', { gateway: svc('gateway', 'sha-bbbbbbb', 'running', 'unhealthy') });
    expect(await redeployView(ctx, stuck, T0 + 60_000, BEFORE)).toMatchObject({ phase: 'recreating' });
    expect(await redeployView(ctx, stuck, T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE)).toMatchObject({ phase: 'timeout', running: false, at: 'recreating' });
    const silent = ctxOf();
    await start(silent);
    expect(await redeployView(silent, null, T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE)).toMatchObject({ phase: 'timeout', running: false, at: 'pulling' });
  });

  it('a stored value of another shape is ignored; nothing recorded: null', async () => {
    const kv = new MemoryKV();
    await kv.set(REDEPLOY_KEY, JSON.stringify({ id: 'x', mode: 'api', final: 'done' }), 60);
    expect(await redeployView(ctxOf(OLD, kv), null)).toBeNull();
    await kv.set(REDEPLOY_KEY, '{not json', 60);
    expect(await redeployView(ctxOf(OLD, kv), null)).toBeNull();
    expect(await redeployView(ctxOf(), null)).toBeNull();
  });

  it('the slot: only claimed for two minutes until recorded, then held; a slot left by an ended or timed-out redeploy is taken over', async () => {
    const kv = new MemoryKV();
    const ctx = ctxOf(OLD, kv);
    const now = Date.now();
    // claimed, never recorded (a crash in between): a short slot that expires on its own
    const lost = (await claimRedeploy(ctx, now))!;
    expect(await claimRedeploy(ctx, now)).toBeNull();
    await abandonRedeploy(ctx, lost); // (stands in for the two minutes passing)
    const id = await start(ctx, 'api', true, now);
    expect(await claimRedeploy(ctx, now + 1_000)).toBeNull();
    // the redeploy ran out of time but nobody stored its end yet, the slot still says so: taken over
    const next = await claimRedeploy(ctx, now + REDEPLOY_TIMEOUT_MS + 1);
    expect(next).toMatch(/^[0-9a-f]{16}$/);
    expect(next).not.toBe(id);
    expect(await kv.get(REDEPLOY_LOCK)).toBe(next);
    // an end that was stored but whose release got lost: taken over too; a slot held by someone else (no record of it) is not
    const kv2 = new MemoryKV();
    const c2 = ctxOf(OLD, kv2);
    const id2 = await start(c2, 'api', true, now);
    await settleRedeploy(c2, id2, { ok: false, error: 'portainer', step: 'redeploy', status: 500 });
    await kv2.set(REDEPLOY_LOCK, id2, 900);
    expect(await claimRedeploy(c2, now + 1_000)).toMatch(/^[0-9a-f]{16}$/);
    await kv2.set(REDEPLOY_LOCK, 'f'.repeat(16), 900);
    expect(await claimRedeploy(c2, now + 2_000)).toBeNull();
  });

  it('mutex contention: a redeploy that cannot be recorded is refused (false); a refusal is still recorded after a few tries', async () => {
    const kv = new MemoryKV();
    const ctx = ctxOf(OLD, kv);
    const id = (await claimRedeploy(ctx))!;
    await kv.set('update:portainer:redeploy:mutex', 'someone-else', 60);
    expect(await beginRedeploy(ctx, id, 'api', 'latest', true, T0, 50)).toBe(false);
    expect(await kv.get(REDEPLOY_KEY)).toBeNull();
    await abandonRedeploy(ctx, id); // what the caller does: the slot is free again
    await kv.del('update:portainer:redeploy:mutex');
    const id2 = await start(ctx, 'api', true, Date.now());
    expect(id2).not.toBe(id);
    await kv.set('update:portainer:redeploy:mutex', 'someone-else', 60);
    await settleRedeploy(ctx, id2, { ok: false, error: 'portainer', step: 'redeploy', status: 500 }, Date.now(), 30, 2);
    expect(JSON.parse((await kv.get(REDEPLOY_KEY))!)).toMatchObject({ id: id2, final: 'failed', status: 500 });
    expect(await kv.get(REDEPLOY_LOCK)).toBeNull();
  });

  it('Portainer said done but the updater gives no listing right now: not "unchanged" yet (it may still be recreating)', async () => {
    const ctx = ctxOf();
    const id = await start(ctx);
    await settleRedeploy(ctx, id, { ok: true, sync: true }, T0 + 2_000);
    expect(await redeployView(ctx, null, T0 + 3_000, BEFORE)).toMatchObject({ phase: 'pulling', running: true });
    expect(await redeployView(ctx, all('sha-aaaaaaa'), T0 + 4_000, BEFORE)).toMatchObject({ phase: 'unchanged' });
  });

  it('a failure names where it happened: refused at once = before anything ran (at null), a late refusal while pulling or recreating, a stack in error after recreating', async () => {
    const fast = ctxOf();
    const f = await start(fast);
    await settleRedeploy(fast, f, { ok: false, error: 'portainer', step: 'stack', status: 401 }, T0 + 1_000);
    expect(await redeployView(fast, null, T0 + 2_000, BEFORE)).toMatchObject({ phase: 'failed', at: null, step: 'stack' });
    const late = ctxOf();
    const l = await start(late);
    await settleRedeploy(late, l, { ok: false, error: 'portainer', step: 'redeploy', status: 500, late: true }, T0 + 60_000);
    expect(await redeployView(late, null, T0 + 61_000, BEFORE)).toMatchObject({ phase: 'failed', at: 'pulling' });
    const seen = ctxOf();
    const s = await start(seen);
    // a service was seen recreated before Portainer's refusal came in
    expect(await redeployView(seen, all('sha-aaaaaaa', { web: svc('web', 'sha-aaaaaaa', 'exited', '') }), T0 + 20_000, BEFORE)).toMatchObject({ phase: 'recreating' });
    await settleRedeploy(seen, s, { ok: false, error: 'portainer', step: 'redeploy', status: 500, late: true }, T0 + 60_000);
    expect(await redeployView(seen, null, T0 + 61_000, BEFORE)).toMatchObject({ phase: 'failed', at: 'recreating' });
    const deploy = ctxOf();
    const d = await start(deploy);
    await settleRedeploy(deploy, d, { ok: false, error: 'portainer', step: 'deploy', status: null }, T0 + 3_000);
    expect(await redeployView(deploy, null, T0 + 4_000, BEFORE)).toMatchObject({ phase: 'failed', at: 'recreating', step: 'deploy' });
  });

  it('a late "ok" landing between the read and the store: the phase is judged again from the newer record, never an end that was not stored', async () => {
    const kv = new MemoryKV();
    const ctx = ctxOf(OLD, kv);
    const id = await start(ctx);
    // Portainer's API answers "done" (sync) right when this read takes the mutex to store a timeout judged from the older record
    const setnx = kv.setnx.bind(kv);
    let once = true;
    kv.setnx = async (k: string, v: string, ttl: number) => {
      if (once && k.endsWith(':mutex')) {
        once = false;
        const r = JSON.parse((await kv.get(REDEPLOY_KEY))!);
        await kv.set(REDEPLOY_KEY, JSON.stringify({ ...r, answer: 'ok', answeredAt: T0 + 1_000, sync: true }), 60);
      }
      return setnx(k, v, ttl);
    };
    const v = await redeployView(ctx, all('sha-aaaaaaa'), T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE);
    expect(v).toMatchObject({ id, phase: 'unchanged', running: false });
    expect(JSON.parse((await kv.get(REDEPLOY_KEY))!)).toMatchObject({ final: 'unchanged' });
  });

  it('the slot cannot be held (its claim expired, another took it): nothing is recorded, no phantom "pulling", the next claim succeeds', async () => {
    const kv = new MemoryKV();
    const ctx = ctxOf(OLD, kv);
    const id = (await claimRedeploy(ctx))!;
    await kv.del(REDEPLOY_LOCK); // the 120 s claim ran out before the record
    expect(await beginRedeploy(ctx, id, 'api', 'latest', true)).toBe(false);
    expect(await kv.get(REDEPLOY_KEY)).toBeNull();
    expect(await redeployView(ctx, null)).toBeNull();
    expect(await claimRedeploy(ctx)).toMatch(/^[0-9a-f]{16}$/);
  });
});
