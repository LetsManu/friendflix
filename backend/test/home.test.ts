import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type Handler, type TestEnv } from './helpers.js';

// Task 7 (Block 20): GET /api/home serves the first screen of the home page in one request
const hex = (c: string) => c.repeat(32);
const A = hex('a'), B = hex('b'), C = hex('c');
const LIB = [
  { Id: A, Name: 'Bärenbande', Type: 'Movie', OfficialRating: 'FSK-0', v: 0, BackdropImageTags: ['t'] },
  { Id: B, Name: 'Abenteuerinsel', Type: 'Series', OfficialRating: 'FSK-12', v: 12, BackdropImageTags: ['t'] },
  { Id: C, Name: 'Nachtangst', Type: 'Movie', OfficialRating: 'FSK-16', v: 16, BackdropImageTags: ['t'] },
];
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let nextupStatus = 200;
let resumeIds = [A];

/** Jellyfin fake that enforces MaxParentalRating of the calling user's policy like the real server */
function jellyfin(): Record<string, Handler> {
  const ids = new Map<string, string>();
  const policy = new Map<string, Record<string, any>>();
  let n = 0;
  const who = (init: RequestInit) => ids.get(/Token="tok-([^"]+)"/.exec(String((init.headers as Record<string, string>)?.Authorization ?? ''))?.[1] ?? '');
  const allowed = (uid: string | undefined, i: (typeof LIB)[number]) => {
    const cap = uid ? policy.get(uid)?.MaxParentalRating : undefined;
    return cap === undefined || cap === null || i.v <= cap;
  };
  const dto = ({ v: _v, ...i }: (typeof LIB)[number]) => ({ ...i, UserData: { PlayedPercentage: 50, PlaybackPositionTicks: 5 } });
  const list = (ids_: string[] | undefined) => (_u: URL, init: RequestInit) => {
    const uid = who(init);
    const out = LIB.filter((i) => allowed(uid, i) && (!ids_ || ids_.includes(i.Id)));
    return { json: { Items: out.map(dto), TotalRecordCount: out.length } };
  };
  return {
    'POST /Users/New': (_u, _i, b) => { const id = `jf${String(++n).padStart(30, '0')}ab`; ids.set(b.Name, id); return { json: { Id: id, Name: b.Name } }; },
    'GET /Users/[^/]+': (u) => ({ json: { Policy: policy.get(u.pathname.split('/')[2]!) ?? { Keep: 'me' } } }),
    'POST /Users/[^/]+/Policy': (u, _i, b) => { policy.set(u.pathname.split('/')[2]!, b); return { status: 204 }; },
    'GET /Items': (u, init) => list(u.searchParams.get('ids')?.split(','))(u, init),
    'GET /Items/[^/]+/Similar': (u, init) => list(undefined)(u, init),
    'GET /Items/[^/]+': (u, init) => { const i = LIB.find((x) => x.Id === u.pathname.split('/')[2]); return i && allowed(who(init), i) ? { json: dto(i) } : { status: 404 }; },
    'GET /UserItems/Resume': (u, init) => list(resumeIds)(u, init),
    'GET /Shows/NextUp': (u, init) => (nextupStatus === 200 ? list([B])(u, init) : { status: nextupStatus }),
    'POST /UserPlayedItems/[^/]+': () => ({ json: {} }),
    'POST /Users/[^/]+/PlayedItems/[^/]+': () => ({ json: {} }),
    'GET /UserViews': () => ({ json: { Items: [] } }),
  };
}

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const home = (s: Sess) => call(s, 'GET', '/api/home');

beforeAll(async () => {
  env = await makeEnv(jellyfin());
  admin = await env.login();
  // a friend who recommended Abenteuerinsel and rated Nachtangst highly
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Bea','friend','jfbea','Bea',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  const bea = (await env.pool.query('select id from users where authentik_sub=$1', ['sub-b'])).rows[0].id;
  const me = (await env.pool.query('select id from users where authentik_sub=$1', ['sub-admin'])).rows[0].id;
  await env.pool.query('insert into recommendations(from_user,to_user,item_id,item_name) values ($1,$2,$3,$4)', [bea, me, B, 'Abenteuerinsel']);
  await env.pool.query('insert into ratings(user_id,item_id,item_name,stars) values ($1,$2,$3,5)', [bea, C, 'Nachtangst']);
  // a pinned themed list holding all three titles
  const id = (await call(admin, 'POST', '/api/lists', { name: 'Gruselabend', themed: true, emoji: '🎃' })).json().id;
  for (const i of [A, B, C]) await call(admin, 'POST', `/api/lists/${id}/items`, { itemId: i });
  await call(admin, 'PUT', `/api/lists/${id}/pin`, { pinned: true });
});
afterAll(() => env.close());

describe('GET /api/home', () => {
  it('401 without session', async () => {
    expect((await env.app.inject('/api/home')).statusCode).toBe(401);
  });

  it('parts present for a normal profile, same data as the single endpoints', async () => {
    const r = await home(admin);
    expect(r.statusCode).toBe(200);
    const { parts, failed } = r.json();
    expect(failed).toEqual([]);
    expect(Object.keys(parts).sort()).toEqual(['because', 'hero', 'hubs', 'leaving', 'nextup', 'recs', 'resume', 'themed']);
    expect(parts.hero.backdrop).toBe(true);
    expect(parts.resume.map((i: { id: string }) => i.id)).toEqual([A]);
    expect(parts.nextup.map((i: { id: string }) => i.id)).toEqual([B]);
    expect(parts.recs.items.map((i: { id: string }) => i.id)).toEqual([B]);
    expect(parts.recs.friends.map((i: { id: string }) => i.id)).toEqual([C]);
    expect(parts.themed).toHaveLength(1);
    expect(parts.themed[0].items).toHaveLength(3);
    // byte-identical to what the old endpoints answer
    expect(parts.resume).toEqual((await call(admin, 'GET', '/api/library/resume')).json().items);
    expect(parts.nextup).toEqual((await call(admin, 'GET', '/api/library/nextup')).json().items);
    expect(parts.recs).toEqual({ ...(await call(admin, 'GET', '/api/recommendations')).json(), friends: (await call(admin, 'GET', '/api/library/friends-rated')).json().items });
    expect(parts.because).toEqual({ ...(await call(admin, 'GET', '/api/library/because')).json(), more: (await call(admin, 'GET', '/api/library/because-more')).json().rows });
    expect(parts.hubs).toEqual((await call(admin, 'GET', '/api/hubs')).json().hubs);
    expect(parts.themed).toEqual((await call(admin, 'GET', '/api/lists/themed')).json().lists);
  });

  it('kids profile: no item above cap, no social/because-from-friends parts', async () => {
    const mk = await call(admin, 'POST', '/api/profiles', { name: 'Mia', kids: true, maxRating: 6 });
    expect(mk.statusCode, mk.body).toBe(201);
    const sel = await call(admin, 'POST', `/api/profiles/${mk.json().profile.id}/select`, {});
    const kid: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: admin.csrf };
    resumeIds = [A, B, C];
    const r = await home(kid);
    resumeIds = [A];
    const ownerId = (await env.pool.query('select id from profiles where is_owner and user_id=(select id from users where authentik_sub=$1)', ['sub-admin'])).rows[0].id;
    const back = await call(admin, 'POST', `/api/profiles/${ownerId}/select`, {});
    expect(back.statusCode, back.body).toBe(200); // the session is the same one: back to the owner profile for the next tests
    expect(r.statusCode).toBe(200);
    const { parts, failed } = r.json();
    expect(failed).toEqual([]);
    const text = JSON.stringify(parts);
    expect(text).not.toContain(B); // FSK-12 and FSK-16 stay out everywhere
    expect(text).not.toContain(C);
    expect(text).toContain(A);
    expect(parts.recs).toEqual({ items: [], recIds: [], friends: [] });
    expect(parts.themed[0].owner).toBeUndefined();
    expect(parts.themed[0].items.map((i: { id: string }) => i.id)).toEqual([A]);
  });

  it('one failing part → 200 with failed:[x], and the broken answer is not cached', async () => {
    const jfId = (await env.pool.query('select jellyfin_user_id j from users where authentik_sub=$1', ['sub-admin'])).rows[0].j;
    await env.ctx.jf.touchUserData(jfId); // fresh cache key (the earlier tests cached an answer)
    nextupStatus = 500;
    const r = await home(admin);
    expect(r.statusCode).toBe(200);
    expect(r.json().failed).toEqual(['nextup']);
    expect(r.json().parts.nextup).toEqual([]);
    expect(r.json().parts.resume).toHaveLength(1);
    nextupStatus = 200;
    expect((await home(admin)).json().failed).toEqual([]);
  });

  it('watched change bumps userDataVersion → fresh data; otherwise the answer is cached', async () => {
    const before = (await home(admin)).json().parts.resume.map((i: { id: string }) => i.id);
    expect(before).toEqual([A]);
    resumeIds = [A, B];
    expect((await home(admin)).json().parts.resume).toHaveLength(1); // still the cached answer
    expect((await call(admin, 'POST', `/api/items/${A}/played`)).statusCode).toBe(200); // bumps the user-data version
    expect((await home(admin)).json().parts.resume).toHaveLength(2);
  });
});
