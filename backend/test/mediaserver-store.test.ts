// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db.js';
import { adminPassword, claimAdminPassword, externalKey, idsInUse, readManaged, slugFor, writeManaged } from '../src/mediaserver/store.js';
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

  it('the administrator password is claimed once: a stored one wins, an undecryptable one is replaced', async () => {
    const a = 'A'.repeat(43), b = 'B'.repeat(43), c = 'C'.repeat(43);
    expect(await Promise.all([claimAdminPassword(env.ctx, 'friendflix-admin', a), claimAdminPassword(env.ctx, 'friendflix-admin', b)])).toEqual([a, a]);
    expect(await claimAdminPassword(env.ctx, 'friendflix-admin', c)).toBe(a);
    expect(await readManaged(env.pool)).toMatchObject({ adminUser: 'friendflix-admin', hasPassword: true });
    await env.pool.query("update media_managed set admin_password_enc = 'garbage'");
    expect(await claimAdminPassword(env.ctx, 'friendflix-admin', c)).toBe(c);
    expect(await adminPassword(env.ctx)).toBe(c);
  });

  it('defaults without a row', async () => {
    expect(await readManaged(env.pool)).toEqual({ kind: null, setup: 'none', setupError: null, adminUser: null, hasPassword: false, libraries: [], externalUrl: null, hasExternalKey: false, updatedAt: null,
      migratedFrom: null, move: null, requestsPrev: null });
  });

  it('migration 62 on a database at 61 keeps the row and adds the stage 2 columns', async () => {
    expect(MIGRATIONS[61]).toMatch(/migrated_from/);
    await env.pool.query("insert into media_managed(id, kind, setup, external_url) values (1, 'ferrofin', 'done', 'http://jf.example.com:8096')");
    await env.pool.query('alter table media_managed drop column migrated_from, drop column move, drop column requests_prev');
    await env.pool.query('delete from schema_migrations where version >= 62');
    await migrate(env.pool);
    expect(await readManaged(env.pool)).toMatchObject({ kind: 'ferrofin', setup: 'done', externalUrl: 'http://jf.example.com:8096', migratedFrom: null, move: null, requestsPrev: null });
    // rerunnable
    await env.pool.query('delete from schema_migrations where version >= 62');
    await migrate(env.pool);
    await expect(env.pool.query(`update media_managed set move = '{"phase":"bogus"}'`)).rejects.toThrow(/check/);
    await env.pool.query(`update media_managed set move = '{"phase":"nfo"}'`);
  });

  it('stage 2 fields round-trip; null clears; a stored value of the wrong shape reads as null', async () => {
    const migratedFrom = { name: 'jellyfin', version: '10.10.3', at: '2026-11-24T10:00:00.000Z' };
    const move = { phase: 'copying' as const, error: null, jobId: '0123456789abcdef', startedAt: '2026-11-24T09:00:00.000Z', requestsWarning: false };
    const requestsPrev = { hostname: 'jellyfin', port: 8096, useSsl: false, urlBase: '' };
    await writeManaged(env.ctx, { migratedFrom, move, requestsPrev });
    expect(await readManaged(env.pool)).toMatchObject({ migratedFrom, move, requestsPrev });
    await writeManaged(env.ctx, { move: { ...move, phase: 'failed', error: 'ids_mismatch' } });
    expect((await readManaged(env.pool)).move).toEqual({ ...move, phase: 'failed', error: 'ids_mismatch' });
    // the phase a failed move failed in: kept for a failed move only, and only a phase a move can fail in
    await writeManaged(env.ctx, { move: { ...move, phase: 'failed', error: 'ids_mismatch', failedIn: 'verify' } });
    expect((await readManaged(env.pool)).move).toEqual({ ...move, phase: 'failed', error: 'ids_mismatch', failedIn: 'verify' });
    await env.pool.query(`update media_managed set move = move || '{"failedIn":"done"}'`);
    expect((await readManaged(env.pool)).move?.failedIn).toBeUndefined();
    await env.pool.query(`update media_managed set move = move || '{"failedIn":"nfo","phase":"nfo"}'`);
    expect((await readManaged(env.pool)).move?.failedIn).toBeUndefined();
    // only what the patch names changes
    expect((await readManaged(env.pool)).requestsPrev).toEqual(requestsPrev);
    await writeManaged(env.ctx, { migratedFrom: null, move: null, requestsPrev: null });
    expect(await readManaged(env.pool)).toMatchObject({ migratedFrom: null, move: null, requestsPrev: null });
    // field by field: a row written by another build never reaches a caller with a bad shape
    await env.pool.query(`update media_managed set migrated_from = '{"name":"a/b","version":null,"at":"2026-11-24T10:00:00.000Z"}',
      move = '{"phase":"verify","error":"Bad Code","jobId":"x","startedAt":"2026-11-24T09:00:00.000Z"}', requests_prev = '{"hostname":"jellyfin","port":0,"useSsl":false,"urlBase":""}'`);
    const m = await readManaged(env.pool);
    expect(m.migratedFrom).toBeNull();
    expect(m.move).toEqual({ phase: 'verify', error: null, jobId: null, startedAt: '2026-11-24T09:00:00.000Z', requestsWarning: false });
    expect(m.requestsPrev).toBeNull();
    await env.pool.query(`update media_managed set migrated_from = '{"name":"jellyfin","at":"2026-11-24T10:00:00.000Z"}', move = '{"phase":"done","startedAt":"x"}', requests_prev = '"x"'`);
    expect(await readManaged(env.pool)).toMatchObject({ migratedFrom: { name: 'jellyfin', version: null, at: '2026-11-24T10:00:00.000Z' }, move: null, requestsPrev: null });
  });

  it('a move\'s dead links: only media server user ids, each once, at most 1000; none reads as absent', async () => {
    const move = { phase: 'copying' as const, error: null, jobId: '0123456789abcdef', startedAt: '2026-11-24T09:00:00.000Z', requestsWarning: false };
    const plain = 'a'.repeat(32), dashed = '0123abcd-0123-4567-89ab-0123456789ab';
    await writeManaged(env.ctx, { move });
    await env.pool.query('update media_managed set move = move || $1::jsonb', [JSON.stringify({
      deadLinks: [plain, 'j1', dashed, 42, null, plain, '../x', 'B'.repeat(32), `${'c'.repeat(32)}\n`, '0123abcd0123-4567-89ab-0123456789ab-', { id: plain }],
    })]);
    expect((await readManaged(env.pool)).move!.deadLinks).toEqual([plain, dashed, 'B'.repeat(32)]);
    // a list that is no list, or holds nothing usable: absent
    for (const raw of ['"x"', '{}', '["j1"]', '[]']) {
      await env.pool.query(`update media_managed set move = move || jsonb_build_object('deadLinks', $1::jsonb)`, [raw]);
      expect((await readManaged(env.pool)).move, raw).toEqual(move);
    }
    // bounded
    const many = Array.from({ length: 1005 }, (_, i) => i.toString(16).padStart(32, '0'));
    await env.pool.query('update media_managed set move = move || $1::jsonb', [JSON.stringify({ deadLinks: many })]);
    expect((await readManaged(env.pool)).move!.deadLinks).toEqual(many.slice(0, 1000));
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
