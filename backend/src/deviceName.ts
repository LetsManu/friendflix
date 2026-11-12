// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

// control characters, lone surrogates, the bidi embeddings/overrides/isolates (U+202A-202E, U+2066-2069) and the direction marks
// U+200E, U+200F, U+061C; all written as escapes on purpose
const REFUSED = /[\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
// what shows nothing: format characters (zero-width space, word joiner, joiner), spaces, variation selectors, every default-ignorable
// code point (Hangul fillers U+115F/U+3164/U+FFA0, combining grapheme joiner U+034F, ...) and the braille blank U+2800
const NOT_VISIBLE = /^[\p{Cf}\p{Z}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}\u2800]*$/u;

/**
 * The user's own name for a device (spec 2.8). `null` or a name without a visible character resets it. Refused characters are
 * checked on the whole raw input first (so a tab inside is refused, not collapsed); then NFC, trim, inner whitespace runs to
 * one space, 1 to 40 code points.
 */
export function cleanDeviceName(raw: unknown): { ok: true; name: string | null } | { ok: false } {
  if (raw === null) return { ok: true, name: null };
  if (typeof raw !== 'string' || REFUSED.test(raw)) return { ok: false };
  const s = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (NOT_VISIBLE.test(s)) return { ok: true, name: null };
  return [...s].length <= 40 ? { ok: true, name: s } : { ok: false };
}
