<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let resume: Item[] = [], next: Item[] = [], views: Item[] = [], latest: Record<string, Item[]> = {};
  let error = '';
  onMount(async () => {
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
{#if resume.length}<h2>Weiterschauen</h2><div class="row">{#each resume as i}<Card item={i} />{/each}</div>{/if}
{#if next.length}<h2>Nächste Folge</h2><div class="row">{#each next as i}<Card item={i} />{/each}</div>{/if}
{#each views as v}
  <h2><a href="/library/{v.id}">{v.name}</a></h2>
  <div class="row">{#each latest[v.id] ?? [] as i}<Card item={i} />{/each}</div>
{/each}
