<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Neu & demnächst" (just "Neu" without a request service): For you (engine picks with their reason), new series, new episodes of
   * followed shows, new films, this week at ours and what is coming soon. The Alles / Serien / Filme filter lives in the URL
   * (?type=series|movie) and applies to every section; a section without titles is left out. Every section loads on its own and a
   * failed or slow one is simply absent: nothing waits forever and one error never breaks the page.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import { api, type Item } from '#lib/api';
  import { features, featuresKnown } from '#lib/capabilities';
  import { kidsMode } from '#lib/kids';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { runtimeLabel, sortUpcoming } from '#lib/mobile';
  import { episodeItem, FILTER_PARAM, filterSearch, freshText, NEW_TITLE_DAYS, parseFilter, planSections, withinDays, type NewData, type NewEpisode, type NewFilter, type Up } from '#lib/newpage';
  import FilterBar from '#lib/new/FilterBar.svelte';
  import NewEpisodes from '#lib/new/NewEpisodes.svelte';
  import UpcomingList from '#lib/new/UpcomingList.svelte';
  import { reasonText } from '#lib/reason';
  import Row from '#lib/Row.svelte';
  import type { RowNote } from '#lib/rowNote';
  import { mobile } from '#lib/viewport';

  const page = pageStore();

  /** a section that does not answer within this long is left out (never a skeleton forever) */
  const SECTION_TIMEOUT_MS = 8000;
  let d: NewData = { forYou: null, newSeries: null, newMovies: null, episodes: null, week: null, upcoming: null };
  let now = Date.now();
  let mounted = false;

  /** one section's request: its list, or [] when the call fails or takes too long */
  async function section<T>(path: string, pick: (r: any) => T[]): Promise<T[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SECTION_TIMEOUT_MS);
    try { return pick(await api(path, { signal: ctl.signal })) ?? []; } catch { return []; } finally { clearTimeout(timer); }
  }
  const set = <K extends keyof NewData>(k: K, v: NonNullable<NewData[K]>) => { now = Date.now(); d = { ...d, [k]: v }; };
  const ITEMS = (type: 'Series' | 'Movie') => `/api/library/items?types=${type}&sort=DateCreated&desc=true&limit=30`;

  onMount(() => {
    mounted = true;
    void section<Item>('/api/library/new-for-you', (r) => r.items).then((v) => set('forYou', v));
    void section<Item>(ITEMS('Series'), (r) => r.items).then((v) => set('newSeries', withinDays(v, NEW_TITLE_DAYS, Date.now())));
    void section<Item>(ITEMS('Movie'), (r) => r.items).then((v) => set('newMovies', withinDays(v, NEW_TITLE_DAYS, Date.now())));
    void section<NewEpisode>('/api/library/new-episodes', (r) => r.items).then((v) => set('episodes', v));
    void section<Item>('/api/library/trending', (r) => r.items).then((v) => set('week', v));
  });
  // "Demnächst" exists only with a request service; /api/me can change that between visits, so the check is reactive and never cached
  let upStarted = false;
  $: if (mounted && $featuresKnown && $features.requests && !$kidsMode && !upStarted) {
    upStarted = true;
    void Promise.all([section<Up>('/api/seerr/upcoming?type=movie', (r) => r.results), section<Up>('/api/seerr/upcoming?type=tv', (r) => r.results)])
      .then(([m, tv]) => set('upcoming', sortUpcoming([...m, ...tv]).slice(0, 40)));
  }
  $: requests = $featuresKnown && $features.requests && !$kidsMode;

  // ---- filter (URL) ----
  $: filter = parseFilter($page.url.searchParams.get(FILTER_PARAM));
  function pick(f: NewFilter) {
    const q = filterSearch(f);
    void goto(q || $page.url.pathname, { replaceState: true, reset: false });
  }

  // ---- what to show ----
  $: plan = planSections(d, filter, { requests });
  /** the four "new" sections have all answered: until then one placeholder block, so nothing above the fold jumps when sections resolve */
  $: topReady = d.forYou !== null && d.newSeries !== null && d.newMovies !== null && d.episodes !== null;
  $: lowReady = $featuresKnown && d.week !== null && (!requests || d.upcoming !== null);
  $: episodeItems = plan.episodes.map(episodeItem);
  $: episodeFresh = new Map(plan.episodes.map((e) => [e.episode.id, e]));

  const kindLabel = (it: Item) => (it.type === 'Movie' ? $t('home.meta.movie') : $t('home.meta.series'));
  const join = (...p: Array<string | number | undefined | false>) => p.filter(Boolean).join(' · ');
  const forYouNote = (it: Item): RowNote => ({ meta: join(kindLabel(it), it.year), reason: reasonText(it.reason, $t) });
  const seriesNote = (it: Item): RowNote => ({ meta: join(runtimeLabel(it), it.year), fresh: freshText(it.dateCreated, now, $t) });
  const movieNote = (it: Item): RowNote => ({ meta: join($t('home.meta.movie'), runtimeLabel(it)), fresh: freshText(it.dateCreated, now, $t) });
  const episodeNote = (it: Item): RowNote => {
    const e = episodeFresh.get(it.id);
    return { meta: $t('detail.view.episodeCode', { s: String(it.parentIndexNumber ?? '?'), e: String(it.indexNumber ?? '?') }), fresh: e ? freshText(e.episode.addedAt, now, $t) : '' };
  };

  $: heading = $features.requests ? $t('home.new.title') : $t('home.new.titleOnly');
  $: recentHref = filter === 'series' ? '/browse/series?sort=DateCreated' : '/browse/movies?sort=DateCreated';
</script>

<svelte:head><title>{$t('common.pageTitle', { page: heading })}</title></svelte:head>

<div class="np">
  <div class="in">
    <header class="top">
      <h1>{heading}</h1>
      <FilterBar value={filter} on:change={(e) => pick(e.detail)} />
    </header>

    {#if !topReady}
      <div class="sk" role="status" aria-busy="true">
        <span class="sr-only">{$t('common.loading')}</span>
        {#each [0, 1] as _}<div class="skrow" aria-hidden="true"><div class="skeleton skh"></div><div class="skcards">{#each Array($mobile ? 3 : 6) as __}<div class="skeleton skc"></div>{/each}</div></div>{/each}
      </div>
    {:else}
      {#if plan.empty}
        <section class="empty frost frost-panel frost-safe" aria-labelledby="np-empty">
          <span class="ic" aria-hidden="true"><Icon name="clock" size={26} /></span>
          <h2 id="np-empty">{$t('home.new.emptyTitle')}</h2>
          <p>{$t('home.new.emptyText')}</p>
          <div class="btns">
            <a class="btn pill" href={recentHref}>{$t('home.new.emptyRecent')}</a>
            <a class="btn sec" href="/calendar"><Icon name="calendar" size={18} />{$t('home.new.emptyCalendar')}</a>
          </div>
        </section>
      {/if}
      <Row title={$t('home.new.forYou')} sub={$t('home.new.forYouSub')} items={plan.forYou} portrait notes={forYouNote} />
      <Row title={$t('home.new.newSeries')} sub={$t('home.new.newSeriesSub')} items={plan.newSeries} portrait notes={seriesNote} />
      {#if plan.episodes.length}
        {#if $mobile}
          <NewEpisodes title={$t('home.new.newEpisodes')} items={plan.episodes} {now} />
        {:else}
          <Row title={$t('home.new.newEpisodes')} sub={$t('home.new.newEpisodesSub')} items={episodeItems} notes={episodeNote} />
        {/if}
      {/if}
      <Row title={$t('home.new.newMovies')} sub={$t('home.new.newMoviesSub')} items={plan.newMovies} portrait notes={movieNote} />
      {#if lowReady && (plan.week.length || plan.upcoming.length)}
        <div class="split" class:two={plan.week.length > 0 && plan.upcoming.length > 0}>
          {#if plan.week.length}<div class="wk"><Row title={$t('home.rows.trending')} items={plan.week} ranked /></div>{/if}
          {#if plan.upcoming.length}<div class="upc"><UpcomingList items={plan.upcoming} /></div>{/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* the page's padding is given back: rows run edge to edge and carry their own gutters (as on the browse page) */
  .np { margin: 0 calc(var(--pad-x) * -1); padding-bottom: 3rem; }
  :global(html.tv) .in { --pad-x: var(--tv-gutter); }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem 2rem; flex-wrap: wrap; margin: 0 var(--pad-x) 1.2rem; }
  h1 { margin: 0; }
  :global(html.tv) .top { margin-bottom: 0; }
  @media (max-width: 720px) { .top { display: grid; gap: .8rem; } }

  .sk { margin-top: 1.5rem; display: grid; gap: 1.6rem; }
  .skrow { display: grid; gap: .8rem; padding: 0 var(--pad-x); }
  .skh { width: 9rem; height: 1.3rem; border-radius: 6px; }
  .skcards { display: flex; gap: 8px; overflow: hidden; }
  .skc { flex: 0 0 calc((100% - 5 * 8px) / 6); aspect-ratio: 2 / 3; border-radius: 12px; }
  :global(html.tv) .skc { aspect-ratio: 16 / 9; border-radius: var(--tv-radius); }
  @media (max-width: 720px) { .skc { flex-basis: calc((100% - 2 * 8px) / 3.2); } }

  .empty { display: grid; justify-items: center; gap: .5rem; text-align: center; margin: 1.5rem var(--pad-x) 0; padding: 1.8rem 1.4rem; max-width: 34rem; border-radius: var(--fr-r-panel, 18px); }
  @media (min-width: 721px) { .empty { margin-inline: auto; } }
  .ic { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 50%; background: var(--fr-sel); color: var(--acc-text); }
  .empty h2 { margin: .4rem 0 0; font-size: 1.25rem; font-weight: 800; line-height: 1.25; }
  .empty p { margin: 0 0 .8rem; color: var(--mut); max-width: 28rem; }
  .btns { display: flex; flex-wrap: wrap; justify-content: center; gap: .6rem; }
  :global(html.tv) .empty { max-width: 44rem; }
  :global(html.tv) .empty h2 { font-size: 1.75rem; }
  :global(html.tv) .empty p { font-size: 1.25rem; }

  .split { display: block; }
  .upc { padding: 0 var(--pad-x); }
  @media (min-width: 1000px) {
    .split.two { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); column-gap: 2rem; align-items: start; }
    .split.two .upc { padding: 0 var(--pad-x) 0 0; }
    /* the ranked strip shares the row with "Demnächst": four posters across its half */
    .split.two .wk :global(section.row.dk.rk) { --n: 4; }
  }
  :global(html.tv) .upc { margin-top: 1.6rem; }
</style>
