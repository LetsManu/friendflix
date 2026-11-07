// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

const level = vi.hoisted(() => ({ allowed: true, value: 'full' as 'full' | 'reduced' }));
vi.mock('#lib/preview', () => ({ motionAllowed: () => level.allowed }));
vi.mock('#lib/tv/motion', () => ({ motionLevel: () => level.value }));
import { bezier, emphIn, emphOut, sheetIn, sheetOut } from './tvSheet';

const el = {} as Element;
afterEach(() => { level.allowed = true; level.value = 'full'; });

describe('bezier', () => {
  it('keeps the end points and follows the curve', () => {
    for (const f of [emphOut, emphIn]) { expect(f(0)).toBe(0); expect(f(1)).toBe(1); }
    expect(emphOut(0.3)).toBeGreaterThan(0.6); // fast out
    expect(emphIn(0.3)).toBeLessThan(0.1); // slow start
    expect(bezier(0, 0, 1, 1)(0.5)).toBeCloseTo(0.5, 3); // linear
    expect(bezier(0.5, 0.5, 0.5, 0.5)(0.25)).toBeCloseTo(0.25, 2);
  });
});

describe('sheet transitions', () => {
  it('full motion: slide up 48 px in 320 ms, leave 32 px in 200 ms', () => {
    const i = sheetIn(el), o = sheetOut(el);
    expect(i.duration).toBe(320); expect(o.duration).toBe(200);
    expect(i.css(0)).toBe('opacity:0;transform:translate3d(0,48.0px,0)');
    expect(i.css(1)).toBe('opacity:1;transform:translate3d(0,0.0px,0)');
    expect(o.css(0.5)).toContain('16.0px');
    expect(i.easing).toBe(emphOut); expect(o.easing).toBe(emphIn);
  });
  it('the reduced set: a 150 ms fade', () => {
    level.value = 'reduced';
    const i = sheetIn(el);
    expect(i.duration).toBe(150); expect(i.css(0.4)).toBe('opacity:0.4');
  });
  it('calm / reduced motion: instant', () => {
    level.allowed = false;
    const o = sheetOut(el);
    expect(o.duration).toBe(0); expect(o.css(0.5)).toBe('');
  });
});
