<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { playSonicLogo, stopSonicLogo } from '#lib/sonic';
  import { t } from '#lib/i18n';

  /** Play the sonic logo along with the animation (only sensible after a user gesture). */
  export let sound = false;
  /** Hard upper bound: the overlay is gone after this long even if no animationend ever fires. */
  const FALLBACK_MS = 4500;
  const FALLBACK_REDUCED_MS = 1300;

  const dispatch = createEventDispatcher<{ done: void }>();
  const uid = 'ffi' + Math.random().toString(36).slice(2, 7);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const letters = [...'FRIEND', ' ', ...'FLIX'];
  // light ribbons the F dissolves into during the dive: brand reds / pinks / ambers, fixed pseudo-random layout
  const RIBBON_COLORS = ['#ff2a3d', '#e50f2a', '#b8071a', '#ff5a36', '#ff8a3d', '#ff3d7f', '#d61f69', '#ffb347', '#8a0a1e'];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ribbons = Array.from({ length: 44 }, () => ({
    w: (0.8 + rnd() * 2.4).toFixed(2), c: RIBBON_COLORS[Math.floor(rnd() * RIBBON_COLORS.length)],
    d: (rnd() * 0.55).toFixed(2), o: rnd() < 0.5 ? 'top' : 'bottom', a: (0.55 + rnd() * 0.45).toFixed(2),
  }));

  let root: HTMLElement;
  let skipping = false, finished = false;
  let fallback: ReturnType<typeof setTimeout>, skipTimer: ReturnType<typeof setTimeout>;
  let returnFocus: HTMLElement | null = null;
  const born = Date.now();

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(fallback); clearTimeout(skipTimer);
    removeEventListener('keydown', onKey, true);
    removeEventListener('pointerdown', onPointer, true);
    const el = returnFocus;
    if (el && el.isConnected) { try { el.focus({ preventScroll: true }); } catch { /* element not focusable any more */ } }
    dispatch('done');
  }

  function skip() {
    if (skipping || finished) return;
    skipping = true;
    void stopSonicLogo(140);
    skipTimer = setTimeout(finish, 220); // the .skip fade is 150 ms; the timer covers a missing animationend
  }
  function onPointer(e: Event) {
    if (Date.now() - born < 150) return; // the click that opened the intro must not close it
    e.preventDefault(); e.stopPropagation();
    skip();
  }
  function onKey(e: KeyboardEvent) {
    // the intro owns the keyboard while it is up: nothing behind it may be activated or tabbed to
    if (e.key === 'Tab') { e.preventDefault(); return; }
    if (e.repeat) { e.preventDefault(); return; }
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); skip(); }
  }
  function onEnd(e: AnimationEvent) {
    if (e.target !== root) return;
    if (/(ff-out|ff-rm|ff-skip)$/.test(e.animationName)) finish();
  }

  onMount(() => {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    returnFocus?.blur();
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onPointer, true);
    fallback = setTimeout(finish, reduced ? FALLBACK_REDUCED_MS : FALLBACK_MS);
    if (sound) void playSonicLogo();
    return () => { if (!finished) { finished = true; clearTimeout(fallback); clearTimeout(skipTimer); removeEventListener('keydown', onKey, true); removeEventListener('pointerdown', onPointer, true); void stopSonicLogo(100); } };
  });
</script>

<div class="intro" class:rm={reduced} class:leaving={skipping} bind:this={root} role="presentation" on:animationend={onEnd}>
  <p class="sr" role="status">{$t('home.intro.loading')}</p>
  <div class="stage" aria-hidden="true">
    <div class="tilewrap">
      <div class="glow"></div>
      <div class="flare"></div>
      <svg class="tile" viewBox="0 0 64 64" focusable="false">
        <defs>
          <linearGradient id="{uid}g" x1="8" y1="2" x2="56" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff3b52" /><stop offset="1" stop-color="#b80719" /></linearGradient>
          <linearGradient id="{uid}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0" /><stop offset=".5" stop-color="#fff" stop-opacity=".85" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient>
          <clipPath id="{uid}c"><rect x="2" y="2" width="60" height="60" rx="15" /></clipPath>
        </defs>
        <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#{uid}g)" />
        <!-- the F is drawn along its centre line first, then the solid shape of the real mark takes over -->
        <path class="fstroke" pathLength="1" d="M23.500 49V22.500Q23.500 18 28 18H46" fill="none" stroke="#fff" stroke-width="9" stroke-linejoin="round" />
        <path class="ffill" fill="#fff" d="M19 18a4 4 0 0 1 4-4h23a4 4 0 0 1 0 8H28v28a4.500 4.500 0 0 1-9 0z" />
        <path class="play" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round" d="M33.500 29.500 45.500 36 33.500 42.500z" />
        <g clip-path="url(#{uid}c)"><rect class="sweep" x="-12" y="-6" width="22" height="76" fill="url(#{uid}s)" /></g>
      </svg>
      <div class="ribbons">{#each ribbons as r}<span style="--w:{r.w}%;--c:{r.c};--d:{r.d}s;--o:{r.o};--a:{r.a}"></span>{/each}</div>
    </div>
    <div class="word">{#each letters as ch, i}{#if ch === ' '}<span class="gap"></span>{:else}<span class="ch" class:acc={i > 6} style="--i:{i}">{ch}</span>{/if}{/each}</div>
  </div>
</div>

<style>
  /* one continuous timeline (~4 s) in step with sonic.ts: tile + swell 0-0.9 s, F drawn 0.4-1.1 s on the rising notes,
     play mark + flare + sweep on the hit at 1.2 s, wordmark 1.3-2.1 s, then the camera dives into the tile while the F
     dissolves into light ribbons (1.8-3.6 s) and everything fades to black. Only transform and opacity animate, and every
     phase overlaps the next so the motion never stops or jumps. */
  .intro { position: fixed; inset: 0; z-index: 10000; background: #000; display: grid; place-items: center; overflow: hidden; cursor: pointer; animation: ff-out .5s cubic-bezier(.4, 0, .2, 1) 3.5s both; contain: strict; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: 0; }
  .stage { --tile: clamp(104px, 22vmin, 176px); position: relative; display: grid; justify-items: center; gap: clamp(.9rem, 3.2vmin, 1.7rem); transform-origin: 50% calc(var(--tile) / 2); will-change: transform; animation: ff-stage 4s linear both; }
  .glow { position: absolute; inset: -110%; border-radius: 50%; background: radial-gradient(circle, rgba(229, 15, 42, .5) 0%, rgba(229, 15, 42, .16) 38%, transparent 68%); opacity: 0; pointer-events: none; will-change: transform, opacity; animation: ff-bloom 3.2s cubic-bezier(.22, 1, .36, 1) .05s both; }
  .tilewrap { position: relative; width: var(--tile); aspect-ratio: 1; will-change: transform, opacity; animation: ff-tile .95s cubic-bezier(.16, 1, .3, 1) .05s both; }
  .tile { display: block; width: 100%; height: 100%; overflow: visible; animation: ff-hide .7s ease-in 2.05s forwards; }
  .flare { position: absolute; inset: -30%; border-radius: 50%; background: radial-gradient(circle, rgba(255, 255, 255, .55) 0%, rgba(255, 120, 130, .22) 30%, transparent 62%); opacity: 0; will-change: transform, opacity; animation: ff-flare 1.1s cubic-bezier(.22, 1, .36, 1) 1.18s both; }
  .fstroke { stroke-dasharray: 1 1; animation: ff-draw .7s cubic-bezier(.65, 0, .35, 1) .4s both, ff-hide .3s ease-in-out 1s forwards; }
  .ffill { animation: ff-fade .3s ease-in-out 1s both; }
  .play { transform-box: fill-box; transform-origin: center; animation: ff-play .55s cubic-bezier(.34, 1.36, .64, 1) 1.02s both; }
  .sweep { opacity: 0; animation: ff-sweep .85s cubic-bezier(.45, 0, .25, 1) 1.2s both; }
  .ribbons { position: absolute; left: -55%; right: -55%; top: -60%; bottom: -60%; display: flex; justify-content: center; gap: .5%; opacity: 0; pointer-events: none; animation: ff-ribbons 1.9s linear 1.8s both; }
  .ribbons span { flex: 0 0 var(--w); opacity: var(--a); background: linear-gradient(to bottom, transparent, var(--c) 22%, var(--c) 78%, transparent); transform-origin: center var(--o); will-change: transform; animation: ff-stream 1.1s cubic-bezier(.3, 0, .2, 1) calc(1.8s + var(--d)) both; }
  .word { display: flex; align-items: baseline; font-weight: 800; font-size: clamp(1.1rem, 3.4vmin, 1.9rem); letter-spacing: .14em; margin-right: -.14em; color: #fff; animation: ff-hide .4s ease-in 1.85s forwards; }
  .ch { display: inline-block; will-change: transform, opacity; animation: ff-letter .75s cubic-bezier(.16, 1, .3, 1) calc(1.3s + var(--i) * 45ms) both; }
  .ch.acc { color: var(--acc, #e50f2a); font-weight: 900; }
  .gap { display: inline-block; width: .6em; }

  /* gentle drift in, then an accelerating dive into the tile */
  @keyframes ff-stage { 0% { transform: scale(.94); animation-timing-function: cubic-bezier(.33, 0, .2, 1); } 40% { transform: scale(1.02); animation-timing-function: cubic-bezier(.5, 0, .8, .4); } 100% { transform: scale(14); } }
  @keyframes ff-tile { from { opacity: 0; transform: scale(.72); } to { opacity: 1; transform: scale(1); } }
  @keyframes ff-bloom { 0% { opacity: 0; transform: scale(.6); } 35% { opacity: .85; transform: scale(1.05); } 100% { opacity: 0; transform: scale(1.25); } }
  @keyframes ff-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes ff-hide { to { opacity: 0; } }
  @keyframes ff-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ff-play { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: scale(1); } }
  @keyframes ff-sweep { 0% { opacity: 0; transform: translateX(-12px) skewX(-18deg); } 25% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; transform: translateX(78px) skewX(-18deg); } }
  @keyframes ff-flare { 0% { opacity: 0; transform: scale(.6); } 25% { opacity: .5; } 100% { opacity: 0; transform: scale(1.5); } }
  @keyframes ff-letter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes ff-ribbons { 0% { opacity: 0; } 18% { opacity: 1; } 72% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes ff-stream { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @keyframes ff-out { from { opacity: 1; } to { opacity: 0; } }
  @keyframes ff-skip { from { opacity: 1; } to { opacity: 0; } }
  @keyframes ff-rm { 0% { opacity: 0; } 33% { opacity: 1; } 67% { opacity: 1; } 100% { opacity: 0; } }

  /* reduced motion: the finished logo, faded in and out over 300 ms each; no zoom, no sweep, no drawing */
  .rm { animation: ff-rm .9s linear both !important; }
  .rm .stage, .rm .glow, .rm .tilewrap, .rm .tile, .rm .flare, .rm .fstroke, .rm .ffill, .rm .play, .rm .sweep, .rm .word, .rm .ch { animation: none !important; }
  .rm .fstroke, .rm .flare, .rm .sweep, .rm .ribbons { display: none; }
  .rm .glow { opacity: .3; transform: none; }

  .leaving { animation: ff-skip .15s linear both !important; pointer-events: none; }
</style>
