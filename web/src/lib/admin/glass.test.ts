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
import { AA, AMB_PEAK, contrast, DARK_BASE, frostComposite, SCRIM_LIGHT, SCRIM_BAR, SCRIM_MENU, SCRIM_SAFE_DIM, GRAIN_LIFT, SCRIM_RGB, SEL_A, textContrast, tintColor, type RGB } from '#lib/glass/tone';

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

describe('Play on sheet: the selected / hovered row keeps white hints', () => {
  it('hint text is white on the light pill, over the brightest picture', () => {
    const sheet = read('../cast/PlayOnSheet.svelte');
    expect(sheet).toMatch(/\.row\.on \.h, \.row:hover \.h \{ color: #fff; \}/);
    const pill = over(frostComposite(WHITE, SCRIM_MENU), WHITE, SEL_A).map((x) => Math.min(255, x + GRAIN_LIFT)) as RGB;
    expect(textContrast(pill)).toBeGreaterThanOrEqual(AA);
  });
});

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
    expect(src('../../routes/admin/users/+page.svelte')).toMatch(/\.badge \{[^}]*background: var\(--wash-warn\); color: var\(--warn\);/);
    expect(src('./settings/SettingRow.svelte')).toMatch(/\.moved \{[^}]*background: var\(--wash-info\); color: var\(--fg\);/);
    for (const bg of ON_GLASS) {
      expect(cr(GLASS.ok, wash('ok', bg)), 'probe ok').toBeGreaterThanOrEqual(AA);
      expect(textContrast(wash('err', bg)), 'probe err').toBeGreaterThanOrEqual(AA);
      expect(cr(MUT, wash('ok', bg)), 'poll winner .72').toBeGreaterThanOrEqual(AA);
      expect(textContrast(wash('ok', bg)), 'poll winner title').toBeGreaterThanOrEqual(AA);
      expect(cr(MUT, wash('muted', bg)), 'hub tag').toBeGreaterThanOrEqual(AA);
      expect(cr(MUT, wash('err', bg)), 'playback .72').toBeGreaterThanOrEqual(AA);
      expect(cr(GLASS.warn, wash('warn', bg)), 'devices waiting').toBeGreaterThanOrEqual(AA);
      expect(cr(GLASS.warn, wash('warn', bg)), 'people exceptions badge').toBeGreaterThanOrEqual(4.5);
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

/**
 * Cast motion rule (cast plan, Global Constraints): animate transform and opacity only. Layout properties never appear in a
 * transition or a @keyframes block of the cast components (progress fills are scaleX, panels grow with growBoth / sheetSlide).
 */
describe('cast surfaces: motion', () => {
  const LAYOUT = /(?<![\w-])(width|height|left|top|right|bottom|max-height|min-height|max-width|min-width|margin[\w-]*|padding[\w-]*)(?![\w-])/;
  /** every transition value and every @keyframes body of one stylesheet */
  function motion(css: string): string[] {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: string[] = [];
    for (const m of src.matchAll(/transition(?:-property)?\s*:([^;}]*)/g)) out.push(`transition:${m[1]}`);
    for (const m of src.matchAll(/@keyframes\s+[\w-]+\s*\{/g)) {
      let depth = 1, i = m.index! + m[0].length;
      const start = i;
      while (depth && i < src.length) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
      out.push(`@keyframes ${src.slice(start, i - 1)}`);
    }
    return out;
  }
  const styleOf = (src: string) => [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const castDir = fileURLToPath(new URL('../cast/', import.meta.url));

  it('the scan sees what it should (it refuses a width transition and a left keyframe)', () => {
    expect(motion('.a { transition: width 1s; }').some((v) => LAYOUT.test(v))).toBe(true);
    expect(motion('@keyframes k { from { left: 0; } to { left: 9px; } }').some((v) => LAYOUT.test(v))).toBe(true);
    expect(motion('.a { transition: transform 1s, opacity 1s; transform-origin: left; width: 3px; }').some((v) => LAYOUT.test(v))).toBe(false);
  });

  it('cast surfaces animate transform and opacity only', () => {
    const files = readdirSync(castDir).filter((f) => f.endsWith('.svelte'));
    expect(files).toEqual(expect.arrayContaining(['CastBar.svelte', 'CastBarExpanded.svelte', 'CastScrubber.svelte', 'PlayOnSheet.svelte', 'RemoteScreen.svelte', 'DiagnoseCast.svelte', 'TrackChips.svelte', 'UpNextCard.svelte']));
    let seen = 0;
    const bad: string[] = [];
    for (const f of files) {
      for (const v of motion(styleOf(readFileSync(join(castDir, f), 'utf8')))) {
        if (/transition:\s*none/.test(v)) continue;
        seen++;
        if (LAYOUT.test(v) || /\b(all)\b|color|background|border|filter|shadow/.test(v)) bad.push(`${f}: ${v.trim()}`);
      }
    }
    expect(seen).toBeGreaterThan(8);
    expect(bad).toEqual([]);
  });

  it('every cast component with motion switches it off in calm mode and for reduced motion', () => {
    for (const f of ['CastBar', 'CastBarExpanded', 'CastScrubber', 'PlayOnSheet', 'RemoteScreen']) {
      const src = read(`../cast/${f}.svelte`);
      expect(src, f).toMatch(/:global\(html\.m-still\)[^{]*\{[^}]*transition: none !important; animation: none !important;/);
      expect(src, f).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    }
  });

  it('the receiver css animates transform and opacity only (visibility flips after the fade, nothing else)', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../static/cast-receiver/receiver.css', import.meta.url)), 'utf8');
    const vals = motion(css);
    expect(vals.length).toBeGreaterThan(4); // the panels' fade and rise, the countdown bar, the loading bar's keyframes
    expect(vals.filter((v) => LAYOUT.test(v) || /\ball\b|filter|shadow|color|background/.test(v))).toEqual([]);
    const props = new Set(vals.filter((v) => v.startsWith('transition:')).flatMap((v) => v.slice(11).split(',').map((x) => x.trim().split(/\s+/)[0]!)).filter((x) => x !== 'none'));
    expect([...props].sort()).toEqual(['opacity', 'transform', 'visibility']);
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\}\s*)\}/g)) expect(m[1]!.replace(/(from|to|\d+%)\s*\{\s*transform:[^;}]*;?\s*\}/g, '').trim()).toBe('');
  });

  it('the receiver css has no backdrop-filter, and calm mode / reduced motion switch the motion off', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../static/cast-receiver/receiver.css', import.meta.url)), 'utf8');
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('backdrop-filter');
    expect(css).toMatch(/body\.still \.fx, body\.still \.fx\.on \{ transition: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ind i \{ animation: none;/);
  });
});

/** the start page's hand-off card: glass, text contrast, motion (transform / opacity only), calm mode */
describe('hand-off card (device hand-off spec 2.4)', () => {
  const card = read('../handoff/HandoffCard.svelte');
  const css = [...card.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

  it('is the safe glass panel, a named region, and not a live region', () => {
    expect(card).toMatch(/class="hc frost frost-safe frost-panel /);
    expect(card).toContain('--fr-scrim-safe:{SCRIM_SAFE_DIM}'); // the scrim that holds .9 white text over pure white
    expect(card).toMatch(/role="region" aria-label=\{\$t\('home\.handoff\.region'\)\}/);
    expect(card).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  it('its text keeps 4.5:1 on the safe glass over the brightest picture, the ambient peak, the base and the solid fallback', () => {
    expect(css).toContain('color: rgba(255, 255, 255, .9)'); // the eyebrow line
    const bright = frostComposite(WHITE, SCRIM_SAFE_DIM, tintColor(WHITE));
    for (const bg of [bright, frostComposite(AMB_PEAK, SCRIM_SAFE_DIM), frostComposite(DARK_BASE, SCRIM_SAFE_DIM), SOLID]) {
      expect(textContrast(bg, 0.9)).toBeGreaterThanOrEqual(AA);
      expect(textContrast(bg, 1)).toBeGreaterThanOrEqual(AA);
    }
    expect(contrast(hex('#d6325a'), WHITE)).toBeGreaterThanOrEqual(AA); // the white button label on --acc-fill
  });

  it('animates transform and opacity only, and switches it off for calm mode and reduced motion', () => {
    const LAYOUT = /(?<![\w-])(width|height|left|top|right|bottom|max-height|min-height|max-width|min-width|margin[\w-]*|padding[\w-]*)(?![\w-])/;
    const parts: string[] = [];
    for (const m of css.matchAll(/transition(?:-property)?\s*:([^;}]*)/g)) parts.push(m[1]!);
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{/g)) {
      let depth = 1, i = m.index! + m[0].length;
      const start = i;
      while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
      parts.push(css.slice(start, i - 1));
    }
    const live = parts.filter((v) => !/^\s*none/.test(v));
    expect(live.length).toBeGreaterThanOrEqual(2);
    for (const v of live) {
      expect(v).not.toMatch(LAYOUT);
      expect(v).not.toMatch(/\ball\b|color|background|border|filter|shadow/);
    }
    expect(css).toContain('translateY(-8px)');
    expect(css).toMatch(/:global\(html\.m-still\)[^{]*\{[^}]*transition: none !important; animation: none !important;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

/** the player's AirPlay connecting layout: safe glass, motion (transform / opacity only), calm mode */
describe('AirPlay connecting layout (device hand-off spec 4)', () => {
  const src = read('../player/AirPlayConnecting.svelte');
  const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

  it('is a safe glass panel over the dimmed backdrop, with a named status and no video frame', () => {
    expect(src).toMatch(/class="msg frost frost-safe frost-panel"/);
    expect(src).toContain('--fr-scrim-safe:{SCRIM_BAR}');
    expect(src).toMatch(/role="status"/);
    expect(src).toContain('brightness(.5)'); // the remote screen's dim treatment
    expect(src).not.toMatch(/<video|drawImage|canvas/);
  });

  it('animates transform and opacity only (the layout overlays, nothing reflows) and switches it off in calm mode', () => {
    const LAYOUT = /(?<![\w-])(width|height|left|top|right|bottom|max-height|min-height|max-width|min-width|margin[\w-]*|padding[\w-]*)(?![\w-])/;
    const parts: string[] = [];
    for (const m of css.matchAll(/transition(?:-property)?\s*:([^;}]*)/g)) parts.push(m[1]!);
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{/g)) {
      let depth = 1, i = m.index! + m[0].length;
      const start = i;
      while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
      parts.push(css.slice(start, i - 1));
    }
    const live = parts.filter((v) => !/^\s*none/.test(v));
    expect(live.length).toBeGreaterThanOrEqual(1);
    for (const v of live) { expect(v).not.toMatch(LAYOUT); expect(v).not.toMatch(/\ball\b|color|background|border|filter|shadow/); }
    expect(src).toMatch(/transition:fade\|global=\{\{ duration: motionAllowed\(\) \? 120 : 0 \}\}/); // opacity, 120 ms, 0 ms when calm
    expect(css).toMatch(/:global\(html\.m-still\)[^{]*\{[^}]*transition: none !important; animation: none !important;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

/** Rollen & Rechte (users & permissions spec §6.1, §8): the matrix's marks on the glass panel, the save bar, and the motion rule */
describe('role matrix and save bar (rights)', () => {
  const dir = fileURLToPath(new URL('./rights/', import.meta.url));
  const matrix = read('./rights/RoleMatrix.svelte'), bar = read('./rights/SaveBar.svelte');
  const css = (src: string) => [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  /** the bar floats over anything: its scrim over pure white, the ambient peak, the base, the solid fallback (as the cast bar) */
  const BAR = [frostComposite(WHITE, SCRIM_BAR), frostComposite(AMB_PEAK, SCRIM_BAR), frostComposite(DARK_BASE, SCRIM_BAR), SOLID];

  it('a staged cell has the amber --warn outline; it keeps 4.5:1 on the panel, the solid first column and the chip fill', () => {
    expect(css(matrix)).toMatch(/td\.staged::after \{ box-shadow: inset 0 0 0 2px var\(--warn\); \}/);
    for (const bg of [...ON_GLASS, ...ON_GLASS.map((b) => over(b, SCRIM_RGB, 0.4))]) expect(cr(GLASS.warn, bg), `${bg}`).toBeGreaterThanOrEqual(AA);
  });

  it('muted role values (.72 white: people line, corner, group labels, a denied switch) on the panel and the solid sticky cells', () => {
    const c = css(matrix);
    expect(c).toMatch(/\.rp \{[^}]*color: var\(--mut\);/);
    expect(c).toMatch(/\.chip\.off \{ color: var\(--mut\); \}/);
    expect(c).toMatch(/thead th \{[^}]*background: var\(--fr-solid\);/);
    // the chips' fill is the darker scrim (.25, .4 on hover): it only adds contrast
    expect(c).toMatch(/\.chip \{[^}]*background: rgba\(var\(--fr-scrim-rgb\), \.25\);/);
    expect(c).toMatch(/td:hover:not\(\.lock\) \.chip \{ background: rgba\(var\(--fr-scrim-rgb\), \.4\); \}/);
    for (const bg of [...ON_GLASS, ...ON_GLASS.flatMap((b) => [over(b, SCRIM_RGB, 0.25), over(b, SCRIM_RGB, 0.4)])]) {
      expect(textContrast(bg, MUT), `${bg}`).toBeGreaterThanOrEqual(AA);
      expect(cr(GLASS.ok, bg), 'allowed tick').toBeGreaterThanOrEqual(AA);
    }
  });

  it('the changed dot (--info) stands out from the panel; its words are the tooltip and the cell name, not the colour', () => {
    expect(css(matrix)).toMatch(/\.dot \{[^}]*background: var\(--info\);/);
    for (const bg of ON_GLASS) expect(cr(GLASS.info, bg)).toBeGreaterThanOrEqual(AA);
    expect(matrix).toContain("tr('adminPeople.roles.changedHere')");
    expect(matrix).toMatch(/cellName\(roleName\(role\), f, v, staged \? 'unsaved' : src === 'role'\)/);
    // the lock icon's class is not the locked cell's (a scoped `.lock` rule would style the <td> too)
    expect(css(matrix)).not.toMatch(/(^|[\s,}])\.lock\b/);
  });

  it('the role sheet and the history: white text and the .9 notes on the menu scrim over any backdrop; the staged rail is --warn', () => {
    for (const f of ['RoleSheet', 'RoleHistory']) {
      const src = read(`./rights/${f}.svelte`);
      expect(src, f).toContain('--fr-scrim-safe:{SCRIM_MENU}');
      expect(css(src), f).toMatch(/color: rgba\(255, 255, 255, \.9\)/);
    }
    expect(css(read('./rights/RoleSheet.svelte'))).toMatch(/\.row\.staged \{ border-left-color: var\(--warn\); \}/);
    for (const bg of [frostComposite(WHITE, SCRIM_MENU), frostComposite(AMB_PEAK, SCRIM_MENU), frostComposite(DARK_BASE, SCRIM_MENU)]) {
      expect(textContrast(bg)).toBeGreaterThanOrEqual(AA);
      expect(textContrast(bg, 0.9)).toBeGreaterThanOrEqual(AA);
      // the rail is a graphic, not text: 3:1
      expect(cr(GLASS.warn, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('the save bar: white text and the light error colour on the bar scrim over any backdrop', () => {
    expect(bar).toMatch(/class="sb frost frost-safe frost-panel" style="--fr-scrim-safe:\{SCRIM_BAR\}"/);
    expect(css(bar)).toContain('.tx.err { color: #ffbdbd; }');
    for (const bg of BAR) {
      expect(textContrast(bg)).toBeGreaterThanOrEqual(AA);
      expect(contrast(hex('#ffbdbd'), bg)).toBeGreaterThanOrEqual(AA);
    }
  });

  it('animates transform and opacity only, and every surface with motion switches it off in calm mode and for reduced motion', () => {
    const LAYOUT = /(?<![\w-])(width|height|left|top|right|bottom|max-height|min-height|max-width|min-width|margin[\w-]*|padding[\w-]*)(?![\w-])/;
    const files = readdirSync(dir).filter((f) => f.endsWith('.svelte'));
    expect(files).toEqual(expect.arrayContaining(['RoleMatrix.svelte', 'FieldControl.svelte', 'CellPopover.svelte', 'SaveBar.svelte', 'ReviewSheet.svelte', 'RoleSheet.svelte', 'RoleHistory.svelte', 'DeleteRoleDialog.svelte', 'NameDialog.svelte']));
    const bad: string[] = [];
    for (const f of files) {
      const c = css(readFileSync(join(dir, f), 'utf8'));
      for (const [, v] of c.matchAll(/transition(?:-property)?\s*:([^;}]*)/g)) if (!/^\s*none/.test(v!) && (LAYOUT.test(v!) || /\ball\b|color|background|border|filter|shadow/.test(v!))) bad.push(`${f}: ${v}`);
      expect(c, f).not.toMatch(/@keyframes/);
    }
    expect(bad).toEqual([]);
    // the moving surfaces use the glass transitions (transform / opacity) and stand still in calm mode
    expect(read('./rights/CellPopover.svelte')).toContain('transition:growBoth|global={{ trigger }}');
    expect(bar).toMatch(/in:barRise out:barRise=\{\{ dir: 'out' \}\}/);
    expect(read('./rights/ReviewSheet.svelte')).toMatch(/sheetSlide\(node, \{ dir \}\)/);
    // the role sheet and the history slide in from the right edge (translateX, the same sheetSlide)
    for (const f of ['RoleSheet', 'RoleHistory']) expect(read(`./rights/${f}.svelte`), f).toMatch(/sheetSlide\(node, \{ dir, side: 'right' \}\)/);
    // the dragged column and its neighbours move by transform only; a glide is a transform transition
    expect(css(matrix)).toMatch(/\.glide \{ transition: transform 180ms var\(--fr-out\); \}/);
    expect(matrix).toMatch(/style:transform=\{shift\(drag, c\)\}/);
    for (const f of ['CellPopover', 'SaveBar', 'ReviewSheet', 'RoleSheet', 'RoleHistory', 'RoleMatrix']) {
      const src = read(`./rights/${f}.svelte`);
      expect(src, f).toMatch(/:global\(html\.m-still\)[^{]*\{[^}]*transition: none !important; animation: none !important;/);
      expect(src, f).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    }
    for (const f of ['DeleteRoleDialog', 'NameDialog']) expect(read(`./rights/${f}.svelte`), f).toContain('ModalShell');
    expect(read('../ui/ModalShell.svelte')).toMatch(/:global\(html\.m-still\)[^{]*\{[^}]*transition: none !important; animation: none !important;/);
  });

  it('the bar reserves its room before it rises: --savebar-h is set in a reactive statement (before the DOM update)', () => {
    expect(bar).toMatch(/\$: reserve\(shown\);/);
    expect(bar).toContain("st.setProperty('--savebar-h'");
    expect(read('../../routes/admin/roles/+page.svelte')).toMatch(/\.roles \{ padding-bottom: var\(--savebar-h, 0px\); \}/);
  });
});

/** The person's Rechte tab (users & permissions spec §8): the muted role value and the three-way switch, and the motion rule */
describe('person rights tab', () => {
  const src = read('./user/Rights.svelte');
  const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  /** the track is the darker scrim fill (as the matrix chips): it only adds contrast */
  const TRACK = 0.25;

  it('animates only transform and opacity (the thumb), nothing else', () => {
    const t = [...css.matchAll(/transition(?:-property)?\s*:([^;}]*)/g)].map((m) => m[1]!);
    expect(t.length).toBeGreaterThan(0);
    for (const v of t) expect(v, v).toMatch(/^\s*(transform|none)\b/);
    expect(css).not.toMatch(/@keyframes/);
    expect(css).toMatch(/\.thumb \{[^}]*transform: translateX\(/);
  });

  it('the role value is the .72 muted text; it keeps 4.5:1 on every glass surface', () => {
    expect(css).toMatch(/\.role \{[^}]*color: var\(--mut\);/);
    for (const bg of ON_GLASS) expect(textContrast(bg, MUT), `${bg}`).toBeGreaterThanOrEqual(AA);
  });

  it('the switch: unselected labels (.72) on the track, the selected one dark on the coral thumb', () => {
    expect(css).toMatch(/\.seg \{[^}]*color: var\(--mut\);/);
    expect(css).toMatch(/\.seg\.on \{ color: #1a1a1a; \}/);
    expect(css).toMatch(/\.thumb \{[^}]*background: var\(--acc\);/);
    expect(css).toMatch(/\.tri \{[^}]*background: rgba\(var\(--fr-scrim-rgb\), \.25\);/);
    for (const bg of ON_GLASS) expect(textContrast(over(bg, SCRIM_RGB, TRACK), MUT), `${bg}`).toBeGreaterThanOrEqual(AA);
    expect(contrast(hex('#1a1a1a'), hex('#ff4f6d'))).toBeGreaterThanOrEqual(AA);
  });

  it('the source chips are StatusPills (info / muted tones, checked with the pills above); the library error is --err text', () => {
    expect(src).toContain("tone={chip(row) === 'user' ? 'info' : 'muted'}");
    expect(css).toMatch(/\.lib-err \{[^}]*color: var\(--err\);/);
  });
});

/** The person's Profile tab (users & permissions spec §6.3): the create sheet's motion and the reserved age-limit room */
describe('person profiles tab', () => {
  const sheet = read('./user/KidsSheet.svelte');
  const page = read('./user/Profiles.svelte');
  const css = (src: string) => [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the create sheet slides up both ways, sits on the menu scrim, animates nothing itself and stands still in calm mode', () => {
    expect(sheet).toMatch(/sheetSlide\(node, \{ dir \}\)/);
    expect(sheet).toMatch(/transition:slide\|global/);
    expect(sheet).toMatch(/transition:scrimFade\|global/);
    expect(sheet).toContain('--fr-scrim-safe:{SCRIM_MENU}');
    expect(css(sheet).replace(/transition: none !important/g, '')).not.toMatch(/transition\s*:|@keyframes/);
    expect(css(sheet)).toMatch(/:global\(html\.m-still\)[^{]*\{[^}]*transition: none !important; animation: none !important;/);
    expect(css(sheet)).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    for (const bg of [frostComposite(WHITE, SCRIM_MENU), frostComposite(AMB_PEAK, SCRIM_MENU), frostComposite(DARK_BASE, SCRIM_MENU)]) expect(textContrast(bg, 0.9)).toBeGreaterThanOrEqual(AA);
    // its error line is bold .9 white text; the light error colour is only the icon (a graphic: 3:1)
    expect(css(sheet)).toContain('.err { display: flex; gap: .55rem; align-items: flex-start; margin: 0; color: rgba(255, 255, 255, .9); font-weight: 700; }');
    for (const bg of [frostComposite(WHITE, SCRIM_MENU), frostComposite(AMB_PEAK, SCRIM_MENU), frostComposite(DARK_BASE, SCRIM_MENU)]) expect(contrast(hex('#ffbdbd'), bg)).toBeGreaterThanOrEqual(3);
  });

  it('every profile row keeps the room of its age limit, with or without a live select', () => {
    expect(css(page)).toMatch(/\.cap, \.pin \{[^}]*min-height: 44px;/);
    // a grown-up profile holds it with the same select, unseen and out of reach
    expect(page).toMatch(/class:ghost=\{!row\.kids\} aria-hidden=\{row\.kids \? undefined : 'true'\} inert=\{!row\.kids\}/);
    expect(css(page)).toMatch(/\.ghost \{ visibility: hidden; \}/);
    // the page itself animates nothing
    expect(css(page)).not.toMatch(/transition\s*:|@keyframes/);
  });
});
