// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '../src/i18n.js';
import { localizeStored } from '../src/notify.js';
import { decodeCursor, feed, groupId, parseGroupId, type Feed } from '../src/notifications/feed.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
type Sess = { cookies: Record<string, string>; csrf: string };
let a: Sess;
let b: Sess;
let ua: string;
let ub: string;

beforeAll(async () => {
  env = await makeEnv();
  a = await env.login();
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-b','b@example.com','Ben Muster','friend','jfb','ben','x')");
  b = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Ben Muster', groups: [] });
  const ids = (await env.pool.query<{ id: string; name: string }>('select id, name from users')).rows;
  ua = ids.find((u) => u.name === 'Admin')!.id;
  ub = ids.find((u) => u.name === 'Ben Muster')!.id;
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from notifications');
  await env.pool.query('update users set notifications_read_at = null');
});
afterEach(() => vi.unstubAllEnvs());

const get = (s: Sess, url: string) => env.app.inject({ method: 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });

interface Row { user?: string | null; kind?: string; title?: string; at: string | Date; key?: string | null; body?: string | null; link?: string | null; msg?: unknown; read?: boolean; hidden?: boolean }
/** Inserts rows with explicit created_at (user: the admin unless given; key: `<kind>|<title>` unless given, null = no key). Returns their ids. */
async function seed(rows: Row[]): Promise<number[]> {
  const ids: number[] = [];
  for (const r of rows) {
    const kind = r.kind ?? 'tv_paired';
    const title = r.title ?? 'Ein Fernseher wurde verbunden';
    const res = await env.pool.query<{ id: string }>(
      `insert into notifications(user_id, kind, title, body, link, msg, group_key, created_at, read_at, hidden_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [r.user === undefined ? ua : r.user, kind, title, r.body ?? null, r.link ?? null, r.msg === undefined ? null : JSON.stringify(r.msg),
        r.key === undefined ? `${kind}|${title}` : r.key, r.at, r.read ? r.at : null, r.hidden ? r.at : null],
    );
    ids.push(Number(res.rows[0]!.id));
  }
  return ids;
}

const NOW = new Date('2026-11-17T04:30:00Z');
const opts = (o: Partial<Parameters<typeof feed>[3]> = {}) => ({ tz: 'Europe/Berlin', filter: 'all' as const, cursor: null, limit: 30, ...o });
const sectionOf = (f: Feed, title: string) => f.sections.find((s) => s.groups.some((g) => g.title === title))?.key;
const groups = (f: Feed) => f.sections.flatMap((s) => s.groups);
const minutesAgo = (n: number, from = NOW) => new Date(from.getTime() - n * 60_000);

describe('notifications feed', () => {
  it("sections follow the viewer's time zone", async () => {
    await seed([{ title: 'Früh', at: '2026-11-17T04:00:00Z' }, { title: 'Oktober', at: '2026-10-02T12:00:00Z' }, { title: 'Mitte', at: '2026-11-12T12:00:00Z' }]);
    // noon UTC: the 17th both in Berlin and in New York, where the row is still on the 16th (23:00)
    const noon = new Date('2026-11-17T12:00:00Z');
    expect(sectionOf(await feed(env.ctx, ua, 'de', opts(), NOW), 'Früh')).toBe('today');
    const berlin = await feed(env.ctx, ua, 'de', opts(), noon);
    expect(sectionOf(berlin, 'Früh')).toBe('today');
    expect(sectionOf(berlin, 'Mitte')).toBe('week');
    expect(sectionOf(berlin, 'Oktober')).toBe('2026-10');
    expect(berlin.sections.map((s) => s.key)).toEqual(['today', 'week', '2026-10']);
    const ny = await feed(env.ctx, ua, 'de', opts({ tz: 'America/New_York' }), noon);
    expect(sectionOf(ny, 'Früh')).toBe('week');
    expect(sectionOf(ny, 'Oktober')).toBe('2026-10');
    // an unknown zone falls back to the server's TZ
    vi.stubEnv('TZ', 'America/New_York');
    const mars = await feed(env.ctx, ua, 'de', opts({ tz: 'Mars/Base' }), noon);
    expect(sectionOf(mars, 'Früh')).toBe('week');
    vi.stubEnv('TZ', 'Europe/Berlin');
    expect(sectionOf(await feed(env.ctx, ua, 'de', opts({ tz: 'Mars/Base' }), noon), 'Früh')).toBe('today');
  });

  it('zones Intl and Postgres both know are used as given; anything else falls back to the server TZ', async () => {
    // now = 12:00Z on the 17th. 18:45Z on the 16th is 00:15 on the 17th at +05:30 (but 23:45 at +05:00), 18:15Z is 23:45 on the 16th
    // at +05:30 (but 00:15 at +06:00): only an offset of +05:30 puts the first today and the second in the week
    await seed([{ title: 'Spät', at: '2026-11-16T18:45:00Z' }, { title: 'Früher', at: '2026-11-16T18:15:00Z' }]);
    const noon = new Date('2026-11-17T12:00:00Z');
    vi.stubEnv('TZ', 'Asia/Tokyo'); // +09:00: both rows and now are on the 17th there
    const at = async (tz: string) => { const f = await feed(env.ctx, ua, 'de', opts({ tz }), noon); return [sectionOf(f, 'Spät'), sectionOf(f, 'Früher')]; };
    expect(await at('Asia/Kolkata')).toEqual(['today', 'week']);
    expect(await at('UTC')).toEqual(['week', 'week']);
    for (const bad of ['Mars/Base', '../etc', '+05', 'x'.repeat(65), '']) expect(await at(bad), bad).toEqual(['today', 'today']);
    // an unusable server TZ ends at UTC
    vi.stubEnv('TZ', ':/etc/localtime');
    expect(await at('Mars/Base')).toEqual(['week', 'week']);
    // through the route
    const r = await get(a, '/api/notifications/feed?tz=Asia%2FKolkata');
    expect(r.statusCode, r.body).toBe(200);
  });

  it('an earlier month keeps the days before the week as its own section', async () => {
    // 2026-11-17 Berlin: week = 11th..16th, so the 2nd of November is in "2026-11"
    await seed([{ title: 'Anfang November', at: '2026-11-02T12:00:00Z' }]);
    expect(sectionOf(await feed(env.ctx, ua, 'de', opts(), NOW), 'Anfang November')).toBe('2026-11');
  });

  it('six tv rows become one group with count 6 and the newest title', async () => {
    await seed(Array.from({ length: 6 }, (_, i) => ({ title: `Fernseher ${i + 1}`, key: 'tv_paired|tv.paired', at: minutesAgo(10 - i), link: `/me/devices?${i + 1}`, body: `Gerät ${i + 1}` })));
    const f = await feed(env.ctx, ua, 'de', opts(), NOW);
    expect(groups(f)).toHaveLength(1);
    const g = groups(f)[0]!;
    expect(g).toMatchObject({ kind: 'tv_paired', category: 'devices', title: 'Fernseher 6', body: 'Gerät 6', link: '/me/devices?6', count: 6, unread: true, at: minutesAgo(5).toISOString() });
    expect(g.items.map((x) => x.title)).toEqual(['Fernseher 6', 'Fernseher 5', 'Fernseher 4', 'Fernseher 3', 'Fernseher 2', 'Fernseher 1']);
    expect(f.unread).toBe(6);
  });

  it('rows without a group key and never-grouped kinds stay single; the same key in an earlier section is its own group', async () => {
    await seed([
      { kind: 'disk_low', title: 'Platte fast voll', key: null, at: minutesAgo(1) },
      { kind: 'disk_low', title: 'Platte fast voll', key: null, at: minutesAgo(2) },
      { title: 'Heute', key: 'tv_paired|tv.paired', at: minutesAgo(3) },
      { title: 'Oktober', key: 'tv_paired|tv.paired', at: '2026-10-05T12:00:00Z' },
      { title: 'Oktober früher', key: 'tv_paired|tv.paired', at: '2026-10-04T12:00:00Z' },
    ]);
    const f = await feed(env.ctx, ua, 'de', opts(), NOW);
    expect(f.sections.map((s) => [s.key, s.groups.map((g) => [g.title, g.count])])).toEqual([
      ['today', [['Platte fast voll', 1], ['Platte fast voll', 1], ['Heute', 1]]],
      ['2026-10', [['Oktober', 2]]],
    ]);
  });

  it('a group with 25 rows has count 25 and 20 items', async () => {
    await seed(Array.from({ length: 25 }, (_, i) => ({ title: `Folge ${i + 1}`, kind: 'episode', key: 'episode|title.episode', at: minutesAgo(100 - i) })));
    const g = groups(await feed(env.ctx, ua, 'de', opts(), NOW))[0]!;
    expect(g.count).toBe(25);
    expect(g.items).toHaveLength(20);
    expect(g.items[0]!.title).toBe('Folge 25');
    expect(g.items[19]!.title).toBe('Folge 6');
    expect(g.items[0]).toEqual({ id: expect.any(Number), title: 'Folge 25', body: null, at: minutesAgo(76).toISOString() });
  });

  it('titles and bodies are rendered in the asked language', async () => {
    const msg = { title: m('title.available', { title: 'Nordlicht' }) };
    await seed([{ kind: 'available', title: 'gespeichert', msg, at: minutesAgo(1) }]);
    const en = localizeStored({ title: 'gespeichert', body: null, msg }, 'en').title;
    expect(en).not.toBe('gespeichert');
    const g = groups(await feed(env.ctx, ua, 'en', opts(), NOW))[0]!;
    expect(g.title).toBe(en);
    expect(g.items[0]!.title).toBe(en);
  });

  it('paging never splits a group and next continues after the last group', async () => {
    // anchored in a fixed past month, so the whole set is one month section whenever the test runs (never split by a midnight)
    const now = Date.parse('2025-03-10T12:00:00Z');
    // 70 groups: 69 single rows, pairs share their created_at (the id breaks the tie; the 30th/31st pair straddles page 1's end), and a 3-row group in the middle
    const rows: Row[] = Array.from({ length: 69 }, (_, i) => ({ title: `Eintrag ${i}`, at: new Date(now - Math.floor((i + 1) / 2) * 1000) }));
    rows.push(...[0, 1, 2].map((j) => ({ title: 'Mitte', key: 'tv_paired|mitte', at: new Date(now - 17_500 - j * 60_000) })));
    await seed(rows);
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await get(a, `/api/notifications/feed${cursor ? `?cursor=${cursor}` : ''}`);
      expect(r.statusCode, r.body).toBe(200);
      const f = r.json() as Feed;
      sizes.push(groups(f).length);
      seen.push(...groups(f).map((g) => g.id));
      for (const g of groups(f)) if (g.title === 'Mitte') expect(g.count).toBe(3);
      cursor = f.next;
      if (++pages > 5) throw new Error('paging does not end');
    } while (cursor);
    expect(sizes).toEqual([30, 30, 10]);
    expect(new Set(seen).size).toBe(70);
  });

  /** 70 single-row groups one minute apart before NOW (titles G0 newest … G69), all today in Berlin. */
  const seventy = () => seed(Array.from({ length: 70 }, (_, i) => ({ title: `G${i}`, at: minutesAgo(i + 1) })));
  const pageTitles = (f: Feed) => groups(f).map((g) => g.title);
  const nextOf = (f: Feed) => (f.next ? decodeCursor(f.next) : null);

  it('rows arriving between pages neither lift a group off the unseen pages nor show up on them', async () => {
    await seventy();
    const p1 = await feed(env.ctx, ua, 'de', opts(), NOW);
    expect(pageTitles(p1)).toEqual(Array.from({ length: 30 }, (_, i) => `G${i}`));
    // a brand-new group, and a new row for G65 (still unseen, on page 3), both newer than everything on page 1
    await seed([{ title: 'Neu', at: NOW }, { title: 'G65', at: NOW }]);
    const later = new Date(NOW.getTime() + 60_000);
    const p2 = await feed(env.ctx, ua, 'de', opts({ cursor: nextOf(p1) }), later);
    const p3 = await feed(env.ctx, ua, 'de', opts({ cursor: nextOf(p2) }), later);
    expect(pageTitles(p2)).toEqual(Array.from({ length: 30 }, (_, i) => `G${i + 30}`));
    expect(pageTitles(p3)).toEqual(Array.from({ length: 10 }, (_, i) => `G${i + 60}`));
    expect(p3.next).toBeNull();
    // G65 keeps the shape it had when paging started
    expect(groups(p3).find((g) => g.title === 'G65')).toMatchObject({ count: 1, at: minutesAgo(66).toISOString() });
    // a fresh first page sees both
    expect(pageTitles(await feed(env.ctx, ua, 'de', opts(), later)).slice(0, 2)).toEqual(['G65', 'Neu']);
  });

  it('a local midnight between pages keeps the sections of the first page', async () => {
    // Berlin 23:59 on the 17th; the next page is asked for at 00:01 on the 18th
    const before = new Date('2026-11-17T22:59:00Z');
    const after = new Date('2026-11-17T23:01:00Z');
    await seed(Array.from({ length: 31 }, (_, i) => ({ title: `H${i}`, at: new Date(before.getTime() - (i + 1) * 60_000) })));
    const p1 = await feed(env.ctx, ua, 'de', opts(), before);
    expect(p1.sections.map((x) => x.key)).toEqual(['today']);
    const p2 = await feed(env.ctx, ua, 'de', opts({ cursor: nextOf(p1) }), after);
    expect(p2.sections.map((x) => [x.key, x.groups.map((g) => g.title)])).toEqual([['today', ['H30']]]);
    // without a cursor the new day applies
    expect((await feed(env.ctx, ua, 'de', opts(), after)).sections.map((x) => x.key)).toEqual(['week']);
  });

  it("hidden rows and other people's rows never appear; broadcasts appear for everyone", async () => {
    const [, , , hiddenBc] = await seed([
      { title: 'Meins', at: minutesAgo(1) },
      { title: 'Versteckt', at: minutesAgo(2), hidden: true },
      { title: 'Von Ben', user: ub, at: minutesAgo(3) },
      { title: 'Rundruf versteckt', user: null, kind: 'available_all', at: minutesAgo(4) },
      { title: 'Rundruf', user: null, kind: 'available_all', at: minutesAgo(5) },
    ]);
    await env.pool.query('insert into notification_state(user_id, notification_id, hidden_at) values ($1,$2,now())', [ua, hiddenBc]);
    const titles = async (uid: string) => groups(await feed(env.ctx, uid, 'de', opts(), NOW)).map((g) => g.title);
    expect(await titles(ua)).toEqual(['Meins', 'Rundruf']);
    expect(await titles(ub)).toEqual(['Von Ben', 'Rundruf versteckt', 'Rundruf']);
    expect(groups((await get(b, '/api/notifications/feed')).json()).map((g) => g.title)).toEqual(['Von Ben', 'Rundruf versteckt', 'Rundruf']);
  });

  it('read follows the watermark or the state row', async () => {
    const T = minutesAgo(60);
    const [, newer] = await seed([
      { title: 'Alt', user: null, kind: 'available_all', at: minutesAgo(90) },
      { title: 'Neuer, gelesen', user: null, kind: 'available_all', at: minutesAgo(30) },
      { title: 'Neuer, ungelesen', user: null, kind: 'available_all', at: minutesAgo(20) },
      { title: 'Persönlich gelesen', at: minutesAgo(10), read: true },
      { title: 'Persönlich offen', at: minutesAgo(5) },
    ]);
    await env.pool.query('update users set notifications_read_at = $2 where id = $1', [ua, T]);
    await env.pool.query('insert into notification_state(user_id, notification_id, read_at) values ($1,$2,now())', [ua, newer]);
    const f = await feed(env.ctx, ua, 'de', opts(), NOW);
    expect(Object.fromEntries(groups(f).map((g) => [g.title, g.unread]))).toEqual({
      'Alt': false, 'Neuer, gelesen': false, 'Neuer, ungelesen': true, 'Persönlich gelesen': false, 'Persönlich offen': true,
    });
    expect(f.unread).toBe(2);
    // Ben has no watermark and no state rows: every broadcast is unread for him
    expect((await feed(env.ctx, ub, 'de', opts(), NOW)).unread).toBe(3);
  });

  it('filter unread and category', async () => {
    await seed([
      { title: 'TV', key: 'tv_paired|tv', at: minutesAgo(1) },
      { title: 'TV', key: 'tv_paired|tv', at: minutesAgo(2), read: true },
      { kind: 'device_pending', title: 'Gerät wartet', at: minutesAgo(3), read: true },
      { kind: 'download_ready', title: 'Download fertig', at: minutesAgo(4) },
      { kind: 'achievement', title: 'Abzeichen', at: minutesAgo(5), read: true },
    ]);
    const global = { unread: 2, categories: [{ key: 'downloads', n: 1 }, { key: 'devices', n: 3 }, { key: 'achievements', n: 1 }] };
    const dev = await feed(env.ctx, ua, 'de', opts({ filter: 'devices' }), NOW);
    expect(groups(dev).map((g) => [g.title, g.count])).toEqual([['TV', 2], ['Gerät wartet', 1]]);
    expect(dev).toMatchObject(global);
    const unread = await feed(env.ctx, ua, 'de', opts({ filter: 'unread' }), NOW);
    expect(groups(unread).map((g) => [g.title, g.count, g.items.length])).toEqual([['TV', 2, 2], ['Download fertig', 1, 1]]);
    expect(unread).toMatchObject(global);
    expect(groups(await feed(env.ctx, ua, 'de', opts({ filter: 'social' }), NOW))).toEqual([]);
    // through the route
    const r = await get(a, '/api/notifications/feed?filter=downloads&tz=Europe/Berlin');
    expect(groups(r.json()).map((g: { title: string }) => g.title)).toEqual(['Download fertig']);
  });

  it('limit=0 answers counts only', async () => {
    await seed([{ title: 'TV', at: minutesAgo(1) }, { kind: 'download_ready', title: 'Fertig', at: minutesAgo(2), read: true }]);
    const r = await get(a, '/api/notifications/feed?limit=0');
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(['categories', 'unread']);
    expect(r.json()).toEqual({ unread: 1, categories: [{ key: 'downloads', n: 1 }, { key: 'devices', n: 1 }] });
    // empty parameters are the defaults (a full page)
    expect(Object.keys((await get(a, '/api/notifications/feed?cursor=&filter=&tz=&limit=')).json()).sort()).toEqual(['categories', 'next', 'sections', 'unread']);
  });

  it('bad input', async () => {
    const err = async (q: string) => { const r = await get(a, `/api/notifications/feed?${q}`); return [r.statusCode, r.json().error]; };
    expect(await err('filter=xyz')).toEqual([400, 'invalid_filter']);
    expect(await err('filter=all&filter=unread')).toEqual([400, 'invalid_filter']);
    expect(await err('cursor=%%%garbage')).toEqual([400, 'invalid_cursor']);
    expect(await err(`cursor=${Buffer.from('{"s":"today"}').toString('base64url')}`)).toEqual([400, 'invalid_cursor']);
    expect(await err(`cursor=${Buffer.from('{"s":"x","at":"2026-11-17T00:00:00.000Z","id":1}').toString('base64url')}`)).toEqual([400, 'invalid_cursor']);
    expect(await err('limit=-1')).toEqual([400, 'bad_request']);
    expect(await err('limit=abc')).toEqual([400, 'bad_request']);
  });

  it('limit is capped at 30', async () => {
    await seed(Array.from({ length: 35 }, (_, i) => ({ title: `E${i}`, at: minutesAgo(i + 1, new Date()) })));
    const f = (await get(a, '/api/notifications/feed?limit=100')).json() as Feed;
    expect(groups(f)).toHaveLength(30);
    expect(f.next).not.toBeNull();
    expect(groups((await get(a, '/api/notifications/feed?limit=5')).json())).toHaveLength(5);
  });

  it('group ids are signed for one person and name the section range', async () => {
    const [newest, , weekId] = await seed([
      { title: 'TV', key: 'tv_paired|tv', at: minutesAgo(1) }, { title: 'TV', key: 'tv_paired|tv', at: minutesAgo(2) },
      { title: 'TV', key: 'tv_paired|tv', at: '2026-11-12T12:00:00Z' },
    ]);
    const [today, week] = groups(await feed(env.ctx, ua, 'de', opts(), NOW));
    // Berlin: today = 16th 23:00Z .. 17th 23:00Z, week = 10th 23:00Z .. 16th 23:00Z
    expect(parseGroupId(env.ctx, ua, today!.id)).toEqual({ groupKey: 'tv_paired|tv', from: new Date('2026-11-16T23:00:00Z'), to: new Date('2026-11-17T23:00:00Z'), maxId: newest! + 1 });
    expect(parseGroupId(env.ctx, ua, week!.id)).toEqual({ groupKey: 'tv_paired|tv', from: new Date('2026-11-10T23:00:00Z'), to: new Date('2026-11-16T23:00:00Z'), maxId: weekId });
    expect(parseGroupId(env.ctx, ub, today!.id)).toBeNull();
    const [body, sig] = today!.id.split('.');
    const forged = Buffer.from(JSON.stringify(['tv_paired|other', 0, Date.now(), 1])).toString('base64url');
    expect(parseGroupId(env.ctx, ua, `${forged}.${sig}`)).toBeNull();
    // a raised maxId (to reach entries that arrived later) breaks the signature
    const [k, f, t, max] = JSON.parse(Buffer.from(body!, 'base64url').toString()) as [string, number, number, number];
    expect(max).toBe(newest! + 1);
    expect(parseGroupId(env.ctx, ua, `${Buffer.from(JSON.stringify([k, f, t, max + 5])).toString('base64url')}.${sig}`)).toBeNull();
    expect(parseGroupId(env.ctx, ua, `${body}.${sig!.slice(0, -2)}AA`)).toBeNull();
    expect(parseGroupId(env.ctx, ua, 'garbage')).toBeNull();
    const own = groupId(env.ctx, ub, 'x|y', new Date(1000), new Date(2000), 42);
    expect(parseGroupId(env.ctx, ub, own)).toEqual({ groupKey: 'x|y', from: new Date(1000), to: new Date(2000), maxId: 42 });
  });

  it('a month section ends where the week begins', async () => {
    await seed([{ title: 'Anfang November', at: '2026-11-02T12:00:00Z' }]);
    const g = groups(await feed(env.ctx, ua, 'de', opts(), NOW))[0]!;
    expect(parseGroupId(env.ctx, ua, g.id)).toMatchObject({ from: new Date('2026-10-31T23:00:00Z'), to: new Date('2026-11-10T23:00:00Z') });
  });

  it('kids profile gets 403 kids_profile', async () => {
    const mk = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: a.cookies, headers: { 'x-csrf-token': a.csrf }, payload: { name: 'Mia', kids: true } });
    expect(mk.statusCode, mk.body).toBe(201);
    const sel = await env.app.inject({ method: 'POST', url: `/api/profiles/${mk.json().profile.id}/select`, cookies: a.cookies, headers: { 'x-csrf-token': a.csrf }, payload: {} });
    const kid: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: a.csrf };
    for (const q of ['', '?limit=0']) {
      const r = await get(kid, `/api/notifications/feed${q}`);
      expect([r.statusCode, r.json().error]).toEqual([403, 'kids_profile']);
    }
  });
});
