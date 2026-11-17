<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Renders the open sheet of lib/requests/picker.ts: the season picker of a series or the collection sheet of a movie. Mounted once
   * in the root layout. The control that opened a sheet gets the focus back when it closes (when it still exists: a wish button
   * that turned into its new state moves the focus itself).
   */
  import { onMount, tick } from 'svelte';
  import CollectionSheet from './CollectionSheet.svelte';
  import SeasonSheet from './SeasonSheet.svelte';
  import { registerSheetHost, sheetRequest } from './picker';

  onMount(registerSheetHost);
  let back: HTMLElement | null = null, shown = 0;
  $: req = $sheetRequest;
  $: if (req && req.id !== shown) opened(req.id);
  $: if (!req && shown) closed();

  function opened(id: number) {
    if (!shown) back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shown = id;
  }
  function closed() {
    shown = 0;
    const el = back;
    back = null;
    void tick().then(() => {
      const a = document.activeElement;
      // only when the focus has nowhere better to be (it was inside the sheet that is leaving, or on the page body)
      if (el?.isConnected && (!a || a === document.body || a.closest('[aria-modal="true"]'))) el.focus({ preventScroll: true });
    });
  }
</script>

{#if req?.kind === 'seasons'}
  {#key req.id}<SeasonSheet tmdbId={req.tmdbId} title={req.title} />{/key}
{:else if req?.kind === 'collection'}
  {#key req.id}<CollectionSheet tmdbId={req.tmdbId} owned={req.owned ?? []} />{/key}
{/if}
