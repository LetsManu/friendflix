// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Wishes for chosen seasons of a series and for the parts of a film collection (request service; fictional titles).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectionOf, partState, seasonStates } from '../src/seerr/states.js';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, friend: Sess;
let rid = 500;
const imported = new Set<string>();
/** tmdb ids whose request POST fails upstream */
const failing = new Set<number>();

const NORDLICHT = {
  id: 7001, name: 'Nordlicht', posterPath: '/nordlicht.jpg',
  seasons: [
    { seasonNumber: 0, name: 'Specials', episodeCount: 2, airDate: '2019-12-24' },
    { seasonNumber: 1, name: 'Staffel 1', episodeCount: 8, airDate: '2019-03-01' },
    { seasonNumber: 2, name: 'Staffel 2', episodeCount: 8, airDate: '2020-03-01' },
    { seasonNumber: 3, name: 'Staffel 3', episodeCount: 10, airDate: '2021-03-01' },
    { seasonNumber: 4, name: 'Staffel 4', episodeCount: 10, airDate: '2022-03-01' },
    { seasonNumber: 5, name: 'Staffel 5', episodeCount: 6, airDate: '2023-03-01' },
  ],
  mediaInfo: {
    status: 4,
    seasons: [{ seasonNumber: 1, status: 5 }, { seasonNumber: 2, status: 4 }],
    requests: [
      { id: 50, status: 1, seasons: [{ seasonNumber: 3, status: 1 }] },
      { id: 51, status: 3, seasons: [{ seasonNumber: 4, status: 3 }] },
      { id: 52, status: 2, seasons: [{ seasonNumber: 5, status: 2 }] },
    ],
  },
};
const HAFENKANAL = { id: 7002, name: 'Hafenkanal', seasons: [{ seasonNumber: 1, episodeCount: 6 }, { seasonNumber: 2, episodeCount: 6 }] };
const part = (id: number, title: string, releaseDate: string | undefined, mediaInfo?: object) => ({ id, mediaType: 'movie', title, releaseDate, posterPath: `/p${id}.jpg`, mediaInfo });
const STERNWARTE = {
  id: 900, name: 'Sternwarte 24 – Die Reihe', posterPath: '/col900.jpg',
  parts: [
    part(8005, 'Sternwarte 24: Morgen', '2099-05-01'),
    part(8002, 'Sternwarte 24: Funkstille', '2014-06-01'),
    part(8001, 'Sternwarte 24', '2012-06-01', { status: 5 }),
    part(8003, 'Sternwarte 24: Nachtschicht', '2016-06-01', { status: 2 }),
    part(8004, 'Sternwarte 24: Sonnenwind', '2018-06-01', { status: 1, requests: [{ id: 60, status: 3 }] }),
    part(8007, 'Sternwarte 24: Polarnacht', '2019-06-01', { status: 3 }),
    part(8006, 'Sternwarte 24: Ohne Datum', undefined),
    part(8008, 'Sternwarte 24: Kometen', '2020-06-01'),
  ],
};
const PART_STATUS: Record<number, number | undefined> = { 8001: 5, 8003: 2, 8007: 3 };

beforeAll(async () => {
  env = await makeEnv({}, {
    seerr: {
      'GET /api/v1/user': () => ({ json: { results: [...imported].map((j, i) => ({ id: 10 + i, jellyfinUserId: j })) } }),
      'POST /api/v1/user/import-from-jellyfin': (_u, _i, b) => { imported.add(b.jellyfinUserIds[0]); return { json: [{ id: 9 }] }; },
      'GET /api/v1/tv/7001': () => ({ json: NORDLICHT }),
      'GET /api/v1/tv/7002': () => ({ json: HAFENKANAL }),
      'GET /api/v1/movie/8009': () => ({ json: { id: 8009, title: 'Allein am Kai' } }),
      'GET /api/v1/movie/\\d+': (u) => {
        const id = Number(u.pathname.split('/').pop());
        const p = STERNWARTE.parts.find((x) => x.id === id);
        const st = PART_STATUS[id];
        return { json: { id, title: p?.title ?? `#${id}`, posterPath: p?.posterPath, collection: { id: 900, name: STERNWARTE.name }, mediaInfo: st ? { status: st } : undefined } };
      },
      'GET /api/v1/collection/900': () => ({ json: STERNWARTE }),
      'POST /api/v1/request': (_u, _i, b) => (failing.has(b.mediaId) ? { status: 500, json: {} } : { json: { id: ++rid, status: 1, media: { status: 2 } } }),
      'GET /api/v1/request': () => ({ json: { results: [{ id: 70, type: 'tv', status: 1, seasons: [{ seasonNumber: 2 }, { seasonNumber: 3 }], media: { status: 2, tmdbId: 7002, mediaType: 'tv' }, requestedBy: { displayName: 'x' }, createdAt: '2026-01-01' }], pageInfo: {} } }),
    },
  });
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub: 'sub-friend', email: 'f@example.com', name: 'Fred', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  friend = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
});
afterAll(() => env.close());
beforeEach(async () => {
  failing.clear();
  await env.pool.query('delete from seerr_requests; delete from request_reservations');
});

const call = (s: Sess, method: string, url: string, body?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const posts = () => env.seerrCalls.filter((c) => c.method === 'POST' && c.path === '/api/v1/request');
const upstream = (path: string) => env.seerrCalls.filter((c) => c.method === 'GET' && c.path === path).length;
const batch = (s: Sess, ids: number[], extra: object = {}) => call(s, 'POST', '/api/requests/batch', { items: ids.map((tmdbId) => ({ mediaType: 'movie', tmdbId })), ...extra });

describe('state mapping (pure)', () => {
  it('season states: available > partial > processing > requested > declined > none', () => {
    const s = seasonStates(NORDLICHT);
    expect(s.map((x) => [x.number, x.state])).toEqual([[0, 'none'], [1, 'available'], [2, 'partial'], [3, 'requested'], [4, 'declined'], [5, 'processing']]);
    expect(s[1]).toMatchObject({ name: 'Staffel 1', episodes: 8, airDate: '2019-03-01' });
    // seasons the service knows only from the media record still appear; junk is ignored
    expect(seasonStates({ seasons: 'x', mediaInfo: { seasons: [{ seasonNumber: 2, status: 5 }, { seasonNumber: -1, status: 5 }, null] } }).map((x) => [x.number, x.state])).toEqual([[2, 'available']]);
    expect(seasonStates({})).toEqual([]);
  });
  it('part states: in the library, in progress, requested, declined, requestable, not released yet', () => {
    const today = '2026-11-17';
    expect(partState({ status: 5 }, '2012-01-01', today)).toBe('available');
    expect(partState({ status: 4 }, '2012-01-01', today)).toBe('available');
    expect(partState({ status: 3 }, '2012-01-01', today)).toBe('processing');
    expect(partState({ status: 1, requests: [{ status: 2 }] }, '2012-01-01', today)).toBe('processing');
    expect(partState({ status: 2 }, '2012-01-01', today)).toBe('requested');
    expect(partState({ status: 1, requests: [{ status: 3 }] }, '2012-01-01', today)).toBe('declined');
    expect(partState(undefined, '2012-01-01', today)).toBe('none');
    expect(partState(undefined, '2026-11-18', today)).toBe('unreleased');
    expect(partState(undefined, undefined, today)).toBe('unreleased');
    expect(partState({ status: 2 }, '2099-01-01', today)).toBe('requested'); // asked for already: that wins over the date
  });
  it('collectionOf reads collection or belongsToCollection, ignores junk', () => {
    expect(collectionOf({ collection: { id: 900, name: 'Reihe' } })).toEqual({ id: 900, name: 'Reihe' });
    expect(collectionOf({ belongsToCollection: { id: 901, name: 'Andere' } })).toEqual({ id: 901, name: 'Andere' });
    expect(collectionOf({ collection: { id: 'x' } })).toBeNull();
    expect(collectionOf({ collection: { id: -3, name: 'n' } })).toBeNull();
    expect(collectionOf({})).toBeNull();
  });
});

describe('seasons', () => {
  it('GET /api/seerr/tv/:id/seasons lists every season with its state', async () => {
    const r = await call(friend, 'GET', '/api/seerr/tv/7001/seasons');
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ tmdbId: 7001, title: 'Nordlicht', poster: '/api/seerr/image/nordlicht.jpg' });
    expect(b.seasons.map((s: any) => [s.number, s.state])).toEqual([[0, 'none'], [1, 'available'], [2, 'partial'], [3, 'requested'], [4, 'declined'], [5, 'processing']]);
    expect(b.seasons[0]).toMatchObject({ number: 0, name: 'Specials', episodes: 2 });
  });
  it('validates the id', async () => {
    expect((await call(friend, 'GET', '/api/seerr/tv/abc/seasons')).statusCode).toBe(400);
    expect((await call(friend, 'GET', '/api/seerr/tv/0/seasons')).statusCode).toBe(400);
  });
  it('a partly requested series: only the chosen seasons that are still open are requested', async () => {
    const before = posts().length;
    const r = await call(friend, 'POST', '/api/requests', { mediaType: 'tv', tmdbId: 7001, seasons: [0, 3, 4, 4] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ seasons: [0, 4] });
    expect(posts()).toHaveLength(before + 1);
    expect(posts().at(-1)!.body).toMatchObject({ mediaType: 'tv', mediaId: 7001, seasons: [0, 4] });
    expect((await env.pool.query('select seasons from seerr_requests where tmdb_id = 7001')).rows).toEqual([{ seasons: [0, 4] }]);
    const mine = (await call(friend, 'GET', '/api/requests/mine')).json().requests;
    expect(mine[0]).toMatchObject({ title: 'Nordlicht', mediaType: 'tv', seasons: [0, 4] });
  });
  it('nothing left to request among the chosen seasons: 409, nothing sent', async () => {
    const before = posts().length;
    const r = await call(friend, 'POST', '/api/requests', { mediaType: 'tv', tmdbId: 7001, seasons: [1, 2, 3, 5] });
    expect([r.statusCode, r.json().error]).toEqual([409, 'already_requested']);
    expect(posts()).toHaveLength(before);
  });
  it('seasons the series does not have: 400 bad_seasons; an empty list: 400', async () => {
    expect((await call(friend, 'POST', '/api/requests', { mediaType: 'tv', tmdbId: 7002, seasons: [9] })).json()).toEqual({ error: 'bad_seasons' });
    expect((await call(friend, 'POST', '/api/requests', { mediaType: 'tv', tmdbId: 7002, seasons: [] })).statusCode).toBe(400);
  });
  it('a new series with chosen seasons sends exactly those; counts as one wish', async () => {
    const r = await call(friend, 'POST', '/api/requests', { mediaType: 'tv', tmdbId: 7002, seasons: [2, 1] });
    expect(r.statusCode, r.body).toBe(200);
    expect(posts().at(-1)!.body).toMatchObject({ mediaId: 7002, seasons: [1, 2] });
    expect((await call(friend, 'GET', '/api/requests/quota')).json()).toMatchObject({ used: 1 });
  });
  it('without seasons a series is still requested whole (older clients)', async () => {
    const r = await call(friend, 'POST', '/api/requests', { mediaType: 'tv', tmdbId: 7002 });
    expect(r.statusCode, r.body).toBe(200);
    expect(posts().at(-1)!.body).toMatchObject({ mediaId: 7002, seasons: 'all' });
    expect((await env.pool.query('select seasons from seerr_requests where tmdb_id = 7002')).rows).toEqual([{ seasons: null }]);
  });
  it('the admin list names the seasons of a request', async () => {
    const l = (await call(admin, 'GET', '/api/admin/requests?filter=pending')).json().requests;
    expect(l[0]).toMatchObject({ id: 70, mediaType: 'tv', seasons: [2, 3] });
  });
});

describe('collections', () => {
  it('GET /api/seerr/movie/:id/collection: parts in release order with their state, cached briefly', async () => {
    const r = await call(friend, 'GET', '/api/seerr/movie/8001/collection');
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json().collection;
    expect(c).toMatchObject({ id: 900, name: 'Sternwarte 24 – Die Reihe', poster: '/api/seerr/image/col900.jpg' });
    expect(c.parts.map((p: any) => [p.tmdbId, p.state])).toEqual([
      [8001, 'available'], [8002, 'none'], [8003, 'requested'], [8004, 'declined'], [8007, 'processing'], [8008, 'none'], [8005, 'unreleased'], [8006, 'unreleased'],
    ]);
    expect(c.parts[0]).toEqual({ tmdbId: 8001, title: 'Sternwarte 24', year: '2012', releaseDate: '2012-06-01', poster: '/api/seerr/image/p8001.jpg', state: 'available' });
    const n = upstream('/api/v1/collection/900');
    expect((await call(friend, 'GET', '/api/seerr/movie/8002/collection')).json().collection.id).toBe(900);
    expect(upstream('/api/v1/collection/900')).toBe(n); // the second movie of the same collection is served from the cache
  });
  it('a movie without a collection: collection null', async () => {
    expect((await call(friend, 'GET', '/api/seerr/movie/8009/collection')).json()).toEqual({ collection: null });
  });
  it('validates the id', async () => {
    expect((await call(friend, 'GET', '/api/seerr/movie/-1/collection')).statusCode).toBe(400);
    expect((await call(friend, 'GET', '/api/seerr/movie/1e3/collection')).statusCode).toBe(400);
  });
  it('a movie wish says which collection the movie belongs to', async () => {
    const r = await call(admin, 'POST', '/api/requests', { mediaType: 'movie', tmdbId: 8002 });
    expect(r.json()).toMatchObject({ collection: { id: 900, name: 'Sternwarte 24 – Die Reihe' } });
  });
});

describe('POST /api/requests/batch', () => {
  it('requests each part on its own, in order; one audit entry per request; per-movie results', async () => {
    const before = posts().length;
    const r = await batch(admin, [8002, 8008]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results).toEqual([
      { tmdbId: 8002, result: 'requested', status: 'angefragt' },
      { tmdbId: 8008, result: 'requested', status: 'angefragt' },
    ]);
    expect(posts().slice(before).map((p) => p.body.mediaId)).toEqual([8002, 8008]);
    expect(Number((await env.pool.query("select count(*) n from audit_log where action = 'request.create'")).rows[0].n)).toBeGreaterThanOrEqual(2);
    expect((await env.pool.query('select tmdb_id from seerr_requests order by id')).rows.map((x) => x.tmdb_id)).toEqual([8002, 8008]);
  });
  it('the quota stops it part-way: what went through and what did not', async () => {
    const before = posts().length;
    const r = await batch(friend, [8002, 8008, 8004]);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.results.map((x: any) => [x.tmdbId, x.result])).toEqual([[8002, 'requested'], [8008, 'requested'], [8004, 'limit']]);
    expect(posts()).toHaveLength(before + 2);
    expect(b.quota).toMatchObject({ limit: 2, used: 2, remaining: 0 });
    expect(typeof b.quota.resetsAt).toBe('string');
  });
  it('already requested parts and upstream failures do not stop the rest', async () => {
    failing.add(8002);
    const r = await batch(admin, [8003, 8002, 8008, 8001]);
    expect(r.json().results.map((x: any) => [x.tmdbId, x.result])).toEqual([[8003, 'exists'], [8002, 'failed'], [8008, 'requested'], [8001, 'exists']]);
    expect((await env.pool.query('select count(*) n from request_reservations')).rows[0].n).toBe('0'); // failures release their slot
  });
  it('a request with the collection id clears the cached collection', async () => {
    await call(friend, 'GET', '/api/seerr/movie/8001/collection');
    const n = upstream('/api/v1/collection/900');
    await batch(admin, [8008], { collectionId: 900 });
    await call(friend, 'GET', '/api/seerr/movie/8001/collection');
    expect(upstream('/api/v1/collection/900')).toBe(n + 1);
  });
  it('validation: movies only, 1 to 30 distinct ids, positive integers', async () => {
    const bad = [
      { items: [] },
      { items: Array.from({ length: 31 }, (_, i) => ({ mediaType: 'movie', tmdbId: 10_000 + i })) },
      { items: [{ mediaType: 'movie', tmdbId: 8002 }, { mediaType: 'movie', tmdbId: 8002 }] },
      { items: [{ mediaType: 'tv', tmdbId: 7002 }] },
      { items: [{ mediaType: 'movie', tmdbId: -4 }] },
      { items: [{ mediaType: 'movie', tmdbId: 8002 }], collectionId: 'x' },
    ];
    const before = posts().length;
    for (const body of bad) expect((await call(admin, 'POST', '/api/requests/batch', body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect(posts()).toHaveLength(before);
  });
  it('needs the CSRF token and a grown-up profile', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/requests/batch', cookies: admin.cookies, payload: { items: [{ mediaType: 'movie', tmdbId: 8002 }] } });
    expect(r.statusCode).toBe(403);
    const p = await call(admin, 'POST', '/api/profiles', { name: 'Mia', kids: true });
    expect(p.statusCode, p.body).toBe(201);
    const sel = await call(admin, 'POST', `/api/profiles/${p.json().profile.id}/select`, {});
    const k = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: admin.csrf };
    for (const [m, u, b] of [['POST', '/api/requests/batch', { items: [{ mediaType: 'movie', tmdbId: 8002 }] }], ['GET', '/api/seerr/movie/8001/collection'], ['GET', '/api/seerr/tv/7001/seasons']] as const) {
      const x = await call(k, m, u, b);
      expect([x.statusCode, x.json().error], u).toEqual([403, 'kids_profile']);
    }
  });
});
