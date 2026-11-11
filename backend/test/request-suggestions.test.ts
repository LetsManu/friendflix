// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requestSuggestions, requestSuggestionsDetailed, SUGGEST_SEEDS } from '../src/requestSuggestions.js';
import { resetIndexCache } from '../src/reco/vectors.js';
import { DEFAULT_ROLES } from '../src/roles.js';
import { SeerrClient } from '../src/seerr/client.js';
import { buildIndex, engineCtx, fakeJf, H, seedProfiles, type Seeded } from './reco-fixture.js';
import { fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

// "Noch nicht bei uns": suggestions from the request service for the profile's seed titles. Function level on the fixture library, then the route.

const KEY = 'key-not-for-clients';
let future = '';
const rec = (id: number, o: Record<string, unknown> = {}) => ({ id, title: `Fiction ${id}`, releaseDate: '2019-05-01', posterPath: `/p${id}abcdef.jpg`, ...o });
let libraryIds = new Set<number>();
let certs: Record<number, string> = {};
let seerrCalls: Call[] = [];
let failSeed: number | null = null;
/** the media server's TMDB id per fixture key; a key without one has only a TVDB id (an anime library) */
let tmdbOf: Record<string, string | undefined> = {};
let searchHits: any[] = [];

const routes = (): Record<string, Handler> => ({
  'GET /api/v1/movie/1001/recommendations': () => (failSeed === 1001 ? { status: 500 } : { json: { totalPages: 1, results: [
    rec(11), rec(12, { mediaInfo: { status: 5 } }), rec(13, { adult: true }), rec(14, { releaseDate: future }), rec(15, { mediaInfo: { status: 2 } }), rec(16), rec(1001),
  ] } }),
  'GET /api/v1/tv/2002/recommendations': () => ({ json: { totalPages: 1, results: [{ id: 21, name: 'Serial Twentyone', firstAirDate: '2020-01-01', posterPath: '/s21abcdef.jpg', mediaInfo: { status: 3 } }, { id: 22, name: 'Serial Twentytwo' }] } }),
  'GET /api/v1/movie/3003/recommendations': () => ({ json: { totalPages: 1, results: [rec(31)] } }),
  'GET /api/v1/search': () => ({ json: { totalPages: 1, results: searchHits } }),
  'GET /api/v1/movie/\\d+': (u) => {
    const id = Number(u.pathname.split('/').pop());
    return { json: { title: `Fiction ${id}`, releases: { results: certs[id] ? [{ iso_3166_1: 'DE', release_dates: [{ certification: '' }, { certification: certs[id] }] }] : [] } } };
  },
});

describe('requestSuggestions (function level)', () => {
  let env: TestEnv;
  let s: Seeded;
  let jfx: ReturnType<typeof fakeJf>;
  beforeAll(async () => { env = await makeEnv(); s = await seedProfiles(env); await buildIndex(env); future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10); });
  afterAll(() => env.close());
  beforeEach(async () => {
    for (const t of ['thumbs', 'watchlist', 'dropped', 'ratings', 'play_seconds', 'seerr_requests']) await env.pool.query(`delete from ${t}`);
    for (const p of ['reco:', 'reqsug:', 'reqseed:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
    resetIndexCache(env.ctx);
    libraryIds = new Set([14]);
    certs = {}; seerrCalls = []; failSeed = null; jfx = fakeJf(); searchHits = [];
    tmdbOf = { bear1: '1001', pups: '2002' };
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,2,'x',$1)", [s.owner.user_id, H('bear1')]);
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,2,'x',$1)", [s.owner.user_id, H('pups')]);
  });

  const ctxFor = () => {
    const jf = Object.assign(Object.create(jfx.jf), {
      async itemAbout(_u: unknown, id: string) { return { providerIds: { tvdb: '555', tmdb: Object.entries(tmdbOf).find(([k]) => H(k) === id)?.[1] }, countries: [], studios: [], tags: [], type: 'x' }; },
      async findByTmdb(id: number) { return libraryIds.has(id) ? { id: 'lib', name: 'x' } : null; },
    });
    return { ...engineCtx(env, jf), seerr: new SeerrClient('http://requests.example.com', KEY, fakeHttp(routes(), seerrCalls)), roles: DEFAULT_ROLES };
  };
  const ask = (type: 'movie' | 'series' = 'movie', o: { role?: string; profile?: string } = {}) =>
    requestSuggestions(ctxFor(), s.user, { id: s.owner.user_id, role: o.role ?? 'friend' }, o.profile ?? s.owner.id, type);

  it('drops library titles, titles the service reports available, adult titles and the seed; shape, reason, proxied poster', async () => {
    const out = await ask();
    expect(out.map((i) => i.tmdbId)).toEqual([11, 15, 16]); // 12 available, 13 adult, 14 in the library, 1001 is the seed
    expect(out[0]).toEqual({ tmdbId: 11, mediaType: 'movie', title: 'Fiction 11', year: 2019, poster: '/api/seerr/image/p11abcdef.jpg', reason: { seed: 'BEAR1' }, request: { state: 'none' } });
    expect(out[1]!.request.state).toBe('requested'); // the service already has a pending request
    expect(JSON.stringify(out)).not.toContain('http');
  });

  it('series: the series seed, mediaType tv, processing state, no film seed involved', async () => {
    const out = await ask('series');
    expect(out).toEqual([
      { tmdbId: 21, mediaType: 'tv', title: 'Serial Twentyone', year: 2020, poster: '/api/seerr/image/s21abcdef.jpg', reason: { seed: 'PUPS' }, request: { state: 'processing' } },
      { tmdbId: 22, mediaType: 'tv', title: 'Serial Twentytwo', year: null, poster: null, reason: { seed: 'PUPS' }, request: { state: 'none' } },
    ]);
    expect(seerrCalls.some((c) => c.path.includes('/movie/'))).toBe(false);
  });

  it('a release date in the future is reported', async () => {
    libraryIds = new Set();
    expect((await ask()).find((i) => i.tmdbId === 14)).toMatchObject({ releaseDate: future });
  });

  it('is bounded: a few seeds, one recommendation call each, and cached for 6 hours per profile', async () => {
    await ask();
    const n = seerrCalls.length;
    expect(seerrCalls.filter((c) => c.path.endsWith('/recommendations')).length).toBeLessThanOrEqual(SUGGEST_SEEDS);
    await ask();
    expect(seerrCalls.length).toBe(n); // from the cache
    expect(await env.kv.keys('reqsug:')).toEqual([`reqsug:${s.owner.id}:movie:x:de`]);
    await ask('movie', { profile: s.kids.id }); // another profile: its own key, its own calls
    expect((await env.kv.keys('reqsug:')).sort()).toEqual([`reqsug:${s.kids.id}:movie:x:de`, `reqsug:${s.owner.id}:movie:x:de`].sort());
  });

  it('the wish state follows the account\'s own requests even from the cache', async () => {
    expect((await ask())[0]!.request.state).toBe('none');
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title) values (7,$1,'movie',11,'Fiction 11')", [s.owner.user_id]);
    const n = seerrCalls.length;
    expect((await ask())[0]!.request.state).toBe('requested');
    expect(seerrCalls.length).toBe(n);
  });

  it('a request that was declined or deleted before the list was built does not show as requested; one made after the build does', async () => {
    await ask(); // builds the list
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title,created_at) values (8,$1,'movie',11,'Fiction 11', now() - interval '1 day')", [s.owner.user_id]);
    expect((await ask())[0]!.request.state).toBe('none');
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title) values (9,$1,'movie',11,'Fiction 11')", [s.owner.user_id]);
    expect((await ask())[0]!.request.state).toBe('requested');
  });

  it('titles are asked for in the profile language, cached per language, and an unknown stored language falls back to German', async () => {
    const langs = () => seerrCalls.filter((c) => c.path.endsWith('/recommendations')).map((c) => new URLSearchParams(c.search).get('language'));
    await ask();
    expect(langs()).toEqual(['de']);
    await env.pool.query(`insert into profile_prefs(profile_id, data) values ($1, '{"language":"en"}') on conflict (profile_id) do update set data = profile_prefs.data || excluded.data`, [s.owner.id]);
    seerrCalls.length = 0;
    await ask();
    expect(langs()).toEqual(['en']); // not served from the German cache entry
    expect((await env.kv.keys('reqsug:')).sort()).toEqual([`reqsug:${s.owner.id}:movie:x:de`, `reqsug:${s.owner.id}:movie:x:en`]);
    await env.pool.query(`update profile_prefs set data = data || '{"language":"xx&evil=1"}' where profile_id=$1`, [s.owner.id]);
    for (const k of await env.kv.keys('reqsug:')) await env.kv.del(k);
    seerrCalls.length = 0;
    await ask();
    expect(langs()).toEqual(['de']);
    expect(seerrCalls.every((c) => !c.search.includes('evil'))).toBe(true);
  });

  it('age cap: a role with a cap only gets titles with a known rating within it; without a cap no rating lookup happens', async () => {
    certs = { 11: 'FSK 12', 15: 'FSK 16' }; // 16 has no entry: unrated
    const guest = await ask('movie', { role: 'guest' });
    expect(guest.map((i) => i.tmdbId)).toEqual([11]); // 15 too old, 16 unrated
    expect(seerrCalls.some((c) => /\/movie\/\d+$/.test(c.path))).toBe(true);
    seerrCalls.length = 0;
    expect((await ask('movie', { role: 'friend' })).map((i) => i.tmdbId)).toEqual([11, 15, 16]);
    expect(seerrCalls.some((c) => /\/movie\/\d+$/.test(c.path))).toBe(false);
    expect(await env.kv.keys('reqsug:')).toContain(`reqsug:${s.owner.id}:movie:12:de`); // the cap is part of the key
  });

  it('a series without a TMDB id (anime library: TVDB only) is found by name and year through the request service', async () => {
    tmdbOf = {};
    searchHits = [{ id: 9, mediaType: 'tv', name: 'Wrong', firstAirDate: '2021-01-01' }, { id: 2002, mediaType: 'tv', name: 'pups', firstAirDate: '2021-04-02' }];
    const out = await ask('series');
    expect(out.map((i) => i.tmdbId)).toEqual([21, 22]);
    expect(seerrCalls.filter((c) => c.path.endsWith('/search')).length).toBe(1);
    expect(await env.kv.get(`reqseed:tv:${H('pups')}`)).toBe('2002');
  });

  it('a name match with another first year or another media type is no seed; the miss is remembered', async () => {
    tmdbOf = {};
    searchHits = [{ id: 2002, mediaType: 'tv', name: 'Pups', firstAirDate: '2015-04-02' }, { id: 2003, mediaType: 'movie', title: 'Pups', releaseDate: '2021-01-01' }];
    expect(await ask('series')).toEqual([]);
    expect(seerrCalls.some((c) => c.path.endsWith('/recommendations'))).toBe(false);
    for (const k of await env.kv.keys('reqsug:')) await env.kv.del(k);
    seerrCalls.length = 0;
    await ask('series');
    expect(seerrCalls.some((c) => c.path.endsWith('/search'))).toBe(false); // not asked again for a day
  });

  it('looks past the first five anchors: the 8th strongest film is the only one with a TMDB id', async () => {
    await env.pool.query('delete from thumbs');
    const keys = ['saga1', 'saga2', 'saga3', 'orbit', 'mars', 'noir1', 'noir2', 'doc3'];
    for (const k of keys) await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,$3,'x',$1)", [s.owner.user_id, H(k), k === 'doc3' ? 1 : 2]);
    tmdbOf = { doc3: '3003' };
    expect((await ask()).map((i) => i.tmdbId)).toEqual([31]);
  });

  it('an empty list is cached for the short time only, a list with titles for the long one', async () => {
    const ttls: number[] = [];
    const realSet = env.kv.set.bind(env.kv);
    env.kv.set = async (k: string, v: string, ttl: number) => { if (k.startsWith('reqsug:')) ttls.push(ttl); return realSet(k, v, ttl); };
    try {
      tmdbOf = {};
      expect(await ask('series')).toEqual([]); // no seed at all (the search finds nothing)
      for (const k of await env.kv.keys('reqsug:')) await env.kv.del(k);
      tmdbOf = { pups: '2002' };
      expect((await ask('series')).length).toBe(2);
    } finally { env.kv.set = realSet; }
    expect(ttls).toEqual([120, 6 * 3600]);
  });

  it('counts of the build: anchors, seeds, seeds without a TMDB id, recommendations, library hits, age filter, final', async () => {
    libraryIds = new Set([14, 16]);
    tmdbOf = { bear1: '1001' };
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,1,'x',$1)", [s.owner.user_id, H('robot')]); // a second film anchor without a TMDB id
    const d = await requestSuggestionsDetailed(ctxFor(), s.user, { id: s.owner.user_id, role: 'friend' }, s.owner.id, 'movie');
    expect(d.fresh).toBe(true);
    expect(d.stats).toEqual({ anchors: 2, seeds: 1, seedsWithoutTmdb: 1, seedsFoundByName: 0, recommendations: 5, inLibrary: 2, lookupFailures: 0, ageFiltered: 0, final: 2 });
    expect((await requestSuggestionsDetailed(ctxFor(), s.user, { id: s.owner.user_id, role: 'friend' }, s.owner.id, 'movie')).fresh).toBe(false);
  });

  it('a failing seed does not fail the answer (short cache), no seeds means an empty list', async () => {
    failSeed = 1001;
    const ttls: number[] = [];
    const realSet = env.kv.set.bind(env.kv);
    env.kv.set = async (k: string, v: string, ttl: number) => { if (k.startsWith('reqsug:')) ttls.push(ttl); return realSet(k, v, ttl); };
    try { expect(await ask()).toEqual([]); } finally { env.kv.set = realSet; }
    expect(ttls).toEqual([120]); // the short cache, not the 6 hours
    await env.pool.query('delete from thumbs');
    for (const k of await env.kv.keys('reqsug:')) await env.kv.del(k);
    for (const k of await env.kv.keys('reco:')) await env.kv.del(k);
    expect(await ask()).toEqual([]);
  });
});

describe('GET /api/library/request-suggestions (route)', () => {
  let env: TestEnv;
  let sess: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => { env = await makeEnv({}, { seerr: routes() }); sess = await env.login(); });
  afterAll(() => env.close());
  const get = (url = '/api/library/request-suggestions?type=movie', cookies = sess.cookies) => env.app.inject({ url, cookies });

  it('needs a session and a valid type', async () => {
    expect((await env.app.inject({ url: '/api/library/request-suggestions' })).statusCode).toBe(401);
    expect((await get('/api/library/request-suggestions?type=anime')).statusCode).toBe(400);
  });

  it('quota passthrough: the limit, the use this month and the reset date of POST /api/requests, nothing else', async () => {
    const uid = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    await env.pool.query("update users set role='friend' where id=$1", [uid]);
    await env.pool.query("insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title) values (71,$1,'movie',5,'Fiction 5')", [uid]);
    const r = await get();
    expect(r.statusCode).toBe(200);
    const q = (await env.app.inject({ url: '/api/requests/quota', cookies: sess.cookies })).json();
    expect(r.json()).toEqual({ items: [], quota: { limit: q.limit, used: 1, resetsAt: q.resetsAt } });
    expect(q.limit).toBe(2);
    expect(r.body).not.toMatch(/key-|seerrkey|adminkey|AccessToken|requests:5055/i);
  });

  it('admins get the counts of the build as `debug`, other roles do not', async () => {
    const uid = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    await env.pool.query("update users set role='admin' where id=$1", [uid]);
    const a = (await get()).json();
    expect(Object.keys(a.debug).sort()).toEqual(['ageFiltered', 'anchors', 'final', 'inLibrary', 'lookupFailures', 'recommendations', 'seeds', 'seedsFoundByName', 'seedsWithoutTmdb']);
    await env.pool.query("update users set role='friend' where id=$1", [uid]);
    expect((await get()).json().debug).toBeUndefined();
  });

  it('kids profile: 403 kids_profile, no request-service call', async () => {
    const k = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: sess.cookies, headers: { 'x-csrf-token': sess.csrf }, payload: { name: 'Mia', kids: true } });
    const sw = await env.app.inject({ method: 'POST', url: `/api/profiles/${k.json().profile.id}/select`, cookies: sess.cookies, headers: { 'x-csrf-token': sess.csrf }, payload: {} });
    const kid = { ff_sid: sw.cookies.find((c) => c.name === 'ff_sid')!.value };
    const n = env.seerrCalls.length;
    const r = await get('/api/library/request-suggestions?type=movie', kid);
    expect([r.statusCode, r.json().error]).toEqual([403, 'kids_profile']);
    expect(env.seerrCalls.length).toBe(n);
    const owner = (await env.pool.query<{ id: string }>('select id from profiles where is_owner')).rows[0]!.id;
    const back = await env.app.inject({ method: 'POST', url: `/api/profiles/${owner}/select`, cookies: kid, headers: { 'x-csrf-token': sess.csrf }, payload: {} });
    sess = { ...sess, cookies: { ff_sid: back.cookies.find((c) => c.name === 'ff_sid')?.value ?? kid.ff_sid } };
  });

  it('no request service: 404 requests_disabled like every request route', async () => {
    await env.ctx.settings.save({ REQUESTS_URL: null }, null);
    try {
      const r = await get();
      expect([r.statusCode, r.json().error]).toEqual([404, 'requests_disabled']);
    } finally {
      await env.ctx.settings.save({ REQUESTS_URL: 'http://requests:5055' }, null);
    }
  });
});
