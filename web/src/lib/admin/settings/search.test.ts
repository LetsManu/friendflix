// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import type { SettingsGroupView, SettingView } from './api';
import { fold, searchSettings } from './search';

afterEach(async () => { await setLocale('de'); });

const row = (key: string, o: Partial<SettingView> = {}): SettingView => ({
  key, kind: 'string', source: 'default', value: null, set: false, apply: 'live', restartPending: false, invalid: false, envNames: [key], updatedAt: null, ...o,
});
/** a part of the registry, in its order (the page gets the groups in registry order) */
const GROUPS: SettingsGroupView[] = [
  { id: 'general', items: [row('PUBLIC_URL', { kind: 'url' }), row('WEBHOOK_SECRET', { kind: 'secret' })] },
  { id: 'signin', items: [row('OIDC_ISSUER', { kind: 'url' }), row('OIDC_CLIENT_ID'), row('AUTHENTIK_PASSWORD_CHANGE_FLOW'), row('AUTHENTIK_EMAIL_CHANGE_FLOW'),
    row('AUTHENTIK_API_TOKEN', { kind: 'secret' }), row('LOGIN_UI', { kind: 'enum', options: ['app', 'authentik'], optional: true })] },
  { id: 'requests', items: [row('REQUESTS_URL', { kind: 'url' })] },
  { id: 'updates', items: [row('GITHUB_TOKEN', { kind: 'secret' }), row('PORTAINER_WEBHOOK_URL', { kind: 'secret' }), row('PORTAINER_URL', { kind: 'url' }),
    row('PORTAINER_API_KEY', { kind: 'secret' }), row('PORTAINER_STACK_ID'), row('PORTAINER_ENDPOINT_ID', { kind: 'int' })] },
  { id: 'livetv', items: [row('LIVETV_ENCODER', { kind: 'enum', options: ['auto', 'qsv', 'vaapi', 'nvenc', 'software'] })] },
  { id: 'server', items: [row('PORT')] },
];

describe('settings search', () => {
  it('fold: lower case, without accents', () => {
    expect(fold('Überg')).toBe('uberg');
    expect(fold('ÉLAN Ñ')).toBe('elan n');
  });

  it('"portainer" finds the five PORTAINER_* keys in Updates', () => {
    const hits = searchSettings('portainer', GROUPS);
    expect(hits.map((h) => h.key)).toEqual(['PORTAINER_WEBHOOK_URL', 'PORTAINER_URL', 'PORTAINER_API_KEY', 'PORTAINER_STACK_ID', 'PORTAINER_ENDPOINT_ID']);
    expect(new Set(hits.map((h) => h.tab))).toEqual(new Set(['updates']));
    expect(hits[0]!.label).toBe('Portainer-Stack-Webhook');
  });

  it('"überg" and "uberg" find the same rows; so do "änderung" and "anderung" (case and accents do not matter)', () => {
    expect(searchSettings('uberg', GROUPS)).toEqual(searchSettings('überg', GROUPS));
    const a = searchSettings('änderung', GROUPS);
    expect(a.map((h) => h.key)).toEqual(['AUTHENTIK_PASSWORD_CHANGE_FLOW', 'AUTHENTIK_EMAIL_CHANGE_FLOW']);
    expect(searchSettings('ANDERUNG', GROUPS)).toEqual(a);
  });

  it('a one-letter query finds nothing', () => {
    expect(searchSettings('p', GROUPS)).toEqual([]);
    expect(searchSettings('  ', GROUPS)).toEqual([]);
  });

  it('key search "OIDC_ISS" finds OIDC_ISSUER', () => {
    expect(searchSettings('OIDC_ISS', GROUPS)).toEqual([{ key: 'OIDC_ISSUER', label: 'OIDC-Issuer', tab: 'signin' }]);
  });

  it('every word must match, in label, key, help or an option; label matches come first, then key matches, each in registry order', () => {
    // "authentik": in the token's label (listed last of them here), in the flows' keys, in an option of LOGIN_UI
    expect(searchSettings('authentik', GROUPS).map((h) => h.key)).toEqual(['AUTHENTIK_API_TOKEN', 'AUTHENTIK_PASSWORD_CHANGE_FLOW', 'AUTHENTIK_EMAIL_CHANGE_FLOW', 'LOGIN_UI']);
    // two words: both must be found
    expect(searchSettings('portainer stack', GROUPS).map((h) => h.key)).toEqual(['PORTAINER_WEBHOOK_URL', 'PORTAINER_STACK_ID', 'PORTAINER_URL', 'PORTAINER_API_KEY', 'PORTAINER_ENDPOINT_ID']);
    // a key typed with its underscore
    expect(searchSettings('public_url', GROUPS).map((h) => h.key)).toEqual(['PUBLIC_URL']);
  });

  it('Live-TV settings are found and say so; the read-only server values are not searched', () => {
    expect(searchSettings('nvenc', GROUPS)).toEqual([{ key: 'LIVETV_ENCODER', label: 'Encoder für Live-TV', tab: 'livetv' }]);
    expect(searchSettings('PORT', GROUPS).map((h) => h.key)).not.toContain('PORT');
  });

  it('at most 30 results', () => {
    const many: SettingsGroupView[] = [{ id: 'general', items: Array.from({ length: 40 }, (_, i) => row(`SETTING_${i}`)) }];
    expect(searchSettings('setting', many)).toHaveLength(30);
  });

  it('searches the current language', async () => {
    await setLocale('en');
    // the label match first; the webhook's help mentions an address too
    expect(searchSettings('portainer address', GROUPS).map((h) => h.key)).toEqual(['PORTAINER_URL', 'PORTAINER_WEBHOOK_URL']);
  });
});
