// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api';
import { setLocale } from '#lib/i18n';
import { areasOf } from './areas';
import type { MatrixRole, RoleMatrix, RoleTemplateInfo } from './model';
import { createBody, createError, createRole, firstStart, startOptions } from './newRole';

vi.mock('#lib/api', async (orig) => ({ ...(await orig<typeof import('#lib/api')>()), api: vi.fn() }));
beforeEach(() => { vi.mocked(api).mockReset(); });
afterEach(async () => { await setLocale('de'); });

// Roles redesign Task 13: the start points of a new role (spec §4.4, §5.2)
const A = (on: string[]) => ({ library: on.includes('library'), livetv: on.includes('livetv'), requests: on.includes('requests'), together: on.includes('together'), downloads: on.includes('downloads') });
const T = (key: RoleTemplateInfo['key'], base: RoleTemplateInfo['base'], on: string[]): RoleTemplateInfo => ({ key, base, patch: {}, areas: A(on) });
const role = (key: string, label: string, values: Record<string, unknown>): MatrixRole => ({
  key, label, builtinLabel: false, base: 'friend', origin: 'admin', invitable: true, position: 0, accounts: 0, profiles: 0, kidsProfiles: 0,
  values, sources: {}, defaults: values, envGone: false, stored: true, missingLibraries: [], areas: areasOf(values),
});
const matrix = (livetv: boolean): RoleMatrix => ({
  fields: [], features: { requests: true, cast: true, livetv }, libraries: [],
  roles: [role('family', 'Familie', { libraries: 'all', liveTv: true, requests: true, party: true, download: true }), role('kino', 'Kino', { libraries: [], liveTv: false })],
  templates: [
    T('family', 'family', ['library', 'livetv', 'requests', 'together', 'downloads']), T('friend', 'friend', ['library', 'livetv', 'requests', 'together']),
    T('guest', 'guest', ['library', 'livetv', 'requests', 'together']), ...(livetv ? [T('liveOnly', 'friend', ['livetv'])] : []), T('empty', 'guest', []),
  ],
});

describe('startOptions', () => {
  it('the templates the server lists, then the copy; titles and area lines', () => {
    const o = startOptions(matrix(true), 'family');
    expect(o.map((x) => x.key)).toEqual(['family', 'friend', 'guest', 'liveOnly', 'empty', 'copy']);
    expect(o.map((x) => x.title)).toEqual(['Familie', 'Freund', 'Gast', 'Nur Live-TV', 'Leer', 'Kopie von …']);
    expect(o.find((x) => x.key === 'family')!.desc).toBe('Mediathek · Live-TV · Wünsche · Gemeinsam · Downloads');
    expect(o.find((x) => x.key === 'liveOnly')!.desc).toBe('Fernsehsender ohne Mediathek');
    expect(o.find((x) => x.key === 'empty')!.desc).toBe('Alles aus, du schaltest frei');
    // the copy's line: the areas of the role it copies (coupled)
    expect(o.find((x) => x.key === 'copy')!.desc).toBe('Mediathek · Live-TV · Wünsche · Gemeinsam · Downloads');
    expect(startOptions(matrix(true), 'kino').find((x) => x.key === 'copy')!.desc).toBe('Nichts freigegeben');
    expect(startOptions(matrix(true), '').find((x) => x.key === 'copy')!.desc).toBe('');
  });
  it('without Live TV: no Nur Live-TV, and no Live-TV in the lines', () => {
    const o = startOptions(matrix(false), 'family');
    expect(o.map((x) => x.key)).toEqual(['family', 'friend', 'guest', 'empty', 'copy']);
    expect(o[1]!.desc).toBe('Mediathek · Wünsche · Gemeinsam');
  });
  it('an older server without templates: only the copy', () => {
    expect(startOptions({ ...matrix(true), templates: undefined }, 'family').map((x) => x.key)).toEqual(['copy']);
  });
  it('english', async () => {
    await setLocale('en');
    expect(startOptions(matrix(true), 'family').map((x) => x.title)).toEqual(['Family', 'Friend', 'Guest', 'Live TV only', 'Empty', 'Copy of …']);
  });
});

describe('firstStart and the body', () => {
  it('a copy when a source is given (Duplizieren), else Freund (or the first template)', () => {
    expect(firstStart(matrix(true), 'kino')).toBe('copy');
    expect(firstStart(matrix(true))).toBe('friend');
    expect(firstStart({ ...matrix(true), templates: [T('empty', 'guest', [])] })).toBe('empty');
    expect(firstStart({ ...matrix(true), templates: [] })).toBe('copy');
  });
  it('createBody: { label, template } or { label, from }', () => {
    expect(createBody('Hafenblick', 'liveOnly', 'family')).toEqual({ label: 'Hafenblick', template: 'liveOnly' });
    expect(createBody('Oma & Opa', 'copy', 'family')).toEqual({ label: 'Oma & Opa', from: 'family' });
  });
});

describe('createRole', () => {
  it('POSTs the body and returns the new key', async () => {
    vi.mocked(api).mockResolvedValue({ key: 'hafenblick' });
    expect(await createRole({ label: 'Hafenblick', template: 'liveOnly' })).toBe('hafenblick');
    expect(api).toHaveBeenCalledWith('/api/admin/roles', { method: 'POST', body: { label: 'Hafenblick', template: 'liveOnly' } });
  });
  it('passes the API error on; createError names a template that is gone', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError(400, { error: 'template_unavailable' }));
    const e = await createRole({ label: 'X', template: 'liveOnly' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(createError(e)).toBe('Ohne Live-TV gibt es diese Vorlage nicht.');
    expect(createError(new ApiError(409, { error: 'name_taken' }))).toBe(createError(new ApiError(409, {})));
  });
});
