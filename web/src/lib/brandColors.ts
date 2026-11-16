// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The accent colour's derived tokens: a port of backend/src/brand/colors.ts, kept line for line (branding plan Task 2). The backend
 * sends the tokens with the public brand, so the web needs this only where it derives them itself (the admin page's live preview and
 * contrast readout, Task 4; a cached brand whose tokens do not parse). Both ports run the shared vectors in
 * test-vectors/brand-colors.json (brandColors.test.ts here, brand-colors.test.ts in the backend), so they cannot drift apart.
 *
 * Every token is the accent with only its HSL lightness moved, in steps of 1 % (`L0 + k/100`, never accumulated, so both ports step
 * through the same floats), until its contrast target holds:
 * - `accText` (= `acc`): ≥ 4.5:1 on every dark surface that carries accent text: `--bg` #101418, `--surface` #161b21 (cards, the
 *   sign-in card) and `--surface-2` #242b33 (chips, sheets' rows, the TV controls). Lightened if needed (`adjusted.text`). The
 *   default coral keeps today's table: 5.8 / 5.4 / 4.49 (the last as before branding).
 * - `accFill`: white text on it ≥ 4.5:1. Darkened if needed (`adjusted.fill`).
 * - `accHover` / `accFillHover`: 6 / 5 lightness points darker than `acc` / `accFill` (darker never lowers white-on-fill contrast).
 * - `accLight`: ≥ 4.5:1 on the glass scrim colour rgb(18,16,24). Starts 12 points above `accText`.
 * - `accLine`: ≥ 3:1 on the toast glass over a white backdrop (the frost composite rgb(94,92,99) of lib/glass/tone.ts
 *   `frostComposite(WHITE, SCRIM_MENU)`; the contract in app.css and ToastHost.svelte). Starts 15 points above `accText`.
 * The default accent returns today's stylesheet table verbatim (app.css) instead of the derivation.
 */

export interface BrandTokens {
  acc: string;
  accHover: string;
  accFill: string;
  accFillHover: string;
  accText: string;
  accLight: string;
  accLine: string;
  /** a shade was moved away from the accent to reach its target */
  adjusted: { text: boolean; fill: boolean };
}

/** the backgrounds the targets are measured on (also in the shared vectors' `targets`) */
/** accent text's backgrounds: --bg, --surface, --surface-2 (app.css :root); the lightest one decides */
export const ACC_TEXT_ON = ['#101418', '#161b21', '#242b33'] as const;
export const ACC_FILL_ON = '#ffffff';
export const ACC_LIGHT_ON = '#121018';
export const ACC_LINE_ON = '#5e5c63';
const TEXT_MIN = 4.5;
const FILL_MIN = 4.5;
const LIGHT_MIN = 4.5;
const LINE_MIN = 3;

export const DEFAULT_ACCENT = '#ff4f6d';

/** bumped with any change of the derivation (the backend's public route puts it in its ETag); must equal the backend's */
export const TOKENS_VERSION = 'c2';

/** today's tokens (app.css :root): the default accent's answer. The fill is a darker shade of the coral, so it counts as adjusted. */
const DEFAULT_TABLE: Readonly<BrandTokens> = Object.freeze({
  acc: '#ff4f6d', accHover: '#e63e5c', accFill: '#d6325a', accFillHover: '#c9304d', accText: '#ff4f6d', accLight: '#ff8aa0', accLine: '#ff9cad',
  adjusted: Object.freeze({ text: false, fill: true }),
});
export const DEFAULT_TOKENS: BrandTokens = copy(DEFAULT_TABLE);

const HEX_RE = /^#[0-9a-f]{6}$/;

type RGB = [number, number, number];
type HSL = [number, number, number];

function copy(t: Readonly<BrandTokens>): BrandTokens {
  return { ...t, adjusted: { ...t.adjusted } };
}

function parseHex(hex: string): RGB {
  const h = hex.toLowerCase();
  if (!HEX_RE.test(h)) throw new TypeError('not a #rrggbb colour');
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function toHex(c: RGB): string {
  return `#${c.map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

const lin = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(c: RGB): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG 2 contrast ratio of two #rrggbb colours (1..21, order does not matter) */
export function contrast(a: string, b: string): number {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toHsl([r8, g8, b8]: RGB): HSL {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl([h, s, l]: HSL): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const k = h / 360;
  return [ch(k + 1 / 3) * 255, ch(k) * 255, ch(k - 1 / 3) * 255];
}

/** the colour with its lightness set to `l` (clamped to 0..1) */
function withL(hsl: HSL, l: number): string {
  return toHex(fromHsl([hsl[0], hsl[1], Math.min(1, Math.max(0, l))]));
}

/**
 * The first lightness from `start` in 1 % steps towards `dir` (+1 lighter, -1 darker) whose colour passes `ok`. Lightness only moves
 * a colour monotonically towards white or black, so it ends at white or black at the latest (both pass every target in its direction).
 */
function step(hsl: HSL, start: number, dir: 1 | -1, ok: (hex: string) => boolean): string {
  for (let k = 0; k <= 100; k++) {
    const l = start + (dir * k) / 100;
    const hex = withL(hsl, l);
    if (ok(hex) || (dir > 0 ? l >= 1 : l <= 0)) return hex;
  }
  return dir > 0 ? '#ffffff' : '#000000';
}

/** the tokens of an accent (#rrggbb, any case). Throws a TypeError for anything else. */
export function deriveTokens(accent: string): BrandTokens {
  const rgb = parseHex(accent);
  const hex = toHex(rgb);
  if (hex === DEFAULT_ACCENT) return copy(DEFAULT_TABLE);
  const hsl = toHsl(rgb);
  const textOk = (c: string) => ACC_TEXT_ON.every((on) => contrast(c, on) >= TEXT_MIN);
  const fillOk = (c: string) => contrast(ACC_FILL_ON, c) >= FILL_MIN;
  const accText = textOk(hex) ? hex : step(hsl, hsl[2], 1, textOk);
  const accFill = fillOk(hex) ? hex : step(hsl, hsl[2], -1, fillOk);
  const textHsl = toHsl(parseHex(accText));
  const fillHsl = toHsl(parseHex(accFill));
  const accLight = step(textHsl, Math.min(1, textHsl[2] + 0.12), 1, (c) => contrast(c, ACC_LIGHT_ON) >= LIGHT_MIN);
  const accLine = step(textHsl, Math.min(1, textHsl[2] + 0.15), 1, (c) => contrast(c, ACC_LINE_ON) >= LINE_MIN);
  return {
    acc: accText,
    accHover: withL(textHsl, textHsl[2] - 0.06),
    accFill,
    accFillHover: withL(fillHsl, fillHsl[2] - 0.05),
    accText,
    accLight,
    accLine,
    adjusted: { text: accText !== hex, fill: accFill !== hex },
  };
}

// ---- web-only helpers (not part of the backend port: nothing above uses them) ----

/** `hex` lightened in 1 % lightness steps from its own lightness until `ok` holds (white at the latest); `hex` itself when it passes */
export function lightenUntil(hex: string, ok: (c: string) => boolean): string {
  const h = toHex(parseHex(hex));
  if (ok(h)) return h;
  const hsl = toHsl(parseHex(h));
  return step(hsl, hsl[2], 1, ok);
}

/** `a` mixed with `b` (`t` = the share of `b`, 0..1) in sRGB, as #rrggbb */
export function mixHex(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  return toHex([0, 1, 2].map((i) => x[i]! * (1 - t) + y[i]! * t) as RGB);
}

/** "r, g, b" of a #rrggbb colour (for `rgba(var(--acc-rgb), a)`) */
export function rgbTriplet(hex: string): string {
  return parseHex(hex).join(', ');
}
