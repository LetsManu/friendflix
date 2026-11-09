// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { alphaOf, deskUi, pillSolid } from './bar';

describe('deskUi', () => {
  it('is true only when tv, mobile and kids are all off', () => {
    expect(deskUi({ tv: false, mobile: false, kids: false })).toBe(true);
    expect(deskUi({ tv: true, mobile: false, kids: false })).toBe(false);
    expect(deskUi({ tv: false, mobile: true, kids: false })).toBe(false);
    expect(deskUi({ tv: false, mobile: false, kids: true })).toBe(false);
  });
});

describe('pillSolid', () => {
  it('is transparent only at the top of a hero page', () => {
    expect(pillSolid(0, true)).toBe(false);
    expect(pillSolid(24, true)).toBe(false);
    expect(pillSolid(25, true)).toBe(true);
    expect(pillSolid(0, false)).toBe(true);
  });
});

describe('alphaOf', () => {
  it('reads the alpha of rgb()/rgba() in comma and space syntax', () => {
    expect(alphaOf(' rgba(255, 255, 255, .13)')).toBe(0.13);
    expect(alphaOf('rgb(255 255 255 / 13%)')).toBe(0.13);
    expect(alphaOf('rgb(255, 255, 255)')).toBe(1);
    expect(alphaOf('rgba(0, 0, 0, 2)')).toBe(1);
  });
  it('reads hex colours (the built CSS writes the token as #ffffff21)', () => {
    expect(alphaOf('#ffffff21')).toBe(0.13);
    expect(alphaOf(' #fff2 ')).toBe(0.13);
    expect(alphaOf('#ffffff')).toBe(1);
    expect(alphaOf('#fff')).toBe(1);
    expect(alphaOf('#fffff')).toBeNull();
  });
  it('is null for anything else', () => {
    expect(alphaOf('')).toBeNull();
    expect(alphaOf('red')).toBeNull();
    expect(alphaOf('rgba(1, 2)')).toBeNull();
    expect(alphaOf('rgba(1, 2, 3, x)')).toBeNull();
  });
});
