// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const card = read('./RatingCard.svelte'), desk = read('../desk/DeskBillboard.svelte'), hero = read('../Hero.svelte');
const cardTpl = read('../Card.svelte'), posterTpl = read('../PosterCard.svelte'), row = read('../Row.svelte');

describe('hero rating card', () => {
  it('shows for 4 s, only without calm mode / reduced motion, never takes pointer events, renders nothing without a rating', () => {
    expect(card).toMatch(/SHOW_MS = 4000/);
    expect(card).toMatch(/motionAllowed\(\)/);
    expect(card).toMatch(/\{#if allowed && rating\}/);
    expect(card).toMatch(/pointer-events: none/);
    expect(card).toMatch(/role="status" aria-live="polite" aria-atomic="true"/);
  });
  it('fades with opacity and transform only, and joins the reasons into a second line', () => {
    expect(card).toMatch(/transition: opacity 400ms ease-out, transform 400ms ease-out/);
    expect(card).toMatch(/reasons\.filter\(Boolean\)\.join\(', '\)/);
  });
  it('replaces the edge flag on the desktop billboard; the plain rating stays in the meta line', () => {
    expect(desk).not.toMatch(/agebadge/);
    expect(desk).toMatch(/<RatingCard rating=\{item\.rating \?\? ''\}/);
    expect(desk).toMatch(/class="age"/);
    expect(hero).toMatch(/<RatingCard /);
  });
});

describe('ranked rows', () => {
  it('no hollow numerals or chip: the card shows a glass strip and exposes "Platz n: title"', () => {
    expect(row).not.toMatch(/text-stroke|\.rank\b/);
    expect(row).toMatch(/rank=\{ranked \? idx \+ 1 : 0\}/);
    for (const src of [cardTpl, posterTpl]) {
      expect(src).toMatch(/class="rkbar frost frost-safe"/);
      expect(src).toMatch(/\$t\('home\.row\.rank', \{ n: rank \}\)/);
      expect(src).toMatch(/\.rkn \{[^}]*color: #ffa7b6/);
    }
  });
});
