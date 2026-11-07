// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { followShift } from './follow';

describe('followShift (TV list windows)', () => {
  const base = { shift: 0, view: 500, total: 1200, h: 100, peek: 50 };
  it('stays put while the item and its peek are in view', () => expect(followShift({ ...base, top: 200 })).toBe(0));
  it('moves down just far enough to show the item and a peek of the next one', () => expect(followShift({ ...base, top: 450 })).toBe(100));
  it('moves back up to show the item and a peek of the previous one', () => expect(followShift({ ...base, shift: 400, top: 300 })).toBe(250));
  it('never past either end of the content', () => {
    expect(followShift({ ...base, top: 1100 })).toBe(700);
    expect(followShift({ ...base, shift: 300, top: 0 })).toBe(0);
    expect(followShift({ ...base, total: 300, top: 250 })).toBe(0); // everything fits: no movement
  });
});
