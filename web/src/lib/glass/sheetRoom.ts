// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The room an open sheet keeps free for the toasts, like the save bar's `--savebar-h`: a bottom sheet sets `--sheet-h` (its height)
 * and a right-hand sheet narrower than the window sets `--sheet-w` (its width) on <html> while it is mounted. ToastHost lifts the
 * toasts above a bottom sheet and moves them left of a right-hand one, by a transform that glides (calm mode: at once), so a toast
 * never covers a sheet's footer buttons. A full-width right-hand sheet (phones) has no room beside it: it pads its own end instead.
 * The room goes when the sheet starts to close (its outro), so the toasts glide back while it slides out. Several open sheets: the
 * largest room counts.
 *   <div class="sheet" use:sheetRoom> … / <div class="sheet" use:sheetRoom={'right'}>
 */

const rooms = new Map<object, { h: number; w: number }>();

function apply(): void {
  if (typeof document === 'undefined') return;
  let h = 0, w = 0;
  for (const r of rooms.values()) { h = Math.max(h, r.h); w = Math.max(w, r.w); }
  const st = document.documentElement.style;
  if (h > 0) st.setProperty('--sheet-h', `${h}px`); else st.removeProperty('--sheet-h');
  if (w > 0) st.setProperty('--sheet-w', `${w}px`); else st.removeProperty('--sheet-w');
}

/** the room of one sheet: its layout height (bottom) or width (right, 0 when it fills the window); transforms do not count */
export function roomOf(side: 'bottom' | 'right', box: { width: number; height: number }, viewportWidth: number): { h: number; w: number } {
  if (side === 'bottom') return { h: Math.ceil(box.height), w: 0 };
  return { h: 0, w: box.width >= viewportWidth - 1 ? 0 : Math.ceil(box.width) };
}

export function sheetRoom(node: HTMLElement, side: 'bottom' | 'right' = 'bottom'): { destroy(): void } {
  const key = {};
  let closing = false;
  const measure = () => {
    if (closing) return;
    rooms.set(key, roomOf(side, { width: node.offsetWidth, height: node.offsetHeight }, window.innerWidth));
    apply();
  };
  const release = () => { rooms.delete(key); apply(); };
  // Svelte's transition events on the sheet: it closes (the room goes now), or an interrupted close opens it again
  const onOut = () => { closing = true; release(); };
  const onIn = () => { closing = false; measure(); };
  measure();
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  ro?.observe(node);
  window.addEventListener('resize', measure);
  node.addEventListener('outrostart', onOut);
  node.addEventListener('introstart', onIn);
  return {
    destroy() {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      node.removeEventListener('outrostart', onOut);
      node.removeEventListener('introstart', onIn);
      release();
    },
  };
}
