<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';
  let items: Item[] | null = null;
  onMount(() => { api('/api/watchlist').then((r) => r.items).then((r: Item[]) => (items = r)).catch(() => (items = [])); });
</script>
<svelte:head><title>Meine Liste – FriendFlix</title></svelte:head>
<h1>Meine Liste</h1>
{#if items === null}<div class="tiles">{#each Array(8) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else if !items.length}<p class="muted">Noch nichts hier. Füge Titel über das Plus hinzu.</p>
{:else}<div class="tiles">{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}</div>{/if}
