// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { rowScrollTarget } from './rowScroll';

describe('rowScrollTarget', () => {
  it('puts the row top at the tile bottom', () => {
    expect(rowScrollTarget(900, 0, 540)).toBe(360);
    expect(rowScrollTarget(600, 400, 540)).toBe(460);
  });
  it('never scrolls above the top', () => expect(rowScrollTarget(100, 0, 540)).toBe(0));
});
