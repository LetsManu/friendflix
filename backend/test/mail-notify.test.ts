// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { m } from '../src/i18n.js';
import * as outbox from '../src/mail/outbox.js';
import { MAIL_PREF_TYPES, mailRecipient, setMailPref } from '../src/mail/people.js';
import { notify, notifyAdmins, type Notice } from '../src/notify.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Mail stage B, Task 2: mail as the fourth channel of notify(). A notice with `mail` and a dedupe key queues one outbox row of that
// type for the person, after its in-app row was created; any mail failure leaves the notice alone.
const ANNA = 'anna@friend.example.com';
const MAIL_CFG: Partial<Config> = { MAIL_SMTP_HOST: 'mail.example.com', MAIL_FROM: 'kino@friend.example.com', PUBLIC_URL: 'https://friend.example.com' };

describe('notify mails a notice', () => {
  let env: TestEnv;
  let anna: string;

  const notices = async () => (await env.pool.query<{ kind: string; dedupe: string | null }>('select kind, dedupe from notifications where user_id = $1', [anna])).rows;
  const mails = async () => (await env.pool.query<{ kind: string; dedupe: string | null; lang: string; user_id: string | null; params_enc: string }>(
    'select kind, dedupe, lang, user_id, params_enc from mail_outbox order by created_at')).rows;
  const notice = (o: Partial<Notice> = {}): Notice => ({
    userId: anna, kind: 'available', title: m('title.available', { title: 'Nordlicht' }), link: '/requests', dedupe: 'avail-7', mail: 'available', ...o,
  });

  beforeAll(async () => {
    env = await makeEnv();
    anna = randomUUID();
    await env.pool.query(
      "insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, 'sub-anna', $2, 'Anna Beispiel', 'friend', $3, 'anna', $4)",
      [anna, ANNA, 'sub-anna'.padEnd(32, '0'), encrypt(env.ctx.encKey, 'pw')]);
    await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [anna, 'Anna Beispiel']);
    await env.pool.query("insert into profile_prefs(profile_id, data) values ($1, '{\"language\": \"en\"}')", [anna]);
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...cfg, ...MAIL_CFG };
    await env.pool.query('delete from mail_outbox');
    await env.pool.query('delete from notifications');
    await env.pool.query('delete from user_prefs where user_id = $1', [anna]);
    await env.pool.query('update users set email = $2 where id = $1', [anna, ANNA]);
  });
  afterEach(() => {
    env.ctx.cfg = cfg;
    vi.restoreAllMocks();
  });

  it('notice with mail queues one row of that kind', async () => {
    expect(await notify(env.ctx, notice())).toBe(true);
    expect(await notices()).toEqual([{ kind: 'available', dedupe: 'avail-7' }]);
    const rows = await mails();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'available', dedupe: 'n:avail-7', lang: 'en', user_id: anna });
    // the notice's texts travel as messages, rendered at send time
    expect(JSON.parse(decrypt(env.ctx.encKey, rows[0]!.params_enc))).toEqual({
      title: { key: 'title.available', params: { title: 'Nordlicht' } }, body: null, link: '/requests',
    });
  });

  it('the same notice twice mails once', async () => {
    expect(await notify(env.ctx, notice())).toBe(true);
    expect(await notify(env.ctx, notice())).toBe(false);
    expect(await notices()).toHaveLength(1);
    expect(await mails()).toHaveLength(1);
  });

  it('no mail without dedupe, without userId, with the type off, without address, when not configured', async () => {
    expect(await notify(env.ctx, notice({ dedupe: undefined }))).toBe(true);
    expect(await notify(env.ctx, notice({ userId: null, dedupe: 'avail-bc' }))).toBe(true);
    expect(await notify(env.ctx, notice({ mail: undefined, dedupe: 'avail-nomail' }))).toBe(true);
    await setMailPref(env.ctx, anna, 'available', false);
    expect(await notify(env.ctx, notice({ dedupe: 'avail-off' }))).toBe(true);
    await setMailPref(env.ctx, anna, 'available', true);
    await env.pool.query('update users set email = null where id = $1', [anna]);
    expect(await notify(env.ctx, notice({ dedupe: 'avail-noaddr' }))).toBe(true);
    await env.pool.query('update users set email = $2 where id = $1', [anna, ANNA]);
    env.ctx.cfg = cfg;
    expect(await notify(env.ctx, notice({ dedupe: 'avail-nocfg' }))).toBe(true);
    expect(await notices()).toHaveLength(5);
    expect((await env.pool.query("select 1 from notifications where user_id is null and dedupe = 'avail-bc'")).rowCount).toBe(1);
    expect(await mails()).toEqual([]);
  });

  // Mail stage B, Task 3 (Controller's call 7): mail is account level. An event of a kids profile is notified to the account, so it
  // mails the account's address in the account's language; a kids profile's own prefs are no mail switches, and a profile id is no
  // account that could be mailed.
  it('a notice of a kids profile mails the account address; the kids profile has no switches of its own', async () => {
    const kids = randomUUID();
    await env.pool.query("insert into profiles(id, user_id, name, is_owner, kids, jellyfin_user_id) values ($1, $2, 'Mika', false, true, 'kids-jf-0001')", [kids, anna]);
    await env.pool.query(`insert into profile_prefs(profile_id, data) values ($1, '{"language": "fr", "mail": {"available": false}}')`, [kids]);
    try {
      expect(await notify(env.ctx, notice({ dedupe: 'avail-kids' }))).toBe(true);
      const rows = (await env.pool.query<{ kind: string; user_id: string; lang: string; rcpt_mask: string; rcpt_enc: string }>(
        'select kind, user_id, lang, rcpt_mask, rcpt_enc from mail_outbox')).rows;
      expect(rows.map(({ rcpt_enc: _, ...r }) => r)).toEqual([{ kind: 'available', user_id: anna, lang: 'en', rcpt_mask: 'a…@friend.example.com' }]);
      expect(decrypt(env.ctx.encKey, rows[0]!.rcpt_enc)).toBe(ANNA);
      expect(await mailRecipient(env.ctx, kids, 'available')).toBeNull();
    } finally {
      await env.pool.query('delete from profiles where id = $1', [kids]);
    }
  });

  // Mail stage C, Task 1: an admin notice with `mail` mails every admin whose switch is on; a friend gets neither notice nor mail.
  it('notifyAdmins with mail queues one row per admin with the switch on', async () => {
    const add = async (sub: string, email: string, name: string, role: 'admin' | 'friend') => {
      const id = randomUUID();
      await env.pool.query(
        'insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, sub, email, name, role, sub.padEnd(32, '0'), sub, encrypt(env.ctx.encKey, 'pw')]);
      await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name]);
      return id;
    };
    const ben = await add('sub-ben', 'ben@friend.example.com', 'Ben Muster', 'friend');
    const carla = await add('sub-carla', 'carla@friend.example.com', 'Carla Muster', 'admin');
    await env.pool.query("update users set role = 'admin' where id = $1", [anna]);
    try {
      await setMailPref(env.ctx, carla, 'storage', false);
      // a friend's stored admin switch does not count
      await env.pool.query('insert into user_prefs(user_id, data) values ($1, $2)', [ben, JSON.stringify({ mail: { storage: true } })]);
      const sent = await notifyAdmins(env.ctx, { kind: 'livetv.rec.storage', title: 'x', link: '/admin/livetv', dedupe: 'ltvrec-storage-2026-11-16', mail: 'storage' });
      expect(sent).toBe(2);
      const inApp = (await env.pool.query<{ user_id: string }>("select user_id from notifications where kind = 'livetv.rec.storage'")).rows.map((r) => r.user_id).sort();
      expect(inApp).toEqual([anna, carla].sort());
      expect(inApp).not.toContain(ben);
      const rows = await mails();
      expect(rows.map(({ kind, dedupe, user_id }) => ({ kind, dedupe, user_id }))).toEqual([
        { kind: 'storage', dedupe: `n:ltvrec-storage-2026-11-16-${anna}`, user_id: anna },
      ]);
      expect(JSON.parse(decrypt(env.ctx.encKey, rows[0]!.params_enc))).toEqual({ title: 'x', body: null, link: '/admin/livetv' });
      // the same alert again: neither a notice nor a mail
      expect(await notifyAdmins(env.ctx, { kind: 'livetv.rec.storage', title: 'x', link: '/admin/livetv', dedupe: 'ltvrec-storage-2026-11-16', mail: 'storage' })).toBe(0);
      expect(await mails()).toHaveLength(1);
    } finally {
      await env.pool.query("update users set role = 'friend' where id = $1", [anna]);
      await env.pool.query('delete from users where id = any($1)', [[ben, carla]]);
    }
  });

  it('a mail failure never fails notify', async () => {
    vi.spyOn(outbox, 'enqueueMail').mockRejectedValue(new Error('outbox down'));
    expect(await notify(env.ctx, notice())).toBe(true);
    expect(outbox.enqueueMail).toHaveBeenCalledTimes(1);
    expect(await notices()).toEqual([{ kind: 'available', dedupe: 'avail-7' }]);
    expect(await mails()).toEqual([]);
  });
});

/**
 * The notice objects handed to notify() / notifyAdmins() in backend/src, each with its top-level text (nested objects, arrays and
 * calls cut out), so a key of the notice itself can be told from a key deeper inside it.
 */
function noticeLiterals(): Array<{ file: string; top: string }> {
  const out: Array<{ file: string; top: string }> = [];
  const src = join(__dirname, '../src');
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const text = readFileSync(join(src, file), 'utf8');
    for (const m of text.matchAll(/\bnotify(?:Admins)?\(\s*[\w.]+\s*,\s*\{/g)) {
      let depth = 0;
      let top = '';
      for (let i = m.index + m[0].length - 1; i < text.length; i++) {
        const ch = text[i]!;
        if ('{[('.includes(ch)) depth++;
        else if ('}])'.includes(ch)) depth--;
        else if (depth === 1) top += ch;
        if (depth === 0) break;
      }
      out.push({ file, top });
    }
  }
  return out;
}

describe('every mailed notice has a dedupe key', () => {
  // notify() mails only a notice with a dedupe key (Controller's call 3): a notice that sets `mail` without one would silently never
  // mail. This scan keeps every mailing call site honest.
  it('each notify() call that sets mail also sets dedupe', () => {
    const all = noticeLiterals();
    expect(all.length).toBeGreaterThan(20);
    const mailing = all.filter((n) => /(^|[\s,])mail:/.test(n.top));
    // wish available, recording failed/partial, series episode, recording done, recording to be deleted, licences expiring; the admin
    // alerts (update available, update failed, Portainer redeploy failed, Systemcheck problem, disk full) and both recordings-storage notices
    expect(mailing.map((n) => n.file).sort()).toEqual([
      'adminAlerts.ts', 'adminAlerts.ts', 'adminAlerts.ts', 'adminAlerts.ts', 'adminAlerts.ts', 'downloadExpiry.ts',
      'livetv/recsched.ts', 'livetv/recsched.ts', 'livetv/recsched.ts', 'livetv/recsched.ts', 'livetv/recstore.ts', 'livetv/recstore.ts', 'routes/seerr.ts',
    ]);
    for (const n of mailing) expect(n.top, n.file).toMatch(/(^|[\s,])dedupe:/);
  });

  it('no mail type is set outside a notify() call literal', () => {
    // a notice object built elsewhere and handed over by name would escape the check above: every `mail: '<type>'` (also behind a
    // condition) outside src/mail must be one of the literals it checked
    const src = join(__dirname, '../src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.startsWith('mail/'));
    const typed = new RegExp(`\\bmail: (?:[^,}\\n]*\\? )?'(?:${MAIL_PREF_TYPES.join('|')})'`, 'g');
    const sites = files.flatMap((f) => [...readFileSync(join(src, f), 'utf8').matchAll(typed)].map(() => f));
    expect(sites.sort()).toEqual(noticeLiterals().filter((n) => /(^|[\s,])mail:/.test(n.top)).map((n) => n.file).sort());
  });
});
