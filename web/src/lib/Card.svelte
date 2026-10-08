<script lang="ts">
  import { api, backdrop, img, fmtMin, type Item } from '$lib/api';
  import { listIds, toggleList } from '$lib/stores';
  import Icon from '$lib/Icon.svelte';

  export let item: Item;
  let fav = item.favorite;
  $: href = item.type === 'Episode' ? `/watch/${item.id}` : `/item/${item.id}`;
  $: detail = item.type === 'Episode' && item.seriesId ? `/item/${item.seriesId}` : `/item/${item.id}`;
  $: src = item.backdrop ? backdrop(item.id, 520) : item.image ? img(item.id, 520) : '';
  $: sub = item.type === 'Episode' ? `${item.seriesName ?? ''} · S${item.parentIndexNumber ?? '?'}:E${item.indexNumber ?? '?'}` : '';
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  $: inList = $listIds.has(item.seriesId ?? item.id);
  $: score = item.communityRating ? Math.round(item.communityRating * 10) : 0;

  async function toggleFav() { fav = !fav; try { await api(`/api/items/${item.id}/favorite`, { method: fav ? 'POST' : 'DELETE' }); } catch { fav = !fav; } }
</script>

<article class="card">
  <a class="thumb" {href} aria-label={item.name + (sub ? ', ' + sub : '')}>
    {#if src}<img loading="lazy" decoding="async" {src} alt="" width="320" height="180" />{/if}
    <span class="cap" class:big={!src}>{item.type === 'Episode' ? item.name : item.name}</span>
    {#if pct}<span class="progress"><i style="width:{pct}%"></i></span>{/if}
  </a>
  <div class="pop">
    <div class="acts">
      <a class="round play" href={href} aria-label="Abspielen"><Icon name="play" size={18} /></a>
      <button class="round" aria-label={inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste hinzufügen'} on:click={() => toggleList(item.seriesId ?? item.id, inList)}><Icon name={inList ? 'check' : 'plus'} size={18} /></button>
      <button class="round" class:on={fav} aria-label={fav ? 'Favorit entfernen' : 'Als Favorit markieren'} aria-pressed={fav} on:click={toggleFav}><Icon name="heart" size={17} fill={fav} /></button>
      <a class="round more" href={detail} aria-label="Mehr Infos"><Icon name="chevron-down" size={18} /></a>
    </div>
    <div class="meta">
      {#if score}<span class="match">{score}% Match</span>{/if}
      {#if item.rating}<span class="age">{item.rating}</span>{/if}
      {#if item.runtimeTicks && item.type !== 'Series'}<span>{fmtMin(item.runtimeTicks)}</span>{/if}
      {#if item.type === 'Series'}<span>Serie</span>{/if}
    </div>
    {#if sub}<div class="sub">{sub}</div>{:else if item.genres.length}<div class="sub">{item.genres.slice(0, 3).join(' • ')}</div>{/if}
  </div>
</article>

<style>
  .card { position: relative; width: 100%; transform-origin: center; transition: transform var(--t-med) var(--ease) 0s; }
  .thumb { display: block; position: relative; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; background: linear-gradient(135deg, #2b2b2b, #1a1a1a); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cap { position: absolute; left: .6rem; bottom: .5rem; right: .6rem; font-weight: 700; font-size: .85rem; text-shadow: 0 1px 6px #000, 0 0 2px #000; line-height: 1.2; }
  .cap.big { top: 0; display: grid; place-items: center; text-align: center; font-size: 1rem; padding: .5rem; }
  .thumb::after { content: ''; position: absolute; inset: 0; background: linear-gradient(transparent 55%, rgba(0,0,0,.65)); pointer-events: none; }
  .cap { z-index: 1; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.3); z-index: 2; }
  .progress i { display: block; height: 100%; background: var(--acc); }
  .pop { position: absolute; left: 0; right: 0; top: 100%; background: var(--surface); padding: .6rem .7rem .8rem; border-radius: 0 0 var(--radius) var(--radius); opacity: 0; visibility: hidden; box-shadow: 0 14px 28px rgba(0,0,0,.6); transition: opacity var(--t-fast); pointer-events: none; }
  .acts { display: flex; gap: .4rem; }
  .round { width: 34px; min-height: 34px; height: 34px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); color: #fff; display: grid; place-items: center; }
  .round:hover:not(:disabled) { border-color: #fff; background: rgba(42,42,42,.9); }
  .round.play { background: #fff; color: #000; border-color: #fff; }
  .round.play:hover { background: rgba(255,255,255,.8); }
  .round.on { color: var(--acc); border-color: var(--acc); }
  .more { margin-left: auto; }
  .meta { display: flex; gap: .6rem; align-items: center; margin-top: .55rem; font-size: .78rem; color: var(--mut); flex-wrap: wrap; }
  .match { color: var(--ok); font-weight: 700; }
  .age { border: 1px solid rgba(255,255,255,.4); padding: 0 .35rem; }
  .sub { font-size: .76rem; margin-top: .3rem; color: #d2d2d2; }

  /* Hover preview only for real pointers; touch devices simply tap through to the detail page. */
  @media (hover: hover) and (pointer: fine) {
    .card:hover, .card:focus-within { z-index: 6; transform: scale(1.32); transition-delay: .35s; }
    :global(.slot:first-child) .card { transform-origin: left center; }
    :global(.slot:last-child) .card { transform-origin: right center; }
    .card:hover .pop, .card:focus-within .pop { opacity: 1; visibility: visible; pointer-events: auto; transition-delay: .35s; }
  }
  @media (hover: none), (pointer: coarse) { .pop { display: none; } }
</style>
