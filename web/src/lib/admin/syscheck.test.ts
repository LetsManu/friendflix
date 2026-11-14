// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasKey, setLocale } from '#lib/i18n';
import de from '#lib/i18n/locales/de/index';
import en from '#lib/i18n/locales/en/index';
import es from '#lib/i18n/locales/es/index';
import fr from '#lib/i18n/locales/fr/index';
import it_ from '#lib/i18n/locales/it/index';
import pl from '#lib/i18n/locales/pl/index';
import tr_ from '#lib/i18n/locales/tr/index';
import {
  CHECK_GROUPS, CHECK_IDS, BROWSER_IDS, adviceTexts, cachedSystemcheck, docsHref, forgetSystemcheck, isNewer, lineText, mergeLines, rememberSystemcheck, settingHref, statusIcon,
  statusTone, summaryOf, type CheckLine, type CheckStatus, type SystemcheckResult,
} from './syscheck';

afterEach(async () => { await setLocale('de'); });

const counts = (o: Partial<Record<CheckStatus, number>>): Record<CheckStatus, number> => ({ ok: 0, warning: 0, problem: 0, not_set_up: 0, unknown: 0, ...o });
const ln = (o: Partial<CheckLine> & Pick<CheckLine, 'id' | 'status'>): CheckLine => ({ group: o.id.split('.')[0] as CheckLine['group'], runs: 'server', ...o });

describe('Systemcheck texts', () => {
  it('lineText of a known cause and fix', () => {
    const t = lineText(ln({ id: 'core.database', status: 'problem', cause: 'db_down', fix: 'db_down' }));
    expect(t.label).toBe('Datenbank');
    expect(t.cause).toBe('Die Datenbank antwortet nicht.');
    expect(t.fix.length).toBeGreaterThan(10);
    expect(t.fix).not.toContain('{');
  });

  it('an unknown cause or fix gives an empty text, never the raw code', () => {
    const t = lineText(ln({ id: 'core.database', status: 'problem', cause: 'no_such_code', fix: 'other_unknown' }));
    expect(t.cause).toBe('');
    expect(t.fix).toBe('');
  });

  it('a locked setting adds the .env sentence to the fix', () => {
    const t = lineText(ln({ id: 'signin.authentik', status: 'problem', cause: 'ak_token_invalid', fix: 'ak_token_invalid', settingKey: 'AUTHENTIK_API_TOKEN', locked: true }));
    expect(t.fix).toContain('.env');
    expect(t.fix).toContain('AUTHENTIK_API_TOKEN');
    // without its own fix sentence the .env sentence stands alone
    expect(lineText(ln({ id: 'core.publicUrl', status: 'problem', settingKey: 'PUBLIC_URL', locked: true })).fix).toContain('.env');
  });

  it('params are filled: numbers, the flow name, and missing ones never show as {n}', () => {
    expect(lineText(ln({ id: 'core.disk.downloads', status: 'warning', cause: 'disk_full', fix: 'disk_full', params: { pct: 93 } })).cause).toContain('93');
    expect(lineText(ln({ id: 'signin.flows', status: 'warning', cause: 'flow_missing', fix: 'flow_missing', params: { n: 1, flow: 'recovery' } })).cause).toContain('Passwort vergessen');
    const more = lineText(ln({ id: 'signin.flows', status: 'warning', cause: 'flow_missing', fix: 'flow_missing', params: { n: 3, flow: 'setup_totp' } }));
    expect(more.cause).toContain('Authenticator-App einrichten');
    expect(more.note).toContain('2');
    expect(lineText(ln({ id: 'media.playback', status: 'warning', cause: 'playback_failed', fix: 'playback_failed' })).cause).not.toMatch(/\{\w+\}/);
  });

  it('follows the language', async () => {
    await setLocale('en');
    expect(lineText(ln({ id: 'core.database', status: 'problem', cause: 'db_down' })).label).toBe('Database');
    expect(summaryOf(counts({ problem: 1 })).text).toBe('1 problem');
  });

  it('every catalogue line, group and status has a text', () => {
    for (const id of CHECK_IDS) expect(lineText(ln({ id, status: 'ok' })).label, id).not.toBe('');
    for (const g of CHECK_GROUPS) expect(hasKey(`syscheck.group.${g}`), g).toBe(true);
    for (const s of ['ok', 'warning', 'problem', 'not_set_up', 'unknown'] as const) {
      expect(hasKey(`syscheck.status.${s}`), s).toBe(true);
      expect(statusIcon(s)).not.toBe('');
    }
  });
});

describe('encoder advice', () => {
  it('every further advice item has its own cause and fix sentence; the first is the line\'s own; unknown codes are dropped', () => {
    const l = ln({ id: 'media.encoder', status: 'warning', cause: 'hevc_failed', fix: 'hevc_failed', params: { advice: 'hevc_failed,no_tonemap,bogus_code,downmix_plain' } });
    const a = adviceTexts(l);
    expect(a).toHaveLength(2);
    expect(a[0]!.cause).toContain('Tone-Mapping ist aus');
    expect(a[0]!.fix).toContain('Tone-Mapping aktivieren');
    expect(a[1]!.cause).toContain('Stereo-Downmix');
    expect(a[1]!.fix).toContain('Dave750');
    expect(adviceTexts(ln({ id: 'media.encoder', status: 'ok' }))).toEqual([]);
    expect(adviceTexts(ln({ id: 'core.env', status: 'warning', params: { advice: 'a,no_tonemap' } }))).toEqual([]);
  });
});

describe('remembered answer (stale-while-revalidate)', () => {
  const res = (at: string): SystemcheckResult => ({ at, lines: [ln({ id: 'core.database', status: 'problem', cause: 'db_down' })], counts: counts({ problem: 1 }) });
  afterEach(() => { forgetSystemcheck(); vi.unstubAllGlobals(); });

  it('keeps the newest answer and never goes back to an older one', () => {
    expect(cachedSystemcheck()).toBeNull();
    rememberSystemcheck(res('2026-11-14T09:00:00.000Z'));
    rememberSystemcheck(res('2026-11-14T08:00:00.000Z'));
    expect(cachedSystemcheck()?.at).toBe('2026-11-14T09:00:00.000Z');
    expect(isNewer(res('2026-11-14T08:59:00.000Z'), res('2026-11-14T09:00:00.000Z'))).toBe(false);
    expect(isNewer(res('2026-11-14T09:00:00.000Z'), null)).toBe(true);
    rememberSystemcheck({ at: 5 } as unknown as SystemcheckResult); // wrong shape: ignored
    expect(cachedSystemcheck()?.at).toBe('2026-11-14T09:00:00.000Z');
  });

  it('survives a reload through sessionStorage; a broken or missing storage is no error', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    rememberSystemcheck(res('2026-11-14T09:00:00.000Z'));
    const saved = store.get('ff-syscheck')!;
    forgetSystemcheck();
    store.set('ff-syscheck', saved);
    expect(cachedSystemcheck()?.lines[0]?.id).toBe('core.database');
    forgetSystemcheck();
    store.set('ff-syscheck', '{not json');
    expect(cachedSystemcheck()).toBeNull();
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
    expect(() => rememberSystemcheck(res('2026-11-14T10:00:00.000Z'))).not.toThrow();
    expect(cachedSystemcheck()?.at).toBe('2026-11-14T10:00:00.000Z');
  });
});

describe('Systemcheck links', () => {
  it('settingHref: the Live-TV settings tab for the livetv group, Admin → Settings otherwise; a bad key opens the settings only', () => {
    expect(settingHref('LIVETV_ENCODER', 'livetv')).toBe('/admin/livetv?tab=settings&setting=LIVETV_ENCODER');
    expect(settingHref('AUTHENTIK_API_TOKEN', 'signin')).toBe('/admin/settings?setting=AUTHENTIK_API_TOKEN');
    expect(settingHref('PUBLIC_URL')).toBe('/admin/settings?setting=PUBLIC_URL');
    expect(settingHref('x"><script')).toBe('/admin/settings');
    expect(settingHref('lower_case')).toBe('/admin/settings');
  });

  it('docsHref builds the blob/main URL and refuses anything else', () => {
    expect(docsHref('setup.md#6-nginx-proxy-manager-portal-proxy-host')).toBe('https://github.com/LetsManu/friendflix/blob/main/docs/setup.md#6-nginx-proxy-manager-portal-proxy-host');
    expect(docsHref('operations.md')).toBe('https://github.com/LetsManu/friendflix/blob/main/docs/operations.md');
    expect(docsHref('../secrets.md')).toBe('');
    expect(docsHref('https://evil.example.com/x.md')).toBe('');
  });
});

describe('Systemcheck status and summary', () => {
  it('statusTone: problem red, warning yellow, not set up and unknown neutral', () => {
    expect(statusTone('ok')).toBe('ok');
    expect(statusTone('warning')).toBe('warn');
    expect(statusTone('problem')).toBe('err');
    expect(statusTone('not_set_up')).toBe('muted');
    expect(statusTone('unknown')).toBe('muted');
  });

  it('summaryOf: problems before warnings, plural; only not set up → Alles in Ordnung', () => {
    expect(summaryOf(counts({ problem: 2, warning: 1, ok: 9 }))).toEqual({ tone: 'err', text: '2 Probleme' });
    expect(summaryOf(counts({ problem: 1 }))).toEqual({ tone: 'err', text: '1 Problem' });
    expect(summaryOf(counts({ warning: 1, ok: 3 }))).toEqual({ tone: 'warn', text: '1 Warnung' });
    expect(summaryOf(counts({ warning: 4 }))).toEqual({ tone: 'warn', text: '4 Warnungen' });
    expect(summaryOf(counts({ not_set_up: 5, ok: 2, unknown: 1 }))).toEqual({ tone: 'ok', text: 'Alles in Ordnung' });
  });
});

describe('Systemcheck lines', () => {
  it('mergeLines keeps catalogue order, fills missing ids with placeholders, browser lines replace them', () => {
    const server = [ln({ id: 'media.server', status: 'ok' }), ln({ id: 'core.database', status: 'problem', cause: 'db_down' })];
    const browser: CheckLine[] = [{ id: 'proxy.websocket', group: 'proxy', status: 'ok', runs: 'browser' }];
    const m = mergeLines(server, browser);
    expect(m.map((l) => l.id)).toEqual([...CHECK_IDS]);
    expect(m.find((l) => l.id === 'core.database')?.status).toBe('problem');
    expect(m.find((l) => l.id === 'proxy.websocket')).toMatchObject({ status: 'ok', runs: 'browser' });
    // not run yet: unknown, without a cause, marked as placeholder
    expect(m.find((l) => l.id === 'proxy.headers')).toMatchObject({ status: 'unknown', runs: 'browser', placeholder: true });
    expect(m.find((l) => l.id === 'livetv.container')).toMatchObject({ status: 'unknown', runs: 'server', placeholder: true });
    expect(m.find((l) => l.id === 'livetv.container')?.cause).toBeUndefined();
    // a server line for a browser id or an unknown id never wins over the catalogue
    expect(mergeLines([ln({ id: 'nope.x' as CheckLine['id'], status: 'problem' })], []).some((l) => (l.id as string) === 'nope.x')).toBe(false);
  });

  it('CHECK_IDS matches the backend catalogue (literal copy of backend/src/syscheck/types.ts)', () => {
    expect([...CHECK_IDS]).toEqual([
      'core.publicUrl', 'core.database', 'core.redis', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env',
      'signin.oidc', 'signin.authentik', 'signin.flows', 'signin.issuerHost', 'signin.passkeys', 'signin.mail',
      'media.server', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder',
      'livetv.container', 'livetv.encoder', 'livetv.sources', 'livetv.guides',
      'updates.updater', 'updates.path', 'updates.portainer',
      'proxy.forwardedProto', 'proxy.peer', 'proxy.websocket', 'proxy.buffering', 'proxy.upload', 'proxy.headers',
    ]);
    expect([...CHECK_GROUPS]).toEqual(['core', 'signin', 'media', 'livetv', 'updates', 'proxy']);
    expect([...BROWSER_IDS]).toEqual(['proxy.websocket', 'proxy.buffering', 'proxy.upload', 'proxy.headers']);
  });

  it('CHECK_IDS is the same list the backend compiles (read from its source)', () => {
    const src = readFileSync(new URL('../../../../backend/src/syscheck/types.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('export const CHECK_IDS = ['), src.indexOf('] as const;', src.indexOf('export const CHECK_IDS = [')));
    expect([...block.matchAll(/'([a-zA-Z.]+)'/g)].map((m) => m[1])).toEqual([...CHECK_IDS]);
  });
});

/**
 * Every cause and fix code a backend check can send has a German text (the other languages are checked against German by their own
 * tests). The codes are read from the check sources, so a new code without a text fails here, not on the admin's screen.
 */
describe('every backend code has a text', () => {
  const dir = new URL('../../../../backend/src/syscheck/', import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  const src = files.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const causes = new Set<string>();
  const fixes = new Set<string>();
  // bad(id, status, 'code', …): the code is the cause and, unless the call names its own fix, the fix
  for (const m of src.matchAll(/\bbad\(\s*[^,]+,\s*[^,]+,\s*'([a-z0-9_]+)'([^\n]*)/g)) {
    causes.add(m[1]!);
    if (!/\bfix: '/.test(m[2]!)) fixes.add(m[1]!);
  }
  for (const m of src.matchAll(/\bcause: '([a-z0-9_]+)'/g)) causes.add(m[1]!);
  for (const m of src.matchAll(/\bfix: '([a-z0-9_]+)'/g)) fixes.add(m[1]!);
  // the engine's own codes (unknown lines: no fix sentence of their own is required, but they have one)
  for (const m of src.matchAll(/'(check_[a-z_]+)'/g)) { causes.add(m[1]!); fixes.add(m[1]!); }
  // timedLine(id, row, 'prefix'): `<prefix>_down` and `<prefix>_slow`
  for (const m of src.matchAll(/\btimedLine\(\s*'[^']+',\s*(?:\w+\([^)]*\)|[^,()]+),\s*'([a-z]+)'/g)) for (const s of ['down', 'slow']) { causes.add(`${m[1]}_${s}`); fixes.add(`${m[1]}_${s}`); }
  // the encoder advice codes (the first is the cause): backend/src/health.ts EncoderAdvice
  const health = readFileSync(new URL('../health.ts', dir), 'utf8');
  const advice = health.slice(health.indexOf('export type EncoderAdvice'), health.indexOf(';', health.indexOf('export type EncoderAdvice')));
  for (const m of advice.matchAll(/'([a-z_]+)'/g)) { causes.add(m[1]!); fixes.add(m[1]!); }
  // signin.flows: the first flow warning of checkLoginFlows is the cause (signin.ts FLOW_WARNING)
  const flowRe = src.match(/const FLOW_WARNING = \/(.+)\/;/)?.[1] ?? '';
  for (const m of flowRe.matchAll(/[a-z]+(?:_[a-z]+)+|consent/g)) { causes.add(m[0]); fixes.add(m[0]); }

  it('found the codes (the patterns still match the sources)', () => {
    expect(causes.size).toBeGreaterThan(50);
    for (const c of ['db_down', 'gateway_slow', 'no_hw_accel', 'downmix_plain', 'flow_missing', 'auth_code_grant', 'consent', 'check_timeout', 'mail_unverified', 'requests_key_invalid']) expect(causes, c).toContain(c);
    expect(fixes).toContain('proxy_forward_host');
    expect(fixes).not.toContain('mail_unverified');
  });
  it('every cause has a text', () => {
    for (const c of causes) expect(hasKey(`syscheck.cause.${c}`), c).toBe(true);
  });
  it('every fix has a text', () => {
    for (const f of fixes) expect(hasKey(`syscheck.fix.${f}`), f).toBe(true);
  });
});

describe('syscheck area in every language', () => {
  type Tree = Record<string, unknown>;
  const keyOrder = (o: Tree, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !('other' in (v as Tree)) ? keyOrder(v as Tree, `${p}${k}.`) : [`${p}${k}`]));
  const areaOrder = (d: Tree) => Object.keys(d);
  it('identical key order in all seven locales, placed right after adminLive', () => {
    const ref = keyOrder(de.syscheck as Tree);
    for (const [name, d] of Object.entries({ en, es, fr, it: it_, pl, tr: tr_ })) {
      expect(keyOrder((d as Tree).syscheck as Tree), name).toEqual(ref);
      const areas = areaOrder(d as Tree);
      expect(areas[areas.indexOf('adminLive') + 1], name).toBe('syscheck');
    }
    const areas = areaOrder(de as Tree);
    expect(areas[areas.indexOf('adminLive') + 1]).toBe('syscheck');
  });
  it('no product names that must not appear, placeholder hosts only', () => {
    for (const d of [de, en, es, fr, it_, pl, tr_]) {
      const text = JSON.stringify((d as Tree).syscheck);
      expect(text).not.toMatch(/netflix|seerr/i);
      for (const host of text.match(/[a-z0-9-]+(\.[a-z0-9-]+)+\.[a-z]{2,}/gi) ?? []) expect(host, host).toMatch(/(^|\.)example\.com$|^192\.0\.2\./);
    }
  });
});
