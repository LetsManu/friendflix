<script lang="ts">
  import { page } from '$app/stores';
  import { api, backdrop, fmtMin, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let ratings: any[] = [], avg: number | null = null, stars = 0, review = '', followed = false;
  let item: Item | null = null, inWatchlist = false, seasons: Item[] = [], episodes: Item[] = [], season = '', next: Item | null = null;

  async function load(id: string) {
    const r = await api(`/api/items/${id}`);
    item = r.item; inWatchlist = r.inWatchlist;
    const rr = await api(`/api/items/${id}/ratings`); ratings = rr.ratings; avg = rr.average;
    const mine = ratings.find((x) => x.mine); stars = mine?.stars ?? 0; review = mine?.review ?? '';
    if (item!.type === 'Series') followed = (await api(`/api/series/${id}/follow`)).followed;
    if (item!.type === 'Series') {
      seasons = (await api(`/api/items/${id}/seasons`)).items;
      season = seasons[0]?.id ?? '';
      next = (await api(`/api/library/nextup`)).items.find((e: Item) => e.seriesId === id) ?? null;
    }
  }
  $: if ($page.params.id) load($page.params.id);
  $: if (item?.type === 'Series' && season) api(`/api/items/${item.id}/episodes?seasonId=${season}`).then((r) => (episodes = r.items));

  async function rate() {
    if (!item || !stars) return;
    await api(`/api/items/${item.id}/rating`, { method: 'PUT', body: { stars, review: review || undefined } });
    const rr = await api(`/api/items/${item.id}/ratings`); ratings = rr.ratings; avg = rr.average;
  }
  async function toggleFollow() { await api(`/api/series/${item!.id}/follow`, { method: followed ? 'DELETE' : 'POST' }); followed = !followed; }
  async function toggle(kind: 'favorite' | 'played' | 'watchlist') {
    if (!item) return;
    const on = kind === 'favorite' ? item.favorite : kind === 'played' ? item.played : inWatchlist;
    await api(`/api/items/${item.id}/${kind}`, { method: on ? 'DELETE' : 'POST' });
    if (kind === 'favorite') item.favorite = !on; else if (kind === 'played') item.played = !on; else inWatchlist = !on;
  }
</script>

{#if item}
  <div class="panel" style={item.backdrop ? `background:linear-gradient(90deg,#181a21 35%,#181a21cc),url(${backdrop(item.id)}) center/cover` : ''}>
    <h1>{item.name} <small class="muted">{item.year ?? ''}</small></h1>
    <p class="muted">{item.genres.join(' · ')} {item.rating ? `· ${item.rating}` : ''} {fmtMin(item.runtimeTicks) ? `· ${fmtMin(item.runtimeTicks)}` : ''}</p>
    <p style="max-width:70ch">{item.overview ?? ''}</p>
    <div class="flex">
      {#if item.type !== 'Series'}
        <a class="btn" href="/watch/{item.id}">{item.positionTicks ? '▶ Fortsetzen' : '▶ Abspielen'}</a>
        <a class="btn sec" href="/party?item={item.id}">🎉 Watch-Party</a>
      {:else if next}
        <a class="btn" href="/watch/{next.id}">▶ Nächste Folge: S{next.parentIndexNumber}E{next.indexNumber}</a>
      {/if}
      <button class="sec" on:click={() => toggle('favorite')}>{item.favorite ? '★ Favorit' : '☆ Favorit'}</button>
      <button class="sec" on:click={() => toggle('watchlist')}>{inWatchlist ? '− Watchlist' : '+ Watchlist'}</button>
      <button class="sec" on:click={() => toggle('played')}>{item.played ? '✓ Gesehen' : 'Als gesehen markieren'}</button>
    </div>
  </div>
  {#if item.type === 'Series'}
    <p><button class:sec={!followed} on:click={toggleFollow}>{followed ? '🔔 Neue Folgen: ich folge' : '🔔 Neue Folgen melden'}</button></p>
    <div class="flex">{#each seasons as s}<button class:sec={season !== s.id} on:click={() => (season = s.id)}>{s.name}</button>{/each}</div>
    <div class="grid" style="margin-top:1rem">{#each episodes as e}<Card item={e} />{/each}</div>
  {/if}
{/if}
{#if item}
  <div class="panel" style="margin-top:1rem">
    <h3>Bewertungen {#if avg}<span class="badge">Ø {avg.toFixed(1)} ★</span>{/if}</h3>
    <div class="flex">
      {#each [1, 2, 3, 4, 5] as n}<button class:sec={stars < n} on:click={() => (stars = n)} aria-label="{n} Sterne">★</button>{/each}
      <input placeholder="Kurzreview (max. 280 Zeichen)" maxlength="280" bind:value={review} style="flex:1;min-width:200px" />
      <button disabled={!stars} on:click={rate}>Speichern</button>
    </div>
    {#each ratings as r}<p><b>{r.name}</b> {'★'.repeat(r.stars)} <span class="muted">{r.review ?? ''}</span></p>{/each}
  </div>
{/if}
