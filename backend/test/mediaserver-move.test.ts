// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { goBack, MOVE_LOCK, moveTick, repairUsers, verifyIds } from '../src/mediaserver/move.js';
import { externalKey, readManaged, writeManaged, type MovePhase } from '../src/mediaserver/store.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { sessionKey } from '../src/session.js';
import { ADMIN, cfg, makeEnv, type Handler, type TestEnv } from './helpers.js';

const SECRET = cfg.INTERNAL_SECRET;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const MANAGED = 'http://mediaserver:8096';
const OLD = 'http://jellyfin.example.com:8096';
/** token-shaped values from pieces (gitleaks) */
const KEY = 'k' + 'ey-' + 'copied-' + '1';
/** the old Jellyfin's key as the way back stored it */
const OLD_KEY = 'k' + 'ey-' + 'old-' + '2';
const COPY_JOB = 'aaaaaaaaaaaaaaaa';
const hex = (n: number) => n.toString(16).padStart(32, '0');
const START = '2026-11-24T09:00:00.000Z';

// ---------------------------------------------------------------- the fake updater

let jobN = 0x100;
type Job = Record<string, any>;
const job = (action: string, state = 'running', id = (++jobN).toString(16).padStart(16, '0')): Job => ({ id, action, state, step: null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' }, startedAt: '2026-11-24T09:00:00.000Z', finishedAt: null, error: null,
  media: { step: 'copy', steps: {} } });
const updMove = (phase: string) => ({ phase, step: null, source: { name: 'jellyfin', version: '10.10.3' }, folders: [{ rel: '', target: '/movies', migrated: true }], abort: false });
const media = () => ({
  available: true, reason: null, base: { set: true, path: '/srv/media', pending: false, expiresAt: null },
  desired: { kind: 'ferrofin', folders: [{ rel: '', target: '/movies', migrated: true }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, run: true, migrated: true } as Record<string, any> | null,
  container: { state: 'running', health: 'healthy', kind: 'ferrofin', image: { digest: DIGEST, upstream: '1.2.3' }, template: 'current', tampered: false, createdAt: '2026-11-24T09:00:00.000Z' } as Record<string, any> | null,
  pin: null, pins: { ferrofin: true, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null as string | null, backups: [], hdr: null,
  move: updMove('ready') as Record<string, any> | null, source: { name: 'jellyfin', state: 'exited', version: '10.10.3' } as Record<string, any> | null,
});

const fake = {
  media: media(),
  job: null as Job | null,
  busy: false,
  up: true,
  bodies: [] as Array<Record<string, any>>,
  /** ops the updater refuses with this code */
  refuse: {} as Record<string, string>,
  /** the render nodes the gpu op detects */
  dri: [{ node: 'renderD129', gid: 44, vendor: 'intel' }] as Array<Record<string, unknown>>,
  /** the code the source job fails with (null: it starts the old Jellyfin) */
  sourceError: null as string | null,
  /** the code the stop job fails with (null: it stops the managed server) */
  stopError: null as string | null,
  /** the status read fails (the updater cannot be read; its ops still answer) */
  statusDown: false,
};
const resetFake = () => Object.assign(fake, { media: media(), job: job('mediaserver-migrate', 'succeeded', COPY_JOB), busy: false, up: true, bodies: [], refuse: {},
  dri: [{ node: 'renderD129', gid: 44, vendor: 'intel' }], sourceError: null, stopError: null, statusDown: false });
const opBodies = (op: string) => fake.bodies.filter((b) => b.op === op);

// ---------------------------------------------------------------- the fake Ferrofin (the copied database)

interface Call { method: string; path: string; query: URLSearchParams; body: any; token: string | null }
interface Lib { Name: string; ItemId: string; Locations: string[]; LibraryOptions: Record<string, unknown> }
/** a server user by name and password (created through the API, or seeded with a name); `policy` as last written */
interface Account { name: string; pw: string; policy: Record<string, unknown> }
const newServer = (key: string) => ({
  key,
  up: true,
  users: new Set<string>(),
  /** the users the fake knows by name (created, or seeded for a name clash) */
  accounts: new Map<string, Account>(),
  items: new Set<string>(),
  libs: [] as Lib[],
  calls: [] as Call[],
  encoding: { EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'none' } as Record<string, unknown>,
  /** runs before a call is answered (a concurrent writer) */
  before: null as ((c: Call) => Promise<void>) | null,
  /** a status to answer instead (a server still starting: 503) */
  fail: null as ((c: Call) => number | null) | null,
});
type Srv = ReturnType<typeof newServer>;
/** the managed Ferrofin (the copied database) and the old Jellyfin the way back returns to */
const server: Srv = newServer(KEY);
const old: Srv = newServer(OLD_KEY);
let createdN = 0;
const resetServer = () => { Object.assign(server, newServer(KEY)); Object.assign(old, newServer(OLD_KEY)); };
const calls = (method: string, path: string, srv: Srv = server) => srv.calls.filter((c) => c.method === method && c.path === path);
const tokenOf = (h: string | null) => /Token="([^"]*)"/.exec(h ?? '')?.[1] ?? null;

function serverAnswer(srv: Srv, c: Call): Response {
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const none = (status = 204) => new Response(null, { status });
  if (c.method === 'POST' && c.path === '/Users/AuthenticateByName') {
    const hit = [...srv.accounts].find(([id, a]) => srv.users.has(id) && a.name === c.body.Username && a.pw === c.body.Pw);
    return hit ? j({ AccessToken: 'tok', User: { Id: hit[0], Name: hit[1].name } }) : none(401);
  }
  if (c.token !== srv.key) return none(401);
  const failed = srv.fail?.(c);
  if (failed) return none(failed);
  const pw = /^\/Users\/([0-9a-f]{32})\/(Password|Policy)$/.exec(c.path);
  if (pw && c.method === 'POST') {
    if (!srv.users.has(pw[1]!)) return none(404);
    const a = srv.accounts.get(pw[1]!) ?? { name: 'x', pw: '', policy: {} };
    srv.accounts.set(pw[1]!, pw[2] === 'Password' ? { ...a, pw: c.body.NewPw } : { ...a, policy: c.body });
    return none();
  }
  if (c.method === 'GET' && c.path.startsWith('/Users/')) {
    const id = c.path.slice('/Users/'.length);
    return srv.users.has(id) ? j({ Id: id, Name: srv.accounts.get(id)?.name ?? 'x', Policy: srv.accounts.get(id)?.policy ?? {} }) : none(404);
  }
  switch (`${c.method} ${c.path}`) {
    case 'GET /System/Info': return j({ Id: 'f'.repeat(32), Version: '10.10.3' });
    case 'POST /Users/New': {
      if ([...srv.accounts.values()].some((a) => a.name === c.body.Name)) return none(400);
      const id = hex(0xe000 + ++createdN);
      srv.users.add(id);
      srv.accounts.set(id, { name: c.body.Name, pw: c.body.Password, policy: {} });
      return j({ Id: id, Name: c.body.Name });
    }
    case 'GET /Library/MediaFolders': return j({ Items: [] });
    case 'GET /Library/VirtualFolders': return j(srv.libs);
    case 'POST /Library/VirtualFolders/LibraryOptions': {
      const lib = srv.libs.find((l) => l.ItemId === c.body.Id);
      if (!lib) return none(404);
      lib.LibraryOptions = c.body.LibraryOptions;
      return none();
    }
    case 'GET /System/Configuration/encoding': return j(srv.encoding);
    case 'POST /System/Configuration/encoding': srv.encoding = c.body; return none();
    case 'GET /Items': {
      const id = c.query.get('ids')!;
      return j({ Items: srv.items.has(id) ? [{ Id: id, Name: 'x', Type: 'Movie' }] : [] });
    }
  }
  return none(404);
}

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const srv = u.origin === MANAGED ? server : u.origin === OLD ? old : null;
  if (srv) {
    if (!srv.up) throw new TypeError('fetch failed');
    const headers = new Headers(init?.headers);
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, body, token: tokenOf(headers.get('authorization')) };
    srv.calls.push(c);
    await srv.before?.(c);
    return serverAnswer(srv, c);
  }
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (!fake.up) throw new TypeError('fetch failed');
  if (u.pathname === '/v1/status') {
    if (fake.statusDown) throw new TypeError('fetch failed');
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: fake.busy, job: fake.job, log: [], services: [], mediaserver: fake.media });
  }
  if (u.pathname !== '/v1/mediaserver') return j({ error: 'not_found' }, 404);
  fake.bodies.push(body);
  const refused = fake.refuse[body.op];
  if (refused) return j({ error: refused }, 409);
  if (body.op === 'gpu') return j({ dri: fake.dri, nvidia: false });
  if (body.op === 'source-start') {
    if (fake.busy) return j({ error: 'busy' }, 409);
    if (!fake.media.source) return j({ error: 'no_target' }, 409);
    // the source job: only the recorded source, started when it is stopped (or its refusal)
    fake.job = job('mediaserver-source', fake.sourceError ? 'failed' : 'succeeded');
    fake.job.error = fake.sourceError;
    if (!fake.sourceError) fake.media.source = { ...fake.media.source, state: 'running' };
    return j({ job: { ...fake.job, state: 'running', error: null } }, 202);
  }
  if (body.op === 'stop') {
    if (fake.busy) return j({ error: 'busy' }, 409);
    fake.job = job('mediaserver-stop', fake.stopError ? 'failed' : 'succeeded');
    fake.job.error = fake.stopError;
    if (fake.media.desired) fake.media.desired.run = false;
    if (fake.media.container && !fake.stopError) fake.media.container.state = 'exited';
    return j({ job: { ...fake.job, state: 'running' } }, 202);
  }
  if (body.op === 'migrate-done') {
    if (fake.media.move?.phase !== 'ready') return j({ error: 'no_target' }, 409);
    fake.media.move = null;
    return j({ ok: true });
  }
  if (body.op === 'migrate-abort') {
    if (fake.busy) return j({ error: 'busy' }, 409);
    if (fake.media.move?.phase !== 'ready' && fake.media.move?.phase !== 'running') return j({ error: 'no_target' }, 409);
    // the abort job: the new container removed, the source started
    fake.media.move = { ...fake.media.move, phase: 'aborted' };
    fake.media.error = 'move_aborted';
    fake.job = job('mediaserver-migrate', 'failed');
    fake.job.error = 'move_aborted';
    return j({ job: { ...fake.job, state: 'running', error: null } }, 202);
  }
  return j({ error: 'invalid_body' }, 400);
}) as typeof fetch;

// ---------------------------------------------------------------- the fake request service (its settings API as in the pinned image)

/** the request service's Jellyfin settings (GET /settings/jellyfin answers all of them, its key included) */
const REQ_KEY = 'k' + 'ey-' + 'req-' + '3';
const reqSettings = () => ({
  name: 'Jellyfin', ip: 'jellyfin.example.com', port: 8920, useSsl: true, urlBase: '/jf', externalHostname: 'https://watch.example.com',
  jellyfinForgotPasswordUrl: '', libraries: [{ id: 'f'.repeat(32), name: 'Filme', enabled: true, type: 'movie' }], serverId: 'e'.repeat(32), apiKey: KEY,
} as Record<string, any>);
const req = {
  settings: reqSettings(),
  /** paths the request service answers with this status instead */
  fail: {} as Record<string, number>,
  calls: [] as Array<{ method: string; path: string; body: any; key: string | undefined }>,
};
const resetReq = () => Object.assign(req, { settings: reqSettings(), fail: {}, calls: [] });
const reqCalls = (method: string, path: string) => req.calls.filter((c) => c.method === method && c.path === path);
const reqRoute = (method: string, path: string, answer: (body: any) => { status?: number; json?: unknown }): Record<string, Handler> => ({
  [`${method} /api/v1${path}`]: (_u, init, body) => {
    req.calls.push({ method, path, body, key: (init.headers as Record<string, string> | undefined)?.['X-Api-Key'] });
    const failed = req.fail[`${method} ${path}`];
    return failed ? { status: failed, json: { message: 'no' } } : answer(body);
  },
});
const reqRoutes: Record<string, Handler> = {
  ...reqRoute('GET', '/settings/jellyfin', () => ({ json: req.settings })),
  // the request service merges the body over its settings and checks the server they name answers (with its stored key)
  ...reqRoute('POST', '/settings/jellyfin', (body) => {
    req.settings = { ...req.settings, ...body };
    return { json: req.settings };
  }),
  ...reqRoute('POST', '/settings/jellyfin/library/sync', () => ({ json: req.settings.libraries })),
  ...reqRoute('POST', '/settings/jellyfin/sync', () => ({ json: { running: true, progress: 0, total: 0 } })),
};
/** the request service's connection as FriendFlix points it at the managed server */
const REQ_MANAGED = { ip: 'mediaserver', port: 8096, useSsl: false, urlBase: '' };

const ctxPatch = (c: TestEnv['ctx']) => { c.fetchImpl = fetchImpl; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; };

describe('the move: the backend phases after the copy', () => {
  let env: TestEnv;
  const tick = () => moveTick(env.ctx);
  /** ticks until `until` (or 20 ticks), the results seen (waiting left out) */
  const run = async (until: string) => {
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await tick();
      if (r !== 'waiting') seen.push(r);
      if (r === until || r === 'idle') break;
    }
    return seen;
  };
  const seedMove = (phase: MovePhase, extra: Record<string, unknown> = {}) =>
    writeManaged(env.ctx, { move: { phase, error: null, jobId: COPY_JOB, startedAt: START, requestsWarning: false, ...extra } });
  let userN = 0;
  /** a user whose owner profile and one more profile are linked to media server users */
  const seedUser = async (ids: { user: string; profile?: string }) => {
    const sub = `sub-move-${++userN}`;
    const r = await env.pool.query<{ id: string }>(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), $1, $2, 'Lea', 'friend', $3, 'lea', $4) returning id`, [sub, `${sub}@example.com`, ids.user, encrypt(env.ctx.encKey, 'pw')]);
    const uid = r.rows[0]!.id;
    await env.pool.query("insert into profiles(id, user_id, name, is_owner) values ($1, $1, 'Lea', true) on conflict do nothing", [uid]);
    if (ids.profile) {
      await env.pool.query("insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username) values (gen_random_uuid(), $1, 'Kind', $2, 'kind')", [uid, ids.profile]);
    }
    return uid;
  };
  /** `n` referenced items (watchlist), the newest first: item i was added i minutes before now */
  const seedItems = async (uid: string, n: number, from = 0) => {
    const profile = (await env.pool.query<{ id: string }>('select id from profiles where user_id = $1 and is_owner', [uid])).rows[0]!.id;
    for (let i = from; i < from + n; i++) {
      await env.pool.query("insert into watchlist(profile_id, user_id, item_id, added_at) values ($1, $2, $3, now() - make_interval(mins => $4))", [profile, uid, hex(i + 1), i]);
    }
  };
  /** the server knows every linked user and `n` of the seeded items */
  const library = (opts: Record<string, unknown> = { SaveLocalMetadata: true, MetadataSavers: ['Nfo'] }) => {
    server.libs = [{ Name: 'Filme', ItemId: 'f'.repeat(32), Locations: ['/movies'], LibraryOptions: { EnableRealtimeMonitor: true, ...opts } }];
  };

  let offset = 0;
  const realNow = Date.now.bind(Date);
  beforeAll(async () => {
    // an updater found absent is remembered for 30 s: every test starts later than that
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    env = await makeEnv({}, { ctxPatch, seerr: reqRoutes });
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });
  beforeEach(async () => {
    offset += 60_000;
    resetFake();
    resetServer();
    resetReq();
    await env.ctx.settings.save({ JELLYFIN_URL: OLD, JELLYFIN_ADMIN_API_KEY: KEY, REQUESTS_URL: 'http://requests:5055', REQUESTS_API_KEY: REQ_KEY }, null);
    await env.pool.query("delete from audit_log; delete from media_managed; delete from users where authentik_sub like 'sub-move-%'; update users set jellyfin_user_id = ''; update profiles set jellyfin_user_id = null");
    for (const prefix of ['updater:pending:', 'media:move:', 'media:managed:']) for (const k of await env.kv.keys(prefix)) await env.kv.del(k);
  });

  it('phases advance copying → nfo → verify → switch → requests → done', async () => {
    const uid = await seedUser({ user: hex(0xa1), profile: hex(0xa2) });
    server.users = new Set([hex(0xa1), hex(0xa2)]);
    await seedItems(uid, 5);
    for (let i = 1; i <= 5; i++) server.items.add(hex(i));
    library();
    await seedMove('copying');
    // the copy still runs
    fake.job = job('mediaserver-migrate', 'running', COPY_JOB);
    fake.busy = true;
    fake.media.move = updMove('running');
    expect(await tick()).toBe('waiting');
    expect((await readManaged(env.pool)).move!.phase).toBe('copying');
    // copied: Ferrofin runs, the old Jellyfin is stopped
    fake.job = job('mediaserver-migrate', 'succeeded', COPY_JOB);
    fake.busy = false;
    fake.media.move = updMove('ready');
    expect(await run('done')).toEqual(['nfo', 'verify', 'switch', 'requests', 'done']);
    const m = await readManaged(env.pool);
    expect(m.move).toMatchObject({ phase: 'done', error: null, jobId: COPY_JOB });
    expect(m).toMatchObject({ kind: 'ferrofin', setup: 'done', setupError: null, externalUrl: OLD, migratedFrom: { name: 'jellyfin', version: '10.10.3' } });
    expect(opBodies('migrate-done')).toEqual([{ op: 'migrate-done' }]);
    expect(opBodies('migrate-abort')).toEqual([]);
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
    // the encoding for the move's GPU (none here: software), the other fields kept
    expect(server.encoding).toEqual({ EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'none', EnableTonemapping: true, TonemappingAlgorithm: 'bt2390', HardwareDecodingCodecs: [] });
    expect(opBodies('gpu')).toEqual([]);
    // every linked user checked, every item of the sample
    expect(calls('GET', `/Users/${hex(0xa1)}`)).toHaveLength(1);
    expect(calls('GET', `/Users/${hex(0xa2)}`)).toHaveLength(1);
    expect(calls('GET', '/Items').map((c) => c.query.get('ids')).sort()).toEqual([1, 2, 3, 4, 5].map(hex));
    // the switch is audited without an address or a key
    const audits = (await env.pool.query<{ action: string; meta: Record<string, unknown> }>("select action, meta from audit_log where action like 'mediaserver.%' order by id")).rows;
    expect(audits).toEqual([{ action: 'mediaserver.moved', meta: { name: 'jellyfin' } }, { action: 'mediaserver.requests_repointed', meta: { ok: true } }]);
    expect(JSON.stringify(audits)).not.toContain(KEY);
    // the request service follows
    expect(req.settings).toMatchObject(REQ_MANAGED);
    expect(m.requestsPrev).toEqual({ hostname: 'jellyfin.example.com', port: 8920, useSsl: true, urlBase: '/jf' });
    // nothing left to do
    expect(await tick()).toBe('idle');
  });

  it('nfo turns savers off only where on', async () => {
    server.libs = [
      { Name: 'Filme', ItemId: 'a'.repeat(32), Locations: ['/movies'], LibraryOptions: { EnableRealtimeMonitor: true, SaveLocalMetadata: true, MetadataSavers: ['Nfo'], PreferredMetadataLanguage: 'de' } },
      { Name: 'Serien', ItemId: 'b'.repeat(32), Locations: ['/tv'], LibraryOptions: { EnableRealtimeMonitor: false, SaveLocalMetadata: false, MetadataSavers: [] } },
      // no savers listed: the server's defaults apply (the NFO saver among them)
      { Name: 'Musik', ItemId: 'c'.repeat(32), Locations: ['/music'], LibraryOptions: { SaveLocalMetadata: false } },
      { Name: 'Doku', ItemId: 'd'.repeat(32), Locations: ['/docs'], LibraryOptions: { SaveLocalMetadata: true, MetadataSavers: [] } },
    ];
    await seedMove('nfo');
    expect(await tick()).toBe('verify');
    const posts = calls('POST', '/Library/VirtualFolders/LibraryOptions');
    expect(posts.map((c) => c.body)).toEqual([
      { Id: 'a'.repeat(32), LibraryOptions: { EnableRealtimeMonitor: true, SaveLocalMetadata: false, MetadataSavers: [], PreferredMetadataLanguage: 'de' } },
      { Id: 'c'.repeat(32), LibraryOptions: { SaveLocalMetadata: false, MetadataSavers: [] } },
      { Id: 'd'.repeat(32), LibraryOptions: { SaveLocalMetadata: false, MetadataSavers: [] } },
    ]);
    expect(posts.every((c) => c.token === KEY)).toBe(true);
    // the second library was left alone
    expect(server.libs[1]!.LibraryOptions).toEqual({ EnableRealtimeMonitor: false, SaveLocalMetadata: false, MetadataSavers: [] });
    // the same phase again (a restart after the posts): nothing more to post
    await seedMove('nfo');
    expect(await tick()).toBe('verify');
    expect(calls('POST', '/Library/VirtualFolders/LibraryOptions')).toHaveLength(3);
  });

  describe('verify failure aborts and restarts the source', () => {
    it('a linked user missing on Ferrofin', async () => {
      await seedUser({ user: hex(0xa1), profile: hex(0xa2) });
      await seedUser({ user: hex(0xb1) });
      server.users = new Set([hex(0xa1), hex(0xb1)]);
      library({ SaveLocalMetadata: false, MetadataSavers: [] });
      await seedMove('verify');
      expect(await tick()).toBe('failed');
      const m = await readManaged(env.pool);
      expect(m.move).toMatchObject({ phase: 'failed', error: 'ids_mismatch', errorMeta: { users: { total: 3, missing: 1 }, items: { sampled: 0, missing: 0 } } });
      expect(m.move!.abortPending).toBeUndefined();
      // the updater removes the new container and starts the old Jellyfin; FriendFlix is unchanged
      expect(opBodies('migrate-abort')).toEqual([{ op: 'migrate-abort' }]);
      expect(opBodies('migrate-done')).toEqual([]);
      expect(fake.media.move!.phase).toBe('aborted');
      expect(m).toMatchObject({ kind: null, setup: 'none', externalUrl: null, migratedFrom: null });
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
      expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe(KEY);
      // nothing follows a failed move
      expect(await tick()).toBe('idle');
      expect(opBodies('migrate-abort')).toHaveLength(1);
    });

    it('97 % of the item sample resolves', async () => {
      const uid = await seedUser({ user: hex(0xa1) });
      server.users = new Set([hex(0xa1)]);
      await seedItems(uid, 100);
      for (let i = 1; i <= 97; i++) server.items.add(hex(i));
      await seedMove('verify');
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'ids_mismatch', errorMeta: { users: { total: 1, missing: 0 }, items: { sampled: 100, missing: 3 } } });
      expect(opBodies('migrate-abort')).toHaveLength(1);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
    });

    it('a server that does not answer, and an abort the updater cannot take yet', async () => {
      await seedUser({ user: hex(0xa1) });
      server.up = false;
      fake.refuse['migrate-abort'] = 'busy';
      await seedMove('verify');
      // a server still starting: three more tries, then the abort
      for (let i = 1; i <= 3; i++) {
        expect(await tick()).toBe('waiting');
        expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'verify', tries: i });
      }
      expect(opBodies('migrate-abort')).toEqual([]);
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'unreachable', abortPending: true });
      expect((await readManaged(env.pool)).move!.tries).toBeUndefined();
      // the abort is sent again until the updater takes it
      expect(await tick()).toBe('failed');
      expect(opBodies('migrate-abort')).toHaveLength(2);
      delete fake.refuse['migrate-abort'];
      expect(await tick()).toBe('failed');
      expect(opBodies('migrate-abort')).toHaveLength(3);
      expect(fake.media.move!.phase).toBe('aborted');
      expect((await readManaged(env.pool)).move!.abortPending).toBeUndefined();
      expect(await tick()).toBe('idle');
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
    });
  });

  it('98 % passes', async () => {
    const uid = await seedUser({ user: hex(0xa1) });
    server.users = new Set([hex(0xa1)]);
    // 250 references: only the 200 newest are sampled; 4 of them are gone (deleted titles), the older ones all are
    await seedItems(uid, 250);
    for (let i = 1; i <= 200; i++) if (![3, 50, 120, 199].includes(i)) server.items.add(hex(i));
    await seedMove('verify');
    expect(await tick()).toBe('switch');
    expect(calls('GET', '/Items')).toHaveLength(200);
    expect(opBodies('migrate-abort')).toEqual([]);
    const client = new JellyfinClient(MANAGED, KEY, fetchImpl);
    expect(await verifyIds(env.ctx, client)).toEqual({ users: { total: 1, missing: 0 }, items: { sampled: 200, missing: 4 } });
  });

  it('the item sample draws from every table that holds a media server item id, newest first, each id once', async () => {
    const uid = await seedUser({ user: hex(0xa1) });
    server.users = new Set([hex(0xa1)]);
    const pid = (await env.pool.query<{ id: string }>('select id from profiles where user_id = $1', [uid])).rows[0]!.id;
    const q = (sql: string, p: unknown[]) => env.pool.query(sql, p);
    await q('insert into watchlist(profile_id, user_id, item_id) values ($1, $2, $3)', [pid, uid, hex(1)]);
    await q("insert into play_seconds(user_id, item_id, day, seconds, item_name) values ($1, $2, current_date, 60, 'x')", [uid, hex(2)]);
    const list = (await q("insert into lists(id, owner_id, name) values (gen_random_uuid(), $1, 'L') returning id", [uid])).rows[0].id;
    await q("insert into list_items(list_id, item_id, item_name) values ($1, $2, 'x')", [list, hex(3)]);
    await q("insert into bookmarks(id, user_id, profile_id, item_id, item_name, position_sec) values (gen_random_uuid(), $1, $2, $3, 'x', 1)", [uid, pid, hex(4)]);
    await q("insert into thumbs(profile_id, user_id, item_id, value, item_name) values ($1, $2, $3, 1, 'x')", [pid, uid, hex(5)]);
    await q("insert into ratings(user_id, item_id, item_name, stars) values ($1, $2, 'x', 4)", [uid, hex(6)]);
    await q("insert into reminders(user_id, kind, jf_item_id, title) values ($1, 'episode', $2, 'x')", [uid, hex(7)]);
    await q(`insert into livetv_recordings(id, profile_id, user_id, channel_name, title, start_at, end_at, pad_before_s, pad_after_s, state, storage, dir, jellyfin_item_id)
      values (gen_random_uuid(), $1, $2, 'Eins', 'x', now() - interval '2 hours', now() - interval '1 hour', 0, 0, 'done', 'library', gen_random_uuid(), $3)`, [pid, uid, hex(8)]);
    // the same item in two tables counts once; an id that is no media server item id is not sampled
    await q("insert into ratings(user_id, item_id, item_name, stars) values ($1, 'tmdb-123', 'x', 4)", [uid]);
    await q("insert into thumbs(profile_id, user_id, item_id, value, item_name) values ($1, $2, $3, 1, 'x')", [pid, uid, hex(1)]);
    const client = new JellyfinClient(MANAGED, KEY, fetchImpl);
    for (let i = 1; i <= 8; i++) server.items.add(hex(i));
    const r = await verifyIds(env.ctx, client);
    expect(r.users).toEqual({ total: 1, missing: 0 });
    expect(r.items).toEqual({ sampled: 8, missing: 0 });
    expect(calls('GET', '/Items').map((c) => c.query.get('ids')).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(hex));
  });

  describe('hardware encoding in the nfo phase (c2)', () => {
    it('the move\'s GPU: the detected render node and vendor, again after a restart', async () => {
      library({ SaveLocalMetadata: false, MetadataSavers: [] });
      fake.media.desired!.gpu = 'dri';
      await seedMove('nfo');
      expect(await tick()).toBe('verify');
      expect(opBodies('gpu')).toEqual([{ op: 'gpu' }]);
      expect(server.encoding).toMatchObject({ EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'qsv', VaapiDevice: '/dev/dri/renderD129', EnableTonemapping: true });
      // the same phase again: the same settings
      const first = structuredClone(server.encoding);
      await seedMove('nfo');
      expect(await tick()).toBe('verify');
      expect(server.encoding).toEqual(first);
    });

    it('the savers first, a few libraries per tick; the encoding once none is left', async () => {
      server.libs = Array.from({ length: 8 }, (_, i) => ({ Name: `L${i}`, ItemId: hex(0xf00 + i), Locations: [`/m${i}`], LibraryOptions: { SaveLocalMetadata: true } }));
      await seedMove('nfo');
      expect(await tick()).toBe('waiting');
      expect(calls('POST', '/Library/VirtualFolders/LibraryOptions')).toHaveLength(6);
      expect(calls('POST', '/System/Configuration/encoding')).toEqual([]);
      expect(await tick()).toBe('verify');
      expect(calls('POST', '/Library/VirtualFolders/LibraryOptions')).toHaveLength(8);
      expect(calls('POST', '/System/Configuration/encoding')).toHaveLength(1);
    });

    it('an encoding failure counts like any nfo failure: retried, then the abort', async () => {
      library({ SaveLocalMetadata: false, MetadataSavers: [] });
      server.fail = (c) => (c.path === '/System/Configuration/encoding' && c.method === 'POST' ? 503 : null);
      await seedMove('nfo');
      expect([await tick(), await tick(), await tick()]).toEqual(['waiting', 'waiting', 'waiting']);
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'unexpected' });
      expect(opBodies('migrate-abort')).toHaveLength(1);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
    });

    it('a GPU detection the updater refuses aborts at once; one it cannot answer is retried', async () => {
      library({ SaveLocalMetadata: false, MetadataSavers: [] });
      fake.media.desired!.gpu = 'dri';
      fake.refuse.gpu = 'no_network';
      await seedMove('nfo');
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'no_network' });
      resetFake();
      fake.media.desired!.gpu = 'dri';
      fake.refuse.gpu = 'unreachable_answer';
      await seedMove('nfo');
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'nfo', tries: 1 });
      delete fake.refuse.gpu;
      expect(await tick()).toBe('verify');
      // the next phase starts its tries over
      expect((await readManaged(env.pool)).move!.tries).toBeUndefined();
    });
  });

  describe('a server still starting (m2, m6)', () => {
    it('two 503s, then the check passes', async () => {
      await seedUser({ user: hex(0xa1) });
      server.users = new Set([hex(0xa1)]);
      let n = 0;
      server.fail = (c) => (c.path.startsWith('/Users/') && ++n <= 2 ? 503 : null);
      await seedMove('verify');
      expect(await tick()).toBe('waiting');
      expect(await tick()).toBe('waiting');
      expect(await tick()).toBe('switch');
      expect((await readManaged(env.pool)).move!.tries).toBeUndefined();
      expect(opBodies('migrate-abort')).toEqual([]);
    });

    it('5xx on every lookup: never counted missing, the fourth failure aborts', async () => {
      const uid = await seedUser({ user: hex(0xa1) });
      server.users = new Set([hex(0xa1)]);
      await seedItems(uid, 3);
      for (let i = 1; i <= 3; i++) server.items.add(hex(i));
      server.fail = (c) => (c.path === '/Items' ? 500 : null);
      await seedMove('verify');
      expect([await tick(), await tick(), await tick()]).toEqual(['waiting', 'waiting', 'waiting']);
      expect(await tick()).toBe('failed');
      const m = await readManaged(env.pool);
      expect(m.move).toMatchObject({ phase: 'failed', error: 'unreachable' });
      expect(m.move!.errorMeta).toBeUndefined();
      expect(opBodies('migrate-abort')).toHaveLength(1);
      // the same for the user lookup
      resetFake();
      server.fail = (c) => (c.path.startsWith('/Users/') ? 502 : null);
      await seedMove('verify');
      expect([await tick(), await tick(), await tick(), await tick()]).toEqual(['waiting', 'waiting', 'waiting', 'failed']);
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'unreachable' });
      expect((await readManaged(env.pool)).move!.errorMeta).toBeUndefined();
    });

    it('no item referenced and every user present: the check passes', async () => {
      await seedUser({ user: hex(0xa1), profile: hex(0xa2) });
      server.users = new Set([hex(0xa1), hex(0xa2)]);
      await seedMove('verify');
      expect(await tick()).toBe('switch');
      expect(calls('GET', '/Items')).toEqual([]);
      const client = new JellyfinClient(MANAGED, KEY, fetchImpl);
      expect(await verifyIds(env.ctx, client)).toEqual({ users: { total: 2, missing: 0 }, items: { sampled: 0, missing: 0 } });
    });
  });

  it('the sample ranks ids, not rows: one id referenced on many days never crowds the others out (m1)', async () => {
    const uid = await seedUser({ user: hex(0xa1) });
    server.users = new Set([hex(0xa1)]);
    // watch time: items 1–3 on each of the last 300 days, items 4–250 once, before that
    await env.pool.query(`insert into play_seconds(user_id, item_id, day, seconds, item_name)
      select $1, lpad(to_hex(i), 32, '0'), current_date - d, 60, 'x' from generate_series(1, 3) i, generate_series(0, 299) d`, [uid]);
    await env.pool.query(`insert into play_seconds(user_id, item_id, day, seconds, item_name)
      select $1, lpad(to_hex(i), 32, '0'), current_date - 300 - i, 60, 'x' from generate_series(4, 250) i`, [uid]);
    for (let i = 1; i <= 250; i++) server.items.add(hex(i));
    const client = new JellyfinClient(MANAGED, KEY, fetchImpl);
    expect(await verifyIds(env.ctx, client)).toEqual({ users: { total: 1, missing: 0 }, items: { sampled: 200, missing: 0 } });
    expect(calls('GET', '/Items').map((c) => c.query.get('ids')).sort()).toEqual(Array.from({ length: 200 }, (_, i) => hex(i + 1)));
  });

  it('the way back is the stored address, read in the switch transaction (m4)', async () => {
    await seedMove('switch');
    // another instance saved a new address that this one has not reloaded yet
    await env.pool.query("update settings set value = to_jsonb('http://jellyfin2.example.com:8096'::text) where key = 'JELLYFIN_URL'");
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
    expect(await tick()).toBe('requests');
    expect((await readManaged(env.pool)).externalUrl).toBe('http://jellyfin2.example.com:8096');
    expect(await externalKey(env.ctx)).toBe(KEY);
  });

  it('migrate-done refused after the commit: delivered only without a move, a warning for an aborted one (m5)', async () => {
    await seedMove('switch');
    fake.refuse['migrate-done'] = 'busy';
    expect(await tick()).toBe('waiting');
    // the updater still settles a move: wait
    fake.refuse['migrate-done'] = 'no_target';
    fake.media.move = updMove('running');
    expect(await tick()).toBe('waiting');
    expect((await readManaged(env.pool)).move!.phase).toBe('switch');
    // it shows the move aborted: the switch stands, with the warning (the way back applies)
    fake.media.move = updMove('aborted');
    expect(await tick()).toBe('requests');
    expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'requests', errorMeta: { warning: 'updater_aborted' } });
    expect(await tick()).toBe('done');
    expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'done', errorMeta: { warning: 'updater_aborted' } });
    expect(opBodies('migrate-abort')).toEqual([]);
  });

  it('switch keeps the key and saves the way back', async () => {
    await seedUser({ user: hex(0xa1) });
    await seedMove('switch');
    expect(await tick()).toBe('requests');
    const m = await readManaged(env.pool);
    expect(m).toMatchObject({ kind: 'ferrofin', setup: 'done', setupError: null, externalUrl: OLD, hasExternalKey: true });
    expect(m.migratedFrom).toMatchObject({ name: 'jellyfin', version: '10.10.3' });
    expect(await externalKey(env.ctx)).toBe(KEY);
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
    expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe(KEY);
    expect(opBodies('migrate-done')).toEqual([{ op: 'migrate-done' }]);
    expect(fake.media.move).toBeNull();
    // the key and the server id never reach the move record or a log line
    expect(JSON.stringify(m)).not.toContain(KEY);
  });

  describe('the request service (spec "The move" 10)', () => {
    const prevRow = async () => (await env.pool.query<{ p: unknown }>('select requests_prev as p from media_managed where id = 1')).rows[0]?.p;

    it('requests repointed and synced, previous saved', async () => {
      await seedMove('switch');
      expect(await tick()).toBe('requests');
      expect(await tick()).toBe('done');
      // its Jellyfin connection names the managed server; its key, libraries, server id and public address stay as they were
      expect(req.settings).toEqual({ ...reqSettings(), ...REQ_MANAGED });
      // only the connection is sent: never a key in the body, FriendFlix's request-service key in the header
      expect(reqCalls('POST', '/settings/jellyfin').map((c) => c.body)).toEqual([REQ_MANAGED]);
      expect(req.calls.every((c) => c.key === REQ_KEY)).toBe(true);
      // the library list synced, then the scan started
      expect(req.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /settings/jellyfin', 'POST /settings/jellyfin', 'POST /settings/jellyfin/library/sync', 'POST /settings/jellyfin/sync']);
      expect(reqCalls('POST', '/settings/jellyfin/sync')[0]!.body).toEqual({ start: true });
      // the previous connection saved for the way back, without a key
      const m = await readManaged(env.pool);
      expect(m.requestsPrev).toEqual({ hostname: 'jellyfin.example.com', port: 8920, useSsl: true, urlBase: '/jf' });
      expect(JSON.stringify(await prevRow())).not.toMatch(/key-/);
      expect(m.move).toMatchObject({ phase: 'done', requestsWarning: false });
      expect((await env.pool.query("select meta from audit_log where action = 'mediaserver.requests_repointed'")).rows).toEqual([{ meta: { ok: true } }]);
      expect(opBodies('migrate-done')).toEqual([{ op: 'migrate-done' }]);
      // run again (a restart before the phase was recorded): the saved connection is the old one, never the managed server
      await seedMove('requests');
      expect(await tick()).toBe('done');
      expect((await readManaged(env.pool)).requestsPrev).toEqual({ hostname: 'jellyfin.example.com', port: 8920, useSsl: true, urlBase: '/jf' });
      expect(req.settings).toMatchObject(REQ_MANAGED);
      expect(opBodies('migrate-done')).toHaveLength(1);
    });

    it('request service refuses: move done with a warning', async () => {
      const warned = async () => {
        const m = await readManaged(env.pool);
        expect(m.move).toMatchObject({ phase: 'done', error: null, requestsWarning: true });
        expect(m).toMatchObject({ kind: 'ferrofin', migratedFrom: { name: 'jellyfin' } });
        expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
        expect(opBodies('migrate-abort')).toEqual([]);
        const a = (await env.pool.query("select meta from audit_log where action = 'mediaserver.requests_repointed'")).rows;
        expect(a).toEqual([{ meta: { ok: false } }]);
        await env.pool.query('delete from audit_log');
      };
      // it refuses the new connection (it could not reach the server it names)
      await seedMove('switch');
      req.fail['POST /settings/jellyfin'] = 500;
      expect(await run('done')).toEqual(['requests', 'done']);
      await warned();
      expect(req.settings).toEqual(reqSettings());
      expect(opBodies('migrate-done')).toEqual([{ op: 'migrate-done' }]);
      // its API differs (no such settings): nothing sent, nothing saved
      resetReq();
      await writeManaged(env.ctx, { requestsPrev: null });
      await seedMove('requests');
      req.fail['GET /settings/jellyfin'] = 404;
      expect(await tick()).toBe('done');
      await warned();
      expect(reqCalls('POST', '/settings/jellyfin')).toEqual([]);
      expect((await readManaged(env.pool)).requestsPrev).toBeNull();
      // its connection is not one it could be pointed back to (no Jellyfin set up there): left alone
      resetReq();
      req.settings = { ...reqSettings(), ip: '' };
      await seedMove('requests');
      expect(await tick()).toBe('done');
      await warned();
      expect(reqCalls('POST', '/settings/jellyfin')).toEqual([]);
      // pointed over, but the sync is refused: still a warning (its libraries may be stale)
      resetReq();
      await seedMove('requests');
      req.fail['POST /settings/jellyfin/library/sync'] = 404;
      expect(await tick()).toBe('done');
      await warned();
      expect(req.settings).toMatchObject(REQ_MANAGED);
      expect((await readManaged(env.pool)).requestsPrev).toEqual({ hostname: 'jellyfin.example.com', port: 8920, useSsl: true, urlBase: '/jf' });
    });

    it('no request service: skipped', async () => {
      await env.ctx.settings.save({ REQUESTS_URL: null }, null);
      expect(env.ctx.seerr).toBeNull();
      await seedMove('switch');
      expect(await run('done')).toEqual(['requests', 'done']);
      const m = await readManaged(env.pool);
      expect(m.move).toMatchObject({ phase: 'done', requestsWarning: false });
      expect(m.requestsPrev).toBeNull();
      expect(req.calls).toEqual([]);
      expect((await env.pool.query("select 1 from audit_log where action = 'mediaserver.requests_repointed'")).rowCount).toBe(0);
    });
  });

  describe('a phase found running after a backend restart resumes or aborts', () => {
    it('copying: the copy ended while the backend was down', async () => {
      // ready: on to the backend's phases
      await seedMove('copying');
      fake.job = job('mediaserver-supervise', 'succeeded'); // a later job hides the copy's
      expect(await tick()).toBe('nfo');
      // the copy failed (the updater started the source again): the move has failed with its code, nothing to abort
      await seedMove('copying');
      fake.media.move = updMove('aborted');
      fake.media.error = 'source_mismatch';
      fake.job = job('mediaserver-migrate', 'failed', COPY_JOB);
      fake.job.error = 'source_mismatch';
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'source_mismatch' });
      expect(opBodies('migrate-done')).toEqual([]);
      // the copy's job failed before the move was recorded (its check)
      await seedMove('copying');
      fake.media.move = null;
      fake.job = job('mediaserver-migrate', 'failed', COPY_JOB);
      fake.job.error = 'no_space';
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'no_space' });
      // the updater restarted before it recorded the move: nothing was stopped
      await seedMove('copying');
      fake.job = null;
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'interrupted' });
      // an updater that is not there: wait
      await seedMove('copying');
      fake.up = false;
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move!.phase).toBe('copying');
    });

    it('nfo and verify run again; an updater whose move is no longer ready ends the move', async () => {
      await seedUser({ user: hex(0xa1) });
      server.users = new Set([hex(0xa1)]);
      library();
      await seedMove('nfo');
      expect(await tick()).toBe('verify');
      expect(await tick()).toBe('switch');
      // a move the updater aborted on its own meanwhile (the source runs again): failed, never switched
      await seedMove('verify');
      fake.media.move = updMove('aborted');
      fake.media.error = 'move_aborted';
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'move_aborted' });
      expect(opBodies('migrate-done')).toEqual([]);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
      // an updater job running (an abort): wait
      await seedMove('verify');
      fake.media.move = updMove('ready');
      fake.busy = true;
      expect(await tick()).toBe('waiting');
    });

    it('switch: a committed switch is not repeated, only migrate-done is sent again', async () => {
      await seedUser({ user: hex(0xa1) });
      await seedMove('switch');
      fake.refuse['migrate-done'] = 'busy';
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move!.phase).toBe('switch');
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
      // the restart: the switch is found committed; the way back keeps the old address (never the managed one)
      delete fake.refuse['migrate-done'];
      expect(await tick()).toBe('requests');
      const m = await readManaged(env.pool);
      expect(m.externalUrl).toBe(OLD);
      expect(await externalKey(env.ctx)).toBe(KEY);
      expect(opBodies('migrate-done')).toHaveLength(2);
      expect((await env.pool.query("select 1 from audit_log where action = 'mediaserver.moved'")).rowCount).toBe(1);
      // migrate-done sent before the restart, its answer lost: the updater has no move left, the switch stands
      await seedMove('switch');
      expect(await tick()).toBe('requests');
      expect(opBodies('migrate-abort')).toEqual([]);
      expect(await run('done')).toEqual(['done']);
    });

    it('switch: a switch that cannot be made aborts while FriendFlix is unchanged', async () => {
      await seedMove('switch');
      await env.ctx.settings.save({ JELLYFIN_ADMIN_API_KEY: null }, null);
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'unexpected' });
      expect(opBodies('migrate-abort')).toHaveLength(1);
      expect(opBodies('migrate-done')).toEqual([]);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
      expect((await readManaged(env.pool)).kind).toBeNull();
    });

    it('an abort written meanwhile is never overwritten, and no switch follows it', async () => {
      await seedUser({ user: hex(0xa1) });
      server.users = new Set([hex(0xa1)]);
      await seedMove('verify');
      // the admin's abort lands while the check runs
      server.before = async () => {
        server.before = null;
        const m = await readManaged(env.pool);
        await writeManaged(env.ctx, { move: { ...m.move!, phase: 'failed', error: 'move_aborted' } });
      };
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'move_aborted' });
      expect(await tick()).toBe('idle');
      expect(opBodies('migrate-done')).toEqual([]);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
    });

    it('one tick at a time (the lock)', async () => {
      await seedMove('nfo');
      await env.kv.set(MOVE_LOCK, 'other', 60);
      expect(await tick()).toBe('locked');
      expect((await readManaged(env.pool)).move!.phase).toBe('nfo');
    });
  });

  it('the abort route waits for the tick and refuses while it runs', async () => {
    const admin = await env.login(ADMIN);
    await seedMove('verify');
    await env.kv.set(MOVE_LOCK, 'other', 60);
    const r = await env.app.inject({ method: 'POST', url: '/api/admin/mediaserver/move/abort', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'busy' });
    expect(opBodies('migrate-abort')).toEqual([]);
    await env.kv.del(MOVE_LOCK);
    const ok = await env.app.inject({ method: 'POST', url: '/api/admin/mediaserver/move/abort', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf } });
    expect(ok.statusCode).toBe(202);
    expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'move_aborted' });
    expect(await env.kv.get(MOVE_LOCK)).toBeNull();
  }, 20_000);
  it('nfo gives up after 20 ticks of a saver that stays on (abort, unexpected)', async () => {
    // more libraries than one tick changes, and the server takes each change but keeps reporting the saver on
    server.libs = Array.from({ length: 8 }, (_, i) => ({ Name: `L${i}`, ItemId: hex(0xf00 + i), Locations: [`/m${i}`], LibraryOptions: { SaveLocalMetadata: true } }));
    server.fail = (c) => (c.path === '/Library/VirtualFolders/LibraryOptions' ? 204 : null);
    await seedMove('nfo');
    // the first tick leaves 2 of 8 on: progress, not counted
    expect(await tick()).toBe('waiting');
    expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'nfo', nfoLeft: 2 });
    expect((await readManaged(env.pool)).move!.rounds).toBeUndefined();
    for (let i = 1; i < 20; i++) {
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'nfo', rounds: i, nfoLeft: 2 });
    }
    expect(await tick()).toBe('failed');
    const m = await readManaged(env.pool);
    expect(m.move).toMatchObject({ phase: 'failed', error: 'unexpected' });
    expect(m.move!.rounds).toBeUndefined();
    expect(m.move!.nfoLeft).toBeUndefined();
    expect(opBodies('migrate-abort')).toHaveLength(1);
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
  });

  it('nfo with 130 libraries: every tick leaves fewer on, so the cap never counts and the phase ends', async () => {
    server.libs = Array.from({ length: 130 }, (_, i) => ({ Name: `L${i}`, ItemId: hex(0x1000 + i), Locations: [`/m${i}`], LibraryOptions: { SaveLocalMetadata: true } }));
    await seedMove('nfo');
    const seen: string[] = [];
    for (let i = 0; i < 30 && seen.at(-1) !== 'verify'; i++) seen.push(await tick());
    expect(seen).toEqual([...Array(21).fill('waiting'), 'verify']);
    expect(calls('POST', '/Library/VirtualFolders/LibraryOptions')).toHaveLength(130);
    expect((await readManaged(env.pool)).move!.rounds).toBeUndefined();
  });

  describe('the way back and the user repair', () => {
    const MOVED_AT = '2026-11-24T10:00:00.000Z';
    /** a profile of `uid` linked to media server user `id`, with its own stored password */
    const seedProfile = async (uid: string, id: string, name: string, pw: string, kids = false) => {
      const r = await env.pool.query<{ id: string }>(`insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
        values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 6) returning id`, [uid, name.slice(0, 20), id, name, encrypt(env.ctx.encKey, pw), kids]);
      return r.rows[0]!.id;
    };
    const profileRow = async (pid: string) => (await env.pool.query<{ jellyfin_user_id: string; jellyfin_username: string }>(
      'select jellyfin_user_id, jellyfin_username from profiles where id = $1', [pid])).rows[0]!;
    /** FriendFlix after a move: the managed Ferrofin in use, the old Jellyfin stored as the way back and stopped */
    const seedMoved = async (move: Record<string, unknown> = {}) => {
      await env.ctx.settings.save({ JELLYFIN_URL: MANAGED, JELLYFIN_ADMIN_API_KEY: KEY }, null);
      await writeManaged(env.ctx, {
        kind: 'ferrofin', setup: 'done', externalUrl: OLD, externalKey: OLD_KEY, migratedFrom: { name: 'jellyfin', version: '10.10.3', at: MOVED_AT },
        move: { phase: 'done', error: null, jobId: COPY_JOB, startedAt: START, requestsWarning: false, ...move } as never,
      });
      fake.media.move = null;
      fake.job = job('mediaserver-migrate', 'succeeded', COPY_JOB);
      // the old Jellyfin is stopped: it answers once the source job started it
      old.before = async () => { if (fake.media.source?.state !== 'running') throw new TypeError('fetch failed'); };
    };
    const back = (o: Record<string, number> = {}) => goBack(env.ctx, null, { waitMs: 3_000, stepMs: 5, lockWaitMs: 0, ...o });

    /** the account `uid` and its profiles: on Jellyfin as before the move, plus what Ferrofin got since */
    const seedAccounts = async () => {
      const uid = await seedUser({ user: hex(0xa1) });
      const kept = await seedProfile(uid, hex(0xa2), 'lea-kind', 'pw-a2');
      // created on Ferrofin since the move: unknown to Jellyfin; a kids profile keeps its cap there
      const fresh = await seedProfile(uid, hex(0xb2), 'lea-neu', 'pw-b2', true);
      // a user of that name and password is on Jellyfin already (an earlier repair that stopped before it stored the id)
      const adopted = await seedProfile(uid, hex(0xc2), 'lea-alt', 'pw-c2');
      // the name is taken on Jellyfin by someone else (another password): a suffixed name
      const clashed = await seedProfile(uid, hex(0xd2), 'lea-zwei', 'pw-d2');
      for (const [id, name, pw] of [[hex(0xa1), 'lea', 'pw-old'], [hex(0xa2), 'lea-kind', 'pw-old'], [hex(0xc9), 'lea-alt', 'pw-c2'], [hex(0xd9), 'lea-zwei', 'other']] as const) {
        old.users.add(id);
        old.accounts.set(id, { name, pw, policy: {} });
      }
      return { uid, kept, fresh, adopted, clashed };
    };

    it('way back recreates missing users and resets passwords', async () => {
      const { kept, fresh, adopted, clashed } = await seedAccounts();
      await seedMoved();
      for (const k of [`jft:${fresh}`, `jft:${kept}`]) await env.kv.set(k, 'cached', 600);
      expect(await back()).toEqual({ ok: true });
      // the old Jellyfin started, FriendFlix on it with the stored address and key, the managed server stopped
      expect(opBodies('source-start')).toEqual([{ op: 'source-start' }]);
      expect(opBodies('stop')).toEqual([{ op: 'stop' }]);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
      expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe(OLD_KEY);
      const m = await readManaged(env.pool);
      expect(m).toMatchObject({ kind: null, setup: 'none', migratedFrom: null, externalUrl: OLD });
      expect(m.move).toMatchObject({ phase: 'done', back: 'done' });
      // every linked password set again from the stored one
      expect(old.accounts.get(hex(0xa1))!.pw).toBe('pw');
      expect(old.accounts.get(hex(0xa2))!.pw).toBe('pw-a2');
      expect((await profileRow(kept)).jellyfin_user_id).toBe(hex(0xa2));
      // the profile made on Ferrofin has a Jellyfin user now, hidden, with the kids cap and its password; its old token is gone
      const f = await profileRow(fresh);
      expect(f.jellyfin_user_id).not.toBe(hex(0xb2));
      expect(old.accounts.get(f.jellyfin_user_id)).toMatchObject({ name: 'lea-neu', pw: 'pw-b2', policy: { IsHidden: true, MaxParentalRating: 6, IsAdministrator: false } });
      expect(await env.kv.get(`jft:${fresh}`)).toBeNull();
      // the same name and password on Jellyfin: that user, its policy written again
      expect(await profileRow(adopted)).toEqual({ jellyfin_user_id: hex(0xc9), jellyfin_username: 'lea-alt' });
      expect(old.accounts.get(hex(0xc9))!.policy).toMatchObject({ IsHidden: true, IsAdministrator: false });
      // the name taken by another user: a new one with a suffix, the other one untouched
      const c = await profileRow(clashed);
      expect(c.jellyfin_username).toMatch(/^lea-zwei\d{3}$/);
      expect(old.accounts.get(c.jellyfin_user_id)).toMatchObject({ name: c.jellyfin_username, pw: 'pw-d2' });
      expect(old.accounts.get(hex(0xd9))).toEqual({ name: 'lea-zwei', pw: 'other', policy: {} });
      // never a user deleted, nothing on Ferrofin changed
      expect([...old.calls, ...server.calls].filter((x) => x.method === 'DELETE')).toEqual([]);
      expect(server.calls.filter((x) => x.method === 'POST')).toEqual([]);
      // audited once, without an address or a key
      const audits = (await env.pool.query<{ action: string; meta: Record<string, unknown> }>("select action, meta from audit_log where action = 'mediaserver.back'")).rows;
      expect(audits).toEqual([{ action: 'mediaserver.back', meta: { name: 'jellyfin' } }]);
      expect(JSON.stringify(await env.pool.query('select meta from audit_log'))).not.toMatch(/key-|pw-|example\.com/);
      // every linked profile resolves on the Jellyfin in use
      const client = new JellyfinClient(OLD, OLD_KEY, fetchImpl);
      expect((await verifyIds(env.ctx, client)).users).toEqual({ total: 5, missing: 0 });
      // nothing left for the tick; a second way back has nothing to go back from
      expect(await tick()).toBe('idle');
      expect(await back()).toEqual({ ok: false, error: 'not_moved' });
    });

    it('way back restores the previous connection', async () => {
      const PREV = { hostname: 'jellyfin.example.com', port: 8920, useSsl: true, urlBase: '/jf' };
      const audits = async () => (await env.pool.query("select meta from audit_log where action = 'mediaserver.requests_repointed' order by id")).rows.map((r) => r.meta);
      await seedAccounts();
      // moved: the request service points at the managed server
      const moved = async () => {
        await seedMoved();
        await writeManaged(env.ctx, { requestsPrev: PREV });
        req.settings = { ...reqSettings(), ...REQ_MANAGED };
        req.calls = [];
        await env.pool.query('delete from audit_log');
      };
      await moved();
      expect(await back()).toEqual({ ok: true });
      expect(req.settings).toEqual(reqSettings());
      expect(reqCalls('POST', '/settings/jellyfin').map((c) => c.body)).toEqual([{ ip: 'jellyfin.example.com', port: 8920, useSsl: true, urlBase: '/jf' }]);
      expect(reqCalls('POST', '/settings/jellyfin/library/sync')).toHaveLength(1);
      expect(reqCalls('POST', '/settings/jellyfin/sync')).toHaveLength(1);
      let m = await readManaged(env.pool);
      expect(m.move).toMatchObject({ back: 'done', requestsWarning: false });
      expect(m.requestsPrev).toBeNull();
      expect(await audits()).toEqual([{ ok: true, back: true }]);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);

      // the request service refuses: the way back still finishes, with the warning; the saved connection is kept (the manual step)
      // (the old Jellyfin keeps the users the first way back left there)
      resetFake();
      await moved();
      req.fail['POST /settings/jellyfin'] = 500;
      // the managed server's stop is refused at first: the tick finishes the way back, the request service is tried once
      fake.refuse.stop = 'busy';
      expect(await back()).toEqual({ ok: true });
      expect((await readManaged(env.pool)).move).toMatchObject({ back: 'switched', requestsWarning: true });
      delete fake.refuse.stop;
      expect(await tick()).toBe('done');
      m = await readManaged(env.pool);
      expect(m.move).toMatchObject({ back: 'done', requestsWarning: true });
      expect(m.requestsPrev).toEqual(PREV);
      expect(reqCalls('POST', '/settings/jellyfin')).toHaveLength(1);
      expect(await audits()).toEqual([{ ok: false, back: true }]);

      // the request service no longer names the managed server (changed by hand, or never pointed over): left as it is
      resetFake();
      await moved();
      req.settings = reqSettings();
      req.settings.ip = 'other.example.com';
      expect(await back()).toEqual({ ok: true });
      expect(req.settings.ip).toBe('other.example.com');
      expect(reqCalls('POST', '/settings/jellyfin')).toEqual([]);
      expect((await readManaged(env.pool)).move).toMatchObject({ back: 'done', requestsWarning: false });
      expect(await audits()).toEqual([]);
    });

    it('repairUsers again finds nothing to create and sets the passwords once more', async () => {
      await seedAccounts();
      await seedMoved();
      expect(await back()).toEqual({ ok: true });
      const posts = calls('POST', '/Users/New', old).length;
      expect(await repairUsers(env.ctx)).toEqual({ created: 0, passwords: 5 });
      expect(calls('POST', '/Users/New', old)).toHaveLength(posts);
    });

    it('way back refuses when the old Jellyfin does not answer, nothing switched', async () => {
      const { fresh } = await seedAccounts();
      const unchanged = async (error: string) => {
        expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
        expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe(KEY);
        const m = await readManaged(env.pool);
        expect(m).toMatchObject({ kind: 'ferrofin', setup: 'done', migratedFrom: { name: 'jellyfin' } });
        expect(m.move).toMatchObject({ phase: 'done', back: 'failed', backError: error });
        expect(opBodies('stop')).toEqual([]);
        expect(calls('POST', '/Users/New', old)).toEqual([]);
        expect((await profileRow(fresh)).jellyfin_user_id).toBe(hex(0xb2));
        expect((await env.pool.query("select 1 from audit_log where action = 'mediaserver.back'")).rowCount).toBe(0);
      };
      // started, but it never answers
      await seedMoved();
      old.before = async () => { throw new TypeError('fetch failed'); };
      expect(await back({ waitMs: 200 })).toEqual({ ok: false, error: 'jellyfin_unreachable' });
      await unchanged('jellyfin_unreachable');
      // it answers, but not to the stored key
      resetFake();
      await seedMoved();
      old.key = 'other';
      expect(await back()).toEqual({ ok: false, error: 'jellyfin_unreachable' });
      await unchanged('jellyfin_unreachable');
      old.key = OLD_KEY;
      // the old container is gone (the stage 1 way back applies), or the updater cannot tell it
      resetFake();
      await seedMoved();
      fake.media.source = null;
      expect(await back()).toEqual({ ok: false, error: 'source_missing' });
      await unchanged('source_missing');
      resetFake();
      await seedMoved();
      fake.sourceError = 'source_mismatch';
      expect(await back()).toEqual({ ok: false, error: 'source_mismatch' });
      await unchanged('source_mismatch');
      // the move's tick holds the lock: busy, nothing written
      resetFake();
      await seedMoved();
      await env.kv.set(MOVE_LOCK, 'other', 60);
      expect(await back()).toEqual({ ok: false, error: 'busy' });
      expect(opBodies('source-start')).toEqual([]);
      expect((await readManaged(env.pool)).move!.back).toBeUndefined();
      await env.kv.del(MOVE_LOCK);
      // a move under way
      await seedMoved({ phase: 'requests' });
      expect(await back()).toEqual({ ok: false, error: 'busy' });
      expect(opBodies('source-start')).toEqual([]);
    });

    it('works from the stored way back when the managed server is gone (the updater dropped the move)', async () => {
      await seedAccounts();
      await seedMoved({ errorMeta: { warning: 'updater_aborted' } });
      fake.media.container = null;
      fake.media.desired = null;
      expect(await back()).toEqual({ ok: true });
      // nothing to stop
      expect(opBodies('stop')).toEqual([]);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
      expect((await readManaged(env.pool)).move).toMatchObject({ back: 'done' });
    });

    it('a way back found unfinished after a restart: resumed once switched, reported before', async () => {
      const { fresh } = await seedAccounts();
      // the switch committed, then the backend stopped: the tick stops the managed server and repairs the users
      await seedMoved({ back: 'switched' });
      await env.ctx.settings.save({ JELLYFIN_URL: OLD, JELLYFIN_ADMIN_API_KEY: OLD_KEY }, null);
      await writeManaged(env.ctx, { kind: null, setup: 'none', migratedFrom: null });
      fake.media.source = { ...fake.media.source, state: 'running' };
      fake.refuse.stop = 'busy';
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move!.back).toBe('switched');
      delete fake.refuse.stop;
      // a stop job that fails is not taken as stopped: sent again on the next tick
      fake.stopError = 'start_failed';
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move!.back).toBe('switched');
      expect(calls('POST', '/Users/New', old)).toEqual([]);
      fake.stopError = null;
      expect(await tick()).toBe('done');
      expect(opBodies('stop')).toHaveLength(3);
      expect((await readManaged(env.pool)).move!.back).toBe('done');
      expect(old.users.has((await profileRow(fresh)).jellyfin_user_id)).toBe(true);
      expect(await tick()).toBe('idle');
      // a repair that fails is tried again on the next tick
      await seedMoved({ back: 'stopped' });
      await env.ctx.settings.save({ JELLYFIN_URL: OLD, JELLYFIN_ADMIN_API_KEY: OLD_KEY }, null);
      await writeManaged(env.ctx, { kind: null, setup: 'none', migratedFrom: null });
      old.before = null;
      old.up = true;
      old.fail = (c) => (c.path.endsWith('/Password') ? 503 : null);
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move!.back).toBe('stopped');
      old.fail = null;
      expect(await tick()).toBe('done');
      // before the switch (the old Jellyfin may run, FriendFlix is unchanged): reported, never switched by the tick
      resetFake();
      await seedMoved({ back: 'starting' });
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ back: 'failed', backError: 'interrupted' });
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
      expect(opBodies('stop')).toEqual([]);
      expect(await tick()).toBe('idle');
      // the admin's next click goes back
      expect(await back()).toEqual({ ok: true });
    });

    /** FriendFlix switched back, the stop done: only the repair is left (the tick's part) */
    const seedStopped = async () => {
      await seedMoved({ back: 'stopped' });
      await env.ctx.settings.save({ JELLYFIN_URL: OLD, JELLYFIN_ADMIN_API_KEY: OLD_KEY }, null);
      await writeManaged(env.ctx, { kind: null, setup: 'none', migratedFrom: null });
      old.before = null;
    };

    it('POST /back answers 202 and the page follows the way back to its end; a refusal shows in the view', async () => {
      const admin = await env.login(ADMIN);
      const key = sessionKey(admin.cookies.ff_sid!);
      await env.kv.set(key, JSON.stringify({ ...JSON.parse((await env.kv.get(key))!), reauthAt: Date.now() }), 600);
      const post = () => env.app.inject({ method: 'POST', url: '/api/admin/mediaserver/back', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf } });
      const state = async () => (await env.app.inject({ method: 'GET', url: '/api/admin/mediaserver', cookies: admin.cookies })).json().move.state;
      const until = async (back: string) => {
        for (let i = 0; i < 300; i++) {
          const v = await state();
          if (v?.back === back) return v;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`never ${back}`);
      };
      const { fresh } = await seedAccounts();
      await seedMoved();
      // the old Jellyfin answers only once the test lets it
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      old.before = async () => {
        await held;
        if (fake.media.source?.state !== 'running') throw new TypeError('fetch failed');
      };
      const r = await post();
      expect(r.statusCode).toBe(202);
      expect(await state()).toMatchObject({ phase: 'done', back: 'starting' });
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
      release();
      expect(await until('done')).toMatchObject({ phase: 'done', back: 'done' });
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(OLD);
      expect(old.users.has((await profileRow(fresh)).jellyfin_user_id)).toBe(true);
      expect(await env.kv.get(MOVE_LOCK)).toBeNull();
      // refused after the 202: the code shows in the view, FriendFlix unchanged
      resetFake();
      await seedMoved();
      fake.media.source = null;
      expect((await post()).statusCode).toBe(202);
      expect(await until('failed')).toMatchObject({ back: 'failed', backError: 'source_missing' });
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
      // refused without a wait: at once
      await env.pool.query('update media_managed set migrated_from = null');
      const now = await post();
      expect(now.statusCode).toBe(409);
      expect(now.json()).toEqual({ error: 'not_moved' });
    }, 20_000);

    it('the way back repairs against the stored way back; settings that still name the managed server never mark it done (I1)', async () => {
      const { fresh } = await seedAccounts();
      await seedStopped();
      // this instance has not taken the switch over yet
      env.ctx.cfg = { ...env.ctx.cfg, JELLYFIN_URL: MANAGED, JELLYFIN_ADMIN_API_KEY: KEY };
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move!.back).toBe('stopped');
      expect(calls('POST', '/Users/New', old)).toEqual([]);
      expect(server.calls).toEqual([]);
      // it has: the repair runs against the stored way back
      env.ctx.cfg = { ...env.ctx.cfg, JELLYFIN_URL: OLD, JELLYFIN_ADMIN_API_KEY: OLD_KEY };
      expect(await tick()).toBe('done');
      expect(old.users.has((await profileRow(fresh)).jellyfin_user_id)).toBe(true);
      expect(server.calls).toEqual([]);
      // a stored way back that names the managed server: never done
      await seedStopped();
      await writeManaged(env.ctx, { externalUrl: MANAGED });
      expect(await tick()).toBe('waiting');
      expect((await readManaged(env.pool)).move!.back).toBe('stopped');
      expect(server.calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    it('a policy that fails is written on the next run, never by making another user (m1)', async () => {
      const uid = await seedUser({ user: hex(0xa1) });
      const clashed = await seedProfile(uid, hex(0xd2), 'lea-zwei', 'pw-d2', true);
      for (const [id, name, pw] of [[hex(0xa1), 'lea', 'pw'], [hex(0xd9), 'lea-zwei', 'other']] as const) {
        old.users.add(id);
        old.accounts.set(id, { name, pw, policy: {} });
      }
      await seedStopped();
      old.fail = (c) => (c.path.endsWith('/Policy') ? 503 : null);
      expect(await tick()).toBe('waiting');
      // the new user is stored at once (its suffixed name), its policy marked as owed
      const first = await profileRow(clashed);
      expect(first.jellyfin_username).toMatch(/^lea-zwei\d{3}$/);
      expect((await readManaged(env.pool)).move!.policyPending).toEqual([first.jellyfin_user_id]);
      old.fail = null;
      expect(await tick()).toBe('done');
      // the base name tried and taken, one suffixed user: none more on the retry
      expect(calls('POST', '/Users/New', old)).toHaveLength(2);
      expect(await profileRow(clashed)).toEqual(first);
      expect(old.accounts.get(first.jellyfin_user_id)!.policy).toMatchObject({ IsHidden: true, MaxParentalRating: 6 });
      expect((await readManaged(env.pool)).move!.policyPending).toBeUndefined();
    });

    it('the updater\'s status cannot be read while the old Jellyfin starts: updater_error (m6)', async () => {
      await seedAccounts();
      await seedMoved();
      fake.statusDown = true;
      expect(await back({ waitMs: 200 })).toEqual({ ok: false, error: 'updater_error' });
      expect((await readManaged(env.pool)).move).toMatchObject({ back: 'failed', backError: 'updater_error' });
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
    });

    it('a repeated move keeps the users its repair made as it makes them: a retry does not make them again (m5)', async () => {
      const uid = await seedUser({ user: hex(0xa1) });
      await seedProfile(uid, hex(0xb2), 'lea-neu', 'pw-b2');
      await seedProfile(uid, hex(0xb3), 'lea-drei', 'pw-b3');
      server.users = new Set([hex(0xa1)]);
      // the first user is made, every try for the second fails (a server still starting)
      let n = 0;
      let failing = true;
      server.fail = (c) => (c.path === '/Users/New' && failing && ++n >= 2 ? 503 : null);
      await seedMove('verify', { repeat: true });
      expect(await tick()).toBe('waiting');
      const kept = (await readManaged(env.pool)).move!.relinks!;
      expect(kept).toHaveLength(1);
      failing = false;
      expect(await tick()).toBe('switch');
      const all = (await readManaged(env.pool)).move!.relinks!;
      expect(all).toHaveLength(2);
      expect(all).toContainEqual(kept[0]);
      // one made, four tries that failed, one made on the retry
      expect(calls('POST', '/Users/New')).toHaveLength(6);
    });

    it('a repeated move repairs before verifying', async () => {
      const uid = await seedUser({ user: hex(0xa1) });
      // made on Jellyfin since the way back, unknown to the copy
      const pid = await seedProfile(uid, hex(0xb2), 'lea-neu', 'pw-b2');
      server.users = new Set([hex(0xa1)]);
      await seedMove('verify', { repeat: true });
      expect(await tick()).toBe('switch');
      // created on the copy; FriendFlix (still on Jellyfin) keeps its id until the switch
      expect((await profileRow(pid)).jellyfin_user_id).toBe(hex(0xb2));
      const rec = (await readManaged(env.pool)).move!;
      const to = rec.relinks![0]!.to;
      expect(rec.relinks).toEqual([{ table: 'profiles', row: pid, from: hex(0xb2), to, name: 'lea-neu' }]);
      expect(server.accounts.get(to)).toMatchObject({ name: 'lea-neu', pw: 'pw-b2', policy: { IsHidden: true } });
      expect(server.accounts.get(hex(0xa1))!.pw).toBe('pw');
      expect(old.calls).toEqual([]);
      // the switch takes the new id over
      expect(await tick()).toBe('requests');
      expect((await profileRow(pid)).jellyfin_user_id).toBe(to);
      expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
    });

    it('a repeated move that fails after its repair leaves FriendFlix\'s ids as they were; a first move never repairs', async () => {
      const uid = await seedUser({ user: hex(0xa1) });
      const pid = await seedProfile(uid, hex(0xb2), 'lea-neu', 'pw-b2');
      server.users = new Set([hex(0xa1)]);
      await seedItems(uid, 10);
      await seedMove('verify', { repeat: true });
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'ids_mismatch', errorMeta: { users: { total: 2, missing: 0 }, items: { sampled: 10, missing: 10 } } });
      expect((await profileRow(pid)).jellyfin_user_id).toBe(hex(0xb2));
      // the first move: no user created, no password set; the missing user fails the check
      resetFake();
      resetServer();
      server.users = new Set([hex(0xa1)]);
      await seedMove('verify');
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ error: 'ids_mismatch', errorMeta: { users: { total: 2, missing: 1 } } });
      expect(server.calls.filter((c) => c.method === 'POST')).toEqual([]);
    });
  });
});
