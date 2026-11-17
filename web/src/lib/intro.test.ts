// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADED, type LoadedBrand } from './brand';
import { decideIntroMark, introMarkSource, preloadMark, DEFAULT_INTRO, introKey, isIntroFreeRoute, parseIntroSettings, shouldPlayIntro, shouldPlayIntroSound } from './intro';

const base = { setting: true, reducedMotion: false, route: '/', sessionSeen: false, tv: false };

describe('shouldPlayIntro', () => {
  it('plays by default', () => expect(shouldPlayIntro(base)).toBe(true));
  it('respects the setting', () => expect(shouldPlayIntro({ ...base, setting: false })).toBe(false));
  it('never plays on TV', () => expect(shouldPlayIntro({ ...base, tv: true })).toBe(false));
  it('plays at most once per session', () => expect(shouldPlayIntro({ ...base, sessionSeen: true })).toBe(false));
  it('never plays during watch / party / public routes', () => {
    for (const route of ['/watch/abc', '/party/xyz', '/tv', '/invite/code', '/offline', '/pending', '/restore']) expect(shouldPlayIntro({ ...base, route })).toBe(false);
    expect(shouldPlayIntro({ ...base, route: '/watchlist' })).toBe(true);
  });
  it('reduced motion: user-triggered shows the calm fade, cold start is skipped', () => {
    expect(shouldPlayIntro({ ...base, reducedMotion: true })).toBe(true);
    expect(shouldPlayIntro({ ...base, reducedMotion: true, cold: true })).toBe(false);
  });
  it('calm mode: no cold-start intro (a user-triggered one still shows, as the calm fade)', () => {
    expect(shouldPlayIntro({ ...base, cold: true, calm: true })).toBe(false);
    expect(shouldPlayIntro({ ...base, cold: true, calm: false })).toBe(true);
    expect(shouldPlayIntro({ ...base, calm: true })).toBe(true);
  });
});

describe('shouldPlayIntroSound', () => {
  const s = { sound: true, soundExplicit: false, reducedMotion: false };
  it('plays after a gesture', () => expect(shouldPlayIntroSound(s)).toBe(true));
  it('never on cold start', () => expect(shouldPlayIntroSound({ ...s, cold: true })).toBe(false));
  it('off when disabled', () => expect(shouldPlayIntroSound({ ...s, sound: false })).toBe(false));
  it('reduced motion needs an explicit opt-in', () => {
    expect(shouldPlayIntroSound({ ...s, reducedMotion: true })).toBe(false);
    expect(shouldPlayIntroSound({ ...s, reducedMotion: true, soundExplicit: true })).toBe(true);
  });
});

describe('settings storage', () => {
  it('keys per profile with a global fallback', () => {
    expect(introKey('p1')).toBe('ff-intro:p1');
    expect(introKey('')).toBe('ff-intro:global');
    expect(introKey(null)).toBe('ff-intro:global');
  });
  it('parses defensively', () => {
    expect(parseIntroSettings(null)).toEqual(DEFAULT_INTRO);
    expect(parseIntroSettings('not json')).toEqual(DEFAULT_INTRO);
    expect(parseIntroSettings('42')).toEqual(DEFAULT_INTRO);
    expect(parseIntroSettings('{"show":false,"sound":true}')).toEqual({ show: false, sound: true, soundExplicit: true });
    expect(parseIntroSettings('{"show":"x","sound":false}')).toEqual({ show: true, sound: false, soundExplicit: false });
  });
  it('route helper', () => expect(isIntroFreeRoute('/watch/1')).toBe(true));
});

describe('intro mark decision (brand present / absent / image failure)', () => {
  const sym = `/api/public/brand/img/${'a'.repeat(64)}.png`;
  const mk = (name: string, symbol?: string, logo?: string): LoadedBrand => ({ ...DEFAULT_LOADED, name, shortName: name, images: { ...(symbol ? { symbol } : {}), ...(logo ? { logo } : {}) } });
  const wide = `/api/public/brand/img/${'b'.repeat(64)}.png`;

  it('no branding: the built-in mark, nothing to preload', () => {
    expect(introMarkSource(DEFAULT_LOADED)).toBeNull();
    expect(decideIntroMark(DEFAULT_LOADED, false)).toBe('builtin');
  });
  it('a custom name without a symbol: the initial, nothing to preload', () => {
    expect(introMarkSource(mk('Moonbeam'))).toBeNull();
    expect(decideIntroMark(mk('Moonbeam'), false)).toBe('initial');
  });
  it('a symbol: preloaded; the image once it loaded', () => {
    expect(introMarkSource(mk('Moonbeam', sym))).toBe(sym);
    expect(decideIntroMark(mk('Moonbeam', sym), true)).toBe('image');
  });
  it('a logo without a symbol: preloaded, shown as the logo; failed: the initial', () => {
    expect(introMarkSource(mk('Moonbeam', undefined, wide))).toBe(wide);
    expect(decideIntroMark(mk('Moonbeam', undefined, wide), true)).toBe('logo');
    expect(decideIntroMark(mk('Moonbeam', undefined, wide), false)).toBe('initial');
  });
  it('the symbol wins over the logo', () => {
    expect(introMarkSource(mk('Moonbeam', sym, wide))).toBe(sym);
    expect(decideIntroMark(mk('Moonbeam', sym, wide), true)).toBe('image');
  });
  it('a symbol that failed: the initial for a custom name, the built-in mark for the default name', () => {
    expect(decideIntroMark(mk('Moonbeam', sym), false)).toBe('initial');
    expect(decideIntroMark(mk('FriendFlix', sym), false)).toBe('builtin');
  });
});

describe('preloadMark', () => {
  it('resolves true on load, false on error and on timeout', async () => {
    const make = (fire: 'load' | 'error' | 'never') => class { onload: (() => void) | null = null; onerror: (() => void) | null = null; decoding = ''; set src(_: string) { queueMicrotask(() => { if (fire === 'load') this.onload?.(); else if (fire === 'error') this.onerror?.(); }); } };
    expect(await preloadMark('/x.png', make('load') as never, 50)).toBe(true);
    expect(await preloadMark('/x.png', make('error') as never, 50)).toBe(false);
    expect(await preloadMark('/x.png', make('never') as never, 20)).toBe(false);
    expect(await preloadMark('/x.png', undefined as never, 20)).toBe(false);
  });
});
