<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let resume: Item[] = [], next: Item[] = [], views: Item[] = [], latest: Record<string, Item[]> = {};
  let error = '', genres: string[] = [], rType = 'Movie', rGenre = '', rUnplayed = true, rMsg = '';
  async function surprise() {
    rMsg = '';
    const p = new URLSearchParams({ type: rType, unplayed: String(rUnplayed) });
    if (rGenre) p.set('genre', rGenre);
    try { location.href = `/item/${(await api(`/api/library/random?${p}`)).item.id}`; } catch { rMsg = 'Nichts Passendes gefunden – lockere die Filter.'; }
  }
  onMount(async () => {
    api('/api/library/genres').then((r) => (genres = r.genres)).catch(() => undefined);
    try {
      [resume, next, views] = await Promise.all([
        api('/api/library/resume').then((r) => r.items),
        api('/api/library/nextup').then((r) => r.items),
        api('/api/library/views').then((r) => r.items),
      ]);
      for (const v of views.slice(0, 6)) {
        api(`/api/library/items?parentId=${v.id}&sort=DateCreated&desc=true&limit=20`).then((r) => (latest[v.id] = r.items));
      }
    } catch { error = 'Bibliothek konnte nicht geladen werden.'; }
  });
</script>

{#if error}<p class="err">{error}</p>{/if}
<div class="panel flex">
  <b>🎲 Überrasch mich</b>
  <select bind:value={rType}><option value="Movie">Film</option><option value="Series">Serie</option></select>
  <select bind:value={rGenre}><option value="">Beliebiges Genre</option>{#each genres as g}<option>{g}</option>{/each}</select>
  <label><input type="checkbox" bind:checked={rUnplayed} /> nur Ungesehenes</label>
  <button on:click={surprise}>Los!</button>
  {#if rMsg}<span class="warn">{rMsg}</span>{/if}
</div>
{#if resume.length}<h2>Weiterschauen</h2><div class="row">{#each resume as i}<Card item={i} />{/each}</div>{/if}
{#if next.length}<h2>Nächste Folge</h2><div class="row">{#each next as i}<Card item={i} />{/each}</div>{/if}
{#each views as v}
  <h2><a href="/library/{v.id}">{v.name}</a></h2>
  <div class="row">{#each latest[v.id] ?? [] as i}<Card item={i} />{/each}</div>
{/each}
