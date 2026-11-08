// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Phone search genre tiles: a fixed palette (every colour keeps white text at 4.5:1 or better) that sits on the coral/dark look; the tile colour is picked from the genre name. */
export const GENRE_PALETTE = [
  '#c4404a', '#a8346a', '#6a3fb8', '#3454c0', '#17728c', '#17806a', '#a8650f', '#903c30',
] as const;

/** Same name (any case, any outer whitespace) always gives the same colour. */
export function genreColor(name: string): string {
  const s = name.trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return GENRE_PALETTE[h % GENRE_PALETTE.length]!;
}
