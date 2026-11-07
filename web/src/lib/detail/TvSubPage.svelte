<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import type { Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import DetailView from '#lib/detail/DetailView.svelte';
  import type { TvSubId } from '#lib/detail/TvSub.svelte';

  /**
   * The route body of a TV detail sub-screen (/item/[id]/episodes, /more, /info, /extras, /collection, /story; spec 3): the
   * detail view (same loads) showing that screen. They are routes so Back and history work. TV-first: outside TV mode the
   * detail page itself replaces the URL (no extra history entry), since the scrolling page shows all of this already.
   */
  export let sub: TvSubId;
  const page = pageStore();
  $: id = $page.params.id ?? '';
  let item: Item | null = null;
  // the layout sets html.tv before the page mounts (a TV never renders early, lib/gate.ts canRenderEarly)
  const tv = typeof document !== 'undefined' && document.documentElement.classList.contains('tv');
  onMount(() => { if (!tv && id) void goto(`/item/${id}`, { replaceState: true }); });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: item?.name ?? $t('detail.view.pageTitle') })}</title></svelte:head>
{#if tv && id}<DetailView {id} variant="tv" {sub} bind:item />{/if}
