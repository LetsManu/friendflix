// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Text contrast on the glass surfaces of settings, /me, the secondary pages and the phone (glass spec §6): the colours in
 * app.css (`.panel, .frost-text`, `html.amb`), the phone search's genre tiles and the tab bar, checked with the tone model
 * against the brightest point of the ambient background (AMB_PEAK), the dark base and the solid fallback.
 */
import { describe, expect, it } from 'vitest';
import { GENRE_PALETTE } from '#lib/genreTint';
import { AA, AMB_PEAK, contrast, DARK_BASE, frostComposite, SCRIM_LIGHT, SCRIM_SAFE_DIM, TEXT_DIM, textContrast, type RGB } from './tone';

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const over = (back: RGB, top: RGB, a: number): RGB => back.map((v, i) => v * (1 - a) + top[i]! * a) as RGB;
const WHITE: RGB = [255, 255, 255];
const SOLID = hex('#1c1a21');
/** a light glass card over the ambient background: its brightest and darkest point, and the solid fallback */
const CARD = [frostComposite(AMB_PEAK, SCRIM_LIGHT), frostComposite(DARK_BASE, SCRIM_LIGHT), SOLID];
/** app.css `.panel, .frost-text` */
const ON_GLASS = { ok: '#c4f7d4', warn: '#ffe9c2', err: '#ffe8e8', link: '#cdf3f7' };

describe('glass pages: text contrast', () => {
  it('dim text on the light glass cards is white at TEXT_DIM (.9)', () => {
    expect(TEXT_DIM).toBe(0.9);
    for (const c of CARD) expect(textContrast(c, TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    // the old grey (#b3bac2) and a lighter grey fail over the brightest glow under the light scrim
    expect(contrast(hex('#b3bac2'), CARD[0]!)).toBeLessThan(AA);
    expect(contrast(hex('#d6dadf'), CARD[0]!)).toBeLessThan(AA);
  });

  it('the status and link colours on the glass cards', () => {
    for (const c of CARD) for (const v of Object.values(ON_GLASS)) expect(contrast(hex(v), c)).toBeGreaterThanOrEqual(AA);
  });

  it('dim text straight on the ambient background (html.amb --mut)', () => {
    for (const c of [AMB_PEAK, DARK_BASE]) expect(contrast(hex('#d6dadf'), c)).toBeGreaterThanOrEqual(AA);
    expect(contrast(hex('#b3bac2'), AMB_PEAK)).toBeLessThan(AA);
  });

  it('a darker row hover and the darker field fill only add contrast', () => {
    const hover = over(CARD[0]!, [18, 16, 24], 0.3), field = over(CARD[0]!, [18, 16, 24], 0.35);
    expect(textContrast(hover, TEXT_DIM)).toBeGreaterThan(textContrast(CARD[0]!, TEXT_DIM));
    expect(textContrast(field)).toBeGreaterThan(textContrast(CARD[0]!));
  });

  it('phone search genre tiles: white over the glass with the genre wash at any strength', () => {
    for (const g of GENRE_PALETTE) for (let a = 0; a <= 1.0001; a += 0.05) for (const c of CARD) expect(textContrast(over(c, hex(g), Math.min(1, a)))).toBeGreaterThanOrEqual(AA);
  });

  it('the tab bar (safe scrim solved for its .9 labels) over pure white, with its light highlight', () => {
    const bar = frostComposite(WHITE, SCRIM_SAFE_DIM);
    expect(textContrast(bar, TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    expect(textContrast(over(bar, WHITE, 0.1))).toBeGreaterThanOrEqual(AA);
    expect(textContrast(over(bar, WHITE, 0.13))).toBeLessThan(AA); // the old .13 highlight was too light
  });
});
