// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/**
 * The instance's brand (branding spec; plan Global Constraints "Defaults"). One row in the `brand` table (migration 56); an empty
 * table means exactly today's look. Every field is public (GET /api/public/brand), so nothing private may ever be added here without
 * changing `publicBrand` in routes.ts.
 */

/**
 * Characters a brand text must not contain: C0/C1 controls; every format character (\p{Cf}: the bidi embedding/override/isolate marks
 * U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069, zero-width spaces, the BOM, the soft hyphen, stray tag characters), except
 * U+200D (the joiner of emoji sequences) and U+200C (the non-joiner Persian and Indic names need); the line and paragraph separators;
 * and the Hangul fillers, letters that render as nothing. A name must not reorder the text around it, look empty, or carry a line break
 * into a title or the manifest. Tag characters are fine inside a subdivision flag (U+1F3F4, tags, U+E007F: the Scotland flag).
 */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]|(?![\u200c\u200d])\p{Cf}/u;
/** the same, but line breaks are allowed (the about text) */
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]|(?![\u200c\u200d])\p{Cf}/u;
/** a subdivision flag emoji: the black flag, its tag characters and the cancel tag */
const FLAG_TAGS = /\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}/gu;
/** whether `s` has a refused character (`control`), the tags of a subdivision flag allowed */
const hasControl = (s: string, control: RegExp) => control.test(s.replace(FLAG_TAGS, '\u{1f3f4}'));
/** something a person can see: a letter, a digit or a symbol (an emoji is a symbol; the blank braille pattern is not) */
const VISIBLE = /(?!\u2800)[\p{L}\p{N}\p{S}]/u;

/** length in characters (code points), as a person counts them: an emoji is one, not two UTF-16 units */
const chars = (s: string) => [...s].length;

const text = (max: number, min = 0, control = CONTROL) =>
  z.string().transform((s) => s.trim()).refine((s) => chars(s) >= min && chars(s) <= max && !hasControl(s, control));

/**
 * http(s) only, no credentials in the URL, at most 200 characters; '' = none. Stored as the parsed URL's href, so every consumer gets
 * one canonical absolute URL (`http:example.com` becomes `http://example.com/`, never a relative path).
 */
const website = z.string().transform((s) => s.trim()).refine((s) => {
  if (s === '') return true;
  if (s.length > 200 || CONTROL.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' && u.hostname !== '';
  } catch {
    return false;
  }
}).transform((s) => (s === '' ? '' : new URL(s).href)).refine((s) => s.length <= 200);

export const IMAGE_HASH_RE = /^[0-9a-f]{64}$/;
const imageHash = z.string().regex(IMAGE_HASH_RE).nullable();

export const brandSchema = z.object({
  name: text(24, 1).refine((s) => VISIBLE.test(s)),
  byline: text(32),
  /** '' = the name */
  shortName: text(12),
  website,
  about: text(280, 0, CONTROL_EXCEPT_NEWLINE),
  header: z.enum(['wordmark', 'symbol', 'logo']),
  accent: z.string().transform((s) => s.toLowerCase()).refine((s) => /^#[0-9a-f]{6}$/.test(s)),
  glow: z.enum(['accent', 'accentViolet', 'neutral', 'off']),
  signInBg: z.enum(['posters', 'image', 'color']),
  logo: imageHash,
  symbol: imageHash,
  signInImage: imageHash,
}).strict();

export type Brand = z.output<typeof brandSchema>;
/** what GET /api/public/brand returns: today every field (the type keeps the two apart for a later private one) */
export type PublicBrand = Brand;

export const BRAND_KEYS = Object.keys(brandSchema.shape) as Array<keyof Brand>;

export const DEFAULT_BRAND: Brand = Object.freeze({
  name: 'FriendFlix',
  byline: '',
  shortName: '',
  website: '',
  about: '',
  header: 'wordmark',
  accent: '#ff4f6d',
  glow: 'accentViolet',
  signInBg: 'posters',
  logo: null,
  symbol: null,
  signInImage: null,
}) as Brand;

/** a PUT's brand: any subset of the fields, nothing else */
export const brandPatchSchema = brandSchema.partial().strict();

/**
 * A stored row's data as a Brand: field by field, so a value that no longer validates (an older release, a hand edit) falls back to its
 * default alone, and keys that are not brand fields are dropped.
 */
export function brandFromStored(data: unknown): Brand {
  const src = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_BRAND };
  for (const k of BRAND_KEYS) {
    if (!(k in src)) continue;
    const r = brandSchema.shape[k].safeParse(src[k]);
    if (r.success) out[k] = r.data;
  }
  return out as Brand;
}
