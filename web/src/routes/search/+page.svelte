<script lang="ts">
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';
  let q = '', items: Item[] = [], searched = false, t: ReturnType<typeof setTimeout>;
  function onInput() {
    clearTimeout(t);
    t = setTimeout(async () => {
      if (q.trim().length < 2) { items = []; searched = false; return; }
      items = (await api(`/api/library/items?q=${encodeURIComponent(q)}&types=Movie,Series,Episode&limit=60`)).items;
      searched = true;
    }, 300);
  }
</script>
<h1>Suche</h1>
<input placeholder="Film oder Serie …" bind:value={q} on:input={onInput} style="width:100%;max-width:480px" />
{#if searched && !items.length}<p class="muted">Nichts gefunden. <a href="/requests?q={encodeURIComponent(q)}" style="text-decoration:underline">Wunsch stellen?</a></p>{/if}
<div class="grid" style="margin-top:1rem">{#each items as i}<Card item={i} />{/each}</div>
