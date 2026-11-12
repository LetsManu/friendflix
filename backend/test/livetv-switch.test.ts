// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 32: a channel switch releases the old stream at once when the new start needs its slot (spec §7.4 "Release on
 * switch", rulings 36–38, Review Focus 6 and 7). livetv is a fake (`ctx.fetchImpl`) that records the order of every `POST` and `DELETE`
 * of `/v1/streams`. The ordering hooks (`__switchHooks`) only run real requests of other viewers; they never write a KV key themselves.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/cast.js';
import { __resetConvMemo, countConversions } from '../src/convbudget.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { CHANNEL_SELECT, toEffective, type EffectiveRow } from '../src/livetv/channels.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { listEvents } from '../src/livetv/events.js';
import { invalidateLivetvRights } from '../src/livetv/rights.js';
import { __switchHooks, invalidateLiveConversions, livetvTick, startOrJoin } from '../src/livetv/streams.js';
import { deviceLiveView, liveViewKey, mintLiveToken, revokeLiveToken } from '../src/livetv/tokens.js';
import type { StreamView } from '../src/livetv/wire.js';
import { invalidateRights } from '../src/rights.js';
import { invalidateRoles } from '../src/roles.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const key = keyFromBase64(ENC_KEY);
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };

let env: TestEnv;
let anna: Sess;
let ben: Sess;
let carla: Sess;
const annaId = '0d000000-0000-4000-a000-0000000000a1';
const benId = '0d000000-0000-4000-a000-0000000000b1';
const carlaId = '0d000000-0000-4000-a000-0000000000c1';
let adminId = '';

// ---- the fake livetv: lists what it runs, records POST / DELETE of /v1/streams in order ----
const streams = new Map<string, StreamView>();
let order: string[] = [];
let keyN = 0;
const hexKey = () => (++keyN).toString(16).padStart(32, '0');
const view = (channelId: string, o: Partial<StreamView> = {}): StreamView => ({
  channelId, streamKey: hexKey(), mode: 'remux', since: Date.now(), state: 'running', bitrate: 4_000_000, errors: [], lastSegmentAt: Date.now(), ...o,
});
const system = () => ({
  cpu: { model: 'Testprozessor', cores: 4, loadPct: 10 }, gpu: { devices: ['/dev/dri/renderD128'], driver: 'iHD', readable: true, busyPct: null },
  encoders: ['h264_qsv', 'h264_vaapi', 'libx264'], cache: { usedBytes: 0, maxBytes: 6_000_000_000 }, recordings: null, srt: { ports: [9000, 9001] },
});
function fakeLivetv() {
  env.ctx.fetchImpl = fakeHttp({
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '3.3.0', bootId: '0123456789abcdef' } }),
    'GET /v1/system': () => ({ json: system() }),
    'GET /v1/streams': () => ({ json: [...streams.values()] }),
    'POST /v1/streams': (_u, _i, b: Record<string, unknown>) => {
      const id = String(b.channelId);
      order.push(`POST:${id}`);
      const had = streams.get(id);
      if (had && had.state !== 'failed') return { json: { streamKey: had.streamKey, state: had.state } };
      const v = view(id, { mode: b.mode as StreamView['mode'] });
      streams.set(id, v);
      return { json: { streamKey: v.streamKey, state: v.state } };
    },
    'DELETE /v1/streams/[\\w-]+': (u) => {
      const id = u.pathname.split('/').pop()!;
      order.push(`DELETE:${id}`);
      return streams.delete(id) ? { status: 204 } : { status: 404, json: { error: 'not_found' } };
    },
    'GET /v1/ingest': () => ({ json: [] }),
    'PUT /v1/ingest': () => ({ json: { ok: true, listening: [] } }),
  });
}
const dels = () => order.filter((o) => o.startsWith('DELETE:'));

// ---- data ----
let news = '';
async function addSource(maxStreams: number | null = null): Promise<string> {
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_sources(id, kind, name, url_enc, max_streams) values (gen_random_uuid(), 'm3u', 'Anbieter A', $1, $2) returning id`,
    [encrypt(key, 'https://iptv.example.com/get.php?username=anna&password=geheim'), maxStreams])).rows[0]!.id;
}
async function addChannel(source: string, name: string, number: number, kind: 'hls' | 'ts' | 'srt' = 'hls'): Promise<string> {
  const url = kind === 'srt' ? 'srt://192.0.2.10:9000?streamid=geheim' : `https://iptv.example.com/live/anna/geheim/${number}.${kind === 'hls' ? 'm3u8' : 'ts'}`;
  return (await env.pool.query<{ id: string }>(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, import_number, group_override)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) returning id`,
    [source, `k-${name}`, encrypt(key, url), kind, name, number, news])).rows[0]!.id;
}
const effective = async (id: string) => toEffective((await env.pool.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = $1`, [id])).rows[0]!);

let addr = 0;
const call = (s: Sess, method: 'POST' | 'DELETE', url: string, payload: object) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${(++addr % 200) + 1}`, payload });
const watch = (s: Sess, id: string, body: Record<string, unknown> = {}) => call(s, 'POST', `/api/livetv/channels/${id}/watch`, body);
const authz = (token: string, ip = '192.0.2.250') => env.app.inject({ method: 'POST', url: '/internal/authz/live', headers: H, payload: { token, ip } });
const released = async () => (await listEvents(env.ctx)).filter((e) => e.code === 'released_on_switch').map((e) => e.channelId).reverse();
const grants = async () => (await env.kv.keys('conv:grant:')).sort();

/** drives a promise that waits on (faked) timers: 100-ms steps of the fake clock, with real I/O turns in between */
async function drive<T>(p: Promise<T>, stepMs = 100, max = 400): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < max && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
    for (let j = 0; j < 5 && !done; j++) await new Promise((r) => setImmediate(r));
  }
  return p;
}

async function person(id: string, sub: string, name: string, role: string): Promise<Sess> {
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $2, $7)`,
    [id, sub, `${sub}@friend.example.com`, name, role, id.replace(/-/g, '').slice(0, 32), encrypt(key, 'pw')]);
  const s = await env.login({ sub, email: `${sub}@friend.example.com`, name, groups: [] });
  await env.pool.query('update devices set approved = true where user_id = $1', [id]);
  return s;
}

beforeAll(async () => {
  env = await makeEnv();
  await env.login(); // the first sign-in is the admin
  adminId = (await env.pool.query<{ id: string }>("select id from users where role = 'admin' limit 1")).rows[0]!.id;
  anna = await person(annaId, 'anna', 'Anna Beispiel', 'family');
  ben = await person(benId, 'ben', 'Ben Muster', 'friend');
  carla = await person(carlaId, 'carla', 'Carla Probe', 'family');
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  __resetConvMemo();
  await env.pool.query('delete from livetv_channels; delete from livetv_group_roles; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from livetv_logos');
  for (const p of ['ltv', 'conv:', 'play:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  streams.clear();
  order = [];
  for (const k of Object.keys(__switchHooks)) delete (__switchHooks as Record<string, unknown>)[k];
  fakeLivetv();
  await detectLivetv(env.ctx, 0);
  invalidateLiveConversions();
  news = (await env.pool.query<{ id: string }>("insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), 'Nachrichten', true, 0) returning id")).rows[0]!.id;
  await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family'), ($1, 'friend')", [news]);
  invalidateLivetvRights();
  invalidateRoles(env.ctx);
  invalidateRights();
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of Object.keys(__switchHooks)) delete (__switchHooks as Record<string, unknown>)[k];
});

describe('release on switch', () => {
  it('zapping on a 1-connection provider releases the old stream at once (Review Focus 7)', async () => {
    const one = await addSource(1);
    const a = await addChannel(one, 'Hafenkanal', 4);
    const b = await addChannel(one, 'Nordlicht TV', 1);
    const t0 = Date.now();
    const wa = await watch(anna, a);
    expect(wa.statusCode, wa.body).toBe(200);
    // Anna's TV is A's only viewer: watching B (same source, max 1) stops A before B starts
    const wb = await watch(anna, b);
    expect(wb.statusCode, wb.body).toBe(200);
    expect(order).toEqual([`POST:${a}`, `DELETE:${a}`, `POST:${b}`]);
    expect(await released()).toEqual([a]);
    expect((await authz(wb.json().token)).statusCode).toBe(200);
    // and back to A at once: B is released the same way
    const back = await watch(anna, a);
    expect(back.statusCode, back.body).toBe(200);
    expect(order).toEqual([`POST:${a}`, `DELETE:${a}`, `POST:${b}`, `DELETE:${b}`, `POST:${a}`]);
    expect(await released()).toEqual([a, b]);
    expect(Date.now() - t0).toBeLessThan(3000); // no 60-s linger and no 5-s wait anywhere
    expect(await env.kv.keys('ltv:stopping:')).toEqual([]);
    expect(await env.kv.keys('ltv:zero:')).toEqual([]);
  });

  it('a budget of 1 releases the old transcode', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const src = await addSource();
    const a = await addChannel(src, 'Hafenkanal', 4, 'srt'); // SRT without a probe: expected transcode
    const b = await addChannel(src, 'Nordlicht TV', 1, 'srt');
    expect((await watch(anna, a)).json().mode).toBe('transcode');
    expect(await grants()).toEqual([`conv:grant:live:${a}`]);
    const wb = await watch(anna, b);
    expect(wb.statusCode, wb.body).toBe(200);
    expect(wb.json().mode).toBe('transcode');
    expect(order).toEqual([`POST:${a}`, `DELETE:${a}`, `POST:${b}`]);
    expect(await grants()).toEqual([`conv:grant:live:${b}`]);
    expect((await countConversions(env.ctx))?.map((e) => e.key)).toEqual([`live:${b}`]);
    expect(await released()).toEqual([a]);
  });

  it('no release when someone else watches the old channel', async () => {
    const one = await addSource(1);
    const a = await addChannel(one, 'Hafenkanal', 4);
    const b = await addChannel(one, 'Nordlicht TV', 1);
    expect((await watch(anna, a)).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await watch(ben, a)).statusCode).toBe(200); // Ben joins A
    vi.setSystemTime(Date.now() + 10_000); // Ben's token was touched 10 s ago: a viewer
    const r = await watch(anna, b);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'provider_limit', max: 1, running: [{ id: a, number: 4, name: 'Hafenkanal', logo: null }] });
    expect(dels()).toEqual([]);
    expect(await grants()).toEqual([]);
    expect(await env.kv.keys('ltv:stopping:')).toEqual([]);
    // 50 s after Ben's last touch he is no viewer any more: released
    vi.setSystemTime(Date.now() + 40_000);
    const again = await watch(anna, b);
    expect(again.statusCode, again.body).toBe(200);
    expect(order).toEqual([`POST:${a}`, `DELETE:${a}`, `POST:${b}`]);
  });

  it('a cast of the old channel counts as a viewer; an admin test preview too', async () => {
    const one = await addSource(1);
    const a = await addChannel(one, 'Hafenkanal', 4);
    const b = await addChannel(one, 'Nordlicht TV', 1);
    expect((await watch(anna, a)).statusCode).toBe(200);
    const cast = await watch(carla, a, { via: 'chromecast' }); // Carla casts A to the living-room TV
    expect(cast.statusCode, cast.body).toBe(200);
    const r = await watch(anna, b);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('provider_limit');
    expect(dels()).toEqual([]);
    // the cast ends; an admin's stream-test preview of A is a viewer as well
    expect((await call(carla, 'DELETE', '/api/livetv/watch', { token: cast.json().token })).statusCode).toBe(204);
    const preview = await mintLiveToken(env.ctx, {
      userId: adminId, profileId: adminId, deviceId: 'admin-desk', sidHash: 'x', channelId: a, channelName: 'Hafenkanal', kind: 'live', via: 'local', remote: false, test: true,
    });
    expect((await watch(anna, b)).statusCode).toBe(503);
    expect(dels()).toEqual([]);
    await revokeLiveToken(env.ctx, preview.hash);
    expect((await watch(anna, b)).statusCode).toBe(200);
    expect(dels()).toEqual([`DELETE:${a}`]);
  });

  it('a viewer counted before the recount keeps the stream (Review Focus 6)', async () => {
    const one = await addSource(1);
    const a = await addChannel(one, 'Hafenkanal', 4);
    const b = await addChannel(one, 'Nordlicht TV', 1);
    expect((await watch(anna, a)).statusCode).toBe(200);
    let benWatch: Awaited<ReturnType<typeof watch>> | null = null;
    let seeded: string | null = null;
    // between Anna's admission and the recount, Ben's real watch of A lands; the hook writes nothing itself
    __switchHooks.beforeRelease = async (id) => {
      if (id !== a || benWatch) return;
      benWatch = await watch(ben, a);
      if (benWatch.statusCode === 200) seeded = await env.kv.get(liveViewKey(hashToken(benWatch.json().token))); // read only
    };
    const r = await watch(anna, b);
    expect(benWatch!.statusCode, benWatch!.body).toBe(200);
    expect(seeded).toBe(a); // the mint seeded Ben's viewer key (F9): that is what the recount sees
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'provider_limit', max: 1, running: [{ id: a, number: 4, name: 'Hafenkanal', logo: null }] });
    expect(dels()).toEqual([]);
    expect(order).toEqual([`POST:${a}`]);
    expect(await env.kv.keys('ltv:stopping:')).toEqual([]);
    expect(await grants()).toEqual([]);
    expect((await authz(benWatch!.json().token)).statusCode).toBe(200); // A still runs for Ben
  });

  it('a join that has not minted its token yet keeps the stream', async () => {
    const one = await addSource(1);
    const a = await addChannel(one, 'Hafenkanal', 4);
    const b = await addChannel(one, 'Nordlicht TV', 1);
    expect((await watch(anna, a)).statusCode).toBe(200);
    let joined: unknown = null;
    // Ben's watch has joined A (startOrJoin answered) but his token is not minted yet when Anna's release counts again
    __switchHooks.beforeRelease = async (id) => {
      if (id !== a || joined) return;
      joined = await startOrJoin(env.ctx, { userId: benId, deviceId: 'tv-ben', role: 'friend' }, await effective(a), { id: benId, kids: false });
    };
    const r = await watch(anna, b);
    expect(joined).toMatchObject({ streamKey: streams.get(a)!.streamKey });
    expect(r.statusCode).toBe(503);
    expect(dels()).toEqual([]);
    expect(await env.kv.keys('ltv:stopping:')).toEqual([]);
  });

  for (const max of [1, 2]) {
    it(`a viewer who joins during the release never gets a dead stream (Review Focus 6, max_streams ${max})`, async () => {
      const one = await addSource(1);
      const a = await addChannel(one, 'Hafenkanal', 4);
      const b = await addChannel(one, 'Nordlicht TV', 1);
      expect((await watch(anna, a)).statusCode).toBe(200);
      let benP: ReturnType<typeof watch> | null = null;
      let waiting!: () => void;
      const benWaits = new Promise<void>((r) => { waiting = r; });
      __switchHooks.stoppingWait = (id) => { if (id === a) waiting(); };
      // the marker is set: Ben's real watch of A arrives now and must wait for the release (the hook writes no KV key)
      __switchHooks.afterMarker = async (id) => {
        if (id !== a || benP) return;
        if (max === 2) await env.pool.query('update livetv_sources set max_streams = 2 where id = $1', [one]); // the admin raised the limit meanwhile
        benP = watch(ben, a);
        await benWaits;
      };
      const r = await watch(anna, b);
      expect(r.statusCode, r.body).toBe(200);
      const bw = await benP!;
      if (max === 1) {
        // B now holds the only connection: Ben gets the normal refusal, never a stream that is being deleted
        expect(bw.statusCode).toBe(503);
        expect(bw.json()).toEqual({ error: 'provider_limit', max: 1, running: [{ id: b, number: 1, name: 'Nordlicht TV', logo: null }] });
        expect(order).toEqual([`POST:${a}`, `DELETE:${a}`, `POST:${b}`]);
      } else {
        // room for both: A starts again through the normal start path, after its DELETE
        expect(bw.statusCode, bw.body).toBe(200);
        expect(order).toEqual([`POST:${a}`, `DELETE:${a}`, `POST:${b}`, `POST:${a}`]);
        expect((await authz(bw.json().token)).json().streamKey).toBe(streams.get(a)!.streamKey);
      }
      expect(await env.kv.keys('ltv:stopping:')).toEqual([]);
    });
  }

  it('a stopping marker that does not go away is waited for at most 5 s (fake clock)', async () => {
    const src = await addSource(1);
    const a = await effective(await addChannel(src, 'Hafenkanal', 4));
    streams.set(a.id, view(a.id, { mode: 'passthrough' }));
    await env.kv.set(`ltv:stopping:${a.id}`, 'stuck-release', 20); // a release that hangs (setup, not an ordering hook)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t0 = Date.now();
    const r = await drive(startOrJoin(env.ctx, { userId: benId, deviceId: 'tv-ben', role: 'friend' }, a, { id: benId, kids: false }), 50, 600);
    const waited = Date.now() - t0;
    expect(r).toMatchObject({ streamKey: streams.get(a.id)!.streamKey });
    expect(waited).toBeGreaterThanOrEqual(5_000);
    expect(waited).toBeLessThan(8_000); // the driver's 50-ms steps run on during I/O; far below the 25-s join wait
    // then treated as not running: the normal start path (livetv's POST is idempotent), its own stream never counted against itself
    expect(order).toEqual([`POST:${a.id}`]);
  });

  it('not needed → the old stream lingers', async () => {
    const src = await addSource();
    const a = await addChannel(src, 'Hafenkanal', 4);
    const b = await addChannel(src, 'Nordlicht TV', 1);
    expect((await watch(anna, a)).statusCode).toBe(200);
    expect((await watch(anna, b)).statusCode).toBe(200);
    expect(dels()).toEqual([]);
    expect(await released()).toEqual([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    await livetvTick(env.ctx);
    vi.setSystemTime(Date.now() + 59_000);
    await livetvTick(env.ctx);
    expect(dels()).toEqual([]);
    vi.setSystemTime(Date.now() + 2_000);
    await livetvTick(env.ctx);
    expect(dels()).toEqual([`DELETE:${a}`]);
  });

  it('the tick leaves a channel that is being released alone', async () => {
    const src = await addSource();
    const a = await addChannel(src, 'Hafenkanal', 4);
    streams.set(a, view(a));
    await env.kv.set(`ltv:zero:${a}`, String(Date.now() - 120_000), 3600);
    await env.kv.set(`ltv:stopping:${a}`, 'a-release', 20);
    await livetvTick(env.ctx);
    expect(dels()).toEqual([]);
  });

  it('a remux old stream is not released for the budget', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const src = await addSource();
    const other = await addChannel(src, 'Bergblick Sport', 7, 'srt');
    streams.set(other, view(other, { mode: 'transcode' })); // fills the budget of 1
    const a = await addChannel(src, 'Hafenkanal', 4, 'ts'); // remux, takes no slot
    const b = await addChannel(src, 'Nordlicht TV', 1, 'srt');
    expect((await watch(anna, a)).json().mode).toBe('remux');
    const r = await watch(anna, b);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('live_full');
    expect(dels()).toEqual([]);
    expect(streams.has(a)).toBe(true);
    expect(await grants()).toEqual([]);
  });

  it('a running target is a join, never a release', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const one = await addSource(1);
    const a = await addChannel(one, 'Hafenkanal', 4, 'srt');
    const b = await addChannel(one, 'Nordlicht TV', 1);
    expect((await watch(anna, a)).statusCode).toBe(200);
    streams.set(b, view(b, { mode: 'passthrough' })); // B runs already (over the limit, e.g. started before the limit was set)
    const r = await watch(anna, b);
    expect(r.statusCode, r.body).toBe(200);
    expect(dels()).toEqual([]);
    expect(order).toEqual([`POST:${a}`]);
    expect(await grants()).toEqual([`conv:grant:live:${a}`]);
  });

  it('the old token is still replaced', async () => {
    const one = await addSource(1);
    const a = await addChannel(one, 'Hafenkanal', 4);
    const b = await addChannel(one, 'Nordlicht TV', 1);
    const wa = (await watch(anna, a)).json();
    expect((await authz(wa.token)).statusCode).toBe(200);
    const view0 = await deviceLiveView(env.ctx, annaId, (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id = $1', [annaId])).rows[0]!.device_id);
    expect(view0).toEqual({ hash: hashToken(wa.token), channelId: a });
    const wb = (await watch(anna, b)).json();
    expect(dels()).toEqual([`DELETE:${a}`]);
    expect((await authz(wa.token)).statusCode).toBe(410);
    expect((await authz(wb.token)).statusCode).toBe(200);
  });
});
