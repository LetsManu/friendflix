// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { exitLgApp, isLgApp, shouldExitOnBack, webosVersion, type LgWin } from './detect';

const APP_UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/108 Safari/537.36 WebAppManager';
const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
const win = (o: { ua?: string; search?: string } = {}): LgWin & { sessionStorage: ReturnType<typeof store> } => ({
  navigator: { userAgent: o.ua ?? 'Mozilla/5.0 Chrome/120' }, location: { search: o.search ?? '' }, sessionStorage: store(),
});

describe('isLgApp', () => {
  it('recognises the LG user agent plus ff_app=webos and stores the hint', () => {
    const w = win({ ua: APP_UA, search: '?ff_app=webos' });
    expect(isLgApp(w)).toBe(true);
    expect(w.sessionStorage.m.get('ff.app')).toBe('webos');
  });
  it('uses the stored flag after in-app navigation', () => {
    const w = win({ ua: APP_UA });
    w.sessionStorage.setItem('ff.app', 'webos');
    expect(isLgApp(w)).toBe(true);
  });
  it('is false for the LG browser alone', () => {
    expect(isLgApp(win({ ua: APP_UA }))).toBe(false);
  });
  it('is false for the URL hint on a desktop user agent', () => {
    expect(isLgApp(win({ search: '?ff_app=webos' }))).toBe(false);
  });
  it('still works when sessionStorage throws, with the URL hint', () => {
    const w: LgWin = { ...win({ ua: APP_UA, search: '?ff_app=webos' }), sessionStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } };
    expect(isLgApp(w)).toBe(true);
  });
});

describe('webosVersion', () => {
  it('reads webOSTV/<n>', () => {
    expect(webosVersion(win({ ua: 'Mozilla/5.0 (Web0S; Linux/SmartTV) webOSTV/6.0' }))).toBe('6.0');
    expect(webosVersion(win({ ua: 'Mozilla/5.0 (Web0S) webOSTV/22' }))).toBe('22');
  });
  it('maps webOS.TV-2025 to 25', () => {
    expect(webosVersion(win({ ua: 'Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/120 webOS.TV-2025 Safari' }))).toBe('25');
  });
  it('is null otherwise', () => {
    expect(webosVersion(win())).toBeNull();
    expect(webosVersion(win({ ua: APP_UA }))).toBeNull();
  });
});

describe('exitLgApp', () => {
  it('calls PalmSystem.platformBack when present', () => {
    const platformBack = vi.fn(), close = vi.fn();
    exitLgApp({ PalmSystem: { platformBack }, close });
    expect(platformBack).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
  it('falls back to close', () => {
    const close = vi.fn();
    exitLgApp({ close });
    expect(close).toHaveBeenCalledOnce();
  });
  it('never throws', () => {
    expect(() => exitLgApp({})).not.toThrow();
    expect(() => exitLgApp({ PalmSystem: { platformBack: () => { throw new Error('x'); } } })).not.toThrow();
  });
});

describe('shouldExitOnBack', () => {
  const base = { path: '/', modalId: undefined as unknown, dropdownOpen: false, editable: false };
  it('exits on home with nothing open', () => expect(shouldExitOnBack(base)).toBe(true));
  it('Back on home with a dropdown open closes it, no exit', () => expect(shouldExitOnBack({ ...base, dropdownOpen: true })).toBe(false));
  it('does not exit away from home', () => expect(shouldExitOnBack({ ...base, path: '/title/x' })).toBe(false));
  it('does not exit with a modal open', () => expect(shouldExitOnBack({ ...base, modalId: 'abc' })).toBe(false));
  it('does not exit while typing', () => expect(shouldExitOnBack({ ...base, editable: true })).toBe(false));
});

describe('without a window (server render, prerender)', () => {
  it('isLgApp is false, webosVersion is null, exitLgApp does nothing; none throws', () => {
    expect(typeof window).toBe('undefined');
    expect(isLgApp()).toBe(false);
    expect(webosVersion()).toBeNull();
    expect(() => exitLgApp()).not.toThrow();
  });
});
