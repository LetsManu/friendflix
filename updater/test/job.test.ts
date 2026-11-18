// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { StepError, type ImageInfo } from '../src/docker.js';
import { JobLog, Updater, type Ops, type UpdaterOpts } from '../src/job.js';
import { DEFAULT_STATE, memoryStore, type Job, type State } from '../src/state.js';

const REPO = 'ghcr.io/letsmanu/friendflix';
const img = (svc: string) => `${REPO}-${svc === 'bootstrap' ? 'backend' : svc}`;
/** sha256 + 64 × one hex digit */
const dg = (c: string) => `sha256:${c.repeat(64)}`;
/** the service's image pinned to the digest of one hex digit */
const ref = (svc: string, c: string) => `${img(svc)}@${dg(c)}`;
const ALL = ['backend', 'gateway', 'web'] as const;

interface WorldOpts {
  /** `<service>:<tag>` -> the digest digit the registry answers; default: sha-aaaaaaa -> a, every other tag -> b */
  registry?: Record<string, string>;
  /** the digest digit each service runs before the job (null: not running); default a everywhere */
  running?: Record<string, string | null>;
  /** the image commit of a digest digit (null: a dev build); default the digit 40 times */
  commits?: Record<string, string | null>;
  /** refs cosign rejects */
  verifyFails?: string[];
  /** backend digest digits that never get healthy */
  unhealthy?: string[];
  /** refs no longer on the host (pruned) */
  pruned?: string[];
  registryDown?: boolean;
  pullFails?: boolean;
  spawnFails?: boolean;
}

/**
 * a fake Docker host and registry: the digest each service runs (with its container id), the images on the host, the local tags
 * compose runs; `up` recreates a service only when its local tag names another digest than it runs (as compose does)
 */
function world(o: WorldOpts = {}) {
  const calls: string[] = [];
  const runs: Record<string, string | null> = { backend: 'a', gateway: 'a', web: 'a', updater: 'a', ...o.running };
  let next = 1;
  const containers: Record<string, string> = Object.fromEntries(Object.keys(runs).map((s) => [s, String(next++).repeat(64)]));
  // both builds are on the host (a: the one before, b: the last pulled); anything else only once pulled
  const local = new Set(['backend', 'gateway', 'web', 'updater', 'livetv'].flatMap((s) => [ref(s, 'a'), ref(s, 'b')]));
  for (const r of o.pruned ?? []) local.delete(r);
  const tags = new Map<string, string>();
  const digit = (r: string) => r.slice(-1);
  const commitOf = (c: string) => (o.commits && c in o.commits ? o.commits[c]! : c.repeat(40));
  const info = (svc: string, c: string): ImageInfo => ({ repoDigests: [ref(svc, c)], commit: commitOf(c), version: '1.0.0' });
  const ops: Ops = {
    images: async (tag, services) => { calls.push(`images ${tag} ${services.join(',')}`); return Object.fromEntries(services.map((s) => [s, `${img(s)}:${tag}`])); },
    registryDigest: async (svc, tag) => {
      calls.push(`registry ${svc} ${tag}`);
      if (o.registryDown) throw new StepError('registry_failed');
      return dg(o.registry?.[`${svc}:${tag}`] ?? (tag === 'sha-aaaaaaa' ? 'a' : 'b'));
    },
    pullDigest: async (r) => { calls.push(`pull ${r}`); if (o.pullFails) throw new StepError('pull_failed'); local.add(r); },
    tag: async (r, image) => { calls.push(`tag ${r} ${image}`); if (!local.has(r)) throw new StepError('tag_failed'); tags.set(image, r); },
    verify: async (r) => { calls.push(`verify ${r}`); return !o.verifyFails?.includes(r); },
    up: async (tag, services) => {
      calls.push(`up ${tag} ${services.join(',')}`);
      for (const s of services.filter((x) => x !== 'bootstrap')) {
        const r = tags.get(`${img(s)}:${tag}`);
        if (!r) throw new StepError('restart_failed');
        if (runs[s] !== digit(r)) { runs[s] = digit(r); containers[s] = String(next++).repeat(64); calls.push(`recreate ${s}`); }
      }
    },
    imageInfo: async (r) => {
      const svc = ['backend', 'gateway', 'web', 'updater', 'livetv'].find((s) => r.startsWith(`${img(s)}@`));
      return svc && local.has(r) ? info(svc, digit(r)) : null;
    },
    running: async (svc) => (runs[svc] ? { ...info(svc, runs[svc]!), container: containers[svc]! } : null),
    spawnSelfUpdate: async (tag) => { calls.push(`spawn ${tag}`); if (o.spawnFails) throw new StepError('restart_failed'); },
    healthy: async (commit7) => {
      calls.push(`health ${commit7}`);
      const c = runs.backend;
      return !!c && !o.unhealthy?.includes(c) && (commit7 === null || commit7 === commitOf(c)?.slice(0, 7));
    },
    ownStack: async () => {}, stop: async () => {}, rm: async () => {}, imageRm: async () => {}, volumeRm: async () => {}, livetvContainer: async () => null, livetvNetwork: async () => {},
  };
  return { ops, calls, runs, containers, tags, local };
}
type World = ReturnType<typeof world>;
function make(w: World, init: Partial<State> = {}, opts: UpdaterOpts = {}) {
  let t = 1_760_800_000_000;
  const store = memoryStore({ ...DEFAULT_STATE, ...init });
  const u = new Updater(w.ops, store, { healthTimeoutMs: 20_000, healthIntervalMs: 5_000, selfUpdateTimeoutMs: 1000, now: () => t, sleep: async (ms) => { t += ms; }, ...opts });
  return { u, store };
}
/** the calls that change the host (pull, tag, recreate, the helper) and cosign */
const changing = (w: World) => w.calls.filter((c) => /^(pull|verify|tag|up|recreate|spawn) /.test(c));
const PREV = { backend: ref('backend', 'a'), gateway: ref('gateway', 'a'), web: ref('web', 'a') };

describe('update job', () => {
  it('nothing changed: no pull, verify or restart; every service unchanged', async () => {
    const w = world({ registry: { 'backend:latest': 'a', 'gateway:latest': 'a', 'web:latest': 'a' } });
    const { u, store } = make(w, { current: 'latest', previous: 'sha-1234567' });
    const r = u.start('update');
    expect(r.ok).toBe(true);
    expect(u.busy).toBe(true);
    await u.idle();
    // every registry digest is read; nothing else moves
    expect(w.calls).toEqual(['images latest bootstrap,backend,gateway,web', 'registry backend latest', 'registry gateway latest', 'registry web latest']);
    expect(store.state.lastJob).toMatchObject({ action: 'update', state: 'succeeded', error: null, step: null, from: 'sha-aaaaaaa', to: 'latest',
      steps: { pull: 'ok', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' },
      services: { backend: 'unchanged', gateway: 'unchanged', web: 'unchanged' } });
    // the state is untouched (no new rollback target)
    expect(store.state).toMatchObject({ current: 'latest', previous: 'sha-1234567', previousDigests: null });
    expect(u.log.tail().some((l) => l.endsWith('all services unchanged'))).toBe(true);
    expect(u.busy).toBe(false);
  });

  it('only web changed: web pulled and verified by digest, re-tagged, up; web updated, the rest unchanged; health without a commit check', async () => {
    const w = world({ registry: { 'backend:latest': 'a', 'gateway:latest': 'a', 'web:latest': 'c' } });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(changing(w)).toEqual([
      `pull ${ref('web', 'c')}`,
      `verify ${ref('web', 'c')}`,
      // every local tag names the compared digest before `up` (an unchanged one its own); compose recreates web alone
      `tag ${ref('backend', 'a')} ${img('backend')}:latest`, `tag ${ref('gateway', 'a')} ${img('gateway')}:latest`, `tag ${ref('web', 'c')} ${img('web')}:latest`,
      'up latest bootstrap,backend,gateway,web', 'recreate web',
    ]);
    expect(w.calls.filter((c) => c.startsWith('health'))).toEqual(['health null']);
    expect(store.state.lastJob).toMatchObject({ state: 'succeeded', steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' },
      services: { backend: 'unchanged', gateway: 'unchanged', web: 'updated' } });
    // the rollback target: what every service ran before (the legacy sha tag is gone)
    expect(store.state).toMatchObject({ current: 'latest', previous: null, previousDigests: PREV });
  });

  it('backend changed: health waits for the new backend commit7 (FF_IMAGE_COMMIT; GIT_SHA for an old image)', async () => {
    // the image commit of the new backend image (docker.ts reads FF_IMAGE_COMMIT, else GIT_SHA) is what /health must answer
    const w = world({ registry: { 'backend:latest': 'c', 'gateway:latest': 'a', 'web:latest': 'a' }, commits: { c: '1'.repeat(40) } });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(changing(w)).toEqual([
      `pull ${ref('backend', 'c')}`, `verify ${ref('backend', 'c')}`,
      `tag ${ref('backend', 'c')} ${img('backend')}:latest`, `tag ${ref('gateway', 'a')} ${img('gateway')}:latest`, `tag ${ref('web', 'a')} ${img('web')}:latest`,
      'up latest bootstrap,backend,gateway,web', 'recreate backend',
    ]);
    expect(w.calls.filter((c) => c.startsWith('health'))).toEqual(['health 1111111']);
    expect(store.state.lastJob).toMatchObject({ state: 'succeeded', services: { backend: 'updated', gateway: 'unchanged', web: 'unchanged' } });
    // a new backend without an image commit (a dev build): container health only
    const d = world({ registry: { 'backend:latest': 'c', 'gateway:latest': 'a', 'web:latest': 'a' }, commits: { c: null } });
    const dev = make(d);
    dev.u.start('update');
    await dev.u.idle();
    expect(d.calls.filter((c) => c.startsWith('health'))).toEqual(['health null']);
    expect(dev.store.state.lastJob).toMatchObject({ state: 'succeeded' });
  });

  it('a backend that does not answer with the new commit, or a changed service not on its target, is not healthy yet', async () => {
    // the backend still answers with the old commit: rolled back after the health budget
    const w = world({ registry: { 'backend:latest': 'c', 'gateway:latest': 'a', 'web:latest': 'a' } });
    w.ops.healthy = async (commit7) => { w.calls.push(`health ${commit7}`); return commit7 === null || commit7 === 'aaaaaaa'; };
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy' });
    // web was recreated but still runs the old digest (compose kept it): not healthy
    const k = world({ registry: { 'backend:latest': 'a', 'gateway:latest': 'a', 'web:latest': 'c' } });
    const up = k.ops.up;
    k.ops.up = async (tag, services) => { await up(tag, services); if (tag === 'latest' && k.runs.web === 'c') k.runs.web = 'a'; };
    const m = make(k);
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy' });
  });

  it('one verify failure re-tags and restarts nothing', async () => {
    const w = world({ verifyFails: [ref('gateway', 'b')] });
    const { u, store } = make(w, { previous: 'sha-1234567' });
    u.start('update');
    await u.idle();
    expect(changing(w)).toEqual([
      ...ALL.map((s) => `pull ${ref(s, 'b')}`),
      `verify ${ref('backend', 'b')}`, `verify ${ref('gateway', 'b')}`,
    ]);
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'verify_failed', step: 'verify', steps: { pull: 'ok', verify: 'failed', restart: 'skipped', health: 'skipped' }, services: null });
    // nothing was recorded either
    expect(store.state).toMatchObject({ previous: 'sha-1234567', previousDigests: null });
    expect(u.log.tail().some((l) => l.endsWith(`signature check failed for ${ref('gateway', 'b')}`))).toBe(true);
  });

  it('registry_failed before any pull', async () => {
    const w = world({ registryDown: true });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(changing(w)).toEqual([]);
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'registry_failed', steps: { pull: 'failed', verify: 'skipped', restart: 'skipped', health: 'skipped' } });
    // one service's lookup failing stops the others' pulls too (every digest is read before the first pull)
    const one = world();
    const reg = one.ops.registryDigest;
    one.ops.registryDigest = async (svc, tag) => { if (svc === 'web') throw new StepError('registry_failed'); return reg(svc, tag); };
    const m = make(one);
    m.u.start('update');
    await m.u.idle();
    expect(changing(one)).toEqual([]);
    expect(m.store.state.lastJob).toMatchObject({ state: 'failed', error: 'registry_failed' });
    // the job log carries the code only
    expect(m.u.log.tail().join('\n')).not.toMatch(/token|bearer/i);
  });

  it('logs the compose files the job uses; a media server mismatch fails the job before anything is pulled', async () => {
    const w = world();
    const { u } = make({ ...w, ops: { ...w.ops, composeFiles: () => ['compose.prod.yaml', 'compose.plex.yaml'] } });
    u.start('update');
    await u.idle();
    expect(u.log.tail().some((l) => l.endsWith('compose files: compose.prod.yaml, compose.plex.yaml'))).toBe(true);
    const m = world();
    const { u: u2, store } = make({ ...m, ops: { ...m.ops, images: async () => { throw new StepError('media_server_mismatch'); } } });
    u2.start('update');
    await u2.idle();
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'media_server_mismatch', steps: { pull: 'failed', restart: 'skipped' } });
    expect(m.calls.filter((c) => c.startsWith('registry') || c.startsWith('pull') || c.startsWith('up'))).toEqual([]);
  });

  it('a foreign stack or changed ports / networks fail the job before anything is pulled; the log says why', async () => {
    for (const [code, detail] of [['foreign_stack', 'portainer'], ['config_mismatch', 'web ports']] as const) {
      const m = world();
      const { u, store } = make({ ...m, ops: { ...m.ops, images: async () => { throw new StepError(code, detail); } } });
      u.start('update');
      await u.idle();
      expect(store.state.lastJob).toMatchObject({ state: 'failed', error: code, steps: { pull: 'failed', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' } });
      expect(m.calls.filter((c) => c.startsWith('pull') || c.startsWith('up'))).toEqual([]);
      expect(u.log.tail().some((l) => l.endsWith(`step pull: ${code} (${detail})`))).toBe(true);
      // the self-update too: no helper is spawned
      const s = world();
      const { u: u2, store: st2 } = make({ ...s, ops: { ...s.ops, images: async () => { throw new StepError(code); } } });
      u2.start('self-update');
      await u2.idle();
      expect(st2.state.lastJob).toMatchObject({ action: 'self-update', state: 'failed', error: code });
      expect(s.calls.filter((c) => c.startsWith('spawn') || c.startsWith('pull'))).toEqual([]);
    }
  });

  it('a pull failure aborts too', async () => {
    const w = world({ pullFails: true });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(w.calls.some((c) => c.startsWith('up ') || c.startsWith('verify') || c.startsWith('tag'))).toBe(false);
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'pull_failed', steps: { pull: 'failed', verify: 'skipped' } });
  });

  it('unhealthy: previous digests re-tagged, only changed services recreated, rolled_back', async () => {
    // gateway and web changed; the new build never gets healthy
    const w = world({ registry: { 'backend:latest': 'a', 'gateway:latest': 'b', 'web:latest': 'b' }, unhealthy: ['a'] });
    const { u, store } = make(w);
    // healthy once the old gateway and web run again
    w.ops.healthy = async (commit7) => { w.calls.push(`health ${commit7}`); return w.runs.gateway === 'a' && w.runs.web === 'a'; };
    u.start('update');
    await u.idle();
    const after = w.calls.slice(w.calls.indexOf('recreate web') + 1);
    expect(after.filter((c) => c === 'health null').length).toBe(6); // 20 s / 5 s + the first round, then the rollback's
    expect(changing({ ...w, calls: after })).toEqual([
      // nothing was pruned: no pull, no verify; every local tag back to what ran before; compose recreates the two that moved
      ...ALL.map((s) => `tag ${ref(s, 'a')} ${img(s)}:latest`),
      'up latest bootstrap,backend,gateway,web', 'recreate gateway', 'recreate web',
    ]);
    expect(store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy', steps: { restart: 'ok', health: 'failed', rollback: 'ok' }, services: null });
    // the services run PREV again: the rollback target stays what it was before the update (none here)
    expect(store.state.previousDigests).toBeNull();
    expect(w.runs).toMatchObject({ backend: 'a', gateway: 'a', web: 'a' });
    expect(u.log.tail().some((l) => l.endsWith('rolling back to the previous digests'))).toBe(true);
  });

  it('an update that rolls back leaves the earlier rollback target in place: a manual rollback still goes there', async () => {
    // the stack runs a; the rollback target from an earlier update is z (digit c); the update to b never gets healthy
    const Z = { backend: ref('backend', 'c'), gateway: ref('gateway', 'c'), web: ref('web', 'c') };
    const w = world({ unhealthy: ['b'] });
    const { u, store } = make(w, { previousDigests: Z, previous: null });
    const seen: Array<State['previousDigests']> = [];
    const up = w.ops.up;
    w.ops.up = async (tag, services) => { seen.push(structuredClone(store.state.previousDigests)); return up(tag, services); };
    u.start('update');
    await u.idle();
    expect(store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy' });
    // while it restarted, the state named what ran before it (a crash there must find a target); afterwards z again
    expect(seen[0]).toEqual(PREV);
    expect(store.state).toMatchObject({ previousDigests: Z, previous: null });
    w.calls.length = 0;
    u.start('rollback');
    await u.idle();
    expect(store.state.lastJob).toMatchObject({ action: 'rollback', state: 'succeeded' });
    expect(w.runs).toMatchObject({ backend: 'c', gateway: 'c', web: 'c' });
    expect(store.state.previousDigests).toEqual(PREV);
    // a legacy sha previous comes back the same way
    const l = world({ unhealthy: ['b'] });
    const m = make(l, { previous: 'sha-1234567' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ previous: 'sha-1234567', previousDigests: null, lastJob: { state: 'rolled_back' } });
  });

  it('the automatic rollback checks the previous backend commit, pulls a pruned previous image by digest and verifies it first', async () => {
    const w = world({ unhealthy: ['b'], pruned: [ref('web', 'a')] });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    const back = w.calls.slice(w.calls.lastIndexOf('health bbbbbbb') + 1);
    expect(changing({ ...w, calls: back })).toEqual([
      `pull ${ref('web', 'a')}`, `verify ${ref('web', 'a')}`,
      ...ALL.map((s) => `tag ${ref(s, 'a')} ${img(s)}:latest`),
      'up latest bootstrap,backend,gateway,web', 'recreate backend', 'recreate gateway', 'recreate web',
    ]);
    expect(back.filter((c) => c.startsWith('health'))).toEqual(['health aaaaaaa']);
    expect(store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy' });
    // a pruned previous image that does not verify: the rollback fails, the bad image is never tagged
    const v = world({ unhealthy: ['b'], pruned: [ref('web', 'a')], verifyFails: [ref('web', 'a')] });
    const m = make(v);
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state.lastJob).toMatchObject({ state: 'failed', error: 'rollback_failed', steps: { rollback: 'failed' } });
    expect(v.calls.filter((c) => c.startsWith(`tag ${ref('web', 'a')}`))).toEqual([]);
  });

  it('a failed restart rolls back as well; a failed rollback is reported as such', async () => {
    const w1 = world();
    const a = make(w1);
    w1.ops.up = (() => { const up = w1.ops.up; let n = 0; return async (tag: string, s: readonly string[]) => { if (n++ === 0) throw new StepError('restart_failed'); return up(tag, s); }; })();
    a.u.start('update');
    await a.u.idle();
    expect(a.store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'restart_failed', steps: { restart: 'failed', health: 'skipped', rollback: 'ok' } });

    const w2 = world({ unhealthy: ['a', 'b'] });
    const b = make(w2);
    b.u.start('update');
    await b.u.idle();
    expect(b.store.state.lastJob).toMatchObject({ state: 'failed', error: 'rollback_failed', steps: { rollback: 'failed' } });
  });

  it('without a known previous build (dev images, nothing running) an unhealthy update just fails', async () => {
    const w = world({ unhealthy: ['b'], running: { backend: null, gateway: null, web: null } });
    const { u, store } = make(w);
    u.start('update');
    await u.idle();
    expect(store.state.lastJob).toMatchObject({ state: 'failed', error: 'unhealthy', from: null, steps: { rollback: 'skipped' } });
    expect(store.state.previousDigests).toBeNull();
    expect(w.calls.filter((c) => c.startsWith('up ')).length).toBe(1);
  });

  it('one job at a time', async () => {
    const { u } = make(world());
    expect(u.start('update').ok).toBe(true);
    expect(u.start('update')).toEqual({ ok: false, error: 'busy' });
    expect(u.start('rollback')).toEqual({ ok: false, error: 'busy' });
    await u.idle();
    expect(u.start('update').ok).toBe(true);
    await u.idle();
  });

  it('the channel decides the tag; pinned needs a version', async () => {
    const w = world();
    const { u, store } = make(w);
    u.setChannel('nightly', null);
    u.start('update');
    await u.idle();
    expect(w.calls[0]).toBe('images nightly bootstrap,backend,gateway,web');
    u.setChannel('pinned', '1.2.3');
    expect(store.state).toMatchObject({ channel: 'pinned', version: '1.2.3' });
    u.start('update');
    await u.idle();
    expect(w.calls).toContain('registry backend 1.2.3');
    u.setChannel('stable', '9.9.9');
    expect(store.state.version).toBeNull();
    expect(make(world(), { channel: 'pinned', version: null }).u.start('update')).toEqual({ ok: false, error: 'no_target' });
  });

  it('after a channel switch the update compares and tags under the new channel tag', async () => {
    // nightly: web moved, backend and gateway are the same digests as the stack runs (from latest)
    const w = world({ registry: { 'backend:nightly': 'a', 'gateway:nightly': 'a', 'web:nightly': 'c' } });
    const { u, store } = make(w, { current: 'latest' });
    u.setChannel('nightly', null);
    u.start('update');
    await u.idle();
    expect(w.calls.filter((c) => c.startsWith('registry'))).toEqual(ALL.map((s) => `registry ${s} nightly`));
    // every service gets its nightly tag (compose runs <image>:nightly from now on), web the new digest. The fake recreates by
    // digest only; real compose may also recreate the others once, since their image string changes (latest -> nightly)
    expect(changing(w)).toEqual([
      `pull ${ref('web', 'c')}`, `verify ${ref('web', 'c')}`,
      `tag ${ref('backend', 'a')} ${img('backend')}:nightly`, `tag ${ref('gateway', 'a')} ${img('gateway')}:nightly`, `tag ${ref('web', 'c')} ${img('web')}:nightly`,
      'up nightly bootstrap,backend,gateway,web', 'recreate web',
    ]);
    expect(store.state).toMatchObject({ current: 'nightly', lastJob: { to: 'nightly', state: 'succeeded' } });
  });

  it('manual rollback by digests; a pruned previous image is pulled by digest and verified first', async () => {
    expect(make(world()).u.start('rollback')).toEqual({ ok: false, error: 'no_previous' });
    expect(make(world(), { previous: 'latest' as never }).u.start('rollback')).toEqual({ ok: false, error: 'no_previous' });
    // the stack runs b everywhere; gateway's previous image was pruned
    const w = world({ running: { backend: 'b', gateway: 'b', web: 'b' }, pruned: [ref('gateway', 'a')] });
    const { u, store } = make(w, { channel: 'nightly', current: 'nightly', previousDigests: { ...PREV, web: ref('web', 'b') }, previous: null });
    const r = u.start('rollback');
    expect(r).toMatchObject({ ok: true, job: { action: 'rollback', to: 'nightly' } });
    await u.idle();
    expect(w.calls.some((c) => c.startsWith('registry'))).toBe(false);
    expect(changing(w)).toEqual([
      `pull ${ref('gateway', 'a')}`, `verify ${ref('gateway', 'a')}`,
      `tag ${ref('backend', 'a')} ${img('backend')}:nightly`, `tag ${ref('gateway', 'a')} ${img('gateway')}:nightly`, `tag ${ref('web', 'b')} ${img('web')}:nightly`,
      'up nightly bootstrap,backend,gateway,web', 'recreate backend', 'recreate gateway',
    ]);
    // the backend moved: its previous commit is checked
    expect(w.calls.filter((c) => c.startsWith('health'))).toEqual(['health aaaaaaa']);
    expect(store.state.lastJob).toMatchObject({ action: 'rollback', state: 'succeeded', from: 'sha-bbbbbbb', to: 'nightly',
      steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' }, services: { backend: 'updated', gateway: 'updated', web: 'unchanged' } });
    // the digests it left are the next rollback target
    expect(store.state).toMatchObject({ current: 'nightly', previous: null, previousDigests: { backend: ref('backend', 'b'), gateway: ref('gateway', 'b'), web: ref('web', 'b') } });
  });

  it('a manual rollback whose pruned image does not verify, or that does not get healthy, is not rolled back again', async () => {
    const v = world({ running: { backend: 'b', gateway: 'b', web: 'b' }, pruned: [ref('web', 'a')], verifyFails: [ref('web', 'a')] });
    const a = make(v, { previousDigests: PREV });
    a.u.start('rollback');
    await a.u.idle();
    expect(a.store.state.lastJob).toMatchObject({ state: 'failed', error: 'verify_failed', steps: { verify: 'failed', restart: 'skipped' } });
    expect(v.calls.some((c) => c.startsWith('tag') || c.startsWith('up'))).toBe(false);
    const w = world({ running: { backend: 'b', gateway: 'b', web: 'b' }, unhealthy: ['a'] });
    const b = make(w, { previousDigests: PREV });
    b.u.start('rollback');
    await b.u.idle();
    expect(b.store.state.lastJob).toMatchObject({ state: 'failed', error: 'unhealthy', steps: { rollback: 'skipped' } });
    expect(w.calls.filter((c) => c.startsWith('up ')).length).toBe(1);
    expect(b.store.state.previousDigests).toEqual(PREV);
    // a recorded ref of another repository is refused before anything moves
    const x = world({ running: { backend: 'b', gateway: 'b', web: 'b' } });
    const c = make(x, { previousDigests: { ...PREV, web: `ghcr.io/evil/friendflix-web@${dg('a')}` } });
    c.u.start('rollback');
    await c.u.idle();
    expect(c.store.state.lastJob).toMatchObject({ state: 'failed', error: 'unexpected_image' });
    expect(changing(x)).toEqual([]);
  });

  it('legacy sha previous rolls back with that tag', async () => {
    // a state file from before digests: previous = sha-<7>; that tag's digests (a) are compared and installed like an update
    const w = world({ running: { backend: 'b', gateway: 'b', web: 'b' } });
    const { u, store } = make(w, { previous: 'sha-aaaaaaa', current: 'latest' });
    u.start('rollback');
    await u.idle();
    expect(w.calls.filter((c) => c.startsWith('registry'))).toEqual(ALL.map((s) => `registry ${s} sha-aaaaaaa`));
    expect(changing(w)).toEqual([
      ...ALL.map((s) => `pull ${ref(s, 'a')}`), ...ALL.map((s) => `verify ${ref(s, 'a')}`),
      ...ALL.map((s) => `tag ${ref(s, 'a')} ${img(s)}:sha-aaaaaaa`),
      'up sha-aaaaaaa bootstrap,backend,gateway,web', 'recreate backend', 'recreate gateway', 'recreate web',
    ]);
    expect(store.state.lastJob).toMatchObject({ action: 'rollback', state: 'succeeded', from: 'sha-bbbbbbb', to: 'sha-aaaaaaa' });
    // from now on the digests it left are the rollback target
    expect(store.state).toMatchObject({ current: 'sha-aaaaaaa', previous: null, previousDigests: { backend: ref('backend', 'b'), gateway: ref('gateway', 'b'), web: ref('web', 'b') } });
    // an unhealthy one is not rolled back again
    const k = world({ running: { backend: 'b', gateway: 'b', web: 'b' }, unhealthy: ['a'] });
    const m = make(k, { previous: 'sha-aaaaaaa' });
    m.u.start('rollback');
    await m.u.idle();
    expect(m.store.state.lastJob).toMatchObject({ state: 'failed', error: 'unhealthy', steps: { rollback: 'skipped' } });
    expect(k.calls.filter((c) => c.startsWith('up ')).length).toBe(1);
  });

  it('self-update: same digest → no pull, no restart; new digest → pull, verify, tag, helper', async () => {
    const same = world({ registry: { 'updater:latest': 'a' } });
    const a = make(same);
    a.u.start('self-update');
    await a.u.idle();
    expect(same.calls).toEqual(['images latest updater', 'registry updater latest']);
    expect(a.store.state.lastJob).toMatchObject({ action: 'self-update', state: 'succeeded', error: null, steps: { pull: 'ok', verify: 'skipped', restart: 'skipped', health: 'skipped' } });
    expect(a.u.log.tail().some((l) => l.endsWith('the updater already runs this image'))).toBe(true);

    const w = world();
    const { u, store } = make(w);
    u.start('self-update');
    await u.idle();
    expect(changing(w)).toEqual([`pull ${ref('updater', 'b')}`, `verify ${ref('updater', 'b')}`, `tag ${ref('updater', 'b')} ${img('updater')}:latest`, 'spawn latest']);
    // still alive after the timeout: the helper did not replace us
    expect(store.state.lastJob).toMatchObject({ action: 'self-update', state: 'failed', error: 'self_update_timeout' });
    // the helper recreated the container: the new process finds the job at its restart step
    const s2 = memoryStore({ ...DEFAULT_STATE, lastJob: { ...store.state.lastJob!, state: 'running', step: 'restart', error: null, finishedAt: null } });
    const u2 = new Updater(w.ops, s2, { log: new JobLog() });
    expect(u2.snapshot().lastJob).toMatchObject({ state: 'succeeded', steps: { restart: 'ok' } });
  });

  it('self-update with a failing registry, verify or helper never spawns / reports the failure', async () => {
    const r = world({ registryDown: true });
    const x = make(r);
    x.u.start('self-update');
    await x.u.idle();
    expect(changing(r)).toEqual([]);
    expect(x.store.state.lastJob).toMatchObject({ state: 'failed', error: 'registry_failed' });
    const w = world({ verifyFails: [ref('updater', 'b')] });
    const a = make(w);
    a.u.start('self-update');
    await a.u.idle();
    expect(w.calls.some((c) => c.startsWith('spawn') || c.startsWith('tag'))).toBe(false);
    expect(a.store.state.lastJob).toMatchObject({ state: 'failed', error: 'verify_failed' });
    const b = make(world({ spawnFails: true }));
    b.u.start('self-update');
    await b.u.idle();
    expect(b.store.state.lastJob).toMatchObject({ state: 'failed', error: 'restart_failed' });
  });

  it('the media phase runs after a healthy update and never in a rollback', async () => {
    const phase = (w: World, answer: () => Promise<'ok' | 'unhealthy' | null>) => async (job: Job) => {
      // the core services are healthy and recorded before the phase starts
      w.calls.push(`media phase ${job.action} ${job.state}`);
      return answer();
    };
    const w = world();
    const { u, store } = make(w, {}, { mediaPhase: phase(w, async () => 'ok') });
    u.start('update');
    await u.idle();
    expect(w.calls.slice(-2)).toEqual(['health bbbbbbb', 'media phase update running']);
    expect(w.calls.filter((c) => c.startsWith('media phase'))).toHaveLength(1);
    expect(store.state.lastJob).toMatchObject({ state: 'succeeded', error: null });

    // nothing to do for the media server: an ordinary success
    const n = world();
    const nothing = make(n, {}, { mediaPhase: phase(n, async () => null) });
    nothing.u.start('update');
    await nothing.u.idle();
    expect(nothing.store.state.lastJob).toMatchObject({ state: 'succeeded', error: null });

    // an update that rolls back never reaches the media server
    const r = world({ unhealthy: ['b'] });
    const back = make(r, {}, { mediaPhase: phase(r, async () => 'ok') });
    back.u.start('update');
    await back.u.idle();
    expect(back.store.state.lastJob).toMatchObject({ state: 'rolled_back' });
    expect(r.calls.some((c) => c.startsWith('media phase'))).toBe(false);

    // neither does a FriendFlix rollback (the media server is never moved down)
    const rb = world({ running: { backend: 'b', gateway: 'b', web: 'b' } });
    const rollback = make(rb, { previousDigests: PREV, current: 'latest' }, { mediaPhase: phase(rb, async () => 'ok') });
    rollback.u.start('rollback');
    await rollback.u.idle();
    expect(rollback.store.state.lastJob).toMatchObject({ action: 'rollback', state: 'succeeded' });
    expect(rb.calls.some((c) => c.startsWith('media phase'))).toBe(false);

    // a failed media phase: FriendFlix stays on the new build, the job says the media server failed
    const f = world();
    const failed = make(f, {}, { mediaPhase: phase(f, async () => 'unhealthy') });
    failed.u.start('update');
    await failed.u.idle();
    expect(failed.store.state.lastJob).toMatchObject({ action: 'update', state: 'succeeded_mediaserver_failed', error: 'unhealthy', steps: { health: 'ok', rollback: 'skipped' } });
    expect(failed.store.state.current).toBe('latest');
    expect(failed.store.state.previousDigests).toEqual(PREV);
    expect(failed.u.log.tail().some((l) => l.endsWith('update succeeded_mediaserver_failed (unhealthy)'))).toBe(true);

    // a phase that throws is a media failure too, never a FriendFlix one
    const x = world();
    const thrown = make(x, {}, { mediaPhase: async () => { throw new Error('boom'); } });
    thrown.u.start('update');
    await thrown.u.idle();
    expect(thrown.store.state.lastJob).toMatchObject({ state: 'succeeded_mediaserver_failed', error: 'helper_failed' });
    expect(thrown.store.state.current).toBe('latest');
  });

  it('nothing changed → media phase still called once (a template change can still need it)', async () => {
    const seen: Job[] = [];
    const w = world({ registry: { 'backend:latest': 'a', 'gateway:latest': 'a', 'web:latest': 'a' } });
    const { u, store } = make(w, {}, { mediaPhase: async (job) => { seen.push(structuredClone(job)); return 'ok'; } });
    u.start('update');
    await u.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: 'update', state: 'running', steps: { pull: 'ok', verify: 'skipped', restart: 'skipped', health: 'skipped' },
      services: { backend: 'unchanged', gateway: 'unchanged', web: 'unchanged' } });
    expect(store.state.lastJob).toMatchObject({ state: 'succeeded', error: null });
    expect(changing(w)).toEqual([]);
    // its failure: FriendFlix is untouched, the job says the media server failed
    const f = world({ registry: { 'backend:latest': 'a', 'gateway:latest': 'a', 'web:latest': 'a' } });
    const failed = make(f, {}, { mediaPhase: async () => 'unhealthy' });
    failed.u.start('update');
    await failed.u.idle();
    expect(failed.store.state.lastJob).toMatchObject({ state: 'succeeded_mediaserver_failed', error: 'unhealthy' });
    // a rollback that changes nothing never runs it
    let n = 0;
    const r = world();
    const back = make(r, { previousDigests: PREV }, { mediaPhase: async () => { n++; return 'ok'; } });
    back.u.start('rollback');
    await back.u.idle();
    expect(back.store.state.lastJob).toMatchObject({ action: 'rollback', state: 'succeeded', services: { backend: 'unchanged' } });
    expect(n).toBe(0);
  });

  it('an update interrupted in its media phase keeps FriendFlix updated', () => {
    const steps = { pull: 'ok' as const, verify: 'ok' as const, restart: 'ok' as const, health: 'ok' as const, rollback: 'skipped' as const };
    const media = { step: 'create' as const, steps: { check: 'ok' as const, pull: 'ok' as const, verify: 'ok' as const, snapshot: 'skipped' as const, create: 'running' as const, start: 'pending' as const, health: 'pending' as const, rollback: 'pending' as const } };
    const job: Job = { id: '0123456789abcdef', action: 'update', state: 'running', step: 'health', from: null, to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null, steps, services: null, media };
    const s = memoryStore({ ...DEFAULT_STATE, lastJob: job });
    new Updater(world().ops, s);
    expect(s.state.lastJob).toMatchObject({ state: 'succeeded_mediaserver_failed', error: 'interrupted', steps: { health: 'ok' }, media: { steps: { create: 'failed' } } });
  });

  it('an update interrupted in its media phase before the phase recorded a step keeps FriendFlix updated', () => {
    const steps = { pull: 'ok' as const, verify: 'ok' as const, restart: 'ok' as const, health: 'ok' as const, rollback: 'skipped' as const };
    const job: Job = { id: '0123456789abcdef', action: 'update', state: 'running', step: 'health', from: null, to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null, steps, services: null, media: null };
    const s = memoryStore({ ...DEFAULT_STATE, current: 'latest', lastJob: job });
    new Updater(world().ops, s);
    expect(s.state.lastJob).toMatchObject({ state: 'succeeded_mediaserver_failed', error: 'interrupted', steps: { health: 'ok' }, media: null });
    // an update that found nothing changed and was in its media phase: FriendFlix is untouched, not a failed update
    const unchanged = { pull: 'ok' as const, verify: 'skipped' as const, restart: 'skipped' as const, health: 'skipped' as const, rollback: 'skipped' as const };
    const same = memoryStore({ ...DEFAULT_STATE, lastJob: { ...job, step: 'pull', steps: unchanged, services: { backend: 'unchanged', gateway: 'unchanged', web: 'unchanged' } } });
    new Updater(world().ops, same);
    expect(same.state.lastJob).toMatchObject({ state: 'succeeded_mediaserver_failed', error: 'interrupted' });
    // one interrupted in its pull step is failed
    const pulling = memoryStore({ ...DEFAULT_STATE, lastJob: { ...job, step: 'pull', steps: { ...steps, pull: 'running', verify: 'pending', restart: 'pending', health: 'pending' } } });
    new Updater(world().ops, pulling);
    expect(pulling.state.lastJob).toMatchObject({ state: 'failed', error: 'interrupted', steps: { pull: 'failed' } });
    // a rollback that had started is not an update that succeeded
    const back = memoryStore({ ...DEFAULT_STATE, lastJob: { ...job, step: 'rollback', steps: { ...steps, rollback: 'running' } } });
    new Updater(world().ops, back);
    expect(back.state.lastJob).toMatchObject({ state: 'failed', error: 'interrupted', steps: { rollback: 'failed' } });
  });

  it('a job interrupted by a restart is marked failed', () => {
    const job = { id: '0123456789abcdef', action: 'update' as const, state: 'running' as const, step: 'health' as const, from: null, to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'ok' as const, verify: 'ok' as const, restart: 'ok' as const, health: 'running' as const, rollback: 'skipped' as const }, services: null, media: null };
    const s = memoryStore({ ...DEFAULT_STATE, lastJob: job });
    new Updater(world().ops, s);
    expect(s.state.lastJob).toMatchObject({ state: 'failed', error: 'interrupted', steps: { health: 'failed' } });
  });

  it('a state file that cannot be written does not stop the job', async () => {
    const w = world();
    const u = new Updater(w.ops, { load: () => ({ ...DEFAULT_STATE }), save: () => { throw new Error('read-only'); } }, { sleep: async () => {} });
    u.start('update');
    await u.idle();
    expect(u.snapshot().lastJob?.state).toBe('succeeded');
    expect(u.log.tail().some((l) => l.includes('state file could not be written'))).toBe(true);
  });

  it('the log keeps the last lines only', () => {
    const l = new JobLog(3, () => 0);
    for (const m of ['a', 'b', 'c', 'd']) l.add(m);
    expect(l.tail()).toEqual(['1970-01-01T00:00:00.000Z b', '1970-01-01T00:00:00.000Z c', '1970-01-01T00:00:00.000Z d']);
  });
});
