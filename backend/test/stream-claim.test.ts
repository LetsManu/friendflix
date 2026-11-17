// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUserLimits } from '../src/limits.js';
import { streamLimitRefusal } from '../src/livetv/routes.js';
import { rand, sessionKey } from '../src/session.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Security audit G1: the per-role stream limit is enforced where streams are served (the gateway asks /internal/stream for every
// playlist / segment / stream request of a play session), not where the client reports its playback.
type Sess = { cookies: Record<string, string>; csrf: string };
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
const ITEMS = [1, 2, 3, 4].map((n) => String(n).repeat(32));
const TICKS = 90 * 600_000_000;
const NONE = { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null };

let env: TestEnv;
let me: Sess;
let other: Sess; // the same account on a second device
let userId = '';
let psN = 0;

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const info = async (s: Sess, itemId: string) => call(s, 'POST', '/api/playback/info', { itemId });
const claim = (s: Sess, itemId: string, ps?: string) =>
  env.app.inject({ method: 'POST', url: '/internal/stream', headers: H, payload: { sid: s.cookies.ff_sid, itemId, ...(ps ? { ps } : {}) } });
const report = (s: Sess, kind: 'start' | 'progress' | 'stop', itemId: string, ps: string) =>
  call(s, 'POST', `/api/playback/${kind}`, { itemId, playSessionId: ps, mediaSourceId: 'ms1', positionTicks: 0 });

/** a second session of the account on another (approved) device */
async function secondDevice(s: Sess): Promise<Sess> {
  const raw = JSON.parse((await env.kv.get(sessionKey(s.cookies.ff_sid!)))!) as Record<string, unknown>;
  await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1, 'dev-second-0001', 'Zweitgerät', true) on conflict do nothing", [raw.userId]);
  const sid = rand();
  await env.kv.set(sessionKey(sid), JSON.stringify({ ...raw, deviceId: 'dev-second-0001' }), 600);
  return { cookies: { ff_sid: sid }, csrf: raw.csrf as string };
}

beforeAll(async () => {
  const item = (id: string) => ({ Id: id, Name: 'Film', Type: 'Movie', RunTimeTicks: TICKS, UserData: { PlaybackPositionTicks: 0 } });
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => ({ json: item(u.pathname.split('/').pop()!) }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: item(u.pathname.split('/').pop()!) }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({ json: { PlaySessionId: `ps-claim-${String(++psN).padStart(4, '0')}`, MediaSources: [{ Id: 'ms1', Container: 'mkv', SupportsDirectPlay: true, Bitrate: 2_000_000, Size: 2_000_000_000, RunTimeTicks: TICKS, MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', Height: 1080 }, { Index: 1, Type: 'Audio', Codec: 'aac' }] }] } }),
    'POST /Sessions/Playing.*': () => ({ status: 204 }),
  });
  me = await env.login();
  other = await secondDevice(me);
  userId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
});
afterAll(() => env.close());
beforeEach(async () => {
  vi.useRealTimers();
  for (const p of [`play:${userId}:`, `serve:${userId}:`, `servedrain:${userId}:`, `pstop:${userId}:`]) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 2 });
});

describe('stream limit at the gateway (/internal/stream)', () => {
  it('the audit scenario: playback info for many titles and no reports at all still serves only maxStreams streams', async () => {
    const ps: string[] = [];
    for (const id of ITEMS.slice(0, 3)) {
      const r = await info(me, id);
      expect(r.statusCode).toBe(200); // nothing is served yet: the info itself takes no slot (hover prefetch)
      ps.push(r.json().playSessionId);
    }
    expect((await claim(me, ITEMS[0]!, ps[0])).statusCode).toBe(200);
    expect((await claim(other, ITEMS[1]!, ps[1])).statusCode).toBe(200);
    const third = await claim(other, ITEMS[2]!, ps[2]);
    expect([third.statusCode, third.json()]).toEqual([429, { error: 'max_streams', max: 2 }]);
    // the served streams count for a new playback info too, and for the start report
    expect((await info(other, ITEMS[3]!)).json()).toEqual({ error: 'max_streams', max: 2 });
    expect((await report(other, 'start', ITEMS[2]!, ps[2]!)).json()).toEqual({ error: 'max_streams', max: 2 });
    // the running ones keep being served (segments, seeking)
    for (let i = 0; i < 3; i++) expect((await claim(me, ITEMS[0]!, ps[0])).statusCode).toBe(200);
  });

  it('seeking, a quality switch (new play session) and a resume of the same item on the same device are one stream', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    expect((await claim(me, ITEMS[0]!, 'ps-q-0001')).statusCode).toBe(200);
    expect((await info(me, ITEMS[0]!)).statusCode).toBe(200); // the player asks again for the same item (quality, audio, resume)
    expect((await claim(me, ITEMS[0]!, 'ps-q-0002')).statusCode).toBe(200);
    expect((await claim(me, ITEMS[0]!)).statusCode).toBe(200); // a request without a play session counts by its item
    expect((await report(me, 'start', ITEMS[0]!, 'ps-q-0002')).statusCode).toBe(200);
    // the same item on ANOTHER device is another stream
    expect((await claim(other, ITEMS[0]!, 'ps-q-0003')).json()).toEqual({ error: 'max_streams', max: 1 });
  });

  it('the next episode: served once the running one stopped; prepared during the countdown only while there is room', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    expect((await claim(me, ITEMS[0]!, 'ps-n-0001')).statusCode).toBe(200);
    expect((await info(me, ITEMS[1]!)).statusCode).toBe(429); // the countdown's prepared info is refused at the limit (no warm-up)
    expect((await claim(me, ITEMS[1]!, 'ps-n-0002')).statusCode).toBe(429); // and so is serving another title next to it
    expect((await report(me, 'stop', ITEMS[0]!, 'ps-n-0001')).statusCode).toBe(200);
    expect((await claim(me, ITEMS[1]!, 'ps-n-0002')).statusCode).toBe(200);
    // with room, the prepared next episode is warmed and later played as the same play session
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 2 });
    const next = await info(me, ITEMS[2]!);
    expect(next.statusCode).toBe(200);
    expect((await claim(me, ITEMS[2]!, next.json().playSessionId)).statusCode).toBe(200);
    expect((await report(me, 'stop', ITEMS[1]!, 'ps-n-0002')).statusCode).toBe(200);
    expect((await report(me, 'start', ITEMS[2]!, next.json().playSessionId)).statusCode).toBe(200);
  });

  it('a stopped stream may fetch its last segments; it counts only while they are fetched; an idle one is forgotten after a minute', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await claim(me, ITEMS[0]!, 'ps-s-0001')).statusCode).toBe(200);
    expect((await report(me, 'stop', ITEMS[0]!, 'ps-s-0001')).statusCode).toBe(200);
    expect((await claim(other, ITEMS[1]!, 'ps-s-0009')).statusCode).toBe(200); // stopped and not fetched: no slot
    await report(other, 'stop', ITEMS[1]!, 'ps-s-0009');
    await env.kv.del(`servedrain:${userId}:ps-s-0009`);
    expect((await claim(me, ITEMS[0]!, 'ps-s-0001')).statusCode).toBe(200); // a buffered segment after the stop
    expect((await claim(other, ITEMS[1]!, 'ps-s-0002')).statusCode).toBe(429); // it is served right now: it counts
    vi.setSystemTime(Date.now() + 21_000);
    expect((await claim(other, ITEMS[1]!, 'ps-s-0002')).statusCode).toBe(200); // no longer fetched: the slot is free
    vi.setSystemTime(Date.now() + 61_000);
    expect((await claim(me, ITEMS[2]!, 'ps-s-0003')).statusCode).toBe(200); // ps-s-0002 idled out (no request for a minute)
  });

  it('stop reports are no way to stream uncounted: only a running stream drains, once, for two minutes', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await claim(me, ITEMS[0]!, 'ps-d-0001')).statusCode).toBe(200);
    // a stop for a play session that never ran opens nothing
    expect((await report(other, 'stop', ITEMS[1]!, 'ps-d-0002')).statusCode).toBe(200);
    expect((await claim(other, ITEMS[1]!, 'ps-d-0002')).statusCode).toBe(429);
    // a running one drains once; a second stop during the window does not extend it
    expect((await report(me, 'stop', ITEMS[0]!, 'ps-d-0001')).statusCode).toBe(200);
    expect((await claim(other, ITEMS[1]!, 'ps-d-0003')).statusCode).toBe(200); // the slot is free again
    // the drained one cannot keep streaming next to the one that took the slot (review: re-armable drain)
    expect((await claim(me, ITEMS[0]!, 'ps-d-0001')).statusCode).toBe(429);
    vi.setSystemTime(Date.now() + 100_000);
    expect((await report(me, 'stop', ITEMS[0]!, 'ps-d-0001')).statusCode).toBe(200);
    expect((await claim(other, ITEMS[1]!, 'ps-d-0003')).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 21_000);
    expect((await claim(me, ITEMS[0]!, 'ps-d-0001')).statusCode).toBe(429); // the window is over: counted again, and the slot is taken
  });

  it('streams cannot alternate through stop, re-claim and start reports to run beyond the limit (review)', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = { s: me, item: ITEMS[0]!, ps: 'ps-x-0001' };
    const b = { s: other, item: ITEMS[1]!, ps: 'ps-x-0002' };
    expect((await claim(a.s, a.item, a.ps)).statusCode).toBe(200);
    let [cur, nxt] = [a, b];
    for (let round = 0; round < 6; round++) {
      // the attacker stops the stream that holds the slot, starts the other one, and tries to keep both going
      await report(cur.s, 'stop', cur.item, cur.ps);
      await report(nxt.s, 'start', nxt.item, nxt.ps);
      for (let i = 0; i < 3; i++) {
        expect([(await claim(a.s, a.item, a.ps)).statusCode, (await claim(b.s, b.item, b.ps)).statusCode].filter((c) => c === 200).length, `round ${round}`).toBeLessThanOrEqual(1);
        vi.setSystemTime(Date.now() + 10_000);
      }
      await report(cur.s, 'start', cur.item, cur.ps); // re-arm attempt: refused while the other one runs
      vi.setSystemTime(Date.now() + 15_000);
      [cur, nxt] = [nxt, cur];
    }
  });

  it('the next title on the same device starts while the stopped one drains (one draining stream of the device is spared)', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    expect((await claim(me, ITEMS[0]!, 'ps-y-0001')).statusCode).toBe(200);
    expect((await report(me, 'stop', ITEMS[0]!, 'ps-y-0001')).statusCode).toBe(200);
    expect((await claim(me, ITEMS[0]!, 'ps-y-0001')).statusCode).toBe(200); // its trailing segments
    expect((await info(other, ITEMS[2]!)).json().error).toBe('max_streams'); // another device: the draining stream still counts
    expect((await claim(other, ITEMS[2]!, 'ps-y-0003')).statusCode).toBe(429);
    expect((await info(me, ITEMS[1]!)).json().error).not.toBe('max_streams'); // the same device: the next episode
    expect((await claim(me, ITEMS[1]!, 'ps-y-0002')).statusCode).toBe(200);
    expect((await claim(me, ITEMS[0]!, 'ps-y-0001')).statusCode).toBe(429); // and from now on the old one is cut off
  });

  it('a stop also ends the requests of the same item and device that named no play session', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    expect((await claim(me, ITEMS[0]!, 'ps-i-0001')).statusCode).toBe(200);
    expect((await claim(me, ITEMS[0]!)).statusCode).toBe(200); // e.g. segments without PlaySessionId
    expect((await report(me, 'stop', ITEMS[0]!, 'ps-i-0001')).statusCode).toBe(200);
    expect(await env.kv.keys(`serve:${userId}:`)).toEqual([]);
    expect((await claim(me, ITEMS[0]!)).statusCode).toBe(200); // a trailing one drains
    expect((await info(me, ITEMS[1]!)).json().error).not.toBe('max_streams'); // the next title is not refused by the old one
  });

  it('progress reports cannot bring a stream back beyond the limit, but the position is still saved', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    expect((await claim(me, ITEMS[0]!, 'ps-p-0001')).statusCode).toBe(200);
    const before = env.jfCalls.filter((c) => c.path.startsWith('/Sessions/Playing')).length;
    expect((await report(other, 'progress', ITEMS[1]!, 'ps-p-0002')).statusCode).toBe(200); // a sleeping tab: its position goes to the server
    expect(env.jfCalls.filter((c) => c.path.startsWith('/Sessions/Playing')).length).toBe(before + 1);
    expect(await env.kv.get(`play:${userId}:ps-p-0002`)).toBeNull(); // but no live record that would let it be served
    expect((await claim(other, ITEMS[1]!, 'ps-p-0002')).statusCode).toBe(429);
  });

  it('parallel claims of two new streams cannot both pass the last slot', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    const r = await Promise.all([claim(me, ITEMS[0]!, 'ps-r-0001'), claim(other, ITEMS[1]!, 'ps-r-0002')]);
    expect(r.map((x) => x.statusCode).sort()).toEqual([200, 429]);
  });

  it('Live TV counts the served streams too', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    const user = { id: userId, role: 'admin' };
    expect(await streamLimitRefusal(env.ctx, user, 'dev-second-0001', 'local', 'live')).toBeNull();
    expect((await claim(me, ITEMS[0]!, 'ps-l-0001')).statusCode).toBe(200);
    expect(await streamLimitRefusal(env.ctx, user, 'dev-second-0001', 'local', 'live')).toEqual({ error: 'max_streams', max: 1 });
  });

  it('Plan B (nginx auth_request) counts the streams it lets through the same way, and denies a new one beyond the limit', async () => {
    await setUserLimits(env.ctx, userId, { ...NONE, maxStreams: 1 });
    const nginx = (s: Sess, uri: string) => env.app.inject({ url: '/internal/authz-nginx', headers: { ...H, 'x-original-uri': uri }, cookies: s.cookies });
    expect((await nginx(me, `/media/Videos/${ITEMS[0]}/master.m3u8?PlaySessionId=ps-b-0001&MediaSourceId=ms1`)).statusCode).toBe(204);
    expect((await nginx(me, `/media/Videos/${ITEMS[0]}/hls1/main/0.ts?PlaySessionId=ps-b-0001`)).statusCode).toBe(204);
    expect(await env.kv.get(`serve:${userId}:ps-b-0001`)).toBeTruthy();
    expect((await nginx(me, `/media/Items/${ITEMS[1]}/Images/Primary`)).statusCode).toBe(204); // images are no stream
    expect((await nginx(other, `/media/Videos/${ITEMS[1]}/master.m3u8?PlaySessionId=ps-b-0002`)).statusCode).toBe(403);
    expect((await nginx(other, `/media/Videos/${ITEMS[1]}/stream?static=true`)).statusCode).toBe(403);
  });

  it('needs the internal secret, a valid body and a usable session', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/internal/stream', payload: { sid: me.cookies.ff_sid, itemId: ITEMS[0] } })).statusCode).toBe(403);
    for (const payload of [{}, { sid: me.cookies.ff_sid, itemId: 'nope' }, { sid: me.cookies.ff_sid, itemId: ITEMS[0], ps: 'x'.repeat(200) }, { sid: me.cookies.ff_sid, itemId: ITEMS[0], extra: 1 }]) {
      expect((await env.app.inject({ method: 'POST', url: '/internal/stream', headers: H, payload })).statusCode).toBe(400);
    }
    expect((await env.app.inject({ method: 'POST', url: '/internal/stream', headers: H, payload: { sid: 'x'.repeat(43), itemId: ITEMS[0] } })).statusCode).toBe(401);
  });
});
