// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminPassword, externalKey, idsInUse, readManaged, slugFor, writeManaged } from '../src/mediaserver/store.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await makeEnv(); });
afterAll(async () => { await env.pool.end(); });
beforeEach(async () => { await env.pool.query('delete from media_managed'); });

describe('media_managed', () => {
  it('the migration creates the one-row table', async () => {
    await expect(env.pool.query('insert into media_managed(id) values (2)')).rejects.toThrow(/check/);
    await expect(env.pool.query("insert into media_managed(id, setup) values (1, 'x')")).rejects.toThrow(/check/);
    await expect(env.pool.query("insert into media_managed(id, setup_error) values (1, 'Bad Code')")).rejects.toThrow(/check/);
    await env.pool.query('insert into media_managed(id) values (1)');
    expect((await readManaged(env.pool)).setup).toBe('none');
  });

  it('defaults without a row', async () => {
    expect(await readManaged(env.pool)).toEqual({ kind: null, setup: 'none', setupError: null, adminUser: null, hasPassword: false, libraries: [], externalUrl: null, hasExternalKey: false, updatedAt: null });
  });

  it('round-trip with encrypted secrets', async () => {
    const pw = 'A'.repeat(43);
    const ek = 'k' + 'ey-' + 'x'.repeat(20);
    await writeManaged(env.ctx, { kind: 'ferrofin', setup: 'first_run', adminUser: 'friendflix-admin', adminPassword: pw, externalUrl: 'http://jf.example.com:8096', externalKey: ek,
      libraries: [{ slug: 'filme', name: 'Filme', type: 'movies', rel: 'Filme', created: false }] });
    const raw = (await env.pool.query<{ admin_password_enc: string; external_key_enc: string }>('select admin_password_enc, external_key_enc from media_managed')).rows[0]!;
    expect(raw.admin_password_enc).not.toBe(pw);
    expect(raw.admin_password_enc).not.toContain(pw);
    expect(raw.external_key_enc).not.toContain(ek);
    expect(await adminPassword(env.ctx)).toBe(pw);
    expect(await externalKey(env.ctx)).toBe(ek);
    const m = await readManaged(env.pool);
    expect(m).toMatchObject({ kind: 'ferrofin', setup: 'first_run', adminUser: 'friendflix-admin', hasPassword: true, hasExternalKey: true, externalUrl: 'http://jf.example.com:8096',
      libraries: [{ slug: 'filme', name: 'Filme', type: 'movies', rel: 'Filme', created: false }] });
    expect(JSON.stringify(m)).not.toContain(pw);
    expect(m.updatedAt).toMatch(/^\d{4}-/);
    // a patch changes only what it names; null clears
    await writeManaged(env.ctx, { setup: 'failed', setupError: 'start_failed', adminPassword: null });
    const n = await readManaged(env.pool);
    expect(n).toMatchObject({ kind: 'ferrofin', setup: 'failed', setupError: 'start_failed', hasPassword: false, hasExternalKey: true });
    expect(await adminPassword(env.ctx)).toBeNull();
    await writeManaged(env.ctx, {});
    expect((await readManaged(env.pool)).setup).toBe('failed');
  });

  it('slugFor', () => {
    expect(slugFor('Filme & Serien', new Set())).toBe('filme-serien');
    expect(slugFor('Kinderfilme', new Set(['kinderfilme']))).toBe('kinderfilme-2');
    expect(slugFor('Kinderfilme', new Set(['kinderfilme', 'kinderfilme-2']))).toBe('kinderfilme-3');
    expect(slugFor('Über uns', new Set())).toBe('ueber-uns');
    expect(slugFor('Straße Öl Äpfel', new Set())).toBe('strasse-oel-aepfel');
    expect(slugFor('!!!', new Set())).toBe('bibliothek');
    expect(slugFor('a'.repeat(70), new Set())).toBe('a'.repeat(40));
    expect(slugFor('a'.repeat(70), new Set(['a'.repeat(40)]))).toBe(`${'a'.repeat(38)}-2`);
  });

  it('ids in use', async () => {
    const user = (id: string, jf: string) => env.pool.query(
      "insert into users(id, authentik_sub, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1::uuid, $1::text, 'Anna Beispiel', 'user', $2, 'anna', 'x')", [id, jf]);
    await env.pool.query('delete from profiles; delete from users');
    expect(await idsInUse(env.pool)).toBe(false);
    await user('00000000-0000-4000-8000-000000000001', 'j1');
    expect(await idsInUse(env.pool)).toBe(true);
    // only a profile that carries a media server user (its account has none)
    await env.pool.query('delete from profiles; delete from users');
    await user('00000000-0000-4000-8000-000000000002', '');
    await env.pool.query("insert into profiles(id, user_id, name, is_owner) values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Ben', true)");
    expect(await idsInUse(env.pool)).toBe(false);
    await env.pool.query("insert into profiles(id, user_id, name, jellyfin_user_id) values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'Kind', 'j2')");
    expect(await idsInUse(env.pool)).toBe(true);
  });
});
