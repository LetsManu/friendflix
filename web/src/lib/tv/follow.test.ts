// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followFocus, followShift } from './follow';

const moves: Array<{ el: unknown; axis: string; to: number }> = [];
vi.mock('#lib/tv/motion', () => ({ animateTo: (el: unknown, axis: string, to: number) => { moves.push({ el, axis, to }); return () => {}; } }));

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

// Node has no DOM: small doubles with just what followFocus touches.
type Rect = { top: number; height: number };
function fakeEl(o: { rect?: Rect; offsetHeight?: number; clientHeight?: number; children?: any[]; follow?: boolean } = {}) {
  const classes = new Set<string>();
  const listeners = new Map<string, (e: any) => void>();
  const el: any = {
    offsetHeight: o.offsetHeight ?? 0, clientHeight: o.clientHeight ?? 0, rect: o.rect ?? { top: 0, height: 0 },
    firstElementChild: null as any, parent: null as any, follow: !!o.follow, classes,
    classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } },
    addEventListener: (t: string, f: any) => listeners.set(t, f),
    removeEventListener: (t: string) => listeners.delete(t),
    getBoundingClientRect: () => ({ ...el.rect, bottom: el.rect.top + el.rect.height }),
    contains: (n: any) => { for (let x = n; x; x = x.parent) if (x === el) return true; return false; },
    closest: (_sel: string) => { for (let x = el; x; x = x.parent) if (x.follow) return x; return null; },
    focus: (target: any) => listeners.get('focusin')?.({ target }),
    listeners,
  };
  for (const c of o.children ?? []) c.parent = el;
  el.firstElementChild = o.children?.[0] ?? null;
  return el;
}

describe('followFocus (action)', () => {
  let observed: any[];
  let roCb: (() => void) | undefined;
  beforeEach(() => {
    moves.length = 0; observed = []; roCb = undefined;
    vi.stubGlobal('getComputedStyle', () => ({ paddingTop: '10px', paddingBottom: '10px' }));
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { roCb = cb; } observe(e: any) { observed.push(e); } disconnect() { observed = []; } });
  });
  afterEach(() => vi.unstubAllGlobals());

  // window view = 520 - 20 padding = 500; strip 1200 tall
  const setup = () => {
    const item = fakeEl({ rect: { top: 0, height: 100 }, follow: true });
    const inside = fakeEl();
    inside.parent = item;
    const strip = fakeEl({ offsetHeight: 1200, rect: { top: 0, height: 1200 }, children: [item] });
    const win = fakeEl({ clientHeight: 520, children: [strip] });
    return { win, strip, item, inside };
  };

  it('marks the edges at start: more content below, nothing above', () => {
    const { win } = setup();
    followFocus(win);
    expect(win.classes.has('below')).toBe(true);
    expect(win.classes.has('above')).toBe(false);
    expect(observed.length).toBe(2); // window and strip
  });

  it('glides the strip when the focused row item is past the edge, measuring the [data-follow] ancestor', () => {
    const { win, strip, item, inside } = setup();
    followFocus(win);
    item.rect = { top: 450, height: 100 }; // bottom + peek (60) = 610 > view 500
    win.focus(inside);
    expect(moves).toEqual([{ el: strip, axis: 'y', to: -110 }]);
    expect(win.classes.has('above')).toBe(true);
    expect(win.classes.has('below')).toBe(true);
  });

  it('measures relative to the strip, so its own transform does not count; falls back to the target itself', () => {
    const { win, strip, item } = setup();
    followFocus(win, { peek: 0 });
    strip.rect = { top: -200, height: 1200 }; // strip currently animated
    item.follow = false;
    const plain = fakeEl({ rect: { top: 600 - 200, height: 100 } }); // layout top 600 inside strip
    plain.parent = strip;
    win.focus(plain);
    expect(moves).toEqual([{ el: strip, axis: 'y', to: -200 }]); // 600 + 100 - 500
  });

  it('ignores focus outside the strip, without a target and without a strip; tiny moves do not animate', () => {
    const { win, item } = setup();
    followFocus(win);
    win.focus(fakeEl());
    win.focus(null);
    item.rect = { top: 10, height: 100 };
    win.focus(item); // already in view: shift stays 0
    expect(moves).toEqual([]);
    const empty = fakeEl({ clientHeight: 100 });
    followFocus(empty);
    empty.focus(fakeEl());
    expect(empty.classes.has('below')).toBe(false);
    expect(moves).toEqual([]);
  });

  it('a changed key glides back to the top; an unchanged key only refreshes', () => {
    const { win, strip, item } = setup();
    const a = followFocus(win, { key: 1 });
    item.rect = { top: 450, height: 100 };
    win.focus(item);
    moves.length = 0;
    a.update({ key: 1 });
    expect(moves).toEqual([]);
    a.update({ key: 2 });
    expect(moves).toEqual([{ el: strip, axis: 'y', to: 0 }]);
    expect(win.classes.has('above')).toBe(false);
    a.update(); // key undefined vs 2: reset again, with defaults
    expect(moves).toHaveLength(2);
  });

  it('keeps the edge fades honest when the content resizes, and cleans up on destroy', () => {
    const { win, strip } = setup();
    const a = followFocus(win);
    strip.offsetHeight = 100;
    roCb!();
    expect(win.classes.has('below')).toBe(false);
    a.destroy();
    expect(win.listeners.has('focusin')).toBe(false);
    expect(observed).toEqual([]);
  });

  it('works without ResizeObserver and without a strip', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const win = fakeEl({ clientHeight: 100 });
    const a = followFocus(win);
    a.update({ key: 'x' });
    a.destroy();
    expect(moves).toEqual([]);
  });

  it('treats unparsable padding as 0', () => {
    vi.stubGlobal('getComputedStyle', () => ({ paddingTop: '', paddingBottom: 'auto' }));
    const { win } = setup();
    followFocus(win); // view 520 < 1200
    expect(win.classes.has('below')).toBe(true);
  });
});
