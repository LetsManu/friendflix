<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script context="module" lang="ts">
  /** the TV detail sub-screens (spec 3), each a route under /item/[id]/ */
  export type TvSubId = 'episodes' | 'more' | 'info' | 'extras' | 'collection' | 'story';
</script>
<script lang="ts">
  import type { Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import type { Facts } from '#lib/fresh';
  import type { About } from '#lib/detail/about';
  import type { Person } from '#lib/detail/format';
  import { uniqueBy } from '#lib/detail/safe';
  import { tileInfo } from '#lib/tv/focusTile';
  import { followFocus } from '#lib/tv/follow';
  import { playPrefetch } from '#lib/player/prefetch';
  import Icon from '#lib/Icon.svelte';
  import CastRow from '#lib/CastRow.svelte';
  import TvSubScreen from '#lib/detail/TvSubScreen.svelte';
  import TvEpisodes from '#lib/detail/TvEpisodes.svelte';
  import TvGrid, { type GridEntry } from '#lib/detail/TvGrid.svelte';
  import DetailsTab from '#lib/detail/DetailsTab.svelte';
  import RatingsLine from '#lib/detail/RatingsLine.svelte';
  import StoryCard from '#lib/detail/StoryCard.svelte';
  import Safe from '#lib/detail/Safe.svelte';

  /** Everything comes from DetailView (the same loads as the detail page); this only arranges one sub-screen in the TV frame. */
  export let sub: TvSubId;
  export let item: Item;
  export let about: About | null | undefined = undefined;
  export let facts: Facts | null = null;
  export let people: Person[] = [];
  export let extras: Array<Item & { kind?: 'trailer' | 'extra' }> = [];
  export let more: Item[] | null = null;
  export let seasons: Item[] = [];
  export let season = '';
  export let episodes: Item[] | null = null;
  export let next: Item | null = null;
  export let seriesKnown = true;
  export let qs = '';
  export let overview = '';
  export let playHref = '';
  export let playLabel = '';
  export let playAria: string | undefined = undefined;
  export let titleId = 'detail-title';

  $: title = ({
    episodes: $t('tv.detail.episodes'), more: $t('detail.more.title'), info: $t('home.hero.moreInfo'), extras: $t('hubs.extras.tab'),
    collection: about?.collection?.name ?? $t('tv.detail.collection'), story: $t('fresh.story.title'),
  } as Record<TvSubId, string>)[sub];

  const dot = (parts: Array<string | number | undefined | null | false>) => parts.filter(Boolean).join(' · ');
  const mins = (x: Item) => (x.runtimeTicks ? $t('common.duration.m', { m: Math.max(1, Math.round(x.runtimeTicks / 600_000_000)) }) : '');
  // More like this: the recommendation reason when the engine gave one, else the title's facts (the focus tile's meta line)
  $: moreEntries = more === null ? null : uniqueBy(more, (i) => i.id).map((i): GridEntry => {
    const info = tileInfo(i, $t);
    return { key: i.id, name: info.title, line: info.reason || info.meta.join(' · '), item: i };
  });
  $: extraEntries = uniqueBy(extras, (x) => x.id).map((x): GridEntry => ({
    key: x.id, name: x.name, line: dot([x.kind === 'trailer' ? $t('hubs.extras.trailer') : $t('hubs.extras.extra'), mins(x)]), item: x,
    to: `/watch/${x.id}${qs ? '?' + qs : ''}`,
  }));
  // the collection's parts: those in the library are cards (posters), the others dim placeholders
  $: partEntries = about === undefined ? null : (about?.collection?.parts ?? []).map((p, i): GridEntry => ({
    key: p.id ?? `t${p.tmdbId ?? ''}:${i}`, name: p.name,
    line: dot([p.year, p.played && $t('detail.collection.watched'), !p.inLibrary && $t('detail.collection.missing')]),
    item: p.inLibrary && p.id ? { id: p.id, name: p.name, type: 'Movie', year: p.year, genres: [], image: p.image, backdrop: false, logo: false, played: p.played, favorite: false, positionTicks: 0 } : undefined,
    missing: p.inLibrary && p.id ? undefined : { poster: p.poster },
  }));
</script>

<TvSubScreen {item} {title} {titleId}>
  {#if sub === 'episodes'}
    {#if seriesKnown}
      <Safe name="episodes" key={item.id}><TvEpisodes {seasons} bind:season {episodes} {next} {qs} /></Safe>
    {/if}
  {:else if sub === 'more'}
    <Safe name="more" key={item.id}><TvGrid entries={moreEntries} label={title} /></Safe>
  {:else if sub === 'extras'}
    <Safe name="extras" key={item.id}><TvGrid entries={extraEntries} label={title} /></Safe>
  {:else if sub === 'collection'}
    <Safe name="collection" key={item.id}><TvGrid entries={partEntries} poster label={title} /></Safe>
  {:else if sub === 'info'}
    <div class="info">
      <div class="win lcol" use:followFocus>
        <div class="strip">
          <Safe name="ratings" key={item.id}><RatingsLine {about} /></Safe>
          {#if overview}<p class="tv-body syn">{overview}</p>{/if}
          <Safe name="details" key={item.id}><DetailsTab {item} {people} {facts} {about} /></Safe>
        </div>
      </div>
      <div class="win rcol" use:followFocus={{ peek: 0.5 }}>
        <div class="strip"><Safe name="cast" key={item.id}><CastRow id={item.id} {people} /></Safe></div>
      </div>
    </div>
  {:else if sub === 'story'}
    <div class="sstory">
      <Safe name="story" key={item.id}><StoryCard seriesId={item.id} /></Safe>
      {#if playHref}<p class="go"><a class="tv-btn" data-autofocus href={playHref} aria-label={playAria} use:playPrefetch><Icon name="play" size={24} />{playLabel}</a></p>{/if}
    </div>
  {/if}
</TvSubScreen>

<style>
  /* ---- Info: a calm two-column page; the left column reads (ratings, synopsis, facts), the right one is the people ---- */
  .info { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); column-gap: 5rem; }
  .win { min-height: 0; margin: 0 -1.5rem; padding: .5rem 1.5rem 5vh; overflow-x: visible; overflow-y: clip; }
  /* Chromium < 90 (webOS 22) has no overflow: clip: hidden instead (the window's scroll is held at 0, see tv/clip.ts) */
  @supports not (overflow: clip) { .win { overflow: hidden; } }
  .win:global(.below) { -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); mask-image: linear-gradient(180deg, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); }
  .win:global(.above) { -webkit-mask-image: linear-gradient(0deg, #000 calc(100% - 4rem), transparent); mask-image: linear-gradient(0deg, #000 calc(100% - 4rem), transparent); }
  .win:global(.above.below) { -webkit-mask-image: linear-gradient(180deg, transparent, #000 4rem, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); mask-image: linear-gradient(180deg, transparent, #000 4rem, #000 calc(100% - 7rem), transparent calc(100% - 5vh)); }
  .syn { margin: 1.2rem 0 0; display: -webkit-box; -webkit-line-clamp: 5; line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
  :global(html.tv) .syn { font-size: 1.2rem; max-width: 52ch; }
  /* the ratings line: the meta line's quiet type, its parts separated by space only */
  .lcol :global(.rl) { margin: 0; font-size: 1.1rem; font-weight: 500; color: var(--tv-white-88); }
  /* the Details tab at TV size; its heading repeats the screen title, the outbound web links lead nowhere on a TV, and the
     friends' card (stars, a typed review) is social UI the TV leaves out (spec 3) */
  .lcol :global(.info h2), .lcol :global(.links), .lcol :global(.social) { display: none; }
  .lcol :global(.dt .info) { margin-top: 1.6rem; }
  .lcol :global(.dt .facts) { margin-top: .7rem; }
  .lcol :global(.dt dl) { gap: .7rem; font-size: 1.1rem; }
  .lcol :global(.dt dl > div) { grid-template-columns: 11rem minmax(0, 1fr); gap: 1.2rem; }
  .lcol :global(.dt dt) { color: var(--mut); font-weight: 500; }
  .lcol :global(.dt dd) { color: var(--tv-white-88); }
  .lcol :global(.dt dd a) { color: inherit; border-radius: 4px; }
  .lcol :global(.attrib) { font-size: .9rem; color: var(--mut); }
  /* the cast: a grid of people (photo or initials), three across; focus = the photo's ring + scale, like a card */
  .rcol .strip :global(.cast) { margin: 0; }
  .rcol :global(.cast h2) { margin: 0 0 1.2rem; font-size: 1.3rem; font-weight: 600; color: var(--tv-white-88); }
  .rcol :global(.cast ul) { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.6rem 1rem; overflow: visible; padding: 0; }
  .rcol :global(.cast li) { display: flex; }
  .rcol :global(.cast a) { width: 100%; gap: .5rem; outline: none; }
  .rcol :global(.cast .av) { position: relative; width: 6rem; height: 6rem; overflow: visible; background: #1a1a1a; font-size: 1.4rem; transition: transform calc(var(--tv-d-spring) * .7) var(--tv-emph-out); }
  .rcol :global(.cast .av img) { border-radius: 50%; }
  .rcol :global(.cast .av::after) { content: ''; position: absolute; inset: 0; border-radius: 50%; box-shadow: var(--tv-card-ring); opacity: 0; transition: opacity calc(var(--tv-d-xs) * .7) ease-in; }
  .rcol :global(.cast a:focus-visible .av) { transform: scale(1.08); transition: transform var(--tv-d-spring) var(--tv-spring); }
  .rcol :global(.cast a:focus-visible .av::after) { opacity: 1; transition: opacity var(--tv-d-xs) ease-out 60ms; }
  .rcol :global(.cast .nm) { font-size: 1.05rem; color: var(--tv-white-88); }
  .rcol :global(.cast a:focus-visible .nm) { color: #fff; text-decoration: none; }
  .rcol :global(.cast .rl) { font-size: .95rem; color: var(--mut); }
  @media (prefers-reduced-motion: reduce) { .rcol :global(.cast a:focus-visible .av) { transform: none; } }

  /* ---- Story so far: the two blocks as reading text, then the way on ---- */
  .sstory { max-width: 62rem; }
  .sstory :global(.story) { margin: 0; padding: 0; background: none; border: 0; border-radius: 0; }
  .sstory :global(.story h2), .sstory :global(.story .x) { display: none; }
  .sstory :global(.story .why) { margin: 0; font-size: 1.1rem; font-weight: 500; color: var(--acc); }
  .sstory :global(.story .blk) { margin-top: 1.8rem; }
  .sstory :global(.story h3) { margin: 0 0 .5rem; font-size: 1.3rem; font-weight: 600; color: var(--tv-white-88); }
  .sstory :global(.story p) { font-size: 1.2rem; line-height: 1.5; color: var(--tv-white-78); max-width: 60ch; }
  .go { margin: 2.4rem 0 0; }
</style>
