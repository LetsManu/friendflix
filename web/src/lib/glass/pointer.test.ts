// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ level: 'full' as 'full' | 'reduced', watched: 0 }));
vi.mock('#lib/tv/motion', () => ({ motionLevel: () => m.level, watchFrames: () => { m.watched++; } }));

import { fxLive, fxPointer, sheen, sheenAt, tilt, TILT_MAX, tiltStep, tiltStyles, tiltTarget } from './pointer';

/** a class list double */
class Classes {
  set = new Set<string>();
  add(c: string) { this.set.add(c); }
  remove(c: string) { this.set.delete(c); }
  contains(c: string) { return this.set.has(c); }
}
/** a minimal element double: listeners, children, classes, style, a fixed box, querySelector by class, closest by class */
class El {
  classList = new Classes();
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  listeners = new Map<string, (e: unknown) => void>();
  className = '';
  constructor(public cls = '', public box = { left: 0, top: 0, width: 200, height: 100 }) { if (cls) this.classList.add(cls); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  appendChild(c: El) { c.parent = this; if (c.className) c.classList.add(c.className); this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(t: string, f: (e: unknown) => void) { this.listeners.set(t, f); }
  removeEventListener(t: string, f: (e: unknown) => void) { if (this.listeners.get(t) === f) this.listeners.delete(t); }
  getBoundingClientRect() { return this.box; }
  fire(t: string, x = 0, y = 0) { this.listeners.get(t)?.({ clientX: x, clientY: y }); }
  querySelector(sel: string): El | null {
    for (const c of this.children) { if (c.classList.contains(sel.slice(1))) return c; const d = c.querySelector(sel); if (d) return d; }
    return null;
  }
  closest(sel: string): El | null { return this.classList.contains(sel.slice(1)) ? this : (this.parent?.closest(sel) ?? null); }
}

let html: El;
let fine = true;
let frames: (() => void)[] = [];
const flush = (max = 1000) => { let n = 0; while (frames.length && n++ < max) frames.shift()!(); return n; };

beforeEach(() => {
  m.level = 'full'; m.watched = 0; fine = true; frames = [];
  html = new El();
  vi.stubGlobal('document', { documentElement: html, createElement: () => new El() });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: fine)' && fine }));
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { frames.push(f); return ++id; });
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
});
afterEach(() => vi.unstubAllGlobals());

describe('gates', () => {
  it('fxPointer gates', () => {
    const ok = { level: 'full' as const, tv: false, kids: false, fine: true };
    expect(fxPointer(ok)).toBe(true);
    expect(fxPointer({ ...ok, level: 'reduced' })).toBe(false);
    expect(fxPointer({ ...ok, tv: true })).toBe(false);
    expect(fxPointer({ ...ok, kids: true })).toBe(false);
    expect(fxPointer({ ...ok, fine: false })).toBe(false);
  });

  it('fxLive', () => {
    expect(fxLive()).toBe(true);
    html.classList.add('tv');
    expect(fxLive()).toBe(false);
    html.classList.remove('tv');
    html.classList.add('kids');
    expect(fxLive()).toBe(false);
    html.classList.remove('kids');
    fine = false;
    expect(fxLive()).toBe(false);
    fine = true;
    m.level = 'reduced';
    expect(fxLive()).toBe(false);
    m.level = 'full';
    vi.stubGlobal('matchMedia', () => { throw new Error('no media queries'); });
    expect(fxLive()).toBe(false);
    vi.stubGlobal('matchMedia', undefined);
    expect(fxLive()).toBe(false);
    vi.stubGlobal('document', undefined);
    expect(fxLive()).toBe(false);
  });
});

describe('geometry', () => {
  it('sheenAt', () => {
    expect(sheenAt({ left: 10, top: 20 }, 110, 70)).toBe('translate3d(100px, 50px, 0)');
    expect(sheenAt({ left: 0.04, top: 0 }, 10.08, 3.333)).toBe('translate3d(10px, 3.3px, 0)');
  });

  it('tiltTarget', () => {
    const r = { left: 100, top: 50, width: 200, height: 100 };
    expect(tiltTarget(r, 200, 100)).toEqual({ x: 0, y: 0, gx: 100, gy: 50 });
    expect(tiltTarget(r, 300, 50)).toEqual({ x: 9, y: 9, gx: 200, gy: 0 }); // top-right corner
    expect(tiltTarget(r, 1000, 1000)).toEqual({ x: 9, y: -9, gx: 200, gy: 100 }); // clamped
    expect(tiltTarget(r, -50, -50)).toEqual({ x: -9, y: 9, gx: 0, gy: 0 });
    expect(tiltTarget(r, 300, 50, 4).x).toBe(4);
  });

  it('tiltStep', () => {
    const zero = { x: 0, y: 0, lift: 0 }, to = { x: 9, y: 0, lift: 1 };
    const one = tiltStep(zero, to);
    expect(one.next.x).toBeCloseTo(1.44, 6);
    expect(one.next.lift).toBeCloseTo(0.16, 6);
    expect(one.done).toBe(false);
    let s = zero, done = false, n = 0;
    while (!done && n++ < 200) ({ next: s, done } = tiltStep(s, to));
    expect(done).toBe(true);
    expect(s).toEqual(to);
    expect(tiltStep(zero, to, 0.5).next.x).toBe(4.5);
  });

  it('tiltStyles at lift 1, x 9', () => {
    const st = tiltStyles({ x: 9, y: -3, lift: 1 });
    expect(st.card).toContain('translate3d(0, -6px, 0)');
    expect(st.card).toContain('rotateX(-3deg)');
    expect(st.card).toContain('rotateY(9deg)');
    expect(st.card).toContain('scale(1.06)');
    expect(st.band).toBe('translateX(22%)');
    expect(st.shadowX).toBe(-10.8);
    expect(st.shadowScale).toBe(0.78);
    const rest = tiltStyles({ x: 0, y: 0, lift: 0 });
    expect(rest.card).toBe('translate3d(0, 0px, 0) rotateX(0deg) rotateY(0deg) scale(1)');
    expect(rest.shadowScale).toBe(0.9);
    expect(tiltStyles({ x: 4.5, y: 0, lift: 0 }, TILT_MAX).band).toBe('translateX(11%)');
  });
});

describe('sheen and tilt actions', () => {
  it('sheen: enter / move / leave, throttled to one frame, destroy cleans up', () => {
    const node = new El('host', { left: 10, top: 20, width: 200, height: 100 });
    const a = sheen(node as unknown as HTMLElement);
    const s = node.children[0]!;
    expect(s.classList.contains('frost-sheen')).toBe(true);
    expect(s.attrs['aria-hidden']).toBe('true');
    node.fire('pointermove', 50, 50); // not on yet: ignored
    expect(frames).toHaveLength(0);
    node.fire('pointerenter', 60, 40);
    expect(s.classList.contains('on')).toBe(true);
    expect(s.style.transform).toBe('translate3d(50px, 20px, 0)');
    node.fire('pointermove', 110, 70);
    node.fire('pointermove', 120, 80); // same frame: one rAF
    expect(frames).toHaveLength(1);
    flush();
    expect(s.style.transform).toBe('translate3d(110px, 60px, 0)');
    node.fire('pointerleave');
    expect(s.classList.contains('on')).toBe(false);
    node.fire('pointerenter', 60, 40);
    node.fire('pointermove', 70, 40);
    a.destroy(); // a pending frame is cancelled
    expect(frames).toHaveLength(0);
    expect(node.children).toHaveLength(0);
    expect(node.listeners.size).toBe(0);
  });

  it('sheen does nothing without fxLive()', () => {
    m.level = 'reduced';
    const node = new El('host');
    const a = sheen(node as unknown as HTMLElement);
    node.fire('pointerenter', 60, 40);
    node.fire('pointermove', 70, 40);
    expect(node.children[0]!.classList.contains('on')).toBe(false);
    expect(frames).toHaveLength(0);
    a.destroy();
    expect(node.listeners.size).toBe(0);
  });

  function card() {
    const row = new El('row');
    const node = row.appendChild(new El('wrap', { left: 0, top: 0, width: 200, height: 100 }));
    const parts = { card: new El('c'), glare: new El('g'), band: new El('b'), shadow: new El('s') };
    for (const p of Object.values(parts)) node.appendChild(p);
    return { row, node, parts };
  }
  const sel = { card: '.c', glare: '.g', band: '.b', shadow: '.s', row: '.row' };

  it('tilt: enter tilts toward the pointer, leave settles back, the loop stops and pulses the frame guard', () => {
    const { row, node, parts } = card();
    const a = tilt(node as unknown as HTMLElement, sel);
    node.fire('pointermove', 1, 1); // not on: ignored
    node.fire('pointerleave'); // not on: ignored
    expect(frames).toHaveLength(0);
    node.fire('pointerenter', 200, 0); // top-right corner
    expect(node.classList.contains('tilt-on')).toBe(true);
    expect(row.classList.contains('tilt-row')).toBe(true);
    flush(1);
    expect(parts.card.style.transform).toContain('rotateY(1.44deg)');
    expect(parts.glare.style.transform).toBe('translate(200px, 0px)');
    expect(parts.band.style.transform).toMatch(/^translateX\(/);
    expect(parts.shadow.style.transform).toMatch(/^translateX\(-1\.728px\) scale\(/);
    expect(m.watched).toBe(1);
    node.fire('pointermove', 100, 50); // centre
    expect(frames).toHaveLength(1); // still one loop
    const n = flush();
    expect(n).toBeLessThan(1000); // it settles
    expect(parts.card.style.transform).toBe('translate3d(0, -6px, 0) rotateX(0deg) rotateY(0deg) scale(1.06)');
    node.fire('pointerleave');
    expect(node.classList.contains('tilt-on')).toBe(false);
    expect(row.classList.contains('tilt-row')).toBe(false);
    flush();
    expect(parts.card.style.transform).toBe('translate3d(0, 0px, 0) rotateX(0deg) rotateY(0deg) scale(1)');
    expect(parts.shadow.style.transform).toBe('translateX(0px) scale(0.9)');
    expect(frames).toHaveLength(0);
    node.fire('pointerenter', 10, 10);
    a.destroy();
    expect(frames).toHaveLength(0);
    expect(node.listeners.size).toBe(0);
    expect(node.classList.contains('tilt-on')).toBe(false);
    expect(row.classList.contains('tilt-row')).toBe(false);
  });

  it('tilt looks its parts up once per hover and reads the box at most once per frame', () => {
    const { node } = card();
    let lookups = 0, reads = 0;
    const qs = node.querySelector.bind(node), rect = node.getBoundingClientRect.bind(node);
    node.querySelector = (sel: string) => { lookups++; return qs(sel); };
    node.getBoundingClientRect = () => { reads++; return rect(); };
    const a = tilt(node as unknown as HTMLElement, sel);
    node.fire('pointerenter', 200, 0);
    expect(lookups).toBe(4);
    node.fire('pointermove', 150, 10);
    node.fire('pointermove', 160, 20);
    node.fire('pointermove', 170, 30);
    expect(reads).toBe(0); // moves only note the point
    flush(1);
    expect(reads).toBe(1);
    flush(5); // frames without a new move: no reads
    expect(reads).toBe(1);
    expect(lookups).toBe(4);
    a.destroy();
  });

  it('calm mode or a tripped guard mid-hover stops tilt and sheen at once', () => {
    const { row, node, parts } = card();
    const a = tilt(node as unknown as HTMLElement, sel);
    node.fire('pointerenter', 200, 0);
    flush(3);
    expect(parts.card.style.transform).not.toContain('scale(1)');
    m.level = 'reduced'; // the guard trips
    const watched = m.watched;
    flush();
    expect(m.watched).toBe(watched); // no more guard pulses
    expect(frames).toHaveLength(0);
    expect(parts.card.style.transform).toBe('translate3d(0, 0px, 0) rotateX(0deg) rotateY(0deg) scale(1)');
    expect(node.classList.contains('tilt-on')).toBe(false);
    expect(row.classList.contains('tilt-row')).toBe(false);
    node.fire('pointermove', 10, 10); // stays off
    node.fire('pointerleave');
    expect(frames).toHaveLength(0);
    // a move notices it too (before any frame runs)
    m.level = 'full';
    node.fire('pointerenter', 200, 0);
    m.level = 'reduced';
    node.fire('pointermove', 10, 10);
    expect(frames).toHaveLength(0);
    expect(node.classList.contains('tilt-on')).toBe(false);
    a.destroy();

    m.level = 'full';
    const host = new El('host');
    const b = sheen(host as unknown as HTMLElement);
    const sp = host.children[0]!;
    host.fire('pointerenter', 10, 10);
    host.fire('pointermove', 20, 20);
    m.level = 'reduced';
    flush(); // the pending frame sees it
    expect(sp.classList.contains('on')).toBe(false);
    m.level = 'full';
    host.fire('pointerenter', 10, 10);
    m.level = 'reduced';
    host.fire('pointermove', 20, 20); // and so does a move
    expect(sp.classList.contains('on')).toBe(false);
    expect(frames).toHaveLength(0);
    b.destroy();
  });

  it('tilt does nothing without fxLive(); missing parts and no row are fine', () => {
    m.level = 'reduced';
    const { row, node, parts } = card();
    const a = tilt(node as unknown as HTMLElement, sel);
    node.fire('pointerenter', 200, 0);
    expect(node.classList.contains('tilt-on')).toBe(false);
    expect(row.classList.contains('tilt-row')).toBe(false);
    expect(frames).toHaveLength(0);
    expect(parts.card.style.transform).toBeUndefined();
    a.destroy();

    m.level = 'full';
    const bare = new El('wrap');
    const b = tilt(bare as unknown as HTMLElement, { card: '.c', glare: '.g', band: '.b', shadow: '.s' });
    bare.fire('pointerenter', 0, 0);
    expect(bare.classList.contains('tilt-on')).toBe(true);
    flush();
    bare.fire('pointerleave');
    flush();
    expect(frames).toHaveLength(0);
    b.destroy();
  });
});
