<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One role select for invites and approvals: the catalogue's invitable roles in catalogue order (plus Admin with
   * `includeAdmin`), each with its one-line summary ("Oma · 2 Streams · ab 12 · Downloads aus"). Built on Select.
   */
  import Select from '#lib/ui/Select.svelte';
  import { roleName, summaryLine, type MatrixRole } from './rights/model';

  export let roles: MatrixRole[] = [];
  export let value = '';
  export let includeAdmin = false;
  export let label: string;
  export let hint = '';

  $: options = [...roles]
    .filter((r) => (r.key === 'admin' ? includeAdmin : r.invitable))
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ value: r.key, label: `${roleName(r)} · ${summaryLine(r)}` }));
</script>

<Select {label} {hint} {options} bind:value on:change />
