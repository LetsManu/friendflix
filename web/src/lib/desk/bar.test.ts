// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { deskUi, pillSolid } from './bar';

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
