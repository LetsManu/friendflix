// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from '#lib/stores';
import { get } from 'svelte/store';
import { animateTo, decodeFade, frameGuard, glide, glideRow, halt, tvPagePlan, motionLevel, nearestScroll, resetMotion, SPRING_C, SPRING_K, springSamples, springStep, stagger } from './motion';

/** simulates the spring at 16 ms frames; returns the positions */
function run(from: { x: number; v: number }, target: number, ms: number, k?: number, c?: number) {
  let s = from;
  const xs: number[] = [];
  for (let t = 16; t <= ms; t += 16) { s = springStep(s, target, 16, k, c); xs.push(s.x); }
  return { s, xs };
}

describe('springStep', () => {
  it('defaults are a stiff, slightly underdamped spring', () => {
    const zeta = SPRING_C / (2 * Math.sqrt(SPRING_K));
    expect(zeta).toBeGreaterThan(0.7);
    expect(zeta).toBeLessThan(1);
  });
  for (const d of [80, 300, 1000]) {
    it(`reaches the target within 1 px after 320 ms (${d} px)`, () => {
      const { s } = run({ x: 0, v: 0 }, d, 320);
      expect(Math.abs(s.x - d)).toBeLessThan(1);
    });
    it(`overshoots by at most 3 % (${d} px)`, () => {
      const { xs } = run({ x: 0, v: 0 }, d, 1200);
      expect(Math.max(...xs)).toBeLessThanOrEqual(d * 1.03);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    });
  }
  it('works in both directions', () => {
    const { s } = run({ x: 500, v: 0 }, 0, 320);
    expect(Math.abs(s.x)).toBeLessThan(1);
  });
  it('a retarget mid-flight continues from the current position and velocity (no jump)', () => {
    let s = { x: 0, v: 0 };
    for (let t = 0; t < 96; t += 16) s = springStep(s, 300, 16);
    expect(s.v).toBeGreaterThan(0);
    const before = s;
    const next = springStep(before, 600, 16);
    // one frame later the position moved on by about v * dt, not jumped to the new target
    expect(Math.abs(next.x - (before.x + before.v * 0.016))).toBeLessThan(30);
    expect(next.v).toBeGreaterThan(before.v); // pulled further
    const { s: end } = run(next, 600, 400);
    expect(Math.abs(end.x - 600)).toBeLessThan(1);
  });
  it('a retarget backwards keeps the momentum for a moment, then turns', () => {
    let s = { x: 0, v: 0 };
    for (let t = 0; t < 64; t += 16) s = springStep(s, 300, 16);
    const x0 = s.x;
    s = springStep(s, 0, 16);
    expect(s.x).toBeGreaterThan(x0); // still moving forward this frame
    const { s: end } = run(s, 0, 500);
    expect(Math.abs(end.x)).toBeLessThan(1);
  });
  it('a stiffer spring (held key) settles faster', () => {
    const slow = run({ x: 0, v: 0 }, 300, 160).s, fast = run({ x: 0, v: 0 }, 300, 160, SPRING_K * 2, SPRING_C * Math.SQRT2).s;
    expect(Math.abs(fast.x - 300)).toBeLessThan(Math.abs(slow.x - 300));
  });
  it('is stable for big frame gaps (sub-steps)', () => {
    const s = springStep({ x: 0, v: 0 }, 100, 200);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(110);
  });
  it('springSamples ends exactly on the target', () => {
    const p = springSamples({ x: 0, v: 0 }, 200);
    expect(p.length).toBeGreaterThan(5);
    expect(p[p.length - 1]).toEqual({ x: 200, v: 0 });
    expect(p.length * 16).toBeLessThan(700);
    expect(springSamples({ x: 5, v: 0 }, 5)).toEqual([{ x: 5, v: 0 }]);
  });
});

describe('nearestScroll', () => {
  // view: the track box 0..1000 with scroll padding 50 left, 100 right; content 3000 wide
  const view = { start: 0, end: 1000, padStart: 50, padEnd: 100, scroll: 500, max: 2000 };
  it('leaves an element that is in view alone', () => expect(nearestScroll({ ...view, elStart: 100, elEnd: 400 })).toBe(500));
  it('brings an element on the right in just far enough', () => expect(nearestScroll({ ...view, elStart: 800, elEnd: 1100 })).toBe(700));
  it('brings an element on the left in just far enough', () => expect(nearestScroll({ ...view, elStart: -200, elEnd: 100 })).toBe(250));
  it('clamps to the scroll range', () => {
    expect(nearestScroll({ ...view, scroll: 100, elStart: -400, elEnd: -100 })).toBe(0);
    expect(nearestScroll({ ...view, scroll: 1900, elStart: 1200, elEnd: 1500 })).toBe(2000);
  });
  it('an element wider than the view aligns its start', () => expect(nearestScroll({ ...view, elStart: 900, elEnd: 2000 })).toBe(1350));
});

// ---- DOM-ish doubles: rAF clock, matchMedia, elements with style + optional Element.animate ----
let now = 0;
let frames: Array<(t: number) => void> = [];
let mql = false;
function tick(ms = 16) { now += ms; const f = frames; frames = []; for (const cb of f) cb(now); }
function settle(maxFrames = 200) { for (let i = 0; i < maxFrames && frames.length; i++) tick(); }
type FakeAnim = { currentTime: number | null; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; keyframes: Keyframe[]; opts: KeyframeAnimationOptions };
function el(withAnimate = false) {
  const anims: FakeAnim[] = [];
  const classes = new Set<string>();
  const e = {
    style: { transform: '', willChange: '' } as Record<string, string>,
    anims,
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c), toggle: (c: string, on?: boolean) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    animate: withAnimate ? vi.fn((keyframes: Keyframe[], opts: KeyframeAnimationOptions) => { const a: FakeAnim = { currentTime: 0, cancel: vi.fn(), onfinish: null, keyframes, opts }; anims.push(a); return a; }) : undefined,
  };
  return e as unknown as HTMLElement & { anims: FakeAnim[]; style: Record<string, string> };
}
const html = el();

beforeEach(() => {
  now = 0; frames = []; mql = false;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => {}; });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') ? mql : false }));
  vi.stubGlobal('document', { documentElement: html, hidden: false, getElementById: () => ({}) });
  prefs.update((p) => ({ ...p, calm: false }));
  resetMotion();
});
afterEach(() => { vi.unstubAllGlobals(); resetMotion(); });

const tx = (s: string) => { const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(s); return m ? Number(m[1]) || Number(m[2]) : 0; };

describe('motionLevel', () => {
  it('full by default', () => expect(motionLevel()).toBe('full'));
  it('reduced in calm mode', () => {
    prefs.update((p) => ({ ...p, calm: true }));
    expect(get(prefs).calm).toBe(true);
    expect(motionLevel()).toBe('reduced');
  });
  it('reduced with prefers-reduced-motion', () => { mql = true; expect(motionLevel()).toBe('reduced'); });
  it('reduced after the frame guard tripped (three consecutive frames over 32 ms), and it says so on <html>', () => {
    const stop = frameGuard();
    tick(16); tick(40); tick(40); tick(16); // two slow frames, then a good one: not yet
    expect(motionLevel()).toBe('full');
    tick(40); tick(40); tick(40);
    expect(motionLevel()).toBe('reduced');
    expect(html.classList.contains('tv-motion-reduced')).toBe(true);
    expect(frames.length).toBe(0); // the guard stops watching once tripped
    stop();
  });
  it('the guard ignores a hidden page and huge gaps (the TV slept), and can be stopped', () => {
    const stop = frameGuard();
    tick(16); tick(5000); tick(40); tick(40); tick(16);
    expect(motionLevel()).toBe('full');
    (document as unknown as { hidden: boolean }).hidden = true;
    tick(40); tick(40); tick(40);
    expect(motionLevel()).toBe('full');
    (document as unknown as { hidden: boolean }).hidden = false;
    stop();
    tick(40); tick(40); tick(40); tick(40);
    expect(motionLevel()).toBe('full');
  });
  it('the guard only watches while something moves (idle TV: no frame loop)', () => {
    const stop = frameGuard();
    for (let i = 0; i < 100; i++) tick(16);
    expect(frames.length).toBe(0); // the first watch window has run out
    animateTo(el(), 'x', 100); // motion re-arms it
    tick(40); tick(40); tick(40);
    expect(motionLevel()).toBe('reduced');
    stop();
  });
});

describe('animateTo (rAF fallback, no Element.animate)', () => {
  it('springs the transform to the target and cleans up will-change', () => {
    const e = el();
    animateTo(e, 'x', 200);
    expect(e.style.willChange).toBe('transform');
    tick();
    const first = tx(e.style.transform);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(200);
    settle();
    expect(e.style.transform).toBe('translate3d(200px, 0px, 0px)');
    expect(e.style.willChange).toBe('');
  });
  it('a target of 0 ends with no transform at all', () => {
    const e = el();
    glide(e, 'y', () => 120);
    expect(e.style.transform).toBe('translate3d(0px, 120px, 0px)'); // the content stays where it was on screen
    settle();
    expect(e.style.transform).toBe('');
  });
  it('interrupting retargets from the current position (no jump)', () => {
    const e = el();
    animateTo(e, 'x', 300);
    tick(); tick(); tick();
    const mid = tx(e.style.transform);
    animateTo(e, 'x', 0);
    expect(tx(e.style.transform)).toBeCloseTo(mid, 5);
    tick();
    expect(Math.abs(tx(e.style.transform) - mid)).toBeLessThan(60);
    settle();
    expect(e.style.transform).toBe('');
  });
  it('cancel stops it where it is', () => {
    const e = el();
    const cancel = animateTo(e, 'x', 300);
    tick(); tick();
    cancel();
    const at = e.style.transform;
    tick(); tick();
    expect(e.style.transform).toBe(at);
    expect(frames.length).toBe(0);
  });
  it('reduced motion: jumps to the end at once', () => {
    mql = true;
    const e = el();
    animateTo(e, 'x', 50);
    expect(e.style.transform).toBe('translate3d(50px, 0px, 0px)');
    const g = el();
    glide(g, 'x', () => 80);
    expect(g.style.transform).toBe('');
  });
});

describe('animateTo / glide (Element.animate: runs on the compositor)', () => {
  it('plays the sampled spring as keyframes, then leaves the final transform in the style', () => {
    const e = el(true);
    animateTo(e, 'x', 100);
    expect(e.anims.length).toBe(1);
    const a = e.anims[0]!;
    expect(a.keyframes[0]!.transform).toBe('translate3d(0px, 0px, 0px)');
    expect(a.keyframes[a.keyframes.length - 1]!.transform).toBe('translate3d(100px, 0px, 0px)');
    expect(a.opts.easing).toBe('linear');
    expect(Number(a.opts.duration)).toBe((a.keyframes.length - 1) * 16);
    a.onfinish?.();
    expect(e.style.transform).toBe('translate3d(100px, 0px, 0px)');
    expect(a.cancel).toHaveBeenCalled();
  });
  it('glide: offset by the scroll jump, then back to 0 with no transform left', () => {
    const e = el(true);
    glide(e, 'y', () => -90);
    const a = e.anims[0]!;
    expect(a.keyframes[0]!.transform).toBe('translate3d(0px, -90px, 0px)');
    expect(a.keyframes[a.keyframes.length - 1]!.transform).toBe('translate3d(0px, 0px, 0px)');
    a.onfinish?.();
    expect(e.style.transform).toBe('');
  });
  it('glide with no scroll change and nothing in flight does nothing', () => {
    const e = el(true);
    glide(e, 'x', () => 0);
    expect(e.anims.length).toBe(0);
  });
  it('a second glide mid-flight starts from the visible offset and keeps the velocity (stiffer: a held key)', () => {
    const e = el(true);
    glide(e, 'x', () => 200);
    const a = e.anims[0]!;
    a.currentTime = 48; // three frames in
    const jumps: number[] = [];
    glide(e, 'x', () => { jumps.push(1); return 200; });
    expect(a.cancel).toHaveBeenCalled();
    const b = e.anims[1]!;
    const start = tx(String(b.keyframes[0]!.transform));
    const visible = springSamples({ x: 200, v: 0 }, 0)[3]!.x;
    expect(start).toBeCloseTo(visible + 200, 0);
    expect(jumps).toEqual([1]);
    // stiffer: fewer frames than a fresh glide of the same size would take
    expect(b.keyframes.length).toBeLessThan(springSamples({ x: start, v: 0 }, 0).length);
  });
  it('halt stops an animation and reports where it was', () => {
    const e = el(true);
    animateTo(e, 'x', 100);
    e.anims[0]!.currentTime = null; // not started yet
    expect(halt(e).x).toBe(0);
    expect(e.style.transform).toBe('');
    expect(halt(el()).x).toBe(0);
  });
});

describe('stagger', () => {
  it('fades the parts in one after the other (40 ms apart)', () => {
    const parts = [el(true), el(true), el(true)];
    stagger(parts, { delay: 80 });
    expect(parts.map((p) => p.anims[0]!.opts.delay)).toEqual([80, 120, 160]);
    expect(parts[0]!.anims[0]!.keyframes[0]).toEqual({ opacity: 0, transform: 'translate3d(0, 8px, 0)' });
    expect(parts[0]!.anims[0]!.opts.duration).toBe(280);
  });
  it('reduced set (frame guard): one plain crossfade, no slide', () => {
    const stop = frameGuard();
    tick(40); tick(40); tick(40);
    const parts = [el(true), el(true)];
    stagger(parts);
    expect(parts.map((p) => p.anims[0]!.opts.delay)).toEqual([0, 0]);
    expect(parts[0]!.anims[0]!.keyframes[0]).toEqual({ opacity: 0 });
    stop();
  });
  it('calm / reduced motion: nothing animates', () => {
    mql = true;
    const parts = [el(true)];
    stagger(parts);
    expect(parts[0]!.anims.length).toBe(0);
    stagger([el()]); // no Element.animate: nothing to do either
  });
});

describe('glideRow', () => {
  function row(scroll: number) {
    const track = { scrollLeft: scroll, clientWidth: 1000, scrollWidth: 3000, getBoundingClientRect: () => ({ left: 0 }) } as unknown as HTMLElement;
    const strip = Object.assign(el(true), { parentElement: track });
    const slot = { parentElement: strip, getBoundingClientRect: () => ({ left: 850 - (track.scrollLeft - scroll), right: 1150 - (track.scrollLeft - scroll) }) } as unknown as HTMLElement;
    const card = { parentElement: slot, closest: (s: string) => (s === '[data-glide]' ? strip : null) } as unknown as HTMLElement;
    return { track, strip, card };
  }
  beforeEach(() => vi.stubGlobal('getComputedStyle', () => ({ scrollPaddingLeft: '50px', scrollPaddingRight: '100px' })));
  it('scrolls the track to the nearest resting place and glides the strip from where it was', () => {
    const { track, strip, card } = row(500);
    expect(glideRow(card)).toBe(true);
    expect(track.scrollLeft).toBe(750); // the slot's right edge (1150) now sits at 1000 - 100 padding
    const kf = strip.anims[0]!.keyframes;
    expect(kf[0]!.transform).toBe('translate3d(250px, 0px, 0px)');
    expect(kf[kf.length - 1]!.transform).toBe('translate3d(0px, 0px, 0px)');
  });
  it('not a glide row, or no Element.animate: false (native scrolling stays)', () => {
    expect(glideRow({ closest: () => null } as unknown as HTMLElement)).toBe(false);
    const strip = Object.assign(el(false), { parentElement: {} });
    expect(glideRow({ closest: () => strip } as unknown as HTMLElement)).toBe(false);
  });
  it('the cancel of an Element.animate spring leaves it where it was', () => {
    const e = el(true);
    const cancel = animateTo(e, 'x', 100);
    e.anims[0]!.currentTime = 10_000;
    cancel();
    expect(e.style.transform).toBe('translate3d(100px, 0px, 0px)');
    cancel(); // twice: nothing
  });
});

describe('tvPagePlan', () => {
  const base = { from: '/', to: '/item/1', back: false, motion: true, level: 'full' as const, hasApi: true, rail: [0, -1] as [number, number] };
  it('card / tile -> detail: a view transition with the artwork morph', () => expect(tvPagePlan(base)).toEqual({ kind: 'view', slide: 0, morph: 'in' }));
  it('Back from the detail page morphs back; a forward move away from it only crossfades', () => {
    expect(tvPagePlan({ ...base, from: '/item/1', to: '/', back: true, rail: [-1, 0] }).morph).toBe('back');
    expect(tvPagePlan({ ...base, from: '/item/1', to: '/', back: false, rail: [-1, 0] }).morph).toBe(null);
    expect(tvPagePlan({ ...base, from: '/item/1', to: '/item/2' }).morph).toBe(null); // two backdrops would share the name
  });
  it('rail pages slide in the direction of travel', () => {
    expect(tvPagePlan({ ...base, to: '/movies', rail: [0, 2] })).toEqual({ kind: 'view', slide: 1, morph: null });
    expect(tvPagePlan({ ...base, from: '/movies', to: '/', rail: [2, 0] }).slide).toBe(-1);
  });
  it('no API: a plain fade; reduced set: crossfade only; calm / reduced motion or the same page: nothing', () => {
    expect(tvPagePlan({ ...base, hasApi: false }).kind).toBe('fade');
    expect(tvPagePlan({ ...base, level: 'reduced', rail: [0, 2] })).toEqual({ kind: 'view', slide: 0, morph: null });
    expect(tvPagePlan({ ...base, motion: false }).kind).toBe('none');
    expect(tvPagePlan({ ...base, to: '/' }).kind).toBe('none');
  });
});

describe('decodeFade', () => {
  function img(complete: boolean) {
    const on: Record<string, () => void> = {};
    const cls = new Set<string>();
    return { complete, naturalWidth: complete ? 10 : 0, cls, on, classList: { add: (c: string) => cls.add(c) }, addEventListener: (n: string, f: () => void) => { on[n] = f; }, removeEventListener: (n: string) => { delete on[n]; }, decode: () => Promise.resolve() };
  }
  it('off TV or already loaded: nothing', () => {
    const i = img(false);
    expect(decodeFade(i as unknown as HTMLImageElement)).toEqual({});
    html.classList.add('tv');
    const j = img(true);
    decodeFade(j as unknown as HTMLImageElement);
    expect(j.cls.size).toBe(0);
    html.classList.remove('tv');
  });
  it('TV: hidden until loaded and decoded, then faded in; an error shows it too', async () => {
    html.classList.add('tv');
    const i = img(false);
    const a = decodeFade(i as unknown as HTMLImageElement);
    expect([...i.cls]).toEqual(['fade']);
    i.on.load!();
    await Promise.resolve(); await Promise.resolve();
    expect(i.cls.has('in')).toBe(true);
    const j = img(false);
    decodeFade(j as unknown as HTMLImageElement);
    j.on.error!();
    expect(j.cls.has('in')).toBe(true);
    a.destroy!();
    expect(i.on.load).toBeUndefined();
    html.classList.remove('tv');
  });
});
