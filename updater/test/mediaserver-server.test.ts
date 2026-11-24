// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ops, StartResult } from '../src/job.js';
import { Updater } from '../src/job.js';
import type { MediaOp } from '../src/mediaserver/types.js';
import { parseMediaBody } from '../src/mediaserver/parse.js';
import { MediaService } from '../src/mediaserver/service.js';
import { STARTING_VIEW, mediaStatusView, type MediaStatusView } from '../src/mediaserver/status.js';
import { Supervisor } from '../src/mediaserver/supervise.js';
import { ReplayCache, deriveKey, sign, streamBinding, streamBindingAsync, type Verifier } from '../src/protocol.js';
import { MAX_DERIVING, handler, warmMediaStatus, type AppDeps } from '../src/server.js';
import { DEFAULT_STATE, memoryStore, type Job } from '../src/state.js';
import { FACTS, FIRST_RUN_SEED, SOURCE, SPEC, ferroPin, okFolders, world } from './media-world.js';

const key = deriveKey('media-server-test-secret-0123456789');
const BACKUP = 'jellyfin-20261117-1402-10.11.3';
const POLISH = 'zażółć gęślą jaźń';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

const VIEW: MediaStatusView = {
  available: true, reason: null, base: { set: false, path: null, pending: false, expiresAt: null }, desired: null, container: null, pin: null,
  pins: { ferrofin: true, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null, backups: [], hdr: null,
};

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

async function listen(d: AppDeps): Promise<string> {
  const h = handler(d);
  const server = createServer((req, res) => { void h(req, res); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** fake service, jobs, status and streams around a real updater and the real verifier */
function fake() {
  const updater = new Updater({} as Ops, memoryStore(DEFAULT_STATE));
  const verifier: Verifier = { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 };
  const calls: string[] = [];
  const job = { id: '0123456789abcdef', action: 'mediaserver-start', state: 'running' } as Job;
  const f = {
    updater, verifier, calls,
    view: { ...VIEW } as MediaStatusView,
    start: ((op: MediaOp): StartResult => { calls.push(`start ${op.op}`); return { ok: true, job }; }) as (op: MediaOp) => StartResult,
    downloaded: [] as Array<{ id: string; passphrase: string }>,
    uploaded: [] as string[],
  };
  const deps: AppDeps = {
    updater, verifier, services: async () => [], self: { version: '1.0.0', sha: null },
    media: {
      service: {
        request: async (path) => { calls.push(`request ${path}`); return { ok: true, expiresAt: '2026-11-17T14:32:00.000Z', warning: null }; },
        confirm: async () => { calls.push('confirm'); return { result: 'wrong' }; },
        clear: async () => { calls.push('clear'); return { ok: true }; },
        browse: async () => { calls.push('browse'); return { entries: [{ name: 'Filme', symlink: false, unreadable: false }], truncated: false }; },
        gpu: async () => { calls.push('gpu'); return { dri: [], nvidia: false }; },
        logs: async () => { calls.push('logs'); return { lines: ['a'] }; },
        moveScan: async (serverId, source) => {
          calls.push(`moveScan ${serverId} ${source ?? '-'}`);
          return source ? { error: 'source_outside_base', outside: ['/music'], refused: [] } : { candidates: [{ id: 'c'.repeat(64), name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', state: 'running', matches: true }] };
        },
      },
      jobs: { start: (op) => f.start(op as MediaOp) },
      status: async () => f.view,
      download: async (id, passphrase, res) => {
        f.downloaded.push({ id, passphrase });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${id}.tar.gz.age"` });
        res.end('age');
      },
      upload: async (req, passphrase) => {
        f.uploaded.push(passphrase);
        for await (const _c of req) { /* consumed */ }
        return { ok: true, backup: { id: BACKUP, kind: 'jellyfin', upstream: '10.11.3', at: '2026-11-17T14:02:00.000Z', tag: 'upload', size: 3 } };
      },
    },
  };
  return { ...f, deps, f };
}

const post = (base: string, body: string, o: { type?: string; unsigned?: boolean; headers?: Record<string, string> } = {}) =>
  fetch(`${base}/v1/mediaserver`, {
    method: 'POST', body,
    headers: { ...(o.unsigned ? {} : sign(key, 'POST', '/v1/mediaserver', body)), 'content-type': o.type ?? 'application/json', ...o.headers },
  });

describe('POST /v1/mediaserver', () => {
  it('unsigned or replayed media requests are refused', async () => {
    const t = fake();
    const base = await listen(t.deps);
    const body = '{"op":"start"}';
    expect((await post(base, body, { unsigned: true })).status).toBe(401);
    const h = sign(key, 'POST', '/v1/mediaserver', body);
    expect((await post(base, body, { headers: h })).status).toBe(202);
    const again = await post(base, body, { headers: h });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'replay' });
    expect(t.calls).toEqual(['start start']);
  });

  it('strict bodies', async () => {
    const t = fake();
    const base = await listen(t.deps);
    const r = await post(base, '{"op":"start","image":"x"}');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid_body' });
    expect((await post(base, '{"op":"start"}', { type: 'text/plain' })).status).toBe(415);
    expect((await post(base, '{broken')).status).toBe(400);
    expect(t.calls).toEqual([]);
  });

  it('the sync ops answer their own shapes', async () => {
    const t = fake();
    const base = await listen(t.deps);
    const req = await post(base, '{"op":"base-request","path":"/srv/media"}');
    expect([req.status, await req.json()]).toEqual([200, { pending: true, expiresAt: '2026-11-17T14:32:00.000Z', warning: null }]);
    const conf = await post(base, '{"op":"base-confirm","code":"XXXX-XXXX-XXXX"}');
    expect([conf.status, await conf.json()]).toEqual([200, { result: 'wrong' }]);
    expect(await (await post(base, '{"op":"base-clear"}')).json()).toEqual({ ok: true });
    expect(await (await post(base, '{"op":"browse","rel":""}')).json()).toEqual({ entries: [{ name: 'Filme', symlink: false, unreadable: false }], truncated: false });
    expect(await (await post(base, '{"op":"gpu"}')).json()).toEqual({ dri: [], nvidia: false });
    expect(await (await post(base, '{"op":"logs","tail":100}')).json()).toEqual({ lines: ['a'] });

    t.deps.media!.service.request = async () => ({ ok: false, status: 429, error: 'rate_limited' });
    t.deps.media!.service.confirm = async () => ({ error: 'busy' });
    t.deps.media!.service.clear = async () => ({ error: 'container_exists' });
    t.deps.media!.service.browse = async () => ({ error: 'invalid_body' });
    t.deps.media!.service.logs = async () => ({ error: 'no_container' });
    const answers = [];
    for (const b of ['{"op":"base-request","path":"/srv/media"}', '{"op":"base-confirm","code":"x"}', '{"op":"base-clear"}', '{"op":"browse","rel":""}', '{"op":"logs","tail":50}']) {
      const r = await post(base, b);
      answers.push([r.status, await r.json()]);
    }
    expect(answers).toEqual([[429, { error: 'rate_limited' }], [409, { error: 'busy' }], [409, { error: 'container_exists' }], [400, { error: 'invalid_body' }], [409, { error: 'no_container' }]]);
  });

  it('job ops answer 202 with the job, 409 while busy', async () => {
    const t = fake();
    const base = await listen(t.deps);
    const r = await post(base, '{"op":"backup","trickplay":false}');
    expect(r.status).toBe(202);
    expect((await r.json()).job).toMatchObject({ id: '0123456789abcdef', action: 'mediaserver-start' });
    t.f.start = () => ({ ok: false, error: 'busy' });
    const busy = await post(base, '{"op":"restart"}');
    expect([busy.status, await busy.json()]).toEqual([409, { error: 'busy' }]);
    t.f.start = () => ({ ok: false, error: 'no_target' });
    const none = await post(base, '{"op":"update"}');
    expect([none.status, await none.json()]).toEqual([400, { error: 'no_target' }]);
  });

  it('not available: only safe ops pass', async () => {
    const t = fake();
    t.f.view = { ...VIEW, available: false, reason: 'no_logs' };
    const base = await listen(t.deps);
    const apply = await post(base, JSON.stringify({ op: 'apply', spec: SPEC }));
    expect([apply.status, await apply.json()]).toEqual([409, { error: 'no_logs' }]);
    for (const b of ['{"op":"base-request","path":"/srv/media"}', '{"op":"browse","rel":""}', '{"op":"start"}']) expect((await post(base, b)).status, b).toBe(409);
    expect((await post(base, '{"op":"stop"}')).status).toBe(202);
    expect((await post(base, '{"op":"remove","data":false}')).status).toBe(202);
    for (const b of ['{"op":"logs","tail":50}', '{"op":"gpu"}', '{"op":"base-clear"}']) expect((await post(base, b)).status, b).toBe(200);
    expect(t.calls).toEqual(['start stop', 'start remove', 'logs', 'gpu', 'clear']);
  });

  it('a body that does not arrive within 10 s is answered 408', async () => {
    const t = fake();
    const base = await listen({ ...t.deps, limits: { bodyMs: 200 } });
    const answer = await new Promise<string>((resolve) => {
      const s = connect(Number(new URL(base).port), '127.0.0.1', () => {
        s.write('POST /v1/mediaserver HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 50\r\n\r\n{"op":');
      });
      let got = '';
      s.on('data', (c) => { got += String(c); });
      s.on('close', () => resolve(got));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 408 /);
    expect(answer).toContain('{"error":"timeout"}');
    expect(t.calls).toEqual([]);
  });
});

describe('stage 2 ops', () => {
  const CID = 'a'.repeat(64);
  const SID = 'b'.repeat(32);
  const MIGRATE = { op: 'migrate', source: CID, trickplay: false, gpu: 'off', uid: 1000, gid: 1000, tz: 'Europe/Berlin', serverId: SID };

  it('parseMediaBody accepts each new op exactly', () => {
    expect(parseMediaBody({ op: 'migrate-scan', serverId: SID })).toEqual({ op: 'migrate-scan', serverId: SID });
    expect(parseMediaBody({ op: 'migrate-scan', serverId: SID, source: CID })).toEqual({ op: 'migrate-scan', serverId: SID, source: CID });
    expect(parseMediaBody({ op: 'migrate-done' })).toEqual({ op: 'migrate-done' });
    expect(parseMediaBody(MIGRATE)).toEqual(MIGRATE);
    expect(parseMediaBody({ op: 'migrate-abort' })).toEqual({ op: 'migrate-abort' });
    expect(parseMediaBody({ op: 'source-start' })).toEqual({ op: 'source-start' });
  });

  it('parseMediaBody rejects extra keys, short ids, a string flag and a short server id', () => {
    for (const bad of [
      { op: 'migrate-scan', serverId: SID, extra: 1 }, { op: 'migrate-scan', serverId: 'b'.repeat(31) }, { op: 'migrate-scan', serverId: SID, source: 'a'.repeat(63) },
      { op: 'migrate-scan' }, { op: 'migrate-done', x: 1 }, { op: 'migrate-abort', x: 1 }, { op: 'source-start', x: 1 },
      { ...MIGRATE, extra: 1 }, { ...MIGRATE, source: 'a'.repeat(63) }, { ...MIGRATE, trickplay: 'false' }, { ...MIGRATE, serverId: 'b'.repeat(31) },
      { ...MIGRATE, serverId: 'B'.repeat(32) }, { ...MIGRATE, gpu: 'x' }, { ...MIGRATE, uid: 0 }, { ...MIGRATE, tz: '../x' },
    ]) expect(parseMediaBody(bad), JSON.stringify(bad)).toBeNull();
  });

  it('parseMediaBody keeps the migrated flag on a spec and its folders, and only as true', () => {
    const spec = { ...SPEC, migrated: true as const, folders: [{ rel: '', target: '/data/filme', migrated: true as const }] };
    expect(parseMediaBody({ op: 'apply', spec })).toEqual({ op: 'apply', spec });
    expect(parseMediaBody({ op: 'apply', spec: { ...spec, migrated: false } })).toBeNull();
    expect(parseMediaBody({ op: 'apply', spec: { ...SPEC, folders: [{ rel: '', target: '/media/x' }] } })).toBeNull();
  });

  it('migrate, migrate-abort and source-start are jobs; migrate-scan and migrate-done are not, and are gated by availability', async () => {
    const t = fake();
    const base = await listen(t.deps);
    expect((await post(base, JSON.stringify(MIGRATE))).status).toBe(202);
    expect((await post(base, '{"op":"migrate-abort"}')).status).toBe(202);
    expect((await post(base, '{"op":"source-start"}')).status).toBe(202);
    expect(t.calls).toEqual(['start migrate', 'start migrate-abort', 'start source-start']);
    // synchronous ops: not jobs, never reach jobs.start; migrate-done answers 400 until its service lands
    const list = await post(base, `{"op":"migrate-scan","serverId":"${SID}"}`);
    expect([list.status, await list.json()]).toEqual([200, { candidates: [{ id: 'c'.repeat(64), name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', state: 'running', matches: true }] }]);
    const one = await post(base, `{"op":"migrate-scan","serverId":"${SID}","source":"${CID}"}`);
    expect([one.status, await one.json()]).toEqual([409, { error: 'source_outside_base', outside: ['/music'], refused: [] }]);
    const done = await post(base, '{"op":"migrate-done"}');
    expect([done.status, await done.json()]).toEqual([400, { error: 'invalid_body' }]);
    expect(t.calls).toEqual(['start migrate', 'start migrate-abort', 'start source-start', `moveScan ${SID} -`, `moveScan ${SID} ${CID}`]);
    t.f.view = { ...VIEW, available: false, reason: 'no_logs' };
    for (const b of [`{"op":"migrate-scan","serverId":"${SID}"}`, '{"op":"migrate-done"}', JSON.stringify(MIGRATE)]) expect((await post(base, b)).status, b).toBe(409);
    for (const b of ['{"op":"migrate-abort"}', '{"op":"source-start"}']) expect((await post(base, b)).status, b).toBe(202);
  });
});

describe('the media status', () => {
  it('status carries mediaserver and never a code or password', async () => {
    const w = world();
    const printed: string[] = [];
    w.cfg.answer = ((orig) => (c) => (c.verb === 'check' && c.args[0] === 'base' ? { exists: true, dir: true, listable: true, looksSystem: false } : orig(c)))(w.cfg.answer);
    const service = new MediaService({ ...w.deps, print: (l) => { printed.push(l); } }, w.jobs);
    const status = mediaStatusView({ updater: w.updater, engine: w.deps.engine, jobs: w.jobs, facts: w.deps.facts, pins: w.deps.pins, templateState: () => w.jobs.templateState(), now: () => w.clock.t });
    const verifier: Verifier = { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 };
    const base = await listen({
      updater: w.updater, verifier, services: async () => [], self: { version: '1.0.0', sha: null },
      media: { service, jobs: w.jobs, status, download: async () => undefined, upload: async () => ({ ok: false, status: 400, error: 'backup_invalid' }) },
    });

    expect((await post(base, '{"op":"base-request","path":"/srv/media"}')).status).toBe(200);
    const apply = await post(base, JSON.stringify({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } }));
    expect(apply.status).toBe(202);
    await w.updater.idle();
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-apply', state: 'succeeded' });

    const r = await fetch(`${base}/v1/status`, { headers: sign(key, 'GET', '/v1/status', '') });
    const text = await r.text();
    const json = JSON.parse(text) as { mediaserver: MediaStatusView };
    expect(json.mediaserver.base).toEqual({ set: true, path: '/srv/media', pending: true, expiresAt: '2026-11-17T14:32:00.000Z' });
    expect(json.mediaserver).toMatchObject({
      // the first-run password is still in the running container's spec until finish-setup recreates it without
      available: true, reason: null, desired: { kind: 'ferrofin', run: true }, container: { state: 'running', health: 'healthy', kind: 'ferrofin', template: 'update_pending', tampered: false },
      pin: { image: ferroPin().image, upstream: null, changed: false }, pins: { ferrofin: true, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null,
    });
    const display = /enter the code ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}) in Admin/.exec(printed[0]!)![1]!;
    const codeHash = w.store.state.media.pending!.codeHash;
    for (const secret of [display, display.replaceAll('-', ''), FIRST_RUN_SEED, codeHash]) expect(text).not.toContain(secret);
  });

  it('pin.changed compares the backend build with the recorded pin source', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    const view = (t = 0) => mediaStatusView({ updater: w.updater, engine: w.deps.engine, jobs: w.jobs, facts: w.deps.facts, pins: w.deps.pins, templateState: async () => 'update_pending', now: () => w.clock.t + t });
    expect((await view()()).pin).toEqual({ image: ferroPin().image, upstream: null, changed: false }); // never recorded: unknown
    w.updater.updateMedia((m) => { m.pinSource = SOURCE; });
    expect((await view()()).pin!.changed).toBe(false);
    w.updater.updateMedia((m) => { m.pinSource = `sha256:${'c'.repeat(64)}`; });
    const v = await view()();
    expect(v.pin!.changed).toBe(true);
    expect(v.container!.template).toBe('update_pending');
    w.cfg.pins = { error: 'no_backend' };
    expect(await view()()).toMatchObject({ pin: { image: null, upstream: null, changed: false }, pins: { ferrofin: false, jellyfin: false } });
  });

  it('a tampered, unadopted container shows in the status', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1', { host: { Privileged: true } });
    w.updater.updateMedia((m) => { m.container = null; m.desired = null; });
    const v = await mediaStatusView({ updater: w.updater, engine: w.deps.engine, jobs: w.jobs, facts: w.deps.facts, pins: w.deps.pins, templateState: async () => null, now: () => w.clock.t })();
    expect(w.media().container).toBeNull();
    expect(v.container).toMatchObject({ tampered: true, kind: 'ferrofin', state: 'running', image: { digest: ferroPin().digest, upstream: 'unknown' } });

    // a guard-clean one the state lost is shown untampered (the supervisor adopts it)
    const c = world();
    c.existing(SPEC, ferroPin(), 'v1.5.1');
    c.updater.updateMedia((m) => { m.container = null; });
    const cv = await mediaStatusView({ updater: c.updater, engine: c.deps.engine, jobs: c.jobs, facts: c.deps.facts, pins: c.deps.pins, templateState: async () => null, now: () => c.clock.t })();
    expect(cv.container).toMatchObject({ tampered: false });
  });

  it('the status view runs no helper: the template is compared with the render gids recorded at the deploy', async () => {
    const w = world();
    // the host's render group changed since the deploy: only a deploy or an update reads it again
    w.cfg.answer = (c) => (c.verb === 'gpu' ? { nodes: [{ node: 'renderD128', gid: 994, vendor: 'intel' }] } : okFolders(c));
    w.existing({ ...SPEC, gpu: 'dri' }, ferroPin(), 'v1.5.1', { renderGids: [993] });
    // wired as server.ts wires it
    const sup = new Supervisor({ ...w.deps, jobs: w.jobs });
    const view = () => mediaStatusView({ updater: w.updater, engine: w.deps.engine, jobs: w.jobs, facts: w.deps.facts, pins: w.deps.pins, templateState: () => sup.templateState(), now: () => w.clock.t })();
    expect((await view()).container).toMatchObject({ state: 'running', template: 'current' });
    // recorded gids the container was not built with: an update is pending
    w.updater.updateMedia((m) => { m.renderGids = [992]; });
    expect((await view()).container!.template).toBe('update_pending');
    // a state from before the record: unknown with the dri GPU, never a helper
    w.updater.updateMedia((m) => { delete m.renderGids; });
    expect(await sup.templateState()).toBeNull();
    expect((await view()).container).toMatchObject({ state: 'running', template: null });
    expect(w.helperCalls).toEqual([]);
    // without the dri GPU an old state compares with no render gids
    const o = world();
    o.existing(SPEC, ferroPin(), 'v1.5.1');
    o.updater.updateMedia((m) => { delete m.renderGids; });
    expect(await new Supervisor({ ...o.deps, jobs: o.jobs }).templateState()).toBe('current');
    o.updater.updateMedia((m) => { m.desired!.tz = 'Europe/Vienna'; });
    expect(await new Supervisor({ ...o.deps, jobs: o.jobs }).templateState()).toBe('update_pending');
    expect(o.helperCalls).toEqual([]);
  });

  it('status view is cached for 10 s', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    let facts = 0, templates = 0, t = 0;
    const view = mediaStatusView({
      updater: w.updater, engine: w.deps.engine, jobs: w.jobs, pins: w.deps.pins, now: () => t,
      facts: async () => { facts++; return FACTS; },
      templateState: async () => { templates++; return 'current'; },
    });
    await view();
    t = 9_999;
    await view();
    expect([facts, templates]).toEqual([1, 1]);
    // what the updater keeps is read on every call
    w.updater.updateMedia((m) => { m.lastError = 'gpu_missing'; });
    expect((await view()).error).toBe('gpu_missing');
    t = 10_000;
    await view();
    expect([facts, templates]).toEqual([2, 1]); // the template state is kept 30 s
    t = 40_000;
    await view();
    expect([facts, templates]).toEqual([3, 2]);
    // a job that ended reads everything again at once
    await w.run({ op: 'stop' });
    await view();
    expect([facts, templates]).toEqual([4, 3]);
  });
});

describe('a slow media status', () => {
  it('concurrent callers share one read', async () => {
    const w = world();
    let facts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const view = mediaStatusView({
      updater: w.updater, engine: w.deps.engine, jobs: w.jobs, pins: w.deps.pins, now: () => w.clock.t, templateState: async () => null,
      facts: async () => { facts++; await gate; return FACTS; },
    });
    const all = Promise.all([view(), view(), view()]);
    release();
    const [a, b, c] = await all;
    expect(facts).toBe(1);
    expect(a.available && b.available && c.available).toBe(true);
  });

  it('/v1/status answers within the bound while the media status hangs (the last view, else the starting view)', async () => {
    const f = fake();
    let hang = false;
    f.deps.media!.status = () => (hang ? new Promise<MediaStatusView>(() => undefined) : Promise.resolve(f.view));
    const base = await listen({ ...f.deps, limits: { mediaStatusMs: 50 } });
    const get = async () => (await (await fetch(`${base}/v1/status`, { headers: sign(key, 'GET', '/v1/status', '') })).json()) as { mediaserver: MediaStatusView | null };

    hang = true;
    let t0 = Date.now();
    // before the first view: a valid view that says it is still being read (never null: the backend reads null as "updater too old")
    expect((await get()).mediaserver).toEqual(STARTING_VIEW);
    expect(STARTING_VIEW).toMatchObject({ available: false, reason: 'starting', container: null, desired: null, error: null, backups: [] });
    expect(Date.now() - t0).toBeLessThan(1_000);
    // a media op's availability check is bounded too
    const op = await post(base, '{"op":"start"}');
    expect(op.status).toBe(409);
    expect(await op.json()).toEqual({ error: 'starting' });

    hang = false;
    expect((await get()).mediaserver).toEqual(VIEW);
    hang = true;
    t0 = Date.now();
    expect((await get()).mediaserver).toEqual(VIEW);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('the media status warm-up', () => {
  it('fills the view once, so /v1/status has it although the next read hangs', async () => {
    const f = fake();
    let reads = 0;
    f.deps.media!.status = () => (++reads === 1 ? Promise.resolve(f.view) : new Promise<MediaStatusView>(() => undefined));
    const base = await listen({ ...f.deps, limits: { mediaStatusMs: 50 } });
    await warmMediaStatus(f.deps.media!);
    expect(reads).toBe(1);
    const r = (await (await fetch(`${base}/v1/status`, { headers: sign(key, 'GET', '/v1/status', '') })).json()) as { mediaserver: MediaStatusView | null };
    expect(r.mediaserver).toEqual(VIEW);
  });

  it('a failed warm-up leaves the starting view and never throws', async () => {
    const f = fake();
    let reads = 0;
    f.deps.media!.status = () => (++reads === 1 ? Promise.reject(new Error('engine')) : new Promise<MediaStatusView>(() => undefined));
    const base = await listen({ ...f.deps, limits: { mediaStatusMs: 50 } });
    await expect(warmMediaStatus(f.deps.media!)).resolves.toBeUndefined();
    const r = (await (await fetch(`${base}/v1/status`, { headers: sign(key, 'GET', '/v1/status', '') })).json()) as { mediaserver: MediaStatusView | null };
    expect(r.mediaserver).toEqual(STARTING_VIEW);
  });
});

describe('the backup streams', () => {
  /** signed over streamBinding(signedOver); `raw` signs the string itself (the old scheme, refused) */
  const download = (base: string, id: string, header: string, signedOver = header, raw = false) => {
    const path = `/v1/mediaserver/backups/${id}/download`;
    return fetch(base + path, { headers: { ...sign(key, 'GET', path, raw ? signedOver : streamBinding(signedOver)), 'x-ff-backup-passphrase': header } });
  };

  it('stream routes: signed over a scrypt derivation of the passphrase header', async () => {
    const t = fake();
    const base = await listen(t.deps);
    const h = b64(POLISH);
    expect((await download(base, BACKUP, h, b64('something else entirely'))).status).toBe(401);
    // a tampered header (one character changed after signing) is refused
    expect((await download(base, BACKUP, `${h.slice(0, -1)}A`, h)).status).toBe(401);
    // a signature over the header itself instead of its derivation is refused
    expect((await download(base, BACKUP, h, h, true)).status).toBe(401);
    expect(t.downloaded).toEqual([]);

    const ok = await download(base, BACKUP, h);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/octet-stream');
    expect(ok.headers.get('content-disposition')).toBe(`attachment; filename="${BACKUP}.tar.gz.age"`);
    expect(await ok.text()).toBe('age');
    expect(t.downloaded).toEqual([{ id: BACKUP, passphrase: POLISH }]);

    // an id that is no backup id: 404 before the signature is looked at
    for (const id of ['..%2Fx', 'x', `${BACKUP}%2F..`]) {
      const r = await fetch(`${base}/v1/mediaserver/backups/${id}/download`);
      expect([r.status, await r.json()], id).toEqual([404, { error: 'not_found' }]);
    }
    expect((await fetch(`${base}/v1/mediaserver/backups/../x/download`)).status).toBe(404);
    expect((await fetch(`${base}/v1/mediaserver/backups/${BACKUP}/download`, { method: 'POST' })).status).toBe(405);

    const short = await download(base, BACKUP, b64('a'.repeat(11)));
    expect([short.status, await short.json()]).toEqual([400, { error: 'invalid_passphrase' }]);
    // an empty header is signed like any other, then refused by the rule
    expect((await download(base, BACKUP, '')).status).toBe(400);
    expect(t.downloaded).toHaveLength(1);

    const path = '/v1/mediaserver/backups/upload';
    const up = await fetch(base + path, { method: 'POST', body: 'age-bytes', headers: { ...sign(key, 'POST', path, streamBinding(h)), 'x-ff-backup-passphrase': h, 'content-type': 'application/octet-stream' } });
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ backup: { id: BACKUP, kind: 'jellyfin', upstream: '10.11.3', at: '2026-11-17T14:02:00.000Z', tag: 'upload', size: 3 } });
    expect(t.uploaded).toEqual([POLISH]);
  });

  it('the scrypt derivation runs only after every cheap check passed', async () => {
    const t = fake();
    const derive = vi.fn(streamBindingAsync);
    const base = await listen({ ...t.deps, streamBinding: derive });
    const path = `/v1/mediaserver/backups/${BACKUP}/download`;
    const h = b64(POLISH);
    const get = (headers: Record<string, string>) => fetch(base + path, { headers: { 'x-ff-backup-passphrase': h, ...headers } });
    const answer = async (r: Response) => [r.status, await r.json()];
    expect(await answer(await get({}))).toEqual([401, { error: 'missing' }]);
    const good = sign(key, 'GET', path, streamBinding(h));
    expect(await answer(await get({ ...good, 'x-ff-updater-signature': 'v1=zz' }))).toEqual([401, { error: 'malformed' }]);
    expect(await answer(await get(sign(key, 'GET', path, streamBinding(h), String(Date.now() - 5 * 60_000))))).toEqual([401, { error: 'expired' }]);
    const bad = b64('a'.repeat(11));
    expect(await answer(await fetch(base + path, { headers: { ...sign(key, 'GET', path, streamBinding(bad)), 'x-ff-backup-passphrase': bad } }))).toEqual([400, { error: 'invalid_passphrase' }]);
    expect(derive).not.toHaveBeenCalled();
    // a signed request is derived once and passes; its nonce again is refused before deriving
    expect((await get(good)).status).toBe(200);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(await answer(await get(good))).toEqual([401, { error: 'replay' }]);
    expect(derive).toHaveBeenCalledTimes(1);
    // a well-formed but wrong signature costs one derivation and is refused
    expect(await answer(await get({ ...sign(key, 'GET', path, streamBinding(h)), 'x-ff-updater-signature': `v1=${'0'.repeat(64)}` }))).toEqual([401, { error: 'bad_signature' }]);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('at most MAX_DERIVING derivations run at once; one more is answered busy', async () => {
    const t = fake();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const derive = vi.fn(async (header: string) => { await held; return streamBindingAsync(header); });
    const base = await listen({ ...t.deps, streamBinding: derive });
    const path = `/v1/mediaserver/backups/${BACKUP}/download`;
    const h = b64(POLISH);
    const get = () => fetch(base + path, { headers: { ...sign(key, 'GET', path, streamBinding(h)), 'x-ff-backup-passphrase': h } });
    const running = Array.from({ length: MAX_DERIVING }, () => get());
    await vi.waitFor(() => expect(derive).toHaveBeenCalledTimes(MAX_DERIVING));
    const extra = await get();
    expect([extra.status, await extra.json()]).toEqual([409, { error: 'busy' }]);
    expect(derive).toHaveBeenCalledTimes(MAX_DERIVING);
    release();
    expect((await Promise.all(running)).map((r) => r.status)).toEqual(Array(MAX_DERIVING).fill(200));
    // the slots are free again
    expect((await get()).status).toBe(200);
  });

  it('upload refusals before reading are answered', async () => {
    const t = fake();
    t.deps.media!.upload = async () => ({ ok: false, status: 409, error: 'busy' });
    const base = await listen(t.deps);
    const path = '/v1/mediaserver/backups/upload';
    const h = b64(POLISH);
    const send = (headers: Record<string, string>) => fetch(base + path, { method: 'POST', body: 'x'.repeat(1000), headers: { 'x-ff-backup-passphrase': h, ...headers } });
    const unsigned = await send({});
    expect([unsigned.status, await unsigned.json(), unsigned.headers.get('connection')]).toEqual([401, { error: 'missing' }, 'close']);
    const busy = await send(sign(key, 'POST', path, streamBinding(h)));
    expect([busy.status, await busy.json()]).toEqual([409, { error: 'busy' }]);
    const bad = b64('a'.repeat(5));
    const short = await fetch(base + path, { method: 'POST', body: 'x', headers: { ...sign(key, 'POST', path, streamBinding(bad)), 'x-ff-backup-passphrase': bad } });
    expect([short.status, await short.json()]).toEqual([400, { error: 'invalid_passphrase' }]);
    expect((await fetch(base + path)).status).toBe(405);
  });

  it('an upload that declares more than 20 GiB is refused before it is read', async () => {
    const t = fake();
    const base = await listen(t.deps);
    const path = '/v1/mediaserver/backups/upload';
    const h = b64(POLISH);
    const head = Object.entries({ ...sign(key, 'POST', path, streamBinding(h)), 'x-ff-backup-passphrase': h }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const answer = await new Promise<string>((resolve) => {
      const s = connect(Number(new URL(base).port), '127.0.0.1', () => {
        s.write(`POST ${path} HTTP/1.1\r\nhost: x\r\ncontent-length: ${20 * 1024 ** 3 + 1}\r\n${head}\r\nage`);
      });
      let got = '';
      s.on('data', (c) => { got += String(c); });
      s.on('close', () => resolve(got));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 413 /);
    expect(answer).toContain('{"error":"too_large"}');
    expect(t.uploaded).toEqual([]);
  });

  it('a stalled upload is cut after the idle limit (it may hold the scrypt lock)', async () => {
    const t = fake();
    let ended: (how: string) => void = () => undefined;
    const how = new Promise<string>((resolve) => { ended = resolve; });
    t.deps.media!.upload = async (req) => {
      await new Promise<void>((resolve) => { req.on('close', () => { ended(req.complete ? 'complete' : 'cut'); resolve(); }); req.resume(); });
      return { ok: false, status: 400, error: 'backup_invalid' };
    };
    const base = await listen({ ...t.deps, limits: { streamIdleMs: 200 } });
    const path = '/v1/mediaserver/backups/upload';
    const h = b64(POLISH);
    const head = Object.entries({ ...sign(key, 'POST', path, streamBinding(h)), 'x-ff-backup-passphrase': h }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const closed = await new Promise<boolean>((resolve) => {
      const s = connect(Number(new URL(base).port), '127.0.0.1', () => { s.write(`POST ${path} HTTP/1.1\r\nhost: x\r\ncontent-length: 1000\r\n${head}\r\nage`); });
      s.on('data', () => undefined);
      s.on('close', () => resolve(true));
    });
    expect(closed).toBe(true);
    expect(await how).toBe('cut');
  });
});
