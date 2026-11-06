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
  import { tvFocus } from './focus';
  import { createSettle, tileInfo, TILE_DELAY_MS, TILE_TRAILER_MS } from './focusTile';

  /** the title shown (with Play / More info) until focus settles on a row card */
  export let hero: Item | null = null;

  let focused: Item | null = null; // the card the tile follows (settled)
  const settle = createSettle<Item | null>(TILE_DELAY_MS, (v) => (focused = v));
  $: settle.push($tvFocus);
  const trailer = createSettle<Item | null>(TILE_TRAILER_MS, (v) => { if (v) void startTrailer(v); });

  $: item = focused ?? hero;
  $: if (item) wantBadge(item.type === 'Episode' ? item.seriesId : item.id);
  $: info = item ? tileInfo(item, $t, $badges[(item.type === 'Episode' ? item.seriesId : item.id) ?? ''], Date.now()) : null;
  $: showButtons = !focused && !!hero;
  $: eyebrow = item ? $t(item.type === 'Series' ? 'home.meta.series' : 'home.meta.movie') : '';

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
  function stop() { trailer.cancel(); if (owner) stopPreview(owner); owner = ''; playing = false; }
  async function startTrailer(i: Item) {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (!$prefs.hoverTrailers || !autoplayAllowed() || document.hidden || nav.connection?.saveData || $previewOwner) return;
    owner = 'tile:' + i.id;
    playing = true;
    const ok = await playPreview(i.id, () => video, owner);
    if (owner !== 'tile:' + i.id) return; // focus moved on meanwhile
    if (!ok) { owner = ''; playing = false; }
  }
  $: if (playing && owner && $previewOwner !== owner) { playing = false; owner = ''; } // something else took over or it failed
  onDestroy(stop);
</script>

<section class="tile" aria-label={info?.title ?? ''}>
  {#each layers as l, i (i)}
    <div class="layer" class:on={i === top && !!l} aria-hidden={i !== top}>
      {#if l?.backdrop}<img class="bg" src={backdrop(l.id, 1280)} alt="" decoding="async" />{/if}
    </div>
  {/each}
  <video class="vid" class:on={playing} bind:this={video} muted={!$previewSound} playsinline loop aria-hidden="true" tabindex="-1"></video>
  <div class="shade"></div>
  {#if item && info}
    <div class="body">
      <p class="tv-eyebrow">{eyebrow}</p>
      {#key item.id}
        {#if info.logoId && !logoFailed[item.id]}
          <img class="logo" src={logoUrl(info.logoId)} alt={info.title} on:error={() => (logoFailed[item.id] = true)} />
        {:else}
          <h1 class="tv-title ttl">{info.title}</h1>
        {/if}
      {/key}
      {#if info.labels.length}<p class="labels">{#each info.labels as l}<span>{l}</span>{/each}</p>{/if}
      {#if info.meta.length}<p class="meta">{info.meta.join(' · ')}</p>{/if}
      {#if info.resume}<p class="resume">{info.resume}</p>{/if}
      {#if info.synopsis}<p class="ov">{info.synopsis}</p>{/if}
      {#if info.reason}<p class="why">{info.reason}</p>{/if}
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
  .tile { position: relative; height: 50vh; overflow: hidden; background: var(--bg); }
  .layer, .vid { position: absolute; inset: 0; opacity: 0; transition: opacity 200ms ease-out; }
  .layer.on { opacity: 1; }
  .bg, .vid { position: absolute; top: 0; right: 0; width: 70%; height: 100%; object-fit: cover; object-position: center 20%; background: transparent; }
  .vid { pointer-events: none; }
  .vid.on { opacity: 1; }
  .shade { position: absolute; inset: 0; pointer-events: none; background:
    linear-gradient(to top, var(--bg) 0%, transparent 35%),
    linear-gradient(to right, var(--bg) 0%, var(--bg) 28%, transparent 70%); }
  .body { position: absolute; left: 0; bottom: 6vh; width: min(46%, 60rem); display: flex; flex-direction: column; gap: .6rem; }
  .tv-eyebrow { margin: 0; }
  .logo { max-width: 24rem; max-height: 9rem; object-fit: contain; object-position: left bottom; align-self: flex-start; }
  .ttl { margin: 0; font-size: 3rem; line-height: 1.05; }
  .labels { margin: 0; display: flex; gap: .5rem; }
  .labels span { padding: .1rem .6rem; border-radius: 3px; background: var(--acc-fill); color: #fff; font-size: 1.1rem; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; }
  .meta, .resume { margin: 0; font-size: 1.75rem; font-weight: 600; }
  .resume { color: var(--acc); }
  .ov { margin: 0; font-size: 1.75rem; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .why { margin: 0; font-size: 1.75rem; color: var(--mut); }
  .btns { display: flex; gap: 1rem; margin-top: .6rem; }
  .snd { position: absolute; right: 5vw; bottom: 6vh; width: 56px; padding: 0; }
</style>
