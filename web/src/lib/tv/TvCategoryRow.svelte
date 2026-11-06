<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** TV home: the genres as a row of large tiles (the top-bar "Categories" menu does not exist on TV) */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { t } from '#lib/i18n';
  import { categoryHref } from '#lib/mobile';

  let genres: string[] = [];
  onMount(async () => {
    try { genres = (((await api('/api/library/genres')).genres as string[]) ?? []).slice(0, 24); } catch { genres = []; }
  });
</script>

{#if genres.length}
  <section class="cr" aria-label={$t('shell.cats.title')}>
    <h2>{$t('shell.cats.title')}</h2>
    <div class="track" role="list">
      {#each genres as g (g)}
        <a class="cat" role="listitem" href={categoryHref('movies', g)}><span>{g}</span></a>
      {/each}
    </div>
  </section>
{/if}

<style>
  /* same rhythm as the rows (Row.svelte TV rules): --pad-x is the 56 px gutter on the home rows */
  .cr { position: relative; z-index: 1; margin: 1.6rem 0 0; padding-bottom: 1.4rem; --cw: calc((100vw - var(--tv-left) - 5vw) / 6.5); }
  .cr:focus-within { z-index: 4; }
  h2 { margin: 0 var(--pad-x) 1rem; font-size: 1.625rem; font-weight: 600; line-height: 1.2; color: var(--tv-white-88); }
  .track { display: flex; gap: .8rem; overflow-x: auto; scrollbar-width: none; padding: 1.4rem 5vw 1.4rem var(--pad-x); margin: -1.4rem 0; scroll-padding: 0 5vw 0 var(--pad-x); }
  .track::-webkit-scrollbar { display: none; }
  /* a text tile: the genre name on the flat placeholder surface, not a heavy poster word */
  .cat { flex: 0 0 var(--cw); aspect-ratio: 16 / 9; display: flex; align-items: flex-end; padding: 1rem 1.125rem; box-sizing: border-box; border-radius: var(--tv-radius); background: #1a1a1a; color: var(--tv-white-88); font-size: 1.375rem; font-weight: 600; line-height: 1.2; text-decoration: none; overflow: hidden; transition: transform var(--tv-t) var(--tv-ease); }
  .cat span { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cat:focus-visible { outline: none; box-shadow: var(--tv-card-ring); color: #fff; transform: scale(1.08); z-index: 6; }
</style>
