// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { describeActivity } from '../activity';
import { activeItem } from '../nav';
import { fieldErrors, generate, importEnv, loadSettings, probeFailure, saveSettings, testGroup, type SettingView } from './api';
import { changedValues, errorText, isChange, keepable, keyHelp, keyLabel, moveHint, probeText, shownDraft, stashPending, submitValue, takePending } from './form';

/** every visible setting of the registry (spec Part A: 48) */
const KEYS = ['PUBLIC_URL', 'WEBHOOK_SECRET', 'API_COMPRESSION', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'ADMIN_GROUP', 'AUTHENTIK_URL',
  'AUTHENTIK_API_TOKEN', 'AUTHENTIK_ENROLL_FLOW', 'AUTHENTIK_RECOVERY_FLOW', 'AUTHENTIK_TOTP_SETUP_FLOW', 'JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY', 'REQUESTS_URL',
  'REQUESTS_API_KEY', 'NTFY_URL', 'NTFY_BASE_URL', 'DISCORD_WEBHOOK_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'TMDB_API_KEY', 'OMDB_API_KEY',
  'DOWNLOADS_ENABLED', 'DIRECT_PLAY_REQUIRES_DOWNLOAD', 'DOWNLOAD_CACHE_MAX_GB', 'DOWNLOAD_MIN_FREE_GB', 'DOWNLOAD_PREP_CONCURRENCY', 'DOWNLOAD_PAUSE_STREAMS',
  'DOWNLOAD_FILE_TTL_HOURS', 'DOWNLOAD_OFFLINE_GRACE_DAYS', 'DOWNLOAD_CREATE_PER_HOUR', 'CAST_ENABLED', 'PREVIEW_WARM', 'HOME_NETWORKS', 'GITHUB_TOKEN',
  'PORTAINER_WEBHOOK_URL', 'PORTAINER_URL', 'PORTAINER_API_KEY', 'PORTAINER_STACK_ID', 'PORTAINER_ENDPOINT_ID', 'PLAYBACK_CHECK_HOUR', 'HEALTH_DISK_WARN_PCT',
  'HEALTH_DISK_CRIT_PCT', 'HEALTH_DB_WARN_GB', 'SESSION_TTL_SECONDS', 'SESSION_IDLE_SECONDS'];

const view = (over: Partial<SettingView> & Pick<SettingView, 'key' | 'kind'>): SettingView => ({
  source: 'db', value: null, set: false, apply: 'live', restartPending: false, invalid: false, envNames: [over.key, `${over.key}_FILE`], updatedAt: null, ...over,
});

afterEach(async () => { vi.unstubAllGlobals(); await setLocale('de'); });

describe('settings texts', () => {
  it('every visible setting has a label and a help text; the request service is never named after a product', async () => {
    expect(KEYS).toHaveLength(48);
    for (const k of KEYS) {
      expect(hasKey(`settings.keys.${k}.label`), k).toBe(true);
      expect(hasKey(`settings.keys.${k}.help`), k).toBe(true);
    }
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
      await setLocale(l);
      const all = KEYS.flatMap((k) => [keyLabel(k), keyHelp(k)]).join(' ') + tr('settings.groups.requests');
      expect(all, l).not.toMatch(/seerr/i);
    }
    expect(keyLabel('NOT_A_KEY')).toBe('NOT_A_KEY');
    expect(keyHelp('NOT_A_KEY')).toBe('');
  });

  it('moveHint names KEY and KEY_FILE and only summarises legacy names', () => {
    expect(moveHint(['PUBLIC_URL', 'PUBLIC_URL_FILE'])).toContain('PUBLIC_URL und PUBLIC_URL_FILE aus der .env');
    const legacy = moveHint(['REQUESTS_URL', 'REQUESTS_URL_FILE', 'SEERR_URL', 'SEERR_URL_FILE']);
    expect(legacy).toContain('REQUESTS_URL und REQUESTS_URL_FILE (und ältere Namen dieser Einstellung)');
    expect(legacy).not.toMatch(/seerr/i);
  });

  it('error and probe texts, with a fallback for unknown codes', () => {
    expect(errorText('too_big')).toBe('Der Wert ist zu groß.');
    expect(errorText('brand_new')).toBe('Ungültiger Wert.');
    expect(errorText('<b>')).toBe('Ungültiger Wert.');
    expect(probeText({ ok: true, code: 'ok' })).toBe('Verbindung funktioniert.');
    expect(probeText({ ok: false, code: 'unreachable', detail: 'upstream_error' })).toBe('Dienst nicht erreichbar. Der Dienst hat mit einem Fehler geantwortet.');
    expect(probeText({ ok: false, code: 'invalid', detail: 'something new' })).toBe('Angaben unvollständig oder ungültig.');
    expect(probeText({ ok: false, code: 'brand_new' as never })).toBe('Angaben unvollständig oder ungültig.');
  });

  it('nav and activity: Settings under operations, the three audit actions read as sentences', () => {
    expect(activeItem('/admin/settings')?.label).toBe('admin.tabs.settings');
    expect(tr('admin.tabs.settings')).toBe('Einstellungen');
    for (const a of ['settings.update', 'settings.import_env', 'settings.generate']) {
      const d = describeActivity({ id: 1, at: '2026-10-14T10:00:00Z', action: a, actor: 'Tester', meta: { keys: ['PUBLIC_URL'] } });
      expect(d.text, a).toMatch(/^Tester /);
      expect(d.icon).toBe('globe');
    }
  });
});

describe('drafts and changed values', () => {
  const url = view({ key: 'NTFY_URL', kind: 'url', value: 'https://ntfy.example.com/ff?auth=redacted', set: true });
  const flag = view({ key: 'API_COMPRESSION', kind: 'bool', value: true, set: true, source: 'default' });
  const num = view({ key: 'DOWNLOAD_PREP_CONCURRENCY', kind: 'int', value: 1, set: true, source: 'default' });
  const cidr = view({ key: 'HOME_NETWORKS', kind: 'cidrList', value: ['10.0.0.0/8', '192.168.0.0/16'], set: true, source: 'default' });
  const key = view({ key: 'TMDB_API_KEY', kind: 'secret', set: true, last4: 'abcd' });
  const unsetKey = view({ key: 'OMDB_API_KEY', kind: 'secret', source: 'unset' });
  const env = view({ key: 'PUBLIC_URL', kind: 'url', value: 'https://friend.example.com', set: true, source: 'env' });
  const json = view({ key: 'X', kind: 'json', value: { a: 1 }, set: true });
  const empty = view({ key: 'NTFY_BASE_URL', kind: 'url', source: 'unset' });

  it('shownDraft by kind (secrets always empty)', () => {
    expect(shownDraft(url)).toBe('https://ntfy.example.com/ff?auth=redacted');
    expect(shownDraft(flag)).toBe(true);
    expect(shownDraft(view({ key: 'B', kind: 'bool', value: null }))).toBe(false);
    expect(shownDraft(num)).toBe('1');
    expect(shownDraft(cidr)).toBe('10.0.0.0/8, 192.168.0.0/16');
    expect(shownDraft(key)).toBe('');
    expect(shownDraft(json)).toBe('{"a":1}');
    expect(shownDraft(empty)).toBe('');
  });

  it('submitValue types the draft; empty clears', () => {
    expect(submitValue(flag, false)).toBe(false);
    expect(submitValue(num, ' 3 ')).toBe(3);
    expect(submitValue(num, 'abc')).toBe('abc');
    expect(submitValue(cidr, ' 10.0.0.0/8 , ,fd00::/8 ')).toBe('10.0.0.0/8,fd00::/8');
    expect(submitValue(url, '  ')).toBeNull();
    expect(submitValue(key, null)).toBeNull();
    expect(submitValue(key, ' spaced key ')).toBe(' spaced key ');
    expect(submitValue(empty, 'https://ntfy.example.com ')).toBe('https://ntfy.example.com');
  });

  it('isChange: typing the shown value back is no change; secrets change when typed or removed', () => {
    expect(isChange(url, undefined)).toBe(false);
    expect(isChange(url, 'https://ntfy.example.com/ff?auth=redacted ')).toBe(false);
    expect(isChange(url, 'https://ntfy.example.com/other')).toBe(true);
    expect(isChange(url, null)).toBe(true);
    expect(isChange(empty, null)).toBe(false);
    expect(isChange(flag, true)).toBe(false);
    expect(isChange(flag, false)).toBe(true);
    expect(isChange(cidr, '10.0.0.0/8,192.168.0.0/16')).toBe(false);
    expect(isChange(cidr, '10.0.0.0/8')).toBe(true);
    expect(isChange(key, '')).toBe(false);
    expect(isChange(key, 'new')).toBe(true);
    expect(isChange(key, null)).toBe(true);
    expect(isChange(unsetKey, null)).toBe(false);
  });

  it('changedValues sends only changed fields, never a redacted value or an env row', () => {
    const items = [url, flag, num, key, env, empty];
    expect(changedValues(items, {})).toEqual({});
    expect(changedValues(items, { NTFY_BASE_URL: 'https://ntfy.example.com', NTFY_URL: 'https://ntfy.example.com/ff?auth=redacted', PUBLIC_URL: 'https://x.example.com' }))
      .toEqual({ NTFY_BASE_URL: 'https://ntfy.example.com' });
    expect(changedValues(items, { API_COMPRESSION: false, DOWNLOAD_PREP_CONCURRENCY: '2', TMDB_API_KEY: null })).toEqual({ API_COMPRESSION: false, DOWNLOAD_PREP_CONCURRENCY: 2, TMDB_API_KEY: null });
  });
});

describe('re-authentication stash', () => {
  const store = () => {
    const m = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    return m;
  };
  const group = view({ key: 'ADMIN_GROUP', kind: 'string', value: 'friendflix-admins', set: true, source: 'default' });
  const token = view({ key: 'AUTHENTIK_API_TOKEN', kind: 'secret', set: true });
  const ntfy = view({ key: 'NTFY_URL', kind: 'url', source: 'unset' });

  it('keepable: never a secret or a URL carrying a credential', () => {
    expect(keepable(token, 'x')).toBe(false);
    expect(keepable(group, 'ff-admins')).toBe(true);
    expect(keepable(ntfy, 'https://ntfy.example.com/ff')).toBe(true);
    expect(keepable(ntfy, 'https://ntfy.example.com/ff?auth=abc')).toBe(false);
    expect(keepable(ntfy, 'https://u:p@ntfy.example.com/ff')).toBe(false);
    expect(keepable(ntfy, null)).toBe(true);
  });

  it('stashes the keepable changes without secrets and gives them back once', () => {
    const m = store();
    expect(stashPending('signin', [group, token], { ADMIN_GROUP: 'ff-admins', AUTHENTIK_API_TOKEN: 'very-secret' }, 1000)).toEqual({ dropped: true });
    expect([...m.values()].join()).not.toContain('very-secret');
    expect(takePending(2000)).toEqual({ group: 'signin', edits: { ADMIN_GROUP: 'ff-admins' }, dropped: true, at: 1000 });
    expect(takePending(2000)).toBeNull();
    stashPending('signin', [group], { ADMIN_GROUP: 'ff-admins' }, 1000);
    expect(takePending(2000)?.dropped).toBe(false);
  });

  it('drops stale, future or malformed stashes', () => {
    const m = store();
    stashPending('signin', [group], { ADMIN_GROUP: 'ff-admins' }, 0);
    expect(takePending(16 * 60_000)).toBeNull();
    stashPending('signin', [group], { ADMIN_GROUP: 'ff-admins' }, 5000);
    expect(takePending(1000)).toBeNull();
    m.set('ff_settings_pending', '{nope');
    expect(takePending()).toBeNull();
    m.set('ff_settings_pending', JSON.stringify({ group: 'signin', at: Date.now() }));
    expect(takePending()).toBeNull();
    m.set('ff_settings_pending', JSON.stringify({ group: 'signin', at: Date.now(), edits: { A: 'x', B: true, C: null, D: 5, E: {} } }));
    expect(takePending()?.edits).toEqual({ A: 'x', B: true, C: null });
  });

  it('blocked storage is no error', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined });
    expect(stashPending('signin', [group], { ADMIN_GROUP: 'x' })).toEqual({ dropped: false });
    expect(takePending()).toBeNull();
  });
});

describe('settings API', () => {
  const res = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
  const calls = () => {
    const fetch = vi.fn(async (..._a: unknown[]) => res(200, { ok: true }));
    vi.stubGlobal('fetch', fetch);
    return () => fetch.mock.calls.map(([url, init]) => [url, (init as { method: string }).method, (init as { body?: string }).body ? JSON.parse((init as { body: string }).body) : undefined]);
  };

  it('calls the routes with the documented bodies', async () => {
    const seen = calls();
    await loadSettings();
    await saveSettings({ A: 1 });
    await saveSettings({ A: 1 }, true);
    await testGroup('media');
    await testGroup('media', { JELLYFIN_URL: 'http://j' });
    await importEnv('all');
    await importEnv(['PUBLIC_URL']);
    await generate('webhookSecret');
    await generate('vapidPair');
    expect(seen()).toEqual([
      ['/api/admin/settings', 'GET', undefined],
      ['/api/admin/settings', 'PUT', { values: { A: 1 } }],
      ['/api/admin/settings', 'PUT', { values: { A: 1 }, force: true }],
      ['/api/admin/settings/test', 'POST', { group: 'media', values: {} }],
      ['/api/admin/settings/test', 'POST', { group: 'media', values: { JELLYFIN_URL: 'http://j' } }],
      ['/api/admin/settings/import-env', 'POST', { keys: 'all' }],
      ['/api/admin/settings/import-env', 'POST', { keys: ['PUBLIC_URL'] }],
      ['/api/admin/settings/generate', 'POST', { what: 'webhookSecret' }],
      ['/api/admin/settings/generate', 'POST', { what: 'vapidPair' }],
    ]);
  });

  it('fieldErrors / probeFailure read the 400 answers only', () => {
    expect(fieldErrors(new ApiError(400, { error: 'invalid_settings', errors: { A: 'too_big' } }))).toEqual({ A: 'too_big' });
    expect(fieldErrors(new ApiError(400, { error: 'probe_failed' }))).toBeNull();
    expect(fieldErrors(new ApiError(400, null))).toBeNull();
    expect(fieldErrors(new ApiError(500, { error: 'invalid_settings', errors: {} }))).toBeNull();
    expect(fieldErrors(new Error('x'))).toBeNull();
    const probe = { ok: false, code: 'timeout' };
    expect(probeFailure(new ApiError(400, { error: 'probe_failed', group: 'media', probe }))).toEqual(probe);
    expect(probeFailure(new ApiError(400, { error: 'invalid_settings', errors: {} }))).toBeNull();
    expect(probeFailure(new ApiError(400, null))).toBeNull();
    expect(probeFailure(new ApiError(401, { error: 'reauth_required' }))).toBeNull();
  });
});
