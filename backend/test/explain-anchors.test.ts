// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EXPLAIN_ANCHORS, seedFor } from '../src/reco/explain.js';

// The profile keeps more anchors than it used to (for the request suggestions); the "Because you ..." reasons still come from the first 8.

describe('seedFor', () => {
  const vec = (k: string) => new Map([[k, 1]]);
  const index = { vecs: new Map(Array.from({ length: 12 }, (_x, i) => [`a${i}`, vec('d')])) } as any;
  const scored = { id: 'x', vec: vec('d'), parts: {}, meta: {} } as any;
  const anchors = Array.from({ length: 12 }, (_x, i) => ({ id: `a${i}`, w: i === 9 ? 1 : 0.5 })); // the 10th is the strongest contribution

  it('considers the first 8 anchors only', () => {
    expect(EXPLAIN_ANCHORS).toBe(8);
    expect(seedFor(scored, undefined, { anchors }, index)).toBe('a0');
  });
});
