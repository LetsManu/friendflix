// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { auditSentence } from './auditText';

afterEach(async () => { await setLocale('de'); });
const e = (action: string, meta: Record<string, unknown>, extra: { actorName?: string | null; targetName?: string | null; target?: string | null; roleName?: (k: string) => string | null } = {}) =>
  auditSentence({ action, actorName: 'Tester', targetName: null, meta, ...extra });

describe('auditSentence', () => {
  it('role.update: a sentence and a chip per changed field, from → to', () => {
    const r = e('role.update', { from: { maxParentalRating: 12, party: true, maxBitrate: 8_000_000 }, to: { maxParentalRating: 16, party: false, maxBitrate: 20_000_000 } }, { targetName: 'Gast' });
    expect(r.text).toBe('Tester hat die Rolle Gast geändert');
    expect(r.chips).toEqual([
      { label: 'Altersfreigabe', from: 'ab 12', to: 'ab 16' },
      { label: 'Höchste Qualität', from: '8 Mbit/s', to: '20 Mbit/s' },
      { label: 'Watch-Partys', from: 'erlaubt', to: 'nicht erlaubt' },
    ]);
  });
  it('writes no cap and library lists in words; never shows a key of another version', () => {
    const r = e('role.update', { from: { maxHeight: 1080, libraries: ['Filme'], futureThing: 1 }, to: { maxHeight: null, libraries: 'all', futureThing: 2 } }, { targetName: 'Gast' });
    expect(r.chips).toEqual([{ label: 'Bibliotheken', from: '1 Bibliothek', to: 'alle' }, { label: 'Max. Auflösung', from: '1080p', to: 'alle' }]);
    expect(JSON.stringify(r)).not.toMatch(/futureThing|maxHeight|libraries/);
  });
  it('a built-in role without a given name is named in the UI language, in english too', async () => {
    expect(e('role.update', {}, { target: 'guest' }).text).toBe('Tester hat die Rolle Gast geändert');
    await setLocale('en');
    expect(e('role.update', {}, { target: 'guest' }).text).toBe('Tester changed the role Guest');
  });
  it('role.create / delete / order', () => {
    expect(e('role.create', { from: 'family', label: 'Oma & Opa' }, { target: 'oma-opa' }).text).toBe('Tester hat die Rolle Oma & Opa als Kopie von Familie angelegt');
    expect(e('role.create', {}, { targetName: 'Kino' }).text).toBe('Tester hat die Rolle Kino angelegt');
    expect(e('role.delete', { moveTo: 'friend', accounts: 3, invites: 0 }, { targetName: 'Kino' }).text).toBe('Tester hat die Rolle Kino gelöscht, ihre Konten wechselten zu Freund');
    expect(e('role.delete', { moveTo: null }, { targetName: 'Kino' }).text).toBe('Tester hat die Rolle Kino gelöscht');
    expect(e('role.order', { keys: ['admin', 'family'] }).text).toBe('Tester hat die Reihenfolge der Rollen geändert');
  });
  it('user.rights, profile.admin_* and user.check_viewed name the person and show no ids, counts or terms', () => {
    const r = e('user.rights', { from: { cast: false }, to: { cast: true } }, { targetName: 'Anna Beispiel' });
    expect(r.text).toBe('Tester hat die Rechte von Anna Beispiel geändert');
    expect(r.chips).toEqual([{ label: 'Auf Fernseher übertragen', from: 'nicht erlaubt', to: 'erlaubt' }]);
    expect(e('profile.admin_update', { profile: 'p-1', from: {}, to: { name: 'Geheim' } }, { targetName: 'Anna Beispiel' }).text).toBe('Tester hat ein Profil von Anna Beispiel geändert');
    expect(e('profile.admin_create', { profile: 'p-1' }, { targetName: 'Anna Beispiel' }).text).toBe('Tester hat ein Profil für Anna Beispiel angelegt');
    expect(e('profile.admin_delete', { profile: 'p-1' }, { targetName: 'Anna Beispiel' }).text).toBe('Tester hat ein Profil von Anna Beispiel gelöscht');
    const v = e('user.check_viewed', { profile: 'p-1', hits: 4 }, { targetName: 'Anna Beispiel' });
    expect(v.text).toBe('Tester hat die Inhaltsprüfung für Anna Beispiel angesehen');
    expect(v.text).not.toMatch(/p-1|4/);
  });
  it('names every role through the resolver and never prints a key', async () => {
    const names: Record<string, string> = { 'oma-opa': 'Oma & Opa', crew: 'Crew', family: 'Verwandte' };
    const roleName = (k: string) => names[k] ?? null;
    expect(e('role.create', { from: 'oma-opa' }, { targetName: 'Kino', roleName }).text).toBe('Tester hat die Rolle Kino als Kopie von Oma & Opa angelegt');
    expect(e('role.delete', { moveTo: 'crew' }, { targetName: 'Kino', roleName }).text).toBe('Tester hat die Rolle Kino gelöscht, ihre Konten wechselten zu Crew');
    // the resolver beats the built-in word (the label the admin gave)
    expect(e('role.update', {}, { target: 'family', roleName }).text).toBe('Tester hat die Rolle Verwandte geändert');
    // a role that is gone: the entry's own label, else a neutral phrase
    expect(e('role.delete', { moveTo: null, label: 'Kino' }, { target: 'kino', roleName }).text).toBe('Tester hat die Rolle Kino gelöscht');
    const gone = e('role.delete', { moveTo: 'oma-opa-2' }, { target: 'kino-2', roleName });
    expect(gone.text).toBe('Tester hat die Rolle „gelöschte Rolle“ gelöscht, ihre Konten wechselten zu „gelöschte Rolle“');
    expect(gone.text).not.toMatch(/kino-2|oma-opa-2/);
    expect(e('role.create', { from: 'weg-1' }, { target: 'neu-1', roleName }).text).not.toMatch(/weg-1|neu-1/);
    await setLocale('en');
    expect(e('role.update', {}, { target: 'x-gone', roleName }).text).toBe('Tester changed the role “deleted role”');
  });
  it('a rename and the invitable switch show from → to', () => {
    const r = e('role.update', { from: { label: 'Gast', invitable: true, maxStreams: 1 }, to: { label: 'Besucher', invitable: false, maxStreams: 2 } }, { targetName: 'Besucher' });
    expect(r.chips).toEqual([
      { label: 'Gleichzeitige Streams', from: '1', to: '2' },
      { label: 'Name', from: 'Gast', to: 'Besucher' },
      { label: 'Für Einladungen wählbar', from: 'erlaubt', to: 'nicht erlaubt' },
    ]);
    // a name that was not set before reads as the built-in word
    expect(e('role.update', { from: { label: null }, to: { label: 'Besucher' } }, { target: 'guest' }).chips).toEqual([{ label: 'Name', from: 'Gast', to: 'Besucher' }]);
  });
  it('the old role.* entries read as "… changed {field}" without chips', () => {
    expect(e('role.playback', { transcoding: true, maxHeight: 1080 }, { target: 'family' })).toEqual({ text: 'Tester hat „Wiedergabe“ der Rolle Familie geändert', chips: [] });
    expect(e('role.request_limit', { requestsPerMonth: 5 }, { target: 'guest' }).text).toBe('Tester hat „Wunsch-Limit“ der Rolle Gast geändert');
    expect(e('role.remote_cap', {}, { target: 'guest' }).text).toContain('Limit unterwegs');
    expect(e('role.downloads', {}, { target: 'guest' }).text).toContain('Downloads');
  });
  it('no actor reads as the system; an unknown action stays generic; no raw key reaches the text', () => {
    expect(e('role.order', {}, { actorName: null }).text).toBe('System hat die Reihenfolge der Rollen geändert');
    const u = e('role.sparkle', {});
    expect(u.text).not.toMatch(/role\.|adminPeople|sentence/);
    for (const r of [e('role.update', { from: { x: 1 }, to: { x: 2 } }), e('user.rights', {}), e('role.playback', {}, { target: 'family' })]) expect(r.text).not.toMatch(/adminPeople|sentence\.|[a-z]+\.[a-z_]+\./);
  });
  it('polish and french sentences exist', async () => {
    for (const l of ['pl', 'fr', 'es', 'it', 'tr'] as const) {
      await setLocale(l);
      const r = e('role.update', { from: { party: true }, to: { party: false } }, { targetName: 'X' });
      expect(r.text).toContain('X');
      expect(r.text).not.toMatch(/adminPeople|sentence/);
      expect(r.chips).toHaveLength(1);
    }
  });
});
