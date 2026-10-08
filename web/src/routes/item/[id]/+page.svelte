<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { castToTv, refreshTvOnline, tvOnline } from '$lib/remote';
  import { api, backdrop, fmtMin, img, type Item } from '$lib/api';
  import Hero from '$lib/Hero.svelte';
  import { dominantColor } from '$lib/tint';
  import Icon from '$lib/Icon.svelte';
  import LazyRow from '$lib/LazyRow.svelte';
  import LangPick from '$lib/LangPick.svelte';
  import { goto } from '$app/navigation';
  import { listIds, toggleList } from '$lib/stores';

  let thumb = 0, extras: Item[] = [], tint = '', friends: Array<{ id: string; name: string }> = [], recOpen = false, recTo = new Set<string>(), recNote = '', recMsg = '';
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
  let lgA = '', lgS = '';
  $: qs = [lgA && `audio=${encodeURIComponent(lgA)}`, lgS && `sub=${encodeURIComponent(lgS)}`].filter(Boolean).join('&');
  $: playBase = item ? (item.type === 'Series' ? (next ? `/watch/${next.id}` : episodes?.[0] ? `/watch/${episodes[0].id}` : '') : `/watch/${item.id}`) : '';
  $: playHref = playBase && qs ? `${playBase}?${qs}` : playBase;
  $: playTarget = playBase.split('/').pop() ?? '';
  async function startParty() { try { goto(`/party/${(await api('/api/party', { method: 'POST', body: { itemId: item!.id } })).id}`); } catch { castMsg = 'Party konnte nicht erstellt werden.'; } }
  $: playLabel = item ? (item.type === 'Series' ? (next ? `Weiter: S${next.parentIndexNumber}:E${next.indexNumber}` : 'Abspielen') : item.positionTicks ? 'Fortsetzen' : 'Abspielen') : 'Abspielen';

  let castMsg = '', castT: ReturnType<typeof setTimeout>;
  onMount(() => { void refreshTvOnline(); return () => clearTimeout(castT); });
  async function castHere() {
    const id = playTarget;
    if (!id) return;
    castMsg = (await castToTv(id)) ? 'Wird auf dem Fernseher gestartet …' : 'Der Fernseher ist nicht erreichbar.';
    clearTimeout(castT); castT = setTimeout(() => (castMsg = ''), 3500);
  }
  async function toggleFav() { if (!item) return; const on = item.favorite; await api(`/api/items/${item.id}/favorite`, { method: on ? 'DELETE' : 'POST' }); item.favorite = !on; }
  async function togglePlayed() { if (!item) return; const on = item.played; await api(`/api/items/${item.id}/played`, { method: on ? 'DELETE' : 'POST' }); item.played = !on; }
  async function setThumb(v: 1 | -1) { if (!item) return; const next = thumb === v ? 0 : v; thumb = next; await api(`/api/items/${item.id}/thumb`, { method: 'PUT', body: { value: next } }).catch(() => (thumb = 0)); }
  async function openRec() { recOpen = true; recMsg = ''; if (!friends.length) friends = (await api('/api/friends').catch(() => ({ friends: [] }))).friends; }
  async function sendRec() {
    try { const r = await api('/api/recommend', { method: 'POST', body: { itemId: item!.id, toUserIds: [...recTo], note: recNote || undefined } }); recMsg = `An ${r.sent} Freund(e) gesendet.`; recTo = new Set(); recNote = ''; setTimeout(() => (recOpen = false), 1200); }
    catch (e: any) { recMsg = e?.body?.error === 'already_recommended' ? 'Diesen Titel hast du ihnen diese Woche schon empfohlen.' : 'Senden fehlgeschlagen.'; }
  }
  function toggleTo(id: string) { const n = new Set(recTo); if (n.has(id)) n.delete(id); else n.add(id); recTo = n; }
  async function toggleFollow() { await api(`/api/series/${item!.id}/follow`, { method: followed ? 'DELETE' : 'POST' }); followed = !followed; }
  async function rate() {
    if (!item || !stars) return;
    await api(`/api/items/${item.id}/rating`, { method: 'PUT', body: { stars, review: review || undefined } });
    const rr = await api(`/api/items/${item.id}/ratings`); ratings = rr.ratings; avg = rr.average;
  }
  const loadSimilar = () => api(`/api/items/${item!.id}/similar`).then((r) => r.items as Item[]).then((l) => (l.length ? l : loadGenre())).catch(() => loadGenre());
  const loadGenre = () => item!.genres.length
    ? api(`/api/library/items?types=${item!.type}&genre=${encodeURIComponent(item!.genres[0]!)}&sort=Random&limit=24`).then((r) => (r.items as Item[]).filter((i) => i.id !== item!.id))
    : Promise.resolve([] as Item[]);
</script>

<svelte:head><title>{item?.name ?? 'Titel'} – FriendFlix</title></svelte:head>
{#if notFound}
  <div class="page"><h1>Titel nicht gefunden</h1><a class="btn" href="/">Zur Startseite</a></div>
{:else}
  <Hero {item} {playHref} {playLabel} more={false} />
  {#if item}
    <div class="body" style={tint ? `--tint: ${tint}` : ''}>
      <div class="actions">
        <button class="icon-btn ring" class:on={inList} aria-pressed={inList} aria-label={inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste hinzufügen'} title="Meine Liste" on:click={() => toggleList(item!.id, inList)}><Icon name={inList ? 'check' : 'plus'} size={22} /></button>
        <button class="icon-btn ring" class:on={item.favorite} aria-pressed={item.favorite} aria-label="Favorit" title="Favorit" on:click={toggleFav}><Icon name="heart" size={21} fill={item.favorite} /></button>
        <button class="icon-btn ring" class:on={item.played} aria-pressed={item.played} aria-label="Als gesehen markieren" title="Gesehen" on:click={togglePlayed}><Icon name="check" size={22} /></button>
        <button class="icon-btn ring" class:on={thumb === 1} aria-pressed={thumb === 1} aria-label="Gefällt mir" title="Gefällt mir" on:click={() => setThumb(1)}><Icon name="thumb-up" size={21} /></button>
        <button class="icon-btn ring" class:on={thumb === -1} aria-pressed={thumb === -1} aria-label="Gefällt mir nicht" title="Nicht für mich" on:click={() => setThumb(-1)}><Icon name="thumb-down" size={21} /></button>
        <button class="icon-btn ring" aria-label="Einem Freund empfehlen" title="Empfehlen" on:click={openRec}><Icon name="send" size={20} /></button>
        {#if $tvOnline && playHref}<button class="sec" on:click={castHere}><Icon name="tv" size={20} />Auf Fernseher</button>{/if}
        {#if item.type !== 'Series'}<button class="sec" on:click={startParty}><Icon name="users" size={20} />Gemeinsam schauen</button>{/if}
        {#if item.type === 'Series'}<button class="sec" aria-pressed={followed} on:click={toggleFollow}><Icon name="bell" size={20} />{followed ? 'Du folgst dieser Serie' : 'Neue Folgen melden'}</button>{/if}
      </div>
      {#if playTarget}<LangPick targetId={playTarget} storeKey={item.type === 'Series' ? item.id : item.id} bind:audio={lgA} bind:sub={lgS} />{/if}
      {#if castMsg}<p class="muted" role="status">{castMsg}</p>{/if}
      {#if recOpen}
        <div class="panel rec" role="dialog" aria-label="Empfehlen">
          <b>„{item.name}“ empfehlen an:</b>
          <div class="flex">{#each friends as f}<label class="chk"><input type="checkbox" checked={recTo.has(f.id)} on:change={() => toggleTo(f.id)} />{f.name}</label>{:else}<span class="muted">Noch keine anderen Nutzer.</span>{/each}</div>
          <div class="flex"><input bind:value={recNote} maxlength="140" placeholder="Nachricht (optional)" aria-label="Nachricht" style="flex:1;min-width:200px" /><button disabled={!recTo.size} on:click={sendRec}>Senden</button><button class="sec" on:click={() => (recOpen = false)}>Abbrechen</button></div>
          {#if recMsg}<span class="muted" role="status">{recMsg}</span>{/if}
        </div>
      {/if}
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
            <li><a class="ep" href="/watch/{e.id}{qs ? '?' + qs : ''}">
              <span class="n">{e.indexNumber ?? ''}</span>
              <span class="th">{#if e.image}<img loading="lazy" src={img(e.id, 320)} alt="" />{/if}{#if e.positionTicks && e.runtimeTicks}<span class="bar"><i style="width:{Math.min(100, (e.positionTicks / e.runtimeTicks) * 100)}%"></i></span>{/if}<span class="pl"><Icon name="play" size={22} /></span></span>
              <span class="tx"><span class="t"><b>{e.name}</b><span class="muted">{fmtMin(e.runtimeTicks)}</span></span><span class="muted ov">{e.overview ?? ''}</span></span>
              {#if e.played}<span class="seen"><Icon name="check" size={18} label="Gesehen" /></span>{/if}
            </a></li>{/each}{/if}
        </ol>
      {/if}

      {#if extras.length}
        <section class="extras"><h2>Bonusmaterial</h2>
          <ul>{#each extras as x (x.id)}<li><a href="/watch/{x.id}"><span class="pl2"><Icon name="play" size={18} /></span><span>{x.name}</span><span class="muted">{fmtMin(x.runtimeTicks)}</span></a></li>{/each}</ul>
        </section>
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
  /* Apple-TV-style mood: soft glow in the backdrop's dominant colour */
  .body::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none; background: radial-gradient(1100px 600px at 20% 105%, rgba(var(--tint, 0,0,0), .28), transparent 70%); transition: background .8s; }
  .rec { display: grid; gap: .8rem; } .chk { display: inline-flex; gap: .45rem; align-items: center; color: var(--fg); min-height: 44px; }
  .extras ul { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: .3rem; max-width: 640px; }
  .extras a { display: flex; gap: .8rem; align-items: center; padding: .6rem .8rem; background: var(--surface); border-radius: 6px; } .extras a:hover { background: var(--surface-2); } .extras .muted { margin-left: auto; }
  .pl2 { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: var(--surface-2); }
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
