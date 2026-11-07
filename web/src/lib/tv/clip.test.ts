// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { clipSupported, noScroll } from './clip';

function box() {
  const fns = new Set<() => void>();
  return {
    scrollTop: 0, scrollLeft: 0, fns,
    addEventListener: (_: string, f: () => void) => fns.add(f),
    removeEventListener: (_: string, f: () => void) => fns.delete(f),
    fire() { fns.forEach((f) => f()); },
  };
}
const old = { supports: (p: string, v: string) => !(p === 'overflow' && v === 'clip') };
const fresh = { supports: () => true };

describe('noScroll (overflow: clip fallback)', () => {
  it('knows overflow: clip from CSS.supports; without the API it assumes support', () => {
    expect(clipSupported(fresh)).toBe(true);
    expect(clipSupported(old)).toBe(false);
    expect(clipSupported({})).toBe(true);
    expect(clipSupported()).toBe(true); // Node: no CSS global
  });
  it('does nothing where overflow: clip works', () => {
    const b = box();
    noScroll(b as unknown as HTMLElement, fresh).destroy();
    expect(b.fns.size).toBe(0);
  });
  it('on an old engine puts a scrolled box back to 0 and stops on destroy', () => {
    const b = box();
    const a = noScroll(b as unknown as HTMLElement, old);
    b.fire(); // nothing scrolled: no write
    expect(b.scrollTop).toBe(0);
    b.scrollTop = 120; b.scrollLeft = 8; b.fire();
    expect([b.scrollTop, b.scrollLeft]).toEqual([0, 0]);
    a.destroy();
    expect(b.fns.size).toBe(0);
  });
});
