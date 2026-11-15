// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/**
 * The instance's brand (branding spec; plan Global Constraints "Defaults"). One row in the `brand` table (migration 56); an empty
 * table means exactly today's look. Every field is public (GET /api/public/brand), so nothing private may ever be added here without
 * changing `publicBrand` in routes.ts.
 */

/** C0/C1 controls and the bidi embedding/override/isolate marks (a name must not reorder the text around it) */
const CONTROL = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** the same, but line breaks are allowed (the about text) */
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** length in characters (code points), as a person counts them: an emoji is one, not two UTF-16 units */
const chars = (s: string) => [...s].length;

const text = (max: number, min = 0, control = CONTROL) =>
  z.string().transform((s) => s.trim()).refine((s) => chars(s) >= min && chars(s) <= max && !control.test(s));

/** http(s) only, no credentials in the URL, at most 200 characters; '' = none */
const website = z.string().transform((s) => s.trim()).refine((s) => {
  if (s === '') return true;
  if (s.length > 200 || CONTROL.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' && u.hostname !== '';
  } catch {
    return false;
  }
});

export const IMAGE_HASH_RE = /^[0-9a-f]{64}$/;
const imageHash = z.string().regex(IMAGE_HASH_RE).nullable();

export const brandSchema = z.object({
  name: text(24, 1),
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
