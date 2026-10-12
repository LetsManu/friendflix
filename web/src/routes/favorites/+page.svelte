<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  let items: Item[] | null = null;
  onMount(() => { api('/api/library/items?filter=favorites&types=Movie,Series,Episode&limit=200').then((r) => r.items).then((r: Item[]) => (items = r)).catch(() => (items = [])); });
  /** un-favouriting through a card takes it off this page */
  const unfav = (e: CustomEvent<{ item: Item; favorite: boolean }>) => { if (!e.detail.favorite) items = (items ?? []).filter((x) => x.id !== e.detail.item.id); };
</script>
<svelte:head><title>Favoriten – FriendFlix</title></svelte:head>
<h1>Favoriten</h1>
{#if items === null}<div class="tiles">{#each Array(8) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if !items.length}<p class="muted">Noch nichts hier. Markiere Titel mit dem Herz, um sie hier zu sammeln.</p>
{:else}<div class="tiles">{#each items as i (i.id)}<div class="slot"><Card item={i} on:favchange={unfav} /></div>{/each}</div>{/if}
