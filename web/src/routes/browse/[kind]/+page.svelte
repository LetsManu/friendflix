<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let items: Item[] | null = null, total = 0, start = 0, genres: string[] = [], busy = false;
  const PAGE = 60;
  $: kind = $page.params.kind === 'series' ? 'Series' : 'Movie';
  $: genre = $page.url.searchParams.get('genre') ?? '';
  $: sort = $page.url.searchParams.get('sort') ?? 'SortName';
  $: filter = $page.url.searchParams.get('filter') ?? '';

  async function load(reset: boolean) {
    busy = true;
    if (reset) { start = 0; items = null; }
    const p = new URLSearchParams({ types: kind, sort, limit: String(PAGE), start: String(start) });
    if (sort === 'DateCreated' || sort === 'CommunityRating') p.set('desc', 'true');
    if (genre) p.set('genre', genre);
    if (filter) p.set('filter', filter);
    try {
      const r = await api(`/api/library/items?${p}`);
      items = [...(items ?? []), ...r.items]; total = r.total; start += PAGE;
    } catch { items = items ?? []; }
    busy = false;
  }
  $: kind, genre, sort, filter, load(true);
  $: if (!genres.length) api('/api/library/genres').then((r) => (genres = r.genres)).catch(() => undefined);

  function set(key: string, value: string) {
    const u = new URL($page.url);
    if (value) u.searchParams.set(key, value); else u.searchParams.delete(key);
    goto(u, { keepFocus: true, noScroll: true });
  }
</script>

<svelte:head><title>{kind === 'Series' ? 'Serien' : 'Filme'} – FriendFlix</title></svelte:head>
<div class="flex head">
  <h1>{kind === 'Series' ? 'Serien' : 'Filme'}</h1>
  <label class="sr-only" for="g">Genre</label>
  <select id="g" value={genre} on:change={(e) => set('genre', e.currentTarget.value)}><option value="">Alle Genres</option>{#each genres as g}<option>{g}</option>{/each}</select>
  <label class="sr-only" for="s">Sortierung</label>
  <select id="s" value={sort} on:change={(e) => set('sort', e.currentTarget.value)}>
    <option value="SortName">A–Z</option><option value="DateCreated">Zuletzt hinzugefügt</option><option value="PremiereDate">Erscheinungsdatum</option><option value="CommunityRating">Beliebtheit</option>
  </select>
  <select value={filter} aria-label="Filter" on:change={(e) => set('filter', e.currentTarget.value)}><option value="">Alle</option><option value="unplayed">Ungesehen</option><option value="played">Gesehen</option><option value="favorites">Favoriten</option></select>
</div>
<div class="tiles">
  {#if items === null}{#each Array(18) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}
  {:else}{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}{/if}
</div>
{#if items && !items.length}<p class="muted">Nichts gefunden – probiere andere Filter.</p>{/if}
{#if items && items.length < total}<p style="text-align:center"><button class="sec" disabled={busy} on:click={() => load(false)}>Mehr laden</button></p>{/if}

<style>.head { margin-bottom: 1.2rem; } .head h1 { margin: 0 1rem 0 0; }</style>
