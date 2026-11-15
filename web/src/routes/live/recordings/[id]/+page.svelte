<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { page } from '$app/stores';
  import { t } from '#lib/i18n';
  import { getRecording, type Recording } from '#lib/live/recordings';

  /** A recording's page (Phase 3 Task 8 entry point; Task 9 puts the player here). */
  let rec: Recording | null = null;
  $: id = $page.params.id ?? '';
  $: if (id) void getRecording(id).then((r) => (rec = r)).catch(() => (rec = null));
</script>

<svelte:head><title>{$t('common.pageTitle', { page: rec?.title ?? $t('live.myRecordings') })}</title></svelte:head>
<h1>{rec?.title ?? ''}</h1>
