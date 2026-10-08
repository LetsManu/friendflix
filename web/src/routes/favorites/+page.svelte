<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';
  let items: Item[] = [];
  onMount(async () => (items = (await api('/api/library/items?filter=favorites&types=Movie,Series,Episode&limit=200')).items));
</script>
<h1>Favoriten</h1>
{#if !items.length}<p class="muted">Noch keine Favoriten.</p>{/if}
<div class="grid">{#each items as i}<Card item={i} />{/each}</div>
