// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GENRE_PALETTE, genreColor } from './genreTint';

describe('genreColor', () => {
  it('is deterministic and ignores case and outer whitespace', () => {
    expect(genreColor('Drama')).toBe(genreColor('Drama'));
    expect(genreColor('  drama ')).toBe(genreColor('DRAMA'));
  });
  it('always returns a palette colour, including for an empty name', () => {
    for (const g of ['', 'Action', 'Sci-Fi', 'Krimi', 'Thriller', 'Komödie', 'Dokumentation']) expect(GENRE_PALETTE).toContain(genreColor(g));
  });
  it('spreads different genres over several colours', () => {
    const used = new Set(['Action', 'Drama', 'Krimi', 'Sci-Fi', 'Thriller', 'Horror', 'Komödie', 'Anime', 'Western', 'Fantasy'].map(genreColor));
    expect(used.size).toBeGreaterThan(3);
  });
});
