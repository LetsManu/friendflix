import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const MOVIE = hex(1), EP = hex(2), SER = hex(3), HID = hex(4), HALF = hex(5);
let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const uid: Record<string, string> = {};
const url = (id: string) => `/api/items/${id}/reactions`;

async function mk(name: string, n: number, disabled = false) {
  uid[name] = (await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, disabled) values (gen_random_uuid(), $1, $2, $1, 'friend', $3, $1, $4, $5) returning id`,
    [name, `${name}@x.de`, hex(100 + n), encrypt(env.ctx.encKey, 'pw'), disabled],
  )).rows[0].id;
}
const react = (name: string, item: string, emoji: string, comment: string | null) =>
  env.pool.query('insert into reactions(user_id,item_id,emoji,comment) values ($1,$2,$3,$4)', [uid[name], item, emoji, comment]);
const get = (id: string) => env.app.inject({ url: url(id), cookies: s.cookies });
const put = (id: string, payload: object) => env.app.inject({ method: 'PUT', url: url(id), cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload });
const del = (id: string) => env.app.inject({ method: 'DELETE', url: url(id), cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/')[2]!;
      if (id === HID) return { status: 404 };
      const type = id === SER ? 'Series' : id === EP ? 'Episode' : 'Movie';
      const UserData = id === MOVIE ? { Played: false } : id === HALF ? { PlayedPercentage: 90 } : id === EP ? { Played: true } : {};
      return { json: { Id: id, Name: 'T', Type: type, UserData } };
    },
  });
  s = await env.login();
  uid.me = (await env.pool.query('select id from users limit 1')).rows[0].id;
  await mk('Lea', 1);
  await mk('Tom', 2);
  await mk('Gone', 3, true);
  await react('Lea', MOVIE, 'love', 'Geheimer Spoiler');
  await react('Gone', MOVIE, 'sad', 'weg');
  await react('Lea', EP, 'wow', 'Krass');
  await react('Tom', EP, 'funny', null);
  await react('Gone', EP, 'sad', 'unsichtbar');
});
afterAll(() => env.close());

describe('reactions', () => {
  it('locked while unwatched: only the count, nothing else leaks', async () => {
    const r = await get(MOVIE);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ locked: true }); // a single reaction would reveal who watched it
    expect(r.body).not.toContain('Lea');
    expect(r.body).not.toContain('Spoiler');
  });
  it('unlocked when played: summary and list, disabled users hidden', async () => {
    const r = await get(EP);
    const j = r.json();
    expect(j.locked).toBe(false);
    expect(j.count).toBe(2);
    expect(j.summary).toEqual({ like: 0, funny: 1, wow: 1, sad: 0, love: 0 });
    expect(j.reactions.map((x: any) => x.name).sort()).toEqual(['Lea', 'Tom']);
    expect(j.reactions.find((x: any) => x.name === 'Lea')).toMatchObject({ emoji: 'wow', comment: 'Krass', mine: false });
    expect(j.reactions.find((x: any) => x.name === 'Tom').comment).toBeUndefined();
    expect(r.body).not.toContain('unsichtbar');
  });
  it('>= 85 percent counts as watched', async () => {
    expect((await get(HALF)).json().locked).toBe(false);
  });
  it('PUT before watching is 403 watch_first', async () => {
    const r = await put(MOVIE, { emoji: 'like' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('watch_first');
  });
  it('PUT upserts and DELETE removes own reaction', async () => {
    let j = (await put(EP, { emoji: 'love', comment: '  Toll  ' })).json();
    expect(j.reactions.find((x: any) => x.mine)).toMatchObject({ name: 'Admin', emoji: 'love', comment: 'Toll' });
    expect(j.count).toBe(3);
    j = (await put(EP, { emoji: 'like' })).json();
    expect(j.count).toBe(3);
    expect(j.summary.like).toBe(1);
    expect(j.summary.love).toBe(0);
    expect(j.reactions.find((x: any) => x.mine).comment).toBeUndefined();
    j = (await del(EP)).json();
    expect(j.count).toBe(2);
    expect(j.reactions.some((x: any) => x.mine)).toBe(false);
  });
  it('404 for invisible items, 400 for series', async () => {
    expect((await get(HID)).statusCode).toBe(404);
    expect((await put(HID, { emoji: 'like' })).statusCode).toBe(404);
    const r = await get(SER);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('unsupported_type');
  });
  it('rejects too long comments and unknown emoji with 400', async () => {
    expect((await put(EP, { emoji: 'like', comment: 'x'.repeat(400) })).statusCode).toBe(400);
    expect((await put(EP, { emoji: 'poop' })).statusCode).toBe(400);
  });
});
