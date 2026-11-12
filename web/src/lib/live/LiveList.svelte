<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { t, type TKey } from '#lib/i18n';
  import type { LiveChannel } from './api';
  import ChannelRow from './ChannelRow.svelte';
  import type { LiveFilter } from './order';

  /**
   * The channel grid (spec §11.1 item 3, §11.2): two columns of 72 px rows on a desktop (one column of 64 px rows on a phone).
   * While loading, skeleton rows of the final height stand in; an empty filter says why in one reserved line of text.
   */
  export let channels: LiveChannel[];
  export let now: Date;
  export let loading = false;
  /** the chip that is chosen, only to word the empty state */
  export let filter: LiveFilter = 'all';
  /** the person has no channel at all */
  export let none = false;

  const dispatch = createEventDispatcher<{ open: LiveChannel; star: LiveChannel }>();

  let empty: TKey;
  $: empty = filter === 'fav' ? 'live.emptyFav' : filter === 'recent' ? 'live.emptyRecent' : none ? 'live.empty' : 'live.emptyGroup';
</script>

<div class="list" aria-busy={loading ? 'true' : undefined}>
  {#if loading}
    <ul class="grid" aria-hidden="true">{#each Array(10) as _, k (k)}<li class="sk skeleton"></li>{/each}</ul>
  {:else if !channels.length}
    <p class="muted empty" role="status">{$t(empty)}</p>
  {:else}
    <ul class="grid" aria-label={$t('live.player.channelList')}>
      {#each channels as c (c.id)}
        <ChannelRow channel={c} {now} on:open={(e) => dispatch('open', e.detail)} on:star={(e) => dispatch('star', e.detail)} />
      {/each}
    </ul>
  {/if}
</div>

<style>
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px 1.4rem; margin: 0; padding: 0; list-style: none; }
  @media (min-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .sk { display: block; height: 72px; border-radius: 12px; }
  .empty { margin: 1.2rem 0; min-height: 44px; }
  @media (max-width: 720px) {
    .sk { height: 64px; }
  }
</style>
