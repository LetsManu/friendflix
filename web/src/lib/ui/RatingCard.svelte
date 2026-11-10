<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { motionAllowed } from '#lib/preview';
  import { prefs } from '#lib/stores';

  /**
   * The hero's age rating as a small glass card at the top left: it fades in when the hero has loaded, stays 4 s, fades out.
   * Opacity (plus a few px of transform) only; it is absolutely positioned and never takes pointer events, so nothing shifts
   * or gets blocked. Mount it per title (`{#key}`) so it comes back when the hero changes. Calm mode and reduced motion:
   * no card at all (`motionAllowed`). No rating: nothing is rendered. `reasons` (the content descriptors) become a second line.
   */
  export let rating = '';
  export let reasons: string[] = [];
  /** the hero's picture is there; the card waits for it */
  export let ready = true;

  const SHOW_MS = 4000;
  let mounted = false, on = false, started = false, timer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => { mounted = true; });
  // the profile's prefs can arrive after the hero: calm mode (or reduced motion) always wins
  const calmOff = (_p: unknown) => motionAllowed();
  $: allowed = mounted && calmOff($prefs);
  $: if (allowed && ready && rating && !started) {
    started = true;
    // one frame with opacity 0 first, so the fade-in runs
    timer = setTimeout(() => { on = true; timer = setTimeout(() => (on = false), SHOW_MS); }, 30);
  }
  onDestroy(() => clearTimeout(timer));
  $: line2 = reasons.filter(Boolean).join(', ');
</script>

{#if allowed && rating}
  <!-- polite and atomic, in the DOM from the start: read once when the text arrives, not on every re-render -->
  <div class="rc frost frost-tile frost-safe" class:on role="status" aria-live="polite" aria-atomic="true">
    <span class="ic" aria-hidden="true"><Icon name="shield" size={20} /></span>
    <span class="tx">
      <b>{rating}</b>
      {#if line2}<small>{line2}</small>{/if}
    </span>
  </div>
{/if}

<style>
  .rc { position: absolute; left: var(--gutter, 16px); top: var(--rc-top, 88px); z-index: 2; display: flex; align-items: center; gap: 10px; max-width: min(320px, calc(100% - 2 * var(--gutter, 16px))); padding: 8px 14px 8px 12px; border-radius: 14px; pointer-events: none; user-select: none;
    opacity: 0; transform: translateY(-4px); transition: opacity 400ms ease-out, transform 400ms ease-out; }
  .rc.on { opacity: 1; transform: none; }
  .ic { display: inline-flex; color: #ffa7b6; }
  .tx { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
  b { font-size: 15px; font-weight: 800; }
  small { font-size: 12px; color: rgba(255, 255, 255, .8); }
</style>
