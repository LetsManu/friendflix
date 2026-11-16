// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { licenceExpiryTick } from '../src/downloadExpiry.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Mail stage B, Task 3 (Controller's calls 5 and 10): once a day from 09:00 server time, every person whose download licences expire
// within 48 h gets one notice (in-app, personal push, mail type `licence`) with the count and the earliest expiry. A licence is
// warned once, only while pending or fetched, and only when it is at least 48 h old.
const MAIL_CFG: Partial<Config> = { MAIL_SMTP_HOST: 'mail.example.com', MAIL_FROM: 'kino@friend.example.com', PUBLIC_URL: 'https://friend.example.com' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-11-16 09:05 server time */
const NOW = new Date(2026, 10, 16, 9, 5, 0);
const DAY_KEY = 'mail:licence-day:2026-11-16';

describe('licence expiry warnings', () => {
  let env: TestEnv;
  let anna = '';
  let ben = '';

  const person = async (sub: string, name: string, email: string) => {
    const id = randomUUID();
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, 'friend', $5, $2, $6)`,
      [id, sub, email, name, sub.padEnd(32, '0'), encrypt(env.ctx.encKey, 'pw')]);
    await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name.split(' ')[0]]);
    await env.pool.query("insert into devices(user_id, device_id, label, approved) values ($1, 'dev-0000000000000001', 'Tablet', true)", [id]);
    return id;
  };
  /** a licence of `userId` (its owner profile unless `profile`) that expires `inH` hours after NOW and was created `ageH` hours before it */
  const licence = async (userId: string, inH: number, ageH = 10 * 24, o: { status?: string; profile?: string } = {}) => {
    const id = randomUUID();
    await env.pool.query(
      `insert into downloads(id, user_id, device_id, profile_id, item_id, quality, status, created_at, expires_at)
       values ($1, $2, 'dev-0000000000000001', $3, $4, 'hd', $5, $6, $7)`,
      [id, userId, o.profile ?? userId, randomUUID().replace(/-/g, ''), o.status ?? 'fetched', new Date(NOW.getTime() - ageH * HOUR), new Date(NOW.getTime() + inH * HOUR)]);
    return id;
  };
  const warned = async (id: string) => (await env.pool.query<{ expiry_warned_at: Date | null }>('select expiry_warned_at from downloads where id = $1', [id])).rows[0]!.expiry_warned_at;
  const notices = async () => (await env.pool.query<{ user_id: string; kind: string; title: string; body: string | null; link: string; dedupe: string; msg: unknown }>(
    "select user_id, kind, title, body, link, dedupe, msg from notifications where kind = 'download_expiring' order by created_at, id")).rows;
  const mails = async () => (await env.pool.query<{ kind: string; user_id: string; dedupe: string; rcpt_mask: string; lang: string }>(
    'select kind, user_id, dedupe, rcpt_mask, lang from mail_outbox order by created_at, id')).rows;

  beforeAll(async () => {
    env = await makeEnv();
    anna = await person('sub-anna', 'Anna Beispiel', 'anna@friend.example.com');
    ben = await person('sub-ben', 'Ben Muster', 'ben@friend.example.com');
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
    await env.pool.query('delete from downloads; delete from notifications; delete from mail_outbox');
    for (const k of await env.kv.keys('mail:licence-day:')) await env.kv.del(k);
  });
  afterEach(() => {
    env.ctx.cfg = cfg;
  });

  it('before 09:00 nothing runs', async () => {
    await licence(anna, 30);
    expect(await licenceExpiryTick(env.ctx, new Date(2026, 10, 16, 8, 59, 0))).toBeNull();
    expect(await env.kv.get(DAY_KEY)).toBeNull();
    expect(await notices()).toEqual([]);
  });

  it('licences inside the window are warned once per person', async () => {
    const a30 = await licence(anna, 30);
    const a47 = await licence(anna, 47);
    const a60 = await licence(anna, 60);
    // Ben's licence expires soon, but he only just downloaded it (a short licence must not warn right after the download)
    const b20 = await licence(ben, 20, 30);
    expect(await licenceExpiryTick(env.ctx, NOW)).toEqual({ warned: 2, people: 1 });
    const earliest = new Date(NOW.getTime() + 30 * HOUR).toISOString();
    expect(await notices()).toEqual([{
      user_id: anna, kind: 'download_expiring', title: '2 Downloads laufen bald ab', body: expect.stringMatching(/^Der erste läuft am .+ ab\.$/),
      link: '/downloads', dedupe: `dl-expiring-${anna}-2026-11-16`,
      msg: {
        title: { key: 'download.expiring.title', params: { n: 2 } },
        body: { key: 'download.expiring.body', params: { n: 2, date: { date: earliest } } },
      },
    }]);
    expect(await mails()).toEqual([{ kind: 'licence', user_id: anna, dedupe: `n:dl-expiring-${anna}-2026-11-16`, rcpt_mask: 'a…@friend.example.com', lang: 'de' }]);
    expect(await warned(a30)).toEqual(NOW);
    expect(await warned(a47)).toEqual(NOW);
    expect(await warned(a60)).toBeNull();
    expect(await warned(b20)).toBeNull();
    expect(await env.kv.get(DAY_KEY)).not.toBeNull();
  });

  it('a second run the same day does nothing', async () => {
    await licence(anna, 30);
    expect(await licenceExpiryTick(env.ctx, NOW)).toEqual({ warned: 1, people: 1 });
    // a licence that entered the window since: it waits for tomorrow's run
    const late = await licence(anna, 40);
    expect(await licenceExpiryTick(env.ctx, new Date(NOW.getTime() + 3 * HOUR))).toBeNull();
    expect(await warned(late)).toBeNull();
    expect(await notices()).toHaveLength(1);
    expect(await mails()).toHaveLength(1);
  });

  it('the next day skips warned licences', async () => {
    const a30 = await licence(anna, 30);
    const a47 = await licence(anna, 47);
    const a60 = await licence(anna, 60);
    expect(await licenceExpiryTick(env.ctx, NOW)).toEqual({ warned: 2, people: 1 });
    const tomorrow = new Date(NOW.getTime() + DAY);
    // a47 now expires in 23 h and a30 in 6 h: both warned yesterday; only a60 (36 h) is new
    expect(await licenceExpiryTick(env.ctx, tomorrow)).toEqual({ warned: 1, people: 1 });
    expect(await warned(a30)).toEqual(NOW);
    expect(await warned(a47)).toEqual(NOW);
    expect(await warned(a60)).toEqual(tomorrow);
    const n = await notices();
    expect(n.map((x) => [x.dedupe, x.title])).toEqual([
      [`dl-expiring-${anna}-2026-11-16`, '2 Downloads laufen bald ab'],
      [`dl-expiring-${anna}-2026-11-17`, 'Ein Download läuft bald ab'],
    ]);
    expect(n[1]!.body).toMatch(/^Er läuft am .+ ab\.$/);
    expect((await mails()).map((m) => m.dedupe)).toEqual([`n:dl-expiring-${anna}-2026-11-16`, `n:dl-expiring-${anna}-2026-11-17`]);
  });

  it('deleted or revoked licences are never warned', async () => {
    const del = await licence(anna, 30, 240, { status: 'deleted' });
    const rev = await licence(anna, 30, 240, { status: 'revoked' });
    const pending = await licence(ben, 30, 240, { status: 'pending' });
    expect(await licenceExpiryTick(env.ctx, NOW)).toEqual({ warned: 1, people: 1 });
    expect(await warned(del)).toBeNull();
    expect(await warned(rev)).toBeNull();
    expect(await warned(pending)).toEqual(NOW);
    expect((await notices()).map((n) => n.user_id)).toEqual([ben]);
  });

  it('a licence of a kids profile mails the account address', async () => {
    const kids = randomUUID();
    await env.pool.query("insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, 'Mika', false, true, 'kids-jf-0001')", [kids, anna]);
    await env.pool.query(`insert into profile_prefs(profile_id, data) values ($1, '{"language": "en"}'), ($2, '{"language": "fr"}')`, [anna, kids]);
    try {
      await licence(anna, 30, 240, { profile: kids });
      expect(await licenceExpiryTick(env.ctx, NOW)).toEqual({ warned: 1, people: 1 });
      // the account's inbox and the account's address, in the account's language
      expect((await notices()).map((n) => [n.user_id, n.title])).toEqual([[anna, 'A download expires soon']]);
      expect(await mails()).toEqual([{ kind: 'licence', user_id: anna, dedupe: `n:dl-expiring-${anna}-2026-11-16`, rcpt_mask: 'a…@friend.example.com', lang: 'en' }]);
    } finally {
      await env.pool.query('delete from downloads');
      await env.pool.query('delete from profile_prefs where profile_id = any($1)', [[anna, kids]]);
      await env.pool.query('delete from profiles where id = $1', [kids]);
    }
  });

  it('a failure gives back the day and the licences of the people not told yet', async () => {
    const a = await licence(anna, 30);
    const b = await licence(ben, 30);
    // the notices table refuses the second person's notice
    let inserts = 0;
    const real = env.ctx.db;
    env.ctx.db = Object.assign(Object.create(real) as typeof real, {
      query: async (sql: unknown, ...rest: unknown[]) => {
        if (typeof sql === 'string' && sql.startsWith('insert into notifications') && ++inserts === 2) throw new Error('db down');
        return (real.query as (...x: unknown[]) => Promise<unknown>).call(real, sql, ...rest);
      },
    });
    try {
      await expect(licenceExpiryTick(env.ctx, NOW)).rejects.toThrow('db down');
    } finally {
      env.ctx.db = real;
    }
    expect(await env.kv.get(DAY_KEY)).toBeNull();
    const told = (await notices()).map((n) => n.user_id);
    expect(told).toHaveLength(1);
    const [toldLic, untoldLic] = told[0] === anna ? [a, b] : [b, a];
    expect(await warned(toldLic)).toEqual(NOW);
    expect(await warned(untoldLic)).toBeNull();
    // the next tick (10 minutes later) tells the other one, and nobody twice
    expect(await licenceExpiryTick(env.ctx, new Date(NOW.getTime() + 10 * 60_000))).toEqual({ warned: 1, people: 1 });
    expect((await notices()).map((n) => n.user_id).sort()).toEqual([anna, ben].sort());
    expect(await mails()).toHaveLength(2);
  });
});
