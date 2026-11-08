<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { t } from '#lib/i18n';
  import Logo from '#lib/Logo.svelte';
  import { motionAllowed } from '#lib/preview';
  import { motionLevel, stagger } from '#lib/tv/motion';

  /**
   * Desktop pause screen (spec 2026-11-08 §3): 5 s after pausing the Player darkens and zooms the picture (stage `.dpause`)
   * and this layer shows what is playing on the left - "You're watching", the title, the episode line and four lines of
   * synopsis, rising 40 ms apart - plus a "Cast & info" button; the logo with "Paused" sits bottom right. Pointer movement or a
   * key ends it (Player `wake()`); only the button takes the pointer, so moving onto it does not wake the bar.
   */
  export let title = '';
  export let sub = '';
  export let overview = '';

  const dispatch = createEventDispatcher<{ castinfo: void }>();
  let col: HTMLDivElement | undefined;
  onMount(() => { if (col && motionLevel() === 'full') stagger([...col.children] as HTMLElement[], { gap: 40 }); });
  const out = (el: Element) => fade(el, { duration: motionAllowed() ? 200 : 0 });
</script>

<div class="dps" data-testid="desk-pause-screen" out:out>
  <div class="shade" aria-hidden="true"></div>
  <div class="pz" bind:this={col} role="status">
    <small class="eb">{$t('player.pause.watching')}</small>
    <h2 class="ttl">{title}</h2>
    {#if sub}<span class="se">{sub}</span>{/if}
    {#if overview}<p class="ov">{overview}</p>{/if}
    <div class="act"><button type="button" class="btn glass" on:click|stopPropagation={() => dispatch('castinfo')}>{$t('player.pause.castInfo')}</button></div>
  </div>
  <div class="ff"><Logo size={28} label="" /><span>{$t('player.pause.paused')}</span></div>
</div>

<style>
  .dps { position: absolute; inset: 0; z-index: 9; pointer-events: none; color: #fff; }
  /* a soft left fade carries the text over the darkened picture */
  .shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0, 0, 0, .55) 0%, rgba(0, 0, 0, .2) 45%, rgba(0, 0, 0, 0) 70%); }
  .pz { position: absolute; left: clamp(1.5rem, 4vw, 4rem); top: 50%; transform: translateY(-50%); max-width: min(46%, 40rem); display: grid; gap: .5rem; justify-items: start; }
  .eb { color: rgba(255, 255, 255, .7); font-size: .95rem; font-weight: 600; }
  .ttl { margin: 0; font-size: clamp(1.8rem, 3.4vw, 3rem); line-height: 1.02; letter-spacing: -.02em; font-weight: 800; overflow-wrap: anywhere; }
  .se { font-weight: 700; }
  .ov { margin: 0; color: #d6d6dc; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .act { margin-top: .6rem; }
  .act .btn { pointer-events: auto; }
  .ff { position: absolute; right: clamp(1.5rem, 3vw, 2.4rem); bottom: clamp(1.25rem, 3vw, 2rem); display: flex; align-items: center; gap: .5rem; font-weight: 800; opacity: .7; }
</style>
