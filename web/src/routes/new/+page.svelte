<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Neu & demnächst" (just "Neu" without a request service): For you (engine picks with their reason), new series, new episodes of
   * followed shows, new films, this week at ours and what is coming soon. A section without titles is left out. Every section loads on its own and a
   * failed or slow one is simply absent: nothing waits forever and one error never breaks the page.
   */
  import { onMount } from 'svelte';
      import { api, type Item } from '#lib/api';
        import { t } from '#lib/i18n';
  import { runtimeLabel, sortUpcoming } from '#lib/mobile';
  import { episodeItem, freshText, NEW_TITLE_DAYS, planSections, withinDays, type NewData, type NewEpisode, type Up } from '#lib/newpage';
    import NewEpisodes from '#lib/new/NewEpisodes.svelte';
  import UpcomingList from '#lib/new/UpcomingList.svelte';
  import { reasonText } from '#lib/reason';
  import Row from '#lib/Row.svelte';
  import type { RowNote } from '#lib/rowNote';
  import { mobile } from '#lib/viewport';

  /** a section that does not answer within this long is left out (never a skeleton forever) */
  const SECTION_TIMEOUT_MS = 8000;
  let d: NewData = { forYou: null, newSeries: null, newMovies: null, episodes: null, week: null, upcoming: null };
  let now = Date.now();

  /** one section's request: its list, or [] when the call fails or takes too long */
  async function section<T>(path: string, pick: (r: any) => T[]): Promise<T[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SECTION_TIMEOUT_MS);
    try { return pick(await api(path, { signal: ctl.signal })) ?? []; } catch { return []; } finally { clearTimeout(timer); }
  }
  const set = <K extends keyof NewData>(k: K, v: NonNullable<NewData[K]>) => { now = Date.now(); d = { ...d, [k]: v }; };
  const ITEMS = (type: 'Series' | 'Movie') => `/api/library/items?types=${type}&sort=DateCreated&desc=true&limit=30`;

  onMount(() => {
    void section<Item>('/api/library/new-for-you', (r) => r.items).then((v) => set('forYou', v));
    void section<Item>(ITEMS('Series'), (r) => r.items).then((v) => set('newSeries', withinDays(v, NEW_TITLE_DAYS, Date.now())));
    void section<Item>(ITEMS('Movie'), (r) => r.items).then((v) => set('newMovies', withinDays(v, NEW_TITLE_DAYS, Date.now())));
    void section<NewEpisode>('/api/library/new-episodes', (r) => r.items).then((v) => set('episodes', v));
    void section<Item>('/api/library/trending', (r) => r.items).then((v) => set('week', v));
    void Promise.all([section<Up>('/api/seerr/upcoming?type=movie', (r) => r.results), section<Up>('/api/seerr/upcoming?type=tv', (r) => r.results)])
      .then(([m, tv]) => set('upcoming', sortUpcoming([...m, ...tv]).slice(0, 40)));
  });

  // ---- what to show ----
  $: plan = planSections(d, 'all', { requests: true });
  /** the four "new" sections have all answered: until then one placeholder block, so nothing above the fold jumps when sections resolve */
  $: topReady = d.forYou !== null && d.newSeries !== null && d.newMovies !== null && d.episodes !== null;
  $: lowReady = d.week !== null && d.upcoming !== null;
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

</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('home.new.title') })}</title></svelte:head>

<div class="np">
  <div class="in">
    <header class="top">
      <h1>{$t('home.new.title')}</h1>
    </header>

    {#if !topReady}
      <div class="sk" role="status" aria-busy="true">
        <span class="sr-only">{$t('common.loading')}</span>
        {#each [0, 1] as _}<div class="skrow" aria-hidden="true"><div class="skeleton skh"></div><div class="skcards">{#each Array($mobile ? 3 : 6) as __}<div class="skeleton skc"></div>{/each}</div></div>{/each}
      </div>
    {:else}
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
