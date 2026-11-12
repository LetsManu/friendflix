<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Programmführer*, Phase 1 (spec §9.4): only the automatic match counts, "398 von 412 Sendern mit Programm · 14 ohne".
   * The line keeps its height while the numbers load, so nothing moves when they arrive. (The list of channels without a programme,
   * the suggestions and the own entries are Phase 2.)
   */
  import { onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { loadCounts, matchLine, type EpgCounts } from './status';

  let counts: EpgCounts | null = null, failed = false;
  async function load() {
    failed = false;
    try { counts = await loadCounts(); } catch { failed = true; }
  }
  onMount(load);
</script>

<AdminCard title={$t('adminLive.epg.title')}>
  <div class="line" aria-live="polite">
    {#if counts}
      <p class="count" data-guide-counts>{matchLine(counts)}</p>
    {:else if failed}
      <p class="err" role="alert"><Icon name="alert" size={18} /><span>{$t('adminLive.epg.loadFailed')}</span><Button variant="secondary" size="sm" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></p>
    {:else}
      <Skeleton w="22rem" h="1.4rem" />
    {/if}
  </div>
  <p class="hint">{$t('adminLive.epg.hint')}</p>
</AdminCard>

<style>
  .line { min-height: 2.75rem; display: flex; align-items: center; }
  .count { margin: 0; font-size: 1.15rem; font-weight: 600; }
  .err { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin: 0; }
  .err :global(svg) { color: var(--err); flex: none; }
  .hint { margin: .4rem 0 0; color: var(--mut); }
</style>
