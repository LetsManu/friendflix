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
  .cr { position: relative; z-index: 1; margin: 2.2rem 0 0; --cw: calc((100vw - 96px - 5vw) / 6.5); }
  .cr:focus-within { z-index: 4; }
  h2 { margin: 0 0 .6rem; font-size: 1.75rem; font-weight: 700; }
  .track { display: flex; gap: .8rem; overflow-x: auto; scrollbar-width: none; padding: 1.4rem 5vw 1.4rem 1.4rem; margin: -1.4rem 0 -1.4rem -1.4rem; scroll-padding: 0 5vw 0 1.4rem; }
  .track::-webkit-scrollbar { display: none; }
  .cat { flex: 0 0 var(--cw); aspect-ratio: 16 / 9; display: grid; place-items: center; padding: 1rem; text-align: center; border-radius: var(--tv-radius); background: linear-gradient(135deg, #242b33, #151a20); color: #fff; font-size: 2rem; font-weight: 800; line-height: 1.1; text-decoration: none; overflow: hidden; transition: transform var(--tv-t) var(--tv-ease); }
  .cat span { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cat:focus-visible { transform: scale(1.08); z-index: 6; }
</style>
