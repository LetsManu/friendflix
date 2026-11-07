<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { img, type Item } from '#lib/api';
  import { fmtDate, t } from '#lib/i18n';
  import { prefs } from '#lib/stores';
  import { isSpoiler } from '#lib/spoiler';
  import { seasonLabel } from '#lib/detail/format';
  import { playPrefetch } from '#lib/player/prefetch';
  import { playOrCast } from '#lib/cast/playOrCast';
  import { focusEl } from '#lib/spatial';
  import { decodeFade, stagger } from '#lib/tv/motion';
  import { followFocus } from '#lib/tv/follow';
  import Icon from '#lib/Icon.svelte';

  /**
   * TV "Episodes & seasons" (spec 3): the seasons as a quiet list on the left, the selected season's episodes as large rows on
   * the right (16:9 still with progress, number + name, length · air date, two lines of synopsis). Moving onto a season selects
   * it (the list follows, the focus stays); Right enters the list at the next-up episode, Left returns to the selected season.
   * Same data as the desktop EpisodeList (DetailView loads it), same player links.
   */
  export let seasons: Item[];
  /** selected season id (two-way: DetailView loads its episodes) */
  export let season = '';
  /** null = loading */
  export let episodes: Item[] | null;
  export let next: Item | null = null;
  /** audio / subtitle choice for the player links */
  export let qs = '';

  const trackOpts = (q: string) => { const p = new URLSearchParams(q); return { audio: p.get('audio') ?? undefined, subtitle: p.get('sub') ?? undefined }; };
  const href = (e: Item) => `/watch/${e.id}${qs ? '?' + qs : ''}`;
  const mins = (e: Item) => (e.runtimeTicks ? $t('common.duration.m', { m: Math.max(1, Math.round(e.runtimeTicks / 600_000_000)) }) : '');
  const aired = (e: Item) => (e.premiereDate ? fmtDate(e.premiereDate, { dateStyle: 'medium' }) : '');
  const pct = (e: Item) => (e.positionTicks && e.runtimeTicks ? Math.min(1, Math.max(0.02, e.positionTicks / e.runtimeTicks)) : 0);

  /** where Right lands and what the screen opens on: the next-up episode, else the first unwatched one, else the first */
  $: auto = episodes?.find((e) => e.id === next?.id) ?? episodes?.find((e) => !e.played) ?? episodes?.[0] ?? null;

  let root: HTMLDivElement | undefined, list: HTMLDivElement | undefined, keyed = false;
  /** moving onto a season selects it, but only when the viewer moved there (the layout's own first focus must not switch it) */
  function pick(id: string) { if (id !== season) season = id; }
  const selected = () => root?.querySelector<HTMLElement>('.seasons .on') ?? null;
  const target = () => (auto && list?.querySelector<HTMLElement>(`a[data-ep="${auto.id}"]`)) || list?.querySelector<HTMLElement>('a[data-ep]') || null;
  /** spatial navigation asks first ("ff-nav"): the columns switch on purpose, not to the geometric neighbour */
  function onNav(e: Event) {
    const dir = (e as CustomEvent<{ dir: string }>).detail?.dir, el = e.target as HTMLElement;
    const to = dir === 'right' && el.closest('.seasons') ? target() : dir === 'left' && el.closest('.eplist') ? selected() : null;
    if (to) { e.preventDefault(); focusEl(to); }
  }

  // a new season's list enters with a short stagger (30 ms apart); the first list just appears (the page transition moved it)
  let shown = '', first = true;
  $: if (episodes && list) enter(season);
  function enter(key: string) {
    if (key === shown) return;
    shown = key;
    const initial = first;
    first = false;
    void tick().then(() => {
      if (!list) return;
      if (!initial) stagger([...list.querySelectorAll<HTMLElement>('[data-follow]')].slice(0, 5), { gap: 30 });
      // the screen opens on the next-up episode, also when the list came after the layout placed a first focus
      else if (!keyed && target() && (document.activeElement === document.body || root?.contains(document.activeElement))) focusEl(target()!);
    });
  }
  onMount(() => {
    const k = () => (keyed = true);
    root?.addEventListener('ff-nav', onNav);
    window.addEventListener('keydown', k, true);
    return () => { root?.removeEventListener('ff-nav', onNav); window.removeEventListener('keydown', k, true); };
  });
</script>

<div class="eps" bind:this={root}>
  <div class="col seasons win" use:followFocus>
    <div class="strip" role="group" aria-label={$t('tv.sub.seasons')}>
      {#each seasons as s (s.id)}
        <div data-follow><button type="button" class="tv-btn srow" class:on={s.id === season} aria-pressed={s.id === season} on:focus={() => { if (keyed) pick(s.id); }} on:click={() => pick(s.id)}>{seasonLabel(s)}</button></div>
      {/each}
    </div>
  </div>

  <div class="col eplist win" use:followFocus={{ key: season, peek: 0.35 }} bind:this={list}>
    <ol class="strip">
      {#if episodes === null}
        {#each [0, 1, 2] as k (k)}<li class="ep sk" aria-hidden="true"><span class="skeleton still"></span><span class="tx"><span class="skeleton l1"></span><span class="skeleton l2"></span></span></li>{/each}
      {:else if !episodes.length}
        <li class="none tv-meta">{$t('detail.episodes.none')}</li>
      {:else}
        {#each episodes as e (e.id)}
          {@const p = pct(e)}
          {@const spoil = isSpoiler(e, $prefs)}
          <li data-follow>
            <a class="ep" href={href(e)} data-ep={e.id} data-autofocus={auto?.id === e.id ? '' : undefined} aria-current={next?.id === e.id ? 'true' : undefined}
              data-play-scope use:playPrefetch on:click={(ev) => playOrCast(ev, e, trackOpts(qs))}>
              <span class="still" data-play-art>
                {#if e.image && !spoil}<img src={img(e.id, 640)} alt="" loading="lazy" decoding="async" use:decodeFade />{/if}
                {#if p}<span class="bar" aria-hidden="true"><span style="transform:scaleX({p})"></span></span>{/if}
              </span>
              <span class="tx">
                <span class="nm">{#if e.indexNumber !== undefined}<span class="n">{e.indexNumber}</span><span class="sr-only">{$t('detail.episodes.episodeN', { n: e.indexNumber })}</span>{/if}{e.name}</span>
                <span class="tv-meta meta">
                  {#each [mins(e), aired(e)].filter(Boolean) as m, i (i)}{#if i}<span class="sep" aria-hidden="true">·</span>{/if}<span>{m}</span>{/each}
                  {#if e.played}{#if mins(e) || aired(e)}<span class="sep" aria-hidden="true">·</span>{/if}<span class="seen"><Icon name="check" size={20} />{$t('detail.episodes.watched')}</span>{/if}
                </span>
                <span class="tv-body ov">{spoil ? $t('detail.episodes.spoiler') : e.overview ?? ''}</span>
              </span>
            </a>
          </li>
        {/each}
      {/if}
    </ol>
  </div>
</div>

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
  .eps { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 16rem minmax(0, 1fr); column-gap: 3.5rem; }

  /* both columns are windows: they clip vertically and glide (lib/tv/follow.ts); the padding is room for the focus scale */
  .win { min-height: 0; margin: 0 -1.5rem; padding: .5rem 1.5rem 5vh; overflow-x: visible; overflow-y: clip; }
  .win:global(.below) { -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); mask-image: linear-gradient(180deg, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); }
  .win:global(.above) { -webkit-mask-image: linear-gradient(0deg, #000 calc(100% - 4rem), transparent); mask-image: linear-gradient(0deg, #000 calc(100% - 4rem), transparent); }
  .win:global(.above.below) { -webkit-mask-image: linear-gradient(180deg, transparent, #000 4rem, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); mask-image: linear-gradient(180deg, transparent, #000 4rem, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); }
  .strip { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }

  /* seasons: the detail page's list rows (R16): transparent at rest, white fill + spring scale on focus; the selected season keeps
     a quiet fill while the focus is in the episodes */
  .seasons .strip { gap: .6rem; }
  .seasons [data-follow] { display: flex; }
  :global(html.tv) .srow { flex: 1 1 auto; min-height: 2.8rem; padding: 0 1.4rem; font-size: 1.1rem; justify-content: flex-start; transform-origin: left center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(html.tv) .srow:not(:focus-visible) { background: transparent; color: var(--tv-white-78); }
  :global(html.tv) .srow.on:not(:focus-visible) { background: var(--tv-btn-rest); color: #fff; }
  :global(html.tv) .srow:focus-visible { transform: scale(1.03); }

  /* episodes: large rows. Focus = the row lifts (spring scale from its left edge, a faint plate fades in behind it) and the
     still takes the card ring; text brightens. No outline (spec 5.1). */
  .eplist .strip { gap: .5rem; }
  /* the focused row grows 2 % to the right: keep that inside the 5 vw safe area */
  .eplist.win { padding-right: 3rem; }
  .ep { position: relative; display: grid; grid-template-columns: 16rem minmax(0, 1fr); column-gap: 1.75rem; align-items: center; padding: .8rem; border-radius: 10px; color: inherit; text-decoration: none;
    transform-origin: left center; transition: transform calc(var(--tv-d-spring) * .7) var(--tv-emph-out); }
  .ep::before { content: ''; position: absolute; inset: 0; border-radius: inherit; background: rgba(255, 255, 255, .07); opacity: 0; transition: opacity calc(var(--tv-d-xs) * .7) ease-in; pointer-events: none; }
  :global(html.tv) .ep:focus-visible { outline: none; transform: scale(1.02); transition: transform var(--tv-d-spring) var(--tv-spring); }
  .ep:focus-visible::before { opacity: 1; transition: opacity var(--tv-d-xs) ease-out; }
  /* not overflow-clipped: the ring layer (::after) lies outside the box; the picture carries the radius itself */
  .still { position: relative; display: block; aspect-ratio: 16 / 9; border-radius: var(--tv-radius, 6px); background: #1a1a1a; }
  .still img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
  .still::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: var(--tv-card-ring); opacity: 0; transition: opacity calc(var(--tv-d-xs) * .7) ease-in; pointer-events: none; }
  .ep:focus-visible .still::after { opacity: 1; transition: opacity var(--tv-d-xs) ease-out 60ms; }
  /* watched progress (spec 5.1): 4 px, coral on 22 % white, inset 10 px */
  .bar { position: absolute; left: .625rem; right: .625rem; bottom: .625rem; height: 4px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .22); }
  .bar span { position: absolute; inset: 0; background: var(--acc); transform-origin: left center; }

  .tx { position: relative; min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
  .nm { font-size: 1.3rem; font-weight: 600; line-height: 1.25; color: var(--tv-white-88); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ep:focus-visible .nm { color: #fff; }
  .n { display: inline-block; min-width: 1.6rem; margin-right: .6rem; color: var(--mut); font-variant-numeric: tabular-nums; font-weight: 500; }
  :global(html.tv) .meta { margin: 0; display: flex; align-items: center; flex-wrap: wrap; font-size: 1.05rem; }
  .sep { margin: 0 .625rem; color: var(--tv-sep); }
  .seen { display: inline-flex; align-items: center; gap: .35rem; }
  :global(html.tv) .ov { margin: .15rem 0 0; font-size: 1.2rem; max-width: 60ch; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .ep:focus-visible .ov { color: var(--tv-white-88); }

  .sk { pointer-events: none; }
  .sk .l1 { display: block; height: 1.3rem; width: 40%; }
  .sk .l2 { display: block; height: 2.6rem; width: 80%; margin-top: .4rem; }
  .none { padding: 1rem .8rem; }

  @media (prefers-reduced-motion: reduce) {
    :global(html.tv) .ep:focus-visible, :global(html.tv) .srow:focus-visible { transform: none; }
  }
</style>
