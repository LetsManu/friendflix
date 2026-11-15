// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phone press feedback (glass spec §8.9): a touch on a glass or white button or card dims it to `PRESS_OPACITY` (80 ms in,
 * 200 ms back, linear; the CSS is `.ff-press` / `.pressed` in app.css). Text is never scaled: only an icon-only control
 * (`.icon` / `.press-scale`, or no text and just an svg / `.icon`) squeezes to scale(.92). A ripple grows from
 * the touch point (scale 0 → 1, opacity .9 → 0, `RIPPLE_MS`, `GLASS_OUT`). Touch and pen only (never a mouse), and only with
 * full motion: calm mode, reduced motion and a tripped frame guard get nothing. Only `transform` and `opacity` move.
 */
import { GLASS_OUT } from '#lib/tv/motion';
import { fxMode, rippleBox } from './fx';

export const PRESS_OPACITY = 0.72;
const ICON_SCALE = 'scale(.92)';
export const RIPPLE_MS = 550;
const RIPPLE: Keyframe[] = [{ transform: 'scale(0)', opacity: 0.9 }, { transform: 'scale(1)', opacity: 0 }];

/** an icon-only control: marked, or no text at all and an svg / .icon inside */
function iconOnly(node: HTMLElement): boolean {
  if (node.classList.contains('icon') || node.classList.contains('press-scale')) return true;
  return !node.textContent?.trim() && !!node.querySelector?.('svg, .icon');
}

/** Svelte action: `<a use:press>`; the node is positioned and clips the ripple (`.ff-press`) */
export function press(node: HTMLElement): { destroy(): void } {
  node.classList.add('ff-press');
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' || fxMode() !== 'full') return;
    node.classList.add('pressed');
    if (iconOnly(node)) node.style.transform = ICON_SCALE;
    else node.style.opacity = String(PRESS_OPACITY);
    const b = rippleBox(node.getBoundingClientRect(), e.clientX, e.clientY);
    const rip = node.ownerDocument.createElement('span');
    rip.className = 'ripple';
    rip.setAttribute('aria-hidden', 'true');
    Object.assign(rip.style, { width: `${b.size}px`, height: `${b.size}px`, left: `${b.left}px`, top: `${b.top}px` });
    node.appendChild(rip);
    const a = rip.animate(RIPPLE, { duration: RIPPLE_MS, easing: GLASS_OUT, fill: 'forwards' });
    a.onfinish = a.oncancel = () => rip.remove();
  };
  const up = () => {
    node.classList.remove('pressed');
    node.style.transform = '';
    node.style.opacity = '';
  };
  node.addEventListener('pointerdown', down);
  for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) node.addEventListener(t, up);
  return {
    destroy() {
      node.removeEventListener('pointerdown', down);
      for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) node.removeEventListener(t, up);
      node.classList.remove('ff-press', 'pressed');
      node.style.transform = '';
      node.style.opacity = '';
    },
  };
}
