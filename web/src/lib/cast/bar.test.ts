// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { barVisible } from './bar';
import type { CastSession } from './engine';

describe('cast bar', () => {
  it('barVisible', () => {
    const s = { itemId: 'x' } as CastSession;
    expect(barVisible({ path: '/', tv: false, session: s })).toBe(true);
    expect(barVisible({ path: '/watch/x', tv: false, session: s })).toBe(false);
    expect(barVisible({ path: '/party/abc', tv: false, session: s })).toBe(false);
    expect(barVisible({ path: '/', tv: true, session: s })).toBe(false);
    expect(barVisible({ path: '/', tv: false, session: null })).toBe(false);
  });
});
