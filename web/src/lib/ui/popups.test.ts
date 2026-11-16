// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllPopups, openPopup, openPopups } from './popups';

afterEach(() => closeAllPopups());

describe('popups', () => {
  it('opening a second pop-up closes the first', () => {
    const a = vi.fn(), b = vi.fn();
    openPopup(a);
    openPopup(b);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(openPopups()).toBe(1);
  });
  it('a child keeps its parent open', () => {
    const p = vi.fn(), c = vi.fn();
    const ph = openPopup(p);
    openPopup(c, ph);
    expect(p).not.toHaveBeenCalled();
    expect(openPopups()).toBe(2);
  });
  it('a sibling of a child closes the child and keeps the parent', () => {
    const p = vi.fn(), c1 = vi.fn(), c2 = vi.fn();
    const ph = openPopup(p);
    openPopup(c1, ph);
    openPopup(c2, ph);
    expect(c1).toHaveBeenCalledTimes(1);
    expect(p).not.toHaveBeenCalled();
    expect(c2).not.toHaveBeenCalled();
    expect(openPopups()).toBe(2);
  });
  it('a grandchild keeps all ancestors open', () => {
    const p = vi.fn(), c = vi.fn(), g = vi.fn();
    const ph = openPopup(p);
    const ch = openPopup(c, ph);
    openPopup(g, ch);
    expect(p).not.toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
    expect(openPopups()).toBe(3);
  });
  it('releasing a parent closes its children first', () => {
    const order: string[] = [];
    const ph = openPopup(() => order.push('parent-close'));
    openPopup(() => order.push('child'), ph);
    ph.release();
    order.push('parent');
    expect(order).toEqual(['child', 'parent']);
    expect(openPopups()).toBe(0);
  });
  it('closeAllPopups closes everything, deepest first, and leaves none', () => {
    const order: string[] = [];
    const ph = openPopup(() => order.push('parent'));
    openPopup(() => order.push('child'), ph);
    closeAllPopups();
    expect(order).toEqual(['child', 'parent']);
    expect(openPopups()).toBe(0);
  });
  it('release is idempotent, even from inside close', () => {
    const close = vi.fn(() => h.release());
    const h = openPopup(close);
    h.release();
    h.release();
    expect(close).not.toHaveBeenCalled();
    const close2 = vi.fn(() => h2.release());
    const h2 = openPopup(close2);
    closeAllPopups();
    expect(close2).toHaveBeenCalledTimes(1);
    expect(openPopups()).toBe(0);
  });
});

describe('popups, stale parent', () => {
  it('a released parent is treated as no parent', () => {
    const ph = openPopup(() => {});
    ph.release();
    const a = vi.fn();
    openPopup(a);
    openPopup(() => {}, ph);
    expect(a).toHaveBeenCalledTimes(1);
  });
});
