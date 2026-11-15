// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACC_FILL_ON, ACC_LIGHT_ON, ACC_LINE_ON, ACC_TEXT_ON, contrast, DEFAULT_TOKENS, deriveTokens, type BrandTokens } from '../src/brand/colors.js';
import { DEFAULT_BRAND } from '../src/brand/schema.js';

// Branding stage A, Task 1: the contrast-safe accent tokens. The vectors are shared with the web (it ports the same algorithm and runs
// the same file), so a change here is a change of both.
interface Vectors {
  targets: { accText: { on: string; min: number }; accFill: { on: string; min: number }; accLight: { on: string; min: number }; accLine: { on: string; min: number } };
  vectors: Array<{ accent: string; note?: string; adjusted: { text: boolean; fill: boolean }; tokens?: Omit<BrandTokens, 'adjusted'> }>;
}
const file = fileURLToPath(new URL('../../test-vectors/brand-colors.json', import.meta.url));
const V = JSON.parse(readFileSync(file, 'utf8')) as Vectors;

const REQUIRED = ['#ff4f6d', '#a37cff', '#4c9dff', '#2fc4b2', '#f2b52c', '#5ccf6a', '#f2e94e', '#1a1a40', '#ffffff', '#000000'];
const HEX = /^#[0-9a-f]{6}$/;

describe('contrast (WCAG 2)', () => {
  it('white on black is 21, a colour on itself 1, and it is symmetric', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#ff4f6d', '#ff4f6d')).toBe(1);
    expect(contrast('#d6325a', '#ffffff')).toBeCloseTo(contrast('#ffffff', '#d6325a'), 10);
  });
  it('matches the ratios the stylesheet documents for today\'s coral', () => {
    expect(contrast('#ff4f6d', '#101418')).toBeCloseTo(5.8, 1); // app.css: coral 5.8:1 on --bg
    expect(contrast('#ffffff', '#d6325a')).toBeCloseTo(4.7, 1); // app.css: white on --acc-fill 4.7:1
  });
});

describe('the shared vectors', () => {
  it('cover every required accent and name the same targets as the code', () => {
    expect(V.vectors.map((v) => v.accent)).toEqual(expect.arrayContaining(REQUIRED));
    expect(V.targets).toEqual({
      accText: { on: ACC_TEXT_ON, min: 4.5 }, accFill: { on: ACC_FILL_ON, min: 4.5 },
      accLight: { on: ACC_LIGHT_ON, min: 4.5 }, accLine: { on: ACC_LINE_ON, min: 3 },
    });
    expect(V.vectors.every((v) => v.tokens !== undefined)).toBe(true);
  });

  for (const v of V.vectors) {
    it(`${v.accent}${v.note ? ` (${v.note})` : ''}: every ratio holds, adjusted and the tokens match the vector`, () => {
      const t = deriveTokens(v.accent);
      for (const k of ['acc', 'accHover', 'accFill', 'accFillHover', 'accText', 'accLight', 'accLine'] as const) expect(t[k], k).toMatch(HEX);
      expect(contrast(t.accText, V.targets.accText.on)).toBeGreaterThanOrEqual(V.targets.accText.min);
      expect(contrast(t.acc, V.targets.accText.on)).toBeGreaterThanOrEqual(V.targets.accText.min);
      expect(contrast('#ffffff', t.accFill)).toBeGreaterThanOrEqual(V.targets.accFill.min);
      expect(contrast('#ffffff', t.accFillHover)).toBeGreaterThanOrEqual(V.targets.accFill.min);
      expect(contrast(t.accLight, V.targets.accLight.on)).toBeGreaterThanOrEqual(V.targets.accLight.min);
      expect(contrast(t.accLine, V.targets.accLine.on)).toBeGreaterThanOrEqual(V.targets.accLine.min);
      expect(t.adjusted).toEqual(v.adjusted);
      const { adjusted: _a, ...tokens } = t;
      expect(tokens).toEqual(v.tokens);
    });
  }
});

describe('deriveTokens', () => {
  it('the default accent gives exactly today\'s stylesheet table (fill counted as adjusted: it is a darker shade)', () => {
    expect(DEFAULT_BRAND.accent).toBe('#ff4f6d');
    expect(deriveTokens('#ff4f6d')).toEqual({
      acc: '#ff4f6d', accHover: '#e63e5c', accFill: '#d6325a', accFillHover: '#c9304d', accText: '#ff4f6d', accLight: '#ff8aa0', accLine: '#ff9cad',
      adjusted: { text: false, fill: true },
    });
    expect(deriveTokens('#FF4F6D')).toEqual(DEFAULT_TOKENS);
  });
  it('is pure: the same accent always gives the same tokens, and the default table cannot be changed from outside', () => {
    expect(deriveTokens('#a37cff')).toEqual(deriveTokens('#a37cff'));
    const t = deriveTokens('#ff4f6d');
    t.acc = '#000000';
    t.adjusted.fill = false;
    expect(deriveTokens('#ff4f6d').acc).toBe('#ff4f6d');
    expect(deriveTokens('#ff4f6d').adjusted.fill).toBe(true);
  });
  it('a too-light accent keeps its text colour and gets a darker fill; a too-dark one keeps its fill and gets a lighter text', () => {
    const light = deriveTokens('#f2e94e');
    expect([light.accText, light.adjusted]).toEqual(['#f2e94e', { text: false, fill: true }]);
    const dark = deriveTokens('#1a1a40');
    expect([dark.accFill, dark.adjusted]).toEqual(['#1a1a40', { text: true, fill: false }]);
  });
  it('refuses anything but a 6-digit hex colour', () => {
    for (const bad of ['', 'ff4f6d', '#fff', '#ff4f6g', '#ff4f6d0', 'red', '#ff4f6d;x']) expect(() => deriveTokens(bad), bad).toThrow();
  });
});
