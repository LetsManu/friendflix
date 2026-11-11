// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CastUnpinnedError, AIRPLAY_PIN2_WINDOW_MS, CAST_IDLE_TTL, castKeyTtl, castLookup, castNextTtlSeconds, createCast, hashToken, NEXT_OVERLAP_MS } from '../src/cast.js';
import { revokeSessions } from '../src/devices.js';
import { countLive, DRAIN_MS, getLive, setLive } from '../src/live.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const MS = 'b'.repeat(32);
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
type Sess = { cookies: Record<string, string>; csrf: string };
/** Jumps the wall clock forward (only Date is faked) so memo windows elapse without real waiting. */
const skipClock = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };
afterEach(() => { vi.useRealTimers(); });
let env: TestEnv;
let admin: Sess;
let visible = true;
/** the play session id the fake server gives the next PlaybackInfo (default: one fixed id) */
let psNext: string | null = null;
/** the media streams the fake server's next PlaybackInfo lists (default: a 2160p source without codec facts) */
let srcStreams: unknown[] | null = null;
const runtime = 7200 * 10_000_000;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': () => (visible ? { json: { Id: ID, Name: 'Film', Type: 'Movie', ImageTags: { Primary: 'x' }, UserData: { PlaybackPositionTicks: 600_000_000 } } } : { status: 404 }),
    'POST /Sessions/Playing': () => ({ status: 204 }),
    'POST /Sessions/Playing/Progress': () => ({ status: 204 }),
    'POST /Sessions/Playing/Stopped': () => ({ status: 204 }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({
      json: {
        PlaySessionId: psNext ?? 'ps-12345678',
        MediaSources: [{ Id: MS, Container: 'mkv', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: runtime, MediaStreams: srcStreams ?? [{ Index: 0, Type: 'Video', Height: 2160 }, { Index: 1, Type: 'Audio' }, { Index: 2, Type: 'Subtitle', Codec: 'srt', Language: 'ger' }] }],
      },
    }),
  });
  admin = await env.login();
});
afterAll(() => env.close());

let n = 0;
// a fresh client address per request keeps the 10/min route limit out of the way (it has its own test)
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-forwarded-for': `10.1.${Math.floor(++n / 250)}.${n % 250}` }, payload: body as object });
// every cast authz carries the gateway's client key; default = one fixed address
const authz = (body: unknown, headers: Record<string, string> = H) => {
  const b = body as Record<string, unknown>;
  return env.app.inject({ method: 'POST', url: '/internal/authz', headers, payload: (b.ct !== undefined && !('client' in b) ? { ...b, client: '198.51.100.1' } : b) as object });
};
const create = async (s: Sess = admin, body: Record<string, unknown> = {}) => {
  const r = await call(s, 'POST', '/api/cast/session', { itemId: ID, ...body });
  return { r, j: r.json(), ct: (/\/media\/c\/([\w-]{43})\//.exec(r.json().contentUrl ?? '')?.[1]) as string };
};

describe('cast session', () => {
  it('reports config (https PUBLIC_URL + CAST_ENABLED)', async () => {
    expect((await call(admin, 'GET', '/api/cast/config')).json()).toEqual({ enabled: true });
  });

  it('creates an absolute, token-in-path HLS URL with the cast profile and cast-only query params', async () => {
    const { r, j, ct } = await create(admin, { startTicks: 1_200_000_000 });
    expect(r.statusCode).toBe(200);
    expect(ct).toHaveLength(43);
    expect(j.contentUrl).toMatch(new RegExp(`^https://portal\\.example\\.com/media/c/${ct}/Videos/${ID}/master\\.m3u8\\?`));
    expect(j.contentUrl).toContain('AudioCodec=aac&');
    expect(j.contentUrl).toContain('Level=41');
    expect(j.contentUrl).toContain('EnableTrickplay=false'); // no trickplay image playlist line for AirPlay / cast receivers
    expect(j.contentUrl).toContain('MaxStreamingBitrate=20000000');
    expect(j.contentUrl).not.toMatch(/api_key|ApiKey/i);
    expect(j).toMatchObject({ contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', startTime: 120, mediaSourceId: MS, playSessionId: 'ps-12345678', title: 'Film' });
    // the poster carries its OWN image-only token, never the media token
    const imgCt = /\/media\/c\/([\w-]{43})\/Items\//.exec(j.imageUrl)![1]!;
    expect(imgCt).not.toBe(ct);
    expect(j.imageUrl).toBe(`https://portal.example.com/media/c/${imgCt}/Items/${ID}/Images/Primary?maxWidth=600`);
    expect(j.subtitles[0].url).toBe(`https://portal.example.com/media/c/${ct}/Videos/${ID}/${MS}/Subtitles/2/0/Stream.vtt`);
    expect(r.headers['cache-control']).toBe('no-store');
    // Jellyfin got the cast transcoding profile: no direct play, aac only, h264 level <= 4.1
    const info = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).at(-1)!;
    expect(info.body.DeviceProfile.DirectPlayProfiles).toEqual([]);
    expect(info.body.DeviceProfile.TranscodingProfiles[0]).toMatchObject({ Container: 'ts', AudioCodec: 'aac', VideoCodec: 'h264', MaxAudioChannels: '2' });
    expect(JSON.stringify(info.body.DeviceProfile.CodecProfiles)).toContain('"Property":"VideoLevel","Value":"41"');
    expect(info.search).toContain('MaxHeight=1080');
    expect(JSON.stringify(info)).not.toContain(ct); // the token never reaches Jellyfin
  });

  it('never stores the raw token in Redis (only its hash) and never in the response body elsewhere', async () => {
    const { ct } = await create();
    const keys = await env.kv.keys('');
    expect(keys.some((k) => k.includes(ct))).toBe(false);
    for (const k of keys) expect(await env.kv.get(k)).not.toContain(ct);
    expect(keys).toContain(`cast:${hashToken(ct)}`);
    // pins live in Redis as well, keyed by hash
    await authz({ ct });
    expect((await env.kv.keys('castpin:')).some((k) => k.includes(ct))).toBe(false);
  });

  it('is refused for an item the profile cannot see', async () => {
    visible = false;
    env.ctx.jf.forgetItems(); // item() is memoised for 10 s; the fake library just changed underneath it
    const before = (await env.kv.keys('cast:')).length;
    const r = await call(admin, 'POST', '/api/cast/session', { itemId: ID });
    visible = true;
    expect(r.statusCode).toBe(404);
    expect((await env.kv.keys('cast:')).length).toBe(before);
  });

  it('enforces maxStreams like normal playback', async () => {
    const userId = (await call(admin, 'GET', '/api/me')).json().id as string;
    const role = env.ctx.roles.admin!;
    const before = role.maxStreams;
    role.maxStreams = 1;
    await setLive(env.ctx, { userId, userName: 'a', itemId: ID, title: 't', positionTicks: 0, isPaused: false, playSessionId: 'other-ps-1', updatedAt: Date.now(), source: 'portal' });
    const r = await call(admin, 'POST', '/api/cast/session', { itemId: ID });
    role.maxStreams = before;
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('max_streams');
  });

  it('rate limits session creation to 10 per minute per client', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await env.app.inject({ method: 'POST', url: '/api/cast/session', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf, 'x-forwarded-for': '203.0.113.9' }, payload: { itemId: ID } });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    await revokeSessions(env.ctx, (await call(admin, 'GET', '/api/me')).json().id);
    admin = await env.login();
  });

  it('requires CSRF and login', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/cast/session', payload: { itemId: ID } })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/api/cast/session', cookies: admin.cookies, payload: { itemId: ID } })).statusCode).toBe(403);
  });

  it('keeps at most 2 active tokens per account (oldest revoked)', async () => {
    await revokeSessions(env.ctx, (await call(admin, 'GET', '/api/me')).json().id); // clean slate (also kills the session)
    admin = await env.login();
    const a = await create();
    const b = await create();
    const c = await create();
    expect((await authz({ ct: a.ct })).statusCode).toBe(401);
    expect((await authz({ ct: b.ct })).statusCode).toBe(200);
    expect((await authz({ ct: c.ct })).statusCode).toBe(200);
  });

  it('DELETE revokes only own token and is idempotent-404', async () => {
    const a = await create();
    expect((await authz({ ct: a.ct })).statusCode).toBe(200);
    expect((await call(admin, 'DELETE', `/api/cast/session/${a.j.castId}`)).statusCode).toBe(200);
    expect((await authz({ ct: a.ct })).statusCode).toBe(401);
    expect((await call(admin, 'DELETE', `/api/cast/session/${a.j.castId}`)).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', '/api/cast/session/zz')).statusCode).toBe(400);
  });
});

describe('POST /internal/authz with ct', () => {
  it('needs the internal secret', async () => {
    const { ct } = await create();
    expect((await authz({ ct }, {})).statusCode).toBe(403);
  });

  it('returns the profile token and the scope', async () => {
    const { ct } = await create();
    const r = await authz({ ct });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ token: expect.stringMatching(/^tok-/), maxBitrate: 20_000_000, scope: { itemId: ID, mediaSourceId: MS, playSessionId: 'ps-12345678' } });
  });

  it('rejects malformed or unknown tokens and bodies mixing sid and ct', async () => {
    expect((await authz({ ct: 'short' })).statusCode).toBe(400);
    expect((await authz({ ct: 'A'.repeat(43) })).statusCode).toBe(401);
    expect((await authz({ ct: 'A'.repeat(43), sid: 'x'.repeat(30) })).statusCode).toBe(400);
    expect((await authz({})).statusCode).toBe(400);
  });

  it('401 once the token is expired', async () => {
    const { ct } = await create();
    const k = `cast:${hashToken(ct)}`;
    const rec = JSON.parse((await env.kv.get(k))!);
    await env.kv.set(k, JSON.stringify({ ...rec, exp: Date.now() - 1 }), 60);
    expect((await authz({ ct })).statusCode).toBe(401);
  });

  it('401 when the user is disabled afterwards', async () => {
    const { ct } = await create();
    const me = (await call(admin, 'GET', '/api/me')).json().id;
    await env.pool.query('update users set disabled=true where id=$1', [me]);
    try {
      expect((await authz({ ct })).statusCode).toBe(401);
    } finally {
      await env.pool.query('update users set disabled=false where id=$1', [me]);
    }
  });

  it('401 when the sender device is no longer approved', async () => {
    const { ct } = await create();
    await env.pool.query('update devices set approved=false');
    try {
      expect((await authz({ ct })).statusCode).toBe(401);
    } finally {
      await env.pool.query('update devices set approved=true');
    }
  });

  it('401 when the profile was deleted', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id;
    const p = await call(admin, 'POST', '/api/profiles', { name: 'Kind' });
    const pid = p.json().profile?.id ?? p.json().id;
    expect(pid).toBeTruthy();
    const sel = await call(admin, 'POST', `/api/profiles/${pid}/select`, {});
    expect(sel.statusCode).toBe(200);
    const { ct, r } = await create(admin);
    expect(r.statusCode).toBe(200);
    await env.pool.query('delete from profiles where id=$1 and user_id=$2', [pid, me]);
    expect((await authz({ ct })).statusCode).toBe(401);
    await call(admin, 'POST', `/api/profiles/${me}/select`, {});
  });

  it('revokeSessions revokes cast tokens (device-scoped and account-wide)', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id;
    const { ct } = await create();
    expect((await authz({ ct })).statusCode).toBe(200);
    await revokeSessions(env.ctx, me, 'some-other-device');
    expect((await authz({ ct })).statusCode).toBe(200);
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await revokeSessions(env.ctx, me, dev);
    expect((await authz({ ct })).statusCode).toBe(401);
    expect(await env.kv.keys(`castidx:${me}:`)).toEqual([]);
    admin = await env.login();
  });
});

describe('cast token hardening', () => {
  it('pins the token to the first client: first ok, second 401, first still ok', async () => {
    const { ct } = await create();
    expect((await authz({ ct, client: '203.0.113.1' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.2' })).statusCode).toBe(401);
    expect((await authz({ ct, client: '203.0.113.1' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.2' })).statusCode).toBe(401);
  });

  it('does not pin on a failed authz (revoked device) and needs a client in the body', async () => {
    const { ct } = await create();
    await env.pool.query('update devices set approved=false');
    try {
      expect((await authz({ ct, client: '203.0.113.5' })).statusCode).toBe(401);
    } finally {
      await env.pool.query('update devices set approved=true');
    }
    skipClock(2100); // negative memo (2 s)
    expect((await authz({ ct, client: '203.0.113.6' })).statusCode).toBe(200); // first SUCCESSFUL client pins
    expect((await authz({ ct, client: '203.0.113.5' })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { ct } })).statusCode).toBe(400);
  });

  it('AirPlay token (via airplay): sender + TV may both use it (two-address pin), a third address is refused; record says airplay', async () => {
    const { r, ct } = await create(admin, { via: 'airplay' });
    expect(r.statusCode).toBe(200);
    const rec = JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!);
    expect(rec.via).toBe('airplay');
    expect((await authz({ ct, client: '203.0.113.21' })).statusCode).toBe(200); // Safari on the phone loads the playlist
    expect((await authz({ ct, client: '203.0.113.22' })).statusCode).toBe(200); // the TV streams
    expect((await authz({ ct, client: '203.0.113.23' })).statusCode).toBe(401);
    expect((await authz({ ct, client: '203.0.113.21' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.22' })).statusCode).toBe(200);
    // revoking drops both pins
    expect((await call(admin, 'DELETE', `/api/cast/session/${r.json().castId}`)).statusCode).toBe(200);
    expect((await env.kv.keys('castpin2:')).some((k) => k.endsWith(hashToken(ct)))).toBe(false);
    skipClock(5100);
    expect((await authz({ ct, client: '203.0.113.22' })).statusCode).toBe(401);
  });

  it('AirPlay second pin only within 120 s of creation (phone first, TV after the picker); afterwards the token is locked to the addresses it has', async () => {
    expect(AIRPLAY_PIN2_WINDOW_MS).toBe(120_000);
    const late = await create(admin, { via: 'airplay' });
    expect((await authz({ ct: late.ct, client: '203.0.113.41' })).statusCode).toBe(200);
    const early = await create(admin, { via: 'airplay' });
    expect((await authz({ ct: early.ct, client: '203.0.113.51' })).statusCode).toBe(200);
    expect((await authz({ ct: early.ct, client: '203.0.113.52' })).statusCode).toBe(200);
    skipClock(121_000);
    // too late for a second address
    expect((await authz({ ct: late.ct, client: '203.0.113.42' })).statusCode).toBe(401);
    expect((await authz({ ct: late.ct, client: '203.0.113.41' })).statusCode).toBe(200);
    // both early pins keep working, nobody else gets in
    expect((await authz({ ct: early.ct, client: '203.0.113.51' })).statusCode).toBe(200);
    expect((await authz({ ct: early.ct, client: '203.0.113.52' })).statusCode).toBe(200);
    expect((await authz({ ct: early.ct, client: '203.0.113.53' })).statusCode).toBe(401);
  });

  it('AirPlay token first: the phone pins it at once, the TV may still take the second address 90 s later (slow picker)', async () => {
    const t = await create(admin, { via: 'airplay' });
    expect((await authz({ ct: t.ct, client: '203.0.113.61' })).statusCode).toBe(200); // the phone plays the token stream
    skipClock(90_000);
    expect((await authz({ ct: t.ct, client: '203.0.113.62' })).statusCode).toBe(200); // the TV, picked 90 s later
    expect((await authz({ ct: t.ct, client: '203.0.113.63' })).statusCode).toBe(401);
  });

  it('Chromecast stays single-pin (default via) and an unknown via is refused', async () => {
    const { ct } = await create();
    expect(JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!).via).toBe('chromecast');
    expect((await authz({ ct, client: '203.0.113.31' })).statusCode).toBe(200);
    expect((await authz({ ct, client: '203.0.113.32' })).statusCode).toBe(401);
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID, via: 'miracast' })).statusCode).toBe(400);
  });

  it('simultaneous first uses: exactly one client wins the pin', async () => {
    const { ct } = await create();
    const rs = await Promise.all(['203.0.113.10', '203.0.113.11', '203.0.113.12'].map((client) => authz({ ct, client })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('sliding TTL: idle window capped by the absolute expiry; seen is refreshed (throttled)', async () => {
    const now = Date.now();
    expect(castKeyTtl(now + 6 * 3600_000, now)).toBe(CAST_IDLE_TTL);
    expect(castKeyTtl(now + 600_000, now)).toBe(600);
    expect(castKeyTtl(now - 1, now)).toBe(0);
    const { ct } = await create();
    const k = `cast:${hashToken(ct)}`;
    const rec0 = JSON.parse((await env.kv.get(k))!);
    expect(rec0.seen).toBeGreaterThan(0);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(JSON.parse((await env.kv.get(k))!).seen).toBe(rec0.seen); // within the throttle window: no write
    await env.kv.set(k, JSON.stringify({ ...rec0, seen: Date.now() - 120_000 }), 60);
    skipClock(5100); // 5 s memo
    expect((await authz({ ct })).statusCode).toBe(200);
    const rec1 = JSON.parse((await env.kv.get(k))!);
    expect(rec1.seen).toBeGreaterThan(Date.now() - 5000);
    expect(rec1.exp).toBe(rec0.exp); // the absolute cap never moves
  });

  it('image token: image-only kind, same item, no live record, revoked with the media token; media authz reports maxHeight', async () => {
    const { ct, j } = await create();
    const imgCt = /\/media\/c\/([\w-]{43})\//.exec(j.imageUrl)![1]!;
    const m = (await authz({ ct })).json();
    expect(m).toMatchObject({ kind: 'media', maxHeight: 1080 });
    const i = (await authz({ ct: imgCt })).json();
    expect(i).toMatchObject({ kind: 'img', scope: { itemId: ID } });
    expect((await call(admin, 'DELETE', `/api/cast/session/${j.castId}`)).statusCode).toBe(200);
    expect((await authz({ ct: imgCt })).statusCode).toBe(401);
    expect((await authz({ ct })).statusCode).toBe(401);
  });

  it('an image token alone does not count as a live stream', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id as string;
    await revokeSessions(env.ctx, me);
    admin = await env.login();
    const { j } = await create();
    const imgCt = /\/media\/c\/([\w-]{43})\//.exec(j.imageUrl)![1]!;
    await env.kv.del(`play:${me}:ps-12345678`);
    expect((await authz({ ct: imgCt })).statusCode).toBe(200);
    expect(await getLive(env.ctx, me, 'ps-12345678')).toBeNull();
  });

  it('a cast with no sender reports still counts as live (maxStreams), and keeps an existing live record', async () => {
    const me = (await call(admin, 'GET', '/api/me')).json().id as string;
    const { ct } = await create();
    for (const k of await env.kv.keys(`play:${me}:`)) await env.kv.del(k);
    expect(await countLive(env.ctx, me)).toBe(0);
    await env.kv.set(`cast:${hashToken(ct)}`, JSON.stringify({ ...JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!), seen: 0 }), 600);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, me)).toBe(1);
    expect(await getLive(env.ctx, me, 'ps-12345678')).toMatchObject({ itemId: ID, title: 'Film', playSessionId: 'ps-12345678', source: 'portal' });
    // a sender report is kept, only refreshed
    await setLive(env.ctx, { userId: me, userName: 'a', itemId: ID, title: 'Film', positionTicks: 5, isPaused: true, playSessionId: 'ps-12345678', updatedAt: 1, source: 'portal' });
    await env.kv.set(`cast:${hashToken(ct)}`, JSON.stringify({ ...JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!), seen: 0 }), 600);
    skipClock(5100);
    expect((await authz({ ct })).statusCode).toBe(200);
    const l = (await getLive(env.ctx, me, 'ps-12345678'))!;
    expect(l.positionTicks).toBe(5);
    expect(l.updatedAt).toBeGreaterThan(1);
  });
});

describe('cast session: stop report and the queued next episode', () => {
  const me = async () => (await call(admin, 'GET', '/api/me')).json().id as string;
  const stale = async (ct: string) => env.kv.set(`cast:${hashToken(ct)}`, JSON.stringify({ ...JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!), seen: 0 }), 600);

  it('a segment fetch after the stop report does not bring the stopped stream back (no ghost stream for maxStreams)', async () => {
    const uid = await me();
    for (const k of await env.kv.keys(`play:${uid}:`)) await env.kv.del(k);
    const { ct, j } = await create();
    const body = { itemId: ID, playSessionId: j.playSessionId, mediaSourceId: MS, positionTicks: 0, isPaused: false, playMethod: 'Transcode' };
    expect((await call(admin, 'POST', '/api/playback/start', body)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect((await call(admin, 'POST', '/api/playback/stop', body)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(0);
    // the receiver still fetches the old token's segments until the new one is loaded (its sliding refresh is due)
    await stale(ct);
    skipClock(5100);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(0);
    // a new start of that play session counts again
    expect((await call(admin, 'POST', '/api/playback/start', body)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    await call(admin, 'POST', '/api/playback/stop', body);
  });

  it('revoking a token whose stream never reported `start` (a dropped queued episode the receiver preloaded) frees its stream slot', async () => {
    const uid = await me();
    for (const k of await env.kv.keys(`play:${uid}:`)) await env.kv.del(k);
    for (const k of await env.kv.keys(`pstop:${uid}:`)) await env.kv.del(k); // the fake server reuses one play session id
    const { ct, j } = await create();
    await stale(ct);
    skipClock(5100);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1); // counted from its segment fetches
    expect((await call(admin, 'DELETE', `/api/cast/session/${j.castId}`)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(0);
    // a reported stream stays until its own stop
    const b = await create();
    const body = { itemId: ID, playSessionId: b.j.playSessionId, mediaSourceId: MS, positionTicks: 0, isPaused: false, playMethod: 'Transcode' };
    await call(admin, 'POST', '/api/playback/start', body);
    expect((await call(admin, 'DELETE', `/api/cast/session/${b.j.castId}`)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    await call(admin, 'POST', '/api/playback/stop', body);
  });

  /** clean slate for this device: no tokens, no live streams, no stop marks; maxStreams 1 */
  const fresh = async () => {
    const uid = await me();
    await revokeSessions(env.ctx, uid);
    admin = await env.login();
    for (const k of [...await env.kv.keys(`play:${uid}:`), ...await env.kv.keys(`pstop:${uid}:`)]) await env.kv.del(k);
    env.ctx.roles.admin!.maxStreams = 1;
    return uid;
  };
  const report = (kind: 'start' | 'stop', ps: string) => call(admin, 'POST', `/api/playback/${kind}`, { itemId: ID, playSessionId: ps, mediaSourceId: MS, positionTicks: 0, isPaused: false, playMethod: 'Transcode' });
  /** the playing cast (reported `start`), then its queued next episode's token */
  const playingThenNext = async () => {
    psNext = null;
    const cur = await create();
    await report('start', cur.j.playSessionId);
    await authz({ ct: cur.ct }); // the receiver fetched it: pinned (a queued token takes over that pin at mint)
    psNext = 'ps-next-0001';
    const nx = await create(admin, { next: true, after: cur.j.castId });
    psNext = null;
    return { cur, nx };
  };
  const role0 = { max: 0 };
  beforeAll(() => { role0.max = env.ctx.roles.admin!.maxStreams; });
  afterEach(() => { env.ctx.roles.admin!.maxStreams = role0.max; psNext = null; });

  it('next: no predecessor (no cast token of this device) is 429, whatever the stream count', async () => {
    await fresh();
    env.ctx.roles.admin!.maxStreams = 5;
    const r = await call(admin, 'POST', '/api/cast/session', { itemId: ID, next: true });
    expect(r.statusCode).toBe(429);
  });

  it('next: issued while the playing cast fills the limit; a wrong predecessor is refused; never beyond the limit', async () => {
    const uid = await fresh();
    const { cur, nx } = await playingThenNext();
    expect(nx.r.statusCode).toBe(200);
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID })).statusCode).toBe(429);
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID, next: true, after: 'f'.repeat(32) })).statusCode).toBe(409);
    expect(cur.r.statusCode).toBe(200);
    await setLive(env.ctx, { userId: uid, userName: 'a', itemId: ID, title: 't', positionTicks: 0, isPaused: false, playSessionId: 'other-ps-2', updatedAt: Date.now(), source: 'portal' });
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID, next: true, after: cur.j.castId })).statusCode).toBe(429);
  });

  it('next: repeated requests keep one queued token (the older one is revoked), the playing one stays', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    psNext = 'ps-next-0002';
    const nx2 = await create(admin, { next: true, after: cur.j.castId });
    expect(nx2.r.statusCode).toBe(200);
    expect((await authz({ ct: nx.ct })).statusCode).toBe(401);
    expect((await authz({ ct: cur.ct })).statusCode).toBe(200);
    expect((await authz({ ct: nx2.ct })).statusCode).toBe(200);
    const media = (await env.kv.keys('cast:')).length;
    psNext = 'ps-next-0003';
    await create(admin, { next: true, after: cur.j.castId });
    expect((await env.kv.keys('cast:')).length).toBe(media); // one in, one out
  });

  it('next: the receiver\'s preload overlap is served and counted once (the playing stream); after its stop the next one counts', async () => {
    const uid = await fresh();
    const { cur, nx } = await playingThenNext();
    expect((await authz({ ct: nx.ct })).statusCode).toBe(200);
    await stale(nx.ct);
    skipClock(5100);
    expect((await authz({ ct: nx.ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(await getLive(env.ctx, uid, 'ps-next-0001')).toBeNull();
    await report('stop', cur.j.playSessionId);
    skipClock(400_000); // long past the overlap window: the predecessor is over, the token behaves normally
    expect((await authz({ ct: nx.ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(await getLive(env.ctx, uid, 'ps-next-0001')).not.toBeNull();
  });

  it('next: once it plays (its predecessor stopped) it is the predecessor of the following one and is not replaced', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    await report('stop', cur.j.playSessionId);
    await report('start', 'ps-next-0001');
    psNext = 'ps-next-0009';
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID, next: true, after: cur.j.castId })).statusCode).toBe(409);
    const nx2 = await create(admin, { next: true, after: nx.j.castId });
    expect(nx2.r.statusCode).toBe(200);
    expect((await authz({ ct: nx.ct })).statusCode).toBe(200);
    await report('stop', 'ps-next-0001');
  });

  it('next: re-minting does not renew the overlap: the window belongs to the play session it follows', async () => {
    const uid = await fresh();
    const { cur, nx } = await playingThenNext();
    const progress = () => call(admin, 'POST', '/api/playback/progress', { itemId: ID, playSessionId: cur.j.playSessionId, mediaSourceId: MS, positionTicks: 0, isPaused: false, playMethod: 'Transcode' });
    const elsewhere = '198.51.100.1'; // the receiver: the address the predecessor is pinned to (a queued token is pinned to it at mint)
    expect((await authz({ ct: nx.ct, client: elsewhere })).statusCode).toBe(200);
    skipClock(170_000);
    await progress();
    psNext = 'ps-next-0004';
    const nx2 = await create(admin, { next: true, after: cur.j.castId });
    expect(nx2.r.statusCode).toBe(200);
    expect((await authz({ ct: nx2.ct, client: elsewhere })).statusCode).toBe(200);
    skipClock(11_000); // 181 s after the first overlap fetch
    await progress();
    expect((await authz({ ct: nx2.ct, client: elsewhere })).statusCode).toBe(401);
    expect(await countLive(env.ctx, uid)).toBe(1);
  });

  it('a stop report only excuses a short drain: fetches of the stopped token count again after DRAIN_MS', async () => {
    const uid = await fresh();
    psNext = null;
    for (const k of await env.kv.keys(`pstop:${uid}:`)) await env.kv.del(k);
    const { ct, j } = await create();
    await report('start', j.playSessionId);
    await report('stop', j.playSessionId);
    skipClock(60_000);
    await stale(ct);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(0);
    skipClock(70_000); // 130 s after the stop
    await stale(ct);
    expect((await authz({ ct })).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(DRAIN_MS).toBe(120_000);
  });

  it('next: used concurrently while the predecessor plays: refused once the 180 s overlap is over, never counted twice', async () => {
    const uid = await fresh();
    const { cur, nx } = await playingThenNext();
    const elsewhere = { ct: nx.ct, client: '198.51.100.1' }; // the predecessor's pin
    const progress = () => call(admin, 'POST', '/api/playback/progress', { itemId: ID, playSessionId: cur.j.playSessionId, mediaSourceId: MS, positionTicks: 0, isPaused: false, playMethod: 'Transcode' });
    expect((await authz(elsewhere)).statusCode).toBe(200);
    skipClock(NEXT_OVERLAP_MS - 10_000);
    await progress(); // the playing cast keeps reporting
    expect((await authz(elsewhere)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    skipClock(20_000);
    await progress();
    expect((await authz(elsewhere)).statusCode).toBe(401);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(await getLive(env.ctx, uid, 'ps-next-0001')).toBeNull();
  });
});

describe('logout / revokeSessions device cleanup', () => {
  const meId = async () => (await call(admin, 'GET', '/api/me')).json().id as string;
  const subFor = async (uid: string, dev: string, id: string) => {
    const prof = (await env.pool.query('select id from profiles where user_id=$1 and is_owner', [uid])).rows[0].id;
    await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1,$2,'x',true) on conflict do nothing", [uid, dev]);
    await env.pool.query("insert into push_subscriptions(user_id, device_id, profile_id, endpoint, p256dh, auth) values ($1,$2,$3,$4,'p','a')", [uid, dev, prof, `https://fcm.googleapis.com/fcm/send/${id}`]);
  };
  const subs = async (uid: string) => Number((await env.pool.query('select count(*) from push_subscriptions where user_id=$1', [uid])).rows[0].count);

  it('logout deletes this device\'s push subscriptions and cast tokens when no other session uses the device', async () => {
    const me = await meId();
    await revokeSessions(env.ctx, me);
    await env.pool.query('delete from push_subscriptions');
    const s = await env.login();
    admin = s;
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await subFor(me, dev, 'a1');
    await subFor(me, 'other-device', 'a2');
    const { ct } = await create();
    expect((await authz({ ct })).statusCode).toBe(200);
    expect((await call(s, 'POST', '/auth/logout')).statusCode).toBe(200);
    expect(await subs(me)).toBe(1); // only the other device's subscription is left
    expect((await authz({ ct })).statusCode).toBe(401);
    admin = await env.login();
  });

  it('logout keeps them while another live session still uses the same device', async () => {
    const me = await meId();
    await env.pool.query('delete from push_subscriptions');
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await subFor(me, dev, 'b1');
    const second = await env.login(); // same browser (device cookie), second session
    const { ct } = await create();
    expect((await call(second, 'POST', '/auth/logout')).statusCode).toBe(200);
    expect(await subs(me)).toBe(1);
    expect((await authz({ ct })).statusCode).toBe(200);
  });

  it('revokeSessions(exceptSid) spares the current session\'s device (push + cast) but clears other devices', async () => {
    const me = await meId();
    await env.pool.query('delete from push_subscriptions');
    const dev = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [me])).rows[0]!.device_id;
    await subFor(me, dev, 'c1');
    await subFor(me, 'other-device', 'c2');
    const { ct } = await create();
    expect((await authz({ ct })).statusCode).toBe(200);
    // a cast token that belongs to another device
    await env.kv.set(`castidx:${me}:${'f'.repeat(32)}`, JSON.stringify({ hash: 'f'.repeat(64), createdAt: 1, deviceId: 'other-device' }), 600);
    await env.kv.set(`cast:${'f'.repeat(64)}`, '{}', 600);
    await revokeSessions(env.ctx, me, undefined, admin.cookies.ff_sid);
    expect(await subs(me)).toBe(1);
    expect((await env.pool.query('select device_id from push_subscriptions where user_id=$1', [me])).rows[0].device_id).toBe(dev);
    expect(await env.kv.get(`cast:${'f'.repeat(64)}`)).toBeNull();
    expect((await authz({ ct })).statusCode).toBe(200);
    // without exceptSid everything goes
    await revokeSessions(env.ctx, me);
    expect(await subs(me)).toBe(0);
    expect((await authz({ ct })).statusCode).toBe(401);
    admin = await env.login();
  });
});

describe('cast disabled', () => {
  it('is off when CAST_ENABLED=false or PUBLIC_URL is not https', async () => {
    const was = env.ctx.cfg.CAST_ENABLED;
    const { ct } = await create();
    env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: 'false' };
    try {
      expect((await call(admin, 'GET', '/api/cast/config')).json()).toEqual({ enabled: false });
      expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID })).statusCode).toBe(404);
      expect((await authz({ ct })).statusCode).toBe(401);
    } finally {
      env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: was };
    }
  });
});

/** capabilities.subtitleExtract: PlaybackDto subtitles point at /api/items/…/stream.vtt, which the receiver reaches via a signed cast URL. */
describe('cast: FriendFlix-served subtitles (subtitleExtract)', () => {
  type Jf = typeof env.ctx.jf;
  const subCalls: Array<{ user: string; args: unknown[] }> = [];
  let restore: () => void = () => {};
  beforeAll(() => {
    const jf = env.ctx.jf as { -readonly [K in keyof Jf]: Jf[K] };
    const prev = { caps: jf.capabilities, prepare: jf.preparePlayback, sub: jf.subtitleStream };
    jf.capabilities = { ...prev.caps, subtitleExtract: true };
    jf.preparePlayback = async (_u, info) => ({ ...info, subtitles: info.subtitles.map((s) => ({ ...s, url: `/api/items/${ID}/subtitle/${info.mediaSourceId}/${s.index}/stream.vtt` })) });
    jf.subtitleStream = async (u, ...args) => {
      subCalls.push({ user: u.jellyfin_username, args });
      return new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nHallo\n');
    };
    restore = () => Object.assign(jf, { capabilities: prev.caps, preparePlayback: prev.prepare, subtitleStream: prev.sub });
  });
  afterAll(() => restore());
  const fetchSub = (url: string) => env.app.inject({ method: 'GET', url: url.replace('https://portal.example.com', '') });

  it('the cast session carries a signed /api/cast/subtitle URL without the media token, served without a cookie', async () => {
    const { r, j, ct } = await create();
    expect(r.statusCode).toBe(200);
    const url: string = j.subtitles[0].url;
    expect(url).toMatch(new RegExp(`^https://portal\\.example\\.com/api/cast/subtitle/[0-9a-f-]{36}/${j.castId}/\\d+/[\\w-]{43}/${ID}/${MS}/2/stream\\.vtt$`));
    expect(url).not.toContain(ct);
    subCalls.length = 0;
    const s = await fetchSub(url);
    expect(s.statusCode).toBe(200);
    expect(s.body).toContain('WEBVTT');
    expect(s.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(s.headers['access-control-allow-origin']).toBe('*'); // the receiver runs on another origin
    expect(s.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(s.headers['cache-control']).toBe('no-store');
    expect(subCalls).toEqual([{ user: expect.any(String), args: [ID, MS, 2, 'vtt'] }]);
    // other API responses keep the same-origin resource policy
    expect((await call(admin, 'GET', '/api/cast/config')).headers['cross-origin-resource-policy']).toBe('same-origin');
  });
  it('only the signed track of the token\'s item: tampered signature / track / media source / payload -> 404', async () => {
    const { j } = await create();
    const url: string = j.subtitles[0].url;
    const [, uid, cid, exp, sig] = /\/api\/cast\/subtitle\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\//.exec(url)! as unknown as string[];
    const other = await create(); // a second live token of the same account
    for (const bad of [
      url.replace(`/${sig}/`, `/${sig!.slice(0, -1)}${sig!.endsWith('A') ? 'B' : 'A'}/`),
      url.replace('/2/stream.vtt', '/3/stream.vtt'),
      url.replace(`/${MS}/`, `/${'c'.repeat(32)}/`),
      url.replace(`/${exp}/`, `/${Number(exp) + 3600}/`), // longer life
      url.replace(`/${cid}/`, `/${other.j.castId}/`), // another token
      url.replace(`/${uid}/`, `/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/`),
      url.replace(`/${sig}/`, `/${sig}x/`),
    ]) expect((await fetchSub(bad)).statusCode, bad).toBe(404);
  });
  it('dies with its cast token (revoke) and when the item is no longer visible', async () => {
    const a = await create();
    const url: string = a.j.subtitles[0].url;
    expect((await fetchSub(url)).statusCode).toBe(200);
    visible = false;
    env.ctx.jf.forgetItems(); // item() is memoised
    try {
      expect((await fetchSub(url)).statusCode).toBe(404);
    } finally {
      visible = true;
    }
    expect((await call(admin, 'DELETE', `/api/cast/session/${a.j.castId}`)).statusCode).toBe(200);
    expect((await fetchSub(url)).statusCode).toBe(404);
  });
  it('expires with the token\'s absolute cap and is off with cast disabled or without subtitleExtract', async () => {
    const { j } = await create();
    const url: string = j.subtitles[0].url;
    const was = env.ctx.cfg.CAST_ENABLED;
    env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: 'false' };
    try {
      expect((await fetchSub(url)).statusCode).toBe(404);
    } finally {
      env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: was };
    }
    const jf = env.ctx.jf as { capabilities: Jf['capabilities'] };
    const caps = jf.capabilities;
    jf.capabilities = { ...caps, subtitleExtract: false };
    try {
      expect((await fetchSub(url)).statusCode).toBe(404);
    } finally {
      jf.capabilities = caps;
    }
    skipClock(7 * 3600 * 1000);
    expect((await fetchSub(url)).statusCode).toBe(404);
  });
});

/** FriendFlix's own receiver (CAST_RECEIVER_APP_ID): config, the receiver report token and POST /api/cast/report. */
describe('cast: own receiver and its report token', () => {
  const APP = 'A1B2C3D4';
  const TV = '198.51.100.1'; // authz() pins with this address: the receiver that streams the token
  let was = '';
  beforeAll(() => { was = env.ctx.cfg.CAST_RECEIVER_APP_ID; env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: APP }; });
  afterAll(() => { env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: was }; });
  afterEach(() => { psNext = null; });
  const me = async () => (await call(admin, 'GET', '/api/me')).json().id as string;
  /** a cast token for the receiver, already streamed (pinned) by the TV */
  const cast = async (body: Record<string, unknown> = {}) => {
    const c = await create(admin, { receiver: true, ...body });
    expect(c.r.statusCode).toBe(200);
    expect((await authz({ ct: c.ct, client: TV })).statusCode).toBe(200);
    return c;
  };
  const rep = (rt: string, event: string, extra: Record<string, unknown> = {}, ip = TV) =>
    env.app.inject({ method: 'POST', url: '/api/cast/report', headers: { 'x-real-ip': ip }, payload: { rt, event, positionTicks: 1_000_000_000, isPaused: false, ...extra } });
  const clean = async (uid: string) => { for (const k of [...await env.kv.keys(`play:${uid}:`), ...await env.kv.keys(`pstop:${uid}:`)]) await env.kv.del(k); };

  it('config names the app ID only when it is set and casting is on; the token only goes to a receiver sender', async () => {
    expect((await call(admin, 'GET', '/api/cast/config')).json()).toEqual({ enabled: true, receiverAppId: APP });
    expect((await create()).j.report).toBeUndefined(); // the Default Media Receiver flow is unchanged
    expect((await create(admin, { receiver: true, via: 'airplay' })).j.report).toBeUndefined();
    const { j, ct } = await create(admin, { receiver: true });
    expect(j.report).toMatch(/^[\w-]+\.[\w-]{43}$/);
    expect(j.report).not.toContain(ct);
    const claims = JSON.parse(Buffer.from(j.report.split('.')[0], 'base64url').toString());
    expect(claims).toMatchObject({ v: 1, c: j.castId, i: ID, ps: j.playSessionId, ms: MS, exp: j.expiresAt });
    expect(JSON.stringify(claims)).not.toContain(ct);
    env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: '' };
    try {
      expect((await call(admin, 'GET', '/api/cast/config')).json()).toEqual({ enabled: true });
      expect((await create(admin, { receiver: true })).j.report).toBeUndefined();
      expect((await rep(j.report, 'progress')).statusCode).toBe(404);
    } finally { env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: APP }; }
    env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: 'false' };
    try { expect((await call(admin, 'GET', '/api/cast/config')).json()).toEqual({ enabled: false }); } finally { env.ctx.cfg = { ...env.ctx.cfg, CAST_ENABLED: 'true' }; }
  });

  it('reports start / progress / stop for its play session without a cookie (same rules as /api/playback/*)', async () => {
    const uid = await me();
    await clean(uid);
    const { j } = await cast();
    const before = env.jfCalls.length;
    expect((await rep(j.report, 'start')).statusCode).toBe(200);
    expect(await getLive(env.ctx, uid, j.playSessionId)).toMatchObject({ itemId: ID, positionTicks: 1_000_000_000, deviceId: expect.any(String) });
    expect((await rep(j.report, 'progress', { positionTicks: 2_000_000_000, isPaused: true })).statusCode).toBe(200);
    expect(await getLive(env.ctx, uid, j.playSessionId)).toMatchObject({ positionTicks: 2_000_000_000, isPaused: true });
    expect((await rep(j.report, 'stop')).statusCode).toBe(200);
    expect(await getLive(env.ctx, uid, j.playSessionId)).toBeNull();
    const sent = env.jfCalls.slice(before).filter((c) => c.path.startsWith('/Sessions/Playing')).map((c) => c.path);
    expect(sent).toEqual(['/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped']);
    await clean(uid);
  });

  it('is bound: tampered claims or signature, another address, a revoked or expired cast token are refused', async () => {
    const { j } = await cast();
    const [body, sig] = j.report.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = (c: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ ...claims, ...c })).toString('base64url')}.${sig}`;
    expect((await rep(forged({ i: 'f'.repeat(32) }), 'progress')).statusCode).toBe(401); // another item
    expect((await rep(forged({ exp: claims.exp + 1 }), 'progress')).statusCode).toBe(401);
    expect((await rep(`${body}.${'A'.repeat(43)}`, 'progress')).statusCode).toBe(401);
    expect((await rep(j.report, 'progress', {}, '203.0.113.9')).statusCode).toBe(401); // not the receiver that streams it
    expect((await rep('x', 'progress')).statusCode).toBe(400);
    expect((await rep(j.report, 'progress')).statusCode).toBe(200);
    skipClock(j.expiresAt - Date.now() + 1000);
    expect((await rep(j.report, 'progress')).statusCode).toBe(401); // past its cap
    vi.useRealTimers();
    expect((await call(admin, 'DELETE', `/api/cast/session/${j.castId}`)).statusCode).toBe(200);
    expect((await rep(j.report, 'progress')).statusCode).toBe(401); // dies with its cast token
  });

  it('a token never streamed (no pin) and a disabled account or unapproved device report nothing', async () => {
    const c = await create(admin, { receiver: true });
    expect((await rep(c.j.report, 'progress')).statusCode).toBe(401);
    const { j } = await cast();
    const uid = await me();
    await env.ctx.db.query('update users set disabled=true where id=$1', [uid]);
    try { expect((await rep(j.report, 'progress')).statusCode).toBe(401); } finally { await env.ctx.db.query('update users set disabled=false where id=$1', [uid]); }
    await env.ctx.db.query('update devices set approved=false where user_id=$1', [uid]);
    try { expect((await rep(j.report, 'progress')).statusCode).toBe(401); } finally { await env.ctx.db.query('update devices set approved=true where user_id=$1', [uid]); }
  });

  it('keeps the stream limit: a start beyond maxStreams is 429, as for the phone', async () => {
    const uid = await me();
    await clean(uid);
    const was = env.ctx.roles.admin!.maxStreams;
    env.ctx.roles.admin!.maxStreams = 1;
    try {
      const { j } = await cast();
      await clean(uid);
      await setLive(env.ctx, { userId: uid, userName: 'a', itemId: ID, title: 't', positionTicks: 0, isPaused: false, playSessionId: 'other-ps-9', updatedAt: Date.now(), source: 'portal' });
      expect((await rep(j.report, 'start')).statusCode).toBe(429);
    } finally {
      env.ctx.roles.admin!.maxStreams = was;
      await clean(uid);
    }
  });

  it('the next-token gate holds: a queued next episode reports nothing while the cast it follows plays, then counts normally', async () => {
    const uid = await me();
    await revokeSessions(env.ctx, uid);
    admin = await env.login();
    await clean(uid);
    const cur = await cast();
    expect((await rep(cur.j.report, 'start')).statusCode).toBe(200);
    psNext = 'ps-next-0042';
    const nx = await create(admin, { next: true, after: cur.j.castId, receiver: true });
    psNext = null;
    expect(nx.r.statusCode).toBe(200);
    expect((await authz({ ct: nx.ct, client: TV })).statusCode).toBe(200); // the receiver's preload (inside the overlap)
    expect((await rep(nx.j.report, 'start')).statusCode).toBe(409);
    expect(await getLive(env.ctx, uid, 'ps-next-0042')).toBeNull();
    // the receiver moved on: the ended one's stop, then the next one's start
    expect((await rep(cur.j.report, 'stop')).statusCode).toBe(200);
    expect((await rep(nx.j.report, 'start')).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect((await rep(nx.j.report, 'stop')).statusCode).toBe(200);
    await clean(uid);
  });

  it('never logs the report token', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    try {
      const { j } = await cast();
      await rep(j.report, 'progress');
      await rep(`${j.report.slice(0, -2)}xx`, 'progress');
      expect(lines.join('\n')).not.toContain(j.report.split('.')[1]);
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});

describe('cast lookup (token-free, re-adoption and Diagnose)', () => {
  const who = async (castId: string) => {
    const idx = JSON.parse((await env.kv.get(`castidx:${await uid()}:${castId}`))!) as { hash: string };
    const rec = JSON.parse((await env.kv.get(`cast:${idx.hash}`))!) as { userId: string; profileId: string; deviceId: string };
    return { userId: rec.userId, profileId: rec.profileId, deviceId: rec.deviceId };
  };
  const uid = async () => (await call(admin, 'GET', '/api/me')).json().id as string;
  let k = 0;
  // every case its own play session: the fixed default one keeps a live record from earlier tests
  beforeEach(() => { psNext = `ps-lookup-${++k}`; });
  afterEach(() => { psNext = null; });

  it('lookup is scoped to account, profile and approved device', async () => {
    const { j } = await create();
    const w = await who(j.castId);
    const a = await castLookup(env.ctx, w, j.castId);
    expect(a).toMatchObject({ castId: j.castId, itemId: ID, mediaSourceId: MS, playSessionId: j.playSessionId, expiresAt: j.expiresAt, runtimeTicks: runtime, via: 'chromecast', next: false, reported: false, title: 'Film', pins: 0, refused: { count: 0, families: [] } });
    expect(a!.subtitles).toEqual([{ index: 2, language: 'ger', title: expect.any(String) }]);
    expect(await castLookup(env.ctx, { ...w, userId: 'u2' }, j.castId)).toBeNull();
    expect(await castLookup(env.ctx, { ...w, profileId: 'p2' }, j.castId)).toBeNull();
    expect(await castLookup(env.ctx, { ...w, deviceId: 'd2' }, j.castId)).toBeNull();
    expect(await castLookup(env.ctx, w, 'f'.repeat(32))).toBeNull();
    // the poster token's handle is no cast
    const imgCastId = hashToken(/\/media\/c\/([\w-]{43})\/Items\//.exec(j.imageUrl)![1]!).slice(0, 32);
    expect(await castLookup(env.ctx, w, imgCastId)).toBeNull();
    // revoked
    expect((await call(admin, 'DELETE', `/api/cast/session/${j.castId}`)).statusCode).toBe(200);
    expect(await castLookup(env.ctx, w, j.castId)).toBeNull();
  });

  it('lookup answer carries no token or URL', async () => {
    const { j, ct } = await create();
    const text = JSON.stringify(await castLookup(env.ctx, await who(j.castId), j.castId));
    expect(text).not.toMatch(/media\/c\//);
    expect(text).not.toContain(ct);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toContain(hashToken(ct)); // not even the stored hash, only the public 128-bit handle
    expect(text).toContain(j.castId);
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no IP literal either: the pin is only reported as a family
  });

  it('lookup names the pinned address family, never the address', async () => {
    const { j, ct } = await create();
    const w = await who(j.castId);
    expect((await castLookup(env.ctx, w, j.castId))!.pinFamily).toBeNull();
    expect((await authz({ ct, client: '192.0.2.10' })).statusCode).toBe(200);
    const l = await castLookup(env.ctx, w, j.castId);
    expect(l!.pinFamily).toBe('v4');
    expect(JSON.stringify(l)).not.toContain('192.0.2');
    // an IPv6 TV: the family is v6 and no part of the address is in the answer
    const c2 = await create();
    const w2 = await who(c2.j.castId);
    expect((await authz({ ct: c2.ct, client: '2001:db8::5' })).statusCode).toBe(200);
    const l2 = await castLookup(env.ctx, w2, c2.j.castId);
    expect(l2!.pinFamily).toBe('v6');
    expect(JSON.stringify(l2)).not.toContain('2001:db8');
  });

  it('lookup reports reported=true only after a start report', async () => {
    const { j } = await create();
    const w = await who(j.castId);
    expect((await castLookup(env.ctx, w, j.castId))!.reported).toBe(false);
    const r = await call(admin, 'POST', '/api/playback/start', { itemId: ID, playSessionId: j.playSessionId, mediaSourceId: MS, positionTicks: 0, isPaused: false, playMethod: 'Transcode' });
    expect(r.statusCode).toBe(200);
    expect((await castLookup(env.ctx, w, j.castId))!.reported).toBe(true);
  });

  it('refused counter stores families, never addresses', async () => {
    const { j, ct } = await create();
    const w = await who(j.castId);
    expect((await authz({ ct, client: '192.0.2.10' })).statusCode).toBe(200);
    expect((await castLookup(env.ctx, w, j.castId))).toMatchObject({ pins: 1, refused: { count: 0, families: [] } });
    expect((await authz({ ct, client: '192.0.2.11' })).statusCode).toBe(401);
    expect((await authz({ ct, client: '2001:db8::1' })).statusCode).toBe(401);
    expect((await castLookup(env.ctx, w, j.castId))!.refused).toEqual({ count: 2, families: ['v4', 'v6'] });
    const raw = (await env.kv.get(`castrefuse:${hashToken(ct)}`))!;
    expect(raw).not.toContain('192.0.2');
    expect(raw).not.toContain('2001');
    const text = JSON.stringify(await castLookup(env.ctx, w, j.castId));
    for (const a of ['192.0.2.10', '192.0.2.11', '2001:db8::1']) expect(text).not.toContain(a);
    // gone with the token
    await call(admin, 'DELETE', `/api/cast/session/${j.castId}`);
    expect(await env.kv.get(`castrefuse:${hashToken(ct)}`)).toBeNull();
  });

  it('GET /api/cast/session/:castId returns the lookup for the caller\'s cast', async () => {
    const { j } = await create();
    const r = await call(admin, 'GET', `/api/cast/session/${j.castId}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({ castId: j.castId, itemId: ID, via: 'chromecast', next: false, reported: false, pins: 0 });
    expect((await call(admin, 'GET', '/api/cast/session/zz')).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'GET', url: `/api/cast/session/${j.castId}` })).statusCode).toBe(401);
  });

  it('GET /api/cast/session/:castId returns 404 for another device\'s cast', async () => {
    const me = await uid();
    const w = { userId: me, profileId: (await env.pool.query('select id from profiles where user_id=$1 and is_owner', [me])).rows[0].id as string, deviceId: 'other-device-lookup' };
    await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1,$2,'x',true) on conflict do nothing", [me, w.deviceId]);
    const c = await createCast(env.ctx, { ...w, itemId: ID, mediaSourceId: MS, playSessionId: 'ps-other-dev', maxBitrate: 1_000_000, title: 'Other' }, 3600);
    expect((await castLookup(env.ctx, w, c.castId))!.title).toBe('Other');
    const r = await call(admin, 'GET', `/api/cast/session/${c.castId}`);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
    // 30 per minute
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await env.app.inject({ method: 'GET', url: `/api/cast/session/${c.castId}`, cookies: admin.cookies, headers: { 'x-forwarded-for': '203.0.113.31' } })).statusCode);
    expect(codes.filter((x) => x === 429).length).toBeGreaterThanOrEqual(2);
  });
});

describe('cast: the queued next token is pinned at mint and its life follows its predecessor', () => {
  const TV = '198.51.100.1'; // authz() pins with this address by default
  const me = async () => (await call(admin, 'GET', '/api/me')).json().id as string;
  const fresh = async () => {
    const uid = await me();
    await revokeSessions(env.ctx, uid);
    admin = await env.login();
    for (const k of [...await env.kv.keys(`play:${uid}:`), ...await env.kv.keys(`pstop:${uid}:`), ...await env.kv.keys('povl:'), ...await env.kv.keys('castnext:')]) await env.kv.del(k);
    env.ctx.roles.admin!.maxStreams = 3;
    return uid;
  };
  const role0 = { max: 0 };
  beforeAll(() => { role0.max = env.ctx.roles.admin!.maxStreams; });
  afterEach(() => { env.ctx.roles.admin!.maxStreams = role0.max; psNext = null; });
  /** the playing cast (fetched by the TV: pinned), then its queued next episode */
  const queued = async () => {
    psNext = null;
    const cur = await create();
    expect((await authz({ ct: cur.ct, client: TV })).statusCode).toBe(200);
    psNext = 'ps-next-1001';
    const nx = await create(admin, { next: true, after: cur.j.castId });
    psNext = null;
    expect(nx.r.statusCode).toBe(200);
    return { cur, nx };
  };

  it('castNextTtlSeconds caps at 6 h', () => {
    const now = Date.now();
    expect(castNextTtlSeconds(4000, now + 7 * 3600_000, now)).toBe(21600);
    expect(castNextTtlSeconds(4000, now + 30 * 60_000, now)).toBe(4000);
    expect(castNextTtlSeconds(4000, now + 3600_000 + 5000_000, now)).toBe(9000); // 4000 + (predecessor's remaining beyond its 1 h)
  });

  it('queued token is pinned to the predecessor\'s address at mint', async () => {
    await fresh();
    const { nx } = await queued();
    expect(await env.kv.get(`castpin:${hashToken(nx.ct)}`)).toBe(TV); // before anybody fetched it
    expect((await authz({ ct: nx.ct, client: '198.51.100.21' })).statusCode).toBe(401); // another address, also first
    expect((await authz({ ct: nx.ct, client: '2001:db8::7' })).statusCode).toBe(401);
    expect((await authz({ ct: nx.ct, client: TV })).statusCode).toBe(200); // the receiver, inside the overlap window
    expect((await call(admin, 'GET', `/api/cast/session/${nx.j.castId}`)).json()).toMatchObject({ next: true, pins: 1, refused: { count: 2, families: ['v4', 'v6'] } });
  });

  it('unpinned predecessor refuses the queue', async () => {
    await fresh();
    const cur = await create(); // never fetched: no pin
    const before = (await env.kv.keys('castidx:')).length;
    const calls = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).length;
    const r = await call(admin, 'POST', '/api/cast/session', { itemId: ID, next: true, after: cur.j.castId });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'cast_unpinned' });
    expect((await env.kv.keys('castidx:')).length).toBe(before);
    expect(env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).length).toBe(calls);
    expect(await env.kv.keys('castnext:')).toEqual([]);
    // once the TV fetched it, the same request works
    await authz({ ct: cur.ct, client: TV });
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: ID, next: true, after: cur.j.castId })).statusCode).toBe(200);
  });

  it('queued token idle life follows the predecessor', async () => {
    await fresh();
    const { cur, nx } = await queued();
    for (let i = 0; i < 4; i++) {
      skipClock(11 * 60_000);
      expect((await authz({ ct: cur.ct, client: TV })).statusCode).toBe(200); // the TV keeps fetching the playing episode
    }
    skipClock(2 * 60_000); // 46 min after the mint: the queued token alone would be idle-expired
    expect((await authz({ ct: nx.ct, client: '198.51.100.21' })).statusCode).toBe(401); // still pinned
    expect((await authz({ ct: nx.ct, client: TV })).statusCode).toBe(200);
  });

  it('without predecessor touches the queued token expires after 45 min', async () => {
    await fresh();
    const { nx } = await queued();
    skipClock(46 * 60_000);
    expect((await authz({ ct: nx.ct, client: TV })).statusCode).toBe(401);
  });

  it('a revoked queued token is never resurrected by its predecessor\'s touches', async () => {
    await fresh();
    const { cur, nx } = await queued();
    expect((await call(admin, 'DELETE', `/api/cast/session/${nx.j.castId}`)).statusCode).toBe(200);
    skipClock(60_000);
    expect((await authz({ ct: cur.ct, client: TV })).statusCode).toBe(200);
    expect(await env.kv.get(`cast:${hashToken(nx.ct)}`)).toBeNull();
    expect(await env.kv.get(`castpin:${hashToken(nx.ct)}`)).toBeNull();
    expect((await authz({ ct: nx.ct, client: TV })).statusCode).toBe(401);
  });

  it('a queued token never takes a pin of its own: no AirPlay queue, no re-pin after a lapse', async () => {
    await fresh();
    const { cur, nx } = await queued();
    // the queue is Chromecast only
    const r = await call(admin, 'POST', '/api/cast/session', { itemId: ID, next: true, via: 'airplay', after: cur.j.castId });
    expect(r.statusCode).toBe(400);
    // even a lapsed pin is not taken again by a foreign address
    await env.kv.del(`castpin:${hashToken(nx.ct)}`);
    expect((await authz({ ct: nx.ct, client: '203.0.113.66' })).statusCode).toBe(401);
    expect(await env.kv.get(`castpin:${hashToken(nx.ct)}`)).toBeNull();
    expect(await env.kv.get(`castpin2:${hashToken(nx.ct)}`)).toBeNull();
  });

  it('the queued poster token is pinned at mint too', async () => {
    await fresh();
    const { nx } = await queued();
    const imgCt = /\/media\/c\/([\w-]{43})\/Items\//.exec(nx.j.imageUrl)![1]!;
    expect(await env.kv.get(`castpin:${hashToken(imgCt)}`)).toBe(TV);
    expect((await authz({ ct: imgCt, client: '203.0.113.66' })).statusCode).toBe(401);
    expect((await authz({ ct: imgCt, client: TV })).statusCode).toBe(200);
    // its pin lives as long as the token: the TV is still served past the idle window (these are the poster's own touches;
    // the predecessor-driven refresh is the next test)
    skipClock(40 * 60_000);
    expect((await authz({ ct: imgCt, client: TV })).statusCode).toBe(200);
    skipClock(10 * 60_000);
    expect((await authz({ ct: imgCt, client: TV })).statusCode).toBe(200);
    expect((await authz({ ct: imgCt, client: '203.0.113.66' })).statusCode).toBe(401);
  });

  it('the queued poster keys are refreshed by the predecessor\'s touches', async () => {
    await fresh();
    const { cur, nx } = await queued();
    const imgCt = /\/media\/c\/([\w-]{43})\/Items\//.exec(nx.j.imageUrl)![1]!;
    expect((await authz({ ct: imgCt, client: TV })).statusCode).toBe(200); // the poster's last own touch
    // only the predecessor is fetched from here on: each of its touches refreshes the successor's poster keys
    for (let i = 0; i < 4; i++) {
      skipClock(11 * 60_000);
      expect((await authz({ ct: cur.ct, client: TV })).statusCode).toBe(200);
    }
    skipClock(2 * 60_000); // 46 min after the poster's own touch: past its 45 min idle window without the refresh
    expect((await authz({ ct: imgCt, client: TV })).statusCode).toBe(200);
    expect((await authz({ ct: imgCt, client: '203.0.113.66' })).statusCode).toBe(401);
    expect(await env.kv.get(`castpin:${hashToken(imgCt)}`)).toBe(TV);
  });

  it('createCast refuses a queued token whose predecessor has no pin (nothing minted)', async () => {
    await fresh();
    const cur = await create(); // never fetched
    const idx = (await env.kv.keys('castidx:')).length;
    const me0 = await me();
    const w = await (async () => {
      const i = JSON.parse((await env.kv.get(`castidx:${me0}:${cur.j.castId}`))!) as { hash: string };
      const rec = JSON.parse((await env.kv.get(`cast:${i.hash}`))!) as { profileId: string; deviceId: string };
      return { hash: i.hash, profileId: rec.profileId, deviceId: rec.deviceId };
    })();
    const base = { userId: me0, profileId: w.profileId, deviceId: w.deviceId, itemId: ID, mediaSourceId: MS, playSessionId: 'ps-x-1', maxBitrate: 1_000_000, afterPs: cur.j.playSessionId };
    await expect(createCast(env.ctx, base, 3600, false, { hash: w.hash })).rejects.toBeInstanceOf(CastUnpinnedError);
    await expect(createCast(env.ctx, base, 3600)).rejects.toBeInstanceOf(CastUnpinnedError);
    expect((await env.kv.keys('castidx:')).length).toBe(idx);
  });

  it('the queued token\'s cap follows the predecessor\'s remaining time', async () => {
    await fresh();
    const { cur, nx } = await queued();
    const a = JSON.parse((await env.kv.get(`cast:${hashToken(cur.ct)}`))!) as { exp: number };
    const b = JSON.parse((await env.kv.get(`cast:${hashToken(nx.ct)}`))!) as { exp: number };
    expect(b.exp).toBeGreaterThan(a.exp);
    expect(b.exp - nx.j.expiresAt).toBe(0);
    expect(b.exp - Date.now()).toBeLessThanOrEqual(6 * 3600_000);
  });
});

describe('cast: HEVC and surround with FriendFlix\'s own receiver', () => {
  const APP = 'A1B2C3D4';
  let was = '';
  beforeAll(() => { was = env.ctx.cfg.CAST_RECEIVER_APP_ID; env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: APP }; });
  afterAll(() => { env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: was }; });
  afterEach(() => { srcStreams = null; psNext = null; });
  const sub = { Index: 9, Type: 'Subtitle', Codec: 'srt', Language: 'ger' };
  /** Dunmoor S1 E5 "Wrenfield Pier": HEVC Main SDR 1080p with a Dolby Digital Plus 5.1 track */
  const wrenfield = [
    { Index: 0, Type: 'Video', Codec: 'hevc', Profile: 'Main', Width: 1920, Height: 1080, BitRate: 3_000_000, VideoRangeType: 'SDR' },
    { Index: 1, Type: 'Audio', Codec: 'eac3', Channels: 6, BitRate: 640_000, IsDefault: true }, sub,
  ];
  /** Saltwater Almanac S2 E1 "Night Market": H.264 with a DTS 5.1 track */
  const nightMarket = [
    { Index: 0, Type: 'Video', Codec: 'h264', Profile: 'High', Width: 1920, Height: 1080, BitRate: 3_000_000, VideoRangeType: 'SDR' },
    { Index: 1, Type: 'Audio', Codec: 'dts', Channels: 6, BitRate: 1_500_000, IsDefault: true }, sub,
  ];
  const stereoH264 = [
    { Index: 0, Type: 'Video', Codec: 'h264', Profile: 'High', Width: 1920, Height: 1080, BitRate: 3_000_000, VideoRangeType: 'SDR' },
    { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, BitRate: 160_000, IsDefault: true }, sub,
  ];
  const caps = { hevc: true, surround: ['eac3'] };
  /** the same URL with the token taken out, to compare two casts */
  const shape = (j: { contentUrl: string }) => j.contentUrl.replace(/\/media\/c\/[\w-]{43}\//, '/media/c/TOKEN/');
  const params = (j: { contentUrl: string }) => new URL(j.contentUrl).searchParams;
  /** a cast from a public address (remote: the plan may ask the HEVC gate) */
  const remote = (body: Record<string, unknown>) => env.app.inject({
    method: 'POST', url: '/api/cast/session', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf, 'x-forwarded-for': `203.0.113.${(++n % 250) + 1}` }, payload: { itemId: ID, receiver: true, ...body },
  });

  it('without caps the URL and the answer are byte-identical to today\'s (own receiver, Default Media Receiver, AirPlay, invalid caps, no claim)', async () => {
    srcStreams = wrenfield;
    const base = (await create(admin, { receiver: true })).j;
    expect(base.hlsSegmentFormat).toBe('ts');
    expect(base.hlsVideoSegmentFormat).toBeUndefined();
    expect(base.delivery).toBeUndefined();
    expect(params(base).get('VideoCodec')).toBe('h264');
    expect(params(base).get('AudioCodec')).toBe('aac');
    expect(params(base).get('SegmentContainer')).toBe('ts');
    expect(params(base).get('TranscodingMaxAudioChannels')).toBe('2');
    expect(params(base).get('Level')).toBe('41');
    expect(params(base).get('RequireAvc')).toBe('true');
    const keys = (j: Record<string, unknown>) => Object.keys(j).filter((k) => k !== 'report').sort();
    for (const body of [
      { receiver: true, caps: { hevc: false, surround: [] } }, // the receiver confirmed nothing
      { receiver: true, caps: { hevc: 'yes', surround: ['dts'] } }, // malformed: ignored, never an error
      { receiver: true, caps: { hevc: true, surround: ['eac3', 'dts'] } },
      { caps }, // a Default Media Receiver session ignores any caps
      { receiver: true, via: 'airplay', caps },
    ]) {
      const { r, j } = await create(admin, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(200);
      expect(shape(j), JSON.stringify(body)).toBe(shape(base));
      expect(keys(j), JSON.stringify(body)).toEqual(keys(base));
      expect(j.hlsSegmentFormat).toBe('ts');
    }
  });

  it('HEVC source + {hevc, eac3}: fMP4 remux, HEVC copied, the 5.1 track passed through, the answer names fMP4', async () => {
    srcStreams = wrenfield;
    const { r, j, ct } = await create(admin, { receiver: true, caps });
    expect(r.statusCode).toBe(200);
    const p = params(j);
    expect(p.get('VideoCodec')).toContain('hevc');
    expect(p.get('AudioCodec')!.startsWith('eac3')).toBe(true);
    expect(p.get('SegmentContainer')).toBe('mp4');
    expect(p.get('TranscodingMaxAudioChannels')).toBe('6');
    expect(p.get('hevc-codectag')).toBe('hvc1');
    expect(p.get('hevc-rangetype')).toBe('SDR|DOVIWithSDR'); // SDR only: never HDR / Dolby Vision
    expect(p.get('h264-level')).toBe('41');
    expect(p.get('h264-videobitdepth')).toBe('8');
    expect(p.has('Level') || p.has('MaxVideoBitDepth') || p.has('RequireAvc')).toBe(false);
    expect(p.get('EnableAdaptiveBitrateStreaming')).toBe('false'); // one variant: the receiver gets no extra HDR-copy variants
    expect(p.get('EnableTrickplay')).toBe('false');
    expect(j.hlsSegmentFormat).toBe('fmp4');
    expect(j.hlsVideoSegmentFormat).toBe('fmp4');
    expect(j.delivery).toMatchObject({ video: 'copy', videoCodec: 'hevc', audio: 'copy', audioCodec: 'eac3', channels: 6 });
    // the cast profile Jellyfin gets is unchanged (the plan decides the stream), and the token never reaches it
    const pb = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).at(-1)!;
    expect(pb.body.DeviceProfile.DirectPlayProfiles).toEqual([]);
    expect(JSON.stringify(pb)).not.toContain(ct);
    expect(j.contentUrl).not.toMatch(/api_key|ApiKey/i);
    expect(j.report).toMatch(/^[\w-]+\.[\w-]{43}$/);
  });

  it('only the surround claim: the DTS 5.1 track of an H.264 file is converted to Dolby Digital Plus, the picture is copied', async () => {
    srcStreams = nightMarket;
    const { j } = await create(admin, { receiver: true, caps: { hevc: false, surround: ['eac3', 'ac3'] } });
    const p = params(j);
    expect(p.get('VideoCodec')).toBe('h264');
    expect(p.get('AudioCodec')).toBe('eac3,ac3');
    expect(p.get('SegmentContainer')).toBe('mp4');
    expect(p.get('AudioChannels')).toBe('6');
    expect(j.hlsSegmentFormat).toBe('fmp4');
    expect(j.hlsVideoSegmentFormat).toBe('fmp4');
    expect(j.delivery).toMatchObject({ video: 'copy', videoCodec: 'h264', audio: 'surround', audioCodec: 'eac3', channels: 6 });
  });

  it('claims that change nothing for this file (an H.264 stereo file, HEVC claimed) keep the TS stream; the answer still says TS', async () => {
    srcStreams = stereoH264;
    const base = (await create(admin, { receiver: true })).j;
    const { j } = await create(admin, { receiver: true, caps });
    expect(shape(j)).toBe(shape(base));
    expect(j.hlsSegmentFormat).toBe('ts');
    expect(j.hlsVideoSegmentFormat).toBeUndefined();
    expect(j.delivery).toMatchObject({ video: 'copy', videoCodec: 'h264', audio: 'copy', channels: 2 });
  });

  it('a device that confirms HEVC but no Main 10 gets only Main; a Main 10 file is not copied as HEVC then', async () => {
    srcStreams = [{ ...wrenfield[0]!, Profile: 'Main 10' }, wrenfield[1], sub];
    const main = (await create(admin, { receiver: true, caps: { hevc: true, surround: [] } })).j;
    expect(params(main).get('hevc-profile')).toBe('main');
    expect(main.delivery.video).toBe('h264');
    const ten = (await create(admin, { receiver: true, caps: { hevc: true, hevc10: true, surround: [] } })).j;
    expect(params(ten).get('hevc-profile')).toBe('main,main10');
    expect(ten.delivery).toMatchObject({ video: 'copy', videoCodec: 'hevc' });
  });

  it('hevc10 without hevc claims nothing', async () => {
    srcStreams = wrenfield;
    const base = (await create(admin, { receiver: true })).j;
    const { j } = await create(admin, { receiver: true, caps: { hevc: false, hevc10: true, surround: [] } });
    expect(shape(j)).toBe(shape(base));
  });

  it('a Dolby Vision source is never HEVC-copied into the stream (SDR only)', async () => {
    srcStreams = [{ ...wrenfield[0]!, VideoRangeType: 'DOVI' }, wrenfield[1], sub];
    const { j } = await create(admin, { receiver: true, caps });
    expect(j.delivery.video).toBe('h264');
    expect(params(j).get('hevc-rangetype')).toBe('SDR|DOVIWithSDR');
  });

  it('remote: the HEVC gate is asked once for a conversion; its answer shapes the plan; a refusal keeps H.264 and names the reason', async () => {
    srcStreams = [{ ...wrenfield[0]!, BitRate: 60_000_000 }, wrenfield[1], sub];
    const gate = vi.fn(async (): Promise<{ ok: true } | { ok: false; why: 'h264_busy' }> => ({ ok: true }));
    const orig = env.ctx.jf.playbackInfo.bind(env.ctx.jf);
    const spy = vi.spyOn(env.ctx.jf, 'playbackInfo').mockImplementation((u, i, o) => orig(u, i, { ...o, hevcGate: o.hevcGate ? gate : undefined }));
    try {
      const r = await remote({ caps });
      expect(r.statusCode).toBe(200);
      expect(gate).toHaveBeenCalledTimes(1);
      expect(r.json().delivery).toMatchObject({ video: 'hevc', videoCodec: 'hevc' });
      expect(r.json().delivery.why).toContain('hevc_upload');
      expect(params(r.json()).get('VideoCodec')).toBe('hevc,h264');
      expect(r.json().hlsSegmentFormat).toBe('fmp4');
      // a conversion is remembered for the server's count (fixed codes only)
      const uid = (await call(admin, 'GET', '/api/me')).json().id as string;
      expect(JSON.parse((await env.kv.get(`pbinfo:${uid}:${r.json().playSessionId}`))!)).toEqual({ video: 'hevc', audio: 'copy' });
      gate.mockResolvedValueOnce({ ok: false, why: 'h264_busy' });
      const refused = await remote({ caps });
      expect(refused.json().delivery).toMatchObject({ video: 'h264' });
      expect(refused.json().delivery.why[0]).toBe('h264_busy');
      expect(params(refused.json()).get('VideoCodec')).toBe('h264,hevc'); // copying stays possible
      // at home the gate is never asked
      gate.mockClear();
      await create(admin, { receiver: true, caps });
      expect(gate).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('remote without a ready probe (the real gate) or with HEVC_STREAMS 0: H.264 with the fixed reason', async () => {
    srcStreams = [{ ...wrenfield[0]!, BitRate: 60_000_000 }, wrenfield[1], sub];
    expect((await remote({ caps })).json().delivery.why[0]).toBe('h264_unproven');
    env.ctx.cfg = { ...env.ctx.cfg, HEVC_STREAMS: 0 };
    try { expect((await remote({ caps })).json().delivery.why[0]).toBe('h264_off'); } finally { env.ctx.cfg = { ...env.ctx.cfg, HEVC_STREAMS: 2 }; }
  });

  it('surround is off with SURROUND_AUDIO=false: the 5.1 track stays stereo', async () => {
    srcStreams = nightMarket;
    env.ctx.cfg = { ...env.ctx.cfg, SURROUND_AUDIO: 'false' };
    try {
      const { j } = await create(admin, { receiver: true, caps: { hevc: false, surround: ['eac3'] } });
      expect(j.delivery).toMatchObject({ audio: 'stereo', channels: 2 });
      expect(params(j).get('AudioCodec')).toBe('aac');
      expect(j.hlsSegmentFormat).toBe('ts');
    } finally { env.ctx.cfg = { ...env.ctx.cfg, SURROUND_AUDIO: 'true' }; }
  });

  it('a queued next episode carries the same caps (fMP4 too)', async () => {
    const uid = (await call(admin, 'GET', '/api/me')).json().id as string;
    await revokeSessions(env.ctx, uid);
    admin = await env.login();
    for (const k of [...await env.kv.keys(`play:${uid}:`), ...await env.kv.keys('castnext:')]) await env.kv.del(k);
    const role = env.ctx.roles.admin!, before = role.maxStreams;
    role.maxStreams = 3;
    try {
      srcStreams = wrenfield;
      const cur = await create(admin, { receiver: true, caps });
      expect((await authz({ ct: cur.ct, client: '198.51.100.1' })).statusCode).toBe(200);
      psNext = 'ps-next-7001';
      const nx = await create(admin, { receiver: true, caps, next: true, after: cur.j.castId });
      expect(nx.r.statusCode).toBe(200);
      expect(nx.j.hlsSegmentFormat).toBe('fmp4');
      expect(shape(nx.j).replace('ps-next-7001', 'ps-12345678')).toBe(shape(cur.j));
    } finally { role.maxStreams = before; psNext = null; }
  });

  it('a receiver failure that follows a conversion counts against the server\'s HEVC state once, like a player fallback', async () => {
    const uid = (await call(admin, 'GET', '/api/me')).json().id as string;
    await env.kv.set(`pbinfo:${uid}:ps-failed-hevc`, JSON.stringify({ video: 'hevc', audio: 'copy' }), 600);
    await env.kv.set(`pbinfo:${uid}:ps-failed-copy`, JSON.stringify({ video: 'copy', audio: 'copy' }), 600);
    await env.kv.del('hevcenc:failures');
    srcStreams = stereoH264;
    await create(admin, { receiver: true, caps, fellBack: 'surround', prevPs: 'ps-failed-hevc' }); // not a HEVC fallback
    await create(admin, { receiver: true, caps, fellBack: 'hevc', prevPs: 'ps-failed-copy' }); // a remux failure never counts
    expect(await env.kv.get('hevcenc:failures')).toBeNull();
    const r = await create(admin, { receiver: true, caps, fellBack: 'hevc', prevPs: 'ps-failed-hevc' });
    expect(r.r.statusCode).toBe(200);
    expect(JSON.parse((await env.kv.get('hevcenc:failures'))!)).toHaveLength(1);
  });
});
