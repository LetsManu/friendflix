// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Text contrast on the glass surfaces of settings, /me, the secondary pages and the phone (glass spec §6): the colours in
 * app.css (`:root`, `.panel, .frost-text`, `html.amb`), the phone search's genre tiles and the tab bar, checked with the tone
 * model against the brightest point of the (dimmed, B′) ambient background (AMB_PEAK): a light glass card over it, the raw
 * ambient itself, a card over the dark base and the solid fallback.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENRE_PALETTE } from '#lib/genreTint';
import {
  AA, AMB_PEAK, contrast, DARK_BASE, frostComposite, MILK_RGB, MILK_TOP, SCRIM_LIGHT, SCRIM_RGB, SCRIM_SAFE_DIM, SCRIM_TAB, SEL_A, TAB_DIM,
  TEXT_DIM, textContrast, type RGB,
} from './tone';

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const over = (back: RGB, top: RGB, a: number): RGB => back.map((v, i) => v * (1 - a) + top[i]! * a) as RGB;
const WHITE: RGB = [255, 255, 255];
const SOLID = hex('#1c1a21');
/** a light glass card at the brightest glow, the raw ambient there, a card over the dark base, the solid fallback */
const CARD_PEAK = frostComposite(AMB_PEAK, SCRIM_LIGHT);
const ON_GLASS_BG = [CARD_PEAK, AMB_PEAK, frostComposite(DARK_BASE, SCRIM_LIGHT), SOLID];
/** straight on the ambient background (no card): its brightest point and its base */
const ON_AMB_BG = [AMB_PEAK, DARK_BASE];

const css = readFileSync(fileURLToPath(new URL('../../app.css', import.meta.url)), 'utf8');
/** the custom properties a rule (exact selector) sets in app.css */
function vars(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
/** white at alpha (`rgba(255, 255, 255, a)`) or a hex colour */
const parse = (v: string): RGB | number => (v.startsWith('#') ? hex(v) : Number(/rgba\(255, 255, 255, ([\d.]+)\)/.exec(v)![1]));
const cr = (t: RGB | number, bg: RGB) => (typeof t === 'number' ? textContrast(bg, t) : contrast(t, bg));

describe('glass pages: text contrast (B′)', () => {
  const glass = vars('.panel, .frost-text');

  it('the light glass cards carry the mockup\'s levels', () => {
    expect(glass).toEqual({
      '--mut': 'rgba(255, 255, 255, .72)', '--hint': 'rgba(255, 255, 255, .66)',
      '--ok': '#4ade80', '--warn': '#f7b344', '--err': '#ffa8a8', '--link': '#80cbd4', '--info': '#80cbd4', '--acc-text': '#ffa7b6',
    });
  });

  it('every one of them passes AA on the card over the peak, the raw ambient, the card over the base and the solid fallback', () => {
    for (const [k, v] of Object.entries(glass)) for (const bg of ON_GLASS_BG) expect(cr(parse(v), bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(AA);
    // the settings side-nav links (white .75; settings/+page.svelte) too
    for (const bg of ON_GLASS_BG) expect(textContrast(bg, 0.75)).toBeGreaterThanOrEqual(AA);
  });

  it('the hierarchy is visible: plain white stands well above the dim text', () => {
    expect(textContrast(CARD_PEAK) / textContrast(CARD_PEAK, 0.72)).toBeGreaterThan(1.5);
    expect(textContrast(CARD_PEAK)).toBeGreaterThan(8);
    // the brand colours that would not pass on the card (why the glass ones are lighter)
    for (const c of ['#f5a623', '#ff6b6b', '#54b9c5', '#ff8aa0', '#b3bac2']) expect(contrast(hex(c), CARD_PEAK)).toBeLessThan(AA);
  });

  it('straight on the ambient background the usual colours pass; coral text takes the lighter coral (html.amb)', () => {
    const root = vars(':root');
    for (const k of ['--mut', '--ok', '--warn', '--err', '--link']) for (const bg of ON_AMB_BG) expect(contrast(hex(root[k]!), bg), k).toBeGreaterThanOrEqual(AA);
    expect(root['--link']).toBe('#54b9c5');
    expect(vars('html.amb')).toEqual({ '--acc-text': 'var(--acc-light)' }); // no grey override any more
    expect(root['--acc-light']).toBe('#ff8aa0');
    for (const bg of ON_AMB_BG) expect(contrast(hex('#ff8aa0'), bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(hex(root['--acc-text']!), AMB_PEAK)).toBeLessThan(AA); // the brand coral does not
  });

  it('a nested panel would draw a second scrim and milk: its dim text fails AA over a white backdrop (why glass never nests)', () => {
    const outer = frostComposite(WHITE, SCRIM_SAFE_DIM);
    const inner = over(over(outer, SCRIM_RGB, SCRIM_LIGHT), MILK_RGB, MILK_TOP);
    expect(textContrast(outer, TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    expect(textContrast(inner, TEXT_DIM)).toBeLessThan(AA);
    expect(css).toMatch(/html:root :is\(\.frost, \.frost-flat, \.panel\) \.panel \{ background: none;[^}]*box-shadow: none;/);
  });

  it('a nested panel keeps its surface\'s text levels: the light card\'s .72 / .66 would fail in the desk detail column', () => {
    // the recommend form (.panel.rec) inside DetailDesk's column, whose contract is white .9 over unsampled artwork
    const col = frostComposite(WHITE, SCRIM_SAFE_DIM);
    expect(textContrast(col, TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    expect(textContrast(col, 0.72)).toBeLessThan(AA);
    expect(textContrast(col, 0.66)).toBeLessThan(AA);
    // so every token the glass block sets is inherited again on a nested panel (more specific than the block)
    const nested = vars('html:root :is(.frost, .frost-flat, .panel) .panel');
    const block = vars('.panel, .frost-text');
    expect(Object.keys(nested).sort()).toEqual(Object.keys(block).sort());
    for (const v of Object.values(nested)) expect(v).toBe('inherit');
  });

  it('a darker row hover and the darker field fill only add contrast', () => {
    const hover = over(CARD_PEAK, SCRIM_RGB, 0.3), field = over(CARD_PEAK, SCRIM_RGB, 0.35);
    expect(textContrast(hover, 0.72)).toBeGreaterThan(textContrast(CARD_PEAK, 0.72));
    expect(textContrast(field)).toBeGreaterThan(textContrast(CARD_PEAK));
  });

  it('phone search genre tiles: white over the glass with the genre wash at any strength', () => {
    for (const g of GENRE_PALETTE) for (let a = 0; a <= 1.0001; a += 0.05) for (const c of ON_GLASS_BG) expect(textContrast(over(c, hex(g), Math.min(1, a)))).toBeGreaterThanOrEqual(AA);
  });

  it('the tab bar: its scrim is the lightest with which the .72 labels and the white label on the .13 pill pass over pure white', () => {
    expect(TAB_DIM).toBe(0.72);
    const ok = (s: number) => { const bar = frostComposite(WHITE, s); return textContrast(bar, TAB_DIM) >= AA && textContrast(over(bar, WHITE, SEL_A)) >= AA; };
    expect(ok(SCRIM_TAB)).toBe(true);
    expect(ok(SCRIM_TAB - 0.01)).toBe(false);
    // and the bar stays far above AA in calm mode (solid)
    expect(textContrast(SOLID, TAB_DIM)).toBeGreaterThan(9);
  });
});
