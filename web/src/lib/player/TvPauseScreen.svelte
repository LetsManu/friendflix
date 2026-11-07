<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { logoUrl } from '#lib/api';
  import { t } from '#lib/i18n';
  import { motionAllowed } from '#lib/preview';
  import { stagger } from '#lib/tv/motion';

  /**
   * TV pause screen (spec 4): after 8 s paused without a key the picture dims to about 45 % (a black layer's opacity, over
   * 600 ms) and a block on the left says what is playing: "You're watching", the title logo (else the name), the episode line
   * and three lines of synopsis, staggered in. Any key takes it away (Player). Calm mode never shows it (pauseScreenDue).
   */
  export let title = '';
  /** item id whose logo to try (the series for an episode); '' = text title only */
  export let logoId = '';
  export let sub = '';
  export let overview = '';

  let logoOk = Boolean(logoId), logoLoaded = false, block: HTMLDivElement | undefined;
  onMount(() => { if (block) stagger([...block.children] as HTMLElement[], { delay: 220, gap: 60 }); });
  const out = (el: Element) => fade(el, { duration: motionAllowed() ? 200 : 0 });
</script>

<div class="pause" data-testid="pause-screen" out:out>
  <div class="dim" aria-hidden="true"></div>
  <div class="blk" bind:this={block} role="status">
    <p class="tv-meta eb">{$t('tv.player.watching')}</p>
    {#if logoOk}
      <img class="logo" class:on={logoLoaded} src={logoUrl(logoId)} alt={title} on:load={() => (logoLoaded = true)} on:error={() => (logoOk = false)} />
    {:else}
      <h2 class="tv-display">{title}</h2>
    {/if}
    {#if sub}<p class="tv-meta se">{sub}</p>{/if}
    {#if overview}<p class="tv-body ov">{overview}</p>{/if}
  </div>
</div>

<style>
  .pause { position: absolute; inset: 0; z-index: 10; pointer-events: none; color: #fff; }
  /* the picture dims to ~45 % over 600 ms; a soft left fade carries the text */
  .dim { position: absolute; inset: 0; background: #000; opacity: .55; animation: tv-dim 600ms ease-out both; }
  .dim::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0, 0, 0, .55) 0%, rgba(0, 0, 0, .25) 45%, rgba(0, 0, 0, 0) 70%); }
  @keyframes tv-dim { from { opacity: 0; } to { opacity: .55; } }
  .blk { position: absolute; left: var(--tv-safe-x, 5vw); bottom: 18vh; max-width: min(46rem, 50vw); display: flex; flex-direction: column; align-items: flex-start; }
  /* "You're watching": a quiet eyebrow in the meta style (muted, sentence case: a status line, not a coral label) */
  :global(html.tv) .eb { margin: 0 0 1.1rem; color: var(--mut); }
  .logo { display: block; max-width: min(32.5rem, 100%); max-height: 10rem; object-fit: contain; object-position: left bottom; opacity: 0; transition: opacity var(--tv-d-s) ease-out; }
  .logo.on { opacity: 1; }
  :global(html.tv) .se { margin: 1.25rem 0 0; color: var(--tv-white-88); }
  :global(html.tv) .ov { margin: .9rem 0 0; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  @media (prefers-reduced-motion: reduce) { .dim { animation: none; } }
</style>
