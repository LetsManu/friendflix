// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reqSerializer } from '../src/app.js';
import type { Config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { mailSubkey } from '../src/mail/address.js';
import { readMailPrefs } from '../src/mail/people.js';
import { unsubscribeToken } from '../src/mail/unsubscribe.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Mail stage B, Task 4: the public unsubscribe route (RFC 8058 one-click POST, the confirm page's JSON POST, a GET that only
// redirects) and the account page's mail switches.
type Sess = { cookies: Record<string, string>; csrf: string };
const ANNA = 'anna@friend.example.com';
const BEN = 'ben@friend.example.com';
const MAIL_CFG: Partial<Config> = { MAIL_SMTP_HOST: 'mail.example.com', MAIL_FROM: 'kino@friend.example.com', PUBLIC_URL: 'https://friend.example.com' };
const URL_ = '/api/public/mail/unsubscribe';
const ALL_ON = { available: true, recording: true, licence: true };

describe('mail person routes', () => {
  let env: TestEnv;
  let anna: string, ben: string;
  let annaS: Sess;
  const logs: string[] = [];

  // every call comes from its own address, so the per-IP limits (tested on their own) do not count the other tests
  let n = 0;
  const ip = () => `192.0.2.${(n = (n % 200) + 1)}`;
  const tok = (userId: string, type: 'available' | 'recording' | 'licence' = 'licence') => unsubscribeToken(env.ctx.encKey, userId, type);
  const oneClick = (t: string, type: 'form' | 'multipart' = 'form', extra: { cookies?: Record<string, string>; remoteAddress?: string } = {}) =>
    env.app.inject({
      method: 'POST', url: `${URL_}?t=${encodeURIComponent(t)}`, remoteAddress: extra.remoteAddress ?? ip(), cookies: extra.cookies,
      ...(type === 'form'
        ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' }
        : { headers: { 'content-type': 'multipart/form-data; boundary=XyZ' }, payload: '--XyZ\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--XyZ--\r\n' }),
    });
  const page = (body: unknown) => env.app.inject({ method: 'POST', url: URL_, remoteAddress: ip(), payload: body as object });
  const as = (s: Sess, method: string, url: string, payload?: unknown) =>
    env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object, remoteAddress: ip() });
  const audits = async () => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>(
    "select actor, meta from audit_log where action = 'mail.pref' order by id")).rows;
  const insertRow = (userId: string, kind: string) => env.pool.query<{ id: string }>(
    `insert into mail_outbox (id, kind, user_id, rcpt_enc, rcpt_mask, rcpt_key, params_enc, lang, state)
     values (gen_random_uuid(), $1, $2, 'x', 'a…@friend.example.com', 'k', 'x', 'de', 'queued') returning id`, [kind, userId]).then((r) => r.rows[0]!.id);

  beforeAll(async () => {
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
    for (const [sub, email, name] of [['sub-anna', ANNA, 'Anna Beispiel'], ['sub-ben', BEN, 'Ben Muster']] as const) {
      await env.pool.query(
        "insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, $2, $3, 'friend', $4, $5, $6)",
        [sub, email, name, sub.padEnd(32, '0'), sub, encrypt(env.ctx.encKey, 'pw')]);
    }
    annaS = await env.login({ sub: 'sub-anna', email: ANNA, name: 'Anna Beispiel', groups: [] });
    const ids = (await env.pool.query<{ id: string; authentik_sub: string }>("select id, authentik_sub from users where authentik_sub in ('sub-anna','sub-ben')")).rows;
    anna = ids.find((r) => r.authentik_sub === 'sub-anna')!.id;
    ben = ids.find((r) => r.authentik_sub === 'sub-ben')!.id;
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
    await env.pool.query('delete from mail_outbox');
    await env.pool.query("delete from audit_log where action = 'mail.pref'");
    await env.pool.query('delete from user_prefs where user_id = any($1)', [[anna, ben]]);
  });
  afterEach(() => {
    env.ctx.cfg = cfg;
  });

  it('one-click POST switches the type off', async () => {
    const t = tok(anna);
    const r = await oneClick(t);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, type: 'licence', on: false });
    expect(r.headers['cache-control']).toContain('no-store');
    const m = await oneClick(t, 'multipart');
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ ok: true, type: 'licence', on: false });
    expect((await readMailPrefs(env.ctx, anna)).licence).toBe(false);
    expect((await readMailPrefs(env.ctx, anna)).recording).toBe(true);
    // a form body is never read: neither a token nor `on` in it counts
    const f = await env.app.inject({ method: 'POST', url: `${URL_}?t=${t}`, remoteAddress: ip(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `t=${tok(ben, 'recording')}&on=true` });
    expect(f.json()).toEqual({ ok: true, type: 'licence', on: false });
    expect(await readMailPrefs(env.ctx, ben)).toEqual(ALL_ON);
    // nor a large one
    expect((await env.app.inject({ method: 'POST', url: `${URL_}?t=${t}`, remoteAddress: ip(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'x'.repeat(5000) })).statusCode).toBe(413);
    const a = await audits();
    expect(a.length).toBeGreaterThan(0);
    for (const row of a) {
      expect(row.actor).toBe(anna);
      expect(row.meta).toEqual({ type: 'licence', on: false, via: 'one_click' });
      expect(JSON.stringify(row.meta)).not.toContain(t.split('.')[3]!);
      expect(Object.keys(row.meta)).not.toContain('t');
    }
  });

  it('page POST with a JSON body can switch back on', async () => {
    const t = tok(anna, 'available');
    const off = await page({ t, on: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ ok: true, type: 'available', on: false });
    expect((await readMailPrefs(env.ctx, anna)).available).toBe(false);
    const on = await page({ t, on: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ ok: true, type: 'available', on: true });
    expect((await readMailPrefs(env.ctx, anna)).available).toBe(true);
    // `on` left out: off (the default of an unsubscribe)
    expect((await page({ t })).json()).toEqual({ ok: true, type: 'available', on: false });
    // `on` that is not a boolean: refused, nothing written
    const bad = await page({ t, on: 'yes' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad_request' });
    expect((await audits()).map((x) => x.meta)).toEqual([
      { type: 'available', on: false, via: 'page' }, { type: 'available', on: true, via: 'page' }, { type: 'available', on: false, via: 'page' }]);
  });

  it('one-click POST works next to a session cookie without csrf header', async () => {
    const r = await oneClick(tok(anna), 'form', { cookies: annaS.cookies });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, type: 'licence', on: false });
    const p = await env.app.inject({ method: 'POST', url: URL_, cookies: annaS.cookies, payload: { t: tok(anna), on: true }, remoteAddress: ip() });
    expect(p.statusCode).toBe(200);
    expect((await readMailPrefs(env.ctx, anna)).licence).toBe(true);
  });

  it('invalid token answers 400 and changes nothing', async () => {
    const annaMac = tok(anna).split('.')[3]!;
    const digestMac = createHmac('sha256', mailSubkey(env.ctx.encKey, 'unsubscribe')).update(`v1|${anna}|digest`).digest('base64url');
    const bad = [
      `v1.${ben}.licence.${annaMac}`, // another person
      `v1.${anna}.recording.${annaMac}`, // another type
      `v1.${anna}.digest.${digestMac}`, // unknown type, properly signed
      `v1.${anna}.licence.${annaMac.slice(0, 42)}`, // cut mac
      `v1.${anna}.licence.${annaMac.slice(0, 42)}A`.replace(/A$/, annaMac.endsWith('A') ? 'B' : 'A'), // changed mac
      `v2.${anna}.licence.${annaMac}`,
      '',
      'x'.repeat(5000),
    ];
    for (const t of bad) {
      for (const r of [await oneClick(t), await page({ t, on: false })]) {
        expect(r.statusCode).toBe(400);
        expect(r.json()).toEqual({ error: 'invalid_token' });
      }
    }
    // no token at all, a token that is not a string, two tokens in the query
    for (const r of [
      await env.app.inject({ method: 'POST', url: URL_, remoteAddress: ip() }),
      await page({ t: 7 }),
      await page({ t: [tok(anna)] }),
      await env.app.inject({ method: 'POST', url: `${URL_}?t=${tok(anna)}&t=${tok(anna)}`, remoteAddress: ip() }),
    ]) {
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid_token' });
    }
    expect(await readMailPrefs(env.ctx, anna)).toEqual(ALL_ON);
    expect(await readMailPrefs(env.ctx, ben)).toEqual(ALL_ON);
    expect((await env.pool.query('select 1 from user_prefs where user_id = any($1)', [[anna, ben]])).rowCount).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it('token of a deleted account answers ok and writes nothing', async () => {
    const gone = randomUUID();
    const t = unsubscribeToken(env.ctx.encKey, gone, 'recording');
    const off = await oneClick(t);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ ok: true, type: 'recording', on: false });
    const on = await page({ t, on: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ ok: true, type: 'recording', on: true });
    expect((await env.pool.query('select 1 from user_prefs where user_id = $1', [gone])).rowCount).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it('GET only redirects', async () => {
    const t = tok(anna);
    for (const method of ['GET', 'HEAD'] as const) {
      const r = await env.app.inject({ method, url: `${URL_}?t=${t}`, remoteAddress: ip() });
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe(`/mail/unsubscribe?t=${t}`);
    }
    // even with a session cookie
    expect((await env.app.inject({ method: 'GET', url: `${URL_}?t=${t}`, cookies: annaS.cookies, remoteAddress: ip() })).statusCode).toBe(303);
    expect(await readMailPrefs(env.ctx, anna)).toEqual(ALL_ON);
    expect(await audits()).toEqual([]);
    for (const q of ['?t=%3Cscript%3E', '', '?t=', `?t=${'a'.repeat(201)}`, '?t=a%0d%0aSet-Cookie:x=1', '?t=//evil.example.com']) {
      const r = await env.app.inject({ method: 'GET', url: `${URL_}${q}`, remoteAddress: ip() });
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe('/mail/unsubscribe');
    }
  });

  it('the unsubscribe routes are rate limited per IP', async () => {
    const post = () => oneClick('v1.bad', 'form', { remoteAddress: '192.0.2.250' });
    for (let i = 0; i < 20; i++) expect((await post()).statusCode).toBe(400);
    expect((await post()).statusCode).toBe(429);
    // another address is not affected
    expect((await oneClick('v1.bad', 'form', { remoteAddress: '192.0.2.251' })).statusCode).toBe(400);
    const get = () => env.app.inject({ method: 'GET', url: `${URL_}?t=x`, remoteAddress: '192.0.2.252' });
    for (let i = 0; i < 20; i++) expect((await get()).statusCode).toBe(303);
    expect((await get()).statusCode).toBe(429);
  });

  it('reqSerializer redacts the unsubscribe token', async () => {
    expect(reqSerializer({ url: '/api/public/mail/unsubscribe?t=v1.abc&x=1' }).url).toBe('/api/public/mail/unsubscribe?t=[redacted]&x=1');
    expect(reqSerializer({ url: '/api/livetv/logos/a?exp=1&sig=abc' }).url).toBe('/api/livetv/logos/a?exp=1&sig=[redacted]');
    expect(reqSerializer({ url: '/x?sig=1&t=2#f' }).url).toBe('/x?sig=[redacted]&t=[redacted]#f');
    // a parameter that only ends in t or sig stays
    expect(reqSerializer({ url: '/x?at=1&tsig=2' }).url).toBe('/x?at=1&tsig=2');
    // the logged URL of a real request carries no token
    const t = tok(anna);
    const mac = t.split('.')[3]!;
    logs.length = 0;
    await oneClick(t);
    await env.app.inject({ method: 'GET', url: `${URL_}?t=${t}`, remoteAddress: ip() });
    await oneClick(`${t}x`); // invalid
    const all = logs.join('\n');
    expect(all).toContain('/api/public/mail/unsubscribe?t=[redacted]');
    expect(all).not.toContain(mac);
    expect(all).not.toMatch(/[?&]t=v1/);
  });

  it('account mail GET and PUT', async () => {
    const g = await as(annaS, 'GET', '/api/account/mail');
    expect(g.statusCode).toBe(200);
    expect(g.headers['cache-control']).toContain('no-store');
    expect(g.json()).toEqual({ configured: true, hasAddress: true, prefs: ALL_ON });
    expect(g.body).not.toContain('@');

    const queued = await insertRow(anna, 'recording');
    const kept = await insertRow(anna, 'licence');
    const p = await as(annaS, 'PUT', '/api/account/mail', { type: 'recording', on: false });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toEqual({ prefs: { ...ALL_ON, recording: false } });
    expect((await as(annaS, 'GET', '/api/account/mail')).json().prefs).toEqual({ ...ALL_ON, recording: false });
    const left = (await env.pool.query<{ id: string }>('select id from mail_outbox')).rows.map((r) => r.id);
    expect(left).toEqual([kept]);
    expect(left).not.toContain(queued);
    expect(await audits()).toEqual([{ actor: anna, meta: { type: 'recording', on: false, via: 'account' } }]);
    expect((await as(annaS, 'PUT', '/api/account/mail', { type: 'recording', on: true })).json()).toEqual({ prefs: ALL_ON });

    // CSRF as for every session route
    const noCsrf = await env.app.inject({ method: 'PUT', url: '/api/account/mail', cookies: annaS.cookies, payload: { type: 'licence', on: false }, remoteAddress: ip() });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toEqual({ error: 'csrf' });
    // no session
    expect((await env.app.inject({ method: 'GET', url: '/api/account/mail', remoteAddress: ip() })).statusCode).toBe(401);
    // bad bodies
    for (const b of [{ type: 'digest', on: false }, { type: 'welcome', on: false }, { type: 'licence', on: 'no' }, {}]) {
      const r = await as(annaS, 'PUT', '/api/account/mail', b);
      expect(r.statusCode).toBe(400);
    }
    expect(await readMailPrefs(env.ctx, anna)).toEqual(ALL_ON);

    // without mail settings, and without an address
    env.ctx.cfg = cfg;
    expect((await as(annaS, 'GET', '/api/account/mail')).json()).toEqual({ configured: false, hasAddress: true, prefs: ALL_ON });
    env.ctx.cfg = { ...cfg, ...MAIL_CFG, PUBLIC_URL: '' };
    expect((await as(annaS, 'GET', '/api/account/mail')).json().configured).toBe(false);
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
    await env.pool.query('update users set email = null where id = $1', [anna]);
    try {
      expect((await as(annaS, 'GET', '/api/account/mail')).json()).toEqual({ configured: true, hasAddress: false, prefs: ALL_ON });
    } finally {
      await env.pool.query('update users set email = $1 where id = $2', [ANNA, anna]);
    }

    // a kids profile has no switches (last: selecting it moves Anna's session onto the kids profile)
    const prof = (await as(annaS, 'POST', '/api/profiles', { name: 'Kind' })).json().profile as { id: string };
    const sel = await as(annaS, 'POST', `/api/profiles/${prof.id}/select`, {});
    const kid: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: annaS.csrf };
    expect((await as(kid, 'GET', '/api/account/mail')).statusCode).toBe(403);
    expect((await as(kid, 'PUT', '/api/account/mail', { type: 'licence', on: false })).statusCode).toBe(403);
    expect(await readMailPrefs(env.ctx, anna)).toEqual(ALL_ON);
  });
});
