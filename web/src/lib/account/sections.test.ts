// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { currentSection, SPY_OFFSET } from './sections';

describe('currentSection', () => {
  const tops = [100, 500, 900, 1400];
  it('no sections: -1', () => {
    expect(currentSection([], 0)).toBe(-1);
    expect(currentSection([], 500, SPY_OFFSET, true)).toBe(-1);
  });
  it('before the first section: the first', () => {
    expect(SPY_OFFSET).toBe(120);
    expect(currentSection(tops, 0, 0)).toBe(0);
    expect(currentSection([300, 600], 0)).toBe(0);
  });
  it('the last section whose top passed the line', () => {
    expect(currentSection(tops, 0)).toBe(0);
    expect(currentSection(tops, 379)).toBe(0);
    expect(currentSection(tops, 380)).toBe(1);
    expect(currentSection(tops, 800)).toBe(2);
    expect(currentSection(tops, 800, 0)).toBe(1);
    expect(currentSection(tops, 5000)).toBe(3);
  });
  it('at the bottom: the last section', () => {
    expect(currentSection(tops, 400, SPY_OFFSET, true)).toBe(3);
  });
});
