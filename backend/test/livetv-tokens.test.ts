// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 30: live tokens (spec §7.1), pinning, `/internal/authz/live` and revocation. Only the hash is stored; the
 * token is never logged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/cast.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { revokeSessions } from '../src/devices.js';
import { getLive } from '../src/live.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import {
  beatLiveToken, LIVE_CAP_S, liveSidHash, liveViewKey, MAX_LIVE_TOKENS, mintLiveToken, resolveLiveToken, VIEW_TTL_S, type LiveTokenRec,
} from '../src/livetv/tokens.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { lockUser } from '../src/users.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { invalidateLiveConversions, streamBitrateFor, streamKeyFor } from '../src/livetv/streams.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

vi.mock('../src/livetv/detect.js', async (orig) => ({
  ...(await orig<typeof import('../src/livetv/detect.js')>()),
  livetvInstalled: vi.fn(() => true),
}));

/** Jumps the wall clock forward (only Date is faked); cumulative within a test */
const skipClock = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };
afterEach(() => { vi.useRealTimers(); });

const key = keyFromBase64(ENC_KEY);
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
const logLines: string[] = [];
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
let adminId = '';
let adminDevice = '';

// people (fictional): Anna Beispiel (family) and Carla Probe (a second admin account)
const ANNA = '0d000000-0000-4000-a000-000000000001';
const CARLA = '0d000000-0000-4000-a000-000000000002';
const SID_A = liveSidHash('session-of-anna-on-her-phone-000000000001');
const SID_B = liveSidHash('session-of-anna-on-the-laptop-00000000002');
const IP1 = '192.0.2.10';
const IP2 = '192.0.2.20';
const IP3 = '192.0.2.30';

let source = '';
let news = '';
let nord = '';
let hafen = '';
/** channel id -> running stream key (the fake streamKeyFor) */
const running = new Map<string, string>();
/** channel id -> the bitrate livetv reports for its stream (bit/s); none = null */
const bitrates = new Map<string, number>();
const deps = { streamKeyFor: async (id: string) => running.get(id) ?? null };
/** what the route's real streamKeyFor reads: livetv's `GET /v1/streams` (stream keys are 32 hex there) */
const hexOf = (k: string) => Buffer.from(k).toString('hex').padEnd(32, '0').slice(0, 32);
const fakeLivetv = () => fakeHttp({
  'GET /healthz': () => ({ json: { ok: true, api: 1, version: '3.3.0', bootId: '0123456789abcdef' } }),
  'GET /v1/streams': () => ({ json: [...running].map(([channelId, k]) => ({
    channelId, streamKey: hexOf(k), mode: 'passthrough', since: 1, state: 'running', bitrate: bitrates.get(channelId) ?? null, errors: [], lastSegmentAt: 2,
  })) }),
});
const authz = (token: string, ip = IP1) => resolveLiveToken(env.ctx, token, ip, deps);
const status = async (token: string, ip = IP1) => (await authz(token, ip)).status;

type MintRec = Omit<LiveTokenRec, 'exp' | 'createdAt'>;
const mint = (o: Partial<MintRec> = {}) => mintLiveToken(env.ctx, {
  userId: ANNA, profileId: ANNA, deviceId: 'dev-anna-1', sidHash: SID_A, channelId: nord, channelName: 'Nordlicht TV',
  kind: 'live', via: 'local', remote: false, ...o,
});

/** every KV entry (key + value) as the memory store holds it */
const kvDump = () => [...((env.kv as unknown as { m: Map<string, { v: string; exp: number }> }).m.entries())];
/** remaining TTL of a KV key in ms (null = absent) */
const ttlMs = (k: string) => {
  const e = (env.kv as unknown as { m: Map<string, { v: string; exp: number }> }).m.get(k);
  return e && e.exp >= Date.now() ? e.exp - Date.now() : null;
};

async function account(id: string, role: string, name: string, jf: string): Promise<void> {
  const first = name.split(' ')[0]!.toLowerCase();
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
     values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, `${first}-sub`, `${first}@friend.example.com`, name, role, jf, encrypt(key, 'pw')]);
  await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name.split(' ')[0]]);
}
async function channel(name: string, group: string | null): Promise<string> {
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, group_override)
     values (gen_random_uuid(), $1, $2, $3, 'hls', $4, $5) returning id`,
    [source, `k-${name}`, encrypt(key, `https://iptv.example.com/live/${encodeURIComponent(name)}.m3u8`), name, group])).rows[0]!.id;
}

beforeAll(async () => {
  env = await makeEnv({}, { logger: { stream: { write: (l: string) => { logLines.push(l); } }, level: 'trace' } });
  admin = await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
  adminDevice = (JSON.parse((await env.kv.get(`sess:${admin.cookies.ff_sid}`))!) as { deviceId: string }).deviceId;
  await account(ANNA, 'family', 'Anna Beispiel', '1'.repeat(32));
  await account(CARLA, 'admin', 'Carla Probe', '2'.repeat(32));
  for (const [u, d] of [[ANNA, 'dev-anna-1'], [ANNA, 'dev-anna-2'], [ANNA, 'dev-anna-3'], [ANNA, 'dev-anna-4'], [ANNA, 'dev-anna-5'], [ANNA, 'dev-anna-6'], [CARLA, 'dev-carla-1']]) {
    await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1, $2, 'Browser', true)", [u, d]);
  }
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from livetv_channels; delete from livetv_group_roles; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources');
  await env.pool.query("update users set disabled = false, locked_reason = null, role = 'admin' where id = $1", [CARLA]);
  await env.pool.query('update users set disabled = false, locked_reason = null where id = $1', [ANNA]);
  source = (await env.pool.query<{ id: string }>("insert into livetv_sources(id, kind, name) values (gen_random_uuid(), 'manual', 'Eigene Feeds') returning id")).rows[0]!.id;
  news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), 'Nachrichten', true, 0) returning id")).rows[0]!.id;
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [news]);
  const fresh = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), 'DE | Neu', false, 1) returning id")).rows[0]!.id;
  nord = await channel('Nordlicht TV', news);
  hafen = await channel('Hafenkanal', fresh); // an unreleased group: nobody sees it on the user side (admins included)
  env.ctx.fetchImpl = fakeLivetv();
  // the real detection too: the route's livetvCall reads livetv's detected state, which the mocked livetvInstalled does not fill
  await detectLivetv(env.ctx, 0);
  invalidateLiveConversions();
  running.clear();
  running.set(nord, 'sk-nordlicht');
  running.set(hafen, 'sk-hafenkanal');
  for (const k of await env.kv.keys('ltv')) await env.kv.del(k);
  for (const k of await env.kv.keys(`play:${ANNA}:`)) await env.kv.del(k);
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
});

describe('live tokens', () => {
  it('only the hash is stored', async () => {
    const { token, hash, expiresAt } = await mint();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashToken(token));
    expect(expiresAt).toBeGreaterThan(Date.now() + (LIVE_CAP_S - 5) * 1000);
    expect(await authz(token)).toEqual({ status: 200, streamKey: 'sk-nordlicht', kind: 'live', maxAgeS: 2 });
    expect(await beatLiveToken(env.ctx, token, { userId: ANNA, sidHash: SID_A, ip: IP2 })).toEqual({ ok: true, expiresAt });
    expect(await env.kv.get(`ltv:${hash}`)).not.toBeNull();
    const dump = kvDump();
    expect(dump.some(([k]) => k.includes(hash))).toBe(true);
    for (const [k, e] of dump) {
      expect(k).not.toContain(token);
      expect(e.v).not.toContain(token);
    }
  });

  it('pins and refusals', async () => {
    // local: the first address pins, another one is refused
    const local = (await mint()).token;
    expect(await status(local, IP1)).toBe(200);
    expect(await status(local, IP2)).toBe(403);
    expect(await status(local, IP1)).toBe(200);
    // chromecast: one address
    const cc = (await mint({ deviceId: 'dev-anna-2', via: 'chromecast' })).token;
    expect(await status(cc, IP2)).toBe(200);
    expect(await status(cc, IP1)).toBe(403);
    // airplay: the phone, then the TV within 120 s; a third address is refused, both pinned ones keep working
    const ap = (await mint({ deviceId: 'dev-anna-3', via: 'airplay' })).token;
    expect(await status(ap, IP1)).toBe(200);
    expect(await status(ap, IP2)).toBe(200);
    expect(await status(ap, IP3)).toBe(403);
    expect(await status(ap, IP1)).toBe(200);
    expect(await status(ap, IP2)).toBe(200);
    // airplay after 120 s: no second address any more (kept alive by its first address's fetches)
    const late = (await mint({ deviceId: 'dev-anna-4', via: 'airplay' })).token;
    expect(await status(late, IP1)).toBe(200);
    for (let i = 0; i < 5; i++) { skipClock(25_000); expect(await status(late, IP1)).toBe(200); }
    expect(await status(late, IP2)).toBe(403);
  });

  it('a local token re-pins through a beat from the same session', async () => {
    const { token, expiresAt } = await mint();
    expect(await status(token, IP1)).toBe(200); // the phone on Wi-Fi
    // the phone moves to mobile data: refused until its own session beats from there
    expect(await status(token, IP2)).toBe(403);
    // a beat of another session of the same account slides the token but never moves the pin
    expect(await beatLiveToken(env.ctx, token, { userId: ANNA, sidHash: SID_B, ip: IP2 })).toEqual({ ok: true, expiresAt });
    expect(await status(token, IP2)).toBe(403);
    // another account's beat: gone, nothing moves
    expect(await beatLiveToken(env.ctx, token, { userId: CARLA, sidHash: SID_A, ip: IP2 })).toEqual({ ok: false, status: 410 });
    expect(await status(token, IP2)).toBe(403);
    // the minting session's beat from the new address re-pins
    expect(await beatLiveToken(env.ctx, token, { userId: ANNA, sidHash: SID_A, ip: IP2 })).toEqual({ ok: true, expiresAt });
    expect(await status(token, IP2)).toBe(200);
    expect(await status(token, IP1)).toBe(403);
    expect(await status(token, IP3)).toBe(403);
    // a cast token never re-pins (the TV's address is not the session's)
    const cc = (await mint({ deviceId: 'dev-anna-2', via: 'chromecast' })).token;
    expect(await status(cc, IP3)).toBe(200);
    expect((await beatLiveToken(env.ctx, cc, { userId: ANNA, sidHash: SID_A, ip: IP1 })).ok).toBe(true);
    expect(await status(cc, IP1)).toBe(403);
    expect(await status(cc, IP3)).toBe(200);
  });

  it('idle 90 s', async () => {
    const { token } = await mint();
    expect(await status(token)).toBe(200);
    skipClock(89_000);
    expect(await status(token)).toBe(200); // within the window (and a touch: it slides)
    skipClock(91_000);
    expect(await status(token)).toBe(401);
    // a beat slides it as well
    const b = (await mint({ deviceId: 'dev-anna-2' })).token;
    for (let i = 0; i < 4; i++) { skipClock(60_000); expect((await beatLiveToken(env.ctx, b, { userId: ANNA, sidHash: SID_A, ip: IP1 })).ok).toBe(true); }
    skipClock(91_000);
    expect(await status(b)).toBe(401);
    expect(await beatLiveToken(env.ctx, b, { userId: ANNA, sidHash: SID_A, ip: IP1 })).toEqual({ ok: false, status: 410 });
  });

  it('four per account', async () => {
    const tokens: string[] = [];
    for (let i = 1; i <= MAX_LIVE_TOKENS + 1; i++) {
      tokens.push((await mint({ deviceId: `dev-anna-${i}` })).token);
      skipClock(5); // distinct mint times
    }
    expect(await status(tokens[0]!)).toBe(410); // the oldest went
    for (const t of tokens.slice(1)) expect(await status(t)).toBe(200);
    // the same device's previous token goes with the next mint (a channel switch)
    const again = (await mint({ deviceId: 'dev-anna-2', channelId: hafen, channelName: 'Hafenkanal' })).token;
    expect(await status(tokens[1]!)).toBe(410);
    expect(await status(again)).toBe(403); // Hafenkanal's group is unreleased (the token itself exists)
    for (const t of tokens.slice(2)) expect(await status(t)).toBe(200);
  });

  it('revocation paths', async () => {
    // sign-out (revokeSessions of the account)
    const signout = (await mint()).token;
    expect(await status(signout)).toBe(200);
    await revokeSessions(env.ctx, ANNA);
    expect(await status(signout)).toBe(410);
    // device removal: only that device's token
    const d1 = (await mint({ deviceId: 'dev-anna-1' })).token;
    const d2 = (await mint({ deviceId: 'dev-anna-2' })).token;
    await revokeSessions(env.ctx, ANNA, 'dev-anna-1');
    expect(await status(d1)).toBe(410);
    expect(await status(d2)).toBe(200);
    // account lock
    await lockUser(env.ctx, null, ANNA, 'manual');
    expect(await status(d2)).toBe(410);
    await env.pool.query('update users set disabled = false, locked_reason = null where id = $1', [ANNA]);
    // profile switch of the minting device (the logged-in admin, through the route)
    const second = (await env.pool.query<{ id: string }>(
      `insert into profiles(id, user_id, name, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), $1, 'Zweit', $2, 'admin-zweit', $3) returning id`, [adminId, '3'.repeat(32), encrypt(key, 'zpw')])).rows[0]!.id;
    const own = (await mint({ userId: adminId, profileId: adminId, deviceId: adminDevice })).token;
    expect(await status(own)).toBe(200);
    const sel = await env.app.inject({ method: 'POST', url: `/api/profiles/${second}/select`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: {} });
    expect(sel.statusCode).toBe(200);
    expect(await status(own)).toBe(410);
    // channel hidden: refused once the 2 s rights memo has run out
    const hid = (await mint()).token;
    expect(await status(hid)).toBe(200);
    await env.pool.query('update livetv_channels set hidden = true where id = $1', [nord]);
    invalidateLivetvRights();
    skipClock(2_100);
    expect(await status(hid)).toBe(403);
    // the group right removed
    await env.pool.query('update livetv_channels set hidden = false where id = $1', [nord]);
    invalidateLivetvRights();
    const grp = (await mint({ deviceId: 'dev-anna-2' })).token;
    expect(await status(grp)).toBe(200);
    await env.pool.query('delete from livetv_group_roles where group_id = $1', [news]);
    invalidateLivetvRights();
    expect(await status(grp)).toBe(200); // memo (2 s)
    skipClock(2_100);
    expect(await status(grp)).toBe(403);
  });

  it('stream gone → 410', async () => {
    const { token } = await mint();
    expect(await status(token)).toBe(200);
    running.delete(nord);
    expect(await status(token)).toBe(410);
    // the route reads livetv's list (Task 31's streamKeyFor): the stream key while it runs, 410 once livetv no longer lists it
    const routed = (await mint({ deviceId: 'dev-anna-2' })).token;
    const viaRoute = () => env.app.inject({ method: 'POST', url: '/internal/authz/live', headers: H, payload: { token: routed, ip: IP1 } });
    running.set(nord, 'sk-nordlicht');
    invalidateLiveConversions();
    expect((await viaRoute()).json()).toEqual({ streamKey: hexOf('sk-nordlicht'), kind: 'live', maxAgeS: 2 });
    running.delete(nord);
    invalidateLiveConversions();
    const r = await viaRoute();
    expect(r.statusCode).toBe(410);
    expect(r.json()).toEqual({ error: 'gone' });
    // a 410 takes no pin: once the stream runs, any address may take the first one
    const p = (await mint({ deviceId: 'dev-anna-3' })).token;
    running.delete(nord);
    expect(await status(p, IP1)).toBe(410);
    running.set(nord, 'sk-nordlicht');
    expect(await status(p, IP2)).toBe(200);
    expect(await status(p, IP1)).toBe(403);
  });

  it('a mint revokes only the same device\'s tokens of the same kind (R8)', async () => {
    const carla = { userId: CARLA, profileId: CARLA, deviceId: 'dev-carla-1', channelId: hafen, channelName: 'Hafenkanal' };
    const n1 = (await mint({ ...carla, channelId: nord, channelName: 'Nordlicht TV' })).token;
    skipClock(5);
    const t1 = (await mint({ ...carla, test: true })).token;
    skipClock(5);
    expect(await status(n1)).toBe(200);
    expect(await status(t1)).toBe(200);
    const t2 = (await mint({ ...carla, test: true })).token;
    skipClock(5);
    expect(await status(t1)).toBe(410);
    expect(await status(n1)).toBe(200);
    expect(await status(t2)).toBe(200);
    const n2 = (await mint({ ...carla, channelId: nord, channelName: 'Nordlicht TV' })).token;
    expect(await status(n1)).toBe(410);
    expect(await status(n2)).toBe(200);
    expect(await status(t2)).toBe(200);
  });

  it('concurrent mints converge', async () => {
    const ts = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mint({ deviceId: `dev-anna-${i}` }).then((m) => m.token)));
    const codes = await Promise.all(ts.map((t) => status(t)));
    expect(codes.filter((c) => c === 200)).toHaveLength(MAX_LIVE_TOKENS);
    const same = await Promise.all([mint({ deviceId: 'dev-anna-1' }), mint({ deviceId: 'dev-anna-1' })]);
    const sc = await Promise.all(same.map((m) => status(m.token)));
    expect(sc.filter((c) => c === 200)).toHaveLength(1);
  });

  it('a beat of a refused token answers 410 and refreshes nothing', async () => {
    const { token, hash } = await mint();
    expect(await status(token)).toBe(200);
    await env.pool.query('update livetv_channels set hidden = true where id = $1', [nord]);
    invalidateLivetvRights();
    const before = ttlMs(liveViewKey(hash));
    skipClock(2_100);
    expect(await beatLiveToken(env.ctx, token, { userId: ANNA, sidHash: SID_A, ip: IP2 })).toEqual({ ok: false, status: 410 });
    expect(ttlMs(liveViewKey(hash))).toBeLessThanOrEqual(before! - 2_000); // not reset to VIEW_TTL_S
    expect(await env.kv.get(`ltvpin:${hash}`)).toBe(IP1); // not re-pinned
  });

  it('logout through the route revokes the device\'s live tokens', async () => {
    await revokeSessions(env.ctx, adminId);
    const s = await env.login();
    admin = s;
    const dev = (JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as { deviceId: string }).deviceId;
    const t = (await mint({ userId: adminId, profileId: adminId, deviceId: dev })).token;
    expect(await status(t)).toBe(200);
    const out = await env.app.inject({ method: 'POST', url: '/auth/logout', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });
    expect(out.statusCode).toBe(200);
    expect(await status(t)).toBe(410);
  });

  it('mint seeds the viewer key', async () => {
    const { hash } = await mint();
    expect(await env.kv.get(liveViewKey(hash))).toBe(nord);
    expect(ttlMs(liveViewKey(hash))).toBeLessThanOrEqual(VIEW_TTL_S * 1000);
    expect(ttlMs(liveViewKey(hash))).toBeGreaterThan(0);
    expect(await getLive(env.ctx, ANNA, `ltv-${hash.slice(0, 24)}`)).toBeNull(); // the live record waits for the first fetch
  });

  it('viewer and live record', async () => {
    const { token, hash } = await mint({ remote: true });
    const ps = `ltv-${hash.slice(0, 24)}`;
    expect(ps).toMatch(/^ltv-[0-9a-f]{24}$/);
    expect(await status(token)).toBe(200);
    expect(await env.kv.get(liveViewKey(hash))).toBe(nord);
    expect(ttlMs(liveViewKey(hash))).toBeGreaterThan(44_000);
    expect(ttlMs(liveViewKey(hash))).toBeLessThanOrEqual(45_000);
    const live = await getLive(env.ctx, ANNA, ps);
    expect(live).toMatchObject({ userId: ANNA, userName: 'Anna Beispiel', itemId: `ch:${nord}`, title: 'Nordlicht TV', source: 'livetv', playSessionId: ps, deviceId: 'dev-anna-1', remote: true });
    // a second fetch within 20 s writes nothing
    await env.kv.del(liveViewKey(hash));
    await env.kv.del(`play:${ANNA}:${ps}`);
    skipClock(10_000);
    expect(await status(token)).toBe(200);
    expect(await env.kv.get(liveViewKey(hash))).toBeNull();
    expect(await getLive(env.ctx, ANNA, ps)).toBeNull();
    // 20 s after the first touch: touched again
    skipClock(11_000);
    expect(await status(token)).toBe(200);
    expect(await env.kv.get(liveViewKey(hash))).toBe(nord);
    expect((await getLive(env.ctx, ANNA, ps))?.source).toBe('livetv');
  });

  it('the live record carries the stream bitrate, none while unknown', async () => {
    const { token, hash } = await mint();
    const ps = `ltv-${hash.slice(0, 24)}`;
    const real = { streamKeyFor: (id: string) => streamKeyFor(env.ctx, id), bitrateFor: (id: string) => streamBitrateFor(env.ctx, id) };
    expect((await resolveLiveToken(env.ctx, token, IP1, real)).status).toBe(200);
    expect((await getLive(env.ctx, ANNA, ps))?.bitrate).toBeUndefined(); // livetv has not measured the stream yet
    bitrates.set(nord, 4_200_000);
    invalidateLiveConversions();
    skipClock(21_000);
    expect((await resolveLiveToken(env.ctx, token, IP1, real)).status).toBe(200);
    expect((await getLive(env.ctx, ANNA, ps))?.bitrate).toBe(4_200_000);
  });

  it('an admin test token plays a channel of an unreleased group', async () => {
    const carla = { userId: CARLA, profileId: CARLA, deviceId: 'dev-carla-1', channelId: hafen, channelName: 'Hafenkanal' };
    const t = (await mint({ ...carla, test: true })).token;
    expect(await status(t)).toBe(200);
    expect(await status((await mint({ ...carla })).token)).toBe(403); // the same channel without `test`
    // the admin role lost: refused (after the rights memo)
    const t2 = (await mint({ ...carla, test: true })).token;
    expect(await status(t2)).toBe(200);
    await env.pool.query("update users set role = 'family' where id = $1", [CARLA]);
    skipClock(2_100);
    expect(await status(t2)).toBe(403);
    expect(await status((await mint({ ...carla, test: true })).token)).toBe(403);
    await env.pool.query("update users set role = 'admin' where id = $1", [CARLA]);
    // the channel missing from its list
    await env.pool.query('update livetv_channels set missing_since = now() where id = $1', [hafen]);
    expect(await status((await mint({ ...carla, test: true })).token)).toBe(403);
    // or its source switched off
    await env.pool.query('update livetv_channels set missing_since = null where id = $1', [hafen]);
    expect(await status((await mint({ ...carla, test: true })).token)).toBe(200);
    await env.pool.query('update livetv_sources set enabled = false where id = $1', [source]);
    expect(await status((await mint({ ...carla, test: true })).token)).toBe(403);
  });

  it('never logged', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    const from = logLines.length;
    try {
      const { token } = await mint();
      const live = (b: unknown, h: Record<string, string> = H) => env.app.inject({ method: 'POST', url: '/internal/authz/live', headers: h, payload: b as object });
      expect((await live({ token, ip: IP1 })).statusCode).toBe(200); // the stream runs in livetv: IP1 pins
      expect((await live({ token, ip: IP2 })).statusCode).toBe(403);
      expect((await live({ token, ip: IP1 }, { 'x-internal-secret': 'wrong' })).statusCode).toBe(403);
      expect((await live({ token, ip: IP1, extra: 1 })).statusCode).toBe(400); // strict
      expect((await live({ token: `${token}x`, ip: IP1 })).statusCode).toBe(400);
      expect((await live({ token, ip: '' })).statusCode).toBe(400);
      expect((await live({ token: 'A'.repeat(43), ip: IP1 })).json()).toEqual({ error: 'unauthenticated' });
      await beatLiveToken(env.ctx, token, { userId: ANNA, sidHash: SID_A, ip: IP2 });
      await revokeSessions(env.ctx, ANNA);
      expect((await live({ token, ip: IP2 })).json()).toEqual({ error: 'gone' });
      const all = [...lines, ...logLines.slice(from)].join('\n');
      expect(logLines.length).toBeGreaterThan(from); // the request log was captured
      expect(all).not.toContain(token);
      expect(all).not.toContain(token.slice(0, 20));
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});
