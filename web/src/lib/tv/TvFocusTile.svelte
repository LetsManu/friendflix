<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { backdrop, logoUrl, type Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import { badges, wantBadge } from '#lib/fresh';
  import Icon from '#lib/Icon.svelte';
  import { autoplayAllowed, playPreview, previewOwner, previewSound, stopPreview, toggleSound } from '#lib/preview';
  import { focusFirst } from '#lib/spatial';
  import { prefs } from '#lib/stores';
  import { tvFocus, tvRank } from './focus';
  import { createSettle, tileInfo, TILE_DELAY_MS, TILE_TRAILER_MS, trailerAllowed } from './focusTile';
  import { decodeFade, EMPH_IN, motionLevel, stagger } from './motion';

  /** the title shown (with Play / More info) until focus settles on a row card */
  export let hero: Item | null = null;
  /** 1-based place of the hero in the Top 10 (0 = not ranked) */
  export let heroRank = 0;

  let focused: Item | null = null; // the card the tile follows (settled)
  const settle = createSettle<Item | null>(TILE_DELAY_MS, (v) => (focused = v));
  // null = back on the hero (e.g. focus returned to the tile buttons): no settle delay
  $: if ($tvFocus === null) { settle.cancel(); focused = null; } else settle.push($tvFocus);
  const trailer = createSettle<Item | null>(TILE_TRAILER_MS, (v) => { if (v) void startTrailer(v); });

  $: item = focused ?? hero;
  $: if (item) wantBadge(item.type === 'Episode' ? item.seriesId : item.id);
  $: info = item ? tileInfo(item, $t, $badges[(item.type === 'Episode' ? item.seriesId : item.id) ?? ''], Date.now()) : null;
  $: labels = [...(info?.labels ?? []), ...(focused ? ($tvRank?.id === focused.id && $tvRank.n <= 10 ? [$t('tv.tile.top10', { n: $tvRank.n })] : []) : (heroRank >= 1 && heroRank <= 10 ? [$t('tv.tile.top10', { n: heroRank })] : []))];
  $: showButtons = !focused && !!hero;
  // the eyebrow only says something meaningful (new season, recently added, Top 10); no generic film/series line
  $: eyebrow = labels.join(' · ');

  // two stacked layers crossfade (opacity only): `layers[top]` shows the current item, the other fades out
  let layers: [Item | null, Item | null] = [null, null];
  let top = 0;
  $: if (item && layers[top]?.id !== item.id) { top = 1 - top; layers[top] = item; layers = layers; }
  let logoFailed: Record<string, boolean> = {};

  // ---- text change (spec 5.2): the old text fades out in 120 ms (no slide), the new one re-enters in a stagger ----
  let bodyEl: HTMLElement | undefined, slotEl: HTMLElement | undefined, textId = '';
  // `$:` runs before the DOM update: the snapshot still shows the old title
  $: if (item) onText(item.id);
  function onText(id: string) {
    if (id === textId) return;
    const had = textId;
    textId = id;
    if (!had || !bodyEl) return;
    ghost(bodyEl);
    void tick().then(() => { if (bodyEl && textId === id) stagger([...bodyEl.querySelectorAll<HTMLElement>('[data-st]')], { delay: 120 }); });
  }
  /** a lifeless copy of the outgoing text block that fades out on top (nothing focusable, hidden from assistive tech) */
  function ghost(el: HTMLElement) {
    el.parentElement?.querySelectorAll('.ghost').forEach((g) => g.remove());
    if (motionLevel() === 'reduced' && !document.documentElement.classList.contains('tv-motion-reduced')) return; // calm / reduced motion: instant swap
    if (typeof el.animate !== 'function') return;
    const g = el.cloneNode(true) as HTMLElement;
    g.classList.add('ghost');
    g.setAttribute('aria-hidden', 'true');
    g.inert = true;
    g.querySelector('[data-tile-slot]')?.remove(); // the overlay in the slot (hand-off card) keeps its own state, it is not text
    g.querySelectorAll('[data-autofocus], [data-st], [id]').forEach((n) => { n.removeAttribute('data-autofocus'); n.removeAttribute('data-st'); n.removeAttribute('id'); });
    g.querySelectorAll('a, button').forEach((n) => n.setAttribute('tabindex', '-1'));
    el.after(g);
    g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: EMPH_IN, fill: 'forwards' }).onfinish = () => g.remove();
  }

  // ---- ambient drift: paused while a key was pressed in the last 2 s (and while a trailer plays) ----
  let still = false, stillT: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    const onKey = () => { still = true; clearTimeout(stillT); stillT = setTimeout(() => (still = false), 2000); };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(stillT); };
  });

  // ---- trailer: after TILE_TRAILER_MS on one title; any new focus value stops it ----
  let video: HTMLVideoElement | undefined, playing = false, owner = '';
  /** the trailer showed its first frame: only then the still fades out (600 ms) and the sound toggle appears */
  let framed = false;
  function onFrame() {
    if (!video || framed) return;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => { if (playing) framed = true; });
    else if (playing) framed = true;
  }
  $: onItem(item);
  let lastId = '';
  function onItem(i: Item | null) {
    const id = i?.id ?? '';
    if (id === lastId) return;
    lastId = id;
    stop();
    if (i) trailer.push(i);
  }
  function clearVideo() { framed = false; if (!video) return; video.pause(); video.removeAttribute('src'); video.load(); }
  function stop() { trailer.cancel(); if (owner) stopPreview(owner); owner = ''; playing = false; clearVideo(); }
  async function startTrailer(i: Item) {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (!trailerAllowed({ hoverTrailers: $prefs.hoverTrailers, autoplay: autoplayAllowed(), hidden: document.hidden, saveData: !!nav.connection?.saveData }) || $previewOwner) return;
    const id = i.type === 'Episode' && i.seriesId ? i.seriesId : i.id;
    const mine = 'tile:' + i.id;
    owner = mine;
    playing = true;
    const ok = await playPreview(id, () => video, mine);
    if (owner !== mine) { clearVideo(); return; } // focus moved on meanwhile
    if (!ok) { owner = ''; playing = false; clearVideo(); }
  }
  $: if (playing && owner && $previewOwner !== owner) { playing = false; owner = ''; clearVideo(); } // something else took over or it failed
  onDestroy(() => { settle.cancel(); stop(); });

  /** Up from the tile's buttons reaches the overlay in the `handoff` slot (top right, too far off the geometric search's axis) */
  function upToSlot(node: HTMLElement) {
    const on = (e: Event) => { if ((e as CustomEvent<{ dir: string }>).detail?.dir === 'up' && slotEl && focusFirst(slotEl, false)) e.preventDefault(); };
    node.addEventListener('ff-nav', on);
    return { destroy: () => node.removeEventListener('ff-nav', on) };
  }
</script>

<section class="tile" class:still={still || (playing && framed)} aria-label={info?.title ?? ''}>
  <div class="art">
    {#each layers as l, i (i)}
      <div class="layer" class:on={i === top && !!l} aria-hidden={i !== top}>
        {#if l?.backdrop}{#key l.id}<div class="drift"><img class="bg" src={backdrop(l.id, 1280)} alt="" decoding="async" use:decodeFade /></div>{/key}{/if}
      </div>
    {/each}
    <video class="vid" class:on={playing && framed} bind:this={video} on:playing={onFrame} on:loadeddata={onFrame} muted={!$previewSound} playsinline loop aria-hidden="true" tabindex="-1"></video>
    <div class="shade"></div>
  </div>
  {#if item && info}
    <div class="body" bind:this={bodyEl}>
      {#if eyebrow}<p class="tv-eyebrow" data-st>{eyebrow}</p>{/if}
      {#key item.id}
        {@const lid = item.id}
        {#if info.logoId && !logoFailed[lid]}
          <img class="logo" data-st src={logoUrl(info.logoId)} alt={info.title} on:error={() => (logoFailed[lid] = true)} />
        {:else}
          <h1 class="tv-display" data-st>{info.title}</h1>
        {/if}
      {/key}
      <!-- an overlay (absolute, top right of the tile: the body is not positioned): after the title in reading order, before the buttons -->
      <div class="slot" data-tile-slot bind:this={slotEl}><slot name="handoff" /></div>
      {#if info.meta.length}<p class="tv-meta meta" data-st>{#each info.meta as m, i}{#if i}<span class="sep" aria-hidden="true">·</span>{/if}<span class:age={!!item.rating && m === item.rating}>{m}</span>{/each}</p>{/if}
      {#if info.resume}<p class="tv-meta resume" data-st>{info.resume}</p>{/if}
      {#if info.synopsis}<p class="tv-body ov" data-st>{info.synopsis}</p>{/if}
      {#if info.reason}<p class="tv-meta why" data-st>{info.reason}</p>{/if}
      {#if showButtons}
        <div class="btns" data-st use:upToSlot>
          <a class="tv-btn" data-autofocus href="/watch/{item.id}"><Icon name="play" size={28} />{$t('home.card.play')}</a>
          <a class="tv-btn2" href="/item/{item.id}"><Icon name="info" size={28} />{$t('home.hero.moreInfo')}</a>
        </div>
      {/if}
    </div>
    {#if playing && framed}
      <button type="button" class="tv-btn2 snd" aria-label={$previewSound ? $t('home.card.soundOff') : $t('home.card.soundOn')} aria-pressed={$previewSound} on:click={() => toggleSound(video)}><Icon name={$previewSound ? 'volume' : 'volume-off'} size={28} /></button>
    {/if}
  {/if}
</section>

<style>
  /* sticky + above the rows (z-index 3): the rows slide up underneath it; it is opaque, so nothing shows through. Clipping lives on the art box so the focused button is not cut. */
  .tile { position: sticky; top: 0; z-index: 3; height: 50vh; background: var(--bg); display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); }
  /* backdrop: 72 vw, anchored right/top; the fades live on the same box, so they start exactly at the image edge (no seam) */
  .art { position: absolute; top: 0; right: 0; z-index: -1; width: 72vw; height: 100%; overflow: hidden; pointer-events: none; }
  /* backdrop change (spec 5.2): 280 ms crossfade; the incoming image settles from 102 % to 100 % */
  .layer, .vid { position: absolute; inset: 0; opacity: 0; transition: opacity calc(var(--tv-fade) * .7) ease-in; }
  .layer.on { opacity: 1; transition: opacity var(--tv-fade) ease-out; }
  .bg { animation: tv-settle var(--tv-d-l) var(--tv-emph-out) both; } /* one image per title ({#key}): runs once as it comes in */
  /* ambient drift on the resting backdrop: 18 s, alternate; paused after a key press (2 s), while a trailer plays and on the
     outgoing layer (it holds its place while it fades). A new title gets a new .drift element, so it starts from rest. */
  .drift { position: absolute; inset: 0; animation: tv-drift 18s ease-in-out var(--tv-d-l) infinite alternate paused; }
  .layer.on .drift { animation-play-state: running; }
  .tile.still .layer.on .drift { animation-play-state: paused; }
  :global(html.tv-motion-reduced) .drift, :global(html.tv-motion-reduced) .bg { animation: none; }
  @keyframes tv-settle { from { transform: scale(1.02); } }
  @keyframes tv-drift { from { transform: none; } to { transform: scale(1.04) translate3d(-1%, 0, 0); } }
  /* trailer: fades in (the still fades out) over 600 ms only once the first frame is there */
  .vid.on { opacity: 1; transition: opacity 600ms ease-out; }
  .bg, .vid { width: 100%; height: 100%; object-fit: cover; object-position: center 20%; background: transparent; }
  .bg { display: block; transform-origin: 60% 40%; }
  .shade { position: absolute; inset: 0; background:
    linear-gradient(180deg, rgba(0, 0, 0, .35) 0%, rgba(0, 0, 0, 0) 20%),
    linear-gradient(0deg, #000 0%, rgba(0, 0, 0, .6) 22%, rgba(0, 0, 0, 0) 48%),
    linear-gradient(90deg, #000 0%, #000 18%, rgba(0, 0, 0, .82) 34%, rgba(0, 0, 0, .35) 58%, rgba(0, 0, 0, 0) 78%); }
  /* the text column: bottom left of the tile (a grid cell, not positioned, so the `handoff` overlay inside it is placed against the
     tile); the outgoing copy (.ghost) shares the cell. z-index -1 on .art keeps the artwork under it. */
  .body { grid-area: 1 / 1; align-self: end; margin: 0 0 6vh var(--tv-gutter); width: min(52%, 60rem); display: flex; flex-direction: column; align-items: flex-start; }
  .slot { display: contents; }
  .tv-eyebrow { margin: 0 0 .75rem; }
  .logo { display: block; max-width: 32.5rem; max-height: 10rem; object-fit: contain; object-position: left bottom; }
  .meta { margin: 1rem 0 0; display: flex; flex-wrap: wrap; align-items: center; }
  .sep { margin: 0 .625rem; color: var(--tv-sep); }
  .age { padding: .05rem .4rem; border: 1px solid rgba(255, 255, 255, .45); border-radius: 3px; font-size: .9em; line-height: 1.2; }
  :global(html.tv) .resume { margin: .5rem 0 0; color: var(--acc); } /* beats the muted html.tv .tv-meta colour */
  .ov { margin: .75rem 0 0; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .why { margin: .75rem 0 0; }
  .btns { display: flex; gap: .75rem; margin-top: 1.75rem; }
  :global(html.tv) .snd { position: absolute; right: 5vw; bottom: 6vh; width: 3.5rem; padding: 0; animation: tv-in var(--tv-d-s) ease-out; }
  @keyframes tv-in { from { opacity: 0; } }
  .body:global(.ghost) { pointer-events: none; z-index: 1; }
</style>
