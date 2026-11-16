<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The staged brand's symbol for Admin → Branding (the preview and the crop masks): the uploaded symbol, else the shell's own mark
   * (lib/Logo.svelte with the staged brand: FriendFlix's F tile, or the initial on the accent fill). Decorative. The colours come from
   * the custom properties around it (Preview.svelte sets the staged ones).
   */
  import Logo from '#lib/Logo.svelte';
  import type { LoadedBrand } from '#lib/brand';

  export let b: LoadedBrand;
  export let size = 32;
  /** fill the box (a crop mask cuts it; the mask's own fill hides the tile's corners): an upload without rounded corners */
  export let bleed = false;
</script>

{#if b.images.symbol}
  <img class="sym" class:bleed data-pv="symbol" src={b.images.symbol} alt="" width={size} height={size} style:width="{size}px" style:height="{size}px" draggable="false" />
{:else}
  <span class="own" class:bleed style:width="{size}px" style:height="{size}px"><Logo value={b} {size} label="" /></span>
{/if}

<style>
  .sym { display: block; flex: none; border-radius: 23%; object-fit: cover; }
  .own { display: inline-grid; place-items: center; flex: none; }
  .bleed.sym { border-radius: 0; }
</style>
