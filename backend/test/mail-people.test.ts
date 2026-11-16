// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { mailSubkey, recipientKey } from '../src/mail/address.js';
import {
  ADMIN_MAIL_TYPES, MAIL_PREF_DEFAULTS, MAIL_PREF_TYPES, PERSON_MAIL_TYPES, isAdminMailType, isMailPrefType, mailPerson, mailRecipient, personMailBlock,
  readMailPrefs, setMailPref,
} from '../src/mail/people.js';
import { unsubscribeToken, unsubscribeUrls, verifyUnsubscribeToken } from '../src/mail/unsubscribe.js';
import { prefsSchema } from '../src/routes/prefs.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Mail stage B, Task 1: per-type mail switches (user_prefs.data.mail), who gets a person mail, and the unsubscribe token.
const ANNA = 'anna@friend.example.com';
const BEN = 'ben@friend.example.com';
const MAIL_CFG: Partial<Config> = { MAIL_SMTP_HOST: 'mail.example.com', MAIL_FROM: 'kino@friend.example.com', PUBLIC_URL: 'https://friend.example.com' };
const DEFAULTS = { available: true, recording: true, licence: true, digest: false, update: true, updatefailed: true, syscheck: true, storage: true };

describe('mail preferences and recipients', () => {
  let env: TestEnv;
  let anna: string;
  let ben: string;

  const addUser = async (sub: string, email: string | null, name: string) => {
    const id = randomUUID();
    await env.pool.query(
      "insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, 'friend', $5, $6, $7)",
      [id, sub, email, name, sub.padEnd(32, '0'), sub, encrypt(env.ctx.encKey, 'pw')]);
    await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name]);
    return id;
  };
  const userPrefs = async (id: string) =>
    (await env.pool.query<{ data: Record<string, unknown> }>('select data from user_prefs where user_id=$1', [id])).rows[0]?.data;
  const insertRow = (userId: string, kind: string, state: 'queued' | 'sending') => env.pool.query<{ id: string }>(
    `insert into mail_outbox (id, kind, user_id, rcpt_enc, rcpt_mask, rcpt_key, params_enc, lang, state, lease_until)
     values (gen_random_uuid(), $1, $2, 'x', 'a…@friend.example.com', 'k', 'x', 'de', $3, $4) returning id`,
    [kind, userId, state, state === 'sending' ? new Date(Date.now() + 60_000) : null]).then((r) => r.rows[0]!.id);

  beforeAll(async () => {
    env = await makeEnv();
    anna = await addUser('sub-anna', ANNA, 'Anna Beispiel');
    ben = await addUser('sub-ben', BEN, 'Ben Muster');
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
    await env.pool.query('delete from mail_outbox');
    await env.pool.query('delete from user_prefs where user_id = any($1)', [[anna, ben]]);
    await env.pool.query("update users set email = case when id = $1 then $2 else $3 end, disabled = false, access_until = null, role = 'friend' where id = any($4)", [anna, ANNA, BEN, [anna, ben]]);
    await env.pool.query('delete from profile_prefs where profile_id = any($1)', [[anna, ben]]);
  });
  afterEach(() => {
    env.ctx.cfg = cfg;
  });

  it('types', () => {
    expect(PERSON_MAIL_TYPES).toEqual(['available', 'recording', 'licence', 'digest']);
    expect(ADMIN_MAIL_TYPES).toEqual(['update', 'updatefailed', 'syscheck', 'storage']);
    expect(MAIL_PREF_TYPES).toEqual([...PERSON_MAIL_TYPES, ...ADMIN_MAIL_TYPES]);
    expect(MAIL_PREF_DEFAULTS).toEqual(DEFAULTS);
    expect(Object.isFrozen(MAIL_PREF_DEFAULTS)).toBe(true);
    // letters only: the unsubscribe token's type field is [a-z]{1,20}
    for (const t of MAIL_PREF_TYPES) expect(t).toMatch(/^[a-z]{1,20}$/);
    expect(isMailPrefType('licence')).toBe(true);
    expect(isMailPrefType('digest')).toBe(true);
    expect(isMailPrefType('storage')).toBe(true);
    expect(isMailPrefType('welcome')).toBe(false);
    expect(isMailPrefType(7)).toBe(false);
    for (const t of ADMIN_MAIL_TYPES) expect(isAdminMailType(t)).toBe(true);
    for (const t of [...PERSON_MAIL_TYPES, 'welcome', 'admin', 7, null]) expect(isAdminMailType(t)).toBe(false);
  });

  it('prefs default: digest off, everything else on', async () => {
    expect(await readMailPrefs(env.ctx, anna)).toEqual({
      available: true, recording: true, licence: true, digest: false, update: true, updatefailed: true, syscheck: true, storage: true,
    });
    // non-boolean values and unknown keys are ignored (the default stays)
    await env.pool.query('insert into user_prefs(user_id, data) values ($1, $2)', [anna, JSON.stringify({ mail: { available: 'no', digest: 'yes', weekly: false, licence: false, storage: false } })]);
    expect(await readMailPrefs(env.ctx, anna)).toEqual({ ...DEFAULTS, licence: false, storage: false });
    await setMailPref(env.ctx, anna, 'digest', true);
    expect((await readMailPrefs(env.ctx, anna)).digest).toBe(true);
  });

  it('setMailPref merges and keeps other user_prefs keys', async () => {
    await env.pool.query('insert into user_prefs(user_id, data) values ($1, $2)', [anna, JSON.stringify({ weeklyDigest: false, ntfyTopic: 'anna-kino' })]);
    expect(await setMailPref(env.ctx, anna, 'recording', false)).toEqual({ ...DEFAULTS, recording: false });
    expect(await setMailPref(env.ctx, anna, 'licence', false)).toEqual({ ...DEFAULTS, recording: false, licence: false });
    const data = (await userPrefs(anna))!;
    expect(data.weeklyDigest).toBe(false);
    expect(data.ntfyTopic).toBe('anna-kino');
    expect((data.mail as Record<string, boolean>).recording).toBe(false);
    expect((data.mail as Record<string, boolean>).licence).toBe(false);
    // no row yet: one is inserted
    expect(await setMailPref(env.ctx, ben, 'available', false)).toEqual({ ...DEFAULTS, available: false });
    expect(await userPrefs(ben)).toEqual({ mail: { available: false } });
  });

  it('switching a type off drops its queued mail', async () => {
    const avail = await insertRow(anna, 'available', 'queued');
    const rec = await insertRow(anna, 'recording', 'queued');
    const sending = await insertRow(anna, 'recording', 'sending');
    const benRec = await insertRow(ben, 'recording', 'queued');
    await setMailPref(env.ctx, anna, 'recording', false);
    const ids = (await env.pool.query<{ id: string }>('select id from mail_outbox')).rows.map((r) => r.id).sort();
    expect(ids).toEqual([avail, sending, benRec].sort());
    expect(ids).not.toContain(rec);
  });

  it('PUT /api/prefs keeps the mail switches', async () => {
    const s = await env.login();
    const owner = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
    await setMailPref(env.ctx, owner, 'licence', false);
    const r = await env.app.inject({ method: 'PUT', url: '/api/prefs', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: prefsSchema.parse({}) });
    expect(r.statusCode, r.body).toBe(200);
    expect((await readMailPrefs(env.ctx, owner)).licence).toBe(false);
  });

  it('mailRecipient', async () => {
    await env.pool.query("insert into profile_prefs(profile_id, data) values ($1, '{\"language\": \"en\"}')", [anna]);
    expect(await mailRecipient(env.ctx, anna, 'available')).toEqual({ to: ANNA, lang: 'en', name: 'Anna Beispiel' });
    // no address, an invalid one, a disabled account
    await env.pool.query('update users set email = null where id = $1', [anna]);
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    await env.pool.query("update users set email = 'not-an-address' where id = $1", [anna]);
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    await env.pool.query('update users set email = $2, disabled = true where id = $1', [anna, ANNA]);
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    expect(await mailRecipient(env.ctx, anna, 'welcome')).toBeNull();
    await env.pool.query('update users set disabled = false where id = $1', [anna]);
    // access ended (not yet locked by the expiry tick): no mail, welcome included; access still running: mail
    await env.pool.query("update users set access_until = now() - interval '1 minute' where id = $1", [anna]);
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    expect(await mailRecipient(env.ctx, anna, 'welcome')).toBeNull();
    await env.pool.query("update users set access_until = now() + interval '1 day' where id = $1", [anna]);
    expect(await mailRecipient(env.ctx, anna, 'available')).toEqual({ to: ANNA, lang: 'en', name: 'Anna Beispiel' });
    expect(await mailRecipient(env.ctx, anna, 'welcome')).toEqual({ to: ANNA, lang: 'en', name: 'Anna Beispiel' });
    // mail not set up, no public URL
    env.ctx.cfg = { ...cfg, ...MAIL_CFG, MAIL_SMTP_HOST: undefined };
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    env.ctx.cfg = { ...cfg, ...MAIL_CFG, PUBLIC_URL: '' };
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    env.ctx.cfg = { ...cfg, ...MAIL_CFG, PUBLIC_URL: 'not a url' };
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
    // type switched off; welcome has no switch
    for (const t of MAIL_PREF_TYPES) await setMailPref(env.ctx, anna, t, false);
    expect(await mailRecipient(env.ctx, anna, 'available')).toBeNull();
    expect(await mailRecipient(env.ctx, anna, 'licence')).toBeNull();
    expect(await mailRecipient(env.ctx, anna, 'welcome')).toEqual({ to: ANNA, lang: 'en', name: 'Anna Beispiel' });
    // an unknown user
    expect(await mailRecipient(env.ctx, randomUUID(), 'welcome')).toBeNull();
    // the instance default without an own choice
    expect((await mailRecipient(env.ctx, ben, 'recording'))!.lang).toBe('de');
  });

  it('admin types never reach a non-admin', async () => {
    // Ben is a friend whose stored admin switch says on (stored while he was admin, or written by hand): still no admin mail
    await env.pool.query('insert into user_prefs(user_id, data) values ($1, $2)', [ben, JSON.stringify({ mail: { update: true } })]);
    for (const t of ADMIN_MAIL_TYPES) expect(await mailRecipient(env.ctx, ben, t)).toBeNull();
    // his person mails are unaffected
    expect(await mailRecipient(env.ctx, ben, 'available')).toEqual({ to: BEN, lang: 'de', name: 'Ben Muster' });
    expect(await mailPerson(env.ctx, ben, 'update', { title: 'x' }, 'n:update-ben')).toBeNull();
    // Anna is an admin
    await env.pool.query("update users set role = 'admin' where id = $1", [anna]);
    expect(await mailRecipient(env.ctx, anna, 'update')).toEqual({ to: ANNA, lang: 'de', name: 'Anna Beispiel' });
    for (const t of ADMIN_MAIL_TYPES) expect(await mailRecipient(env.ctx, anna, t)).not.toBeNull();
    // her switch decides
    await setMailPref(env.ctx, anna, 'syscheck', false);
    expect(await mailRecipient(env.ctx, anna, 'syscheck')).toBeNull();
    // a disabled admin, an admin whose access ended
    await env.pool.query('update users set disabled = true where id = $1', [anna]);
    expect(await mailRecipient(env.ctx, anna, 'update')).toBeNull();
    await env.pool.query("update users set disabled = false, access_until = now() - interval '1 minute' where id = $1", [anna]);
    expect(await mailRecipient(env.ctx, anna, 'update')).toBeNull();
    expect((await env.pool.query('select 1 from mail_outbox')).rowCount).toBe(0);
  });

  it('personMailBlock answers not_admin after a demotion', async () => {
    await env.pool.query("update users set role = 'admin' where id = $1", [anna]);
    expect(await mailPerson(env.ctx, anna, 'update', { title: 'x' }, 'n:update-anna')).toEqual(expect.any(String));
    const key = recipientKey(env.ctx.encKey, ANNA);
    expect(await personMailBlock(env.ctx, anna, 'update', key)).toBeNull();
    await env.pool.query("update users set role = 'friend' where id = $1", [anna]);
    for (const t of ADMIN_MAIL_TYPES) expect(await personMailBlock(env.ctx, anna, t, key)).toBe('not_admin');
    // person mails of the demoted account still go out
    expect(await personMailBlock(env.ctx, anna, 'available', key)).toBeNull();
    expect(await personMailBlock(env.ctx, anna, 'welcome', key)).toBeNull();
    // an inactive account stays `inactive`
    await env.pool.query('update users set disabled = true where id = $1', [anna]);
    expect(await personMailBlock(env.ctx, anna, 'update', key)).toBe('inactive');
  });

  it('mailPerson queues once per dedupe key', async () => {
    const params = { title: { key: 'notify.available.title', params: { title: 'Nordlicht TV' } } };
    const id = await mailPerson(env.ctx, anna, 'available', params, 'n:avail-7');
    expect(id).toEqual(expect.any(String));
    expect(await mailPerson(env.ctx, anna, 'available', params, 'n:avail-7')).toBeNull();
    const rows = (await env.pool.query<{ id: string; kind: string; user_id: string; rcpt_mask: string; rcpt_enc: string; params_enc: string; dedupe: string }>(
      'select id, kind, user_id, rcpt_mask, rcpt_enc, params_enc, dedupe from mail_outbox')).rows;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({ id, kind: 'available', user_id: anna, rcpt_mask: 'a…@friend.example.com', dedupe: 'n:avail-7' });
    expect(r.params_enc).not.toContain('Nordlicht');
    expect(r.params_enc.startsWith('{')).toBe(false);
    expect(r.rcpt_enc).not.toContain('anna@');
    // nobody to mail: no row
    await setMailPref(env.ctx, ben, 'available', false);
    expect(await mailPerson(env.ctx, ben, 'available', params, 'n:avail-8')).toBeNull();
    expect((await env.pool.query('select 1 from mail_outbox')).rowCount).toBe(1);
  });
});

describe('unsubscribe token', () => {
  const k = Buffer.alloc(32, 7);
  const anna = '0b6f3c1e-2d4a-4f7b-9c1d-5e8f7a6b3c21';
  const ben = '7c2e9a14-5b3d-4e8f-a1c6-2d9b8e7f4a13';

  it('token round-trip', () => {
    const t = unsubscribeToken(k, anna, 'licence');
    expect(t).toMatch(/^v1\.[0-9a-f-]{36}\.licence\.[A-Za-z0-9_-]{43}$/);
    expect(verifyUnsubscribeToken(k, t)).toEqual({ userId: anna, type: 'licence' });
    for (const type of MAIL_PREF_TYPES) expect(verifyUnsubscribeToken(k, unsubscribeToken(k, ben, type))).toEqual({ userId: ben, type });
  });

  it('token round-trip for the new types', () => {
    expect(verifyUnsubscribeToken(k, unsubscribeToken(k, anna, 'updatefailed'))).toEqual({ userId: anna, type: 'updatefailed' });
    expect(verifyUnsubscribeToken(k, unsubscribeToken(k, anna, 'digest'))).toEqual({ userId: anna, type: 'digest' });
    for (const type of ADMIN_MAIL_TYPES) expect(unsubscribeToken(k, ben, type)).toMatch(new RegExp(`^v1\\.[0-9a-f-]{36}\\.${type}\\.[A-Za-z0-9_-]{43}$`));
  });

  it('verify rejects tampered tokens', () => {
    const t = unsubscribeToken(k, anna, 'licence');
    const mac = t.split('.')[3]!;
    expect(verifyUnsubscribeToken(k, `v1.${ben}.licence.${mac}`)).toBeNull();
    expect(verifyUnsubscribeToken(k, `v1.${anna}.available.${mac}`)).toBeNull();
    expect(verifyUnsubscribeToken(k, t.slice(0, -1))).toBeNull();
    expect(verifyUnsubscribeToken(k, unsubscribeToken(Buffer.alloc(32, 8), anna, 'licence'))).toBeNull();
    expect(verifyUnsubscribeToken(k, `v2.${t.slice(3)}`)).toBeNull();
    expect(verifyUnsubscribeToken(k, `v1.${anna}.digest.${mac}`)).toBeNull();
    expect(verifyUnsubscribeToken(k, `v1.${anna}.storage.${mac}`)).toBeNull();
    expect(verifyUnsubscribeToken(k, 'a'.repeat(2000))).toBeNull();
    expect(verifyUnsubscribeToken(k, '')).toBeNull();
    expect(verifyUnsubscribeToken(k, `${t}.x`)).toBeNull();
    expect(verifyUnsubscribeToken(k, ` ${t}`)).toBeNull();
    expect(verifyUnsubscribeToken(k, `${t}\n`)).toBeNull();
    // an uppercase id, even with a valid mac for it
    const upper = anna.toUpperCase();
    const macUpper = createHmac('sha256', mailSubkey(k, 'unsubscribe')).update(`v1|${upper}|licence`).digest('base64url');
    expect(verifyUnsubscribeToken(k, `v1.${upper}.licence.${macUpper}`)).toBeNull();
    // a padded mac, and another encoding of the same 32 bytes (the last character carries 2 unused bits)
    expect(verifyUnsubscribeToken(k, `${t}=`)).toBeNull();
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = B64.indexOf(mac.at(-1)!);
    const twin = `${mac.slice(0, -1)}${B64[last ^ 1]}`;
    expect(Buffer.from(twin, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
    expect(verifyUnsubscribeToken(k, `v1.${anna}.licence.${twin}`)).toBeNull();
  });

  it('unsubscribeUrls', () => {
    const t = unsubscribeToken(k, anna, 'available');
    expect(unsubscribeUrls('https://friend.example.com', t)).toEqual({
      page: `https://friend.example.com/mail/unsubscribe?t=${t}`,
      oneClick: `https://friend.example.com/api/public/mail/unsubscribe?t=${t}`,
    });
  });
});
