<script lang="ts">
  import { page } from '$app/stores';
  import { api, backdrop, fmtMin, img, type Item } from '$lib/api';
  import Hero from '$lib/Hero.svelte';
  import Icon from '$lib/Icon.svelte';
  import LazyRow from '$lib/LazyRow.svelte';
  import { listIds, toggleList } from '$lib/stores';

  let item: Item | null = null, seasons: Item[] = [], episodes: Item[] | null = null, season = '', next: Item | null = null;
  let ratings: any[] = [], avg: number | null = null, stars = 0, review = '', followed = false, notFound = false;

  async function load(id: string) {
    item = null; episodes = null; notFound = false; next = null; seasons = [];
    try {
      const r = await api(`/api/items/${id}`);
      item = r.item;
      const rr = await api(`/api/items/${id}/ratings`); ratings = rr.ratings; avg = rr.average;
      const mine = ratings.find((x) => x.mine); stars = mine?.stars ?? 0; review = mine?.review ?? '';
      if (item!.type === 'Series') {
        followed = (await api(`/api/series/${id}/follow`)).followed;
        seasons = (await api(`/api/items/${id}/seasons`)).items;
        season = seasons[0]?.id ?? '';
        next = (await api('/api/library/nextup')).items.find((e: Item) => e.seriesId === id) ?? null;
        if (next?.seasonId && seasons.some((s) => s.id === next!.seasonId)) season = next.seasonId;
      }
    } catch { notFound = true; }
  }
  $: if ($page.params.id) load($page.params.id);
  $: if (item?.type === 'Series' && season) { episodes = null; api(`/api/items/${item.id}/episodes?seasonId=${season}`).then((r) => (episodes = r.items)).catch(() => (episodes = [])); }

  $: inList = item ? $listIds.has(item.id) : false;
  $: playHref = item ? (item.type === 'Series' ? (next ? `/watch/${next.id}` : episodes?.[0] ? `/watch/${episodes[0].id}` : '') : `/watch/${item.id}`) : '';
  $: playLabel = item ? (item.type === 'Series' ? (next ? `Weiter: S${next.parentIndexNumber}:E${next.indexNumber}` : 'Abspielen') : item.positionTicks ? 'Fortsetzen' : 'Abspielen') : 'Abspielen';

  async function toggleFav() { if (!item) return; const on = item.favorite; await api(`/api/items/${item.id}/favorite`, { method: on ? 'DELETE' : 'POST' }); item.favorite = !on; }
  async function togglePlayed() { if (!item) return; const on = item.played; await api(`/api/items/${item.id}/played`, { method: on ? 'DELETE' : 'POST' }); item.played = !on; }
  async function toggleFollow() { await api(`/api/series/${item!.id}/follow`, { method: followed ? 'DELETE' : 'POST' }); followed = !followed; }
  async function rate() {
    if (!item || !stars) return;
    await api(`/api/items/${item.id}/rating`, { method: 'PUT', body: { stars, review: review || undefined } });
    const rr = await api(`/api/items/${item.id}/ratings`); ratings = rr.ratings; avg = rr.average;
  }
  const loadSimilar = () => item!.genres.length
    ? api(`/api/library/items?types=${item!.type}&genre=${encodeURIComponent(item!.genres[0]!)}&sort=Random&limit=24`).then((r) => (r.items as Item[]).filter((i) => i.id !== item!.id))
    : Promise.resolve([] as Item[]);
</script>

<svelte:head><title>{item?.name ?? 'Titel'} – FriendFlix</title></svelte:head>
{#if notFound}
  <div class="page"><h1>Titel nicht gefunden</h1><a class="btn" href="/">Zur Startseite</a></div>
{:else}
  <Hero {item} {playHref} {playLabel} more={false} />
  {#if item}
    <div class="body">
      <div class="actions">
        <button class="icon-btn ring" class:on={inList} aria-pressed={inList} aria-label={inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste hinzufügen'} title="Meine Liste" on:click={() => toggleList(item!.id, inList)}><Icon name={inList ? 'check' : 'plus'} size={22} /></button>
        <button class="icon-btn ring" class:on={item.favorite} aria-pressed={item.favorite} aria-label="Favorit" title="Favorit" on:click={toggleFav}><Icon name="heart" size={21} fill={item.favorite} /></button>
        <button class="icon-btn ring" class:on={item.played} aria-pressed={item.played} aria-label="Als gesehen markieren" title="Gesehen" on:click={togglePlayed}><Icon name="check" size={22} /></button>
        {#if item.type !== 'Series'}<a class="btn sec" href="/party?item={item.id}"><Icon name="users" size={20} />Watch-Party</a>{/if}
        {#if item.type === 'Series'}<button class="sec" aria-pressed={followed} on:click={toggleFollow}><Icon name="bell" size={20} />{followed ? 'Du folgst dieser Serie' : 'Neue Folgen melden'}</button>{/if}
      </div>
      {#if item.genres.length}<p class="muted">Genres: <span style="color:#fff">{item.genres.join(', ')}</span></p>{/if}

      {#if item.type === 'Series'}
        <div class="seasonbar">
          <h2>Folgen</h2>
          <label class="sr-only" for="se">Staffel</label>
          <select id="se" bind:value={season}>{#each seasons as s}<option value={s.id}>{s.name}</option>{/each}</select>
        </div>
        <ol class="eps">
          {#if episodes === null}{#each Array(5) as _}<li><div class="skeleton" style="height:90px"></div></li>{/each}
          {:else}{#each episodes as e (e.id)}
            <li><a class="ep" href="/watch/{e.id}">
              <span class="n">{e.indexNumber ?? ''}</span>
              <span class="th">{#if e.image}<img loading="lazy" src={img(e.id, 320)} alt="" />{/if}{#if e.positionTicks && e.runtimeTicks}<span class="bar"><i style="width:{Math.min(100, (e.positionTicks / e.runtimeTicks) * 100)}%"></i></span>{/if}<span class="pl"><Icon name="play" size={22} /></span></span>
              <span class="tx"><span class="t"><b>{e.name}</b><span class="muted">{fmtMin(e.runtimeTicks)}</span></span><span class="muted ov">{e.overview ?? ''}</span></span>
              {#if e.played}<span class="seen"><Icon name="check" size={18} label="Gesehen" /></span>{/if}
            </a></li>{/each}{/if}
        </ol>
      {/if}

      <section class="rate panel">
        <h2>Bewertungen {#if avg}<span class="badge">Ø {avg.toFixed(1)} von 5</span>{/if}</h2>
        <div class="flex" role="group" aria-label="Sterne vergeben">
          {#each [1, 2, 3, 4, 5] as n}<button class="icon-btn star" class:on={stars >= n} aria-pressed={stars >= n} aria-label="{n} {n === 1 ? 'Stern' : 'Sterne'}" on:click={() => (stars = n)}><Icon name="star" size={24} fill={stars >= n} /></button>{/each}
          <input placeholder="Kurzreview (max. 280 Zeichen)" maxlength="280" bind:value={review} aria-label="Kurzreview" style="flex:1;min-width:200px" />
          <button disabled={!stars} on:click={rate}>Speichern</button>
        </div>
        {#each ratings as r}<p><b>{r.name}</b> <span class="warn">{'★'.repeat(r.stars)}</span> <span class="muted">{r.review ?? ''}</span></p>{/each}
      </section>
    </div>
    {#key item.id}<div class="similar"><LazyRow title="Ähnliche Titel" load={loadSimilar} /></div>{/key}
  {/if}
{/if}

<style>
  .body { position: relative; z-index: 3; padding: 0 var(--pad-x) 1rem; max-width: 1400px; }
  .actions { display: flex; gap: .7rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
  .ring { border: 2px solid rgba(255,255,255,.5); background: rgba(42,42,42,.6); width: 46px; min-height: 46px; height: 46px; }
  .ring:hover:not(:disabled) { border-color: #fff; } .ring.on { color: var(--acc); border-color: var(--acc); }
  .seasonbar { display: flex; align-items: center; justify-content: space-between; margin: 2rem 0 .5rem; }
  .eps { list-style: none; padding: 0; margin: 0; }
  .ep { display: grid; grid-template-columns: 2.2rem 160px 1fr auto; gap: 1rem; align-items: center; padding: 1rem .8rem; border-bottom: 1px solid var(--line); border-radius: 4px; transition: background var(--t-fast); }
  .ep:hover { background: #2a2a2a; }
  .n { font-size: 1.4rem; color: var(--mut); text-align: center; }
  .th { position: relative; aspect-ratio: 16 / 9; background: #222; border-radius: 4px; overflow: hidden; display: block; }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .th .bar { position: absolute; left: 0; right: 0; bottom: 0; }
  .pl { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; background: rgba(0,0,0,.45); transition: opacity var(--t-fast); } .ep:hover .pl, .ep:focus-visible .pl { opacity: 1; }
  .tx { display: flex; flex-direction: column; gap: .3rem; min-width: 0; } .t { display: flex; justify-content: space-between; gap: 1rem; }
  .ov { font-size: .88rem; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .seen { color: var(--ok); }
  .rate { margin-top: 2rem; } .star.on { color: #f5c518; }
  .similar { position: relative; z-index: 2; padding-bottom: 5rem; }
  @media (max-width: 640px) { .ep { grid-template-columns: 110px 1fr; } .n, .seen { display: none; } }
</style>
