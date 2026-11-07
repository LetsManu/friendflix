// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TV motion system (spec 5.2): springs for row / page glides, staggered text, the frame-budget guard and the shared
 * View Transition names. Everything moves `transform` / `opacity` only. Glides are FLIP-style: the real scroll position
 * jumps to its final value at once (layout, scroll-based code and spatial navigation see the true geometry), and a
 * transform on the content plays the difference back to 0 with a spring. Where `Element.animate` exists the spring is
 * sampled into keyframes, so it runs on the compositor even while the main thread renders the focus tile.
 */
import { writable, type Readable } from 'svelte/store';
import { motionAllowed } from '#lib/preview';

/** shared View Transition names (card / tile artwork -> detail backdrop; the page content) */
export const VT_ART = 'ff-tv-art';
export const VT_MAIN = 'ff-main';
/** entering / leaving curves (the same values as the CSS tokens --tv-emph-out / --tv-emph-in) */
export const EMPH_OUT = 'cubic-bezier(.05,.7,.1,1)';
export const EMPH_IN = 'cubic-bezier(.3,0,.8,.15)';

/** spring stiffness / damping (per s²): damping ratio ~0.76, settles in ~300 ms with < 2 % overshoot */
export const SPRING_K = 760;
export const SPRING_C = 42;
/** a key pressed while a glide is still running (held arrow): stiffer, same damping ratio, so steps get shorter and never stack */
const FAST_K = SPRING_K * 2, FAST_C = SPRING_C * Math.SQRT2;
const FRAME = 16;

export type Spring = { x: number; v: number };
type Axis = 'x' | 'y';

/** one step of a damped spring towards `target` (semi-implicit Euler in sub-steps of at most 4 ms, so long frames stay stable) */
export function springStep(state: Spring, target: number, dtMs: number, k = SPRING_K, c = SPRING_C): Spring {
  let { x, v } = state;
  const n = Math.max(1, Math.ceil(dtMs / 4)), h = dtMs / n / 1000;
  for (let i = 0; i < n; i++) {
    v += (-k * (x - target) - c * v) * h;
    x += v * h;
  }
  return { x, v };
}

const settled = (s: Spring, target: number) => Math.abs(s.x - target) < 0.5 && Math.abs(s.v) < 20;

/** the spring from `from` to `target` sampled every 16 ms; the last sample is exactly the target at rest */
export function springSamples(from: Spring, target: number, k = SPRING_K, c = SPRING_C): Spring[] {
  const out: Spring[] = [];
  let s = from;
  for (let i = 0; i < 90 && !settled(s, target); i++) { out.push(s); s = springStep(s, target, FRAME, k, c); }
  out.push({ x: target, v: 0 });
  return out;
}

/** the scroll position that brings [elStart, elEnd] into the view (inside the scroll padding) with the least movement */
export function nearestScroll(o: { start: number; end: number; padStart: number; padEnd: number; scroll: number; max: number; elStart: number; elEnd: number }): number {
  const lo = o.start + o.padStart, hi = o.end - o.padEnd;
  let s = o.scroll;
  if (o.elEnd - o.elStart > hi - lo || o.elStart < lo) s += o.elStart - lo;
  else if (o.elEnd > hi) s += o.elEnd - hi;
  return Math.min(o.max, Math.max(0, s));
}

// ---- motion level + frame-budget guard ----
let guardOn = false, tripped = false, guardRaf = 0, watchUntil = 0, last = 0, slow = 0;
/** the TV budget: three consecutive frames over 32 ms (under ~30 fps) trip the guard */
export const TV_GUARD = { slowMs: 32, frames: 3 } as const;
/**
 * The desktop budget: a steady 30 fps (VMs, remote desktop, a throttled laptop) is fine; under 20 fps for a sustained stretch
 * (eight frames in a row, ~0.4 s) is not. A page transition's full-viewport snapshots render a few frames around 50 ms even on
 * a machine that otherwise holds 60 fps (software rendering); a handful of those must not cost the session its motion.
 */
export const DESK_GUARD = { slowMs: 50, frames: 8 } as const;
let budget: { slowMs: number; frames: number } = TV_GUARD;
const now = () => performance.now();
const trippedStore = writable(false);
/** true once the frame guard tripped this session (for markup that keys on motionLevel(), e.g. the desktop pill's blur) */
export const motionTripped: Readable<boolean> = { subscribe: trippedStore.subscribe };

/** 'reduced' with calm mode, prefers-reduced-motion, or once the frame guard tripped (no drift, no stagger, crossfades only) */
export function motionLevel(): 'full' | 'reduced' {
  return tripped || !motionAllowed() ? 'reduced' : 'full';
}

function guardFrame() {
  guardRaf = 0;
  if (!guardOn || tripped) return;
  const t = now(), d = t - last;
  last = t;
  // a hidden page or a huge gap (the TV slept, a tab switch) says nothing about the animation budget
  if (document.hidden || d > 1000) slow = 0;
  else if (d > budget.slowMs) slow++;
  else slow = 0;
  if (slow >= budget.frames) {
    tripped = true;
    document.documentElement.classList.add('tv-motion-reduced');
    trippedStore.set(true);
    return;
  }
  if (t < watchUntil) guardRaf = requestAnimationFrame(guardFrame);
}
/** something starts moving: watch the frame times for the next second (an idle TV runs no frame loop) */
function pulse() {
  if (!guardOn || tripped) return;
  watchUntil = now() + 1000;
  if (!guardRaf) { last = now(); slow = 0; guardRaf = requestAnimationFrame(guardFrame); }
}
/** a compositor animation the guard should watch starts elsewhere (a page / player view transition) */
export function watchFrames(): void { pulse(); }
/**
 * A view transition's animation starts now (its `ready`): the rendering it paused on purpose before (the update callback
 * waiting for the new page, the capture) is no slow frame. Frame times count from here, and the guard watches what follows.
 */
export function framesResume(): void { last = now(); slow = 0; pulse(); }
/**
 * A page change starts (desktop): until its transition animates, the main thread builds the new page; those long frames are
 * no animation running slowly, so the current watch window ends here (the transition's `framesResume` opens the next one).
 */
export function framesIdle(): void {
  watchUntil = 0; slow = 0;
  if (guardRaf) cancelAnimationFrame(guardRaf);
  guardRaf = 0;
}
/**
 * Starts the frame-budget guard (once, on TV boot / while the desktop layout is on): while things move it watches the rAF
 * deltas, and `frames` consecutive frames over `slowMs` (TV: 3 over 32 ms; desktop: DESK_GUARD) drop the session to the
 * reduced set (`html.tv-motion-reduced` in CSS). Returns a stop function.
 */
export function frameGuard(o: { slowMs: number; frames: number } = TV_GUARD): () => void {
  guardOn = true;
  budget = { slowMs: o.slowMs, frames: o.frames };
  pulse();
  return () => { guardOn = false; if (guardRaf) cancelAnimationFrame(guardRaf); guardRaf = 0; };
}
/** back to a fresh session (tests) */
export function resetMotion(): void {
  guardOn = false; tripped = false; slow = 0; budget = TV_GUARD; watchUntil = 0;
  trippedStore.set(false);
  if (guardRaf) cancelAnimationFrame(guardRaf);
  guardRaf = 0;
  if (typeof document !== 'undefined') document.documentElement?.classList.remove('tv-motion-reduced');
}

// ---- springs on an element's transform ----
type Run = { axis: Axis; samples: Spring[]; anim?: Animation; raf?: number; cur?: Spring };
const runs = new WeakMap<HTMLElement, Run>();
const rest = new WeakMap<HTMLElement, number>(); // a transform left in place by animateTo (target != 0)
const px = (n: number) => `${+n.toFixed(2)}px`;
const tf = (axis: Axis, x: number) => (axis === 'x' ? `translate3d(${px(x)}, 0px, 0px)` : `translate3d(0px, ${px(x)}, 0px)`);
const put = (el: HTMLElement, axis: Axis, x: number) => {
  el.style.transform = Math.abs(x) < 0.01 ? '' : tf(axis, x);
  if (Math.abs(x) < 0.01) rest.delete(el); else rest.set(el, x);
};

function sampleAt(samples: Spring[], ms: number): Spring {
  const f = Math.max(0, ms) / FRAME, i = Math.floor(f);
  if (i >= samples.length - 1) return samples[samples.length - 1]!;
  const a = samples[i]!, b = samples[i + 1]!, w = f - i;
  return { x: a.x + (b.x - a.x) * w, v: a.v + (b.v - a.v) * w };
}

/** stops whatever spring runs on `el` and returns where it visibly was (and how fast); the inline transform is cleared */
export function halt(el: HTMLElement): Spring & { active: boolean } {
  const r = runs.get(el);
  let s: Spring = { x: rest.get(el) ?? 0, v: 0 };
  if (r) {
    if (r.anim) { s = sampleAt(r.samples, Number(r.anim.currentTime ?? 0)); r.anim.onfinish = null; r.anim.cancel(); }
    else if (r.cur) s = r.cur;
    if (r.raf) cancelAnimationFrame(r.raf);
    runs.delete(el);
  }
  el.style.transform = '';
  rest.delete(el);
  return { ...s, active: !!r };
}

function start(el: HTMLElement, axis: Axis, from: Spring, target: number, fast: boolean): () => void {
  const samples = springSamples(from, target, fast ? FAST_K : SPRING_K, fast ? FAST_C : SPRING_C);
  if (samples.length === 1) { put(el, axis, target); return () => {}; }
  pulse();
  const r: Run = { axis, samples };
  runs.set(el, r);
  if (typeof el.animate === 'function') {
    put(el, axis, target); // the resting value lives in the style; the animation plays over it and is dropped at the end
    const anim = el.animate(samples.map((s) => ({ transform: tf(axis, s.x) })), { duration: (samples.length - 1) * FRAME, easing: 'linear' });
    r.anim = anim;
    anim.onfinish = () => { if (runs.get(el) === r) runs.delete(el); anim.cancel(); };
    return () => { if (runs.get(el) !== r) return; const s = halt(el); put(el, axis, s.x); };
  }
  // no Web Animations: a rAF loop on the main thread
  let cur = from, t0 = now();
  r.cur = cur;
  el.style.willChange = 'transform';
  put(el, axis, from.x);
  const frame = () => {
    const t = now();
    cur = springStep(cur, target, Math.min(64, t - t0), fast ? FAST_K : SPRING_K, fast ? FAST_C : SPRING_C);
    t0 = t;
    r.cur = cur;
    if (settled(cur, target)) { runs.delete(el); el.style.willChange = ''; put(el, axis, target); return; }
    el.style.transform = tf(axis, cur.x);
    r.raf = requestAnimationFrame(frame);
  };
  r.raf = requestAnimationFrame(frame);
  return () => { if (runs.get(el) !== r) return; if (r.raf) cancelAnimationFrame(r.raf); runs.delete(el); el.style.willChange = ''; };
}

/**
 * Springs `el`'s transform (translate on `axis`) to `target` px. A call while one is running retargets from the current
 * position and velocity, so there is never a jump; reduced motion jumps straight to the end. Returns a cancel function.
 */
export function animateTo(el: HTMLElement, axis: Axis, target: number): () => void {
  const from = halt(el);
  if (motionLevel() === 'reduced') { put(el, axis, target); return () => {}; }
  return start(el, axis, from, target, false);
}

/**
 * Puts `el` at `target` at once (whatever spring ran on it stops), remembered like an `animateTo` end value so a later
 * `animateTo` springs on from here. Nothing moves, so the frame guard does not watch (a first placement, a layout fix-up).
 */
export function placeAt(el: HTMLElement, axis: Axis, target: number): void {
  halt(el);
  put(el, axis, target);
}

/**
 * FLIP glide: `jump` changes a scroll position at once and returns by how much (after - before). The content `el` keeps
 * its place on screen through a transform of the same size, which then springs back to 0. While `jump` runs the
 * transform is off, so it measures the true layout. A glide during a glide continues from what is on screen, stiffer.
 */
export function glide(el: HTMLElement, axis: Axis, jump: () => number): void {
  const was = halt(el);
  const d = jump();
  if (motionLevel() === 'reduced') return;
  const x = was.x + d;
  if (Math.abs(x) < 0.5 && Math.abs(was.v) < 20) return;
  start(el, axis, { x, v: was.v }, 0, was.active);
}

/**
 * TV rows: brings `el` into its row's view (nearest, inside the track's scroll padding: the same resting place as
 * `scrollIntoView({ inline: 'nearest' })`) and glides the row's strip there. False when `el` is not in a glide row or the
 * browser cannot animate (the caller falls back to native scrolling).
 */
export function glideRow(el: HTMLElement): boolean {
  const strip = el.closest<HTMLElement>('[data-glide]'), track = strip?.parentElement;
  if (!strip || !track || typeof strip.animate !== 'function') return false;
  let item: HTMLElement = el;
  while (item.parentElement && item.parentElement !== strip) item = item.parentElement;
  glide(strip, 'x', () => {
    const before = track.scrollLeft, tr = track.getBoundingClientRect(), r = item.getBoundingClientRect(), cs = getComputedStyle(track);
    const want = nearestScroll({ start: tr.left, end: tr.left + track.clientWidth, padStart: parseFloat(cs.scrollPaddingLeft) || 0, padEnd: parseFloat(cs.scrollPaddingRight) || 0, scroll: before, max: track.scrollWidth - track.clientWidth, elStart: r.left, elEnd: r.right });
    if (Math.abs(want - before) >= 1) track.scrollLeft = want;
    return track.scrollLeft - before;
  });
  return true;
}

/**
 * Staggered entry (focus tile text): each part fades in and rises 8 px, 40 ms apart, `--tv-emph-out`, 280 ms each.
 * The reduced set (frame guard) gets one plain 200 ms crossfade; calm mode / reduced motion: nothing moves.
 */
export function stagger(parts: HTMLElement[], o: { delay?: number; gap?: number } = {}): void {
  if (!motionAllowed()) return;
  const base = o.delay ?? 0, gap = o.gap ?? 40;
  if (parts.length) pulse();
  parts.forEach((p, i) => {
    if (typeof p.animate !== 'function') return;
    if (tripped) p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 0, easing: 'ease-out', fill: 'backwards' });
    else p.animate([{ opacity: 0, transform: 'translate3d(0, 8px, 0)' }, { opacity: 1, transform: 'translate3d(0, 0, 0)' }], { duration: 280, delay: base + i * gap, easing: EMPH_OUT, fill: 'backwards' });
  });
}

/**
 * Svelte action (TV): an image that is still loading fades in over 200 ms once it is decoded (`img.decode()`) instead of
 * popping in; one that is already there shows at once. Off TV it does nothing.
 */
export function decodeFade(img: HTMLImageElement): { destroy?: () => void } {
  if (!document.documentElement.classList.contains('tv') || (img.complete && img.naturalWidth > 0)) return {};
  const show = () => img.classList.add('in');
  const go = () => { if (typeof img.decode === 'function') img.decode().then(show, show); else show(); };
  img.classList.add('fade');
  img.addEventListener('load', go, { once: true });
  img.addEventListener('error', show, { once: true });
  return { destroy() { img.removeEventListener('load', go); img.removeEventListener('error', show); } };
}

export type TvPagePlan = { kind: 'none' | 'fade' | 'view'; slide: -1 | 0 | 1; morph: 'in' | 'back' | null; sub: -1 | 0 | 1 };
/** a detail page (`/item/<id>`), not one of its sub-screens */
const isDetail = (p: string) => /^\/item\/[^/]+\/?$/.test(p);
/** the detail page a sub-screen (`/item/<id>/<screen>`) belongs to, '' for any other path */
export const subParent = (p: string): string => /^(\/item\/[^/]+)\/[^/]+\/?$/.exec(p)?.[1] ?? '';
/**
 * How a TV page change animates (spec 5.2). `rail` = the pages' places in the rail (-1: not a rail page).
 * none: calm / reduced motion (instant swap). fade: no View Transitions API (the new page fades in, 200 ms).
 * view: a same-document View Transition; into a detail page the focused artwork morphs into the backdrop (`in`), Back from
 * it morphs back (`back`); between rail pages the content slides 16 px in the direction of travel; a detail page's
 * sub-screen slides in from the right (`sub` 1, 24 px) and leaves the same way back (`sub` -1). The reduced set (frame
 * guard) keeps only the crossfade.
 */
export function tvPagePlan(o: { from: string; to: string; back: boolean; motion: boolean; level: 'full' | 'reduced'; hasApi: boolean; rail: [number, number] }): TvPagePlan {
  const none: TvPagePlan = { kind: 'none', slide: 0, morph: null, sub: 0 };
  if (!o.motion || o.from === o.to) return none;
  if (!o.hasApi) return { ...none, kind: 'fade' };
  if (o.level === 'reduced') return { ...none, kind: 'view' };
  // detail page <-> one of its own sub-screens: a layer slides over it (no morph: the backdrop stays where it is)
  const sub = subParent(o.to) && subParent(o.to) === o.from.replace(/\/$/, '') ? 1 : subParent(o.from) && subParent(o.from) === o.to.replace(/\/$/, '') ? -1 : 0;
  if (sub) return { ...none, kind: 'view', sub };
  const [a, b] = o.rail;
  const slide = a >= 0 && b >= 0 && a !== b ? (b > a ? 1 : -1) : 0;
  const morph = isDetail(o.to) && !isDetail(o.from) ? 'in' : isDetail(o.from) && !isDetail(o.to) && o.back ? 'back' : null;
  return { kind: 'view', slide, morph, sub: 0 };
}

export type DeskPagePlan = { kind: 'none' | 'fade' | 'view'; morph: 'in' | 'back' | null };
/** a detail page path (`/item/<id>`), not one of the TV sub-screens below it */
export const isDetailPage = (p: string): boolean => isDetail(p);
/**
 * How a desktop page change animates (spec desktop browse §3, the TV's pattern without rails and sub-screens).
 * none: calm / reduced motion, or the same page (instant swap). fade: no View Transitions API or the reduced set (a plain
 * crossfade, no morph). view: into a detail page (also detail -> detail from "More like this") the clicked artwork morphs
 * into the backdrop (`in`); browser Back / "‹ Back" out of a detail page morphs the backdrop back into the card (`back`).
 * A link out of a detail page (a deep link's "‹ Back" goes home) has no card to return to: no morph.
 */
export function deskPagePlan(o: { from: string; to: string; back: boolean; motion: boolean; level: 'full' | 'reduced'; hasApi: boolean }): DeskPagePlan {
  if (!o.motion || o.from === o.to) return { kind: 'none', morph: null };
  if (!o.hasApi || o.level === 'reduced') return { kind: 'fade', morph: null };
  const morph = o.back && isDetail(o.from) ? 'back' : isDetail(o.to) ? 'in' : null;
  return { kind: 'view', morph };
}
