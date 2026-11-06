<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { backdrop, logoUrl, type Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import { badges, wantBadge } from '#lib/fresh';
  import Icon from '#lib/Icon.svelte';
  import { autoplayAllowed, playPreview, previewOwner, previewSound, stopPreview, toggleSound } from '#lib/preview';
  import { prefs } from '#lib/stores';
  import { tvFocus, tvRank } from './focus';
  import { createSettle, tileInfo, TILE_DELAY_MS, TILE_TRAILER_MS, trailerAllowed } from './focusTile';

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

  // ---- trailer: after TILE_TRAILER_MS on one title; any new focus value stops it ----
  let video: HTMLVideoElement | undefined, playing = false, owner = '';
  $: onItem(item);
  let lastId = '';
  function onItem(i: Item | null) {
    const id = i?.id ?? '';
    if (id === lastId) return;
    lastId = id;
    stop();
    if (i) trailer.push(i);
  }
  function clearVideo() { if (!video) return; video.pause(); video.removeAttribute('src'); video.load(); }
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
</script>

<section class="tile" aria-label={info?.title ?? ''}>
  <div class="art">
    {#each layers as l, i (i)}
      <div class="layer" class:on={i === top && !!l} aria-hidden={i !== top}>
        {#if l?.backdrop}<img class="bg" src={backdrop(l.id, 1280)} alt="" decoding="async" />{/if}
      </div>
    {/each}
    <video class="vid" class:on={playing} bind:this={video} muted={!$previewSound} playsinline loop aria-hidden="true" tabindex="-1"></video>
    <div class="shade"></div>
  </div>
  {#if item && info}
    <div class="body">
      {#if eyebrow}<p class="tv-eyebrow">{eyebrow}</p>{/if}
      {#key item.id}
        {@const lid = item.id}
        {#if info.logoId && !logoFailed[lid]}
          <img class="logo" src={logoUrl(info.logoId)} alt={info.title} on:error={() => (logoFailed[lid] = true)} />
        {:else}
          <h1 class="tv-display">{info.title}</h1>
        {/if}
      {/key}
      {#if info.meta.length}<p class="tv-meta meta">{#each info.meta as m, i}{#if i}<span class="sep" aria-hidden="true">·</span>{/if}<span class:age={!!item.rating && m === item.rating}>{m}</span>{/each}</p>{/if}
      {#if info.resume}<p class="tv-meta resume">{info.resume}</p>{/if}
      {#if info.synopsis}<p class="tv-body ov">{info.synopsis}</p>{/if}
      {#if info.reason}<p class="tv-meta why">{info.reason}</p>{/if}
      {#if showButtons}
        <div class="btns">
          <a class="tv-btn" data-autofocus href="/watch/{item.id}"><Icon name="play" size={28} />{$t('home.card.play')}</a>
          <a class="tv-btn2" href="/item/{item.id}"><Icon name="info" size={28} />{$t('home.hero.moreInfo')}</a>
        </div>
      {/if}
    </div>
    {#if playing}
      <button type="button" class="tv-btn2 snd" aria-label={$previewSound ? $t('home.card.soundOff') : $t('home.card.soundOn')} aria-pressed={$previewSound} on:click={() => toggleSound(video)}><Icon name={$previewSound ? 'volume' : 'volume-off'} size={28} /></button>
    {/if}
  {/if}
</section>

<style>
  /* sticky + above the rows (z-index 3): the rows slide up underneath it; it is opaque, so nothing shows through. Clipping lives on the art box so the focused button is not cut. */
  .tile { position: sticky; top: 0; z-index: 3; height: 50vh; background: var(--bg); }
  /* backdrop: 72 vw, anchored right/top; the fades live on the same box, so they start exactly at the image edge (no seam) */
  .art { position: absolute; top: 0; right: 0; width: 72vw; height: 100%; overflow: hidden; pointer-events: none; }
  .layer, .vid { position: absolute; inset: 0; opacity: 0; transition: opacity calc(var(--tv-fade) * .7) ease-in; }
  .layer.on, .vid.on { opacity: 1; transition: opacity var(--tv-fade) ease-out; }
  .bg, .vid { width: 100%; height: 100%; object-fit: cover; object-position: center 20%; background: transparent; }
  .bg { display: block; }
  .shade { position: absolute; inset: 0; background:
    linear-gradient(180deg, rgba(0, 0, 0, .35) 0%, rgba(0, 0, 0, 0) 20%),
    linear-gradient(0deg, #000 0%, rgba(0, 0, 0, .6) 22%, rgba(0, 0, 0, 0) 48%),
    linear-gradient(90deg, #000 0%, #000 18%, rgba(0, 0, 0, .82) 34%, rgba(0, 0, 0, .35) 58%, rgba(0, 0, 0, 0) 78%); }
  .body { position: absolute; left: var(--tv-gutter); bottom: 6vh; width: min(52%, 60rem); display: flex; flex-direction: column; align-items: flex-start; }
  .tv-eyebrow { margin: 0 0 .75rem; }
  .logo { display: block; max-width: 32.5rem; max-height: 10rem; object-fit: contain; object-position: left bottom; }
  .meta { margin: 1rem 0 0; display: flex; flex-wrap: wrap; align-items: center; }
  .sep { margin: 0 .625rem; color: var(--tv-sep); }
  .age { padding: .05rem .4rem; border: 1px solid rgba(255, 255, 255, .45); border-radius: 3px; font-size: .9em; line-height: 1.2; }
  .resume { margin: .5rem 0 0; color: var(--acc); }
  .ov { margin: .75rem 0 0; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .why { margin: .75rem 0 0; }
  .btns { display: flex; gap: .75rem; margin-top: 1.75rem; }
  :global(html.tv) .snd { position: absolute; right: 5vw; bottom: 6vh; width: 3.5rem; padding: 0; }
</style>
