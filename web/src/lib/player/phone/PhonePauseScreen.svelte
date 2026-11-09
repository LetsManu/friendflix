<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { t } from '#lib/i18n';
  import Logo from '#lib/Logo.svelte';
  import { motionAllowed } from '#lib/preview';
  import { motionLevel, stagger } from '#lib/tv/motion';
  import type { PhoneOrient } from './logic';

  /**
   * Phone pause screen (spec 2026-11-08 §3): 5 s after pausing the Player zooms the picture to 103 % (stage `.ppause`) and this
   * layer dims it (a black layer at .62, the same as brightness .38 without animating `filter` or fighting the brightness
   * gesture's inline filter). On the start side, inside the safe area: "You're watching", the title (3 lines portrait, 2
   * landscape), the episode line and the synopsis (3 lines portrait, 4 landscape), rising 40 ms apart; the logo with "Paused" at
   * the end-side bottom. Nothing here takes the pointer: a tap reaches the stage and brings the controls back (Player `wake()`).
   * No Cast & info button on phones.
   */
  export let title = '';
  export let sub = '';
  export let overview = '';
  export let orient: PhoneOrient = 'landscape';

  let col: HTMLDivElement | undefined, ff: HTMLDivElement | undefined;
  /** with motion the dim layer fades in with the picture's zoom (500 ms); without it everything is there at once */
  const mo = motionAllowed();
  onMount(() => {
    if (col && motionLevel() === 'full') stagger([...col.children, ...(ff ? [ff] : [])] as HTMLElement[], { gap: 40 });
  });
  const out = (el: Element) => fade(el, { duration: motionAllowed() ? 200 : 0 });
</script>

<div class="pps" class:port={orient === 'portrait'} class:mo data-testid="phone-pause-screen" out:out>
  <div class="dim" aria-hidden="true"></div>
  <div class="pz" bind:this={col} role="status">
    <small class="eb">{$t('player.pause.watching')}</small>
    <h2 class="ttl">{title}</h2>
    {#if sub}<span class="se">{sub}</span>{/if}
    {#if overview}<p class="ov">{overview}</p>{/if}
  </div>
  <div class="ff" bind:this={ff}><Logo size={24} label="" /><span>{$t('player.pause.paused')}</span></div>
</div>

<style>
  .pps { position: absolute; inset: 0; z-index: 7; pointer-events: none; color: #fff; }
  .dim { position: absolute; inset: 0; background: #000; opacity: .62; }
  .mo .dim { animation: pps-dim 500ms var(--m-emph-out, ease-out) both; }
  @keyframes pps-dim { from { opacity: 0; } to { opacity: .62; } }
  /* landscape: centred in the height between the safe insets; portrait: above the logo row and the home indicator */
  .pz { position: absolute; left: calc(var(--safe-left, 0px) + 16px); top: calc(var(--safe-top, 0px) + 12px); bottom: calc(var(--safe-bottom, 0px) + 12px);
    max-width: 58%; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 6px; overflow: hidden; }
  .port .pz { top: auto; bottom: calc(var(--safe-bottom, 0px) + 12px + 24px + 20px); max-height: calc(100% - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 80px); justify-content: flex-end; }
  .eb { color: rgba(255, 255, 255, .7); font-size: 13px; font-weight: 600; }
  .ttl { margin: 0; font-size: 26px; line-height: 1.08; letter-spacing: -.01em; font-weight: 900; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; flex: none; }
  .se { font-size: 14px; font-weight: 700; flex: none; }
  .ov { margin: 2px 0 0; font-size: 14px; color: #d6d6dc; line-height: 1.45; flex: none;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden; }
  .port .ttl { font-size: 24px; -webkit-line-clamp: 3; line-clamp: 3; }
  .port .ov { -webkit-line-clamp: 3; line-clamp: 3; }
  .ff { position: absolute; right: calc(var(--safe-right, 0px) + 16px + var(--inset, 0px)); bottom: calc(var(--safe-bottom, 0px) + 12px);
    display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 800; }
  .ff > :global(*) { opacity: .7; } /* on the parts: the rise-in animates the row's own opacity to 1 */
  @media (prefers-reduced-motion: reduce) { .mo .dim { animation: none; } }
</style>
