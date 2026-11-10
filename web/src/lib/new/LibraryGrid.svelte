<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** "Neu in der Bibliothek": the titles added lately (series and films together, newest first) as a grid of posters with name and freshness. */
  import type { Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { t } from '#lib/i18n';
  import { runtimeLabel } from '#lib/mobile';
  import { freshText } from '#lib/newpage';
  import PosterCard from '#lib/PosterCard.svelte';
  import { mobile } from '#lib/viewport';

  export let items: Item[];
  export let now: number;
  export let title: string;
  export let sub = '';

  const meta = (it: Item) => [it.type === 'Movie' ? $t('home.meta.movie') : $t('home.meta.series'), it.type === 'Movie' ? runtimeLabel(it) : it.year].filter(Boolean).join(' · ');
</script>

<section class="lg" aria-labelledby="np-lg">
  <div class="hd"><h2 id="np-lg">{title}</h2>{#if sub}<span class="sub">{sub}</span>{/if}</div>
  <ul>
    {#each items as it (it.id)}
      <li>
        {#if $mobile}<PosterCard item={it} />{:else}<Card item={it} poster />{/if}
        <div class="note" data-testid="row-note"><b class="nm">{it.name}</b><span class="mt">{meta(it)}</span>{#if freshText(it.dateCreated, now, $t)}<span class="fresh">{freshText(it.dateCreated, now, $t)}</span>{/if}</div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .lg { min-width: 0; }
  .hd { display: flex; align-items: baseline; gap: .8rem; margin: 0 0 .9rem; }
  h2 { margin: 0; font-size: 1.3rem; font-weight: 800; letter-spacing: -.01em; line-height: 1.25; }
  .sub { color: var(--mut); font-size: .85rem; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 24px 16px; }
  li { min-width: 0; }
  .note { display: flex; flex-direction: column; gap: 1px; margin-top: .6rem; padding-inline: 2px; font-size: .8rem; line-height: 1.3; color: var(--mut); min-width: 0; }
  .nm { color: #fff; font-size: .92rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fresh { color: var(--acc-text); font-weight: 600; }
  @media (max-width: 1200px) { ul { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
  @media (max-width: 1000px) { ul { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 720px) { ul { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 8px; } .nm { font-size: .82rem; } }
  @media (max-width: 420px) { ul { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 10px; } }
</style>
