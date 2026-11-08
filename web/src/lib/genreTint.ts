// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Phone search genre tiles: a fixed palette that sits on the coral/dark look; the tile colour is picked from the genre name. */
export const GENRE_PALETTE = [
  '#e8505b', '#c2417a', '#7b4bd1', '#3f63d6', '#1f8aa8', '#1f9a7a', '#c77a1e', '#a8483a',
] as const;

/** Same name (any case, any outer whitespace) always gives the same colour. */
export function genreColor(name: string): string {
  const s = name.trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return GENRE_PALETTE[h % GENRE_PALETTE.length]!;
}
