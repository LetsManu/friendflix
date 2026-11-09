// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dense glass admin (glass spec §7): which stat values count up, and every admin text colour on the new glass surfaces
 * (sidebar, tiles, tables, status pills, fields), checked with the tone model against the brightest point of the dimmed
 * ambient background (AMB_PEAK): a light glass card over it, the raw ambient, a card over the dark base and the solid
 * fallback (calm mode, TV, kids).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countable } from './glass';
import { AA, AMB_PEAK, contrast, DARK_BASE, frostComposite, SCRIM_LIGHT, SCRIM_RGB, SEL_A, textContrast, type RGB } from '#lib/glass/tone';

describe('countable', () => {
  it('takes finite numbers', () => {
    expect(countable(0)).toBe(0);
    expect(countable(12)).toBe(12);
    expect(countable(2431)).toBe(2431);
    expect(countable(Number.NaN)).toBeNull();
    expect(countable(Number.POSITIVE_INFINITY)).toBeNull();
  });
  it('takes digit strings with or without thousands separators, as fmtNumber writes them in each locale', () => {
    expect(countable('7')).toBe(7);
    expect(countable('2431')).toBe(2431);
    expect(countable('2.431')).toBe(2431);
    expect(countable('2,431')).toBe(2431);
    expect(countable('2 431')).toBe(2431);
    expect(countable('2 431')).toBe(2431);
    expect(countable('2 431')).toBe(2431);
    expect(countable('1.234.567')).toBe(1234567);
    expect(countable(new Intl.NumberFormat('de').format(98765))).toBe(98765);
    expect(countable(new Intl.NumberFormat('fr').format(98765))).toBe(98765);
  });
  it('refuses units, dashes, decimals, mixed separators and null', () => {
    for (const v of ['3 GB', '12 %', '–', '—', '-', '', '1.5', '2,43', '1.234,567', '1,234.567', '12a', 'abc', ' ']) expect(countable(v), v).toBeNull();
    expect(countable(null)).toBeNull();
    expect(countable(undefined)).toBeNull();
  });
});

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const over = (back: RGB, top: RGB, a: number): RGB => back.map((v, i) => v * (1 - a) + top[i]! * a) as RGB;
const WHITE: RGB = [255, 255, 255];
const SOLID = hex('#1c1a21');
const CARD_PEAK = frostComposite(AMB_PEAK, SCRIM_LIGHT);
/** the glass surfaces' backgrounds: card over the peak, raw ambient, card over the base, solid fallback */
const ON_GLASS = [CARD_PEAK, AMB_PEAK, frostComposite(DARK_BASE, SCRIM_LIGHT), SOLID];
/** the glass text levels (app.css `.panel, .frost-text`) */
const MUT = 0.72, HINT = 0.66, NAV = 0.75;
const GLASS = { ok: '#4ade80', warn: '#f7b344', err: '#ffa8a8', info: '#80cbd4', link: '#80cbd4', accText: '#ffa7b6' };
/** StatusPill: the tone wash (app.css --tone-*) over a .35 scrim fill */
const PILL_FILL = 0.35;
const TONES: Record<string, [RGB, number, string | number]> = {
  ok: [[70, 211, 105], 0.14, GLASS.ok], warn: [[245, 166, 35], 0.15, GLASS.warn], err: [[255, 107, 107], 0.15, GLASS.err],
  info: [[84, 185, 197], 0.15, GLASS.info], muted: [WHITE, 0.08, MUT],
};
const cr = (t: string | number, bg: RGB) => (typeof t === 'number' ? textContrast(bg, t) : contrast(hex(t), bg));

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const appCss = read('../../app.css'), shell = read('./AdminShell.svelte'), pill = read('../ui/StatusPill.svelte');
const table = read('../ui/DataTable.svelte'), tile = read('../ui/StatTile.svelte'), field = read('../ui/Field.svelte');

describe('admin glass: text contrast (B′)', () => {
  it('the glass text tokens include the lighter info colour', () => {
    expect(appCss).toContain(`--info: ${GLASS.info};`);
    expect(appCss).toMatch(/\.panel, \.frost-text \{[^}]*--info: #80cbd4;/);
  });

  it('sidebar: group headings (.72), links (.75), the current link white on the light pill, hover on the darker fill', () => {
    expect(shell).toMatch(/class="side frost-flat frost-panel frost-text"/);
    expect(shell).toContain('color: rgba(255, 255, 255, .75)');
    expect(shell).toContain('background: rgba(var(--fr-scrim-rgb), .3)');
    for (const bg of ON_GLASS) {
      expect(textContrast(bg, MUT)).toBeGreaterThanOrEqual(AA);
      expect(textContrast(bg, NAV)).toBeGreaterThanOrEqual(AA);
      expect(textContrast(over(bg, WHITE, SEL_A))).toBeGreaterThanOrEqual(AA);
      expect(textContrast(over(bg, SCRIM_RGB, 0.3))).toBeGreaterThanOrEqual(AA);
    }
    // the pending / failing counts: dark text on the glass status colours
    expect(contrast(hex('#1a1200'), hex(GLASS.warn))).toBeGreaterThanOrEqual(AA);
    expect(contrast(hex('#220000'), hex(GLASS.err))).toBeGreaterThanOrEqual(AA);
  });

  it('tiles: value white, label .72, hint .66 and the tone hints on the glass tile', () => {
    expect(tile).toContain('class="tile frost-flat frost-text {tone}"');
    for (const bg of ON_GLASS) {
      expect(textContrast(bg)).toBeGreaterThanOrEqual(AA);
      for (const t of [MUT, HINT, GLASS.ok, GLASS.warn, GLASS.err]) expect(cr(t, bg), `${t}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('tables: the solid sticky header (.72), cells white / .72 on the card and on the darker hover and phone row fill', () => {
    expect(table).toContain('background: var(--fr-solid)');
    expect(table).toContain('background: rgba(var(--fr-scrim-rgb), .3)');
    expect(textContrast(SOLID, MUT)).toBeGreaterThanOrEqual(AA);
    for (const bg of ON_GLASS) for (const b of [bg, over(bg, SCRIM_RGB, 0.3)]) {
      expect(textContrast(b)).toBeGreaterThanOrEqual(AA);
      expect(textContrast(b, MUT)).toBeGreaterThanOrEqual(AA);
      expect(cr(GLASS.link, b)).toBeGreaterThanOrEqual(AA);
    }
  });

  it('status pills: every tone\'s text on its wash over the scrim fill passes; the plain wash alone would not', () => {
    for (const k of Object.keys(TONES)) expect(pill).toContain(`linear-gradient(var(--tone-${k}), var(--tone-${k})), rgba(var(--fr-scrim-rgb), ${String(PILL_FILL).slice(1)})`);
    for (const [k, [c, a, text]] of Object.entries(TONES)) for (const bg of ON_GLASS) {
      expect(cr(text, over(over(bg, SCRIM_RGB, PILL_FILL), c, a)), `${k} on ${bg}`).toBeGreaterThanOrEqual(AA);
    }
    // why the fill: the old wash straight on the card over the peak
    for (const k of ['ok', 'warn', 'err', 'info'] as const) { const [c, a, text] = TONES[k]!; expect(cr(text, over(CARD_PEAK, c, a))).toBeLessThan(AA); }
    // and the pill never says it by colour alone: an icon per tone and a text
    expect(pill).toMatch(/TONE_ICON: Record<Tone, string> = \{ ok: 'check', warn: 'clock', err: 'alert', info: 'info', muted: 'x' \}/);
  });

  it('fields and selects: white text and the error colour on the darker glass fill', () => {
    expect(field).toContain('background: rgba(var(--fr-scrim-rgb), .35)');
    for (const bg of ON_GLASS) {
      const f = over(bg, SCRIM_RGB, 0.35);
      expect(textContrast(f)).toBeGreaterThanOrEqual(AA);
      expect(cr(GLASS.err, bg)).toBeGreaterThanOrEqual(AA);
      expect(cr(HINT, bg)).toBeGreaterThanOrEqual(AA);
    }
  });

  it('coral text: the light coral on glass, the ambient coral straight on the ambient; the brand coral as text fails there', () => {
    for (const bg of ON_GLASS) expect(cr(GLASS.accText, bg)).toBeGreaterThanOrEqual(AA);
    for (const bg of [AMB_PEAK, DARK_BASE]) expect(contrast(hex('#ff8aa0'), bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(hex('#ff4f6d'), AMB_PEAK)).toBeLessThan(AA);
    // the recommendation card's "change" link and the cast bar's hint use the coral text token, not the brand coral
    expect(read('./RecoCard.svelte')).toMatch(/\.change \{[^}]*color: var\(--acc-text\)/);
    expect(read('../cast/CastBar.svelte')).toMatch(/\.t2\.hint \{ color: var\(--acc-text\); \}/);
  });
});
