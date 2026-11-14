// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { MemoryKV } from '../src/kv.js';
import { REDEPLOY_TIMEOUT_MS, beginRedeploy, redeployView, settleRedeploy, type ServiceSeen } from '../src/redeploy.js';

// The phase of an update handed to Portainer (redeploy.ts), worked out from what runs afterwards: Portainer gives no progress
// and recreates this backend halfway through, so the record lives in the kv store and every read judges it again.
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const T0 = 1_800_000_000_000;
const ctxOf = (sha = OLD, kv = new MemoryKV()) => ({ kv, cfg: { GIT_SHA: sha } }) as unknown as Ctx;
const svc = (service: string, sha: string, state = 'running', health = 'healthy'): ServiceSeen => ({ service, state, health, sha });
const all = (sha: string, over: Partial<Record<string, ServiceSeen>> = {}) => ['backend', 'gateway', 'web', 'updater'].map((s) => over[s] ?? svc(s, sha));

describe('Portainer redeploy phases', () => {
  it('pulling -> recreating (n of 3) -> health -> done on the new backend; the end is kept', async () => {
    const kv = new MemoryKV();
    const old = ctxOf(OLD, kv);
    const id = await beginRedeploy(old, 'api', 'latest', T0);
    const booted = T0 - 60_000; // this backend ran before the redeploy
    expect(await redeployView(old, all('sha-aaaaaaa'), T0 + 1_000, booted)).toMatchObject({ id, mode: 'api', tag: 'latest', phase: 'pulling', running: true, services: { updated: 0, total: 3 } });
    // Portainer recreates the gateway first (the updater is not one of the judged services)
    const mid = all('sha-aaaaaaa', { gateway: svc('gateway', 'sha-bbbbbbb'), web: svc('web', 'sha-aaaaaaa', 'exited', '') });
    expect(await redeployView(old, mid, T0 + 60_000, booted)).toMatchObject({ phase: 'recreating', services: { updated: 1, total: 3 } });
    // the new backend (another build, started after the redeploy) answers; web still starting
    const fresh = ctxOf(NEW, kv);
    const starting = all('sha-bbbbbbb', { web: svc('web', 'sha-bbbbbbb', 'running', 'starting') });
    expect(await redeployView(fresh, starting, T0 + 90_000, T0 + 80_000)).toMatchObject({ phase: 'health', running: true, services: { updated: 3, total: 3 } });
    const done = await redeployView(fresh, all('sha-bbbbbbb'), T0 + 100_000, T0 + 80_000);
    expect(done).toMatchObject({ phase: 'done', running: false, finishedAt: new Date(T0 + 100_000).toISOString() });
    // stored: a later read with other services (a manual change, the updater gone) still shows how it ended
    expect(await redeployView(fresh, null, T0 + 999_999_999, T0 + 80_000)).toMatchObject({ phase: 'done', finishedAt: done!.finishedAt });
  });

  it('without an updater listing: done as soon as this backend is a new container (also of the same build: a forced redeploy)', async () => {
    const kv = new MemoryKV();
    await beginRedeploy(ctxOf(OLD, kv), 'webhook', 'nightly', T0);
    expect(await redeployView(ctxOf(OLD, kv), null, T0 + 5_000, T0 - 1)).toMatchObject({ phase: 'pulling', services: null });
    expect(await redeployView(ctxOf(OLD, kv), null, T0 + 50_000, T0 + 40_000)).toMatchObject({ phase: 'done' });
  });

  it('a refusal, also one that came after "started" went out, ends it as failed with the status and step only', async () => {
    const ctx = ctxOf();
    const id = await beginRedeploy(ctx, 'api', 'latest', T0);
    await settleRedeploy(ctx, id, { ok: false, error: 'portainer', step: 'redeploy', status: 500 }, T0 + 90_000);
    expect(await redeployView(ctx, null, T0 + 91_000, T0 - 1)).toMatchObject({ phase: 'failed', running: false, error: 'portainer', step: 'redeploy', status: 500, code: null });
    // an answer for an older redeploy changes nothing
    const next = await beginRedeploy(ctx, 'api', 'latest', T0 + 100_000);
    await settleRedeploy(ctx, id, { ok: false, error: 'portainer', step: 'redeploy', status: 404 });
    expect(await redeployView(ctx, null, T0 + 101_000, T0 - 1)).toMatchObject({ id: next, phase: 'pulling' });
  });

  it('Portainer done (its API answers after redeploying) but nothing recreated: unchanged; no answer and no change in 15 minutes: timeout', async () => {
    const ctx = ctxOf();
    const id = await beginRedeploy(ctx, 'api', 'latest', T0);
    await settleRedeploy(ctx, id, { ok: true }, T0 + 40_000);
    expect(await redeployView(ctx, all('sha-aaaaaaa'), T0 + 41_000, T0 - 1)).toMatchObject({ phase: 'unchanged', running: false });
    // an answer inside the grace window (a webhook, or a Portainer that deploys in the background) proves nothing yet
    const quick = ctxOf();
    const q = await beginRedeploy(quick, 'webhook', 'latest', T0);
    await settleRedeploy(quick, q, { ok: true }, T0 + 300);
    expect(await redeployView(quick, null, T0 + 60_000, T0 - 1)).toMatchObject({ phase: 'pulling' });
    expect(await redeployView(quick, null, T0 + REDEPLOY_TIMEOUT_MS + 1, T0 - 1)).toMatchObject({ phase: 'unchanged' });
    const silent = ctxOf();
    await beginRedeploy(silent, 'api', 'latest', T0);
    expect(await redeployView(silent, null, T0 + REDEPLOY_TIMEOUT_MS + 1, T0 - 1)).toMatchObject({ phase: 'timeout', running: false, at: 'pulling' });
  });

  it('nothing recorded: null', async () => {
    expect(await redeployView(ctxOf(), null)).toBeNull();
  });
});
