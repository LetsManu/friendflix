// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionKey } from '../src/session.js';
import { mediaManagedTick } from '../src/mediaserver/firstRun.js';
import { libraryReferences } from '../src/mediaserver/references.js';
import { libraryItemIds } from '../src/mediaserver/serverApi.js';
import { readManaged, writeManaged, type LibraryEntry } from '../src/mediaserver/store.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

const SECRET = 'internal-secret-123456';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const MANAGED = 'http://mediaserver:8096';
/** token-shaped values from pieces (gitleaks) */
const PASSWORD = 'pw-' + 'A'.repeat(40);
const keyOf = (n: number) => 'k' + 'ey-' + 'managed-' + n;
const hex = (c: string) => c.repeat(32);
const LIBS: LibraryEntry[] = [
  { slug: 'filme', name: 'Filme', type: 'movies', rel: 'Filme', created: false },
  { slug: 'serien', name: 'Serien', type: 'tvshows', rel: 'Serien/Neu', created: false },
];
const FOLDERS = [{ rel: 'Filme', name: 'Filme', type: 'movies' }, { rel: 'Serien/Neu', name: 'Serien', type: 'tvshows' }];

// ---------------------------------------------------------------- the fake updater

let jobN = 0;
type Job = Record<string, any>;
const job = (action: string, state = 'running'): Job => ({ id: (++jobN).toString(16).padStart(16, '0'), action, state, step: null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' }, startedAt: '2026-11-17T10:00:00.000Z', finishedAt: null, error: null,
  media: { step: 'check', steps: {} } });
const media = (kind: string) => ({
  available: true, reason: null, base: { set: true, path: '/srv/media', pending: false, expiresAt: null },
  desired: { kind, folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien/Neu', target: '/media/serien' }], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true, run: true },
  container: { state: 'running', health: 'healthy', kind, image: { digest: DIGEST, upstream: '1.2.3' }, template: kind === 'ferrofin' ? 'update_pending' : 'current', tampered: false, createdAt: '2026-11-17T10:00:00.000Z' },
  pin: null, pins: { ferrofin: true, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null, backups: [], hdr: null,
});

// ---------------------------------------------------------------- the fake media server

interface Call { method: string; path: string; query: URLSearchParams; body: any; token: string | null }
const server = {
  up: true,
  wizardDone: false,
  /** the administrator the server knows (Ferrofin: from its first-run environment) */
  user: null as { name: string; password: string } | null,
  keys: [] as Array<{ AccessToken: string; AppName: string; DateCreated: string }>,
  folders: [] as Array<{ Name: string; ItemId: string; CollectionType: string; Locations: string[] }>,
  items: {} as Record<string, string[]>,
  encoding: { EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'none', EnableTonemapping: false } as Record<string, unknown>,
  /** a status to answer once for the first call it returns one for */
  failOnce: null as ((c: Call) => number | null) | null,
  calls: [] as Call[],
};
let folderN = 0;
const resetServer = () => Object.assign(server, { up: true, wizardDone: false, user: null, keys: [], folders: [], items: {}, encoding: { EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'none', EnableTonemapping: false }, failOnce: null, calls: [] });
const calls = (method: string, path: string) => server.calls.filter((c) => c.method === method && c.path === path);
const tokenOf = (h: string | null) => /Token="([^"]*)"/.exec(h ?? '')?.[1] ?? null;

function serverAnswer(c: Call): Response {
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const none = (status = 204) => new Response(null, { status });
  const fail = server.failOnce?.(c);
  if (fail) { server.failOnce = null; return none(fail); }
  const authed = c.token !== null && (server.keys.some((k) => k.AccessToken === c.token) || c.token === 'session-token');
  if (c.path.startsWith('/Startup/')) {
    if (server.wizardDone) return none(401);
    if (c.method === 'GET' && c.path === '/Startup/User') return j({ Name: 'root' });
    if (c.path === '/Startup/User') server.user = { name: c.body.Name, password: c.body.Password };
    if (c.path === '/Startup/Complete') server.wizardDone = true;
    return none();
  }
  switch (`${c.method} ${c.path}`) {
    case 'GET /System/Info/Public': return j({ ServerName: 'mediaserver', Version: '12.0.0', StartupWizardCompleted: server.wizardDone });
    case 'POST /Users/AuthenticateByName':
      return server.user && c.body.Username === server.user.name && c.body.Pw === server.user.password
        ? j({ AccessToken: 'session-token', User: { Id: hex('1'), Name: server.user.name, Policy: { IsAdministrator: true } } }) : none(401);
    case 'POST /Sessions/Logout': return none();
  }
  if (!authed) return none(401);
  switch (`${c.method} ${c.path}`) {
    case 'GET /Auth/Keys': return j({ Items: server.keys });
    case 'POST /Auth/Keys':
      server.keys.push({ AccessToken: keyOf(server.keys.length + 1), AppName: c.query.get('app')!, DateCreated: new Date().toISOString() });
      return none();
    case 'GET /Library/VirtualFolders': return j(server.folders);
    case 'POST /Library/VirtualFolders':
      server.folders.push({ Name: c.query.get('name')!, ItemId: (++folderN).toString(16).padStart(32, 'f'), CollectionType: c.query.get('collectionType')!, Locations: c.query.getAll('paths') });
      return none();
    case 'POST /Library/VirtualFolders/Name': {
      const f = server.folders.find((x) => x.Name === c.query.get('name'));
      if (!f) return none(404);
      f.Name = c.query.get('newName')!;
      return none();
    }
    case 'DELETE /Library/VirtualFolders':
      server.folders = server.folders.filter((x) => x.Name !== c.query.get('name'));
      return none();
    case 'POST /Library/Refresh': return none();
    case 'GET /System/Configuration/encoding': return j(server.encoding);
    case 'POST /System/Configuration/encoding': server.encoding = c.body; return none();
    case 'GET /Items': {
      const all = server.items[c.query.get('ParentId')!] ?? [];
      const start = Number(c.query.get('StartIndex')), limit = Number(c.query.get('Limit'));
      return j({ Items: all.slice(start, start + limit).map((Id) => ({ Id, Name: 'x', Type: 'Movie' })) });
    }
  }
  return none(404);
}

const fake = {
  media: media('jellyfin') as Record<string, any>,
  job: null as Job | null,
  busy: false,
  bodies: [] as Array<Record<string, any>>,
  /** the render nodes the gpu op detects */
  dri: [] as Array<Record<string, unknown>>,
  /** ops the updater refuses (busy) */
  refuse: new Set<string>(),
};
const INTEL = [{ node: 'renderD129', gid: 44, vendor: 'intel' }];
const resetFake = (kind = 'jellyfin') => Object.assign(fake, { media: media(kind), job: null, busy: false, bodies: [], dri: INTEL, refuse: new Set<string>() });
const opBodies = (op: string) => fake.bodies.filter((b) => b.op === op);

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (u.origin === MANAGED) {
    if (!server.up) throw new TypeError('fetch failed');
    const headers = new Headers(init?.headers);
    const c: Call = { method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, body, token: tokenOf(headers.get('authorization')) };
    server.calls.push(c);
    return serverAnswer(c);
  }
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (u.pathname === '/v1/status') {
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: fake.busy, job: fake.job, log: [], services: [], mediaserver: fake.media });
  }
  if (u.pathname !== '/v1/mediaserver') return j({ error: 'not_found' }, 404);
  fake.bodies.push(body);
  if (body.op === 'gpu') return j({ dri: fake.dri, nvidia: false });
  if (fake.refuse.has(body.op)) return j({ error: 'busy' }, 409);
  fake.job = job(`mediaserver-${body.op === 'finish-setup' ? 'finish' : body.op}`);
  fake.busy = true;
  return j({ job: fake.job }, 202);
}) as typeof fetch;

const ctxPatch = (c: TestEnv['ctx']) => { c.fetchImpl = fetchImpl; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; };

type Sess = { cookies: Record<string, string>; csrf: string };

describe('managed media server first run', () => {
  let env: TestEnv;
  let admin: Sess;
  let offset = 0;
  const realNow = Date.now.bind(Date);
  const req = (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/admin/mediaserver${path}`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const reauth = async () => {
    const key = sessionKey(admin.cookies.ff_sid!);
    await env.kv.set(key, JSON.stringify({ ...JSON.parse((await env.kv.get(key))!), reauthAt: Date.now() }), 600);
  };
  const tick = (log?: { warn(o: object, m: string): void }) => mediaManagedTick(env.ctx, log);
  /** ticks until `until` (or 20 ticks), the steps seen (waiting left out) */
  const run = async (until: string, log?: { warn(o: object, m: string): void }) => {
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await tick(log);
      if (r !== 'waiting') seen.push(r);
      if (r === until) break;
    }
    return seen;
  };
  const seed = async (kind: 'ferrofin' | 'jellyfin', setup: 'applying' | 'first_run' | 'libraries' | 'done', libraries: LibraryEntry[] = LIBS) =>
    writeManaged(env.ctx, { kind, setup, setupError: null, adminUser: 'friendflix-admin', adminPassword: PASSWORD, libraries });
  /** the settings already point at the managed server with a key it knows */
  const connected = async () => {
    server.keys.push({ AccessToken: keyOf(1), AppName: 'FriendFlix', DateCreated: '2026-11-17T10:00:00.000Z' });
    await env.ctx.settings.save({ JELLYFIN_URL: MANAGED, JELLYFIN_ADMIN_API_KEY: keyOf(1) }, null);
  };
  const appliedJob = () => { fake.job = job('mediaserver-apply', 'succeeded'); fake.busy = false; };

  beforeAll(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    env = await makeEnv({}, { ctxPatch });
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });
  beforeEach(async () => {
    offset += 11 * 60_000;
    resetFake();
    resetServer();
    await env.ctx.settings.save({ JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'adminkey' }, null);
    admin = await env.login(ADMIN);
    await env.pool.query("delete from audit_log; delete from media_managed; delete from profiles where not is_owner; update users set jellyfin_user_id = ''; update profiles set jellyfin_user_id = null");
    for (const prefix of ['updater:pending:', 'media:managed:']) for (const k of await env.kv.keys(prefix)) await env.kv.del(k);
  });

  it('jellyfin: from applying to done', async () => {
    await seed('jellyfin', 'applying');
    fake.job = job('mediaserver-apply');
    fake.busy = true;
    expect(await tick()).toBe('waiting');
    expect((await readManaged(env.pool)).setup).toBe('applying');
    fake.job.state = 'succeeded';
    fake.busy = false;
    // one library per tick, the scan once none is left
    expect(await run('done')).toEqual(['first_run', 'api_key', 'libraries', 'libraries', 'libraries', 'hwaccel', 'finishing', 'done']);
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'done', setupError: null, libraries: LIBS.map((l) => ({ ...l, created: true })) });

    // the startup wizard, in order, with the generated administrator
    const startup = server.calls.filter((c) => c.path.startsWith('/Startup/')).map((c) => `${c.method} ${c.path}`);
    expect(startup).toEqual(['POST /Startup/Configuration', 'GET /Startup/User', 'POST /Startup/User', 'POST /Startup/RemoteAccess', 'POST /Startup/Complete']);
    expect(calls('POST', '/Startup/Configuration')[0]!.body).toEqual({ UICulture: 'de-DE', MetadataCountryCode: 'DE', PreferredMetadataLanguage: 'de' });
    expect(calls('POST', '/Startup/User')[0]!.body).toEqual({ Name: 'friendflix-admin', Password: PASSWORD });
    expect(calls('POST', '/Startup/RemoteAccess')[0]!.body).toEqual({ EnableRemoteAccess: false, EnableAutomaticPortMapping: false });

    // two libraries below /media, no local metadata
    const posts = calls('POST', '/Library/VirtualFolders');
    expect(posts.map((c) => [c.query.get('name'), c.query.get('collectionType'), c.query.getAll('paths'), c.query.get('refreshLibrary')]))
      .toEqual([['Filme', 'movies', ['/media/filme'], 'false'], ['Serien', 'tvshows', ['/media/serien'], 'false']]);
    for (const p of posts) {
      expect(p.body).toEqual({ LibraryOptions: { EnableRealtimeMonitor: true, SaveLocalMetadata: false, MetadataSavers: [], PreferredMetadataLanguage: 'de', MetadataCountryCode: 'DE' } });
      expect(p.token).toBe(keyOf(1));
    }
    expect(calls('POST', '/Library/Refresh')).toHaveLength(1);

    // Intel: QSV on the detected node, the other encoding fields kept
    expect(opBodies('gpu')).toEqual([{ op: 'gpu' }]);
    expect(server.encoding).toEqual({
      EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', HardwareAccelerationType: 'qsv', EnableTonemapping: true, TonemappingAlgorithm: 'bt2390',
      HardwareDecodingCodecs: ['h264', 'hevc', 'mpeg2video', 'vc1', 'vp8', 'vp9', 'av1'], VaapiDevice: '/dev/dri/renderD129',
    });

    // the connection: saved from the database, audited as a settings change (keys only)
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(MANAGED);
    expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe(keyOf(1));
    const src = env.ctx.settings.sources();
    expect([src.JELLYFIN_URL, src.JELLYFIN_ADMIN_API_KEY]).toEqual(['db', 'db']);
    const settingsAudit = (await env.pool.query<{ meta: { keys: string[] } }>("select meta from audit_log where action = 'settings.update'")).rows;
    expect(settingsAudit.map((r) => r.meta.keys.sort())).toEqual([['JELLYFIN_ADMIN_API_KEY', 'JELLYFIN_URL']]);
    expect(opBodies('finish-setup')).toEqual([]);
    expect(await tick()).toBe('idle');
  });

  it('ferrofin: no wizard, finish-setup once', async () => {
    resetFake('ferrofin');
    server.wizardDone = true;
    server.user = { name: 'friendflix-admin', password: PASSWORD };
    await seed('ferrofin', 'applying');
    appliedJob();
    expect(await run('finishing')).toEqual(['first_run', 'api_key', 'libraries', 'libraries', 'libraries', 'hwaccel', 'finishing']);
    expect(await tick()).toBe('waiting'); // finish-setup started
    expect(opBodies('finish-setup')).toEqual([{ op: 'finish-setup' }]);
    expect(await tick()).toBe('waiting'); // its job runs
    fake.job!.state = 'succeeded';
    fake.busy = false;
    expect(await tick()).toBe('done');
    expect(await tick()).toBe('idle');
    expect(await tick()).toBe('idle');
    expect(opBodies('finish-setup')).toHaveLength(1);
    expect(server.calls.filter((c) => c.path.startsWith('/Startup/'))).toEqual([]);
    expect((await env.pool.query("select meta from audit_log where action = 'mediaserver.action'")).rows.map((r) => r.meta)).toEqual([{ op: 'finish-setup' }]);
  });

  it('wizard_taken: someone else completed the wizard', async () => {
    server.wizardDone = true;
    server.user = { name: 'someone', password: 'other' };
    await seed('jellyfin', 'first_run');
    appliedJob();
    expect(await tick()).toBe('failed');
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'failed', setupError: 'wizard_taken' });
    expect(calls('POST', '/Users/AuthenticateByName')).toHaveLength(1);
    expect(server.calls.filter((c) => c.path.startsWith('/Startup/'))).toEqual([]);
    expect(await tick()).toBe('idle');
  });

  it('a completed wizard that is our own (a surviving server) goes on to the key', async () => {
    server.wizardDone = true;
    server.user = { name: 'friendflix-admin', password: PASSWORD };
    await seed('jellyfin', 'first_run');
    appliedJob();
    expect(await tick()).toBe('api_key');
    expect(server.calls.filter((c) => c.path.startsWith('/Startup/'))).toEqual([]);
    expect(calls('POST', '/Sessions/Logout')).toHaveLength(1);
    // a key that works is kept: no second key
    await connected();
    expect(await tick()).toBe('libraries');
    expect(calls('POST', '/Auth/Keys')).toEqual([]);
  });

  it('a server that does not come up is unhealthy after 3 minutes', async () => {
    server.up = false;
    await seed('jellyfin', 'first_run');
    appliedJob();
    expect(await tick()).toBe('waiting');
    await env.pool.query("update media_managed set updated_at = now() - interval '4 minutes'");
    expect(await tick()).toBe('first_run');
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'first_run', setupError: 'unhealthy' });
  });

  it('a failed apply job is the setup error', async () => {
    await seed('jellyfin', 'applying');
    fake.job = { ...job('mediaserver-apply', 'failed'), error: 'folder_missing' };
    expect(await tick()).toBe('applying');
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'applying', setupError: 'folder_missing' });
  });

  it('a failure keeps its step and Nochmal resumes there', async () => {
    await seed('jellyfin', 'libraries');
    await connected();
    appliedJob();
    server.failOnce = (c) => (c.method === 'POST' && c.path === '/Library/VirtualFolders' && c.query.get('name') === 'Serien' ? 500 : null);
    const log = { warn: vi.fn() };
    expect(await tick(log)).toBe('libraries'); // Filme
    expect(log.warn).not.toHaveBeenCalled();
    expect(await tick(log)).toBe('libraries'); // Serien fails
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'libraries', setupError: 'unexpected', libraries: [{ slug: 'filme', created: true }, { slug: 'serien', created: false }] });
    expect(log.warn).toHaveBeenCalledWith({ step: 'libraries', code: 'unexpected' }, 'managed media server setup step failed');
    // nothing happens until Nochmal
    const n = server.calls.length;
    expect(await tick()).toBe('idle');
    expect(server.calls).toHaveLength(n);
    expect((await req('POST', '/action', { op: 'retry' })).json()).toEqual({ ok: true });
    expect((await readManaged(env.pool)).setupError).toBeNull();
    expect(await tick()).toBe('libraries'); // Serien
    expect(await tick()).toBe('hwaccel');
    expect(calls('POST', '/Library/VirtualFolders').map((c) => c.query.get('name'))).toEqual(['Filme', 'Serien', 'Serien']);
    expect(server.folders.map((f) => f.Name)).toEqual(['Filme', 'Serien']);
  });

  it('two ticks at once run one step', async () => {
    await seed('jellyfin', 'first_run');
    appliedJob();
    const results = await Promise.all([tick(), tick()]);
    expect(results.sort()).toEqual(['api_key', 'locked']);
    expect(calls('POST', '/Startup/User')).toHaveLength(1);
    expect((await readManaged(env.pool)).setup).toBe('api_key');
  });

  it('a restart after the libraries step creates no second library', async () => {
    await seed('jellyfin', 'libraries', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    appliedJob();
    expect(await tick()).toBe('hwaccel');
    expect(calls('POST', '/Library/VirtualFolders')).toEqual([]);
    // a library that exists in the server already (a switch back to managed: entries recomputed not created) is only marked
    await seed('jellyfin', 'libraries');
    server.folders = [{ Name: 'Filme', ItemId: hex('a'), CollectionType: 'movies', Locations: ['/media/filme'] }];
    expect(await run('hwaccel')).toEqual(['libraries', 'libraries', 'hwaccel']);
    expect(calls('POST', '/Library/VirtualFolders').map((c) => c.query.get('name'))).toEqual(['Serien']);
    expect((await readManaged(env.pool)).libraries.every((l) => l.created)).toBe(true);
  });

  it('the password never leaves', async () => {
    await seed('jellyfin', 'applying');
    appliedJob();
    const log = { warn: vi.fn() };
    expect(await run('done', log)).toContain('done');
    // and a failing step
    await seed('jellyfin', 'first_run');
    server.wizardDone = true;
    server.user = { name: 'someone', password: 'other' };
    expect(await tick(log)).toBe('failed');
    expect(log.warn).toHaveBeenCalled();
    const logged = JSON.stringify(log.warn.mock.calls);
    const audits = JSON.stringify((await env.pool.query('select * from audit_log')).rows);
    const row = JSON.stringify((await env.pool.query('select setup, setup_error, admin_user, libraries from media_managed')).rows);
    for (const secret of [PASSWORD, keyOf(1)]) {
      expect(logged).not.toContain(secret);
      expect(audits).not.toContain(secret);
      expect(row).not.toContain(secret);
    }
    expect((await env.pool.query<{ p: string }>('select admin_password_enc as p from media_managed')).rows[0]!.p).not.toContain(PASSWORD);
  });

  it('references count lists, resume points and recordings', async () => {
    const adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
    await seed('jellyfin', 'done', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    const filme = hex('a');
    server.folders = [{ Name: 'Filme', ItemId: filme, CollectionType: 'movies', Locations: ['/media/filme'] }, { Name: 'Serien', ItemId: hex('b'), CollectionType: 'tvshows', Locations: ['/media/serien'] }];
    const [i1, i2, i3, i4] = [hex('1'), hex('2'), hex('3'), hex('4')];
    server.items[filme] = [i1, i2, i3, i4];
    const list = (await env.pool.query<{ id: string }>("insert into lists(id, owner_id, name) values (gen_random_uuid(), $1, 'Abend') returning id", [adminId])).rows[0]!.id;
    await env.pool.query("insert into list_items(list_id, item_id, item_name) values ($1, $2, 'Eins')", [list, i1]);
    await env.pool.query('insert into watchlist(user_id, profile_id, item_id) values ($1, $1, $2)', [adminId, i4]);
    const guest = '00000000-0000-4000-8000-0000000000aa';
    await env.pool.query("insert into profiles(id, user_id, name, is_owner, jellyfin_user_id) values ($1, $2, 'Gast', false, $3)", [guest, adminId, hex('f')]);
    await env.pool.query('insert into resume_hidden(profile_id, item_id) values ($1, $3), ($2, $3)', [adminId, guest, i2]);
    await env.pool.query(`insert into livetv_recordings(id, profile_id, user_id, channel_name, title, start_at, end_at, pad_before_s, pad_after_s, state, storage, dir, jellyfin_item_id)
      values (gen_random_uuid(), $1, $1, 'Hafenkanal', 'Sternstunde', now() - interval '2 hours', now() - interval '1 hour', 0, 0, 'done', 'library', gen_random_uuid(), $2)`, [adminId, i3]);

    expect(await libraryReferences(env.ctx, 'filme')).toEqual({ lists: 2, resume: 2, recordings: 1 });
    expect(await libraryReferences(env.ctx, 'serien')).toEqual({ lists: 0, resume: 0, recordings: 0 });
    const listed = (await req('GET', '/libraries')).json().libraries;
    expect(listed.map((l: { slug: string; references: unknown }) => [l.slug, l.references])).toEqual([['filme', { lists: 2, resume: 2, recordings: 1 }], ['serien', { lists: 0, resume: 0, recordings: 0 }]]);

    // renaming the referenced library is refused before anything is sent
    await reauth();
    const r = await req('POST', '/apply', { kind: 'jellyfin', folders: [{ ...FOLDERS[0], name: 'Kino' }, FOLDERS[1]], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'library_referenced' });
    expect(opBodies('apply')).toEqual([]);
    expect(calls('POST', '/Library/VirtualFolders/Name')).toEqual([]);

    // deleting it: in the server, the entry gone, audited; the references stay
    const d = await req('DELETE', '/libraries/filme');
    expect(d.statusCode).toBe(200);
    expect(calls('DELETE', '/Library/VirtualFolders').map((c) => c.query.get('name'))).toEqual(['Filme']);
    expect(server.folders.map((f) => f.Name)).toEqual(['Serien']);
    expect((await readManaged(env.pool)).libraries.map((l) => l.slug)).toEqual(['serien']);
    expect((await env.pool.query("select meta from audit_log where action = 'mediaserver.action'")).rows.map((x) => x.meta)).toEqual([{ op: 'library_delete' }]);
    expect((await env.pool.query('select count(*)::int as n from list_items where item_id = $1', [i1])).rows[0].n).toBe(1);
  });

  it('the server not answering: references unknown, a rename and a delete refused with a code', async () => {
    await seed('jellyfin', 'done', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    server.up = false;
    expect((await req('GET', '/libraries')).json().libraries.map((l: { references: unknown }) => l.references)).toEqual([null, null]);
    await reauth();
    const r = await req('POST', '/apply', { kind: 'jellyfin', folders: [{ ...FOLDERS[0], name: 'Kino' }, FOLDERS[1]], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true });
    expect(r.json()).toEqual({ error: 'unreachable' });
    expect((await req('DELETE', '/libraries/filme')).json()).toEqual({ error: 'unreachable' });
    expect((await readManaged(env.pool)).libraries).toHaveLength(2);
  });

  it('an unreferenced rename renames in place, a new type is a new library', async () => {
    await seed('jellyfin', 'done', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    server.folders = [{ Name: 'Filme', ItemId: hex('a'), CollectionType: 'movies', Locations: ['/media/filme'] }, { Name: 'Serien', ItemId: hex('b'), CollectionType: 'tvshows', Locations: ['/media/serien'] }];
    await reauth();
    const r = await req('POST', '/apply', { kind: 'jellyfin', folders: [{ ...FOLDERS[0], name: 'Kino' }, { ...FOLDERS[1], type: 'mixed' }], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true });
    expect(r.statusCode).toBe(202);
    expect(calls('POST', '/Library/VirtualFolders/Name').map((c) => [c.query.get('name'), c.query.get('newName')])).toEqual([['Filme', 'Kino']]);
    expect(calls('DELETE', '/Library/VirtualFolders').map((c) => c.query.get('name'))).toEqual(['Serien']);
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'libraries', libraries: [{ slug: 'filme', name: 'Kino', created: true }, { slug: 'serien', type: 'mixed', created: false }] });
    expect(await tick()).toBe('waiting'); // the apply runs
    fake.job!.state = 'succeeded';
    fake.busy = false;
    expect(await run('hwaccel')).toEqual(['libraries', 'hwaccel']);
    expect(calls('POST', '/Library/VirtualFolders').map((c) => [c.query.get('name'), c.query.get('collectionType')])).toEqual([['Serien', 'mixed']]);
  });

  it('adding a folder after done creates its library', async () => {
    await seed('jellyfin', 'done', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    server.folders = [{ Name: 'Filme', ItemId: hex('a'), CollectionType: 'movies', Locations: ['/media/filme'] }, { Name: 'Serien', ItemId: hex('b'), CollectionType: 'tvshows', Locations: ['/media/serien'] }];
    await reauth();
    const r = await req('POST', '/apply', { kind: 'jellyfin', folders: [...FOLDERS, { rel: 'Musik', name: 'Musik', type: 'music' }], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true });
    expect(r.statusCode).toBe(202);
    expect(opBodies('apply')[0]!.firstRun).toBeUndefined();
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'libraries', setupError: null });
    expect(await tick()).toBe('waiting'); // the apply mounts it first
    fake.job!.state = 'succeeded';
    fake.busy = false;
    expect(await run('done')).toEqual(['libraries', 'hwaccel', 'finishing', 'done']);
    const posts = calls('POST', '/Library/VirtualFolders');
    expect(posts.map((c) => [c.query.get('name'), c.query.getAll('paths')])).toEqual([['Musik', ['/media/musik']]]);
    expect(calls('POST', '/Startup/User')).toEqual([]);
  });

  it('another or an undetected VA-API vendor decodes only H.264 and HEVC in hardware', async () => {
    await connected();
    for (const [dri, device] of [[[{ node: 'renderD130', gid: 44, vendor: 'other' }], '/dev/dri/renderD130'], [[], '/dev/dri/renderD128']] as const) {
      await seed('jellyfin', 'libraries', LIBS.map((l) => ({ ...l, created: true })));
      await env.pool.query("update media_managed set setup = 'hwaccel'");
      appliedJob();
      fake.dri = [...dri];
      expect(await tick()).toBe('finishing');
      expect(server.encoding).toMatchObject({ HardwareAccelerationType: 'vaapi', HardwareDecodingCodecs: ['h264', 'hevc'], VaapiDevice: device, TonemappingAlgorithm: 'bt2390' });
    }
  });

  it('a changed GPU after done sets the encoding again', async () => {
    await seed('jellyfin', 'done', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    await reauth();
    expect((await req('POST', '/apply', { kind: 'jellyfin', folders: FOLDERS, uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true })).statusCode).toBe(202);
    expect((await readManaged(env.pool)).setup).toBe('hwaccel');
    fake.media.desired.gpu = 'off';
    fake.job!.state = 'succeeded';
    fake.busy = false;
    expect(await run('done')).toEqual(['finishing', 'done']);
    expect(opBodies('gpu')).toEqual([]);
    expect(server.encoding).toMatchObject({ HardwareAccelerationType: 'none', HardwareDecodingCodecs: [], TonemappingAlgorithm: 'bt2390' });
    expect(server.encoding.VaapiDevice).toBeUndefined();
  });

  // ------------------------------------------------------------------------------------------------- review fix round 1

  const BOTH_IN_SERVER = () => [{ Name: 'Filme', ItemId: hex('a'), CollectionType: 'movies', Locations: ['/media/filme'] }, { Name: 'Serien', ItemId: hex('b'), CollectionType: 'tvshows', Locations: ['/media/serien'] }];
  const applyWith = (folders: unknown[]) => req('POST', '/apply', { kind: 'jellyfin', folders, uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true });

  it('a folder named like a kept library is refused: library_name_taken', async () => {
    await seed('jellyfin', 'done', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    server.folders = BOTH_IN_SERVER();
    await reauth();
    // the films folder removed (its library kept), a new folder named like it, in another case
    let r = await applyWith([FOLDERS[1], { rel: 'Filme-neu', name: ' filme ', type: 'movies' }]);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'library_name_taken' });
    // a rename onto the kept name likewise
    r = await applyWith([{ ...FOLDERS[1], name: 'Filme' }]);
    expect(r.json()).toEqual({ error: 'library_name_taken' });
    expect(opBodies('apply')).toEqual([]);
    expect(server.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect((await readManaged(env.pool)).libraries).toEqual(LIBS.map((l) => ({ ...l, created: true })));
  });

  it('ensureLibrary: a library of that name on another folder is library_name_taken, never marked created', async () => {
    await seed('jellyfin', 'libraries', [{ slug: 'filme-2', name: 'Filme', type: 'movies', rel: 'Filme-neu', created: false }]);
    await connected();
    appliedJob();
    server.folders = [BOTH_IN_SERVER()[0]!];
    expect(await tick()).toBe('libraries');
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'libraries', setupError: 'library_name_taken', libraries: [{ slug: 'filme-2', created: false }] });
    expect(calls('POST', '/Library/VirtualFolders')).toEqual([]);
  });

  it('finish-setup is keyed on the apply the setup follows now, not an earlier one', async () => {
    resetFake('ferrofin');
    server.wizardDone = true;
    server.user = { name: 'friendflix-admin', password: PASSWORD };
    await connected();
    server.folders = BOTH_IN_SERVER();
    // an earlier apply A with its finish job F, both done long ago
    await env.kv.set('media:managed:apply', 'a'.repeat(16), 600);
    await env.kv.set(`media:managed:finish:${'a'.repeat(16)}`, 'f'.repeat(16), 600);
    // a new apply B that came back to a later step with the password in the container (template update_pending)
    await seed('ferrofin', 'libraries', LIBS.map((l) => ({ ...l, created: true })));
    appliedJob();
    expect(await run('finishing')).toEqual(['hwaccel', 'finishing']);
    expect(await tick()).toBe('waiting');
    expect(opBodies('finish-setup')).toHaveLength(1);
    fake.job!.state = 'succeeded';
    fake.busy = false;
    expect(await tick()).toBe('done');

    // the updater restarted (no apply job to read): a finish key of its own, so finish-setup is sent again
    await seed('ferrofin', 'applying', LIBS.map((l) => ({ ...l, created: true })));
    fake.job = null;
    fake.media.container.template = 'update_pending';
    expect(await run('finishing')).toEqual(['first_run', 'api_key', 'libraries', 'hwaccel', 'finishing']);
    expect(await tick()).toBe('waiting');
    expect(opBodies('finish-setup')).toHaveLength(2);
  });

  describe('finish-setup is skipped only for an apply known to have sent no password', () => {
    const ferrofin = async () => {
      resetFake('ferrofin');
      server.wizardDone = true;
      server.user = { name: 'friendflix-admin', password: PASSWORD };
      await connected();
      server.folders = BOTH_IN_SERVER();
    };
    const ferrofinFolders = (extra: unknown[] = []) => req('POST', '/apply', { kind: 'ferrofin', folders: [...FOLDERS, ...extra], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true });

    it('(a) a first-run apply whose template reads current (unreadable) still gets finish-setup', async () => {
      await ferrofin();
      await reauth();
      expect((await ferrofinFolders()).statusCode).toBe(202);
      expect(Object.keys(opBodies('apply')[0]!)).toContain('firstRun');
      fake.media.container.template = 'current'; // the updater could not read the template: reads current
      fake.job!.state = 'succeeded';
      fake.busy = false;
      expect(await run('finishing')).toEqual(['first_run', 'api_key', 'libraries', 'libraries', 'libraries', 'hwaccel', 'finishing']);
      expect(await tick()).toBe('waiting');
      expect(opBodies('finish-setup')).toHaveLength(1);
    });

    it('(b) a re-apply without the password and a current template is done without finish-setup', async () => {
      await ferrofin();
      await seed('ferrofin', 'done', LIBS.map((l) => ({ ...l, created: true })));
      fake.media.container.template = 'current';
      await reauth();
      expect((await ferrofinFolders([{ rel: 'Musik', name: 'Musik', type: 'music' }])).statusCode).toBe(202);
      expect(Object.keys(opBodies('apply')[0]!)).not.toContain('firstRun');
      fake.job!.state = 'succeeded';
      fake.busy = false;
      expect(await run('done')).toEqual(['libraries', 'hwaccel', 'finishing', 'done']);
      expect(opBodies('finish-setup')).toEqual([]);
    });

    it('(c) an apply without a record gets finish-setup', async () => {
      await ferrofin();
      await seed('ferrofin', 'libraries', LIBS.map((l) => ({ ...l, created: true })));
      appliedJob(); // started elsewhere: no record of what it sent
      fake.media.container.template = 'current';
      expect(await run('finishing')).toEqual(['hwaccel', 'finishing']);
      expect(await tick()).toBe('waiting');
      expect(opBodies('finish-setup')).toHaveLength(1);
      // another job hides the finish job's result: finish-setup again, never done from the template
      fake.job = job('mediaserver-hdr-test', 'succeeded');
      fake.busy = false;
      expect(await tick()).toBe('waiting');
      expect(await tick()).toBe('waiting');
      expect(opBodies('finish-setup')).toHaveLength(2);
      fake.job!.state = 'succeeded';
      fake.busy = false;
      expect(await tick()).toBe('done');
    });
  });

  it('a refused apply after a retype still sends the setup back to libraries', async () => {
    await seed('jellyfin', 'done', LIBS.map((l) => ({ ...l, created: true })));
    await connected();
    server.folders = BOTH_IN_SERVER();
    fake.refuse.add('apply');
    await reauth();
    const r = await applyWith([FOLDERS[0], { ...FOLDERS[1], type: 'mixed' }]);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'busy' });
    expect(server.folders.map((f) => f.Name)).toEqual(['Filme']);
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'libraries', setupError: null, libraries: [{ slug: 'filme', created: true }, { slug: 'serien', type: 'mixed', created: false }] });
    // the container still mounts the folder: the tick creates the library again
    appliedJob();
    expect(await run('hwaccel')).toEqual(['libraries', 'hwaccel']);
    expect(calls('POST', '/Library/VirtualFolders').map((c) => [c.query.get('name'), c.query.get('collectionType'), c.query.get('paths')])).toEqual([['Serien', 'mixed', '/media/serien']]);
  });

  it('two ticks at once in the libraries step post one library', async () => {
    await seed('jellyfin', 'libraries');
    await connected();
    appliedJob();
    const results = await Promise.all([tick(), tick()]);
    expect(results.sort()).toEqual(['libraries', 'locked']);
    expect(calls('POST', '/Library/VirtualFolders').map((c) => c.query.get('name'))).toEqual(['Filme']);
    expect((await readManaged(env.pool)).libraries.map((l) => l.created)).toEqual([true, false]);
  });

  it('item ids beyond the cap fail instead of a short count', async () => {
    await connected();
    server.folders = BOTH_IN_SERVER();
    server.items[hex('a')] = Array.from({ length: 2000 }, (_, i) => i.toString(16).padStart(32, '0'));
    await expect(libraryItemIds(env.ctx.fetchImpl, MANAGED, keyOf(1), 'Filme', 2000)).rejects.toMatchObject({ code: 'unexpected' });
    server.items[hex('a')] = server.items[hex('a')]!.slice(1);
    expect(await libraryItemIds(env.ctx.fetchImpl, MANAGED, keyOf(1), 'Filme', 2000)).toHaveLength(1999);
    expect(await libraryItemIds(env.ctx.fetchImpl, MANAGED, keyOf(1), 'Filme')).toHaveLength(1999);
  });
});
