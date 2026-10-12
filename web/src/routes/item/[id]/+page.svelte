<script lang="ts">
  import { pageStore } from '#lib/page';
  import type { Item } from '#lib/api';
  import DetailView from '#lib/detail/DetailView.svelte';
  const page = pageStore();

  let item: Item | null = null;
  $: id = $page.params.id ?? '';
</script>

<svelte:head><title>{item?.name ?? 'Titel'} – FriendFlix</title></svelte:head>
{#if id}<DetailView {id} variant="page" bind:item />{/if}
