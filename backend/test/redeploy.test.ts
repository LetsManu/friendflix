// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { MemoryKV } from '../src/kv.js';
import { REDEPLOY_KEY, REDEPLOY_LOCK, REDEPLOY_TIMEOUT_MS, abandonRedeploy, beginRedeploy, claimRedeploy, redeployView, settleRedeploy, type ServiceSeen } from '../src/redeploy.js';

// The phase of an update handed to Portainer (redeploy.ts), worked out from what runs afterwards: Portainer gives no progress
// and recreates this backend halfway through, so the record lives in the kv store and every read judges it again.
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
/** a web-only update: backend (B) and gateway (G) carried, web from W1 to W2 */
const B = '1'.repeat(40), G = '2'.repeat(40), W1 = '3'.repeat(40), W2 = '4'.repeat(40);
const T0 = 1_800_000_000_000;
const BEFORE = T0 - 60_000; // this backend ran before the redeploy
const SECRET = 'internal-secret-123456';
/** commit times as GitHub answers them (installed.ts commitTime): the newest image commit is the installed build */
const TIMES: Record<string, string> = {
  [OLD]: '2026-01-01T00:00:00Z', [NEW]: '2026-02-01T00:00:00Z',
  [B]: '2026-03-01T00:00:00Z', [G]: '2026-03-02T00:00:00Z', [W1]: '2026-03-03T00:00:00Z', [W2]: '2026-03-10T00:00:00Z',
};
const dig = (commit: string) => `sha256:${commit[0]!.repeat(64)}`;
/** what the (fake) updater lists right now; null: it gives no listing */
let listed: ServiceSeen[] | null = null;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fetchImpl = async (input: unknown) => {
  const u = new URL(String(input));
  if (u.host === 'api.github.com') {
    const t = TIMES[u.pathname.split('/').pop()!];
    return t ? json({ commit: { committer: { date: t } } }) : json({}, 404);
  }
  if (u.host === 'updater:7070' && u.pathname === '/v1/status') return listed ? json({ channel: 'stable', services: listed }) : json({}, 500);
  throw new TypeError('fetch failed'); // the services themselves do not answer
};
/** with the updater (UPDATER_URL), the installed build comes from its listing; without, from this backend alone (no service answers) */
const ctxOf = (sha = OLD, kv = new MemoryKV(), updater = true, cfg: Record<string, unknown> = {}) => ({
  kv, fetchImpl,
  cfg: {
    GIT_SHA: sha, UPDATE_REPO: 'example/friendflix', INTERNAL_SECRET: SECRET, UPDATER_URL: updater ? 'http://updater:7070' : undefined,
    WEB_INTERNAL_URL: 'http://web:3000', GATEWAY_URL: 'http://gateway:4000', LIVETV_URL: 'http://livetv:8090', ...cfg,
  },
}) as unknown as Ctx;
/** `changed`: whether the registry has another digest for the tag (null: unknown) */
const svc = (service: string, commit: string, state = 'running', health = 'healthy', changed: boolean | null = null): ServiceSeen => ({ service, state, health, commit, digest: dig(commit), changed });
const all = (commit: string, over: Partial<Record<string, ServiceSeen>> = {}) => ['backend', 'gateway', 'web', 'updater'].map((s) => over[s] ?? svc(s, commit));
/** the page's read: the updater lists `services` (the installed build is asked for it too) */
function view(ctx: Ctx, services: ServiceSeen[] | null | undefined, now?: number, bootedAt?: number) {
  listed = services ?? null;
  return redeployView(ctx, services, now, bootedAt);
}
async function start(ctx: Ctx, mode: 'api' | 'webhook' = 'api', updater = true, at = T0) {
  if (updater) listed = all(OLD);
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
    expect(await view(old, all(OLD), T0 + 1_000, BEFORE)).toMatchObject({ id, mode: 'api', tag: 'latest', phase: 'pulling', running: true, services: { updated: 0, total: 3 } });
    const mid = all(OLD, { gateway: svc('gateway', NEW), web: svc('web', OLD, 'exited', '') });
    expect(await view(old, mid, T0 + 60_000, BEFORE)).toMatchObject({ phase: 'recreating', services: { updated: 1, total: 3 } });
    const fresh = ctxOf(NEW, kv);
    // the new backend answers while the updater is being recreated too: no listing now, so it waits (never done from the backend alone)
    expect(await view(fresh, null, T0 + 80_000, T0 + 70_000)).toMatchObject({ phase: 'health', running: true });
    const starting = all(NEW, { web: svc('web', NEW, 'running', 'starting') });
    expect(await view(fresh, starting, T0 + 90_000, T0 + 70_000)).toMatchObject({ phase: 'health', running: true, services: { updated: 3, total: 3 } });
    expect(await kv.get(REDEPLOY_LOCK)).toBe(id);
    const done = await view(fresh, all(NEW), T0 + 100_000, T0 + 70_000);
    expect(done).toMatchObject({ phase: 'done', running: false, finishedAt: new Date(T0 + 100_000).toISOString() });
    expect(await kv.get(REDEPLOY_LOCK)).toBeNull();
    expect(await view(fresh, null, T0 + 999_999_999, T0 + 70_000)).toMatchObject({ phase: 'done', finishedAt: done!.finishedAt });
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
    await start(ctxOf(OLD, kv, false), 'webhook', false);
    expect(await view(ctxOf(OLD, kv, false), undefined, T0 + 5_000, BEFORE)).toMatchObject({ phase: 'pulling', services: null });
    // a crash or reboot of this backend (same build) proves nothing
    expect(await view(ctxOf(OLD, kv, false), undefined, T0 + 50_000, T0 + 40_000)).toMatchObject({ phase: 'pulling', running: true });
    expect(await view(ctxOf(NEW, kv, false), undefined, T0 + 60_000, T0 + 55_000)).toMatchObject({ phase: 'done' });
    // set up but absent from the start (compose.no-updater.yaml keeps UPDATER_URL): null counts as no updater for this redeploy
    const kv2 = new MemoryKV();
    await start(ctxOf(OLD, kv2), 'webhook', false);
    expect(await view(ctxOf(NEW, kv2), null, T0 + 60_000, T0 + 55_000)).toMatchObject({ phase: 'done' });
  });

  it('a same-build restart counts once a change was seen (a forced redeploy recreated the services)', async () => {
    const kv = new MemoryKV();
    await start(ctxOf(OLD, kv));
    expect(await view(ctxOf(OLD, kv), all(OLD, { web: svc('web', OLD, 'exited', '') }), T0 + 20_000, BEFORE)).toMatchObject({ phase: 'recreating' });
    expect(await view(ctxOf(OLD, kv), all(OLD), T0 + 40_000, T0 + 30_000)).toMatchObject({ phase: 'done' });
  });

  it('a refusal, also one after "started" went out, ends it as failed with the status and step only; an older answer changes nothing', async () => {
    const ctx = ctxOf();
    const id = await start(ctx);
    await settleRedeploy(ctx, id, { ok: false, error: 'portainer', step: 'redeploy', status: 500 }, T0 + 90_000);
    expect(await view(ctx, null, T0 + 91_000, BEFORE)).toMatchObject({ phase: 'failed', running: false, error: 'portainer', step: 'redeploy', status: 500, code: null });
    const next = await start(ctx, 'api', true, T0 + 100_000);
    await settleRedeploy(ctx, id, { ok: false, error: 'portainer', step: 'redeploy', status: 404 });
    expect(await view(ctx, null, T0 + 101_000, BEFORE)).toMatchObject({ id: next, phase: 'pulling' });
  });

  it('the API answered "done" (not deploying) and nothing changed: unchanged at once; a "deploying" or webhook answer waits', async () => {
    const ctx = ctxOf();
    const id = await start(ctx);
    await settleRedeploy(ctx, id, { ok: true, sync: true }, T0 + 2_000);
    expect(await view(ctx, all(OLD), T0 + 3_000, BEFORE)).toMatchObject({ phase: 'unchanged', running: false });
    const quick = ctxOf();
    const q = await start(quick, 'webhook');
    await settleRedeploy(quick, q, { ok: true, sync: false }, T0 + 300);
    expect(await view(quick, all(OLD), T0 + 60_000, BEFORE)).toMatchObject({ phase: 'pulling' });
    expect(await view(quick, all(OLD), T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE)).toMatchObject({ phase: 'unchanged' });
  });

  it('timeout: unchanged only when it never got past pulling; stuck later (or no answer at all) is a timeout naming the phase', async () => {
    const ctx = ctxOf();
    const id = await start(ctx);
    await settleRedeploy(ctx, id, { ok: true, sync: false }, T0 + 1_000);
    // the gateway runs the new build but never gets healthy; backend and web still run the old one, the registry has newer ones
    const stuck = all(OLD, { backend: svc('backend', OLD, 'running', 'healthy', true), gateway: svc('gateway', NEW, 'running', 'unhealthy'), web: svc('web', OLD, 'running', 'healthy', true) });
    expect(await view(ctx, stuck, T0 + 60_000, BEFORE)).toMatchObject({ phase: 'recreating' });
    expect(await view(ctx, stuck, T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE)).toMatchObject({ phase: 'timeout', running: false, at: 'recreating' });
    const silent = ctxOf();
    await start(silent);
    expect(await view(silent, null, T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE)).toMatchObject({ phase: 'timeout', running: false, at: 'pulling' });
  });

  it('a stored value of another shape is ignored; nothing recorded: null', async () => {
    const kv = new MemoryKV();
    await kv.set(REDEPLOY_KEY, JSON.stringify({ id: 'x', mode: 'api', final: 'done' }), 60);
    expect(await view(ctxOf(OLD, kv), null)).toBeNull();
    await kv.set(REDEPLOY_KEY, '{not json', 60);
    expect(await view(ctxOf(OLD, kv), null)).toBeNull();
    expect(await view(ctxOf(), null)).toBeNull();
    // a record from before the per-service start values (no fromServices) is an older shape too
    const ctx = ctxOf(OLD, kv);
    await kv.del(REDEPLOY_KEY);
    await start(ctx);
    const r = JSON.parse((await kv.get(REDEPLOY_KEY))!);
    expect(r).toMatchObject({ from: OLD, fromServices: { backend: dig(OLD), gateway: dig(OLD), web: dig(OLD) } });
    const { fromServices: _gone, ...older } = r;
    await kv.set(REDEPLOY_KEY, JSON.stringify(older), 60);
    expect(await view(ctx, all(OLD))).toBeNull();
  });

  it('a web-only redeploy is done when web runs its new commit, judged without GIT_SHA', async () => {
    // images built only when they changed: backend (B) and gateway (G) are carried, only web moves from W1 to W2; the backend's
    // GIT_SHA says nothing (unset here), this backend is never recreated
    const kv = new MemoryKV();
    const ctx = ctxOf(undefined, kv, true, { GIT_SHA: undefined, FF_IMAGE_COMMIT: B });
    const carried = [svc('backend', B, 'running', 'healthy', false), svc('gateway', G, 'running', 'healthy', false)];
    listed = [...carried, svc('web', W1, 'running', 'healthy', true)];
    const id = (await claimRedeploy(ctx, T0))!;
    expect(await beginRedeploy(ctx, id, 'webhook', 'nightly', true, T0)).toBe(true);
    expect(JSON.parse((await kv.get(REDEPLOY_KEY))!)).toMatchObject({ from: W1, fromServices: { backend: dig(B), gateway: dig(G), web: dig(W1) } });
    expect(await view(ctx, [...carried, svc('web', W1, 'running', 'healthy', true)], T0 + 5_000, BEFORE)).toMatchObject({ phase: 'pulling', services: { updated: 0, total: 3 } });
    expect(await view(ctx, [...carried, svc('web', W1, 'exited', '', true)], T0 + 20_000, BEFORE)).toMatchObject({ phase: 'recreating', services: { updated: 0, total: 3 } });
    expect(await view(ctx, [...carried, svc('web', W2, 'running', 'starting', false)], T0 + 30_000, BEFORE)).toMatchObject({ phase: 'health', running: true, services: { updated: 1, total: 3 } });
    // backend and gateway still run their (unchanged) images: not waited for
    expect(await view(ctx, [...carried, svc('web', W2, 'running', 'healthy', false)], T0 + 40_000, BEFORE)).toMatchObject({ phase: 'done', running: false, services: { updated: 1, total: 3 } });
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
    expect(await view(ctx, null, T0 + 3_000, BEFORE)).toMatchObject({ phase: 'pulling', running: true });
    expect(await view(ctx, all(OLD), T0 + 4_000, BEFORE)).toMatchObject({ phase: 'unchanged' });
  });

  it('a failure names where it happened, from the step and status (never from timing): refused = request row; a 5xx / no status of the redeploy call = pulling (recreating once a change was seen); a stack in error = recreating', async () => {
    const at = async (a: { step: string; status: number | null; error?: string }, seen = false) => {
      const ctx = ctxOf();
      const id = await start(ctx);
      if (seen) expect(await view(ctx, all(OLD, { web: svc('web', OLD, 'exited', '') }), T0 + 20_000, BEFORE)).toMatchObject({ phase: 'recreating' });
      await settleRedeploy(ctx, id, { ok: false, error: a.error ?? 'portainer', step: a.step, status: a.status }, T0 + 30_000);
      return (await view(ctx, null, T0 + 31_000, BEFORE))!;
    };
    expect(await at({ step: 'stack', status: 401 })).toMatchObject({ phase: 'failed', at: null, step: 'stack' });
    expect((await at({ step: 'stack_file', status: 500 })).at).toBeNull();
    expect((await at({ step: 'redeploy', status: 404 })).at).toBeNull(); // a 4xx: refused, nothing ran
    expect((await at({ step: 'webhook', status: 404, error: 'webhook_gone' })).at).toBeNull();
    // the redeploy call pulls and recreates before it answers: a fast 5xx failed in there, not at the request
    expect((await at({ step: 'redeploy', status: 500 })).at).toBe('pulling');
    expect((await at({ step: 'webhook', status: 502 })).at).toBe('pulling');
    expect((await at({ step: 'redeploy', status: null })).at).toBe('pulling');
    expect((await at({ step: 'redeploy', status: 500 }, true)).at).toBe('recreating');
    expect((await at({ step: 'deploy', status: null })).at).toBe('recreating');
    // not reachable: the request never got to Portainer
    expect((await at({ step: 'redeploy', status: null, error: 'portainer_unreachable' })).at).toBeNull();
  });

  it('a forced redeploy of the same build: a restart counts as the change, so it ends done (not unchanged or timeout) also without a listing', async () => {
    const kv = new MemoryKV();
    const id = (await claimRedeploy(ctxOf(OLD, kv, false), T0))!;
    expect(await beginRedeploy(ctxOf(OLD, kv, false), id, 'webhook', 'latest', false, T0, 3_000, true)).toBe(true);
    expect(JSON.parse((await kv.get(REDEPLOY_KEY))!)).toMatchObject({ v: 1, forced: true });
    expect(await view(ctxOf(OLD, kv, false), undefined, T0 + 5_000, BEFORE)).toMatchObject({ phase: 'pulling', running: true });
    // the same build answers again from a process younger than the redeploy: Portainer recreated it
    expect(await view(ctxOf(OLD, kv, false), undefined, T0 + 50_000, T0 + 40_000)).toMatchObject({ phase: 'done', running: false });
    // not forced: the same restart proves nothing (a crash, a reboot)
    const kv2 = new MemoryKV();
    await start(ctxOf(OLD, kv2, false), 'webhook', false);
    expect(await view(ctxOf(OLD, kv2, false), undefined, T0 + 50_000, T0 + 40_000)).toMatchObject({ phase: 'pulling' });
    // an older record without the field parses as before; a wrong type is not trusted
    const r = JSON.parse((await kv.get(REDEPLOY_KEY))!);
    await kv.set(REDEPLOY_KEY, JSON.stringify({ ...r, forced: 'yes' }), 60);
    expect(await view(ctxOf(OLD, kv), undefined)).toBeNull();
  });

  it('a forced redeploy with a services listing: done once the backend restarted and, on a later poll, every service runs healthy (web / gateway recreated between polls is not a timeout)', async () => {
    const kv = new MemoryKV();
    listed = all(OLD);
    const id = (await claimRedeploy(ctxOf(OLD, kv), T0))!;
    expect(await beginRedeploy(ctxOf(OLD, kv), id, 'api', 'latest', true, T0, 3_000, true)).toBe(true);
    const old = all(OLD);
    // before the backend restarted: nothing proves the reload yet
    expect(await view(ctxOf(OLD, kv), old, T0 + 10_000, BEFORE)).toMatchObject({ phase: 'pulling', running: true });
    // the first poll that sees the restarted backend only notes it: web and gateway may not be recreated yet
    expect(await view(ctxOf(OLD, kv), old, T0 + 30_000, T0 + 20_000)).toMatchObject({ phase: 'recreating', running: true });
    expect(JSON.parse((await kv.get(REDEPLOY_KEY))!).restarted).toEqual(['backend']);
    // a later poll with a service not healthy yet waits
    expect(await view(ctxOf(OLD, kv), all(OLD, { gateway: svc('gateway', OLD, 'running', 'starting') }), T0 + 35_000, T0 + 20_000)).toMatchObject({ phase: 'health', running: true });
    // web and gateway were recreated between two polls (never seen down): every service running and healthy ends it done
    const done = await view(ctxOf(OLD, kv), old, T0 + 40_000, T0 + 20_000);
    expect(done).toMatchObject({ phase: 'done', running: false });
    expect(await view(ctxOf(OLD, kv), old, T0 + REDEPLOY_TIMEOUT_MS + 1, T0 + 20_000)).toMatchObject({ phase: 'done' });
    // a stored list of anything but those services is not trusted
    const r = JSON.parse((await kv.get(REDEPLOY_KEY))!);
    await kv.set(REDEPLOY_KEY, JSON.stringify({ ...r, restarted: ['db'] }), 60);
    expect(await view(ctxOf(OLD, kv), old)).toBeNull();
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
    const v = await view(ctx, all(OLD), T0 + REDEPLOY_TIMEOUT_MS + 1, BEFORE);
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
    expect(await view(ctx, null)).toBeNull();
    expect(await claimRedeploy(ctx)).toMatch(/^[0-9a-f]{16}$/);
  });
});
