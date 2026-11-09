// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ allowed: true, level: 'full' as 'full' | 'reduced' }));
vi.mock('#lib/preview', () => ({ motionAllowed: () => m.allowed }));
vi.mock('#lib/tv/motion', () => ({ motionLevel: () => m.level, GLASS_OUT: 'cubic-bezier(.22,1,.36,1)' }));

import { rippleBox } from './fx';
import { press, PRESS_SCALE, RIPPLE_MS } from './press';

class Classes {
  set = new Set<string>();
  add(...c: string[]) { c.forEach((x) => this.set.add(x)); }
  remove(...c: string[]) { c.forEach((x) => this.set.delete(x)); }
  contains(c: string) { return this.set.has(c); }
}
type Anim = { onfinish: (() => void) | null; oncancel: (() => void) | null; frames: Keyframe[]; opts: KeyframeAnimationOptions };
class Span {
  className = '';
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  parent: Node | null = null;
  anim: Anim | null = null;
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  animate(frames: Keyframe[], opts: KeyframeAnimationOptions) { this.anim = { onfinish: null, oncancel: null, frames, opts }; return this.anim; }
}
class Node {
  classList = new Classes();
  children: Span[] = [];
  listeners = new Map<string, (e: unknown) => void>();
  ownerDocument = { createElement: () => new Span() };
  box = { left: 10, top: 20, width: 120, height: 44 };
  getBoundingClientRect() { return this.box; }
  appendChild(c: Span) { c.parent = this; this.children.push(c); return c; }
  addEventListener(t: string, f: (e: unknown) => void) { this.listeners.set(t, f); }
  removeEventListener(t: string, f: (e: unknown) => void) { if (this.listeners.get(t) === f) this.listeners.delete(t); }
  fire(t: string, e: object = {}) { this.listeners.get(t)?.(e); }
}
const setup = () => { const n = new Node(); const a = press(n as unknown as HTMLElement); return { n, a }; };
const touch = { pointerType: 'touch', clientX: 40, clientY: 30 };

describe('press', () => {
  beforeEach(() => { m.allowed = true; m.level = 'full'; });

  it('constants', () => {
    expect(PRESS_SCALE).toBe(0.92);
    expect(RIPPLE_MS).toBe(550);
  });

  it('marks the node; a mouse does nothing', () => {
    const { n } = setup();
    expect(n.classList.contains('ff-press')).toBe(true);
    n.fire('pointerdown', { ...touch, pointerType: 'mouse' });
    expect(n.classList.contains('pressed')).toBe(false);
    expect(n.children).toHaveLength(0);
  });

  it('a touch squeezes and leaves one ripple from the touch point', () => {
    const { n } = setup();
    n.fire('pointerdown', touch);
    expect(n.classList.contains('pressed')).toBe(true);
    expect(n.children).toHaveLength(1);
    const r = n.children[0]!, b = rippleBox(n.box, 40, 30);
    expect(r.className).toBe('ripple');
    expect(r.attrs['aria-hidden']).toBe('true');
    expect(r.style).toEqual({ width: `${b.size}px`, height: `${b.size}px`, left: `${b.left}px`, top: `${b.top}px` });
    expect(r.anim!.frames).toEqual([{ transform: 'scale(0)', opacity: 0.9 }, { transform: 'scale(1)', opacity: 0 }]);
    expect(r.anim!.opts).toMatchObject({ duration: 550, easing: 'cubic-bezier(.22,1,.36,1)' });
  });

  it('up, cancel and leave release it', () => {
    const { n } = setup();
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
      n.fire('pointerdown', { ...touch, pointerType: 'pen' });
      expect(n.classList.contains('pressed')).toBe(true);
      n.fire(t);
      expect(n.classList.contains('pressed')).toBe(false);
    }
  });

  it('the ripple is removed when it finishes (or is cancelled)', () => {
    const { n } = setup();
    n.fire('pointerdown', touch);
    n.fire('pointerdown', touch);
    expect(n.children).toHaveLength(2);
    n.children[0]!.anim!.onfinish!();
    expect(n.children).toHaveLength(1);
    n.children[0]!.anim!.oncancel!();
    expect(n.children).toHaveLength(0);
  });

  it('calm / reduced motion and a tripped frame guard: nothing', () => {
    const { n } = setup();
    m.allowed = false;
    n.fire('pointerdown', touch);
    m.allowed = true; m.level = 'reduced';
    n.fire('pointerdown', touch);
    expect(n.classList.contains('pressed')).toBe(false);
    expect(n.children).toHaveLength(0);
  });

  it('destroy removes the listeners and the classes', () => {
    const { n, a } = setup();
    n.fire('pointerdown', touch);
    a.destroy();
    expect(n.listeners.size).toBe(0);
    expect(n.classList.contains('ff-press')).toBe(false);
    expect(n.classList.contains('pressed')).toBe(false);
  });
});
