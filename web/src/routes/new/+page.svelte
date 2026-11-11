<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  /** when the page last asked /api/me for the feature flags (a module value: it survives client-side navigation) */
  let flagsAt = 0;
</script>

<script lang="ts">
  /**
   * "Neu & demnächst" (just "Neu" for kids and without a request service). Three tabs - Für dich (the engine's picks with their
   * reason, suggestions that are not in the library yet with a Wünschen button, new episodes), Neu in der Bibliothek (everything
   * added lately, this week at ours) and Wünsche & demnächst (search, own requests, announced titles). The tab (?tab=) and the
   * Alles / Serien / Filme filter (?type=) live in the URL: a tab change is a history entry (back steps through tabs), a filter
   * change replaces the entry (the filter is a view). Every section loads on its own and a failed or slow one is simply absent:
   * nothing waits forever and one error never breaks the page. The television keeps the plain stacked rows (no tabs, no wishes).
   */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import { api, ApiError, type Item } from '#lib/api';
  import { features, featuresFrom, featuresKnown } from '#lib/capabilities';
  import { kidsMode } from '#lib/kids';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { runtimeLabel, sortUpcoming } from '#lib/mobile';
  import {
    episodeItem, FILTER_PARAM, SUGGEST_TIMEOUT_MS, availableTabs, forYouItems, freshText, completeSuggestions, earlySuggestions, runGuard, NEW_TITLE_DAYS, openRequests, pageSearch, parseFilter, parseTab, planSections, quotaLeft, TAB_PARAM,
    withinDays, type NewData, type NewEpisode, type NewFilter, type NewTab, type Suggestion, type Up,
  } from '#lib/newpage';
  import FilterBar from '#lib/new/FilterBar.svelte';
  import LibraryGrid from '#lib/new/LibraryGrid.svelte';
  import EpisodeCards from '#lib/new/EpisodeCards.svelte';
  import NewEpisodes from '#lib/new/NewEpisodes.svelte';
  import Spotlight from '#lib/new/Spotlight.svelte';
  import Suggestions from '#lib/new/Suggestions.svelte';
  import Tabs from '#lib/new/Tabs.svelte';
  import UpcomingList from '#lib/new/UpcomingList.svelte';
  import WishPanel from '#lib/new/WishPanel.svelte';
  import { reasonText } from '#lib/reason';
  import { loadMine, loadQuota, mine, quota } from '#lib/requests/wish';
  import Row from '#lib/Row.svelte';
  import type { RowNote } from '#lib/rowNote';
  import { mobile } from '#lib/viewport';

  const page = pageStore();

  /** a section that does not answer within this long is left out (never a skeleton forever) */
  const SECTION_TIMEOUT_MS = 8000;
  /** the calls the first view waits for: given up sooner (the server keeps building and caches it for the next visit); the suggestions have their own, longer SUGGEST_TIMEOUT_MS */
  const FAST_TIMEOUT_MS = 4000;
  /** which halves of the suggestions are still on their way */
  let pendingMovies = false, pendingSeries = false;
  /** a placeholder is only kept for a half that counts under the filter */
  $: suggestLoading = (pendingMovies && filter !== 'series') || (pendingSeries && filter !== 'movie');
  const wishRun = runGuard();
  let d: NewData = { forYou: null, newSeries: null, newMovies: null, episodes: null, week: null, upcoming: null, suggest: null };
  let now = Date.now();
  let mounted = false;
  let tv = false;
  let wp: WishPanel | undefined;
  let wantFocus = false;

  /** a vanished request service (the admin removed it while this tab was open): the page drops everything that needs it */
  function serviceGone(e: unknown) {
    if (e instanceof ApiError && e.body?.error === 'requests_disabled') features.update((f) => ({ ...f, requests: false }));
  }
  /** one call, null when it fails or takes too long */
  async function fetchJson<R>(path: string, ms = SECTION_TIMEOUT_MS): Promise<R | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try { return await api<R>(path, { signal: ctl.signal }); } catch (e) { serviceGone(e); return null; } finally { clearTimeout(timer); }
  }
  /** one section's list, or [] when the call fails or takes too long */
  async function section<T>(path: string, pick: (r: any) => T[], ms = SECTION_TIMEOUT_MS): Promise<T[]> {
    const r = await fetchJson<unknown>(path, ms);
    return (r ? pick(r) : null) ?? [];
  }
  const set = <K extends keyof NewData>(k: K, v: NonNullable<NewData[K]>) => { now = Date.now(); d = { ...d, [k]: v }; };
  const ITEMS = (type: 'Series' | 'Movie') => `/api/library/items?types=${type}&sort=DateCreated&desc=true&limit=30`;

  /** the feature flags change when an admin connects or removes the request service: re-read them (at most every 30 s) */
  async function refreshFlags(force = false) {
    if (!force && Date.now() - flagsAt < 30_000) return;
    flagsAt = Date.now();
    try { features.set(featuresFrom((await api<{ features?: unknown }>('/api/me')).features)); } catch { /* keep what we know */ }
  }

  onMount(() => {
    mounted = true;
    const syncTv = () => { tv = document.documentElement.classList.contains('tv'); };
    syncTv();
    const mo = new MutationObserver(syncTv);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const onFocus = () => { if (document.visibilityState === 'visible') void refreshFlags(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    void refreshFlags();

    void section<Item>('/api/library/new-for-you', (r) => forYouItems(r), FAST_TIMEOUT_MS).then((v) => set('forYou', v));
    void section<Item>(ITEMS('Series'), (r) => r.items).then((v) => set('newSeries', withinDays(v, NEW_TITLE_DAYS, Date.now())));
    void section<Item>(ITEMS('Movie'), (r) => r.items).then((v) => set('newMovies', withinDays(v, NEW_TITLE_DAYS, Date.now())));
    void section<NewEpisode>('/api/library/new-episodes', (r) => r.items, FAST_TIMEOUT_MS).then((v) => set('episodes', v));
    // this week at ours: grown-ups only (the route refuses kids); it needs no feature flag
    if ($kidsMode) set('week', []);
    else void section<Item>('/api/library/trending', (r) => r.items).then((v) => set('week', v));
    return () => { mo.disconnect(); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  });

  // what needs the request service starts once /api/me has confirmed it (a page rendered from the last visit's hint must not call
  // a service that may be gone): suggestions, the quota, the own requests, the announced titles
  let wishStarted = false;
  $: if (mounted && requests && !wishStarted) {
    wishStarted = true;
    void loadWishData();
  }
  // the service went away while the tab was open: forget what it gave, so that it starts afresh when it comes back
  $: if (!requests && wishStarted) {
    wishStarted = false;
    d = { ...d, suggest: null, upcoming: null };
    wishRun.cancel();
    pendingMovies = pendingSeries = false;
  }
  async function loadWishData() {
    void Promise.all([section<Up>('/api/seerr/upcoming?type=movie', (r) => r.results), section<Up>('/api/seerr/upcoming?type=tv', (r) => r.results)])
      .then(([m, s]) => set('upcoming', sortUpcoming([...m, ...s]).slice(0, 40)));
    // the television shows no wishes: only the announced titles
    if (tv) { set('suggest', []); return; }
    void loadMine();
    type Answer = { items: Suggestion[]; quota: { limit: number | null; used: number; resetsAt: string } | null };
    // each half is shown as soon as it arrives (a cached one is quick, a cold build is not); the slots of the other stay skeletons meanwhile
    // the first to arrive takes at most half of the slots, the second fills the others behind it: the cards on screen never move
    let early: Suggestion[] | null = null, shown: Suggestion[] = [];
    const run = wishRun.start(); // a load that is overtaken (the service went away and came back) writes nothing
    pendingMovies = pendingSeries = true;
    const arrive = (items: Suggestion[]) => {
      if (wishRun.stale(run)) return;
      if (early === null) { early = items; shown = earlySuggestions(items, slots, filter === 'all'); set('suggest', shown); }
      else set('suggest', completeSuggestions(shown, early, items));
    };
    const [m, s] = await Promise.all([
      fetchJson<Answer>('/api/library/request-suggestions?type=movie', SUGGEST_TIMEOUT_MS).then((r) => { if (!wishRun.stale(run)) pendingMovies = false; arrive(r?.items ?? []); return r; }),
      fetchJson<Answer>('/api/library/request-suggestions?type=series', SUGGEST_TIMEOUT_MS).then((r) => { if (!wishRun.stale(run)) pendingSeries = false; arrive(r?.items ?? []); return r; }),
    ]);
    if (wishRun.stale(run)) return;
    const q = m?.quota ?? s?.quota ?? null;
    if (q) quota.set(q); else void loadQuota();
  }

  /** grown-up profile with a request service (as far as we know: the hint of the last visit until /api/me answered) */
  $: canWish = $features.requests && !$kidsMode;
  /** the same, confirmed by /api/me: only then the page calls the service */
  $: requests = $featuresKnown && canWish;

  // ---- tab and filter (URL) ----
  $: tabs = availableTabs({ requests: canWish });
  $: tab = parseTab($page.url.searchParams.get(TAB_PARAM), { requests: canWish });
  $: filter = parseFilter($page.url.searchParams.get(FILTER_PARAM));
  const go = (t: NewTab, f: NewFilter, replace: boolean) => goto(pageSearch(t, f) || $page.url.pathname, { replace, reset: false });
  const pickTab = (t: NewTab) => { void go(t, filter, false); };
  const pickFilter = (f: NewFilter) => { void go(tab, f, true); };
  async function wish() {
    if (tab === 'wishes') { wp?.focusSearch(); return; }
    wantFocus = true;
    await go('wishes', filter, false);
    await tick();
    wantFocus = false;
  }

  // ---- what to show ----
  $: plan = planSections(d, filter, { requests: canWish });
  /** each tab waits only for its own library calls (never for the request service: the suggestions have a slot of their own) */
  $: forYouReady = d.forYou !== null && d.episodes !== null;
  $: libraryReady = d.newSeries !== null && d.newMovies !== null && d.week !== null;
  $: tvReady = forYouReady && libraryReady;
  $: slots = $mobile ? 3 : 4;
  $: episodeItems = plan.episodes.map(episodeItem);
  $: episodeFresh = new Map(plan.episodes.map((e) => [e.episode.id, e]));
  $: emptyForYou = !plan.forYou.length && !plan.suggestions.length && !plan.episodes.length;
  $: open = openRequests($mine).length;
  $: left = quotaLeft($quota);

  const kindLabel = (it: Item) => (it.type === 'Movie' ? $t('home.meta.movie') : $t('home.meta.series'));
  const join = (...p: Array<string | number | undefined | false>) => p.filter(Boolean).join(' · ');
  const forYouNote = (it: Item): RowNote => ({ meta: join(kindLabel(it), it.year), reason: reasonText(it.reason, $t) });
  const seriesNote = (it: Item): RowNote => ({ meta: join(runtimeLabel(it), it.year), fresh: freshText(it.dateCreated, now, $t) });
  const movieNote = (it: Item): RowNote => ({ meta: join($t('home.meta.movie'), runtimeLabel(it)), fresh: freshText(it.dateCreated, now, $t) });
  /** the card overlay already names season and episode on the desktop, so its note gives only the freshness; TV hides the overlay and keeps the code */
  const episodeNote = (it: Item): RowNote => {
    const e = episodeFresh.get(it.id);
    const fresh = e ? freshText(e.episode.addedAt, now, $t) : '';
    return tv ? { meta: $t('detail.view.episodeCode', { s: String(it.parentIndexNumber ?? '?'), e: String(it.indexNumber ?? '?') }), fresh } : { fresh };
  };

  $: heading = canWish ? $t('home.new.title') : $t('home.new.titleOnly');
  $: recentHref = filter === 'series' ? '/browse/series?sort=DateCreated' : '/browse/movies?sort=DateCreated';
</script>

<svelte:head><title>{$t('common.pageTitle', { page: heading })}</title></svelte:head>

{#snippet skeleton()}
  <div class="sk" role="status" aria-busy="true">
    <span class="sr-only">{$t('common.loading')}</span>
    {#each [0, 1] as _}<div class="skrow" aria-hidden="true"><div class="skeleton skh"></div><div class="skcards">{#each Array($mobile ? 3 : 6) as __}<div class="skeleton skc"></div>{/each}</div></div>{/each}
  </div>
{/snippet}

{#snippet forYouSkeleton()}
  <div class="sk fysk">
    <span class="sr-only" role="status">{$t('common.loading')}</span>
    <div class="skspot" aria-hidden="true">{#each Array($mobile ? 1 : 3) as _}<div class="skeleton"></div>{/each}</div>
    {#if canWish}<Suggestions items={null} {slots} title={$t('home.new.missing')} sub={$t('home.new.missingSub')} />{/if}
    <div class="skrow" aria-hidden="true"><div class="skeleton skh"></div><div class="ske">{#each Array($mobile ? 3 : 4) as _}<div class="skeleton"></div>{/each}</div></div>
  </div>
{/snippet}

{#snippet libSkeleton()}
  <div class="sk" role="status" aria-busy="true">
    <span class="sr-only">{$t('common.loading')}</span>
    <div class="skrow" aria-hidden="true"><div class="skeleton skh"></div><div class="sklib">{#each Array($mobile ? 6 : 12) as _}<div class="skeleton"></div>{/each}</div></div>
  </div>
{/snippet}

{#snippet empty()}
  <section class="empty frost frost-panel frost-safe" aria-labelledby="np-empty">
    <span class="ic" aria-hidden="true"><Icon name="clock" size={26} /></span>
    <h2 id="np-empty">{$t('home.new.emptyTitle')}</h2>
    <p>{$t('home.new.emptyText')}</p>
    <div class="btns">
      <a class="btn pill" href={recentHref}>{$t('home.new.emptyRecent')}</a>
      <a class="btn sec" href="/calendar"><Icon name="calendar" size={18} />{$t('home.new.emptyCalendar')}</a>
    </div>
  </section>
{/snippet}

<div class="np" class:tvp={tv}>
  <div class="in">
    <header class="top">
      <h1>{heading}</h1>
      <div class="ctl">
        {#if !$mobile || tv}<FilterBar value={filter} on:change={(e) => pickFilter(e.detail)} />{/if}
        {#if canWish && !tv}<button type="button" class="btn pill add" on:click={wish}><Icon name="plus" size={18} /><span>{$t('home.new.wishAction')}</span></button>{/if}
      </div>
    </header>

    {#if tv}
      <!-- television: the plain stacked rows, no tabs and no wishes -->
      {#if !tvReady}{@render skeleton()}
      {:else}
        {#if plan.empty}{@render empty()}{/if}
        <div class="bleed"><Row title={$t('home.new.forYou')} sub={$t('home.new.forYouSub')} items={plan.forYou} portrait notes={forYouNote} /></div>
        <div class="bleed"><Row title={$t('home.new.newSeries')} sub={$t('home.new.newSeriesSub')} items={plan.newSeries} portrait notes={seriesNote} /></div>
        {#if plan.episodes.length}<div class="bleed"><Row title={$t('home.new.newEpisodes')} sub={$t('home.new.newEpisodesSub')} items={episodeItems} notes={episodeNote} /></div>{/if}
        <div class="bleed"><Row title={$t('home.new.newMovies')} sub={$t('home.new.newMoviesSub')} items={plan.newMovies} portrait notes={movieNote} /></div>
        <div class="bleed"><Row title={$t('home.rows.trending')} items={plan.week} ranked /></div>
        {#if plan.upcoming.length}<div class="upc"><UpcomingList items={plan.upcoming} /></div>{/if}
      {/if}
    {:else}
      <div class="tabrow"><Tabs {tabs} value={tab} {open} short={$mobile} on:change={(e) => pickTab(e.detail)} /></div>
      {#if $mobile}<div class="chips"><FilterBar chips value={filter} on:change={(e) => pickFilter(e.detail)} /></div>{/if}

      <div id="np-panel" class="panel-body" role="tabpanel" aria-labelledby="np-tab-{tab}">
        {#if tab === 'wishes'}
          <WishPanel bind:this={wp} upcoming={plan.upcoming} {filter} autofocus={wantFocus} />
        {:else if tab === 'foryou' && !forYouReady}
          {@render forYouSkeleton()}
        {:else if tab === 'library' && !libraryReady}
          {@render libSkeleton()}
        {:else if tab === 'foryou'}
          {#if emptyForYou}{@render empty()}{/if}
          {#if plan.forYou.length}
            <Spotlight items={plan.forYou} count={$mobile ? 1 : 3} title={$t('home.new.forYou')} sub={$mobile ? '' : $t('home.new.forYouSub')} />
            {#if $mobile && plan.forYou.length > 1}<div class="bleed"><Row title={$t('home.new.moreForYou')} items={plan.forYou.slice(1)} portrait notes={forYouNote} /></div>{/if}
          {/if}
          {#if canWish}
            <Suggestions items={d.suggest === null ? null : plan.suggestions.slice(0, slots)} loading={suggestLoading} {slots} title={$t('home.new.missing')} sub={$t('home.new.missingSub')} on:wish={wish} />
          {/if}
          {#if plan.episodes.length}
            {#if $mobile}<div class="bleed"><NewEpisodes title={$t('home.new.newEpisodes')} items={plan.episodes} {now} /></div>
            {:else}<EpisodeCards title={$t('home.new.newEpisodes')} sub={$t('home.new.newEpisodesSub')} items={plan.episodes.slice(0, 4)} {now} />{/if}
          {/if}
          {#if $mobile && canWish && d.suggest !== null && plan.suggestions.length >= slots}
            <button type="button" class="bar frost frost-panel frost-safe" on:click={wish}>
              <span class="pl" aria-hidden="true"><Icon name="plus" size={20} /></span>
              <span class="bt"><b>{$t('home.new.barTitle')}</b><span>{$t('home.new.barSub')}</span></span>
              {#if left !== null}<span class="lf">{$t('home.new.quotaLeftShort', { left })}</span>{/if}
            </button>
          {/if}
        {:else}
          {#if !plan.library.length}{@render empty()}
          {:else}<LibraryGrid items={plan.library} {now} title={$t('home.new.libraryHead')} sub={$mobile ? '' : $t('home.new.libraryHeadSub')} />{/if}
          {#if plan.week.length}<div class="bleed wk"><Row title={$t('home.rows.trending')} items={plan.week} ranked /></div>{/if}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .np { padding-bottom: 3rem; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem 2rem; flex-wrap: wrap; margin: 0 0 1rem; }
  h1 { margin: 0; }
  .ctl { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; min-width: 0; }
  .add { min-height: 48px; padding-inline: 1.5rem; font-weight: 800; }
  .add:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
  .tabrow { margin: 0 0 1.4rem; }
  .chips { margin: .8rem 0 1.2rem; overflow-x: auto; scrollbar-width: none; }
  .panel-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2.2rem; min-width: 0; }
  /* rows carry their own gutters: they run past the page's padding and give it back */
  .bleed { margin: 0 calc(var(--pad-x) * -1); }
  .bleed :global(section.row) { margin-top: 0; }
  .bleed :global(section.row) { margin-bottom: 0; }
  .upc { margin-top: 1.6rem; }

  :global(html.tv) .in { --pad-x: var(--tv-gutter); }
  :global(html.tv) .top { margin-bottom: 0; }
  :global(html.tv) .np .bleed { margin: 0 calc(var(--pad-x) * -1); }
  :global(html.tv) .bleed :global(section.row) { margin-top: 1.6rem; }
  :global(html.tv) .upc { padding: 0; }
  @media (max-width: 720px) {
    .top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .8rem; }
    h1 { font-size: 1.35rem; line-height: 1.2; min-width: 0; }
    .ctl { gap: .6rem; }
    .add { min-height: 44px; padding-inline: 1.1rem; }
    .panel-body { gap: 1.8rem; }
  }

  .sk { margin-top: .5rem; display: grid; gap: 1.6rem; }
  .skrow { display: grid; gap: .8rem; }
  .skh { width: 9rem; height: 1.3rem; border-radius: 6px; }
  .skcards { display: flex; gap: 8px; overflow: hidden; }
  .fysk { margin-top: 0; gap: 2.2rem; }
  .skspot { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
  .skspot > div { height: 280px; border-radius: 20px; }
  .ske { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .ske > div { aspect-ratio: 16 / 9; border-radius: 16px; }
  .sklib { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 24px 16px; }
  .sklib > div { aspect-ratio: 2 / 3; border-radius: 12px; }
  .skc { flex: 0 0 calc((100% - 5 * 8px) / 6); aspect-ratio: 2 / 3; border-radius: 12px; }
  :global(html.tv) .skc { aspect-ratio: 16 / 9; border-radius: var(--tv-radius); }
  @media (max-width: 720px) {
    .skc { flex-basis: calc((100% - 2 * 8px) / 3.2); }
    .skspot { grid-template-columns: minmax(0, 1fr); }
    .skspot > div { height: 340px; }
    .ske { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .sklib { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 8px; }
  }

  .empty { display: grid; justify-items: center; gap: .5rem; text-align: center; margin: .5rem auto 0; padding: 1.8rem 1.4rem; max-width: 34rem; border-radius: var(--fr-r-panel, 18px); }
  .ic { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 50%; background: var(--fr-sel); color: var(--acc-text); }
  .empty h2 { margin: .4rem 0 0; font-size: 1.25rem; font-weight: 800; line-height: 1.25; }
  .empty p { margin: 0 0 .8rem; color: var(--mut); max-width: 28rem; }
  .btns { display: flex; flex-wrap: wrap; justify-content: center; gap: .6rem; }
  :global(html.tv) .empty { max-width: 44rem; }
  :global(html.tv) .empty h2 { font-size: 1.75rem; }
  :global(html.tv) .empty p { font-size: 1.25rem; }

  /* phone: "Etwas fehlt?" bar at the end of the first tab */
  .bar { display: flex; align-items: center; gap: .9rem; width: 100%; min-height: 64px; padding: 10px 18px 10px 12px; text-align: left; color: #fff; font: inherit; border-radius: 22px; }
  .bar .pl { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--acc-fill); }
  .bar .bt { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; font-weight: 400; }
  .bar .bt b { font-size: 1rem; }
  .bar .bt span { font-size: .85rem; color: rgba(255, 255, 255, .8); }
  .bar .lf { flex: none; color: var(--acc-text); font-weight: 700; font-size: .9rem; }
  .bar:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
</style>
