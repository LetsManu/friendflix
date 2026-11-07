// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { pageTarget, rowPages } from './rows';

describe('rowPages', () => {
  it('starts on page 0 with only next available', () => {
    expect(rowPages({ scroll: 0, viewport: 1000, content: 3500 })).toEqual({ page: 0, pages: 4, canPrev: false, canNext: true });
  });
  it('reaches the end', () => {
    expect(rowPages({ scroll: 2500, viewport: 1000, content: 3500 })).toEqual({ page: 3, pages: 4, canPrev: true, canNext: false });
  });
  it('is one page when content fits, and survives a zero viewport', () => {
    expect(rowPages({ scroll: 0, viewport: 1000, content: 800 })).toEqual({ page: 0, pages: 1, canPrev: false, canNext: false });
    expect(rowPages({ scroll: 0, viewport: 0, content: 0 }).pages).toBe(1);
  });
});

describe('pageTarget', () => {
  it('moves one viewport and clamps', () => {
    expect(pageTarget({ scroll: 0, viewport: 1000, content: 3500 }, 1)).toBe(1000);
    expect(pageTarget({ scroll: 2600, viewport: 1000, content: 3500 }, 1)).toBe(2500);
    expect(pageTarget({ scroll: 300, viewport: 1000, content: 3500 }, -1)).toBe(0);
    expect(pageTarget({ scroll: 0, viewport: 1000, content: 500 }, 1)).toBe(0);
  });
});
