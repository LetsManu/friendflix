<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * User detail, activity tab: recently watched titles of every profile. Mounted only while the tab is open, and every
   * load writes an audit entry (the backend records who looked), which the note says.
   */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import DataTable from '#lib/ui/DataTable.svelte';
  import type { Column } from '#lib/ui/table';

  export let userId: string;
  interface Item { id: string; name: string; type: string; seriesName?: string; parentIndexNumber?: number; indexNumber?: number; lastPlayedDate?: string; profile: { id: string; name: string } }

  let rows: Item[] | null = null, skipped = 0, error: string | null = null;
  async function load() {
    try {
      const r = await api<{ items: Item[]; skipped: string[] }>(`/api/admin/users/${userId}/activity`);
      rows = r.items; skipped = r.skipped.length; error = null;
    } catch {
      error = tr('adminPeople.loadFailed');
    }
  }
  onMount(load);
  function retry() { error = null; rows = null; void load(); }

  $: columns = [
    { key: 'title', label: $t('adminPeople.detail.activity.col.title'), primary: true },
    { key: 'profile', label: $t('adminPeople.detail.activity.col.profile') },
    { key: 'when', label: $t('adminPeople.detail.activity.col.when') },
  ] satisfies Column<Item>[];
  const episode = (i: Item): string => (i.parentIndexNumber !== undefined && i.indexNumber !== undefined
    ? tr('adminPeople.detail.activity.episode', { series: i.seriesName ?? '', season: i.parentIndexNumber, episode: i.indexNumber }) : i.seriesName ?? '');
</script>

<p class="note"><Icon name="info" size={16} />{$t('adminPeople.detail.activity.note')}</p>
{#if skipped}<p class="note warn" role="status">{$t('adminPeople.detail.activity.skipped', { n: skipped })}</p>{/if}

<DataTable caption={$t('adminPeople.detail.tabs.activity')} {rows} {columns} key={(i) => `${i.profile.id}:${i.id}`} pageSize={25} {error} emptyText={$t('adminPeople.detail.activity.empty')} on:retry={retry}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'title'}
      {#if row.seriesName}<span class="n">{row.name}</span> <span class="sub">{episode(row)}</span>{:else}<span class="n">{row.name}</span>{/if}
    {:else if col.key === 'profile'}{row.profile.name}
    {:else if col.key === 'when'}
      {#if row.lastPlayedDate}<time datetime={row.lastPlayedDate} title={fmtDateTime(row.lastPlayedDate)}>{fmtRelative(row.lastPlayedDate)}</time>{/if}
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .note { display: flex; align-items: center; gap: .4rem; margin: 0 0 .8rem; color: var(--mut); font-size: .9rem; }
  .note :global(svg) { flex: none; }
  .note.warn { color: var(--warn); }
  .n { font-weight: 600; }
  .sub { color: var(--mut); font-weight: 400; }
  time { white-space: nowrap; }
</style>
