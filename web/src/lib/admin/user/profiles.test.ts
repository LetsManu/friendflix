// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api';
import { setLocale } from '#lib/i18n';
import { CAPS, MAX_PROFILES, profileError, reloadAfter } from './profiles';

afterEach(async () => { await setLocale('de'); });
const err = (status: number, error: string) => new ApiError(status, { error });

describe('kids profile admin', () => {
  it('knows the backend limits', () => {
    expect(MAX_PROFILES).toBe(5);
    expect(CAPS).toEqual([0, 6, 12]);
  });

  it('answers every backend error code with its own honest text', () => {
    expect(profileError(err(409, 'max_profiles'), 'create')).toBe('Ein Konto kann höchstens 5 Profile haben.');
    expect(profileError(err(409, 'name_taken'), 'create')).toBe('Diesen Namen hat schon ein anderes Profil.');
    expect(profileError(err(409, 'deletion_in_progress'), 'update')).toBe('Dieses Konto wird gerade gelöscht. Seine Profile lassen sich nicht mehr ändern.');
    expect(profileError(err(400, 'owner_not_kids'), 'update')).toBe('Das Hauptprofil kann kein Kinderprofil sein.');
    expect(profileError(err(400, 'not_kids'), 'update')).toBe('Eine Altersgrenze gibt es nur bei Kinderprofilen.');
    expect(profileError(err(400, 'owner_profile'), 'delete')).toBe('Das Hauptprofil lässt sich nicht löschen.');
    expect(profileError(err(400, 'owner_not_deletable'), 'delete')).toBe('Das Hauptprofil lässt sich nicht löschen.');
    expect(profileError(err(400, 'not_kids_profile'), 'delete')).toMatch(/Nur Kinderprofile/);
    expect(profileError(err(404, 'not_found'), 'delete')).toBe('Dieses Profil gibt es nicht mehr.');
  });

  it('a media server refusal reads differently per action (an update is stored anyway)', () => {
    expect(profileError(err(502, 'jellyfin'), 'update')).toMatch(/gespeichert/i);
    // the repair button's own label, never a quoted copy that can drift from it
    expect(profileError(err(502, 'jellyfin'), 'update')).toContain('„Verknüpfungen reparieren“');
    expect(profileError(err(502, 'jellyfin'), 'create')).toMatch(/nicht angelegt/);
    expect(profileError(err(502, 'jellyfin'), 'delete')).toMatch(/nicht gelöscht/);
  });

  it('falls back to the generic text and never leaks a code', () => {
    expect(profileError(err(500, 'boom'), 'update')).toBe('Serverfehler. Bitte später noch einmal versuchen.');
    expect(profileError(new TypeError('x'), 'create')).not.toMatch(/boom|TypeError/);
  });

  it('reloads after what changed anyway or is already gone', () => {
    expect(reloadAfter(err(502, 'jellyfin'), 'update')).toBe(true);
    expect(reloadAfter(err(502, 'jellyfin'), 'create')).toBe(false);
    expect(reloadAfter(err(404, 'not_found'), 'delete')).toBe(true);
    expect(reloadAfter(err(409, 'deletion_in_progress'), 'update')).toBe(true);
    expect(reloadAfter(err(409, 'name_taken'), 'update')).toBe(false);
  });

  it('speaks every language (no text falls back to German)', async () => {
    const codes = ['max_profiles', 'deletion_in_progress', 'owner_not_kids', 'not_kids', 'owner_profile', 'not_kids_profile', 'not_found', 'jellyfin'];
    const de = codes.map((c) => profileError(err(409, c), 'update'));
    for (const l of ['en', 'es', 'fr', 'it', 'pl', 'tr'] as const) {
      await setLocale(l);
      codes.forEach((c, i) => expect(profileError(err(409, c), 'update'), `${l} ${c}`).not.toBe(de[i]));
    }
  });
});
