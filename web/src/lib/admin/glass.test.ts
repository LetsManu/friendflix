// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dense glass admin (glass spec §7): which stat values count up, and every admin text colour on the new glass surfaces
 * (sidebar, tiles, tables, status pills, fields), checked with the tone model against the brightest point of the dimmed
 * ambient background (AMB_PEAK): a light glass card over it, the raw ambient, a card over the dark base and the solid
 * fallback (calm mode, TV, kids).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countable } from './glass';
import { AA, AMB_PEAK, contrast, DARK_BASE, frostComposite, SCRIM_LIGHT, SCRIM_BAR, SCRIM_RGB, SEL_A, textContrast, type RGB } from '#lib/glass/tone';

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
const table = read('../ui/DataTable.svelte'), tile = read('../ui/StatTile.svelte'), field = read('../ui/Field.svelte'), select = read('../ui/Select.svelte');

describe('admin glass: text contrast (B′)', () => {
  it('the glass text tokens include the lighter info colour', () => {
    expect(appCss).toContain(`--info: ${GLASS.info};`);
    expect(appCss).toMatch(/\.panel, \.frost-text \{[^}]*--info: #80cbd4;/);
  });

  it('sidebar: group headings (.72), links (.75), the current link white on the light pill, hover on the darker fill', () => {
    expect(shell).toMatch(/class="side frost-flat frost-panel frost-text"/);
    expect(shell).toContain('color: rgba(255, 255, 255, .75)');
    expect(shell).toContain('class="ni fill-hover"');
    expect(appCss).toMatch(/\.fill-hover::after \{[^}]*background: rgba\(var\(--fr-scrim-rgb\), \.3\);/);
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
    for (const k of Object.keys(TONES)) {
      expect(appCss).toContain(`--wash-${k}: linear-gradient(var(--tone-${k}), var(--tone-${k})), rgba(var(--fr-scrim-rgb), ${String(PILL_FILL).slice(1)});`);
      expect(pill).toContain(`background: var(--wash-${k});`);
    }
    for (const [k, [c, a, text]] of Object.entries(TONES)) for (const bg of ON_GLASS) {
      expect(cr(text, over(over(bg, SCRIM_RGB, PILL_FILL), c, a)), `${k} on ${bg}`).toBeGreaterThanOrEqual(AA);
    }
    // why the fill: the old wash straight on the card over the peak
    for (const k of ['ok', 'warn', 'err', 'info'] as const) { const [c, a, text] = TONES[k]!; expect(cr(text, over(CARD_PEAK, c, a))).toBeLessThan(AA); }
    // and the pill never says it by colour alone: an icon per tone and a text
    expect(pill).toMatch(/TONE_ICON: Record<Tone, string> = \{ ok: 'check', warn: 'clock', err: 'alert', info: 'info', muted: 'x' \}/);
  });

  it('tone washes inside the glass cards sit on the dark fill too: settings probe, poll winner, hub tags, playback, devices', () => {
    const wash = (k: keyof typeof TONES, bg: RGB) => { const [c, a] = TONES[k]!; return over(over(bg, SCRIM_RGB, PILL_FILL), c, a); };
    const src = (rel: string) => read(rel);
    expect(src('../../routes/admin/settings/+page.svelte')).toMatch(/\.probe\.ok \{ background: var\(--wash-ok\); color: var\(--ok\); \}/);
    expect(src('../../routes/admin/settings/+page.svelte')).toMatch(/\.probe\.err \{ background: var\(--wash-err\); color: var\(--fg\); \}/);
    expect(src('../../routes/admin/polls/+page.svelte')).toMatch(/\.opts li\.win \{[^}]*background: var\(--wash-ok\);/);
    expect(src('../../routes/admin/hubs/+page.svelte')).toMatch(/\.tag \{[^}]*color: var\(--mut\); background: var\(--wash-muted\);/);
    expect(src('../../routes/admin/playback/+page.svelte')).toMatch(/\.fails li \{[^}]*background: var\(--wash-err\);/);
    expect(src('../../routes/admin/devices/+page.svelte')).toMatch(/\.waiting \{[^}]*background: var\(--wash-warn\); color: var\(--warn\);/);
    expect(src('./settings/SettingRow.svelte')).toMatch(/\.moved \{[^}]*background: var\(--wash-info\); color: var\(--fg\);/);
    for (const bg of ON_GLASS) {
      expect(cr(GLASS.ok, wash('ok', bg)), 'probe ok').toBeGreaterThanOrEqual(AA);
      expect(textContrast(wash('err', bg)), 'probe err').toBeGreaterThanOrEqual(AA);
      expect(cr(MUT, wash('ok', bg)), 'poll winner .72').toBeGreaterThanOrEqual(AA);
      expect(textContrast(wash('ok', bg)), 'poll winner title').toBeGreaterThanOrEqual(AA);
      expect(cr(MUT, wash('muted', bg)), 'hub tag').toBeGreaterThanOrEqual(AA);
      expect(cr(MUT, wash('err', bg)), 'playback .72').toBeGreaterThanOrEqual(AA);
      expect(cr(GLASS.warn, wash('warn', bg)), 'devices waiting').toBeGreaterThanOrEqual(AA);
      expect(textContrast(wash('info', bg)), 'moved hint').toBeGreaterThanOrEqual(AA);
    }
    // why: the plain washes on the card over the peak (the review's figures)
    const [okC, okA] = TONES.ok!, [muC, muA] = TONES.muted!;
    expect(cr(GLASS.ok, over(CARD_PEAK, okC, okA))).toBeLessThan(AA);
    expect(cr(MUT, over(CARD_PEAK, okC, okA))).toBeLessThan(AA);
    expect(cr(MUT, over(CARD_PEAK, muC, muA))).toBeLessThan(AA);
  });

  it('hovers move only opacity: no colour property in any transition of the admin glass', () => {
    const files = ['./AdminShell.svelte', '../ui/StatTile.svelte', './ServiceLights.svelte', '../../routes/admin/+page.svelte', '../ui/DataTable.svelte', '../ui/Field.svelte', '../ui/Select.svelte', '../ui/StatusPill.svelte'];
    for (const f of files) for (const m of read(f).matchAll(/transition:([^;}]*)/g)) expect(m[1], f).not.toMatch(/color|background|border|shadow/);
    expect(appCss).toMatch(/\.fill-hover::after \{[^}]*opacity: 0;[^}]*transition: opacity var\(--t-fast\); \}/);
    // calm mode / reduced motion (html.m-still): the hover layers switch at once
    expect(appCss).toContain('html.m-still :is(.fill-hover, .edge-hover)::after { transition: none; }');
    expect(appCss).toMatch(/\.edge-hover::after \{[^}]*opacity: 0;[^}]*transition: opacity var\(--t-fast\); \}/);
    // the sidebar pill measures from .side: nothing between it and the entries is positioned
    expect(shell).not.toMatch(/\.side nav \{/);
  });

  /**
   * App-wide (owner rule, final review ruling I3): no colour, background, border or filter in any transition anywhere in web/src
   * (app.css, auth.css and every component's <style>). Fills and colours switch at once; a fading fill or edge is an opacity
   * layer (.fill-hover / .edge-hover). The allowlist holds only what must stay, each with its reason.
   */
  it('no colour, background, border or filter transition anywhere in the web app (explicit allowlist)', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const ALLOW: Array<{ file: string; sel: RegExp; why: string }> = [
      // glass spec Constraints / §8.4: "the text colour of a selected tab or segment label" is the named exception
      { file: 'lib/detail/DetailDesk.svelte', sel: /\.tab\b/, why: 'detail tab label colour follows the sliding pill (named exception)' },
      { file: 'lib/detail/DetailView.svelte', sel: /\.tab\b/, why: 'detail tab label colour follows the sliding pill (named exception)' },
      { file: 'lib/desk/DeskBar.svelte', sel: /\.tab\b|\.gone\b/, why: 'top-bar tab label colour follows the sliding fill (named exception)' },
      // the player (spec 2026-11-08 §3-§4), not a glass surface: the pause screen dims the video itself (filter on <video>, the
      // controls sit above it) and the letterbox takes the page colour while the loading poster shows; replacing these needs
      // a new layer between the video and the controls (left for the player's own follow-up)
      { file: 'lib/Player.svelte', sel: /^\s*\.stage\b/, why: 'player pause dim / credits glide / loading letterbox (player spec)' },
    ];
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.(svelte|css)$/.test(f)).map((f) => f.split(sep).join('/'));
    expect(files.length).toBeGreaterThan(100);
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf8');
      const css = f.endsWith('.css') ? src : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
      for (const [, sel, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        for (const [, v] of body!.matchAll(/transition(?:-property)?\s*:([^;]*)/g)) {
          seen++;
          if (!/color|background|border|filter|\ball\b/.test(v!)) continue;
          if (ALLOW.some((a) => a.file === f && a.sel.test(sel!))) continue;
          bad.push(`${f}: ${sel!.trim()} { transition:${v} }`);
        }
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(bad).toEqual([]);
    // the global button and field rules move transform / opacity only
    expect(appCss).toMatch(/button, \.btn \{[^}]*transition: transform var\(--t-fast\), opacity var\(--t-fast\); \}/);
    expect(appCss).not.toMatch(/input, select, textarea \{[^}]*transition/);
  });

  it('fields and selects: white text and the error colour on the darker glass fill', () => {
    expect(appCss).toMatch(/\.adm \.field :is\(input[^{]*\{[^}]*background: rgba\(var\(--fr-scrim-rgb\), \.35\);/);
    for (const c of [field, select]) expect(c).not.toContain('.35)');
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
  });
});

describe('cast bar: text on its glass (cast spec §2)', () => {
  const bar = read('../cast/CastBar.svelte'), exp = read('../cast/CastBarExpanded.svelte');
  /** the bar floats over anything (a white button, a bright poster): the bar scrim over pure white is the worst case; then the ambient peak, the base and the solid fallback */
  const SURFACES = [frostComposite(WHITE, SCRIM_BAR), frostComposite(AMB_PEAK, SCRIM_BAR), frostComposite(DARK_BASE, SCRIM_BAR), SOLID];
  it('both panels use the bar scrim and the stated line colours', () => {
    expect(bar).toMatch(/class="box frost frost-safe frost-panel" style="--fr-scrim-safe:\{SCRIM_BAR\}"/);
    expect(exp).toMatch(/class="exp frost frost-safe frost-panel" style="--fr-scrim-safe:\{SCRIM_BAR\}"/);
    for (const css of [bar, exp]) {
      expect(css).toContain('color: rgba(255, 255, 255, .72)');
      expect(css).toContain('.t2.warn { color: #ffc56b; }');
      expect(css).toContain('.t2.error { color: #ffbdbd; }');
    }
    expect(exp).toContain('color: rgba(255, 255, 255, .78)'); // times / volume hint (CastScrubber, volhint)
  });
  it('white .72 / .78, amber and error text keep 4.5:1 on every surface', () => {
    for (const bg of SURFACES) {
      for (const a of [0.72, 0.78]) expect(textContrast(bg, a), String(a)).toBeGreaterThanOrEqual(AA);
      expect(contrast(hex('#ffc56b'), bg)).toBeGreaterThanOrEqual(AA);
      expect(contrast(hex('#ffbdbd'), bg)).toBeGreaterThanOrEqual(AA);
    }
  });
});
