// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Glass motion helpers (glass spec §8): the curves as functions, the grow-from-the-button transition for menus and sheets,
 * the sliding pill's three parts, the count-up and the press ripple. Everything moves `transform` / `opacity` only.
 */
import { motionAllowed } from '#lib/preview';
import { motionLevel, watchFrames } from '#lib/tv/motion';

/** a CSS cubic-bezier as a function of time (Newton steps, bisection when they stall); f(0) = 0, f(1) = 1 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (x: number) => {
    let u = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(u) - x, d = dx(u);
      if (Math.abs(e) < 1e-6) return u;
      if (Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    let lo = 0, hi = 1;
    u = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : sy(solve(t)));
}

/** GLASS_SPRING, GLASS_IN and GLASS_OUT (`#lib/tv/motion`) as functions */
export const springEase = cubicBezier(0.34, 1.56, 0.64, 1);
export const inEase = cubicBezier(0.4, 0, 1, 1);
export const outEase = cubicBezier(0.22, 1, 0.36, 1);

/** 'still': calm mode or reduced motion (instant); 'reduced': the frame guard tripped (opacity only); 'full' */
export type FxMode = 'full' | 'reduced' | 'still';
/**
 * A full-motion glass transition is built (it starts now): the frame guard watches the next second, so the most expensive glass
 * moments (a sheet, a menu or a toast moving over blurred content) can trip it too (glass spec, Constraints).
 */
function watched(mode: FxMode): FxMode {
  if (mode === 'full') watchFrames();
  return mode;
}
export function fxMode(): FxMode {
  if (!motionAllowed()) return 'still';
  return motionLevel() === 'reduced' ? 'reduced' : 'full';
}

export const GROW_IN_MS = 220;
export const GROW_OUT_MS = 150;
export const REDUCED_MS = 160;

export type DOMRectLike = { left: number; top: number; width: number; height: number };
export type Shift = { x: number; y: number };

/** the pop-up entry curve: fast start, long soft landing, never above 1 */
export const emphOut: (t: number) => number = cubicBezier(0.05, 0.7, 0.1, 1);

const SHIFT_PX = 8;
/**
 * The popover's entry offset in px (at most 8 per axis): it slides toward its place from the trigger's side. A popover whose top
 * lies below the trigger's centre opens downward (y -8), one whose bottom lies above it opens upward (+8); side-opening ones
 * (vertically level with the trigger) get x instead.
 */
export function growShift(trigger: DOMRectLike, pop: DOMRectLike): Shift {
  const cy = trigger.top + trigger.height / 2;
  const cx = trigger.left + trigger.width / 2;
  if (pop.top >= cy) return { x: 0, y: -SHIFT_PX };
  if (pop.top + pop.height <= cy) return { x: 0, y: SHIFT_PX };
  return { x: pop.left >= cx ? -SHIFT_PX : SHIFT_PX, y: 0 };
}

const linear = (t: number) => t;
const px = (v: number) => Math.round(v * 10) / 10 + 0; // + 0: no "-0"

/**
 * Svelte transition: menus and sheets fade and slide 8 px from their button; text never scales. Full motion: emphOut (220 ms)
 * in, `inEase` (150 ms) out. Reduced set: a 160 ms crossfade. Calm / reduced motion: instant. The translate is a function of
 * t alone, so a reversal mid-flight continues from the current point without a jump.
 */
export function grow(_node: Element, p: { shift?: Shift; dir?: 'in' | 'out'; mode?: FxMode } = {}): { duration: number; delay: 0; easing: (t: number) => number; css: (t: number, u: number) => string } {
  const mode = watched(p.mode ?? fxMode());
  const sh = p.shift ?? { x: 0, y: -SHIFT_PX };
  if (mode === 'still') return { duration: 0, delay: 0, easing: linear, css: () => '' };
  if (mode === 'reduced') return { duration: REDUCED_MS, delay: 0, easing: linear, css: (t) => `opacity:${t}` };
  const out = p.dir === 'out';
  return {
    duration: out ? GROW_OUT_MS : GROW_IN_MS,
    delay: 0,
    easing: out ? inEase : emphOut,
    css: (t) => `transform:translate(${px(sh.x * (1 - t))}px,${px(sh.y * (1 - t))}px);opacity:${Math.min(1, Math.max(0, t))}`,
  };
}

const grown = new WeakMap<Element, Shift>();
/**
 * grow() out of a trigger (menus, §5): the shift comes from the trigger's centre against the popover's placed box, measured once
 * when the popover first opens and kept for its close and for a reopen mid-close.
 * The reversal itself comes from using it as a bidirectional transition (`growBoth` with Svelte's `transition:`).
 */
export function growFrom(node: Element, p: { trigger?: Element | null; dir?: 'in' | 'out'; mode?: FxMode } = {}): ReturnType<typeof grow> {
  let shift = grown.get(node);
  if (!shift && p.trigger) {
    shift = growShift(p.trigger.getBoundingClientRect(), node.getBoundingClientRect());
    grown.set(node, shift);
  }
  return grow(node, { shift, dir: p.dir, mode: p.mode });
}

export type Dir = 'in' | 'out';
type Cfg = ReturnType<typeof grow>;
/**
 * A bidirectional Svelte transition (`transition:`) built from one-way ones: Svelte calls the returned function once it knows
 * the direction, and a close mid-open (or a reopen mid-close) continues from the current point with the new direction's
 * duration and curve, so nothing jumps (glass spec §8.3).
 */
export function twoWay(make: (dir: Dir) => Cfg): (o?: { direction?: 'in' | 'out' | 'both' }) => Cfg {
  return (o) => make(o?.direction === 'out' ? 'out' : 'in');
}
/** growFrom as a bidirectional transition: `transition:growBoth={{ trigger }}` */
export function growBoth(node: Element, p: { trigger?: Element | null; mode?: FxMode } = {}): (o?: { direction?: 'in' | 'out' | 'both' }) => Cfg {
  return twoWay((dir) => growFrom(node, { ...p, dir }));
}

export const SHEET_IN_MS = 320;
export const SHEET_OUT_MS = 200;
/**
 * Svelte transition: a phone bottom sheet slides up from below the window (translateY 100 % → 0, 320 ms emphOut) and back down
 * (200 ms GLASS_IN); `side: 'right'` slides in from the right edge instead (translateX), for the desktop role sheet. Reduced set: a 160 ms crossfade. Calm / reduced motion: instant.
 */
export function sheetSlide(_node: Element, p: { dir?: 'in' | 'out'; mode?: FxMode; side?: 'bottom' | 'right' } = {}): { duration: number; delay: 0; easing: (t: number) => number; css: (t: number, u: number) => string } {
  const mode = watched(p.mode ?? fxMode());
  if (mode === 'still') return { duration: 0, delay: 0, easing: linear, css: () => '' };
  if (mode === 'reduced') return { duration: REDUCED_MS, delay: 0, easing: linear, css: (t) => `opacity:${t}` };
  const out = p.dir === 'out';
  return { duration: out ? SHEET_OUT_MS : SHEET_IN_MS, delay: 0, easing: out ? inEase : emphOut, css: (_t, u) => `transform:translate${p.side === 'right' ? 'X' : 'Y'}(${Math.round(u * 1000) / 10}%)` };
}

export const TOAST_IN_MS = 300;
export const TOAST_OUT_MS = 200;
/**
 * Svelte transition: a toast rises in (translateY 140 % → 0 and opacity, 300 ms emphOut) and slides out (200 ms inEase), §8.5.
 * Reduced set: a 160 ms crossfade. Calm / reduced motion: instant.
 */
export function toastRise(_node: Element, p: { dir?: 'in' | 'out'; mode?: FxMode } = {}): { duration: number; delay: 0; easing: (t: number) => number; css: (t: number, u: number) => string } {
  const mode = watched(p.mode ?? fxMode());
  if (mode === 'still') return { duration: 0, delay: 0, easing: linear, css: () => '' };
  if (mode === 'reduced') return { duration: REDUCED_MS, delay: 0, easing: linear, css: (t) => `opacity:${t}` };
  const out = p.dir === 'out';
  return {
    duration: out ? TOAST_OUT_MS : TOAST_IN_MS,
    delay: 0,
    easing: out ? inEase : emphOut,
    css: (t, u) => `transform:translateY(${Math.round(u * 1400) / 10}%);opacity:${Math.min(1, Math.max(0, t))}`,
  };
}

export const BAR_IN_MS = 240;
export const BAR_OUT_MS = 180;
/**
 * Svelte transition: the cast bar rises 16 px while it fades in (240 ms, outEase) and goes back the same way (180 ms); only
 * transform and opacity (cast spec §2). Reduced set: a 160 ms crossfade. Calm / reduced motion: instant.
 */
export function barRise(_node: Element, p: { dir?: 'in' | 'out'; mode?: FxMode } = {}): { duration: number; delay: 0; easing: (t: number) => number; css: (t: number, u: number) => string } {
  const mode = watched(p.mode ?? fxMode());
  if (mode === 'still') return { duration: 0, delay: 0, easing: linear, css: () => '' };
  if (mode === 'reduced') return { duration: REDUCED_MS, delay: 0, easing: linear, css: (t) => `opacity:${t}` };
  const out = p.dir === 'out';
  return { duration: out ? BAR_OUT_MS : BAR_IN_MS, delay: 0, easing: out ? inEase : outEase, css: (t, u) => `transform:translateY(${Math.round(u * 160) / 10}px);opacity:${Math.min(1, Math.max(0, t))}` };
}

/** Svelte transition: a sheet's scrim fades (200 ms; the reduced set's 160 ms; instant when still) */
export function scrimFade(_node: Element, p: { mode?: FxMode } = {}): { duration: number; delay: 0; easing: (t: number) => number; css: (t: number) => string } {
  const mode = p.mode ?? fxMode();
  return { duration: mode === 'still' ? 0 : mode === 'reduced' ? REDUCED_MS : 200, delay: 0, easing: linear, css: (t) => `opacity:${t}` };
}

/** the sliding pill's middle part is this many px wide before scaling */
export const PILL_MID = 100;
/** the sliding pill's three transforms (left cap, scaled middle, right cap) for a target box; caps are `h` wide */
export function pillParts(t: { x: number; w: number }, h: number): { l: string; mid: string; r: string } {
  return {
    l: `translateX(${t.x}px)`,
    mid: `translateX(${t.x + h / 2}px) scaleX(${Math.max(0, t.w - h) / PILL_MID})`,
    r: `translateX(${t.x + t.w - h}px)`,
  };
}

/** the count-up's length (§8.8) */
export const COUNT_MS = 1100;
/** the counted value `ms` into the count-up (ease-out cubic) */
export function countAt(to: number, ms: number, dur = COUNT_MS): number {
  if (dur <= 0) return to;
  return Math.round(to * (1 - (1 - Math.min(1, Math.max(0, ms) / dur)) ** 3));
}

/** the press ripple's box (§8.9): twice the larger side, centred on the touch point */
export function rippleBox(r: DOMRectLike, x: number, y: number): { size: number; left: number; top: number } {
  const size = 2 * Math.max(r.width, r.height);
  return { size, left: x - r.left - size / 2, top: y - r.top - size / 2 };
}
