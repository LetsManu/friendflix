// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newEpisodes } from '../src/newpage.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';
import { MemoryKV } from '../src/kv.js';
import { plexEnv, identity, type PlexEnv } from './plex/setup.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const hex = (n: number) => n.toString(16).padStart(32, '0');
const [S_WATCHED, S_LISTED, S_STRANGER, S_OLD, S_HIDDEN, S_KIDS_ONLY_ADULT] = [hex(1), hex(2), hex(3), hex(4), hex(5), hex(6)];
const NAMES: Record<string, string> = { [S_WATCHED]: 'Watched Show', [S_LISTED]: 'Listed Show', [S_STRANGER]: 'Stranger Show', [S_OLD]: 'Old Show', [S_HIDDEN]: 'Hidden Show', [S_KIDS_ONLY_ADULT]: 'Adult Show' };

interface Ep { id: string; series: string; season: number; ep: number; name: string; added: string }
let eps: Ep[] = [];
const played = new Set<string>(); // series ids with a played episode (for every viewer)
const hiddenFrom = new Map<string, Set<string>>(); // jellyfin user id -> series ids that user may not see
const wire = (e: Ep) => ({ Id: e.id, Name: e.name, Type: 'Episode', SeriesId: e.series, SeriesName: NAMES[e.series], ParentIndexNumber: e.season, IndexNumber: e.ep, DateCreated: e.added, UserData: {} });
const seen = (u: URL, series: string) => !hiddenFrom.get(u.searchParams.get('userId') ?? '')?.has(series);

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const clearCache = async () => { for (const k of await env.kv.keys('newep:')) await env.kv.del(k); };
const get = (url = '/api/library/new-episodes', cookies = s.cookies) => env.app.inject({ url, cookies });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const types = u.searchParams.get('includeItemTypes') ?? '';
      if (u.searchParams.get('filters') === 'IsPlayed' && u.searchParams.get('parentId')) {
        const sid = u.searchParams.get('parentId')!;
        return { json: { Items: played.has(sid) && seen(u, sid) ? [{ Id: hex(900), Name: 'x', Type: 'Episode', SeriesId: sid, UserData: { Played: true } }] : [], TotalRecordCount: 1 } };
      }
      if (types === 'Movie,Episode') {
        const start = Number(u.searchParams.get('startIndex') ?? 0);
        const all = eps.filter((e) => seen(u, e.series)).sort((a, b) => b.added.localeCompare(a.added));
        return { json: { Items: all.slice(start, start + Number(u.searchParams.get('limit') ?? 200)).map(wire) } };
      }
      return { json: { Items: [], TotalRecordCount: 0 } };
    },
  });
  s = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await clearCache();
  await env.pool.query('delete from watchlist');
  played.clear();
  hiddenFrom.clear();
  eps = [
    { id: hex(101), series: S_WATCHED, season: 2, ep: 3, name: 'Drei', added: ago(1) },
    { id: hex(102), series: S_WATCHED, season: 2, ep: 4, name: 'Vier', added: ago(1) }, // same batch: the later episode wins
    { id: hex(103), series: S_WATCHED, season: 2, ep: 2, name: 'Zwei', added: ago(3) },
    { id: hex(111), series: S_LISTED, season: 1, ep: 7, name: 'Sieben', added: ago(0.5) },
    { id: hex(121), series: S_STRANGER, season: 1, ep: 1, name: 'Pilot', added: ago(0.2) },
    { id: hex(131), series: S_OLD, season: 1, ep: 9, name: 'Alt', added: ago(8) },
    { id: hex(141), series: S_HIDDEN, season: 1, ep: 1, name: 'Versteckt', added: ago(2) },
  ];
  played.add(S_WATCHED); played.add(S_OLD); played.add(S_HIDDEN);
  await env.pool.query('insert into watchlist(profile_id,user_id,item_id) select p.id, p.user_id, $1 from profiles p where p.is_owner', [S_LISTED]);
});

describe('GET /api/library/new-episodes (Jellyfin)', () => {
  it('lists followed series (watched or on the Merkliste) with a new episode, newest first, one entry per series', async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.windowDays).toBe(7);
    expect(body.items.map((i: { seriesId: string }) => i.seriesId)).toEqual([S_LISTED, S_WATCHED, S_HIDDEN]); // Stranger: not followed, Old: older than 7 days
    expect(body.items[1]).toMatchObject({ seriesId: S_WATCHED, seriesName: 'Watched Show', newCount: 3, episode: { id: hex(102), season: 2, episode: 4, name: 'Vier' } });
    expect(Date.parse(body.items[1].episode.addedAt)).toBeGreaterThan(Date.now() - 2 * DAY);
    expect(body.items[0].episode).toMatchObject({ season: 1, episode: 7, name: 'Sieben' });
  });

  it('answers an empty list when nothing is followed or nothing is new, and needs a session', async () => {
    played.clear();
    await env.pool.query('delete from watchlist');
    expect((await get()).json()).toEqual({ windowDays: 7, items: [] });
    eps = [];
    expect((await get()).json().items).toEqual([]);
    expect((await env.app.inject({ url: '/api/library/new-episodes' })).statusCode).toBe(401);
  });

  it('library permissions: a series the viewer cannot see never appears (scan and watched check use the viewer identity)', async () => {
    const jf = (await env.pool.query<{ j: string }>('select jellyfin_user_id j from users limit 1')).rows[0]!.j;
    hiddenFrom.set(jf, new Set([S_HIDDEN, S_LISTED]));
    expect((await get()).json().items.map((i: { seriesId: string }) => i.seriesId)).toEqual([S_WATCHED]);
  });

  it('kids profile: own identity, same rules (the age cap of its media-server user decides what it sees)', async () => {
    const k = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { name: 'Mia', kids: true, maxRating: 6 } });
    expect(k.statusCode).toBe(201);
    const pid = k.json().profile.id as string;
    const kidJf = (await env.pool.query<{ j: string }>('select jellyfin_user_id j from profiles where id=$1', [pid])).rows[0]!.j;
    hiddenFrom.set(kidJf, new Set([S_WATCHED])); // the cap hides it for the kid
    const sw = await env.app.inject({ method: 'POST', url: `/api/profiles/${pid}/select`, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: {} });
    const kid = { ff_sid: sw.cookies.find((c) => c.name === 'ff_sid')!.value };
    // the Merkliste is per profile: the kid has nothing on it, and the owner's Merkliste does not leak over
    const r = await get('/api/library/new-episodes', kid);
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((i: { seriesId: string }) => i.seriesId)).toEqual([S_HIDDEN]); // watched by the kid (played), not capped
    await env.pool.query('insert into watchlist(profile_id,user_id,item_id) values ($1, (select user_id from profiles where id=$1), $2)', [pid, S_STRANGER]);
    await clearCache();
    expect((await get('/api/library/new-episodes', kid)).json().items.map((i: { seriesId: string }) => i.seriesId)).toEqual([S_STRANGER, S_HIDDEN]);
    // back to the owner profile (the session switched), then the kids profile goes
    const owner = (await env.pool.query<{ id: string }>('select id from profiles where is_owner')).rows[0]!.id;
    const back = await env.app.inject({ method: 'POST', url: `/api/profiles/${owner}/select`, cookies: kid, headers: { 'x-csrf-token': s.csrf }, payload: {} });
    s = { cookies: { ff_sid: back.cookies.find((c) => c.name === 'ff_sid')?.value ?? kid.ff_sid }, csrf: s.csrf };
    await env.pool.query('delete from profiles where id=$1', [pid]);
  });

  it('is cached, but the Merkliste is read live and the response never carries a token', async () => {
    const first = await get();
    const calls = () => env.jfCalls.filter((c) => c.path === '/Items').length;
    const n = calls();
    await get();
    expect(calls()).toBe(n); // second answer from the cache
    await env.pool.query('insert into watchlist(profile_id,user_id,item_id) select p.id, p.user_id, $1 from profiles p where p.is_owner', [S_STRANGER]);
    const again = (await get()).json().items.map((i: { seriesId: string }) => i.seriesId);
    expect(again).toContain(S_STRANGER);
    expect(calls()).toBe(n);
    expect(first.body).not.toMatch(/tok-|adminkey|AccessToken/i);
  });

  it('does not depend on the request service: same answer after the admin removes it', async () => {
    const before = (await get()).json();
    await env.ctx.settings.save({ REQUESTS_URL: null }, null);
    try {
      expect(env.ctx.seerr).toBeNull();
      expect((await get()).json()).toEqual(before);
    } finally {
      await env.ctx.settings.save({ REQUESTS_URL: cfg.REQUESTS_URL }, null);
    }
  });

  it('bounded: at most 30 entries', async () => {
    eps = Array.from({ length: 45 }, (_, i) => ({ id: hex(1000 + i), series: hex(2000 + i), season: 1, ep: 1, name: `E${i}`, added: ago(1 + i / 100) }));
    for (const e of eps) played.add(e.series);
    const items = (await get()).json().items as Array<{ seriesId: string }>;
    expect(items).toHaveLength(30);
    expect(items[0]!.seriesId).toBe(hex(2000));
  });
});

describe('new episodes: bounded media-server work', () => {
  const user = { jellyfin_user_id: 'u-bound', id: 'u-bound' } as never;
  /** a stub seam: `total` series with one new episode each (newest first); counts the played-lookups and how many ran at once */
  const seam = (total: number, playedSeries = new Set<string>()) => {
    const st = { lookups: [] as string[], inFlight: 0, maxInFlight: 0 };
    const jf = {
      userDataVersion: async () => 1,
      addedItems: async (_u: unknown, o: { start: number; limit: number }) => Array.from({ length: total }, (_, i) => ({
        id: hex(5000 + i), name: `E${i}`, type: 'Episode', seriesId: hex(6000 + i), seriesName: `S${i}`, parentIndexNumber: 1, indexNumber: 1,
        dateCreated: ago(1 + i / 1000), image: false,
      })).slice(o.start, o.start + o.limit),
      items: async (_u: unknown, o: { parentId: string }) => {
        st.lookups.push(o.parentId);
        st.maxInFlight = Math.max(st.maxInFlight, ++st.inFlight);
        await new Promise((r) => setTimeout(r, 2));
        st.inFlight--;
        return { items: playedSeries.has(o.parentId) ? [{ id: 'x' }] : [], total: 0 };
      },
    };
    return { st, ctx: { db: env.pool, kv: new MemoryKV(), jf: jf as never } };
  };
  const owner = async () => (await env.pool.query<{ id: string }>('select id from profiles where is_owner')).rows[0]!.id;

  it('at most 60 lookups, at most 4 at a time, and the cap never cuts a Merkliste show beyond it', async () => {
    const pid = await owner();
    const listedSeries = hex(6000 + 150); // far beyond the 60 newest
    await env.pool.query('delete from watchlist');
    await env.pool.query('insert into watchlist(profile_id,user_id,item_id) select p.id, p.user_id, $1 from profiles p where p.is_owner', [listedSeries]);
    const watched = new Set([hex(6000), hex(6059), hex(6060), hex(6100)]); // 6060 and 6100 are past the cap: never looked up
    const { st, ctx } = seam(200, watched);
    const out = await newEpisodes(ctx, user, pid);
    expect(st.lookups.length).toBe(60);
    expect(st.lookups).not.toContain(listedSeries); // the Merkliste needs no media-server call
    expect(st.maxInFlight).toBeLessThanOrEqual(4);
    expect(out.map((e) => e.seriesId)).toEqual([hex(6000), hex(6059), listedSeries]); // newest first
    const n = st.lookups.length;
    await newEpisodes(ctx, user, pid);
    expect(st.lookups.length).toBe(n); // second answer from the cache
  });

  it('a Merkliste show that is taken off the list disappears from the cached answer, without a new lookup', async () => {
    const pid = await owner();
    const listedSeries = hex(6003);
    await env.pool.query('delete from watchlist');
    await env.pool.query('insert into watchlist(profile_id,user_id,item_id) select p.id, p.user_id, $1 from profiles p where p.is_owner', [listedSeries]);
    const { st, ctx } = seam(10);
    expect((await newEpisodes(ctx, user, pid)).map((e) => e.seriesId)).toEqual([listedSeries]);
    const n = st.lookups.length;
    expect(n).toBe(9); // the other nine were looked up, the listed one was not
    await env.pool.query('delete from watchlist');
    expect(await newEpisodes(ctx, user, pid)).toEqual([]);
    expect(st.lookups.length).toBe(n);
  });
});

describe('new episodes on the Plex path', () => {
  let p: PlexEnv;
  beforeAll(async () => { p = await plexEnv(); });
  afterAll(() => p.close());

  it('uses the same seam: watched shows only, viewer-scoped rows, same entry shape', async () => {
    const u = await identity(p.ms, 'admin');
    const ctx = { db: p.pool, kv: p.kv, jf: p.ms };
    const epRows = (await p.ms.addedItems(u, { start: 0, limit: 50 })).filter((i) => i.type === 'Episode');
    expect(epRows.length).toBeGreaterThan(0); // the fixture episodes arrived a day ago
    expect(await newEpisodes(ctx, u, hex(77))).toEqual([]); // nothing watched, nothing listed
    const target = epRows[0]!;
    await p.ms.setPlayed(u, target.id, true);
    const out = await newEpisodes({ ...ctx, kv: new MemoryKV() }, u, hex(77));
    expect(out.map((e) => e.seriesId)).toEqual([target.seriesId]);
    expect(out[0]!.episode).toMatchObject({ season: expect.any(Number), episode: expect.any(Number), name: expect.any(String) });
  });
});
