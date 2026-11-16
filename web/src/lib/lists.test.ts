// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { coverGradient, isNotFound, moveItem, pickerCache, PICKER_FAIL_TTL_MS, PICKER_TTL_MS, type PickerList } from './lists';

describe('isNotFound', () => {
  it('is true only for 404', () => {
    expect(isNotFound(new ApiError(404, null))).toBe(true);
    expect(isNotFound(new ApiError(502, null))).toBe(false);
    expect(isNotFound(new TypeError('network'))).toBe(false);
  });
});

describe('themed list helpers', () => {
  it('moveItem reorders without mutating and ignores impossible moves', () => {
    const a = ['a', 'b', 'c'];
    expect(moveItem(a, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(a, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(a, 0, 0)).toEqual(a);
    expect(moveItem(a, 0, -1)).toEqual(a);
    expect(moveItem(a, 0, 3)).toEqual(a);
    expect(a).toEqual(['a', 'b', 'c']);
  });
  it('coverGradient uses the colour or a neutral fallback, never raw input', () => {
    expect(coverGradient('#112233')).toContain('#112233');
    expect(coverGradient(null)).toContain('#3d4450');
    expect(coverGradient('red; background:url(x)')).toContain('#3d4450');
  });
});

describe('pickerCache', () => {
  const L: PickerList[] = [{ id: 'a', name: 'A', contains: false, canEdit: true }];
  const setup = (fail = false) => {
    let t = 1000;
    const load = vi.fn((_id: string) => (fail ? Promise.reject(new Error('x')) : Promise.resolve(L)));
    return { c: pickerCache(load, () => t, 2), load, tick: (ms: number) => { t += ms; } };
  };
  it('shares a running request and a fresh result; loads again once old or when asked', async () => {
    const { c, load, tick } = setup();
    expect(c.now('i')).toBeNull();
    const p = c.get('i');
    expect(c.get('i')).toBe(p);
    expect(c.now('i')).toBeNull(); // still running
    await p;
    expect(c.now('i')).toEqual({ lists: L });
    tick(PICKER_TTL_MS - 1);
    await c.get('i');
    expect(load).toHaveBeenCalledTimes(1);
    tick(1);
    expect(c.now('i')).toBeNull();
    await c.get('i');
    expect(load).toHaveBeenCalledTimes(2);
    await c.get('i', true);
    expect(load).toHaveBeenCalledTimes(3);
    c.forget('i');
    expect(c.now('i')).toBeNull();
  });
  it('keeps a failure for a short time', async () => {
    const { c, load, tick } = setup(true);
    await expect(c.get('i')).rejects.toThrow();
    expect(c.now('i')).toEqual({ failed: true });
    await expect(c.get('i')).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(1);
    tick(PICKER_FAIL_TTL_MS);
    expect(c.now('i')).toBeNull();
    await expect(c.get('i')).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('keeps at most `max` titles, dropping the oldest', async () => {
    const { c } = setup();
    await Promise.all([c.get('a'), c.get('b'), c.get('c')]);
    expect(c.now('a')).toBeNull();
    expect(c.now('c')).toEqual({ lists: L });
  });
});
