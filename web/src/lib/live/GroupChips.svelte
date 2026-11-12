<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import SlidePill from '#lib/glass/SlidePill.svelte';
  import { SCRIM_SAFE_DIM } from '#lib/glass/tone';
  import { t } from '#lib/i18n';
  import type { LiveFilter } from './order';
  import type { LiveGroup } from './api';

  /**
   * The group chips (spec §11.1 item 2, §21): Alle, Favoriten, Zuletzt gesehen (only when the profile has watched a channel) and
   * the groups in order. They filter, they are not tabs: plain toggle buttons with `aria-pressed`, the selection on a sliding
   * pill (SlidePill). A glass bar that scrolls sideways when the chips do not fit; sticky under the header on phones.
   */
  export let groups: LiveGroup[];
  export let value: LiveFilter;
  /** show *Zuletzt gesehen* */
  export let recent = false;
  /** the groups have not arrived yet: the bar keeps its height */
  export let loading = false;

  const dispatch = createEventDispatcher<{ select: LiveFilter }>();
  let host: HTMLElement | undefined;

  $: chips = [
    { id: 'all', label: $t('live.all') },
    { id: 'fav', label: $t('live.favouritesChip') },
    ...(recent ? [{ id: 'recent', label: $t('live.recentChip') }] : []),
    ...groups.map((g) => ({ id: g.id, label: g.name })),
  ];
</script>

<div class="wrap">
  <div class="chips frost frost-pill frost-safe" style="--fr-scrim-safe:{SCRIM_SAFE_DIM}" role="group" aria-label={$t('live.groups')} aria-busy={loading ? 'true' : undefined} bind:this={host}>
    {#if loading}
      <span class="chip sk skeleton" aria-hidden="true"></span><span class="chip sk skeleton" aria-hidden="true"></span><span class="chip sk skeleton" aria-hidden="true"></span>
    {:else}
      {#each chips as c (c.id)}
        <button type="button" class="chip" class:on={value === c.id} aria-pressed={value === c.id} on:click={() => dispatch('select', c.id)}>{c.label}</button>
      {/each}
      {#if host}<SlidePill {host} selector={'.chip.on'} tone="white" />{/if}
    {/if}
  </div>
</div>

<style>
  .wrap { margin: 0 0 1rem; }
  .chips { display: inline-flex; max-width: 100%; box-sizing: border-box; gap: 4px; padding: 6px; overflow-x: auto; scrollbar-width: none; vertical-align: top; }
  .chips::-webkit-scrollbar { display: none; }
  /* 40 px tall in a 52 px bar; the hit area is 44 px (::after). The global coral button look is restated away. */
  .chip, .chip:hover:not(:disabled), .chip:active:not(:disabled) {
    position: relative; z-index: 1; flex: none; height: 40px; min-height: 40px; padding: 0 18px; margin: 0; background: transparent; border: 0; border-radius: 999px;
    color: rgba(255, 255, 255, .9); font-size: 15px; font-weight: 700; white-space: nowrap; transform: none;
  }
  .chip::after { content: ''; position: absolute; left: 0; right: 0; top: -2px; bottom: -2px; border-radius: inherit; }
  .chip.on, .chip.on:hover:not(:disabled) { color: #111; }
  .chip.sk { width: 84px; padding: 0; }
  @media (max-width: 720px) {
    /* sticky under the 56 px header: the glass bar stays over the scrolling list */
    .wrap { position: sticky; top: calc(var(--nav-total) + 6px); z-index: 20; }
  }
</style>
