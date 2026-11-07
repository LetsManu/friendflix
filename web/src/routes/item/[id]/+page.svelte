<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  import type { Item } from '#lib/api';
  import DetailView from '#lib/detail/DetailView.svelte';
  import { t } from '#lib/i18n';
  const page = pageStore();

  let item: Item | null = null;
  $: id = $page.params.id ?? '';
  // TV mode (html.tv, set by the layout once /api/me answered): the scroll-free TV detail page
  let tv = typeof document !== 'undefined' && document.documentElement.classList.contains('tv');
  onMount(() => {
    const sync = () => { tv = document.documentElement.classList.contains('tv'); };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: item?.name ?? $t('detail.view.pageTitle') })}</title></svelte:head>
{#if id}<DetailView {id} variant={tv ? 'tv' : 'page'} bind:item />{/if}
