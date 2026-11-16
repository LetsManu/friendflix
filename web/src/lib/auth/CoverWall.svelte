<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The sign-in background (spec Part C "Cover wall"): 5 tilted columns of small covers from the library, moving slowly up and down in
   * turn, dimmed toward the card. Decorative only: hidden from assistive technology, nothing focusable, no titles.
   * Covers come from the public `GET /api/public/login-art` (same-origin paths); without them (wall off, empty library, setup's 503, an
   * outage: any non-200) the wall shows generated colour tiles from the app's palette. Still under `prefers-reduced-motion`.
   * The brand chooses the background (`mode`): `posters` is this wall; `image` its own uploaded sign-in image, dimmed by the same shade
   * (without the image: the wall); `color` just the glow behind the wall, nothing fetched.
   */
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { brand, brandKnown, brandPalette, type BrandSignInBg } from '#lib/brand';
  import { artPaths, fallbackArt, wallColumns } from './flow';

  export let mode: BrandSignInBg = 'posters';
  /** the uploaded sign-in image (a same-origin, content-hashed URL of the public brand route) */
  export let image: string | null = null;
  $: shown = mode === 'image' && image ? 'image' : mode === 'color' ? 'color' : 'posters';
  /** the brand was known before the first paint (a cached one, every visit but the first): the background shows at once, as always */
  const late = !get(brandKnown);
  /** the warm glow behind the wall follows the accent (today's wine tone by default) */
  $: pal = brandPalette($brand.tokens);

  const COLS = 5;
  /** per column (from the mockup): durations alternate with the direction */
  const DURATIONS = [48, 58, 44, 51, 59] as const;
  const FALLBACK_PER_COL = 8;

  let columns: string[][] = [];
  let loaded = false;
  // generated tiles: the same for everyone on a given day, so the wall does not flicker between loads
  // (their bright colours follow the accent: the brand's palette, today's corals by default)
  const day = Math.floor(Date.now() / 86_400_000) * 7;
  $: fallback = Array.from({ length: COLS }, (_, c) => {
    const tiles = fallbackArt(day + c, FALLBACK_PER_COL, pal.art, pal.wall);
    return [...tiles, ...tiles];
  });

  // the covers are fetched once the wall is known to be the background: after the brand is known (cached, or the first answer), so a
  // brand with its own image or just the glow never fetches them, and a first visit does not flash covers it will not show
  const ctl = new AbortController();
  let started = false, mounted = false;
  function fetchCovers() {
    started = true;
    void (async () => {
      try {
        const r = await fetch('/api/public/login-art', { credentials: 'same-origin', signal: ctl.signal });
        if (r.status === 200) columns = wallColumns(artPaths(await r.json()), COLS);
      } catch { /* offline or no JSON: generated tiles */ }
      loaded = true;
    })();
  }
  $: if (mounted && $brandKnown && shown === 'posters' && !started) fetchCovers();
  onMount(() => {
    mounted = true;
    return () => ctl.abort();
  });
  /** a cover that does not load leaves its tile empty (the tile keeps the column's rhythm) */
  const hide = (e: Event) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden');
</script>

<div class="wall" class:late aria-hidden="true" style:--wall-glow={pal.wall} data-wall={!$brandKnown ? 'loading' : shown !== 'posters' ? shown : columns.length ? 'covers' : loaded ? 'generated' : 'loading'}>
  {#if !$brandKnown}
    <!-- the brand is not known yet (a first visit, for a moment): the plain glow, then the chosen background fades in -->
  {:else if shown === 'image'}
    <img class="own" src={image} alt="" aria-hidden="true" draggable="false" decoding="async" />
  {:else if shown === 'posters'}
  <div class="tiles">
    {#if columns.length}
      {#each columns as col, c (c)}
        <div class="col" class:down={c % 2 === 1} style="animation-duration:{DURATIONS[c % DURATIONS.length]}s">
          {#each col as src, i (i)}
            <i class="tile"><img {src} loading="lazy" decoding="async" alt="" aria-hidden="true" draggable="false" on:error={hide} /></i>
          {/each}
        </div>
      {/each}
    {:else}
      {#each fallback as col, c (c)}
        <div class="col" class:down={c % 2 === 1} style="animation-duration:{DURATIONS[c % DURATIONS.length]}s">
          {#each col as t, i (i)}
            <i class="tile art" style="background:linear-gradient({t.angle}deg,{t.from},{t.to})"></i>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
  {/if}
  <div class="shade"></div>
</div>

<style>
  .wall { position: absolute; inset: 0; overflow: hidden; pointer-events: none; user-select: none;
    background: radial-gradient(120% 70% at 20% 0%, var(--wall-glow) 0%, transparent 60%), radial-gradient(90% 60% at 100% 30%, #16323a 0%, transparent 60%), var(--bg); }
  /* the brand's own sign-in image: fills the screen behind the same shade as the wall (it never moves) */
  .own { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .tiles { position: absolute; inset: -20%; display: flex; gap: 8px; opacity: .55; transform: rotate(-10deg); }
  .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; animation: wall-up linear infinite; will-change: transform; }
  .col.down { animation-name: wall-down; }
  @keyframes wall-up { from { transform: translateY(0); } to { transform: translateY(-50%); } }
  @keyframes wall-down { from { transform: translateY(-50%); } to { transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .col { animation: none; } }
  /* a first visit: the background the brand chose fades in once the brand is known (opacity only) */
  .late :is(.tiles, .own) { animation: wall-in 400ms ease-out both; }
  @keyframes wall-in { from { opacity: 0; } }
  .tile { display: block; flex: none; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; background: var(--surface-2); }
  .tile img { display: block; width: 100%; height: 100%; object-fit: cover; }
  /* phone: the card sits at the bottom, the wall dims toward it (mockup values) */
  .shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(16, 20, 24, .25) 0%, rgba(16, 20, 24, .55) 35%, rgba(16, 20, 24, .9) 70%, var(--bg) 100%); }
  /* desktop: the card is centred, the wall dims toward the middle */
  @media (min-width: 640px) {
    .shade { background: radial-gradient(ellipse 60% 70% at 50% 50%, rgba(16, 20, 24, .9) 0%, rgba(16, 20, 24, .55) 55%, rgba(16, 20, 24, .25) 100%); }
  }
</style>
