<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  import type { Item } from '#lib/api';
  /** seasons / episodes stay cached while the player hops from episode to episode */
  const seasonCache = new Map<string, Item[]>();
  const episodeCache = new Map<string, Item[]>();
</script>

<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { api, img } from '#lib/api';
  import { fmtDuration, t } from '#lib/i18n';
  import { prefs } from '#lib/stores';
  import { isSpoiler } from '#lib/spoiler';
  import { seasonLabel } from '#lib/detail/format';
  import { focusEl } from '#lib/spatial';
  import { decodeFade, stagger } from '#lib/tv/motion';
  import { followFocus } from '#lib/tv/follow';
  import Icon from '#lib/Icon.svelte';
  import { sheetIn, sheetOut } from '#lib/player/tvSheet';

  /**
   * TV player "Episodes" (spec 4): a full-screen layer that slides up. Seasons as a quiet list on the left (the detail page's
   * season rows), the season's episodes as a row of 16:9 stills on the right (progress, number + name, length), the focused
   * one's synopsis above the row. The playing episode is focused on open; OK plays another one (Player: pickEpisode).
   */
  export let seriesId: string;
  export let seasonId = '';
  export let currentId: string;
  export let seriesName = '';
  const dispatch = createEventDispatcher<{ pick: { id: string }; close: void }>();

  let seasons: Item[] = seasonCache.get(seriesId) ?? [], season = seasonId, episodes: Item[] | null = null, failed = false, seq = 0;
  async function loadSeasons() {
    if (!seasons.length) {
      try { seasons = (await api(`/api/items/${seriesId}/seasons`)).items as Item[]; seasonCache.set(seriesId, seasons); } catch { seasons = []; }
    }
    if (!season) season = seasons[0]?.id ?? '';
    if (!season) void loadEpisodes(''); // no seasons (flat series): all episodes
  }
  async function loadEpisodes(sid: string) {
    const my = ++seq, key = `${seriesId}:${sid}`, hit = episodeCache.get(key);
    if (hit) { episodes = hit; return; }
    episodes = null; failed = false;
    try {
      const r = (await api(`/api/items/${seriesId}/episodes${sid ? `?seasonId=${sid}` : ''}`)).items as Item[];
      if (my === seq) { episodes = r; episodeCache.set(key, r); }
    } catch { if (my === seq) { episodes = []; failed = true; } }
  }
  $: if (season) void loadEpisodes(season);

  const mins = (e: Item) => (e.runtimeTicks ? fmtDuration(Math.max(1, Math.round(e.runtimeTicks / 600_000_000)) * 60) : '');
  const pct = (e: Item) => (e.id === currentId ? 0 : e.played ? 1 : e.positionTicks && e.runtimeTicks ? Math.min(1, Math.max(0.02, e.positionTicks / e.runtimeTicks)) : 0);

  let root: HTMLDivElement | undefined, track: HTMLDivElement | undefined, focused: Item | null = null, keyed = false, placed = false;
  const target = () => track?.querySelector<HTMLElement>(`[data-ep="${currentId}"]`) ?? track?.querySelector<HTMLElement>('[data-ep]') ?? null;
  const selected = () => root?.querySelector<HTMLElement>('.seasons [aria-pressed="true"]') ?? null;
  /** moving onto a season selects it (only after a key: the first placed focus must not switch it) */
  function pick(id: string) { if (id !== season) season = id; }
  function onNav(e: Event) {
    const dir = (e as CustomEvent<{ dir: string }>).detail?.dir, el = e.target as HTMLElement;
    const to = dir === 'right' && el.closest('.seasons') ? target() : dir === 'left' && el.closest('[data-ep]') && el === track?.querySelector('[data-ep]') ? selected() : null;
    if (to) { e.preventDefault(); focusEl(to); }
  }

  // the playing episode is focused once its season is rendered; a new season's row enters with a short stagger
  let shown = '';
  $: if (episodes && track) void enter(season);
  async function enter(key: string) {
    if (key === shown) return;
    const first = !shown;
    shown = key;
    await tick();
    if (!track) return;
    if (first && !placed) {
      placed = true;
      const el = target();
      if (el) { track.scrollLeft = Math.max(0, el.getBoundingClientRect().left - (el.parentElement ?? track).getBoundingClientRect().left); el.focus({ preventScroll: true }); } // the playing one first in the row
      else selected()?.focus();
    } else stagger([...track.querySelectorAll<HTMLElement>('[data-ep]')].slice(0, 5), { gap: 30 });
  }
  onMount(() => {
    void loadSeasons();
    const k = () => (keyed = true);
    root?.addEventListener('ff-nav', onNav);
    window.addEventListener('keydown', k, true);
    return () => { root?.removeEventListener('ff-nav', onNav); window.removeEventListener('keydown', k, true); };
  });
</script>

<div class="tvov eps ui" bind:this={root} data-nav data-scope data-own-scroll role="dialog" aria-label={$t('player.episodes.title')} tabindex="-1" in:sheetIn out:sheetOut on:click|stopPropagation on:keydown={() => {}}>
  <header>
    <h2 class="tv-row-title">{$t('player.episodes.title')}</h2>
    {#if seriesName}<span class="tv-meta">{seriesName}</span>{/if}
  </header>
  <div class="body">
    {#if seasons.length > 1}
      <div class="col seasons win" use:followFocus>
        <div class="strip" role="group" aria-label={$t('tv.sub.seasons')}>
          {#each seasons as s (s.id)}
            <div data-follow><button type="button" class="tv-btn srow" aria-pressed={s.id === season} on:focus={() => { if (keyed) pick(s.id); }} on:click={() => pick(s.id)}>{seasonLabel(s)}</button></div>
          {/each}
        </div>
      </div>
    {/if}
    <div class="col right">
      <p class="tv-body syn" aria-hidden="true">{#if focused}{isSpoiler(focused, $prefs) ? $t('detail.episodes.spoiler') : focused.overview ?? ''}{/if}</p>
      {#if episodes === null}
        <div class="track"><div class="strip">{#each [0, 1, 2, 3] as k (k)}<span class="skeleton sk" aria-hidden="true"></span>{/each}</div></div>
      {:else if !episodes.length}
        <p class="tv-meta none" role="status">{failed ? $t('player.episodes.failed') : $t('player.episodes.none')}</p>
      {:else}
        <div class="track" class:bleed={seasons.length <= 1} bind:this={track}>
          <div class="strip" data-glide>
            {#each episodes as e (e.id)}
              {@const p = pct(e)}
              {@const cur = e.id === currentId}
              <button type="button" class="ep" data-ep={e.id} aria-current={cur ? 'true' : undefined} on:focus={() => (focused = e)} on:click={() => (cur ? dispatch('close') : dispatch('pick', { id: e.id }))}>
                <span class="still">
                  {#if e.image && !isSpoiler(e, $prefs)}<img src={img(e.id, 480)} alt="" loading="lazy" decoding="async" use:decodeFade />{/if}
                  {#if cur}<span class="now tv-label"><Icon name="play" size={16} />{$t('player.episodes.playing')}</span>{/if}
                  {#if p}<span class="pbar" aria-hidden="true"><span style="transform:scaleX({p})"></span></span>{/if}
                </span>
                <span class="nm">{#if e.indexNumber !== undefined}<span class="n">{e.indexNumber}</span>{/if}{e.name}</span>
                <span class="tv-meta mt">{mins(e)}{#if e.played}<span class="seen"><Icon name="check" size={18} /></span>{/if}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .eps { position: absolute; inset: 0; z-index: 12; display: flex; flex-direction: column; justify-content: flex-end; gap: 2rem; padding: var(--tv-safe-y, 5vh) 0 var(--tv-safe-y, 5vh) var(--tv-safe-x, 5vw); box-sizing: border-box; color: #fff;
    background: linear-gradient(0deg, #000 0%, rgba(0, 0, 0, .94) 50%, rgba(0, 0, 0, .7) 100%); }
  header { display: flex; align-items: baseline; gap: 1.25rem; }
  header h2 { margin: 0; }
  .body { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 3rem; align-items: end; min-height: 0; }
  .seasons { align-self: end; }
  .win { min-height: 0; max-height: 26rem; margin: 0 -1.5rem; padding: .5rem 1.5rem; overflow-x: visible; overflow-y: clip; }
  .seasons .strip { display: flex; flex-direction: column; gap: .5rem; }
  .seasons [data-follow] { display: flex; }
  :global(html.tv) .srow { flex: 1 1 auto; min-height: 3.5rem; min-width: 12rem; padding: 0 1.4rem; font-size: 1.2rem; justify-content: flex-start; transform-origin: left center; white-space: nowrap; }
  :global(html.tv) .srow:not(:focus-visible) { background: transparent; color: var(--tv-white-78); }
  :global(html.tv) .srow[aria-pressed='true']:not(:focus-visible) { background: var(--tv-btn-rest); color: #fff; }
  :global(html.tv) .srow:focus-visible { transform: scale(1.03); }

  .right { min-width: 0; display: flex; flex-direction: column; gap: 1.25rem; }
  :global(html.tv) .syn { margin: 0; min-height: calc(1.45em * 3); max-width: 52ch; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  /* the row: a native scroll box whose strip glides (lib/tv/motion.ts glideRow via [data-own-scroll]); room above for the focus scale */
  .track { overflow-x: auto; overflow-y: visible; scrollbar-width: none; padding: 1.4rem var(--tv-safe-x, 5vw) 1rem 0; margin: -1.4rem 0 -1rem; scroll-padding: 0 var(--tv-safe-x, 5vw) 0 0; }
  .track::-webkit-scrollbar { display: none; }
  /* without a seasons column the row runs to the screen edge: earlier episodes peek in from the left */
  .track.bleed { margin-left: calc(-1 * var(--tv-safe-x, 5vw)); padding-left: var(--tv-safe-x, 5vw); scroll-padding-left: var(--tv-safe-x, 5vw); }
  .strip { display: flex; flex: none; gap: 1.25rem; }
  .sk { flex: 0 0 21rem; aspect-ratio: 16 / 9; }
  :global(html.tv) .ep { flex: 0 0 21rem; min-height: 0; padding: 0; display: flex; flex-direction: column; align-items: stretch; gap: .5rem; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; border-radius: 0;
    transform-origin: 50% 40%; transition: transform calc(var(--tv-d-spring) * .7) var(--tv-emph-out); }
  :global(html.tv) .ep:focus-visible { outline: none; transform: scale(1.06); transition: transform var(--tv-d-spring) var(--tv-spring); }
  .still { position: relative; display: block; aspect-ratio: 16 / 9; border-radius: var(--tv-radius, 6px); background: #1a1a1a; }
  .still img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
  .still::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: var(--tv-card-ring); opacity: 0; transition: opacity calc(var(--tv-d-xs) * .7) ease-in; pointer-events: none; }
  .ep:focus-visible .still::after { opacity: 1; transition: opacity var(--tv-d-xs) ease-out 60ms; }
  .now { position: absolute; left: .625rem; top: .625rem; display: inline-flex; align-items: center; gap: .35rem; padding: .3rem .55rem; border-radius: 4px; background: var(--acc-fill); color: #fff; }
  .pbar { position: absolute; left: .625rem; right: .625rem; bottom: .625rem; height: 4px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .22); }
  .pbar span { position: absolute; inset: 0; background: var(--acc); transform-origin: left center; }
  .nm { font-size: 1.2rem; font-weight: 600; line-height: 1.25; color: var(--tv-white-78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ep:focus-visible .nm { color: #fff; }
  .n { margin-right: .55rem; color: var(--mut); font-variant-numeric: tabular-nums; font-weight: 500; }
  :global(html.tv) .mt { display: flex; align-items: center; gap: .5rem; font-size: 1rem; margin-top: -.2rem; }
  .seen { display: inline-flex; color: var(--tv-white-78); }
  .none { margin: 0; }
  @media (prefers-reduced-motion: reduce) { :global(html.tv) .ep:focus-visible, :global(html.tv) .srow:focus-visible { transform: none; } }
</style>
