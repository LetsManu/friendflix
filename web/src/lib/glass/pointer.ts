// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pointer effects on glass (glass spec §8.1 light sheen, §8.7 poster tilt and glint). Both move `transform` / `opacity`
 * only and run only with full motion, a fine pointer, off TV and off kids profiles (`fxLive`).
 */
import { motionLevel, watchFrames } from '#lib/tv/motion';

/** the pointer-effect gate: full motion, not TV, not kids, a fine pointer */
export function fxPointer(o: { level: 'full' | 'reduced'; tv: boolean; kids: boolean; fine: boolean }): boolean {
  return o.level === 'full' && !o.tv && !o.kids && o.fine;
}

/** `fxPointer` for this page right now; false without a document */
export function fxLive(): boolean {
  if (typeof document === 'undefined') return false;
  const c = document.documentElement.classList;
  let fine = false;
  try { fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches; } catch { /* no media queries */ }
  return fxPointer({ level: motionLevel(), tv: c.contains('tv'), kids: c.contains('kids'), fine });
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** the sheen's transform for a pointer at (x, y) on a surface whose box starts at r */
export function sheenAt(r: { left: number; top: number }, x: number, y: number): string {
  return `translate3d(${r1(x - r.left)}px, ${r1(y - r.top)}px, 0)`;
}

/** Svelte action: a light sheen that follows the pointer inside the surface (the host clips it, e.g. `overflow: hidden`) */
export function sheen(node: HTMLElement): { destroy(): void } {
  const s = document.createElement('span');
  s.className = 'frost-sheen';
  s.setAttribute('aria-hidden', 'true');
  node.appendChild(s);
  let raf = 0, x = 0, y = 0;
  const paint = () => {
    raf = 0;
    if (!fxLive()) { s.classList.remove('on'); return; } // calm mode / reduced motion / a tripped guard mid-hover: off at once
    s.style.transform = sheenAt(node.getBoundingClientRect(), x, y);
  };
  const enter = (e: PointerEvent) => {
    if (!fxLive()) return;
    x = e.clientX; y = e.clientY;
    paint();
    s.classList.add('on');
  };
  const move = (e: PointerEvent) => {
    if (!s.classList.contains('on')) return;
    if (!fxLive()) { s.classList.remove('on'); return; }
    x = e.clientX; y = e.clientY;
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const leave = () => s.classList.remove('on');
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', leave);
  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
      s.remove();
    },
  };
}

/** the tilt's largest angle (deg), the share of the distance eased per frame, and the summed difference that counts as settled */
export const TILT_MAX = 9;
export const TILT_EASE = 0.16;
export const TILT_REST = 0.01;

/** x = rotateY (deg), y = rotateX (deg), lift 0..1 */
export type TiltState = { x: number; y: number; lift: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** where the tilt heads for a pointer at (px, py): angles toward the pointer, and the glare's spot inside the card */
export function tiltTarget(r: { left: number; top: number; width: number; height: number }, px: number, py: number, max = TILT_MAX): { x: number; y: number; gx: number; gy: number } {
  const nx = clamp01((px - r.left) / r.width), ny = clamp01((py - r.top) / r.height);
  return { x: (nx - 0.5) * 2 * max, y: (0.5 - ny) * 2 * max, gx: nx * r.width, gy: ny * r.height };
}

/** one frame of easing toward `to`; done (and exactly `to`) once the summed difference is under `TILT_REST` */
export function tiltStep(cur: TiltState, to: TiltState, k = TILT_EASE): { next: TiltState; done: boolean } {
  const next = { x: cur.x + (to.x - cur.x) * k, y: cur.y + (to.y - cur.y) * k, lift: cur.lift + (to.lift - cur.lift) * k };
  const diff = Math.abs(to.x - next.x) + Math.abs(to.y - next.y) + Math.abs(to.lift - next.lift);
  return diff < TILT_REST ? { next: { ...to }, done: true } : { next, done: false };
}

/** the card's transform, the light band's shift and the shadow's offset / scale for a tilt state */
export function tiltStyles(s: TiltState, max = TILT_MAX): { card: string; band: string; shadowX: number; shadowScale: number } {
  return {
    card: `translate3d(0, ${r3(-6 * s.lift)}px, 0) rotateX(${r3(s.y)}deg) rotateY(${r3(s.x)}deg) scale(${r3(1 + 0.06 * s.lift)})`,
    band: `translateX(${r3((s.x / max) * 22)}%)`,
    shadowX: r3(-s.x * 1.2),
    shadowScale: r3(0.9 - 0.12 * s.lift),
  };
}

/**
 * Svelte action on a row card's wrapper: tilts the card toward the pointer, moves the glare, the light band and the shadow,
 * and marks the row (`.tilt-row`) so siblings step back. `o` names the child selectors. Without `fxLive()` nothing moves.
 */
export function tilt(node: HTMLElement, o: { card: string; glare: string; band: string; shadow: string; row?: string }): { destroy(): void } {
  const REST: TiltState = { x: 0, y: 0, lift: 0 };
  let cur: TiltState = { ...REST }, to: TiltState = { ...REST };
  let gx = 0, gy = 0, raf = 0, px = 0, py = 0, aimed = true, on = false;
  /** the parts and the row, looked up once per hover (on enter), not on every frame */
  let parts: Record<'card' | 'glare' | 'band' | 'shadow', HTMLElement | null> = { card: null, glare: null, band: null, shadow: null };
  let rowEl: HTMLElement | null = null;
  const paint = (s: TiltState) => {
    const st = tiltStyles(s);
    if (parts.card) parts.card.style.transform = st.card;
    if (parts.band) parts.band.style.transform = st.band;
    if (parts.shadow) parts.shadow.style.transform = `translateX(${st.shadowX}px) scale(${st.shadowScale})`;
    if (parts.glare) parts.glare.style.transform = `translate(${Math.round(gx)}px, ${Math.round(gy)}px)`;
  };
  const unmark = () => { node.classList.remove('tilt-on'); rowEl?.classList.remove('tilt-row'); };
  /** calm mode, reduced motion or a tripped guard mid-hover: everything back to rest at once, no loop, no guard pulses */
  const halt = () => {
    on = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    cur = { ...REST }; to = { ...REST };
    paint(cur);
    unmark();
  };
  const frame = () => {
    raf = 0;
    if (!fxLive()) return halt();
    if (!aimed) {
      // one layout read per frame, only after the pointer moved
      aimed = true;
      const t = tiltTarget(node.getBoundingClientRect(), px, py);
      to = { x: t.x, y: t.y, lift: 1 };
      gx = t.gx; gy = t.gy;
    }
    const { next, done } = tiltStep(cur, to);
    cur = next;
    paint(cur);
    watchFrames();
    if (!done) raf = requestAnimationFrame(frame);
  };
  const run = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const enter = (e: PointerEvent) => {
    if (!fxLive()) return;
    on = true;
    parts = { card: node.querySelector<HTMLElement>(o.card), glare: node.querySelector<HTMLElement>(o.glare), band: node.querySelector<HTMLElement>(o.band), shadow: node.querySelector<HTMLElement>(o.shadow) };
    rowEl = o.row ? node.closest<HTMLElement>(o.row) : null;
    node.classList.add('tilt-on');
    rowEl?.classList.add('tilt-row');
    px = e.clientX; py = e.clientY; aimed = false;
    run();
  };
  const move = (e: PointerEvent) => {
    if (!on) return;
    if (!fxLive()) return halt();
    px = e.clientX; py = e.clientY; aimed = false;
    run();
  };
  const leave = () => {
    if (!on) return;
    on = false;
    aimed = true;
    to = { ...REST };
    unmark();
    run();
  };
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', leave);
  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
      unmark();
    },
  };
}
