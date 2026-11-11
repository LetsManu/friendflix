// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Continuous AirPlay, server-side progress per episode (Task 18): the gateway reports the joined stream's segment positions
 * (POST /internal/cast/progress, token hash + item + position) and the backend turns them into each episode's start, progress and
 * stop as the token's profile on the token's device (via airplay), with one live stream at any time.
 * Saltwater Almanac (fictional): S1 E10, S2 E1, S2 E2 in a row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, revokeCasts, type CastRecord } from '../src/cast.js';
import { countLive } from '../src/live.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

const SERIES = 'e'.repeat(32);
const FILM = 'f'.repeat(32);
const FILM_MS = '9'.repeat(32);
const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
const S = 10_000_000; // ticks per second
type Ep = { id: string; ms: string; ps: string; name: string; season: number; ix: number; rt: number };
const EPS: Ep[] = [
  { id: '1'.repeat(32), ms: 'a'.repeat(32), ps: 'ps-night-market', name: 'Night Market', season: 1, ix: 10, rt: 2832 * S },
  { id: '2'.repeat(32), ms: 'b'.repeat(32), ps: 'ps-toll-keeper', name: 'The Toll Keeper', season: 2, ix: 1, rt: 2643 * S },
  { id: '3'.repeat(32), ms: 'c'.repeat(32), ps: 'ps-glass-tides', name: 'Glass Tides', season: 2, ix: 2, rt: 2970 * S },
];
type Sess = { cookies: Record<string, string>; csrf: string };
/** Jumps the wall clock forward (only Date is faked). */
const skipClock = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };
afterEach(() => { vi.useRealTimers(); });

let env: TestEnv;
let admin: Sess;
let n = 0;
/** every PlaybackInfo hands out a fresh play session per episode (tokens of different tests never share one) */
let mint = 0;
const epDto = (e: Ep) => ({
  Id: e.id, Name: e.name, Type: 'Episode', SeriesId: SERIES, SeriesName: 'Saltwater Almanac', ParentIndexNumber: e.season, IndexNumber: e.ix, RunTimeTicks: e.rt,
  ImageTags: { Primary: 'x' }, UserData: { PlaybackPositionTicks: 0 }, MediaSources: [{ Id: e.ms, MediaStreams: [] }],
});

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': (u) => {
      if (u.pathname.endsWith(FILM)) return { json: { Id: FILM, Name: 'Film', Type: 'Movie', RunTimeTicks: 5400 * S, UserData: {} } };
      return { json: epDto(EPS.find((e) => u.pathname.endsWith(e.id)) ?? EPS[0]!) };
    },
    [`GET /Shows/${SERIES}/Episodes`]: (u) => {
      const i = EPS.findIndex((e) => e.id === u.searchParams.get('startItemId'));
      return { json: { Items: EPS.slice(i, i + Number(u.searchParams.get('limit') ?? 2)).map(epDto) } };
    },
    'POST /Items/[^/]+/PlaybackInfo': (u) => {
      const streams = [{ Index: 0, Type: 'Video', Codec: 'h264', Height: 1080 }, { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'ger' }];
      if (u.pathname.includes(FILM)) return { json: { PlaySessionId: `ps-film-${++mint}`, MediaSources: [{ Id: FILM_MS, Container: 'mkv', Bitrate: 4_000_000, RunTimeTicks: 5400 * S, MediaStreams: streams }] } };
      const e = EPS.find((x) => u.pathname.includes(x.id))!;
      return { json: { PlaySessionId: `${e.ps}-${++mint}`, MediaSources: [{ Id: e.ms, Container: 'mkv', Bitrate: 4_000_000, RunTimeTicks: e.rt, MediaStreams: streams }] } };
    },
    'POST /Sessions/Playing': () => ({ status: 204 }),
    'POST /Sessions/Playing/Progress': () => ({ status: 204 }),
    'POST /Sessions/Playing/Stopped': () => ({ status: 204 }),
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  });
  admin = await env.login(ADMIN);
  expect((await call('PUT', '/api/admin/settings', { values: { CAST_AIRPLAY_CONTINUOUS: true } })).statusCode).toBe(200);
});
afterAll(() => env.close());
// the live records of earlier tests' tokens (45 s) never count in a later one
beforeEach(async () => { for (const k of await env.kv.keys('play:')) await env.kv.del(k); });

const call = (method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf, 'x-forwarded-for': `10.4.${Math.floor(++n / 250)}.${n % 250}` }, payload: body as object });

/** a joined AirPlay token of the three episodes: the raw token, its hash, castId and stored record */
async function joined(body: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', ...body });
  expect(r.statusCode, r.body).toBe(200);
  const ct = /\/media\/c\/([\w-]{43})\//.exec(r.json().contentUrl)![1]!;
  const hash = hashToken(ct);
  const rec = JSON.parse((await env.kv.get(`cast:${hash}`))!) as CastRecord;
  return { ct, hash, castId: r.json().castId as string, rec, ps: (rec.items ?? []).map((i) => i.playSessionId) };
}
const joinedToken = () => joined({ continuous: true });
const progress = (tokenHash: string, itemId: string, positionTicks: number, headers: Record<string, string> = H) =>
  env.app.inject({ method: 'POST', url: '/internal/cast/progress', headers, payload: { tokenHash, itemId, positionTicks } });
/** what the server told Jellyfin since `from`: [kind, item, play session, position] */
const reports = (from: number) =>
  env.jfCalls.slice(from).filter((c) => c.method === 'POST' && c.path.startsWith('/Sessions/Playing'))
    .map((c) => [c.path.replace('/Sessions/', ''), c.body.ItemId, c.body.PlaySessionId, c.body.PositionTicks]);
const authz = (ct: string) => env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { ct, client: '198.51.100.7' } });

describe('server-side per-episode progress of a joined AirPlay stream', () => {
  it('moving to episode 2 stops episode 1 at its runtime and starts episode 2', async () => {
    const { hash, ps } = await joinedToken();
    const from = env.jfCalls.length;
    for (const [id, pos] of [[EPS[0]!.id, 0], [EPS[0]!.id, 2815 * S], [EPS[1]!.id, 0]] as const) {
      const r = await progress(hash, id, pos);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ ok: true });
    }
    // episode 1's last report was 17 s before its end (within the last 30 s): it played to its end
    expect(reports(from)).toEqual([
      ['Playing', EPS[0]!.id, ps[0], 0],
      ['Playing/Stopped', EPS[0]!.id, ps[0], EPS[0]!.rt],
      ['Playing', EPS[1]!.id, ps[1], 0],
    ]);
    // and episode 2 to episode 3 the same way
    skipClock(5_000);
    await progress(hash, EPS[1]!.id, EPS[1]!.rt - 3 * S);
    await progress(hash, EPS[2]!.id, 0);
    expect(reports(from).slice(3)).toEqual([
      ['Playing/Stopped', EPS[1]!.id, ps[1], EPS[1]!.rt],
      ['Playing', EPS[2]!.id, ps[2], 0],
    ]);
  });

  it('a seek into episode 2 stops episode 1 where it was', async () => {
    const { hash, ps } = await joinedToken();
    const from = env.jfCalls.length;
    await progress(hash, EPS[0]!.id, 0);
    await progress(hash, EPS[0]!.id, 300 * S);
    await progress(hash, EPS[1]!.id, 600 * S);
    expect(reports(from)).toEqual([
      ['Playing', EPS[0]!.id, ps[0], 0],
      ['Playing/Stopped', EPS[0]!.id, ps[0], 300 * S],
      ['Playing', EPS[1]!.id, ps[1], 600 * S],
    ]);
    // and back into episode 1: episode 2 stops where it was, episode 1 starts again
    await progress(hash, EPS[0]!.id, 100 * S);
    expect(reports(from).slice(3)).toEqual([
      ['Playing/Stopped', EPS[1]!.id, ps[1], 600 * S],
      ['Playing', EPS[0]!.id, ps[0], 100 * S],
    ]);
  });

  it('never more than one live stream', async () => {
    const { ct, hash, ps, rec } = await joinedToken();
    const uid = rec.userId;
    expect((await authz(ct)).statusCode).toBe(200);
    const live = async () => [await countLive(env.ctx, uid), ...(await env.kv.keys(`play:${uid}:`)).map((k) => k.split(':')[2])];
    await progress(hash, EPS[0]!.id, 0);
    expect(await live()).toEqual([1, ps[0]]);
    // the token's sliding refresh (touch) keeps the current part's live record
    skipClock(25_000);
    expect((await authz(ct)).statusCode).toBe(200);
    expect(await live()).toEqual([1, ps[0]]);
    await progress(hash, EPS[0]!.id, 2820 * S);
    await progress(hash, EPS[1]!.id, 0);
    expect(await live()).toEqual([1, ps[1]]);
    // well past the stop's drain window, the touches keep episode 2 live and never bring episode 1 back
    for (let i = 0; i < 8; i++) {
      skipClock(25_000);
      expect((await authz(ct)).statusCode).toBe(200);
      expect(await live(), `touch ${i}`).toEqual([1, ps[1]]);
    }
  });

  it('a first report of a later part replaces the live record the token\'s first fetches made for episode 1', async () => {
    const { ct, hash, ps, rec } = await joinedToken();
    const uid = rec.userId;
    expect((await authz(ct)).statusCode).toBe(200);
    skipClock(25_000);
    expect((await authz(ct)).statusCode).toBe(200); // touch: episode 1 counted from the fetches alone
    expect(await countLive(env.ctx, uid)).toBe(1);
    const from = env.jfCalls.length;
    await progress(hash, EPS[1]!.id, 60 * S); // the TV started in episode 2 (a seek before the first report)
    expect(reports(from)).toEqual([['Playing', EPS[1]!.id, ps[1], 60 * S]]);
    expect((await env.kv.keys(`play:${uid}:`)).map((k) => k.split(':')[2])).toEqual([ps[1]]);
  });

  it('progress at most every 30 s', async () => {
    const { hash, ps } = await joinedToken();
    const from = env.jfCalls.length;
    await progress(hash, EPS[0]!.id, 0);
    skipClock(15_000); await progress(hash, EPS[0]!.id, 15 * S);
    skipClock(14_000); await progress(hash, EPS[0]!.id, 29 * S);
    expect(reports(from)).toHaveLength(1);
    skipClock(1_000); await progress(hash, EPS[0]!.id, 30 * S); // 30 s since the last report
    skipClock(15_000); await progress(hash, EPS[0]!.id, 45 * S);
    skipClock(15_000); await progress(hash, EPS[0]!.id, 60 * S);
    expect(reports(from)).toEqual([
      ['Playing', EPS[0]!.id, ps[0], 0],
      ['Playing/Progress', EPS[0]!.id, ps[0], 30 * S],
      ['Playing/Progress', EPS[0]!.id, ps[0], 60 * S],
    ]);
  });

  it('revoke stops the current episode at its last position', async () => {
    const { hash, castId, ps, rec } = await joinedToken();
    const from = env.jfCalls.length;
    await progress(hash, EPS[0]!.id, 0);
    await progress(hash, EPS[1]!.id, 0);
    skipClock(10_000);
    await progress(hash, EPS[1]!.id, 500 * S); // throttled: no report, but the position is kept
    expect(reports(from)).toHaveLength(3);
    const r = await call('DELETE', `/api/cast/session/${castId}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(reports(from).slice(3)).toEqual([['Playing/Stopped', EPS[1]!.id, ps[1], 500 * S]]);
    // every part's encoding ends with the token, not only episode 1's
    const stopped = env.jfCalls.slice(from).filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings').map((c) => new URLSearchParams(c.search).get('playSessionId'));
    expect(stopped).toEqual(expect.arrayContaining(ps));
    expect(await countLive(env.ctx, rec.userId)).toBe(0);
    expect(await env.kv.get(`castjp:${hash}`)).toBeNull();
    // the gateway's next call for the revoked token changes nothing
    const after = env.jfCalls.length;
    expect((await progress(hash, EPS[1]!.id, 510 * S)).statusCode).toBe(404);
    expect(env.jfCalls.length).toBe(after);
  });

  it('revoking all tokens of a device (logout, device revoke, profile switch) stops the current episode too', async () => {
    const { hash, ps, rec } = await joinedToken();
    const from = env.jfCalls.length;
    await progress(hash, EPS[0]!.id, 0);
    skipClock(10_000);
    await progress(hash, EPS[0]!.id, 700 * S);
    expect(await revokeCasts(env.ctx, rec.userId, rec.deviceId)).toBeGreaterThan(0);
    // (the device's other token from an earlier test is revoked and stopped as well: only this token's play sessions here)
    expect(reports(from).filter((r) => ps.includes(r[2]))).toEqual([
      ['Playing', EPS[0]!.id, ps[0], 0],
      ['Playing/Stopped', EPS[0]!.id, ps[0], 700 * S],
    ]);
    const stopped = env.jfCalls.slice(from).filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings').map((c) => new URLSearchParams(c.search).get('playSessionId'));
    expect(stopped).toEqual(expect.arrayContaining(ps));
  });

  it('a token evicted by a newer one stops nothing: the last progress stands', async () => {
    const first = await joinedToken();
    await progress(first.hash, EPS[0]!.id, 0);
    skipClock(10_000);
    await progress(first.hash, EPS[0]!.id, 900 * S);
    const from = env.jfCalls.length;
    await joinedToken();
    await joinedToken(); // two media tokens per account: the first one is evicted
    expect(await env.kv.get(`cast:${first.hash}`)).toBeNull();
    expect(reports(from)).toEqual([]);
    expect((await progress(first.hash, EPS[0]!.id, 910 * S)).statusCode).toBe(404);
  });

  it('the hand-off row follows with via airplay', async () => {
    const { hash, rec } = await joinedToken();
    const row = async () => (await env.pool.query('select item_id, position_ticks, via from handoff where profile_id = $1 and device_id = $2', [rec.profileId, rec.deviceId])).rows[0];
    await progress(hash, EPS[0]!.id, 0);
    expect(await row()).toEqual({ item_id: EPS[0]!.id, position_ticks: '0', via: 'airplay' });
    await progress(hash, EPS[0]!.id, 2830 * S);
    await progress(hash, EPS[1]!.id, 12 * S);
    expect(await row()).toEqual({ item_id: EPS[1]!.id, position_ticks: String(12 * S), via: 'airplay' });
  });

  it('unknown token, unlisted item or single-item token is 404', async () => {
    const { hash } = await joinedToken();
    const single = await joined(); // AirPlay, no continuous: one item
    const film = await joined({ itemId: FILM, continuous: true }); // a film is never joined
    expect(single.rec.items).toBeUndefined();
    expect(film.rec.items).toBeUndefined();
    const from = env.jfCalls.length;
    const cases: Array<[string, string]> = [
      ['0'.repeat(64), EPS[0]!.id], // no such token
      [hash, '4'.repeat(32)], // not one of its items
      [hash, FILM],
      [single.hash, EPS[0]!.id],
      [film.hash, FILM],
    ];
    for (const [h, id] of cases) {
      const r = await progress(h, id, 0);
      expect(r.statusCode, `${h.slice(0, 4)} ${id.slice(0, 4)}`).toBe(404);
      expect(r.json()).toEqual({ error: 'not_found' });
    }
    expect(reports(from)).toEqual([]);
    expect(await env.kv.keys('castjp:')).toEqual([]);
  });

  it('internal only: the secret is required, the body is the hash (never a raw token) and nothing else', async () => {
    const { ct, hash } = await joinedToken();
    expect((await progress(hash, EPS[0]!.id, 0, {})).statusCode).toBe(403);
    expect((await progress(hash, EPS[0]!.id, 0, { 'x-internal-secret': 'wrong' })).statusCode).toBe(403);
    const bad = [
      { token: ct, itemId: EPS[0]!.id, positionTicks: 0 },
      { tokenHash: ct, itemId: EPS[0]!.id, positionTicks: 0 },
      { tokenHash: hash, itemId: EPS[0]!.id, positionTicks: -1 },
      { tokenHash: hash, itemId: EPS[0]!.id, positionTicks: 1.5 },
      { tokenHash: hash, itemId: EPS[0]!.id, positionTicks: 0, client: '198.51.100.7' },
    ];
    for (const payload of bad) expect((await env.app.inject({ method: 'POST', url: '/internal/cast/progress', headers: H, payload })).statusCode, JSON.stringify(Object.keys(payload))).toBe(400);
    expect(await env.kv.keys('castjp:')).toEqual([]);
  });
});
