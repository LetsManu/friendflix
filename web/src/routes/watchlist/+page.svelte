<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';
  let items: Item[] = [];
  onMount(async () => (items = (await api('/api/watchlist')).items));
</script>
<h1>Watchlist</h1>
{#if !items.length}<p class="muted">Deine Watchlist ist leer.</p>{/if}
<div class="grid">{#each items as i}<Card item={i} />{/each}</div>
