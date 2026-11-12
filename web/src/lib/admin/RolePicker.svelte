<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One role select for invites and approvals: the catalogue's invitable roles in catalogue order (plus Admin with
   * `includeAdmin`), each with its one-line summary ("Oma · 2 Streams · ab 12 · Downloads aus"). Built on Select.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { roleName, summaryLine, type MatrixRole } from './rights/model';

  export let roles: MatrixRole[] = [];
  export let value = '';
  export let includeAdmin = false;
  export let label: string;
  export let hint = '';
  /** the catalogue is loading or failed to load: the select stays disabled (no role can be granted blind); a failure offers a retry */
  export let state: 'ready' | 'loading' | 'error' = 'ready';
  const dispatch = createEventDispatcher<{ retry: void }>();

  $: options = [...roles]
    .filter((r) => (r.key === 'admin' ? includeAdmin : r.invitable))
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ value: r.key, label: `${roleName(r)} · ${summaryLine(r)}` }));
</script>

<div class="rp">
  <Select {label} hint={state === 'loading' ? $t('adminPeople.rolesLoading') : hint} {options} bind:value disabled={state !== 'ready'} error={state === 'error' ? $t('adminPeople.loadFailed') : ''} on:change />
  {#if state === 'error'}<Button variant="secondary" icon="refresh" on:click={() => dispatch('retry')}>{$t('ui.retry')}</Button>{/if}
</div>

<style>
  .rp { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; min-width: 0; }
  .rp :global(.field) { align-self: stretch; }
</style>
