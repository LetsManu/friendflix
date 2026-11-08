// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dragClose, UP_DAMP } from './dragClose';

type Handler = (e: any) => void;

/** Minimal sheet element double: listeners, style, classList, scrollTop, pointer capture. */
function fakeNode() {
  const listeners = new Map<string, { fn: Handler; capture: boolean }[]>();
  const classes = new Set<string>();
  const node = {
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
    style: { transform: '' },
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    setPointerCapture: vi.fn(),
    addEventListener(type: string, fn: Handler, opt?: boolean | { capture?: boolean }) {
      const capture = typeof opt === 'boolean' ? opt : !!opt?.capture;
      listeners.set(type, [...(listeners.get(type) ?? []), { fn, capture }]);
    },
    removeEventListener(type: string, fn: Handler, opt?: boolean | { capture?: boolean }) {
      const capture = typeof opt === 'boolean' ? opt : !!opt?.capture;
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => !(l.fn === fn && l.capture === capture)));
    },
    fire(type: string, e: object = {}) {
      const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn(), ...e };
      for (const l of [...(listeners.get(type) ?? [])]) l.fn(ev);
      return ev;
    },
    count: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
    dragging: () => classes.has('dragging'),
  };
  return node;
}

const grab = { closest: (s: string) => (s === '.grab' ? {} : null) };
const body = { closest: () => null };
const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

describe('dragClose', () => {
  let node: ReturnType<typeof fakeNode>;
  let close: ReturnType<typeof vi.fn<() => void>>;
  let act: ReturnType<typeof dragClose>;
  beforeEach(() => {
    node = fakeNode();
    close = vi.fn<() => void>();
    act = dragClose(node as unknown as HTMLElement, { close });
  });
  afterEach(() => vi.useRealTimers());

  describe('mouse/pen on the grab handle', () => {
    it('drag past the threshold closes and the sheet leaves from the release point', async () => {
      node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 100, pointerId: 7 });
      expect(node.setPointerCapture).toHaveBeenCalledWith(7);
      expect(node.dragging()).toBe(true);
      node.fire('pointermove', { clientY: 250 });
      expect(node.style.transform).toBe('translateY(150px)');
      node.fire('pointerup');
      expect(close).toHaveBeenCalledOnce();
      expect(node.dragging()).toBe(false);
      // inline offset survives until the closer has rendered its leaving state
      expect(node.style.transform).toBe('translateY(150px)');
      await Promise.resolve();
      expect(node.style.transform).toBe('');
    });

    it('a short drag springs back without closing', () => {
      node.fire('pointerdown', { pointerType: 'pen', target: grab, clientY: 100, pointerId: 1 });
      node.fire('pointermove', { clientY: 150 });
      expect(node.style.transform).toBe('translateY(50px)');
      node.fire('pointerup');
      expect(close).not.toHaveBeenCalled();
      expect(node.style.transform).toBe('');
      expect(node.dragging()).toBe(false);
    });

    it('upward movement never lifts the sheet', () => {
      node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 100, pointerId: 1 });
      node.fire('pointermove', { clientY: 40 });
      expect(node.style.transform).toBe('');
      node.fire('pointerup');
      expect(close).not.toHaveBeenCalled();
    });

    it('pointercancel ends the drag like a release (short: snaps back)', () => {
      node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 0, pointerId: 1 });
      node.fire('pointermove', { clientY: 30 });
      node.fire('pointercancel');
      expect(close).not.toHaveBeenCalled();
      expect(node.style.transform).toBe('');
      expect(node.dragging()).toBe(false);
    });

    it('ignores pointers that did not start on the handle, and touch pointers', () => {
      node.fire('pointerdown', { pointerType: 'mouse', target: body, clientY: 0, pointerId: 1 });
      node.fire('pointerdown', { pointerType: 'mouse', target: null, clientY: 0, pointerId: 1 });
      node.fire('pointerdown', { pointerType: 'touch', target: grab, clientY: 0, pointerId: 1 });
      node.fire('pointermove', { clientY: 300 });
      node.fire('pointerup');
      expect(node.dragging()).toBe(false);
      expect(node.style.transform).toBe('');
      expect(close).not.toHaveBeenCalled();
    });

    it('a custom threshold and update() are honoured', () => {
      const close2 = vi.fn<() => void>();
      act.update({ close: close2, threshold: 20 });
      node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 0, pointerId: 1 });
      node.fire('pointermove', { clientY: 30 });
      node.fire('pointerup');
      expect(close2).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe('touch anywhere on the sheet', () => {
    it('a downward drag past the threshold follows the finger, closes and swallows the next click', () => {
      vi.useFakeTimers();
      node.fire('touchstart', touch(50, 100));
      const mv = node.fire('touchmove', touch(52, 260));
      expect(mv.preventDefault).toHaveBeenCalled();
      expect(node.dragging()).toBe(true);
      expect(node.style.transform).toBe('translateY(160px)');
      node.fire('touchend');
      expect(close).toHaveBeenCalledOnce();
      const click = node.fire('click');
      expect(click.preventDefault).toHaveBeenCalled();
      expect(click.stopPropagation).toHaveBeenCalled();
      // swallowed once only
      expect(node.fire('click').preventDefault).not.toHaveBeenCalled();
    });

    it('the click swallow expires after 400 ms', () => {
      vi.useFakeTimers();
      node.fire('touchstart', touch(0, 0));
      node.fire('touchmove', touch(0, 20));
      node.fire('touchend');
      vi.advanceTimersByTime(401);
      expect(node.fire('click').preventDefault).not.toHaveBeenCalled();
    });

    it('a short touch drag snaps back and does not close', () => {
      node.fire('touchstart', touch(0, 0));
      node.fire('touchmove', touch(0, 40));
      expect(node.style.transform).toBe('translateY(40px)');
      node.fire('touchend');
      expect(close).not.toHaveBeenCalled();
      expect(node.style.transform).toBe('');
    });

    it('touchcancel ends the drag too', () => {
      node.fire('touchstart', touch(0, 0));
      node.fire('touchmove', touch(0, 30));
      node.fire('touchcancel');
      expect(node.dragging()).toBe(false);
      expect(node.style.transform).toBe('');
    });

    it('a tiny movement (< 8 px) neither starts a drag nor blocks the tap', () => {
      node.fire('touchstart', touch(0, 0));
      const mv = node.fire('touchmove', touch(3, 5));
      expect(mv.preventDefault).not.toHaveBeenCalled();
      expect(node.dragging()).toBe(false);
      node.fire('touchend');
      expect(node.fire('click').preventDefault).not.toHaveBeenCalled();
    });

    it('upward and sideways moves are left to the browser scroll', () => {
      node.fire('touchstart', touch(100, 100));
      expect(node.fire('touchmove', touch(100, 60)).preventDefault).not.toHaveBeenCalled();
      // disarmed for the rest of this gesture, even if it later moves down
      expect(node.fire('touchmove', touch(100, 200)).preventDefault).not.toHaveBeenCalled();
      node.fire('touchend');
      node.fire('touchstart', touch(100, 100));
      expect(node.fire('touchmove', touch(160, 120)).preventDefault).not.toHaveBeenCalled();
      expect(node.dragging()).toBe(false);
      expect(node.style.transform).toBe('');
    });

    it('does not arm when the sheet is scrolled, or with several fingers', () => {
      node.scrollTop = 30;
      node.fire('touchstart', touch(0, 0));
      expect(node.fire('touchmove', touch(0, 100)).preventDefault).not.toHaveBeenCalled();
      node.scrollTop = 0;
      node.fire('touchstart', { touches: [{ clientX: 0, clientY: 0 }, { clientX: 5, clientY: 5 }] });
      expect(node.fire('touchmove', touch(0, 100)).preventDefault).not.toHaveBeenCalled();
      // a second finger joining mid-drag is ignored
      node.fire('touchstart', touch(0, 0));
      expect(node.fire('touchmove', { touches: [{ clientX: 0, clientY: 50 }, { clientX: 9, clientY: 9 }] }).preventDefault).not.toHaveBeenCalled();
      expect(node.dragging()).toBe(false);
    });

    it('touchend without a drag does not swallow clicks or close', () => {
      node.fire('touchstart', touch(0, 0));
      node.fire('touchend');
      expect(close).not.toHaveBeenCalled();
      expect(node.fire('click').preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('pulling up with `open`', () => {
    let open: ReturnType<typeof vi.fn<() => void>>;
    beforeEach(() => {
      open = vi.fn<() => void>();
      act.update({ close, open });
      Object.assign(node, { clientHeight: 400, scrollHeight: 400 });
    });

    it('the handle pulled up past the threshold opens and keeps its damped lift', () => {
      node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 300, pointerId: 1 });
      node.fire('pointermove', { clientY: 150 });
      expect(node.style.transform).toBe(`translateY(${-150 * UP_DAMP}px)`);
      node.fire('pointerup');
      expect(open).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(node.dragging()).toBe(false);
      expect(node.style.transform).toBe(`translateY(${-150 * UP_DAMP}px)`);
    });

    it('a short pull up springs back; down still closes', () => {
      node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 300, pointerId: 1 });
      node.fire('pointermove', { clientY: 250 });
      node.fire('pointerup');
      expect(open).not.toHaveBeenCalled();
      expect(node.style.transform).toBe('');
      node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 0, pointerId: 1 });
      node.fire('pointermove', { clientY: 120 });
      node.fire('pointerup');
      expect(close).toHaveBeenCalledOnce();
    });

    it('a finger pulls up only when the sheet has nothing more to scroll', () => {
      vi.useFakeTimers();
      node.fire('touchstart', touch(0, 300));
      const mv = node.fire('touchmove', touch(0, 150));
      expect(mv.preventDefault).toHaveBeenCalled();
      node.fire('touchend');
      expect(open).toHaveBeenCalledOnce();
      expect(node.fire('click').preventDefault).toHaveBeenCalled();

      node.scrollHeight = 900; // more content below: the browser scrolls
      node.fire('touchstart', touch(0, 300));
      expect(node.fire('touchmove', touch(0, 150)).preventDefault).not.toHaveBeenCalled();
      node.fire('touchend');
      expect(open).toHaveBeenCalledOnce();
    });

    it('scrolled down to the end, a downward swipe scrolls instead of dragging', () => {
      Object.assign(node, { scrollTop: 500, scrollHeight: 900 });
      node.fire('touchstart', touch(0, 100));
      expect(node.fire('touchmove', touch(0, 200)).preventDefault).not.toHaveBeenCalled();
      expect(node.dragging()).toBe(false);
    });
  });

  it('destroy() removes every listener, so later gestures do nothing', () => {
    expect(node.count()).toBe(9);
    act.destroy();
    expect(node.count()).toBe(0);
    node.fire('pointerdown', { pointerType: 'mouse', target: grab, clientY: 0, pointerId: 1 });
    node.fire('touchstart', touch(0, 0));
    node.fire('touchmove', touch(0, 200));
    node.fire('touchend');
    expect(node.dragging()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
