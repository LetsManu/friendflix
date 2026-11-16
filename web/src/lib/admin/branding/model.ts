// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Branding's staged-edits model (branding stage A Task 4): the field limits and their messages (the backend's schema,
 * backend/src/brand/schema.ts, checked here first so the admin sees a message while typing), the diff a save sends, the tabs a change
 * belongs to, the accent presets and contrast readout (lib/brandColors.ts, the backend's derivation), and the brand the live preview
 * renders. Everything here is pure.
 */
import { DEFAULT_APP_NAME, fmtNumber, tr } from '#lib/i18n';
import { brandPalette, DEFAULT_BRAND, GLASS_TEXT_ON, type BrandGlow, type BrandImages, type LoadedBrand, type PublicBrand } from '#lib/brand';
import { ACC_TEXT_ON, contrast, deriveTokens, type BrandTokens } from '#lib/brandColors';
import { contrast as rgbContrast, type RGB } from '#lib/glass/tone';

export type FieldKey = keyof PublicBrand;
export type BrandTab = 'identity' | 'logo' | 'colors';
/** stage A's tabs (Texte, Rechtliches & Hilfe, Teilen & E-Mails come with stage B) */
export const BRAND_TABS: readonly BrandTab[] = ['identity', 'logo', 'colors'];

export const FIELD_TAB: Readonly<Record<FieldKey, BrandTab>> = {
  name: 'identity', byline: 'identity', shortName: 'identity', website: 'identity', about: 'identity',
  header: 'logo', logo: 'logo', symbol: 'logo',
  accent: 'colors', glow: 'colors', signInBg: 'colors', signInImage: 'colors',
};
/** the order the save looks for the first error in (the page's field order) */
const FIELD_ORDER: readonly FieldKey[] = ['name', 'byline', 'shortName', 'website', 'about', 'header', 'logo', 'symbol', 'accent', 'glow', 'signInBg', 'signInImage'];
export const IMAGE_FIELDS = ['logo', 'symbol', 'signInImage'] as const;
export type ImageField = (typeof IMAGE_FIELDS)[number];
const TEXT_FIELDS = ['name', 'byline', 'shortName', 'website', 'about'] as const;

/** characters at most (code points, trimmed), as the backend counts them */
export const LIMITS = { name: 24, byline: 32, shortName: 12, website: 200, about: 280 } as const;

/** the six accent presets (the mockup's; coral is today's default) */
export const PRESETS = [
  { id: 'coral', hex: '#ff4f6d' }, { id: 'violet', hex: '#a37cff' }, { id: 'blue', hex: '#4c9dff' },
  { id: 'teal', hex: '#2fc4b2' }, { id: 'gold', hex: '#f2b52c' }, { id: 'green', hex: '#5ccf6a' },
] as const;

// the backend's character rules (schema.ts CONTROL, CONTROL_EXCEPT_NEWLINE, FLAG_TAGS, VISIBLE)
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]|(?![‌‍])\p{Cf}/u;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}ᅟᅠㅤﾠ]|(?![‌‍])\p{Cf}/u;
const FLAG_TAGS = /\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}/gu;
const hasControl = (s: string, re: RegExp) => re.test(s.replace(FLAG_TAGS, '\u{1f3f4}'));
const VISIBLE = /(?!⠀)[\p{L}\p{N}\p{S}]/u;

/** characters as a person counts them (an emoji is one) */
export const charCount = (s: string): number => [...s].length;

/** '#4c9dff' from '#4C9DFF', '4c9dff' or '#4cf' (null: not a colour) */
export function normalizeAccent(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  if (/^[0-9a-f]{3}$/.test(s)) return `#${[...s].map((c) => c + c).join('')}`;
  return null;
}

function websiteOk(s: string): boolean {
  if (CONTROL.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' && u.hostname !== '';
  } catch {
    return false;
  }
}

const tooLong = (max: number) => tr('admin.branding.errors.tooLong', { max });

/** the message for a field's value ('' = fine) */
export function fieldError(key: FieldKey, value: unknown): string {
  if (key === 'accent') return typeof value === 'string' && normalizeAccent(value) ? '' : tr('admin.branding.errors.accent');
  if (!(TEXT_FIELDS as readonly string[]).includes(key)) return '';
  const s = typeof value === 'string' ? value.trim() : '';
  const max = LIMITS[key as keyof typeof LIMITS];
  if (key === 'name' && s === '') return tr('admin.branding.errors.required');
  if (key === 'website') {
    if (s === '') return '';
    if (charCount(s) > max) return tooLong(max);
    return websiteOk(s) ? '' : tr('admin.branding.errors.website');
  }
  if (hasControl(s, key === 'about' ? CONTROL_EXCEPT_NEWLINE : CONTROL)) return tr('admin.branding.errors.chars');
  if (charCount(s) > max) return tooLong(max);
  if (key === 'name' && !VISIBLE.test(s)) return tr('admin.branding.errors.visible');
  return '';
}

/** every field's message, in the page's order (an empty object: all fine) */
export function validate(b: PublicBrand): Partial<Record<FieldKey, string>> {
  const out: Partial<Record<FieldKey, string>> = {};
  for (const k of FIELD_ORDER) {
    const e = fieldError(k, b[k]);
    if (e) out[k] = e;
  }
  return out;
}

/** the first field with a message (the page's order) */
export const firstError = (errors: Partial<Record<FieldKey, string>>): FieldKey | null => FIELD_ORDER.find((k) => errors[k]) ?? null;

/** a value as it is sent: text trimmed, the accent normalised (a half-typed accent stays as typed, so it counts as a change) */
function norm(k: FieldKey, v: unknown): unknown {
  if (k === 'accent' && typeof v === 'string') return normalizeAccent(v) ?? v;
  if ((TEXT_FIELDS as readonly string[]).includes(k) && typeof v === 'string') return v.trim();
  return v;
}

/** the staged fields that differ from the saved brand, as the PUT sends them */
export function stagedDiff(saved: PublicBrand, staged: PublicBrand): Partial<PublicBrand> {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) {
    const v = norm(k, staged[k]);
    if (v !== norm(k, saved[k])) out[k] = v;
  }
  return out as Partial<PublicBrand>;
}

export const isDirty = (saved: PublicBrand, staged: PublicBrand): boolean => Object.keys(stagedDiff(saved, staged)).length > 0;

/** the tabs holding a change */
export const dirtyTabs = (diff: Partial<PublicBrand>): Set<BrandTab> => new Set(Object.keys(diff).map((k) => FIELD_TAB[k as FieldKey]));

// ---- colours ----

export interface RatioRow { id: 'text' | 'fill' | 'glass'; ratio: number; adjusted: boolean }

const hexRgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

/**
 * The contrast readout: accent text on the dark page (`--acc-text`), white on the buttons (`--acc-fill`), both from the backend's
 * derivation with its own `adjusted`; and accent text on the light glass (`--acc-glass`, a web-only shade, lib/brand.ts brandPalette),
 * its lowest ratio over the glass backgrounds, "angepasst" when it had to be lightened beyond `--acc-light`.
 */
export function ratioRows(t: BrandTokens): RatioRow[] {
  const glass = brandPalette(t).glassText;
  return [
    { id: 'text', ratio: contrast(t.accText, ACC_TEXT_ON), adjusted: t.adjusted.text },
    { id: 'fill', ratio: contrast('#ffffff', t.accFill), adjusted: t.adjusted.fill },
    { id: 'glass', ratio: Math.min(...GLASS_TEXT_ON.map((bg) => rgbContrast(hexRgb(glass), bg))), adjusted: glass !== t.accLight },
  ];
}

/** "4,5:1" (one decimal, in the person's language; rounded down, so a passing ratio never reads higher than it is) */
export const ratioText = (r: number): string =>
  tr('admin.branding.colors.ratio', { ratio: fmtNumber(Math.floor(r * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });

const rgba = (hex: string, a: number) => `rgba(${hexRgb(hex).join(', ')}, ${a})`;

/** the page glow of a mode (app.css .frost-amb and html.glow-<mode>), from the tokens' colour values only */
export function glowBackground(glow: BrandGlow, t: BrandTokens): string {
  const base = '#0a090d';
  if (glow === 'off') return base;
  if (glow === 'neutral') {
    return `radial-gradient(60% 55% at 78% 22%, rgba(150, 150, 165, 0.2), transparent 70%), radial-gradient(45% 50% at 20% 85%, rgba(110, 110, 128, 0.16), transparent 70%), ${base}`;
  }
  if (glow === 'accent') {
    return `radial-gradient(60% 55% at 78% 22%, ${rgba(t.accFill, 0.33)}, transparent 70%), radial-gradient(45% 50% at 20% 85%, ${rgba(t.accFill, 0.18)}, transparent 70%), radial-gradient(40% 40% at 55% 60%, ${rgba(t.acc, 0.13)}, transparent 70%), ${base}`;
  }
  return `radial-gradient(60% 55% at 78% 22%, rgba(214, 92, 64, 0.33), transparent 70%), radial-gradient(45% 50% at 20% 85%, rgba(78, 64, 190, 0.25), transparent 70%), radial-gradient(40% 40% at 55% 60%, ${rgba(t.acc, 0.13)}, transparent 70%), ${base}`;
}

// ---- the preview ----

/** the image URLs the page knows, by field (the saved answer's and this visit's uploads) */
export type ImageUrls = Partial<Record<ImageField, string>>;

/**
 * The brand the preview renders: the staged values, the tokens of the staged accent (or of `lastAccent`, the last valid one, while a
 * colour is half typed), and the images the staged fields refer to.
 */
export function previewBrand(staged: PublicBrand, urls: ImageUrls, lastAccent: string = DEFAULT_BRAND.accent): LoadedBrand {
  const accent = normalizeAccent(staged.accent) ?? normalizeAccent(lastAccent) ?? DEFAULT_BRAND.accent;
  const name = staged.name.trim() || DEFAULT_APP_NAME;
  const images: BrandImages = {};
  if (staged.logo && urls.logo) images.logo = urls.logo;
  if (staged.symbol && urls.symbol) images.symbol = urls.symbol;
  if (staged.signInImage && urls.signInImage) images.signIn = urls.signInImage;
  return {
    rev: 0, brand: { ...staged, accent }, tokens: deriveTokens(accent), images, name, shortName: staged.shortName.trim() || name,
  };
}

/**
 * The custom properties the preview (and the crop masks) set around themselves, so the shell's own pieces inside (lib/Logo.svelte's
 * mark, `var(--acc-fill)`) draw the staged colours: only colour values derived from a validated accent.
 */
export function previewVars(b: LoadedBrand): string {
  const t = b.tokens, p = brandPalette(t);
  return [['--acc', t.acc], ['--acc-text', t.accText], ['--acc-fill', t.accFill], ['--acc-fill-hover', t.accFillHover], ['--acc-light', t.accLight],
    ['--acc-glass', p.glassText], ['--acc-rgb', p.rgb], ['--mark-from', p.markFrom], ['--mark-to', p.markTo]]
    .filter(([, v]) => /^#[0-9a-f]{6}$/.test(v!) || /^\d{1,3}, \d{1,3}, \d{1,3}$/.test(v!))
    .map(([k, v]) => `${k}:${v}`).join(';');
}

// ---- server answers ----

/** a 400 `invalid` for `field`: its message (an image field: it was swept before the save, upload it again); null for no field */
export function serverFieldError(field: string): { field: FieldKey; text: string } | null {
  if (!(field in FIELD_TAB)) return null;
  const f = field as FieldKey;
  return { field: f, text: tr((IMAGE_FIELDS as readonly string[]).includes(f) ? 'admin.branding.errors.imageGone' : 'admin.branding.errors.invalid') };
}

/** an upload's error code (the backend's, or the browser preparation's) as a sentence */
export function uploadErrorText(code: string, size?: { width?: number; height?: number }): string {
  switch (code) {
    case 'too_large': case 'tooLarge': return tr('admin.branding.errors.tooLarge');
    case 'unsupported_type': case 'type': return tr('admin.branding.errors.imageType');
    case 'dimensions': return tr('admin.branding.errors.dimensions');
    case 'corrupt': return tr('admin.branding.errors.corrupt');
    case 'read': return tr('admin.branding.errors.imageRead');
    case 'large': return tr('admin.branding.errors.imageLarge');
    case 'small': return tr('admin.branding.errors.imageSmall', { w: size?.width ?? 0, h: size?.height ?? 0 });
    default: return tr('admin.branding.errors.uploadFailed');
  }
}
