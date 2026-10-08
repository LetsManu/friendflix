<script lang="ts">
  import { page } from '$app/stores';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let items: Item[] = [], total = 0, start = 0, sort = 'SortName', filter = '', q = '';
  const PAGE = 60;
  async function load(reset = true) {
    if (reset) { start = 0; items = []; }
    const p = new URLSearchParams({ parentId: $page.params.id!, sort, limit: String(PAGE), start: String(start) });
    if (sort === 'DateCreated' || sort === 'CommunityRating') p.set('desc', 'true');
    if (filter) p.set('filter', filter);
    if (q) p.set('q', q);
    const r = await api(`/api/library/items?${p}`);
    items = [...items, ...r.items]; total = r.total; start += PAGE;
  }
  $: if ($page.params.id) load();
</script>

<div class="flex">
  <input placeholder="In dieser Bibliothek suchen" bind:value={q} on:change={() => load()} />
  <select bind:value={sort} on:change={() => load()}>
    <option value="SortName">Name</option><option value="DateCreated">Neu hinzugefügt</option>
    <option value="PremiereDate">Erscheinungsdatum</option><option value="CommunityRating">Bewertung</option>
  </select>
  <select bind:value={filter} on:change={() => load()}>
    <option value="">Alle</option><option value="unplayed">Ungesehen</option><option value="played">Gesehen</option><option value="favorites">Favoriten</option>
  </select>
</div>
<div class="grid" style="margin-top:1rem">{#each items as i}<Card item={i} />{/each}</div>
{#if items.length < total}<p><button on:click={() => load(false)}>Mehr laden</button></p>{/if}
