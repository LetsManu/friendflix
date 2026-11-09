<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { img, logoUrl, srcset, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { FRESH_KEYS } from '#lib/badges';
  import { badges, type Badge } from '#lib/fresh';
  import { heroPlayHref, heroPlaysNative, listIdOf } from '#lib/heroPlay';
  import { t, type TKey } from '#lib/i18n';
  import { genreLine, itemPath } from '#lib/mobile';
  import { native } from '#lib/native/bridge';
  import { playOrCast } from '#lib/cast/playOrCast';
  import { playPrefetch } from '#lib/player/prefetch';
  import { openPreview } from '#lib/previewSheet';
  import { press } from '#lib/glass/press';
  import { listIds, toggleList } from '#lib/stores';
  import { motionLevel, springStep, watchFrames, type Spring } from '#lib/tv/motion';
  import { swipeTarget } from '#lib/phone/logic';
  import { averageColor, glowCss, type Rgb } from '#lib/phone/glow';

  /**
   * Phone home (not kids, not TV): a swipe carousel of up to five poster cards. The centred card is ~70 % of the width, its
   * neighbours peek smaller (scale .86) and dimmer. A horizontal drag follows the finger (vertical moves stay page scrolls,
   * `touch-action: pan-y`); on release `swipeTarget` picks the card and a spring (lib/tv/motion springStep) settles there.
   * Slides only move through transform / opacity; side cards darken through a black overlay's opacity. Behind it a glow in the centred poster's colour crossfades
   * (two layers, opacity only). Play / Continue and My list act on the centred card; a tap on it opens the preview sheet,
   * a tap on a side card centres it. No auto-advance, no trailer. Without items (the picks are still loading) it shows
   * placeholders of the same height, so the rows below never move when the cards arrive.
   */
  export let items: Item[];

  /** a drag decides its direction after this many px */
  const INTENT_PX = 8;
  /** pull past the first / last card: the track moves this fraction of the finger */
  const EDGE = 0.35;

  let cur = 0, centredId = items[0]?.id ?? '';
  /** the track's width; a slide is 70 % of it (at most 340 px), slide centres sit 90 % of a slide apart */
  let tw = typeof window === 'undefined' ? 390 : Math.min(window.innerWidth, 720);
  $: step = Math.min(tw * 0.7, 340) * 0.9;
  /** visual position in px (cur * step at rest) */
  let x = 0;
  let raf = 0, springV = 0;
  let links: HTMLAnchorElement[] = [];
  let posters: HTMLImageElement[] = [];
  let logoFailed = new Set<string>();

  // ---- the items can change under the carousel (rows load later, badges arrive): the centred title stays centred ----
  $: syncItems(items);
  function syncItems(list: Item[]) {
    const k = list.findIndex((i) => i.id === centredId);
    const next = k >= 0 ? k : Math.max(0, Math.min(cur, list.length - 1));
    centredId = list[next]?.id ?? '';
    if (next === cur) { if (!drag && !raf) x = cur * step; return; }
    // the centred title moved to another index: shift the track with it, so nothing under the finger jumps
    const shift = (next - cur) * step;
    cur = next;
    if (drag) { drag.base += shift; x += shift; }
    else if (raf) { x += shift; settle(next, springV); }
    else x = cur * step;
  }
  // a resize while at rest keeps the centred card in the middle
  $: if (step && !drag && !raf) x = cur * step;

  $: centred = items[cur] ?? items[0];
  $: listId = centred ? listIdOf(centred) : '';
  $: inList = listId ? $listIds.has(listId) : false;

  /** eyebrow: the title's fresh label (series / movies only, as on the cards) */
  function eyebrow(it: Item, all: Record<string, Badge | null>): TKey | null {
    if (it.type === 'Episode') return null;
    const f = all[it.id]?.fresh;
    return f ? FRESH_KEYS[f] : null;
  }
  const posterId = (it: Item) => (it.type === 'Episode' && it.seriesId ? it.seriesId : it.id);

  /** transform / opacity of slide i for the track position x (no filter: a large image would repaint on every frame) */
  function slideStyle(i: number, pos: number, s: number): string {
    const off = i * s - pos, d = s ? Math.abs(off) / s : 0, a = Math.min(d, 1);
    const op = d <= 1 ? 1 - a * 0.45 : Math.max(0, 0.55 * (2 - d));
    return `transform:translate3d(${off.toFixed(1)}px,0,0) scale(${(1 - a * 0.14).toFixed(4)});opacity:${op.toFixed(3)};z-index:${10 - Math.round(d)};visibility:${op > 0 ? 'visible' : 'hidden'}`;
  }
  /** the side cards' dimming: a black overlay whose opacity grows to .35 one card away from the centre (opacity only) */
  function dimStyle(i: number, pos: number, s: number): string {
    const d = s ? Math.abs(i * s - pos) / s : 0;
    return `opacity:${(Math.min(d, 1) * 0.35).toFixed(3)}`;
  }

  // ---- spring ----
  function stopSpring() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  /** settles the track on card `target`, starting from the current position with velocity v (px/s) */
  function settle(target: number, v = 0) {
    stopSpring();
    const to = target * step;
    if (motionLevel() === 'reduced') { x = to; return; }
    let s: Spring = { x, v }, t0 = performance.now();
    watchFrames();
    const frame = (t: number) => {
      s = springStep(s, to, Math.min(64, Math.max(0, t - t0)));
      t0 = t;
      if (Math.abs(s.x - to) < 0.5 && Math.abs(s.v) < 20) { x = to; raf = 0; springV = 0; return; }
      x = s.x; springV = s.v;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  function go(i: number, v = 0) {
    cur = Math.max(0, Math.min(items.length - 1, i));
    centredId = items[cur]?.id ?? '';
    settle(cur, v);
  }

  // ---- drag (pointer events; the browser keeps vertical pans) ----
  type Drag = { id: number; x0: number; y0: number; base: number; on: boolean; hist: Array<[number, number]> };
  let drag: Drag | null = null, track: HTMLElement;
  let swallow = false, swallowT: ReturnType<typeof setTimeout> | undefined;
  function down(e: PointerEvent) {
    if (items.length < 2 || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    stopSpring(); // a card caught mid-spring stays under the finger
    swallow = false;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: x, on: false, hist: [[e.timeStamp, e.clientX]] };
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dx) < INTENT_PX && Math.abs(dy) < INTENT_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) { drag = null; settle(cur); return; } // vertical: the page scrolls
      drag.on = true;
      try { track.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    }
    drag.hist.push([e.timeStamp, e.clientX]);
    if (drag.hist.length > 6) drag.hist.shift();
    const max = (items.length - 1) * step;
    let nx = drag.base - dx;
    if (nx < 0) nx *= EDGE;
    else if (nx > max) nx = max + (nx - max) * EDGE;
    x = nx;
  }
  /** finger speed over the last ~100 ms, px/ms (positive = moving right) */
  function speed(d: Drag, now: number): number {
    const recent = d.hist.filter(([t]) => now - t <= 100);
    if (recent.length < 2) return 0;
    const [t0, x0] = recent[0]!, [t1, x1] = recent[recent.length - 1]!;
    return t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
  }
  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.on) { if (raf === 0 && x !== cur * step) settle(cur); return; } // a tap: the click decides
    swallow = true; clearTimeout(swallowT); swallowT = setTimeout(() => (swallow = false), 400);
    const vx = speed(d, e.timeStamp);
    go(swipeTarget({ index: cur, count: items.length, dx: e.clientX - d.x0, vx }), -vx * 1000);
  }
  function cancel(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    settle(cur);
  }
  /** the click that ends a drag does nothing */
  function noClick(e: MouseEvent) { if (swallow) { e.preventDefault(); e.stopPropagation(); swallow = false; } }

  function tap(e: MouseEvent, i: number) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new-tab clicks keep the plain link
    e.preventDefault();
    if (i !== cur) { go(i); return; }
    const it = items[i];
    if (it) openPreview(it, e.currentTarget as HTMLElement);
  }

  async function keys(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = cur + (e.key === 'ArrowRight' ? 1 : -1);
    if (next < 0 || next >= items.length) return;
    e.preventDefault();
    const inTrack = track?.contains(document.activeElement);
    go(next);
    await tick();
    if (inTrack) links[cur]?.focus({ preventScroll: true });
  }

  function play(e: MouseEvent) { if (centred && heroPlaysNative(centred, '', native.available)) playOrCast(e, centred); }

  // ---- glow: two layers, the new colour fades in over the old one ----
  const colours = new Map<string, Rgb | null>();
  let layers: [string, string] = [glowCss(null), glowCss(null)], front = 0;
  $: glowFor(centred);
  function glowFor(it: Item | undefined) {
    if (!it || typeof document === 'undefined') return;
    let c = colours.get(it.id);
    if (c === undefined) {
      const el = posters[items.indexOf(it)];
      if (!el || !el.complete || !el.naturalWidth) return; // the poster's load event comes back here
      c = averageColor(el);
      colours.set(it.id, c);
    }
    const css = glowCss(c);
    if (css === layers[front]) return;
    const back = front ? 0 : 1;
    layers[back] = css;
    layers = layers;
    front = back;
  }
  function posterLoaded(i: number) { if (i === cur) glowFor(items[i]); }

  onMount(() => glowFor(centred));
  onDestroy(() => { stopSpring(); clearTimeout(swallowT); });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="mc" data-play-scope aria-roledescription="carousel" aria-label={$t('home.carousel.label')} aria-busy={items.length ? undefined : 'true'} on:keydown={keys}>
  <div class="glow" aria-hidden="true">
    <i class:on={front === 0} style:background={layers[0]}></i>
    <i class:on={front === 1} style:background={layers[1]}></i>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="track" class:single={items.length < 2} bind:this={track} bind:clientWidth={tw}
    on:pointerdown={down} on:pointermove={move} on:pointerup={up} on:pointercancel={cancel} on:click|capture={noClick} on:dragstart={(e) => e.preventDefault()}>
    {#each items as it, i (it.id)}
      {@const brow = eyebrow(it, $badges)}
      <div class="slide" class:on={i === cur} role="group" aria-roledescription="slide" aria-label={$t('home.carousel.slide', { n: i + 1, m: items.length })} style={slideStyle(i, x, step)}>
        <a class="card" href={itemPath(it)} bind:this={links[i]} tabindex={i === cur ? 0 : -1} draggable="false" aria-label={$t('home.card.openPreview', { name: it.name })} aria-haspopup="dialog" on:click={(e) => tap(e, i)}>
          <img class="poster" bind:this={posters[i]} data-play-art={i === cur ? '' : undefined} src={img(posterId(it), 520)} srcset={srcset('Primary', posterId(it), [320, 520, 780])} sizes="min(70vw, 340px)" alt="" draggable="false" width="340" height="510" loading={i < 2 ? 'eager' : 'lazy'} fetchpriority={i === 0 ? 'high' : undefined} on:load={() => posterLoaded(i)} />
          <span class="fade"></span>
          <span class="over">
            {#if brow}<span class="eyebrow">{$t(brow)}</span>{/if}
            {#if it.logo && !logoFailed.has(it.id)}<img class="logo" src={logoUrl(it.id)} alt={it.name} draggable="false" on:error={() => (logoFailed = new Set([...logoFailed, it.id]))} />{:else}<span class="title">{it.name}</span>{/if}
            {#if genreLine(it.genres)}<span class="genres">{genreLine(it.genres)}</span>{/if}
          </span>
        </a>
        <span class="dim" aria-hidden="true" style={dimStyle(i, x, step)}></span>
      </div>
    {:else}
      <div class="slide skeleton" aria-hidden="true"></div>
    {/each}
  </div>
  <p class="sr-only" aria-live="polite" aria-atomic="true">{centred ? `${$t('home.carousel.slide', { n: cur + 1, m: items.length })}, ${centred.name}` : ''}</p>
  <!-- while loading: an empty dots row keeps the height (a single card has no dots, its buttons take the same space) -->
  {#if items.length !== 1}
    <div class="dots" aria-hidden="true">{#each items as it, i (it.id)}<i class:on={i === cur}></i>{/each}</div>
  {/if}
  {#if centred}
    <div class="acts" class:solo={items.length < 2}>
      <a class="btn w" href={heroPlayHref(centred)} use:playPrefetch use:press on:click={play}><Icon name="play" size={20} />{centred.positionTicks ? $t('home.card.resume') : $t('home.card.play')}</a>
      <button type="button" class="btn g frost frost-btn frost-safe" use:press aria-pressed={inList} on:click={() => toggleList(listId, inList)}><Icon name={inList ? 'check' : 'plus'} size={20} />{$t('home.card.myList')}</button>
    </div>
  {:else}
    <div class="acts" aria-hidden="true"><div class="btn skeleton"></div><div class="btn skeleton"></div></div>
  {/if}
</section>

<style>
  .mc { position: relative; overflow: hidden; padding: calc(var(--nav-total) + 1rem) 0 .4rem; background: var(--bg); }
  /* the glow reaches up under the glass header; two layers crossfade (opacity only) */
  .glow { position: absolute; inset: 0; pointer-events: none; }
  .glow i { position: absolute; inset: 0; opacity: 0; transition: opacity .6s var(--m-emph-out); }
  .glow i.on { opacity: 1; }
  /* calm mode / reduced motion (html.m-still, kept live by the layout) and a tripped frame guard: instant changes */
  :global(html.m-still) .mc .glow i, :global(html.m-still) .mc .dots i, :global(html.m-still) .mc .btn,
  :global(html.tv-motion-reduced) .mc .glow i, :global(html.tv-motion-reduced) .mc .dots i, :global(html.tv-motion-reduced) .mc .btn { transition: none; }
  @media (prefers-reduced-motion: reduce) { .glow i { transition: none; } }
  /* all slides share one grid cell; JS moves them (transform / opacity) */
  .track { position: relative; z-index: 1; display: grid; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  .slide { position: relative; grid-area: 1 / 1; justify-self: center; width: min(70%, 340px); aspect-ratio: 2 / 3; border-radius: 18px; overflow: hidden; background: #1c2228; box-shadow: 0 22px 46px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .1); will-change: transform; transform-origin: 50% 50%; }
  .track.single .slide { will-change: auto; }
  .card { position: relative; display: block; width: 100%; height: 100%; color: #fff; -webkit-touch-callout: none; }
  .card:focus-visible { outline: 2px solid #fff; outline-offset: -4px; border-radius: 18px; box-shadow: none; }
  /* the dark companion of the two-tone ring sits over the poster (an inset shadow on the link itself would be under the image) */
  .card:focus-visible::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 7px var(--ring-dark); pointer-events: none; }
  .poster { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
  /* over the whole card (art and text); JS sets its opacity from the distance to the centre */
  .dim { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; border-radius: inherit; }
  .fade { position: absolute; inset: 0; background: linear-gradient(0deg, rgba(0, 0, 0, .85) 0%, rgba(0, 0, 0, .55) 22%, transparent 48%); pointer-events: none; }
  .over { position: absolute; left: 0; right: 0; bottom: 0; padding: 3.6rem .9rem .9rem; display: grid; gap: .4rem; justify-items: center; text-align: center; pointer-events: none; }
  .eyebrow { font-size: .7rem; font-weight: 800; color: var(--acc); letter-spacing: .14em; text-transform: uppercase; text-shadow: 0 1px 6px rgba(0, 0, 0, .7); }
  .logo { max-width: 78%; max-height: 3.4rem; object-fit: contain; filter: drop-shadow(0 3px 10px rgba(0, 0, 0, .7)); }
  .title { font-size: 1.4rem; font-weight: 800; line-height: 1.1; letter-spacing: -.02em; text-shadow: 0 2px 12px rgba(0, 0, 0, .7); overflow-wrap: anywhere; }
  .genres { font-size: .8rem; font-weight: 600; color: #e6e6e6; text-shadow: 0 1px 6px rgba(0, 0, 0, .8); }
  /* each dot is a fixed 20 px pill shown at 30 % width; the current one grows to full width (transform only) */
  .dots { position: relative; z-index: 1; display: flex; justify-content: center; height: 6px; margin: 14px 0 12px; }
  .dots i { flex: none; width: 20px; height: 6px; margin: 0 -2px; border-radius: 99px; background: #fff; opacity: .3; transform: scaleX(.3); transition: transform .35s var(--m-spring), opacity .3s; }
  .dots i.on { transform: none; opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .dots i, .btn { transition: none; } }
  .acts { position: relative; z-index: 1; display: flex; gap: 8px; padding: 0 22px; }
  /* the same space as the dots row (14 + 6 + 12 px): one card, several or the placeholders, the carousel keeps its height */
  .acts.solo { margin-top: 32px; }
  .slide.skeleton { box-shadow: none; }
  :global(html.m-still) .mc .skeleton::after, :global(html.tv-motion-reduced) .mc .skeleton::after { animation: none; display: none; }
  .btn { flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 0 1rem; border-radius: 999px; font-weight: 700; font-size: 15px; white-space: nowrap; transition: transform .15s var(--m-emph-out); }
  .btn:active { transform: scale(.97); }
  .btn.w { background: #fff; color: #0b0b0d; }
  .btn.w:hover { background: rgba(255, 255, 255, .86); }
  /* .btn.g is the glass pill (.frost .frost-safe: the glow and artwork sit behind it; solid without full motion); its hover
     never adds milk (contrast), the press feedback (lib/glass/press.ts) answers a touch */
</style>
