<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The player's AirPlay connecting layout (device hand-off spec 4): the tap's token is on its way, or a TV was picked and has not
   * played yet. It lies over the video's box (nothing moves) with the title's backdrop under the remote screen's dim treatment
   * (never the video frame), a decorative spinner where the play button will be, the status line and *Abbrechen*.
   * The Player renders it while `airPhase()` is 'connecting'. It crossfades by opacity (120 ms; calm mode and reduced motion: 0 ms).
   */
  import { fade } from 'svelte/transition';
  import { onMount } from 'svelte';
  import { SCRIM_BAR } from '#lib/glass/tone';
  import { t } from '#lib/i18n';
  import { motionAllowed } from '#lib/preview';

  /** the picture candidates, best first (`castBackdrops()`: the next one is tried when one fails to load) */
  export let art: string[];
  export let onCancel: () => void;

  let i = 0;
  $: src = art[i] ?? null;
  // the live region mounts empty: screen readers announce what is put into a region that already exists
  let said = false;
  onMount(() => { const id = setTimeout(() => (said = true), 50); return () => clearTimeout(id); });
</script>

<div class="ac" data-testid="airplay-connecting" style="--fr-scrim-safe:{SCRIM_BAR}" transition:fade|global={{ duration: motionAllowed() ? 120 : 0 }}>
  {#if src}<img class="bg" {src} alt="" aria-hidden="true" on:error={() => i++} />{/if}
  <div class="shade" aria-hidden="true"></div>
  <div class="box">
    <span class="disc" aria-hidden="true"><span class="spin"></span></span>
    <p class="msg frost frost-safe frost-panel" role="status">{#if said}{$t('player.castRemote.connecting', { device: $t('player.castBar.airplayDevice') })}{/if}</p>
    <button type="button" class="frost-btn" on:click|stopPropagation={onCancel}>{$t('player.airplay.cancel')}</button>
  </div>
</div>

<style>
  .ac { position: absolute; inset: 0; z-index: 6; overflow: hidden; background: #000; color: #fff; display: grid; place-items: center; pointer-events: auto; }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: blur(16px) brightness(.5) saturate(1.1); transform: scale(1.08); }
  .shade { position: absolute; inset: 0; background: linear-gradient(rgba(0, 0, 0, .55), rgba(0, 0, 0, .25) 40%, rgba(0, 0, 0, .8)); pointer-events: none; }
  .box { position: relative; display: grid; justify-items: center; gap: 16px; padding: 0 16px; max-width: 100%; }
  .disc { width: 76px; height: 76px; border-radius: 50%; background: #fff; display: grid; place-items: center; }
  .spin { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(0, 0, 0, .25); border-top-color: #000; animation: ac-spin .9s linear infinite; }
  @keyframes ac-spin { to { transform: rotate(360deg); } }
  .msg { margin: 0; padding: 12px 20px; font-weight: 700; text-align: center; overflow-wrap: anywhere; }

  /* calm mode and reduced motion: nothing moves, the panel is solid (the .frost rules) */
  :global(html.m-still) .ac :is(*, *::before, *::after) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .ac :is(*, *::before, *::after) { transition: none !important; animation: none !important; }
  }
</style>
