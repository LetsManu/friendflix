// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isTizenApp, tizenVersion, type TizenWin } from './detect';

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
const win = (o: Partial<TizenWin> & { ua?: string; search?: string } = {}): TizenWin & { sessionStorage: ReturnType<typeof store> } => ({
  navigator: { userAgent: o.ua ?? 'Mozilla/5.0 Chrome/120' }, location: { search: o.search ?? '' }, sessionStorage: store(), ...('tizen' in o ? { tizen: o.tizen } : {}),
});

describe('isTizenApp', () => {
  it('recognises the user agent marker', () => {
    expect(isTizenApp(win({ ua: 'Mozilla/5.0 (SMART-TV; Tizen 6.5) FriendFlixTizen/1.0.0' }))).toBe(true);
  });
  it('recognises the tizen object plus ff_app=tizen and stores it', () => {
    const w = win({ tizen: {}, search: '?ff_app=tizen' });
    expect(isTizenApp(w)).toBe(true);
    expect(w.sessionStorage.m.get('ff.app')).toBe('tizen');
  });
  it('uses the stored flag after in-app navigation', () => {
    const w = win({ tizen: {} });
    w.sessionStorage.setItem('ff.app', 'tizen');
    expect(isTizenApp(w)).toBe(true);
  });
  it('is false in a plain browser, and for the query alone', () => {
    expect(isTizenApp(win())).toBe(false);
    expect(isTizenApp(win({ search: '?ff_app=tizen' }))).toBe(false);
    expect(isTizenApp(win({ tizen: {} }))).toBe(false);
  });
});

describe('tizenVersion', () => {
  it('reads the platform version from the user agent', () => {
    expect(tizenVersion(win({ ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit' }))).toBe('6.5');
    expect(tizenVersion(win())).toBeNull();
  });
});
