// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The accessibility audit's colour fixes (2026-11-09), pinned against the stylesheets they live in: every number here is read
 * from the source, then checked with the tone model (lib/glass/tone.ts) against the worst case the audit measured - a pure
 * white picture behind the scrim (bright posters, a bright video frame). Text needs AA (4.5:1), focus indicators 3:1.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA, contrast, textContrast, type RGB } from '#lib/glass/tone';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const over = (back: RGB, top: RGB, a: number): RGB => back.map((v, i) => v * (1 - a) + top[i]! * a) as RGB;
/** black at `a` over a white picture: what text sits on under a scrim */
const scrimOnWhite = (a: number) => over(WHITE, BLACK, a);
/** the body of the first rule whose selector list contains `sel` exactly */
function rule(css: string, sel: string): string {
  const i = css.indexOf(sel + ' {');
  expect(i, `rule ${sel}`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
}
const alphaAt = (body: string, stop: string) => {
  const m = new RegExp(`rgba\\(0,\\s*0,\\s*0,\\s*([.\\d]+)\\)\\s*${stop.replace('.', '\\.')}`).exec(body);
  expect(m, `stop at ${stop} in ${body}`).not.toBeNull();
  return Number(m![1]);
};

describe('card captions over bright posters (WCAG 1.4.3)', () => {
  const css = read('lib/Card.svelte');
  const body = rule(css, '.cap::before');
  it('the caption has its own scrim under the text only, from 1.6rem above it to the card edge', () => {
    expect(body).toMatch(/top: -1\.6rem/);
    expect(body).toMatch(/bottom: -\.5rem/); // the caption sits .5rem above the card's bottom edge
    expect(body).toMatch(/z-index: -1/);
    expect(css).toMatch(/\.cap\.big::before \{ display: none; \}/); // no picture: no scrim
  });
  it('white caption text keeps AA over a pure white poster where the text starts (and further down it only gets darker)', () => {
    const top = alphaAt(body, '1.6rem');
    const end = Number(/rgba\(0, 0, 0, ([.\d]+)\)\); pointer-events/.exec(body)![1]);
    expect(end).toBeGreaterThanOrEqual(top);
    expect(contrast(WHITE, scrimOnWhite(top))).toBeGreaterThanOrEqual(AA);
    // the second line is white .9 (.l2)
    expect(textContrast(scrimOnWhite(top), 0.9)).toBeGreaterThanOrEqual(AA);
  });
});

describe('player labels over a bright frame (WCAG 1.4.3)', () => {
  const player = read('lib/Player.svelte');
  it('desktop: the bar scrim is at least .62 where the title block starts (the 4.5rem top padding); the chapter label is white', () => {
    const desk = rule(player, '.stage.desk .ctl');
    expect(desk).toMatch(/padding: 4\.5rem/);
    const a = alphaAt(desk, '4.5rem');
    expect(contrast(WHITE, scrimOnWhite(a))).toBeGreaterThanOrEqual(AA);
    const em = rule(player, '.ttlblock em');
    expect(em).toMatch(/color: #fff;/);
    expect(em).toMatch(/border-left: 3px solid var\(--acc/); // the coral stays as a bar beside the text
    // the episode line on the same scrim
    const sub = /\.ttlblock span \{ color: (#[0-9a-f]{6});/.exec(player)![1]!;
    expect(contrast(hex(sub), scrimOnWhite(a))).toBeGreaterThanOrEqual(AA);
  });
  it('phone: the dock scrim is at least .62 at the text (it starts 72 px above the dock); chapter white, meta line white .92', () => {
    const dock = rule(player, '.ctl.dock::before');
    expect(dock).toMatch(/height: calc\(100% \+ 72px\)/);
    const a = alphaAt(dock, '64px');
    expect(contrast(WHITE, scrimOnWhite(a))).toBeGreaterThanOrEqual(AA);
    const title = read('lib/player/phone/PhoneTitle.svelte');
    expect(rule(title, 'em')).toMatch(/color: #fff;/);
    const meta = Number(/span \{ font-size: 13px; color: rgba\(255, 255, 255, ([.\d]+)\)/.exec(title)![1]);
    expect(meta).toBeGreaterThanOrEqual(0.92);
    expect(textContrast(scrimOnWhite(a), meta)).toBeGreaterThanOrEqual(AA);
  });
  it('the quality pill ("Original") has a dark fill: white text keeps AA over pure white even without the top shade', () => {
    const chip = read('lib/player/QualityChip.svelte');
    const pill = rule(chip, '.pill');
    const a = Number(/background: rgba\(0, 0, 0, ([.\d]+)\)/.exec(pill)![1]);
    expect(pill).toMatch(/color: #fff;/);
    expect(contrast(WHITE, scrimOnWhite(a))).toBeGreaterThanOrEqual(AA);
  });
});

describe('billboard synopsis, footer and kids header (WCAG 1.4.3)', () => {
  it('the billboard keeps .72 out to 46 % (where the text column ends): the synopsis (white .92) passes over a white backdrop', () => {
    const bb = read('lib/desk/DeskBillboard.svelte');
    const m = /rgba\(var\(--ink\), ([.\d]+)\) 46%/.exec(bb);
    expect(m).not.toBeNull();
    const ink: RGB = [16, 20, 24];
    expect(textContrast(over(WHITE, ink, Number(m![1])), 0.92)).toBeGreaterThanOrEqual(AA);
  });
  it('the footer text is #9aa0a6, undimmed, on the page colour', () => {
    const foot = read('lib/Footer.svelte');
    expect(rule(foot, '.foot')).toMatch(/color: #9aa0a6;/);
    expect(rule(foot, '.brand')).not.toMatch(/opacity/);
    expect(rule(foot, '.version')).not.toMatch(/opacity/);
    expect(contrast(hex('#9aa0a6'), hex('#101418'))).toBeGreaterThanOrEqual(AA);
  });
  it('the kids badge has dark text on its pink → amber gradient', () => {
    const layout = read('routes/+layout.svelte');
    expect(rule(layout, '.kbadge')).toMatch(/color: #20233a;/);
    for (const stop of ['#ff5d8f', '#ffb703']) expect(contrast(hex('#20233a'), hex(stop)), stop).toBeGreaterThanOrEqual(AA);
  });
});

describe('the two-tone focus ring (WCAG 2.4.7 / 1.4.11)', () => {
  const app = read('app.css');
  const dark = /--ring-dark: rgba\(8, 8, 12, ([.\d]+)\)/.exec(app);
  it('white outline plus a dark companion that fills the gap and rims the outside; TV keeps its own ring', () => {
    expect(app).toMatch(/:focus-visible \{ outline: 2px solid #fff; outline-offset: var\(--ring-o, 3px\);/);
    expect(app).toContain(":where(html:not(.tv)) body :focus-visible:where(:not([tabindex='-1'])) { box-shadow: 0 0 0 calc(var(--ring-o, 3px) + 4px) var(--ring-dark); }");
    // after the glass and button classes, so it wins over their edge shadows at the same weight
    expect(app.indexOf(':where(html:not(.tv)) body :focus-visible')).toBeGreaterThan(app.indexOf('.frost-btn {'));
    expect(app.indexOf(':where(html:not(.tv)) body :focus-visible')).toBeGreaterThan(app.indexOf('button.glass, .btn.glass {'));
    expect(app).toMatch(/html\.tv :focus-visible \{ outline: 3px solid var\(--tv-ring\); outline-offset: 3px; box-shadow: none; \}/);
  });
  it('3:1 both ways: the white ring against its dark companion on the brightest backdrop, and the companion against white', () => {
    expect(dark).not.toBeNull();
    const companion = over(WHITE, [8, 8, 12], Number(dark![1]));
    expect(contrast(WHITE, companion)).toBeGreaterThanOrEqual(3);
    // on the dark app the companion vanishes and the white ring stands alone (today's look)
    expect(contrast(WHITE, hex('#101418'))).toBeGreaterThanOrEqual(3);
  });
  it('every desktop / phone rule that draws a white focus outline with its own shadow includes the dark companion', () => {
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.svelte')).map((f) => f.split(sep).join('/'));
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)) {
        const [, sel, body] = m;
        if (/html\.tv|\.tv\b|tv-/.test(sel!) || !/outline: \d+px solid #fff/.test(body!) || !/box-shadow/.test(body!)) continue;
        if (!body!.includes('--ring-dark') && !/box-shadow: none/.test(body!)) bad.push(`${f}: ${sel!.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('components that move the ring tell the companion (--ring-o) or draw an inner one', () => {
    expect(read('lib/desk/DeskBar.svelte')).toMatch(/\.tab:focus-visible \{[^}]*--ring-o: 0px;/);
    expect(read('lib/phone/Carousel.svelte')).toMatch(/\.card:focus-visible::after \{[^}]*box-shadow: inset 0 0 0 7px var\(--ring-dark\)/);
    expect(read('lib/phone/TabBar.svelte')).toMatch(/a:focus-visible \{[^}]*inset 0 0 0 4px var\(--ring-dark\)/);
    expect(read('routes/settings/+page.svelte')).toMatch(/\.sw-in:focus-visible \+ \.sw-tr \{[^}]*var\(--ring-dark\)/);
  });
});

describe('layout (WCAG 1.4.10 / 2.4.11)', () => {
  it('settings reflows at 320 px: the form track can shrink and the selects never exceed it', () => {
    const s = read('routes/settings/+page.svelte');
    expect(rule(s, '.form')).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
    expect(s).toMatch(/\.field select, \.field input \{ max-width: min\(360px, 100%\); \}/);
  });
  it('scrolling into view stops clear of the glass bars: below the header, above the phone tab bar and home indicator', () => {
    const app = read('app.css');
    expect(app).toContain('html { scroll-padding-top: calc(var(--nav-total) + 8px); }');
    expect(app).toContain('html:not(.kids) { scroll-padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 16px); }');
  });
});
