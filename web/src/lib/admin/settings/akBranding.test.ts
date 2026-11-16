// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// the fresh sign-in (lib/account/reauth.ts): whether the person signed in again
const re = vi.hoisted(() => ({ reauthenticate: vi.fn(async (_next: string) => true) }));
vi.mock('#lib/auth/flow', () => ({ flowConfig: vi.fn() }));
vi.mock('#lib/account/reauth', async (orig) => ({ ...(await orig<typeof import('#lib/account/reauth')>()), reauthenticate: re.reauthenticate }));

import { ApiError } from '#lib/api';
import { setLocale, trDynamic } from '#lib/i18n';
import { AK_BRANDING_GUIDE, loadAkBranding, partText, syncAkBranding, syncErrorText, type AkPart } from './akBranding';

const tr = (k: string, p?: Record<string, string | number | null | undefined>) => trDynamic(k, p);
const reply = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });

beforeEach(() => { re.reauthenticate.mockReset(); re.reauthenticate.mockResolvedValue(true); });
afterEach(async () => { vi.unstubAllGlobals(); await setLocale('de'); });

describe('partText', () => {
  it('done: name and logo; the sender, with or without the SMTP settings', () => {
    expect(partText('brand', { state: 'done' }, false, tr)).toEqual({ tone: 'ok', text: 'Name und Logo übertragen.' });
    expect(partText('brand', { state: 'done', logo: true }, false, tr)).toEqual({ tone: 'ok', text: 'Name und Logo übertragen.' });
    // no logo went along (none set, or no PUBLIC_URL): the line says so
    expect(partText('brand', { state: 'done', logo: false }, false, tr)).toEqual({ tone: 'ok', text: 'Name übertragen.' });
    expect(partText('stage', { state: 'done' }, false, tr)).toEqual({ tone: 'ok', text: 'Absender übertragen.' });
    expect(partText('stage', { state: 'done' }, true, tr)).toEqual({ tone: 'ok', text: 'Absender und SMTP-Einstellungen übertragen.' });
  });

  it('skipped: nothing to send is a warning', () => {
    const r = partText('stage', { state: 'skipped', code: 'nothing_to_send' }, false, tr);
    expect(r.tone).toBe('warn');
    expect(r.text).toBe(tr('settings.mail.authentik.stageSkipped'));
  });

  it('a stage on Authentik\'s global settings says the sender was not changed', () => {
    const r = partText('stage', { state: 'skipped', code: 'global_settings' }, false, tr);
    expect(r).toEqual({ tone: 'warn', text: 'Authentik nutzt seine globalen E-Mail-Einstellungen – Absender nicht geändert.' });
  });

  it('a refusal names the part and the missing permission', () => {
    const r = partText('brand', { state: 'failed', code: 'permission', permission: 'authentik_brands.change_brand' }, false, tr);
    expect(r).toEqual({ tone: 'err', text: 'Name und Logo: Dem Authentik-Token fehlt die Berechtigung „authentik_brands.change_brand“.' });
    const s = partText('stage', { state: 'failed', code: 'permission', permission: 'authentik_stages_email.change_emailstage' }, true, tr);
    expect(s.text).toBe('E-Mail-Stufe: Dem Authentik-Token fehlt die Berechtigung „authentik_stages_email.change_emailstage“.');
  });

  it('a refusal without a (well-formed) codename says a permission is missing', () => {
    const generic = `E-Mail-Stufe: ${tr('settings.mail.authentik.code.permissionAny')}`;
    expect(partText('stage', { state: 'failed', code: 'permission' }, false, tr).text).toBe(generic);
    expect(partText('stage', { state: 'failed', code: 'permission', permission: '<b>x</b>' }, false, tr).text).toBe(generic);
  });

  it('every failure code has its own sentence; an unknown code is the generic one', () => {
    const codes = ['token_invalid', 'not_found', 'no_email_stage', 'unreachable', 'error'] as const;
    const texts = codes.map((code) => partText('stage', { state: 'failed', code }, false, tr));
    for (const [i, r] of texts.entries()) {
      expect(r.tone).toBe('err');
      expect(r.text).toBe(`E-Mail-Stufe: ${tr(`settings.mail.authentik.code.${codes[i]}`)}`);
      expect(r.text).not.toContain('settings.');
    }
    expect(new Set(texts.map((r) => r.text)).size).toBe(codes.length);
    const odd = partText('brand', { state: 'failed', code: 'gremlins' } as unknown as AkPart, false, tr);
    expect(odd.text).toBe(`Name und Logo: ${tr('settings.mail.authentik.code.error')}`);
  });

  it('follows the language', async () => {
    await setLocale('en');
    expect(partText('brand', { state: 'done' }, false, tr).text).toBe(tr('settings.mail.authentik.brandDone'));
    expect(partText('brand', { state: 'done' }, false, tr).text).not.toBe('Name und Logo übertragen.');
  });
});

describe('syncErrorText', () => {
  it('turns route refusals into sentences', () => {
    expect(syncErrorText(new ApiError(401, { error: 'reauth_required' }), tr)).toEqual({ tone: 'warn', text: tr('settings.mail.authentik.error.reauth_required') });
    expect(syncErrorText(new ApiError(400, { error: 'mail_not_configured' }), tr).text).toBe(tr('settings.mail.authentik.error.mail_not_configured'));
    expect(syncErrorText(new ApiError(503, { error: 'authentik_unavailable' }), tr).text).toBe(tr('settings.mail.authentik.error.authentik_unavailable'));
    expect(syncErrorText(new ApiError(429, null), tr).text).toBe(tr('settings.mail.authentik.error.rate_limited'));
    expect(syncErrorText(new ApiError(403, { error: 'forbidden' }), tr).text).toBe(tr('settings.mail.authentik.error.forbidden'));
    // an expired tab token is no question of rights: the generic "try again"
    expect(syncErrorText(new ApiError(403, { error: 'csrf' }), tr)).toEqual({ tone: 'err', text: tr('settings.mail.authentik.error.failed') });
    expect(syncErrorText(new ApiError(403, null), tr).text).toBe(tr('settings.mail.authentik.error.failed'));
    expect(syncErrorText(new ApiError(500, { error: 'internal' }), tr)).toEqual({ tone: 'err', text: tr('settings.mail.authentik.error.failed') });
    expect(syncErrorText(new Error('offline'), tr).text).toBe(tr('settings.mail.authentik.error.failed'));
  });
});

describe('loadAkBranding / syncAkBranding', () => {
  it('reads the preview and posts { smtp }', async () => {
    const fetch = vi.fn(async (_u: string, i: RequestInit) => reply(200, i.method === 'POST' ? { brand: { state: 'done' }, stage: { state: 'done' } } : { available: true }));
    vi.stubGlobal('fetch', fetch);
    expect(await loadAkBranding()).toEqual({ available: true });
    expect(await syncAkBranding(false)).toEqual({ brand: { state: 'done' }, stage: { state: 'done' } });
    expect(fetch.mock.calls.map(([u, i]) => [u, i.method, i.body])).toEqual([
      ['/api/admin/authentik/branding', 'GET', undefined],
      ['/api/admin/authentik/branding', 'POST', '{"smtp":false}'],
    ]);
    expect(re.reauthenticate).not.toHaveBeenCalled();
  });

  it('retries once after reauth_required', async () => {
    const answers = [reply(401, { error: 'reauth_required' }), reply(200, { brand: { state: 'done' }, stage: { state: 'done' } })];
    const fetch = vi.fn(async (_u: string, _i: RequestInit) => answers.shift()!);
    vi.stubGlobal('fetch', fetch);
    expect(await syncAkBranding(true)).toEqual({ brand: { state: 'done' }, stage: { state: 'done' } });
    expect(re.reauthenticate).toHaveBeenCalledTimes(1);
    expect(re.reauthenticate.mock.calls[0]![0]).toBe('/admin/settings?tab=notifications');
    expect(fetch.mock.calls.map(([, i]) => i.body)).toEqual(['{"smtp":true}', '{"smtp":true}']);
  });

  it('a second reauth_required is an error, not another sign-in', async () => {
    const fetch = vi.fn(async (_u: string, _i: RequestInit) => reply(401, { error: 'reauth_required' }));
    vi.stubGlobal('fetch', fetch);
    await expect(syncAkBranding(true)).rejects.toMatchObject({ status: 401 });
    expect(re.reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a sign-in given up sends nothing more', async () => {
    re.reauthenticate.mockResolvedValue(false);
    const fetch = vi.fn(async (_u: string, _i: RequestInit) => reply(401, { error: 'reauth_required' }));
    vi.stubGlobal('fetch', fetch);
    await expect(syncAkBranding(true)).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('other refusals are not retried', async () => {
    const fetch = vi.fn(async (_u: string, _i: RequestInit) => reply(400, { error: 'mail_not_configured' }));
    vi.stubGlobal('fetch', fetch);
    await expect(syncAkBranding(true)).rejects.toMatchObject({ status: 400 });
    expect(re.reauthenticate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('the guide points at the docs section', () => {
    expect(AK_BRANDING_GUIDE).toBe('https://github.com/LetsManu/friendflix/blob/main/docs/authentik.md#10b-e-mails-in-the-friendflix-look');
  });
});
