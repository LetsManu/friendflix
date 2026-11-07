<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { backdrop, srcset, HERO_WIDTHS, type Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import { decodeFade } from '#lib/tv/motion';
  import Icon from '#lib/Icon.svelte';

  /**
   * The frame every TV detail sub-screen shares (spec 3): the title's backdrop in the same 72 vw box as on the detail page,
   * but heavily darkened, so the screen reads as a layer on top of it; the title's name as a quiet eyebrow, the screen's
   * name, a Back hint, and the content below on the 152 px edge. The page never scrolls; lists glide inside their windows.
   */
  export let item: Item;
  export let title: string;
  export let titleId = 'detail-title';
</script>

<div class="tvs">
  <!-- data-vt-bd: the backdrop box stays put while the content slides (html.ff-vt-sub, see app.css) -->
  <div class="hero" data-vt-bd="" aria-hidden="true">
    {#if item.backdrop}
      {#key item.id}<img class="bg" src={backdrop(item.id, 1280)} srcset={srcset('Backdrop', item.id, HERO_WIDTHS)} sizes="72vw" alt="" use:decodeFade />{/key}
    {/if}
    <div class="shade"></div>
  </div>

  <header class="hd">
    <div class="ttl">
      <p class="eb">{item.name}</p>
      <h1 id={titleId} class="tv-display h">{title}</h1>
    </div>
    <p class="hint" aria-hidden="true"><span class="key"><Icon name="arrow-left" size={18} /></span>{$t('tv.sub.back')}</p>
  </header>

  <div class="body"><slot /></div>
</div>

<style>
  .tvs { position: relative; height: 100vh; overflow: clip; background: var(--bg); color: #fff; display: flex; flex-direction: column; }

  /* the detail page's backdrop box, much darker: the picture is a tint behind the content, never competing with it */
  .hero { position: absolute; top: 0; right: 0; width: 72vw; height: 100%; overflow: hidden; pointer-events: none; }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; display: block; }
  .shade { position: absolute; inset: 0; background:
    linear-gradient(0deg, #000 0%, rgba(0, 0, 0, .9) 38%, rgba(0, 0, 0, .62) 100%),
    linear-gradient(90deg, #000 0%, #000 18%, rgba(0, 0, 0, .82) 34%, rgba(0, 0, 0, .45) 62%, rgba(0, 0, 0, .3) 100%); }

  .hd { position: relative; z-index: 1; flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 2rem; padding: 7vh var(--tv-safe-x) 0 var(--tv-gutter); }
  .ttl { min-width: 0; }
  /* the title's name: context, not a label, so it stays quiet (muted, sentence case) */
  .eb { margin: 0 0 .4rem; font-size: 1.1rem; font-weight: 600; letter-spacing: .01em; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60vw; }
  :global(html.tv) .h { font-size: 2.8rem; -webkit-line-clamp: 1; line-clamp: 1; }
  /* Back hint: a key cap and a word, at the same quiet level as the meta line */
  .hint { margin: .5rem 0 0; display: flex; align-items: center; gap: .6rem; font-size: 1rem; font-weight: 500; color: rgba(255, 255, 255, .5); white-space: nowrap; }
  .key { display: grid; place-items: center; width: 1.8rem; height: 1.8rem; border: 1px solid rgba(255, 255, 255, .3); border-radius: 6px; }

  .body { position: relative; z-index: 1; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 2rem var(--tv-safe-x) 0 var(--tv-gutter); }
</style>
