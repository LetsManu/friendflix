// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { MOVE_LOCK, moveTick, verifyIds } from '../src/mediaserver/move.js';
import { externalKey, readManaged, writeManaged, type MovePhase } from '../src/mediaserver/store.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

const SECRET = cfg.INTERNAL_SECRET;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const MANAGED = 'http://mediaserver:8096';
const OLD = 'http://jellyfin.example.com:8096';
/** token-shaped values from pieces (gitleaks) */
const KEY = 'k' + 'ey-' + 'copied-' + '1';
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
  desired: { kind: 'ferrofin', folders: [{ rel: '', target: '/movies', migrated: true }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, run: true, migrated: true },
  container: { state: 'running', health: 'healthy', kind: 'ferrofin', image: { digest: DIGEST, upstream: '1.2.3' }, template: 'current', tampered: false, createdAt: '2026-11-24T09:00:00.000Z' },
  pin: null, pins: { ferrofin: true, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null as string | null, backups: [], hdr: null,
  move: updMove('ready') as Record<string, any> | null, source: { name: 'jellyfin', state: 'exited', version: '10.10.3' },
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
};
const resetFake = () => Object.assign(fake, { media: media(), job: job('mediaserver-migrate', 'succeeded', COPY_JOB), busy: false, up: true, bodies: [], refuse: {},
  dri: [{ node: 'renderD129', gid: 44, vendor: 'intel' }] });
const opBodies = (op: string) => fake.bodies.filter((b) => b.op === op);

// ---------------------------------------------------------------- the fake Ferrofin (the copied database)

interface Call { method: string; path: string; query: URLSearchParams; body: any; token: string | null }
interface Lib { Name: string; ItemId: string; Locations: string[]; LibraryOptions: Record<string, unknown> }
const server = {
  up: true,
  users: new Set<string>(),
  items: new Set<string>(),
  libs: [] as Lib[],
  calls: [] as Call[],
  encoding: { EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'none' } as Record<string, unknown>,
  /** runs before a call is answered (a concurrent writer) */
  before: null as ((c: Call) => Promise<void>) | null,
  /** a status to answer instead (a server still starting: 503) */
  fail: null as ((c: Call) => number | null) | null,
};
const resetServer = () => Object.assign(server, { up: true, users: new Set<string>(), items: new Set<string>(), libs: [], calls: [],
  encoding: { EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'none' }, before: null, fail: null });
const calls = (method: string, path: string) => server.calls.filter((c) => c.method === method && c.path === path);
const tokenOf = (h: string | null) => /Token="([^"]*)"/.exec(h ?? '')?.[1] ?? null;

function serverAnswer(c: Call): Response {
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const none = (status = 204) => new Response(null, { status });
  if (c.token !== KEY) return none(401);
  const failed = server.fail?.(c);
  if (failed) return none(failed);
  if (c.method === 'GET' && c.path.startsWith('/Users/')) {
    const id = c.path.slice('/Users/'.length);
    return server.users.has(id) ? j({ Id: id, Name: 'x', Policy: {} }) : none(404);
  }
  switch (`${c.method} ${c.path}`) {
    case 'GET /Library/VirtualFolders': return j(server.libs);
    case 'POST /Library/VirtualFolders/LibraryOptions': {
      const lib = server.libs.find((l) => l.ItemId === c.body.Id);
      if (!lib) return none(404);
      lib.LibraryOptions = c.body.LibraryOptions;
      return none();
    }
    case 'GET /System/Configuration/encoding': return j(server.encoding);
    case 'POST /System/Configuration/encoding': server.encoding = c.body; return none();
    case 'GET /Items': {
      const id = c.query.get('ids')!;
      return j({ Items: server.items.has(id) ? [{ Id: id, Name: 'x', Type: 'Movie' }] : [] });
    }
  }
  return none(404);
}

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (u.origin === MANAGED) {
    if (!server.up) throw new TypeError('fetch failed');
    const headers = new Headers(init?.headers);
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, body, token: tokenOf(headers.get('authorization')) };
    server.calls.push(c);
    await server.before?.(c);
    return serverAnswer(c);
  }
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (!fake.up) throw new TypeError('fetch failed');
  if (u.pathname === '/v1/status') {
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: fake.busy, job: fake.job, log: [], services: [], mediaserver: fake.media });
  }
  if (u.pathname !== '/v1/mediaserver') return j({ error: 'not_found' }, 404);
  fake.bodies.push(body);
  const refused = fake.refuse[body.op];
  if (refused) return j({ error: refused }, 409);
  if (body.op === 'gpu') return j({ dri: fake.dri, nvidia: false });
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
    env = await makeEnv({}, { ctxPatch });
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });
  beforeEach(async () => {
    offset += 60_000;
    resetFake();
    resetServer();
    await env.ctx.settings.save({ JELLYFIN_URL: OLD, JELLYFIN_ADMIN_API_KEY: KEY }, null);
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
    expect(audits).toEqual([{ action: 'mediaserver.moved', meta: { name: 'jellyfin' } }]);
    expect(JSON.stringify(audits)).not.toContain(KEY);
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
      fake.media.desired.gpu = 'dri';
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
      fake.media.desired.gpu = 'dri';
      fake.refuse.gpu = 'no_network';
      await seedMove('nfo');
      expect(await tick()).toBe('failed');
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'no_network' });
      resetFake();
      fake.media.desired.gpu = 'dri';
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
});
