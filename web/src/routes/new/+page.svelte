<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '$lib/api';
  import Row from '$lib/Row.svelte';
  import Card from '$lib/Card.svelte';

  let movies: Item[] | null = null, series: Item[] | null = null, upcoming: Item[] | null = null;
  const items = (types: string) => api(`/api/library/items?types=${types}&sort=DateCreated&desc=true&limit=24`).then((r) => r.items as Item[]);
  onMount(() => {
    items('Movie').then((r) => (movies = r)).catch(() => (movies = []));
    items('Series').then((r) => (series = r)).catch(() => (series = []));
    api('/api/calendar').then((r) => (upcoming = r.items)).catch(() => (upcoming = []));
  });
</script>
<svelte:head><title>Neu &amp; beliebt – FriendFlix</title></svelte:head>
<h1>Neu &amp; beliebt</h1>
<div class="bleed">
  <Row title="Neue Filme" items={movies} />
  <Row title="Neue Serien" items={series} />
  {#if upcoming && upcoming.length}
    <section class="up">
      <h2>Demnächst</h2>
      <ul>
        {#each upcoming.slice(0, 12) as e}
          <li><span class="date">{e.premiereDate ? new Date(e.premiereDate).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short' }) : '–'}</span><a href="/item/{e.seriesId ?? e.id}"><b>{e.seriesName}</b> S{e.parentIndexNumber}:E{e.indexNumber} · {e.name}</a></li>
        {/each}
      </ul>
      <a class="btn sec" href="/calendar">Zum Kalender</a>
    </section>
  {/if}
</div>
<style>
  .bleed { margin: 0 calc(var(--pad-x) * -1); }
  h1 { margin-bottom: 0; }
  .up { padding: 3rem var(--pad-x) 4rem; position: relative; z-index: 2; } .up ul { list-style: none; padding: 0; margin: 0 0 1rem; max-width: 52rem; }
  .up li { display: flex; gap: 1rem; padding: .7rem 0; border-bottom: 1px solid var(--line); } .date { color: var(--mut); width: 7rem; flex: none; }
</style>
