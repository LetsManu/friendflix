// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Svelte action for a phone bottom sheet: drag it down to close. A mouse/pen drags on its `.grab` handle, a finger
 * anywhere on the sheet while it is scrolled to the top. The sheet follows only through `transform`; while it follows,
 * the node carries `.dragging` (the sheet's CSS drops its transition then). Released past `threshold` px it closes,
 * otherwise the inline transform is cleared and the sheet's own transition springs it back; past it the sheet's exit
 * transition starts from the release point. A touch drag starts only after 8 px of mostly downward movement, so taps
 * and sideways moves still work; the click after a drag is swallowed.
 *
 * With `open`, the sheet can also be pulled up: it rises at a damped `UP_DAMP` of the finger's travel, and released more
 * than `threshold` px above the start it calls `open` (e.g. go to the full page) and keeps its lifted offset (the caller
 * unmounts it). A finger pulls up only while the sheet is scrolled to its end; the mouse/pen on `.grab` always can.
 */
export const UP_DAMP = 0.4;
export function dragClose(node: HTMLElement, opts: { close: () => void; open?: () => void; threshold?: number }) {
  let o = opts, y0 = 0, x0 = 0, dy = 0, mode: 'pointer' | 'touch' | null = null, armed = false, upArmed = false, swallow = false;
  let swallowT: ReturnType<typeof setTimeout> | undefined;

  const follow = (d: number) => {
    dy = o.open ? d : Math.max(0, d);
    const shown = dy < 0 ? dy * UP_DAMP : dy;
    node.style.transform = shown ? `translateY(${shown}px)` : '';
  };
  const begin = (m: 'pointer' | 'touch') => { mode = m; dy = 0; node.classList.add('dragging'); };
  function finish() {
    const limit = o.threshold ?? 90, far = dy > limit, up = !!o.open && dy < -limit;
    mode = null; node.classList.remove('dragging');
    if (up) { o.open!(); return; }
    if (!far) { follow(0); return; } // springs back through the sheet's own transition
    // closing: the sheet leaves from where the finger let go. The inline offset is dropped only after the closer's
    // leaving state has rendered (Svelte flushes in a microtask queued during close()), so the exit transition starts at
    // the release point instead of snapping back first; an instant closer has unmounted the node by then.
    o.close();
    queueMicrotask(() => { dy = 0; node.style.transform = ''; });
  }

  function pDown(e: PointerEvent) {
    if (e.pointerType === 'touch' || !(e.target as Element | null)?.closest?.('.grab')) return;
    y0 = e.clientY; begin('pointer');
    node.setPointerCapture?.(e.pointerId);
  }
  function pMove(e: PointerEvent) { if (mode === 'pointer') follow(e.clientY - y0); }
  function pUp() { if (mode === 'pointer') finish(); }

  function tStart(e: TouchEvent) {
    const one = e.touches.length === 1;
    armed = one && node.scrollTop <= 0;
    upArmed = one && !!o.open && node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
    if (!armed && !upArmed) return;
    x0 = e.touches[0]!.clientX; y0 = e.touches[0]!.clientY;
  }
  function tMove(e: TouchEvent) {
    if ((!armed && !upArmed) || e.touches.length !== 1) return;
    const dx = e.touches[0]!.clientX - x0, d = e.touches[0]!.clientY - y0;
    if (mode !== 'touch') {
      if (Math.abs(dx) < 8 && Math.abs(d) < 8) return;
      // the browser scrolls: sideways, upward without `open` (or with more to scroll), downward when scrolled
      if (Math.abs(dx) > Math.abs(d) || (d > 0 ? !armed : !upArmed)) { armed = upArmed = false; return; }
      begin('touch');
    }
    e.preventDefault(); // the sheet follows the finger instead of scrolling
    follow(d);
  }
  function tEnd() {
    armed = upArmed = false;
    if (mode !== 'touch') return;
    swallow = true; clearTimeout(swallowT); swallowT = setTimeout(() => (swallow = false), 400);
    finish();
  }
  function noClick(e: MouseEvent) { if (swallow) { e.preventDefault(); e.stopPropagation(); swallow = false; } }

  node.addEventListener('pointerdown', pDown);
  node.addEventListener('pointermove', pMove);
  node.addEventListener('pointerup', pUp);
  node.addEventListener('pointercancel', pUp);
  node.addEventListener('touchstart', tStart, { passive: true });
  node.addEventListener('touchmove', tMove, { passive: false });
  node.addEventListener('touchend', tEnd);
  node.addEventListener('touchcancel', tEnd);
  node.addEventListener('click', noClick, true);
  return {
    update(n: typeof opts) { o = n; },
    destroy() {
      clearTimeout(swallowT);
      node.removeEventListener('pointerdown', pDown);
      node.removeEventListener('pointermove', pMove);
      node.removeEventListener('pointerup', pUp);
      node.removeEventListener('pointercancel', pUp);
      node.removeEventListener('touchstart', tStart);
      node.removeEventListener('touchmove', tMove);
      node.removeEventListener('touchend', tEnd);
      node.removeEventListener('touchcancel', tEnd);
      node.removeEventListener('click', noClick, true);
    },
  };
}
