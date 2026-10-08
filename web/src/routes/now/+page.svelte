<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api, img } from '$lib/api';
  let items: any[] = [], t: ReturnType<typeof setInterval>;
  const load = async () => (items = (await api('/api/nowplaying')).items);
  onMount(() => { load(); t = setInterval(load, 5000); });
  onDestroy(() => clearInterval(t));
</script>
<h1>Läuft gerade</h1>
{#if !items.length}<p class="muted">Gerade schaut niemand etwas.</p>{/if}
<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
  {#each items as i}
    <div class="panel"><div class="flex"><img src={img(i.itemId, 120)} alt="" style="width:60px;border-radius:4px" />
      <div><b>{i.user}</b><br />{i.seriesName ? i.seriesName + ' – ' : ''}{i.title}<br /><span class="muted">{i.isPaused ? 'Pausiert' : 'Läuft'}</span></div></div>
      {#if i.runtimeTicks}<div class="bar" style="margin-top:.6rem"><i style="width:{Math.min(100, (i.positionTicks / i.runtimeTicks) * 100)}%"></i></div>{/if}</div>
  {/each}
</div>
