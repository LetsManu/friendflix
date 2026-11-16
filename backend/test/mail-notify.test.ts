// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { m } from '../src/i18n.js';
import * as outbox from '../src/mail/outbox.js';
import { setMailPref } from '../src/mail/people.js';
import { notify, type Notice } from '../src/notify.js';
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

  it('a mail failure never fails notify', async () => {
    vi.spyOn(outbox, 'enqueueMail').mockRejectedValue(new Error('outbox down'));
    expect(await notify(env.ctx, notice())).toBe(true);
    expect(outbox.enqueueMail).toHaveBeenCalledTimes(1);
    expect(await notices()).toEqual([{ kind: 'available', dedupe: 'avail-7' }]);
    expect(await mails()).toEqual([]);
  });
});
