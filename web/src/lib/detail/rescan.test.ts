// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { ApiError } from '#lib/api';
import { ALL_CAPS, capsFrom } from '#lib/capabilities';
import { setLocale } from '#lib/i18n';
import type { ConfirmOptions } from '#lib/ui/confirm';
import { dismissAll, toasts } from '#lib/ui/toast';
import { RESCAN_MODES, rescanConfirms, rescanRequest, rescanShown, startRescan } from './rescan';

afterEach(async () => { dismissAll(); await setLocale('de'); });

describe('rescanShown: who sees *Neu einlesen*', () => {
  it('an admin on a server that can: films, series and seasons', () => {
    for (const type of ['Movie', 'Series', 'Season']) expect(rescanShown(type, true, ALL_CAPS), type).toBe(true);
  });
  it('never for an episode or anything else, never before the type is known', () => {
    for (const type of ['Episode', 'BoxSet', 'Person', '', undefined]) expect(rescanShown(type, true, ALL_CAPS), String(type)).toBe(false);
  });
  it('never for a non-admin, or while the admin flag is unknown', () => {
    expect(rescanShown('Series', false, ALL_CAPS)).toBe(false);
    expect(rescanShown('Series', undefined, ALL_CAPS)).toBe(false);
  });
  it('never when the server lacks the capability (Plex); an older server that says nothing counts as able', () => {
    expect(rescanShown('Movie', true, capsFrom({ itemRefresh: false }))).toBe(false);
    expect(capsFrom({}).itemRefresh).toBe(true);
    expect(capsFrom({ itemRefresh: 'no' }).itemRefresh).toBe(true);
  });
});

describe('the request of each mode', () => {
  it('three modes in the dialog order', () => {
    expect([...RESCAN_MODES]).toEqual(['scan', 'missing', 'replace']);
  });
  it('POST /api/admin/items/:id/refresh with the mode in the body; the id is encoded', () => {
    for (const mode of RESCAN_MODES) expect(rescanRequest('a'.repeat(32), mode)).toEqual({ path: `/api/admin/items/${'a'.repeat(32)}/refresh`, method: 'POST', body: { mode } });
    expect(rescanRequest('x/y', 'scan').path).toBe('/api/admin/items/x%2Fy/refresh');
  });
  it('only replace asks first', () => {
    expect(RESCAN_MODES.filter(rescanConfirms)).toEqual(['replace']);
  });
});

describe('startRescan', () => {
  const ID = 'b'.repeat(32);
  it('sends the request and says so in a toast; does not wait for the server or poll', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const ask = vi.fn(async () => true);
    expect(await startRescan({ id: ID, mode: 'scan', name: 'Bright Valley' }, { call, ask })).toBe('done');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(`/api/admin/items/${ID}/refresh`, { method: 'POST', body: { mode: 'scan' } });
    expect(ask).not.toHaveBeenCalled();
    expect(get(toasts).map((t) => [t.kind, t.message])).toEqual([['success', '„Bright Valley“ wird neu eingelesen. Das kann ein paar Minuten dauern.']]);
  });
  it('replace asks first: no is nothing sent, yes sends', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    let answer = false;
    const ask = vi.fn(async (_o: ConfirmOptions) => answer);
    expect(await startRescan({ id: ID, mode: 'replace', name: 'Staffel 1' }, { call, ask })).toBe('cancelled');
    expect(call).not.toHaveBeenCalled();
    expect(ask.mock.calls[0]![0]).toMatchObject({ danger: true, title: 'Alle Metadaten und Bilder ersetzen?', confirmLabel: 'Ersetzen' });
    expect(ask.mock.calls[0]![0].body).toContain('„Staffel 1“');
    answer = true;
    expect(await startRescan({ id: ID, mode: 'replace', name: 'Staffel 1' }, { call, ask })).toBe('done');
    expect(call).toHaveBeenCalledWith(`/api/admin/items/${ID}/refresh`, { method: 'POST', body: { mode: 'replace' } });
  });
  it('a failure comes back as the shared error text, no toast', async () => {
    const fail = (e: unknown) => vi.fn(async () => { throw e; });
    expect(await startRescan({ id: ID, mode: 'missing', name: 'X' }, { call: fail(new ApiError(429, { error: 'rate_limited' })) })).toEqual({ error: 'Zu viele Versuche. Bitte kurz warten.' });
    expect(await startRescan({ id: ID, mode: 'missing', name: 'X' }, { call: fail(new ApiError(404, { error: 'not_found' })) })).toEqual({ error: 'Das gibt es nicht (mehr).' });
    expect(await startRescan({ id: ID, mode: 'missing', name: 'X' }, { call: fail(new TypeError('offline')) })).toEqual({ error: expect.any(String) });
    expect(get(toasts)).toEqual([]);
  });
  it('follows the UI language', async () => {
    await setLocale('en');
    await startRescan({ id: ID, mode: 'scan', name: 'Bright Valley' }, { call: async () => ({ ok: true }) });
    expect(get(toasts)[0]!.message).toBe('“Bright Valley” is being rescanned. This can take a few minutes.');
  });
});
