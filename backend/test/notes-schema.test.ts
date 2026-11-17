// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { m } from '../src/i18n.js';
import { MIGRATIONS } from '../src/db.js';
import { notify } from '../src/notify.js';
import { CATEGORIES, categoryOf, groupKey, NEVER_GROUPED } from '../src/notifications/categories.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(() => env.close());

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

/** Kinds that no category claims on purpose. */
const OTHER_ALLOWED: string[] = [];

describe('categoryOf', () => {
  it('maps every kind used in backend/src', () => {
    const kinds = new Set<string>();
    for (const f of walk(join(import.meta.dirname, '../src'))) {
      const src = readFileSync(f, 'utf8');
      for (const call of src.matchAll(/\bnotify(?:Admins)?\(/g)) {
        const hit = /kind:\s*'([^']+)'/.exec(src.slice(call.index, call.index + 400));
        if (hit) kinds.add(hit[1]!);
      }
    }
    expect(kinds.size).toBeGreaterThan(10);
    const other = [...kinds].filter((k) => categoryOf(k) === 'other' && !OTHER_ALLOWED.includes(k));
    expect(other).toEqual([]);
  });
  it('maps the dynamic kinds and the documented prefixes', () => {
    expect(categoryOf('request_approve')).toBe('requests');
    expect(categoryOf('request_decline')).toBe('requests');
    expect(categoryOf('media_declined')).toBe('requests');
    expect(categoryOf('media_available')).toBe('requests');
    expect(categoryOf('download_ready')).toBe('downloads');
    expect(categoryOf('livetv.rec.done')).toBe('livetv');
    expect(categoryOf('something_new')).toBe('other');
    expect(CATEGORIES).toEqual(['downloads', 'devices', 'series', 'achievements', 'livetv', 'system', 'requests', 'social', 'other']);
    for (const k of NEVER_GROUPED) expect(categoryOf(k)).not.toBe('other');
  });
});

describe('groupKey', () => {
  it('groups by kind and message key, never for single kinds', () => {
    expect(groupKey('tv_paired', m('tv.paired.title', { name: 'Wohnzimmer' }))).toBe(groupKey('tv_paired', m('tv.paired.title', { name: 'Küche' })));
    expect(groupKey('update_available', 'x', 7)).toBe('update_available|id:7');
    expect(() => groupKey('update_available', 'x')).toThrow();
    expect(groupKey('available', 'Neu: A')).toBe('available|Neu: A');
    expect(groupKey('available', 'Neu: A')).not.toBe(groupKey('available', 'Neu: B'));
    expect(groupKey('episode', 'T')).not.toBe(groupKey('digest', 'T'));
    expect(groupKey('digest', { join: [m('tv.paired.title', { name: 'a' }), 'x'], sep: '\n' })).toBe('digest|tv.paired.title+x');
    // a join inside a join contributes nothing (the SQL backfill does the same)
    expect(groupKey('digest', { join: [m('tv.paired.title'), { join: ['a', 'b'] }, 'x'] })).toBe('digest|tv.paired.title++x');
  });
});

describe('notify stores group_key', () => {
  it('backfills old rows and stores equal keys for the same message key', async () => {
    await env.pool.query(
      `insert into notifications(user_id, kind, title, msg, dedupe) values
        (null, 'episode', 'Alt A', null, 'old-1'),
        (null, 'tv_paired', 'Alt B', '{"title":{"key":"tv.paired.title","params":{"name":"x"}}}', 'old-2'),
        (null, 'update_failed', 'Alt C', null, 'old-3'),
        (null, 'digest', 'Alt D', '{"title":{"join":[{"key":"tv.paired.title"},"x"],"sep":"\\n"}}', 'old-4'),
        (null, 'digest', 'Alt E', '{"title":{"join":[{"key":"tv.paired.title"},{"join":["a","b"]},"x"]}}', 'old-5')`,
    );
    // the notifications center migration is the last entry
    expect(MIGRATIONS[MIGRATIONS.length - 1]).toContain('notification_state');
    await env.pool.query(MIGRATIONS[MIGRATIONS.length - 1]!);
    const rows = (await env.pool.query<{ dedupe: string; group_key: string; id: string }>("select id, dedupe, group_key from notifications where dedupe like 'old-%' order by dedupe")).rows;
    expect(rows[0]!.group_key).toBe('episode|Alt A');
    expect(rows[1]!.group_key).toBe('tv_paired|tv.paired.title');
    expect(rows[2]!.group_key).toBe(`update_failed|id:${rows[2]!.id}`);
    expect(rows[3]!.group_key).toBe('digest|tv.paired.title+x');
    expect(rows[4]!.group_key).toBe('digest|tv.paired.title++x');

    await notify(env.ctx, { userId: null, kind: 'tv_paired', title: m('tv.paired.title', { name: 'Wohnzimmer' }), dedupe: 'new-1' });
    await notify(env.ctx, { userId: null, kind: 'tv_paired', title: m('tv.paired.title', { name: 'Küche' }), dedupe: 'new-2' });
    await notify(env.ctx, { userId: null, kind: 'update_failed', title: 'Boom', dedupe: 'new-3' });
    const n = (await env.pool.query<{ dedupe: string; group_key: string; id: string }>("select id, dedupe, group_key from notifications where dedupe like 'new-%' order by dedupe")).rows;
    expect(n[0]!.group_key).toBe('tv_paired|tv.paired.title');
    expect(n[1]!.group_key).toBe(n[0]!.group_key);
    expect(n[2]!.group_key).toBe(`update_failed|id:${n[2]!.id}`);
    expect((await env.pool.query("select 1 from notifications where group_key like '%id:pending'")).rowCount).toBe(0);
  });
});

describe('notification_state', () => {
  it('cascades with the notification and the user', async () => {
    await env.login();
    const u = (await env.pool.query<{ id: string }>('select id from users limit 1')).rows[0]!.id;
    const id = (await env.pool.query<{ id: string }>("insert into notifications(user_id, kind, title, dedupe) values (null,'available_all','x','st-1') returning id")).rows[0]!.id;
    await env.pool.query('insert into notification_state(user_id, notification_id, read_at) values ($1,$2,now())', [u, id]);
    await env.pool.query('delete from notifications where id=$1', [id]);
    expect((await env.pool.query('select 1 from notification_state where notification_id=$1', [id])).rowCount).toBe(0);
    const id2 = (await env.pool.query<{ id: string }>("insert into notifications(user_id, kind, title, dedupe) values (null,'available_all','x','st-2') returning id")).rows[0]!.id;
    await env.pool.query('insert into notification_state(user_id, notification_id, hidden_at) values ($1,$2,now())', [u, id2]);
    await env.pool.query('delete from users where id=$1', [u]);
    expect((await env.pool.query('select 1 from notification_state where notification_id=$1', [id2])).rowCount).toBe(0);
  });
});
