import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  LOCALES, fmtDate, fmtDateTime, fmtDuration, fmtList, fmtNumber, fmtRelative, fmtTime, getLocale, hasKey, intlLocale, isLocale, loadLocale,
  locale, localeName, pickLocale, ready, setLocale, t, tr, trDynamic,
} from './index';
import { richParts } from './rich';
import de from './locales/de/index';
import en from './locales/en/index';

afterEach(async () => { await setLocale('de'); });

/** every dotted key of a nested dictionary (plural objects count as one key) */
function keys(o: object, p = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' || (v && typeof v === 'object' && 'other' in v) ? [p + k] : keys(v as object, `${p}${k}.`)));
}

describe('i18n core', () => {
  it('locales: seven languages with native names, code checks, browser matching', () => {
    expect(LOCALES.map((l) => l.name)).toEqual(['Deutsch', 'English', 'Français', 'Español', 'Italiano', 'Türkçe', 'Polski']);
    expect(isLocale('pl')).toBe(true);
    expect(isLocale('pt')).toBe(false);
    expect(localeName('fr')).toBe('Français');
    expect(pickLocale(['pt-BR', 'en-US', 'de'])).toBe('en');
    expect(pickLocale(['FR_ch'])).toBe('fr');
    expect(pickLocale(['ja', undefined, null])).toBeNull();
  });

  it('German is the default and bundled', () => {
    expect(getLocale()).toBe('de');
    expect(get(ready)).toBe(true);
    expect(tr('shell.nav.home')).toBe('Start');
    expect(get(t)('shell.nav.new')).toBe('Neu & beliebt');
  });

  it('interpolates {name} and formats numbers for the locale', () => {
    expect(tr('shell.mobile.forName', { name: 'Anna' })).toBe('Für Anna');
    expect(tr('account.me.all', { n: 1234 })).toBe('Alle (1.234)');
    // unknown placeholders stay visible instead of silently disappearing
    expect(tr('shell.mobile.forName')).toBe('Für {name}');
    expect(tr('shell.mobile.forName', { other: 'x' })).toBe('Für {name}');
  });

  it('plural via Intl.PluralRules (n)', async () => {
    expect(tr('shell.mobile.meUnread', { n: 1 })).toBe('Mein FriendFlix, 1 neue Benachrichtigung');
    expect(tr('shell.mobile.meUnread', { n: 3 })).toBe('Mein FriendFlix, 3 neue Benachrichtigungen');
    expect(tr('account.profiles.maxProfiles', { n: 5 })).toBe('Es sind höchstens 5 Profile möglich.');
    await setLocale('en');
    expect(tr('shell.mobile.meUnread', { n: 1 })).toBe('My FriendFlix, 1 new notification');
    expect(tr('shell.mobile.meUnread', { n: 2 })).toBe('My FriendFlix, 2 new notifications');
  });

  it('lazy loads a language and switches the stores without reload', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('document', { documentElement: { lang: 'de' } });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const seen: string[] = [];
    const stop = t.subscribe((f) => seen.push(f('shell.nav.series')));
    const p = setLocale('en');
    await p;
    expect(get(locale)).toBe('en');
    expect(intlLocale()).toBe('en-GB');
    expect(seen).toEqual(['Serien', 'TV Shows']);
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem('ff-locale')).toBe('en');
    stop();
    expect(await loadLocale('en')).toBe(en); // cached
    vi.unstubAllGlobals();
  });

  it('unknown locale codes fall back to German; the last overlapping call wins', async () => {
    expect(await setLocale('xx')).toBe('de');
    const a = setLocale('en'), b = setLocale('de');
    await Promise.all([a, b]);
    expect(getLocale()).toBe('de');
  });

  it('missing key → German → key, with a dev warning', async () => {
    await setLocale('fr'); // French is still empty: German shows through
    expect(tr('shell.nav.myList')).toBe('Meine Liste');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(trDynamic('shell.nav.doesNotExist')).toBe('shell.nav.doesNotExist');
    expect(trDynamic('shell.nav')).toBe('shell.nav'); // a group is not a message
    expect(warn).toHaveBeenCalledWith('[i18n] missing key "shell.nav.doesNotExist"');
    warn.mockRestore();
    expect(hasKey('shell.nav.home')).toBe(true);
    expect(hasKey('shell.nav.nope')).toBe(false);
  });

  it('formatters follow the locale', async () => {
    const d = new Date(2026, 9, 12, 18, 5);
    expect(fmtDate(d)).toBe('12. Oktober 2026');
    expect(fmtTime(d)).toBe('18:05');
    expect(fmtDateTime(d)).toBe('12.10.2026, 18:05');
    expect(fmtNumber(1234.5)).toBe('1.234,5');
    expect(fmtDuration(112 * 60)).toBe('1 Std. 52 Min.');
    expect(fmtDuration(45 * 60)).toBe('45 Min.');
    expect(fmtDuration(2 * 3600)).toBe('2 Std.');
    expect(fmtDuration(30)).toBe('30 Sek.');
    expect(fmtList(['Deutsch', 'Englisch', 'Japanisch'])).toBe('Deutsch, Englisch und Japanisch');
    const now = d.getTime();
    expect(fmtRelative(now - 86400_000, now)).toBe('gestern');
    expect(fmtRelative(now - 3 * 3600_000, now)).toBe('vor 3 Stunden');
    expect(fmtRelative(now + 2 * 86400_000, now)).toBe('übermorgen');
    expect(fmtDate('kaputt')).toBe('');
    expect(fmtDate(null)).toBe('');

    await setLocale('en');
    expect(fmtDate(d)).toBe('12 October 2026');
    expect(fmtNumber(1234.5)).toBe('1,234.5');
    expect(fmtDuration(112 * 60)).toBe('1 h 52 min');
    expect(fmtRelative(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(fmtList(['German', 'English'])).toBe('German and English');

    await setLocale('pl'); // no Polish texts yet: German pattern, Polish number formatting
    expect(fmtNumber(1234.5)).toBe('1234,5');
    expect(fmtDate(d)).toBe('12 października 2026');
  });

  it('English covers every key of the pilot areas (shell, account, common)', () => {
    for (const area of ['shell', 'account', 'common'] as const) {
      expect(keys(en[area] ?? {}), area).toEqual(keys(de[area]));
    }
  });

  it('plural objects in de have an "other" form and translations keep placeholders', () => {
    const msgs = (o: object, p = ''): Array<[string, string]> => Object.entries(o).flatMap(([k, v]) =>
      typeof v === 'string' ? [[p + k, v] as [string, string]] : v && typeof v === 'object' && 'other' in v ? Object.entries(v as Record<string, string>).map(([c, s]) => [`${p}${k}.${c}`, s] as [string, string]) : msgs(v as object, `${p}${k}.`));
    const deMap = new Map(msgs(de));
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const [k, s] of msgs(en)) {
      const base = deMap.get(k) ?? deMap.get(k.replace(/\.(one|few|many|two|zero)$/, '.other'));
      if (base !== undefined) expect(ph(s), k).toBe(ph(base));
    }
  });
});

describe('rich text', () => {
  it('only b, kbd and internal links become markup', () => {
    expect(richParts('Taste <kbd>/</kbd> oder <b>Geräte</b>: <a href="/devices">hier</a>.')).toEqual([
      { kind: 'text', text: 'Taste ' }, { kind: 'kbd', text: '/' }, { kind: 'text', text: ' oder ' }, { kind: 'b', text: 'Geräte' },
      { kind: 'text', text: ': ' }, { kind: 'a', href: '/devices', text: 'hier' }, { kind: 'text', text: '.' },
    ]);
    expect(richParts('<img src=x onerror=alert(1)> <a href="//evil.example">x</a> <a href="javascript:x">y</a>').every((p) => p.kind === 'text')).toBe(true);
  });
});
