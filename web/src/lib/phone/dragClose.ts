// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Svelte action for a phone bottom sheet: drag it down to close. A mouse/pen drags on its `.grab` handle, a finger
 * anywhere on the sheet while it is scrolled to the top. The sheet follows only through `transform`; while it follows,
 * the node carries `.dragging` (the sheet's CSS drops its transition then). Released past `threshold` px it closes,
 * otherwise the inline transform is cleared and the sheet's own transition springs it back. A touch drag starts only
 * after 8 px of mostly downward movement, so taps and sideways moves still work; the click after a drag is swallowed.
 */
export function dragClose(node: HTMLElement, opts: { close: () => void; threshold?: number }) {
  let o = opts, y0 = 0, x0 = 0, dy = 0, mode: 'pointer' | 'touch' | null = null, armed = false, swallow = false;
  let swallowT: ReturnType<typeof setTimeout> | undefined;

  const follow = (d: number) => { dy = Math.max(0, d); node.style.transform = dy ? `translateY(${dy}px)` : ''; };
  const begin = (m: 'pointer' | 'touch') => { mode = m; dy = 0; node.classList.add('dragging'); };
  function finish() {
    const far = dy > (o.threshold ?? 90);
    mode = null; node.classList.remove('dragging'); follow(0);
    if (far) o.close();
  }

  function pDown(e: PointerEvent) {
    if (e.pointerType === 'touch' || !(e.target as Element | null)?.closest?.('.grab')) return;
    y0 = e.clientY; begin('pointer');
    node.setPointerCapture?.(e.pointerId);
  }
  function pMove(e: PointerEvent) { if (mode === 'pointer') follow(e.clientY - y0); }
  function pUp() { if (mode === 'pointer') finish(); }

  function tStart(e: TouchEvent) {
    armed = e.touches.length === 1 && node.scrollTop <= 0;
    if (!armed) return;
    x0 = e.touches[0]!.clientX; y0 = e.touches[0]!.clientY;
  }
  function tMove(e: TouchEvent) {
    if (!armed || e.touches.length !== 1) return;
    const dx = e.touches[0]!.clientX - x0, d = e.touches[0]!.clientY - y0;
    if (mode !== 'touch') {
      if (Math.abs(dx) < 8 && Math.abs(d) < 8) return;
      if (d <= 0 || Math.abs(dx) > d) { armed = false; return; } // upward or sideways: the browser scrolls
      begin('touch');
    }
    e.preventDefault(); // the sheet follows the finger instead of scrolling
    follow(d);
  }
  function tEnd() {
    armed = false;
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
