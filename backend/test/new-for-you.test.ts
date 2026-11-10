// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { FOR_YOU_DAYS, newForYou } from '../src/newpage.js';
import { resetIndexCache } from '../src/reco/vectors.js';
import { buildIndex, DAY, engineCtx, fakeJf, H, keysOf, NOW, seedProfiles, type Seeded } from './reco-fixture.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// "Für dich neu": the v2 engine's fresh candidates, restricted to titles added within 14 days, with reasons, type filter, kids rules.
// Function level on the fixture library (pinned clock), then the real route.

describe('newForYou (engine level)', () => {
  let env: TestEnv;
  let s: Seeded;
  beforeAll(async () => { env = await makeEnv(); s = await seedProfiles(env); await buildIndex(env); });
  afterAll(() => env.close());
  beforeEach(async () => {
    for (const t of ['thumbs', 'watchlist', 'dropped', 'ratings', 'play_seconds', 'recommendations']) await env.pool.query(`delete from ${t}`);
    await env.pool.query("delete from users where authentik_sub like 'sub-fy-%'");
    for (const p of ['reco:', 'trend:', 'fresh:', 'newforyou:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
    resetIndexCache(env.ctx);
  });
  const ask = (f: ReturnType<typeof fakeJf>, o: { kids?: boolean; type?: 'movie' | 'series'; engine?: 'v1' | 'v2' } = {}) =>
    newForYou(engineCtx(env, f.jf, { RECO_ENGINE: o.engine ?? 'v2' }), o.kids ? s.kidsUser : s.user, o.kids ? s.kids.id : s.owner.id, o.type, NOW);

  it('lists only titles added within 14 days, ranked by the engine, each with a reason', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'pups', 'signal', 'rom2']; // 5 and 10 days; 20 and 450 days
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id,created_at) values ($1,$2,2,'x',$1,$3)", [s.owner.user_id, H('bear1'), new Date(NOW - 5 * DAY)]);
    const r = await ask(f);
    expect(r.engine).toBe('v2');
    expect(keysOf(r.items).sort()).toEqual(['hype', 'pups']);
    for (const i of r.items) {
      expect(i.reason).toEqual({ seed: expect.toSatisfy((x: unknown) => x === null || typeof x === 'object'), traits: expect.any(Array) });
      expect(Date.parse(i.dateCreated!)).toBeGreaterThan(NOW - FOR_YOU_DAYS * DAY);
    }
    // the profile loves the bears (Animation / Family): the new puppies series says why
    expect(r.items.find((i) => i.id === H('pups'))!.reason).toMatchObject({ seed: { name: 'BEAR1' } });
  });

  it('?type filter: movie keeps films, series keeps series', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'pups'];
    expect(keysOf((await ask(f, { type: 'movie' })).items)).toEqual(['hype']);
    expect(keysOf((await ask(f, { type: 'series' })).items)).toEqual(['pups']);
  });

  it('nothing new: an empty list', async () => {
    const f = fakeJf();
    f.state.recent = ['rom2', 'noir1'];
    expect(await ask(f)).toEqual({ engine: 'v2', items: [] });
    f.state.recent = [];
    expect(await ask(f)).toEqual({ engine: 'v2', items: [] });
  });

  it('titles the profile already finished or thumbed down are not offered', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'pups'];
    await env.pool.query("insert into thumbs(user_id,item_id,value,item_name,profile_id) values ($1,$2,-1,'x',$3)", [s.owner.user_id, H('hype'), s.owner.id]);
    expect(keysOf((await ask(f)).items)).toEqual(['pups']);
  });

  it('friends signal: a reason for the grown-up profile, never for a kids profile (social sources do not run)', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'pups'];
    const fid = (await env.pool.query<{ id: string }>(
      "insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-fy-1', 'fy@example.com', 'Fia', 'friend', 'jf-fy', 'Fia', $1) returning id", [encrypt(env.ctx.encKey, 'pw')])).rows[0]!.id;
    await env.pool.query("insert into ratings(user_id, item_id, item_name, stars) values ($1,$2,'x',5)", [fid, H('pups')]);
    const adult = (await ask(f)).items.find((i) => i.id === H('pups'))!;
    expect(adult.reason!.traits.some((t) => t.startsWith('friends'))).toBe(true);
    const kid = (await ask(f, { kids: true })).items.find((i) => i.id === H('pups'))!;
    expect(kid.reason!.traits.some((t) => t.startsWith('friends'))).toBe(false);
  });

  it('kids: the age cap applies (the media server hides FSK 12 from the kids identity)', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'pups'];
    f.state.caps['jfkid'] = 6;
    expect(keysOf((await ask(f, { kids: true })).items)).toEqual(['pups']);
  });

  it('is cached per profile (10 min), the type filter is applied after the cache', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'pups'];
    await ask(f);
    const n = f.calls.length;
    expect(keysOf((await ask(f, { type: 'movie' })).items)).toEqual(['hype']);
    expect(f.calls.length).toBe(n);
    expect((await env.kv.keys('newforyou:')).length).toBe(1);
  });

  it('engine v1: the newest titles of the window without reasons', async () => {
    const f = fakeJf();
    f.state.recent = ['hype', 'signal', 'pups'];
    const r = await ask(f, { engine: 'v1' });
    expect(r.engine).toBe('v1');
    expect(keysOf(r.items)).toEqual(['hype', 'pups']);
    expect(r.items.every((i) => i.reason === null)).toBe(true);
  });
});

describe('GET /api/library/new-for-you', () => {
  let env: TestEnv;
  let owner: { cookies: Record<string, string>; csrf: string };
  let fake: ReturnType<typeof fakeJf>;
  const shift = Date.now() - NOW; // the fixture dates are relative to a pinned clock; the route uses the real one
  const get = (url: string, cookies = owner.cookies) => env.app.inject({ url, cookies });

  beforeAll(async () => {
    env = await makeEnv();
    owner = await env.login();
    fake = fakeJf();
    const items = fake.jf.items.bind(fake.jf);
    Object.assign(env.ctx.jf, fake.jf, {
      items: async (...a: Parameters<typeof items>) => {
        const r = await items(...a);
        return { ...r, items: r.items.map((i) => ({ ...i, dateCreated: new Date(Date.parse(i.dateCreated!) + shift).toISOString() })) };
      },
    });
    await buildIndex(env);
    env.ctx.cfg = { ...cfg, RECO_ENGINE: 'v2' };
    fake.state.recent = ['hype', 'pups', 'rom2'];
  });
  afterAll(() => env.close());
  beforeEach(async () => { for (const k of await env.kv.keys('newforyou:')) await env.kv.del(k); });

  it('answers items with reasons, windowDays 14, and filters by type', async () => {
    const r = await get('/api/library/new-for-you');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect([b.engine, b.windowDays]).toEqual(['v2', 14]);
    expect(keysOf(b.items).sort()).toEqual(['hype', 'pups']);
    expect(b.items[0].reason).toHaveProperty('traits');
    expect(keysOf((await get('/api/library/new-for-you?type=series')).json().items)).toEqual(['pups']);
    expect(keysOf((await get('/api/library/new-for-you?type=movie')).json().items)).toEqual(['hype']);
  });

  it('rejects an unknown type and needs a session', async () => {
    expect((await get('/api/library/new-for-you?type=anime')).statusCode).toBe(400);
    expect((await env.app.inject({ url: '/api/library/new-for-you' })).statusCode).toBe(401);
  });

  it('a kids profile gets its own, capped answer with no friends reason', async () => {
    const k = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: owner.cookies, headers: { 'x-csrf-token': owner.csrf }, payload: { name: 'Mia', kids: true, maxRating: 6 } });
    expect(k.statusCode).toBe(201);
    const pid = k.json().profile.id as string;
    fake.state.caps[(await env.pool.query<{ j: string }>('select jellyfin_user_id j from profiles where id=$1', [pid])).rows[0]!.j] = 6;
    const sw = await env.app.inject({ method: 'POST', url: `/api/profiles/${pid}/select`, cookies: owner.cookies, headers: { 'x-csrf-token': owner.csrf }, payload: {} });
    const kid = { ff_sid: sw.cookies.find((c) => c.name === 'ff_sid')!.value };
    const r = await get('/api/library/new-for-you', kid);
    expect(r.statusCode).toBe(200);
    expect(keysOf(r.json().items)).toEqual(['pups']);
  });

  it('v1 engine: newest titles, reason null; the answer never carries a token', async () => {
    env.ctx.cfg = { ...cfg, RECO_ENGINE: 'v1' };
    try {
      const r = await get('/api/library/new-for-you');
      expect(r.json().engine).toBe('v1');
      expect(r.json().items.every((i: { reason: unknown }) => i.reason === null)).toBe(true);
      expect(r.body).not.toMatch(/tok-|adminkey|AccessToken/i);
    } finally {
      env.ctx.cfg = { ...cfg, RECO_ENGINE: 'v2' };
    }
  });

  it('does not depend on the request service: same answer without it', async () => {
    await env.ctx.settings.save({ REQUESTS_URL: null }, null);
    try {
      expect(env.ctx.seerr).toBeNull();
      expect((await get('/api/library/new-for-you')).statusCode).toBe(200);
    } finally {
      await env.ctx.settings.save({ REQUESTS_URL: cfg.REQUESTS_URL }, null);
    }
  });
});
