<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { img, type Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import { prefs } from '#lib/stores';
  import { isSpoiler } from '#lib/spoiler';
  import Icon from '#lib/Icon.svelte';
  import DownloadButton from '#lib/DownloadButton.svelte';
  import { seasonLabel } from '#lib/detail/format';
  import EpisodeComments from '#lib/detail/EpisodeComments.svelte';
  import { kidsMode } from '#lib/kids';
  import { perms } from '#lib/perms';
  import { playPrefetch } from '#lib/player/prefetch';
  import { playOrCast } from '#lib/cast/playOrCast';
  import { SCRIM_SAFE_DIM } from '#lib/glass/tone';

  /** series id (for the per-episode download buttons) */
  export let seriesId: string;
  export let seasons: Item[];
  /** selected season id (two-way) */
  export let season = '';
  /** null = loading */
  export let episodes: Item[] | null;
  /** next-up episode: highlighted */
  export let next: Item | null = null;
  /** query string (audio/sub choice) appended to the player links */
  export let qs = '';
  /** list: one row per episode (page, modal); row: a horizontal strip of 16:9 tiles (desktop detail page) */
  export let layout: 'list' | 'row' = 'list';
  /** the audio / subtitle choice carried in the link's query, for the native player */
  const trackOpts = (q: string) => { const p = new URLSearchParams(q); return { audio: p.get('audio') ?? undefined, subtitle: p.get('sub') ?? undefined }; };

  let revealed = new Set<string>();
  const reveal = (e: MouseEvent, id: string) => { e.preventDefault(); e.stopPropagation(); revealed = new Set([...revealed, id]); };
  const hidden = (e: Item, r: Set<string>) => isSpoiler(e, $prefs) && !r.has(e.id);
  // friends-only comments per episode (expand); kids profiles never see them
  let openComments = new Set<string>(), counts: Record<string, number> = {};
  const toggleComments = (id: string) => { const n = new Set(openComments); if (n.has(id)) n.delete(id); else n.add(id); openComments = n; };
  $: current = (e: Item) => (next ? next.id === e.id : false);
</script>

<section class="eps" class:row={layout === 'row'} aria-labelledby="eps-h">
  <div class="seasonbar">
    <h2 id="eps-h" class:sr-only={layout === 'row'}>{$t('detail.episodes.title')}</h2>
    {#if seasons.length}
      <span class="sel">
        <label class="sr-only" for="dv-season">{$t('detail.episodes.season')}</label>
        <select id="dv-season" bind:value={season}>{#each seasons as s (s.id)}<option value={s.id}>{seasonLabel(s)}</option>{/each}</select>
        <span class="chev" aria-hidden="true"><Icon name="chevron-down" size={16} /></span>
      </span>
    {/if}
  </div>
  <ol>
    {#if episodes === null}
      {#each Array(4) as _}<li><div class="skeleton sk"></div></li>{/each}
    {:else if !episodes.length}
      <li class="muted none">{$t('detail.episodes.none')}</li>
    {:else}
      {#each episodes as e (e.id)}
        {@const pct = e.positionTicks && e.runtimeTicks ? Math.min(100, (e.positionTicks / e.runtimeTicks) * 100) : 0}
        <li class="eprow" class:cur={current(e)}>
          <div class="epmain">
          <a class="ep frost-flat frost-tile" class:frost-safe={layout === 'row'} style={layout === 'row' ? `--fr-scrim-safe:${SCRIM_SAFE_DIM}` : undefined} href="/watch/{e.id}{qs ? '?' + qs : ''}" aria-current={current(e) ? 'true' : undefined} data-play-scope use:playPrefetch on:click={(ev) => playOrCast(ev, e, trackOpts(qs))}>
            <span class="n" aria-hidden="true">{e.indexNumber ?? ''}</span>
            <span class="th" data-play-art>
              {#if e.image}<img class:spoil={hidden(e, revealed)} loading="lazy" src={img(e.id, 320)} alt="" />{/if}
              {#if pct}<span class="bar"><i style="width:{pct}%"></i></span>{/if}
              <span class="pl"><Icon name="play" size={22} /></span>
            </span>
            <span class="tx">
              <span class="t"><b>{#if e.indexNumber !== undefined}<span class="sr-only">{$t('detail.episodes.episodeN', { n: e.indexNumber })}</span>{/if}{e.name}</b><span class="muted dur">{e.runtimeTicks ? $t('common.duration.m', { m: Math.round(e.runtimeTicks / 600_000_000) }) : ''}</span></span>
              {#if hidden(e, revealed)}<span class="muted ov">{$t('detail.episodes.spoiler')} · <button type="button" class="lnk" on:click={(ev) => reveal(ev, e.id)}>{$t('detail.episodes.reveal')}</button></span>
              {:else}<span class="muted ov">{e.overview ?? ''}</span>{/if}
            </span>
            {#if e.played}<span class="seen"><Icon name="check" size={18} label={$t('detail.episodes.watched')} /></span>{/if}
          </a>
          <span class="epdl">
            {#if !$kidsMode && $perms.comments}
              <button type="button" class="cmbtn" class:on={openComments.has(e.id)} aria-expanded={openComments.has(e.id)} aria-controls="cm-panel-{e.id}"
                aria-label={openComments.has(e.id) ? $t('anime.comments.hide') : $t('anime.comments.show')} title={openComments.has(e.id) ? $t('anime.comments.hide') : $t('anime.comments.show')}
                on:click={() => toggleComments(e.id)}><Icon name="message" size={18} />{#if counts[e.id]}<span class="n2">{counts[e.id]}</span>{/if}</button>
            {/if}
            <DownloadButton itemId={e.id} {seriesId} compact />
          </span>
          </div>
          {#if openComments.has(e.id) && !$kidsMode && $perms.comments}
            <div id="cm-panel-{e.id}"><EpisodeComments itemId={e.id} onCount={(n) => (counts = { ...counts, [e.id]: n })} /></div>
          {/if}
        </li>
      {/each}
    {/if}
  </ol>
</section>

<style>
  .eps { margin-top: 2.2rem; }
  .seasonbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .6rem; }
  h2 { margin: 0; font-size: 1.4rem; }
  .sel { position: relative; display: inline-block; }
  select { appearance: none; -webkit-appearance: none; background: var(--fr-solid); border: 1px solid var(--fr-line); border-radius: 999px; padding: 0 2.2rem 0 1.1rem; font-weight: 600; cursor: pointer; }
  select:hover { border-color: #fff; }
  .chev { position: absolute; right: .7rem; top: 50%; transform: translateY(-50%); pointer-events: none; }
  /* episodes are glass tiles (glass spec §4: .frost-flat.frost-tile, 12 px padding, 10 px thumbnail radius, coral progress) */
  ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .sk { height: 90px; margin: 0; border-radius: var(--fr-r-tile); }
  .none { padding: 1rem .8rem; }
  .epmain { position: relative; }
  .eprow { position: relative; }
  /* no fill on hover or for next up (more milk would cost contrast; the solid fallback stays): the edge lights, next up is coral */
  .ep { display: grid; grid-template-columns: 2.6rem 160px 1fr auto; gap: 1rem; align-items: center; padding: 12px; color: var(--fg); text-decoration: none; box-shadow: inset 0 1px 0 var(--fr-hi), var(--fr-shadow-card); }
  .ep:hover { border-color: rgba(255, 255, 255, .42); }
  .eprow.cur .ep { border-color: var(--acc); box-shadow: inset 0 1px 0 var(--fr-hi), inset 0 0 0 1px var(--acc), var(--fr-shadow-card); }
  .ep:focus-visible { outline: 2px solid #fff; outline-offset: 2px; --ring-o: 2px; }
  .n { font-size: 1.6rem; color: var(--mut); text-align: center; font-weight: 300; }
  .th { position: relative; aspect-ratio: 16 / 9; background: #1c2228; border-radius: 10px; overflow: hidden; display: block; }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .th img.spoil { filter: blur(14px); transform: scale(1.1); }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255, 255, 255, .3); }
  .bar i { display: block; height: 100%; background: var(--acc); }
  .pl { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; background: rgba(0, 0, 0, .45); transition: opacity var(--t-fast); }
  .ep:hover .pl, .ep:focus-visible .pl { opacity: 1; }
  .tx { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
  .t { display: flex; justify-content: space-between; gap: 1rem; }
  .dur { white-space: nowrap; }
  .ov { font-size: .88rem; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .lnk { background: none; border: 0; padding: 0; min-height: 0; color: var(--fg); text-decoration: underline; cursor: pointer; font: inherit; font-weight: 400; display: inline; }
  .lnk:hover:not(:disabled) { background: none; }
  .seen { color: var(--ok); }
  .epdl { position: absolute; right: .8rem; bottom: .8rem; display: flex; align-items: center; gap: .4rem; }
  /* the row's bottom margin makes room when the comments panel is closed: the buttons sit over the row's padding */
  .cmbtn { display: inline-flex; align-items: center; gap: .25rem; min-height: 0; padding: .3rem .5rem; border-radius: 999px; background: rgba(255, 255, 255, .1); border: 0; color: var(--fg); cursor: pointer; font-size: .8rem; }
  @media (pointer: coarse) { .cmbtn { min-height: 44px; min-width: 44px; justify-content: center; } }
  .cmbtn:hover, .cmbtn.on { background: rgba(255, 255, 255, .22); }
  .n2 { font-variant-numeric: tabular-nums; }
  /* ---- row: a horizontal strip of 16:9 tiles (title, length, progress line); next up wears the coral ring ---- */
  .row { margin-top: 0; }
  .row .seasonbar { justify-content: flex-start; margin-bottom: 16px; }
  .row ol { display: flex; gap: 16px; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scroll-padding-inline: 4px; padding: 4px 4px 24px; margin: 0 -4px; scrollbar-width: thin; }
  .row .eprow { flex: 0 0 clamp(240px, 21vw, 320px); scroll-snap-align: start; display: flex; flex-direction: column; }
  .row .epmain { flex: 1; display: flex; flex-direction: column; }
  .row .ep { flex: 1; display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
  /* over the backdrop (desk): the safe scrim for the dimmest text, white .9 (lib/glass/tone.ts TEXT_DIM) */
  .row .ep { --mut: rgba(255, 255, 255, .9); }
  .row .n { display: none; }
  .row .th { width: 100%; }
  .row .ep:hover img { opacity: .86; }
  .row .tx { gap: 4px; }
  .row .t { font-size: 15px; line-height: 20px; }
  .row .dur { font-size: 13px; font-variant-numeric: tabular-nums; }
  .row .ov { font-size: 13px; line-height: 18px; }
  .row .seen { position: absolute; top: 20px; right: 20px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: rgba(16, 20, 24, .72); }
  .row .epdl { position: static; margin-top: 8px; }
  .row .sk { height: auto; aspect-ratio: 16 / 9; margin: 0; }
  .row .none { padding: 0; }
  @media (max-width: 640px) {
    .ep { grid-template-columns: 110px 1fr; gap: .7rem; }
    .n, .seen { display: none; }
    .epdl { right: .4rem; bottom: .4rem; }
  }
</style>
