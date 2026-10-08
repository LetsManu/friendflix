<script lang="ts">
  import { page } from '$app/stores';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let items: Item[] | null = null, total = 0, start = 0, sort = 'SortName', filter = '', q = '', busy = false;
  const PAGE = 60;
  async function load(reset = true) {
    busy = true;
    if (reset) { start = 0; items = null; }
    const p = new URLSearchParams({ parentId: $page.params.id!, sort, limit: String(PAGE), start: String(start) });
    if (sort === 'DateCreated' || sort === 'CommunityRating') p.set('desc', 'true');
    if (filter) p.set('filter', filter);
    if (q) p.set('q', q);
    try { const r = await api(`/api/library/items?${p}`); items = [...(items ?? []), ...r.items]; total = r.total; start += PAGE; } catch { items = items ?? []; }
    busy = false;
  }
  $: if ($page.params.id) load();
</script>
<div class="flex" style="margin-bottom:1.2rem">
  <input aria-label="In dieser Bibliothek suchen" placeholder="In dieser Bibliothek suchen" bind:value={q} on:change={() => load()} />
  <select aria-label="Sortierung" bind:value={sort} on:change={() => load()}><option value="SortName">A–Z</option><option value="DateCreated">Zuletzt hinzugefügt</option><option value="PremiereDate">Erscheinungsdatum</option><option value="CommunityRating">Beliebtheit</option></select>
  <select aria-label="Filter" bind:value={filter} on:change={() => load()}><option value="">Alle</option><option value="unplayed">Ungesehen</option><option value="played">Gesehen</option><option value="favorites">Favoriten</option></select>
</div>
<div class="tiles">
  {#if items === null}{#each Array(12) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}{:else}{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}{/if}
</div>
{#if items && items.length < total}<p style="text-align:center"><button class="sec" disabled={busy} on:click={() => load(false)}>Mehr laden</button></p>{/if}
