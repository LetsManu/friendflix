// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feed, FeedCounts, FeedGroup } from '../src/notifications/feed.js';
import { notesRetentionTick } from '../src/notifications/retention.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
type Sess = { cookies: Record<string, string>; csrf: string };
let anna: Sess;
let ben: Sess;
let ua: string;
let ub: string;

beforeAll(async () => {
  env = await makeEnv();
  anna = await env.login({ ...ADMIN, name: 'Anna Beispiel' });
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Ben Muster','friend','jfb','ben','x')");
  ben = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Ben Muster', groups: [] });
  const ids = (await env.pool.query<{ id: string; name: string }>('select id, name from users')).rows;
  ua = ids.find((u) => u.name === 'Anna Beispiel')!.id;
  ub = ids.find((u) => u.name === 'Ben Muster')!.id;
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from notifications');
  await env.pool.query('update users set notifications_read_at = null');
});
afterEach(() => vi.useRealTimers());

const call = (s: Sess, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });

interface Row { user?: string | null; kind?: string; title?: string; at?: Date; key?: string | null; read?: boolean; hidden?: boolean }
/** Inserts rows (user: Anna unless given; at: now; key: `<kind>|<title>` unless given). Returns their ids. */
async function seed(rows: Row[]): Promise<number[]> {
  const ids: number[] = [];
  for (const r of rows) {
    const kind = r.kind ?? 'tv_paired';
    const title = r.title ?? 'Ein Fernseher wurde verbunden';
    const at = r.at ?? new Date();
    const res = await env.pool.query<{ id: string }>(
      `insert into notifications(user_id, kind, title, group_key, created_at, read_at, hidden_at) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [r.user === undefined ? ua : r.user, kind, title, r.key === undefined ? `${kind}|${title}` : r.key, at, r.read ? at : null, r.hidden ? at : null],
    );
    ids.push(Number(res.rows[0]!.id));
  }
  return ids;
}
/** `n` rows of one tv group, a second apart, the newest now. */
const tvGroup = (n: number, user: string | null = ua) =>
  seed(Array.from({ length: n }, (_, i) => ({ user, title: `Fernseher ${i + 1}`, key: 'tv_paired|tv.paired', at: new Date(Date.now() - (n - i) * 1000) })));

const feedOf = async (s: Sess, filter = 'all'): Promise<Feed> => {
  const r = await call(s, 'GET', `/api/notifications/feed?filter=${filter}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const groupsOf = async (s: Sess, filter = 'all'): Promise<FeedGroup[]> => (await feedOf(s, filter)).sections.flatMap((x) => x.groups);
const countsOf = async (s: Sess): Promise<FeedCounts> => (await call(s, 'GET', '/api/notifications/feed?limit=0')).json();
const tvGroupOf = async (s: Sess) => (await groupsOf(s)).find((g) => g.kind === 'tv_paired');
const legacy = async (s: Sess): Promise<Array<Record<string, unknown>>> => (await call(s, 'GET', '/api/notifications')).json().notifications;

describe('read, hide and undo', () => {
  it('reading one group of 25 marks all 25', async () => {
    await tvGroup(25);
    await seed([{ kind: 'download_ready', title: 'Fertig' }, { kind: 'achievement', title: 'Erfolg' }]);
    expect((await countsOf(anna)).unread).toBe(27);
    const g = (await tvGroupOf(anna))!;
    expect(g.count).toBe(25);
    expect(g.items).toHaveLength(20); // the group reads all 25 rows, not only the listed items
    const r = await call(anna, 'POST', '/api/notifications/read', { groups: [g.id] });
    expect(r.statusCode, r.body).toBe(200);
    expect((await countsOf(anna)).unread).toBe(2);
    expect((await tvGroupOf(anna))!.unread).toBe(false);
    expect((await env.pool.query("select count(*)::int n from notifications where kind = 'tv_paired' and read_at is null")).rows[0].n).toBe(0);
  });

  it('hide and undo a 25-row group', async () => {
    await tvGroup(25);
    const g = (await tvGroupOf(anna))!;
    const r = await call(anna, 'POST', '/api/notifications/hide', { groups: [g.id] });
    expect(r.statusCode, r.body).toBe(200);
    const { undo, n } = r.json();
    expect(n).toBe(25);
    expect(undo).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 random bytes, base64url
    expect(await tvGroupOf(anna)).toBeUndefined();
    expect((await countsOf(anna)).unread).toBe(0);
    const u = await call(anna, 'POST', '/api/notifications/unhide', { token: undo });
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json()).toEqual({ n: 25 });
    const back = (await tvGroupOf(anna))!;
    expect(back.count).toBe(25);
    expect(back.unread).toBe(true);
  });

  it('a row of the same key that arrives after the page was loaded is neither read nor hidden', async () => {
    await tvGroup(3);
    const g = (await tvGroupOf(anna))!;
    const [late] = await seed([{ title: 'Fernseher spät', key: 'tv_paired|tv.paired' }]);
    expect((await call(anna, 'POST', '/api/notifications/read', { groups: [g.id] })).statusCode).toBe(200);
    expect((await env.pool.query('select read_at from notifications where id = $1', [late])).rows[0].read_at).toBeNull();
    expect((await countsOf(anna)).unread).toBe(1);
    const h = await call(anna, 'POST', '/api/notifications/hide', { groups: [g.id] });
    expect(h.json().n).toBe(3);
    const now = (await tvGroupOf(anna))!;
    expect(now.count).toBe(1);
    expect(now.title).toBe('Fernseher spät');
  });

  it('a broadcast cleared by Anna stays for Ben', async () => {
    const [b1, b2] = await seed([
      { user: null, kind: 'available_all', title: 'Neu: Hafenkanal' },
      { user: null, kind: 'available_all', title: 'Neu: Sternwarte 24' },
    ]);
    const h = await call(anna, 'POST', '/api/notifications/hide', { ids: [b1] });
    expect(h.json().n).toBe(1);
    expect((await groupsOf(anna)).map((x) => x.title)).toEqual(['Neu: Sternwarte 24']);
    const forBen = await groupsOf(ben);
    expect(forBen.map((x) => [x.title, x.unread])).toEqual([['Neu: Sternwarte 24', true], ['Neu: Hafenkanal', true]]);
    expect((await call(anna, 'POST', '/api/notifications/read', { ids: [b2] })).statusCode).toBe(200);
    expect((await groupsOf(anna))[0]!.unread).toBe(false);
    expect((await legacy(anna)).find((x) => x.id === b2)!.read).toBe(true);
    expect((await groupsOf(ben)).every((x) => x.unread)).toBe(true);
    expect((await legacy(ben)).map((x) => x.read)).toEqual([false, false]);
    // the broadcast rows themselves are never touched
    const rows = (await env.pool.query('select read_at, hidden_at from notifications where id = any($1::bigint[])', [[b1, b2]])).rows;
    expect(rows.every((x) => x.read_at === null && x.hidden_at === null)).toBe(true);
    expect((await env.pool.query('select user_id from notification_state')).rows.every((x) => x.user_id === ua)).toBe(true);
  });

  it('clear by category and unread', async () => {
    await seed([
      { kind: 'tv_paired', title: 'Fernseher' },
      { kind: 'device_pending', title: 'Neues Gerät' },
      { kind: 'download_ready', title: 'Fertig' },
      { kind: 'achievement', title: 'Erfolg gelesen', read: true },
      { kind: 'achievement', title: 'Erfolg neu' },
      { user: null, kind: 'available_all', title: 'Neu: Nordlicht' },
      { user: ub, kind: 'tv_paired', title: 'Bens Fernseher' },
    ]);
    const titles = async (s: Sess) => (await groupsOf(s)).map((x) => x.title).sort();
    const hide = (body: unknown) => call(anna, 'POST', '/api/notifications/hide', body);
    expect((await hide({ category: 'devices' })).json().n).toBe(2);
    expect(await titles(anna)).toEqual(['Erfolg gelesen', 'Erfolg neu', 'Fertig', 'Neu: Nordlicht']);
    expect((await hide({ category: 'unread' })).json().n).toBe(3);
    expect(await titles(anna)).toEqual(['Erfolg gelesen']);
    expect((await hide({ category: 'all' })).json().n).toBe(1);
    expect(await titles(anna)).toEqual([]);
    for (const bad of [{}, { category: 'nope' }, { ids: [1], extra: true }, { ids: Array.from({ length: 201 }, (_, i) => i + 1) }]) {
      const r = await hide(bad);
      expect([r.statusCode, r.json().error], JSON.stringify(bad).slice(0, 40)).toEqual([400, 'invalid_body']);
    }
    expect((await call(anna, 'POST', '/api/notifications/hide')).statusCode).toBe(400);
    // Ben's own row and the broadcast stay for him
    expect(await titles(ben)).toEqual(['Bens Fernseher', 'Neu: Nordlicht']);
  });

  it('undo expires', async () => {
    const [id1, id2] = await seed([{ title: 'Eins' }, { title: 'Zwei', kind: 'achievement' }]);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const t1 = (await call(anna, 'POST', '/api/notifications/hide', { ids: [id1] })).json().undo;
    vi.setSystemTime(Date.now() + 31_000);
    const r = await call(anna, 'POST', '/api/notifications/unhide', { token: t1 });
    expect([r.statusCode, r.json().error]).toEqual([404, 'undo_expired']);
    const t2 = (await call(anna, 'POST', '/api/notifications/hide', { ids: [id2] })).json().undo;
    expect((await call(anna, 'POST', '/api/notifications/unhide', { token: t2 })).json()).toEqual({ n: 1 });
    const again = await call(anna, 'POST', '/api/notifications/unhide', { token: t2 });
    expect([again.statusCode, again.json().error]).toEqual([404, 'undo_expired']);
    expect((await call(anna, 'POST', '/api/notifications/unhide', { token: 'x'.repeat(22) })).statusCode).toBe(404);
    expect((await call(anna, 'POST', '/api/notifications/unhide', {})).statusCode).toBe(400);
    // Ben cannot undo Anna's clear
    const t3 = (await call(anna, 'POST', '/api/notifications/hide', { ids: [id2] })).json().undo;
    expect((await call(ben, 'POST', '/api/notifications/unhide', { token: t3 })).json()).toEqual({ n: 0 });
    expect((await groupsOf(anna)).map((x) => x.title)).toEqual([]);
  });

  it("another person's group id is refused", async () => {
    await tvGroup(2);
    const g = (await tvGroupOf(anna))!;
    for (const path of ['/api/notifications/read', '/api/notifications/hide']) {
      for (const body of [{ groups: [g.id] }, { groups: [`${g.id}x`] }, { groups: ['kaputt'] }]) {
        const r = await call(ben, 'POST', path, body);
        expect([r.statusCode, r.json().error], path).toEqual([400, 'invalid_group']);
      }
    }
    expect((await call(anna, 'POST', '/api/notifications/read', { groups: Array.from({ length: 51 }, () => g.id) })).statusCode).toBe(400);
    expect((await tvGroupOf(anna))!.unread).toBe(true);
  });

  it('POST /read without a body keeps today\'s behaviour', async () => {
    await seed([{ title: 'Eins' }, { title: 'Zwei', kind: 'achievement' }, { user: null, kind: 'available_all', title: 'Neu: Nordlicht' }, { user: ub, title: 'Bens' }]);
    const r = await call(anna, 'POST', '/api/notifications/read');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect((await env.pool.query('select notifications_read_at from users where id = $1', [ua])).rows[0].notifications_read_at).not.toBeNull();
    expect((await env.pool.query('select count(*)::int n from notifications where user_id = $1 and read_at is null', [ua])).rows[0].n).toBe(0);
    expect((await legacy(anna)).every((x) => x.read === true)).toBe(true);
    expect((await countsOf(anna)).unread).toBe(0);
    // Ben's are untouched, and no state rows are written for the watermark
    expect((await countsOf(ben)).unread).toBe(2);
    expect((await env.pool.query('select count(*)::int n from notification_state')).rows[0].n).toBe(0);
  });

  it('the legacy list keeps its shape for the Android poller', async () => {
    const base = Date.now() - 3600_000;
    const ids = await seed(Array.from({ length: 32 }, (_, i) => ({ title: `Eintrag ${i}`, kind: 'achievement', at: new Date(base + i * 60_000) })));
    const [hidden] = await seed([{ title: 'Versteckt', kind: 'achievement', at: new Date(base + 40 * 60_000), hidden: true }]);
    const [bc] = await seed([{ user: null, kind: 'available_all', title: 'Neu: Sternwarte 24', at: new Date(base + 35 * 60_000) }]);
    await env.pool.query('update users set notifications_read_at = $2 where id = $1', [ua, new Date(base - 60_000)]); // watermark below the broadcast
    expect((await call(anna, 'POST', '/api/notifications/read', { ids: [bc] })).statusCode).toBe(200);
    const list = await legacy(anna);
    expect(list).toHaveLength(30);
    for (const x of list) {
      expect(Object.keys(x).sort()).toEqual(['body', 'created_at', 'id', 'kind', 'link', 'read', 'title']);
      expect(typeof x.id).toBe('number');
    }
    const times = list.map((x) => Date.parse(String(x.created_at)));
    expect([...times].sort((p, q) => q - p)).toEqual(times);
    expect(list.some((x) => x.id === hidden)).toBe(false);
    expect(list[0]).toMatchObject({ id: bc, kind: 'available_all', read: true });
    expect(list[1]).toMatchObject({ id: ids[31], read: false });
    // Ben: the broadcast is still unread
    expect((await legacy(ben)).find((x) => x.id === bc)!.read).toBe(false);
  });
});

describe('retention', () => {
  it('retention deletes rows older than 90 days once a day', async () => {
    const now = new Date();
    const day = 86_400_000;
    const [old, recent, oldBc] = await seed([
      { title: 'Alt', at: new Date(now.getTime() - 91 * day) },
      { title: 'Jünger', at: new Date(now.getTime() - 89 * day) },
      { user: null, kind: 'available_all', title: 'Neu: Hafenkanal', at: new Date(now.getTime() - 91 * day) },
    ]);
    await env.pool.query('insert into notification_state(user_id, notification_id, read_at, hidden_at) values ($1, $2, now(), null), ($3, $2, null, now())', [ua, oldBc, ub]);
    const pad = (n: number) => String(n).padStart(2, '0');
    await env.kv.del(`notes:retention:${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
    expect(await notesRetentionTick(env.ctx, now)).toBe(2);
    const left = (await env.pool.query<{ id: string }>('select id from notifications')).rows.map((x) => Number(x.id));
    expect(left).toEqual([recent]);
    expect(left).not.toContain(old);
    expect((await env.pool.query('select count(*)::int n from notification_state')).rows[0].n).toBe(0);
    expect(await notesRetentionTick(env.ctx, now)).toBeNull();
  });
});
