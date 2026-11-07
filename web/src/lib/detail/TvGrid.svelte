<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script context="module" lang="ts">
  import type { Item } from '#lib/api';
  /** one tile of a TV sub-screen grid: a title (Card) or a part that is not in the library (a placeholder, not focusable) */
  export type GridEntry = { key: string; name: string; line: string; item?: Item; to?: string; missing?: { poster?: string } };
</script>
<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '#lib/i18n';
  import { followFocus } from '#lib/tv/follow';
  import Card from '#lib/Card.svelte';

  /**
   * TV sub-screen card grid (More like this, Collection, Extras; spec 3): the same TV cards as the home rows, five per row on
   * the 152 px edge (posters: seven), in a window that glides when the focus walks past its edge. The line above the grid names
   * the focused tile and says why it is here (More like this: the recommendation reason) or what it is.
   */
  /** null = loading */
  export let entries: GridEntry[] | null;
  export let poster = false;
  export let label = '';

  let cur = 0, grid: HTMLElement | undefined;
  $: shownEntry = entries?.[Math.min(cur, entries.length - 1)] ?? null;
  function onFocus(e: FocusEvent) {
    const i = Number((e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i);
    if (Number.isInteger(i)) cur = i;
  }
  // the screen opens on the first tile once the list is there (unless the focus was placed meanwhile: Back restores a tile)
  let placed = false;
  $: if (entries?.length && grid && !placed) place();
  function place() {
    placed = true;
    void tick().then(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.closest('main')) return;
      grid?.querySelector<HTMLElement>('.card a.thumb')?.focus({ preventScroll: true });
    });
  }
</script>

<div class="tg" class:poster>
  <div class="focusline" aria-live="polite">
    {#if shownEntry}
      <p class="nm">{shownEntry.name}</p>
      <p class="tv-meta ln">{shownEntry.line}</p>
    {/if}
  </div>
  <div class="win" use:followFocus={{ peek: 0.3 }}>
    <ul class="grid" aria-label={label} aria-busy={entries === null} bind:this={grid} on:focusin={onFocus}>
      {#if entries === null}
        {#each Array(poster ? 7 : 5) as _, k (k)}<li class="ph" aria-hidden="true"><div class="skeleton"></div></li>{/each}
      {:else if !entries.length}
        <li class="none tv-meta">{$t('tv.sub.none')}</li>
      {:else}
        {#each entries as en, i (en.key)}
          <li data-follow data-i={i}>
            {#if en.item}
              <Card item={en.item} {poster} to={en.to ?? ''} />
            {:else}
              <div class="miss" role="img" aria-label="{en.name}, {$t('detail.collection.missing')}">
                {#if en.missing?.poster}<img src={en.missing.poster} alt="" loading="lazy" decoding="async" />{/if}
                <span class="mt">{$t('detail.collection.missing')}</span>
              </div>
            {/if}
            {#if poster || !en.item}<span class="cap">{en.name}</span>{/if}
          </li>
        {/each}
      {/if}
    </ul>
  </div>
</div>

<style>
  .tg { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; --cols: 5; --gap: 1.2rem; }
  .tg.poster { --cols: 7; }
  /* the focused tile's name and its reason / facts: one calm line pair above the grid, it changes in place */
  .focusline { flex: none; min-height: 3.6rem; margin: 0 0 1.2rem; }
  .nm { margin: 0; font-size: 1.3rem; font-weight: 600; line-height: 1.25; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(html.tv) .ln { margin: .3rem 0 0; font-size: 1.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.3em; }

  .win { flex: 1 1 auto; min-height: 0; margin: 0 -2rem; padding: 1.4rem 2rem 5vh; overflow-x: visible; overflow-y: clip; }
  /* Chromium < 90 (webOS 22) has no overflow: clip: hidden instead (the window's scroll is held at 0, see tv/clip.ts) */
  @supports not (overflow: clip) { .win { overflow: hidden; } }
  .win:global(.below) { -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 9rem), transparent calc(100% - 5vh)); mask-image: linear-gradient(180deg, #000 calc(100% - 9rem), transparent calc(100% - 5vh)); }
  .win:global(.above) { -webkit-mask-image: linear-gradient(0deg, #000 calc(100% - 3rem), transparent); mask-image: linear-gradient(0deg, #000 calc(100% - 3rem), transparent); }
  .win:global(.above.below) { -webkit-mask-image: linear-gradient(180deg, transparent, #000 3rem, #000 calc(100% - 9rem), transparent calc(100% - 5vh)); mask-image: linear-gradient(180deg, transparent, #000 3rem, #000 calc(100% - 9rem), transparent calc(100% - 5vh)); }
  /* five 16:9 cards per row at 1080p (seven posters); the row gap leaves room for the focus scale */
  .grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 2rem var(--gap); }
  .grid > li { position: relative; min-width: 0; }
  .grid > li:focus-within { z-index: 2; }
  .ph .skeleton { aspect-ratio: 16 / 9; }
  .poster .ph .skeleton { aspect-ratio: 2 / 3; }
  .none { grid-column: 1 / -1; }
  /* posters and placeholders carry their name under the image (the 16:9 cards rely on their artwork and the line above) */
  .cap { display: block; margin-top: .6rem; font-size: .9375rem; font-weight: 500; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* a part that is not in the library: a dim placeholder, not a target */
  .miss { position: relative; aspect-ratio: 16 / 9; border-radius: var(--tv-radius, 6px); overflow: hidden; background: #141414; display: grid; place-items: center; }
  .poster .miss { aspect-ratio: 2 / 3; }
  .miss img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .35; }
  .mt { position: relative; padding: 1rem; font-size: .9375rem; font-weight: 600; letter-spacing: .02em; color: var(--mut); text-align: center; }
</style>
