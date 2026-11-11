<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { get } from 'svelte/store';
  import { api, ApiError, getActiveProfile, type Item } from '#lib/api';
  import BrandHubs from '#lib/BrandHubs.svelte';
  import { deskUi } from '#lib/desk/bar';
  import DeskBillboard from '#lib/desk/DeskBillboard.svelte';
  import Hero from '#lib/Hero.svelte';
  import Carousel from '#lib/phone/Carousel.svelte';
  import { carouselPicks } from '#lib/phone/logic';
  import { badges, wantBadge, type Badge } from '#lib/fresh';
  import LazyRow from '#lib/LazyRow.svelte';
  import Row from '#lib/Row.svelte';
  import ThemedListRows from '#lib/ThemedListRows.svelte';
  import UpcomingRow from '#lib/UpcomingRow.svelte';
  import HandoffCard from '#lib/handoff/HandoffCard.svelte';
  import { dismiss as dismissHandoff, isDismissed, loadHandoff, shouldTakeFocus, type Handoff } from '#lib/handoff/handoff';
  import { failedParts, firstNonEmptyTab, homeCache, swrLoad, type HomePart, type HomeResponse } from '#lib/home';
  import type { Hub } from '#lib/hubs';
  import { loadFeatured, loadThemed, type FeaturedList, type ThemedList } from '#lib/lists';
  import { t, tr } from '#lib/i18n';
  import { kidsMode } from '#lib/kids';
  import { usable } from '#lib/spatial';
  import { mobile } from '#lib/viewport';
  import { tvFocus, tvRank } from '#lib/tv/focus';
  import { glide } from '#lib/tv/motion';
  import { rowScrollTarget } from '#lib/tv/rowScroll';
  import TvCategoryRow from '#lib/tv/TvCategoryRow.svelte';
  import TvFocusTile from '#lib/tv/TvFocusTile.svelte';

  let hero: Item | null = null, heroPlay = '';
  /** the billboard title has been answered (it may be null): with recs and latest, what the phone carousel waits for */
  let heroSettled = false;
  let resume: Item[] | null = null, next: Item[] | null = null, latest: Item[] | null = null, mine: Item[] | null = null;
  let trending: Item[] | null = null, recs: Item[] | null = null, friendsRated: Item[] | null = null;
  let top: Item[] | null = null, because: { name: string } | null = null, becauseItems: Item[] | null = null;
  let moreRaw: Array<{ because: { id: string; name: string }; items: Item[]; engine?: 'v1' | 'v2' }> = [];
  // engine v2: which engine built the "because" row, and the row ranker's order of the recommendation rows (null = the fixed layout)
  let becauseEngine: 'v1' | 'v2' = 'v1', homeOrder: string[] | null = null;
  let featured: FeaturedList[] = [];
  let hubs: Hub[] = [], themed: ThemedList[] = [];
  // titles an admin set a removal date for (only those the viewer can see; the row stays hidden while empty)
  let leaving: Item[] | null = null;
  let views: Item[] = [], genres: string[] = [], error = '';
  const q = (p: Record<string, string>) => new URLSearchParams(p).toString();
  // Jellyfin can answer 5xx/network errors right after a fresh sign-up: retry (not on 401/403) before giving up
  const retry = async <T,>(fn: () => Promise<T>, tries = 3, delayMs = 1500, giveUp: (e: unknown) => boolean = (e) => e instanceof ApiError && (e.status === 401 || e.status === 403)): Promise<T> => {
    for (let i = 1; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (i >= tries || giveUp(e)) throw e;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  };
  const load = (path: string) => retry(() => api(path));
  const items = (p: Record<string, string>) => load(`/api/library/items?${q(p)}`).then((r) => r.items as Item[]);
  /**
   * Cached per profile (module scope in #lib/home): back to home renders at once from memory. Personal rows
   * (Weiterschauen, Nächste Folge, Merkliste) always revalidate in the background, the catalogue rows after 5 minutes.
   */
  const cached = <T,>(key: string, fetcher: () => Promise<T>, apply: (v: T) => void, onError: () => void, ttl?: number) =>
    swrLoad(homeCache, `${getActiveProfile()}|${key}`, fetcher, apply, ttl, onError).catch(() => undefined); // onError only when nothing cached was shown
  const ALWAYS = 0;
  const idle = (fn: () => void) => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 900 }); else setTimeout(fn, 300);
  };

  // (GET /api/home: a 4xx is final, e.g. a server without the endpoint: straight to the old loaders)
  // The old per-row loaders: the fallback for every part GET /api/home could not deliver (named in `failed`, or the whole call failed).
  const loaders: Record<HomePart, () => void> = {
    // billboard: a random pick stays the same while it is cached
    hero: () => void cached('hero', async () => { const pool = await items({ types: 'Movie,Series', sort: 'Random', limit: '15' }); return pool.find((i) => i.backdrop) ?? pool[0] ?? null; }, (v) => { hero = v; heroSettled = true; }, () => { hero = null; heroSettled = true; }),
    resume: () => void cached('resume', () => load('/api/library/resume').then((r) => r.items as Item[]), (v) => (resume = v), () => (resume = []), ALWAYS),
    nextup: () => void cached('nextup', () => load('/api/library/nextup').then((r) => r.items as Item[]), (v) => (next = v), () => (next = []), ALWAYS),
    leaving: () => void cached('leaving', () => load('/api/library/leaving').then((r) => r.items as Item[]), (v) => (leaving = v), () => (leaving = []), ALWAYS),
    recs: () => {
      void cached('recs', () => load('/api/recommendations').then((r) => r.items as Item[]), (v) => (recs = v), () => (recs = []));
      void cached('friends', () => load('/api/library/friends-rated').then((r) => r.items as Item[]), (v) => (friendsRated = v), () => (friendsRated = []));
    },
    because: () => {
      void cached('because', () => load('/api/library/because'), (r: { because: { name: string } | null; items: Item[]; engine?: 'v1' | 'v2' }) => { because = r.because; becauseItems = r.items; becauseEngine = r.engine ?? 'v1'; homeOrder = null; }, () => (becauseItems = []));
      // more "Because you watched" rows (2-3 further recent titles); they only appear in between the other rows below the fold
      void cached('becauseMore', () => load('/api/library/because-more').then((r) => r.rows as typeof moreRaw), (v) => (moreRaw = v), () => (moreRaw = []));
    },
    hubs: () => void cached('hubs', () => api('/api/hubs').then((r) => ((r.hubs as Hub[] | undefined) ?? [])), (v) => (hubs = v), () => (hubs = [])),
    themed: () => void cached('themed', loadThemed, (v) => (themed = v), () => (themed = [])),
  };
  const HOME_KEY = () => `${getActiveProfile()}|home`;
  function applyHome(r: HomeResponse<Item>) {
    const bad = failedParts(r);
    const p = r.parts;
    if (!bad.has('hero')) { hero = p.hero ? (p.hero as Item) : null; heroSettled = true; }
    if (!bad.has('resume')) resume = p.resume;
    if (!bad.has('nextup')) next = p.nextup;
    if (!bad.has('leaving')) leaving = p.leaving;
    if (!bad.has('recs')) { recs = p.recs.items; friendsRated = p.recs.friends; }
    if (!bad.has('because')) { because = p.because.because; becauseItems = p.because.items; moreRaw = p.because.more; becauseEngine = p.because.engine ?? 'v1'; homeOrder = Array.isArray(p.order) ? p.order : null; }
    if (!bad.has('hubs')) hubs = p.hubs as Hub[];
    if (!bad.has('themed')) themed = p.themed as ThemedList[];
    for (const n of bad) loaders[n]();
  }

  let homeAnswered: Promise<unknown> = Promise.resolve();
  onMount(() => {
    // 1. the whole first screen (billboard, rows, hubs, themed lists) in ONE request; stale data from the last visit shows at once.
    //    Parts the server could not build are loaded the old way, one request each.
    const firstScreen = swrLoad(homeCache, HOME_KEY(), () => retry(() => api('/api/home') as Promise<HomeResponse<Item>>, 2, 800, (e) => e instanceof ApiError && e.status >= 400 && e.status < 500), applyHome, ALWAYS, () => { for (const n of Object.keys(loaders) as HomePart[]) loaders[n](); })
      .catch(() => undefined);
    homeAnswered = firstScreen;
    // 3. below the fold: once the browser is idle (keeps the network free for the billboard image);
    //    from the cache at once (back navigation: same page height, so the scroll position restores exactly)
    const warm = Boolean(homeCache.get(`${getActiveProfile()}|latest`));
    // (after the first screen, so the idle requests never compete with it)
    void (warm ? Promise.resolve() : firstScreen).then(() => (warm ? (fn: () => void) => fn() : idle)(() => {
      void cached('latest', () => items({ types: 'Movie,Series', sort: 'DateCreated', desc: 'true', limit: '24' }), (v) => (latest = v), () => (latest = []));
      void cached('trending', () => load('/api/library/trending').then((r) => (r.items as Item[]).map((i) => ({ ...i, caption: i.viewers ? tr('home.meta.watching', { n: i.viewers }) : i.caption }))), (v) => (trending = v), () => (trending = []));
      void cached('top', () => items({ types: 'Movie,Series', sort: 'CommunityRating', desc: 'true', limit: '10' }), (v) => (top = v), () => (top = []));
      void cached('mine', () => load('/api/watchlist').then((r) => r.items as Item[]), (v) => (mine = v), () => (mine = []), ALWAYS);
      void cached('featured', () => loadFeatured(), (v) => (featured = v), () => (featured = []));
      void cached('views', () => load('/api/library/views').then((r) => r.items as Item[]), (v) => (views = v), () => (error = tr('home.rows.libraryFailed')));
      void cached('genres', () => load('/api/library/genres').then((r) => (r.genres as string[]).slice(0, 8)), (v) => (genres = v), () => undefined);
    }));
  });
  // Back in front (the app's native player closed, or this tab after watching on another device): the progress rows are re-read,
  // at most every 5 s. pageshow with persisted: a page restored from the back/forward cache.
  let rowsAt = 0;
  function refreshProgress() {
    if (document.hidden || Date.now() - rowsAt < 5000) return;
    rowsAt = Date.now();
    loaders.resume();
    loaders.nextup();
    void refreshHandoff();
  }
  const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) refreshProgress(); };
  // ---- "continue here": what another device played last (spec device hand-off 2.4). The card is an overlay in the hosts' `handoff` slot ----
  let handoff: Handoff | null = null, handoffSeq = 0, dismissedId = '';
  /** asked after mount and whenever the progress rows are re-read; never for a kids profile (their home is /kids, where no card shows); the newest answer wins */
  async function refreshHandoff() {
    if (get(kidsMode)) return;
    const n = ++handoffSeq;
    const h = await loadHandoff();
    if (n === handoffSeq) handoff = h;
  }
  let gone = false;
  // asked only after /api/home has answered (the first screen keeps its 5-call budget); the card waits for the billboard anyway
  onMount(() => { void homeAnswered.then(() => { if (!gone) void refreshHandoff(); }); });
  onDestroy(() => { gone = true; handoffSeq++; }); // an answer after leaving is dropped
  /** the offer unless this device dismissed it */
  $: offer = handoff && handoff.id !== dismissedId && !isDismissed(handoff.id) ? handoff : null;
  /** only once the billboard title is here (and, on the phone carousel, once its cards are): a late title never meets a card that was already shown */
  $: offerReady = heroSettled && !picksPending;
  async function onHandoffDismiss(e: CustomEvent<string>) {
    dismissHandoff(e.detail);
    dismissedId = e.detail;
    await tick();
    // the card held focus: it goes to the page's first button (the billboard's Play)
    if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }
  // ---- TV remote: the card's action takes the focus only if it shows within 2 s of mount and before any key (spec 2.4) ----
  let mountedAt = 0, keyPressed = false, focusDecided = false, backNav = false;
  // Back / Forward to the start page: the layout puts the focus back where the viewer was (a row card, a button); the card never competes
  afterNavigate((nav) => { if (nav.type === 'popstate') backNav = true; });
  onMount(() => {
    mountedAt = Date.now();
    const onKey = () => { keyPressed = true; };
    window.addEventListener('keydown', onKey, { capture: true, once: true });
    return () => window.removeEventListener('keydown', onKey, true);
  });
  /** the tile's first button (Back on the card, Down from it, after Ausblenden) */
  const focusTile = () => document.querySelector<HTMLElement>('section.tile [data-autofocus]')?.focus({ preventScroll: true });
  $: tvOffer = tv && offerReady && hero ? offer : null;
  // decided once per page load, when the first card shows (a later card, e.g. after a refresh, never takes the focus)
  $: if (tvOffer && !focusDecided) void takeFocus();
  async function takeFocus() {
    focusDecided = true;
    if (backNav || !shouldTakeFocus({ mountedAt, arrivedAt: Date.now(), keyPressed })) return;
    await tick();
    // only while the card shows (focus in the tile) and the focus is not placed yet, or rests on the tile's Play (the layout's
    // first focus). Not relying on `inert`: Chromium 85 / 87 lack it, and `.focus()` would land on the faded card there.
    const a = document.activeElement;
    const free = !a || a === document.body || a.matches('section.tile [data-autofocus]');
    if (!keyPressed && free && get(tvFocus) === null) document.querySelector<HTMLElement>('section.tile [data-handoff] a[href]')?.focus({ preventScroll: true });
  }
  onMount(() => {
    rowsAt = Date.now(); // the first screen just loaded them
    document.addEventListener('visibilitychange', refreshProgress);
    window.addEventListener('pageshow', onPageShow);
    return () => { document.removeEventListener('visibilitychange', refreshProgress); window.removeEventListener('pageshow', onPageShow); };
  });
  async function removeResume(id: string) {
    const prev = resume;
    resume = resume ? resume.filter((i) => i.id !== id) : resume; // optimistic
    try {
      await api(`/api/library/resume/${id}`, { method: 'DELETE' });
      homeCache.set(`${getActiveProfile()}|resume`, resume);
      const h = homeCache.get(HOME_KEY())?.value as HomeResponse<Item> | undefined;
      if (h) homeCache.set(HOME_KEY(), { ...h, parts: { ...h.parts, resume: resume ?? [] } });
    } catch { resume = prev; }
  }
  $: heroRank = hero && top ? top.findIndex((i) => i.id === hero!.id) + 1 : 0;
  // Jellyfin's next-up also lists the episode you are in the middle of: that one is already under "Weiterschauen"
  $: nextOnly = next && resume ? next.filter((e) => !resume!.some((r) => r.id === e.id)) : next;
  // the extra rows never repeat what "Weiterschauen" / "Nächste Folge" / the first "Weil du ..." row already show (episodes count as their series)
  $: taken = new Set([...(resume ?? []), ...(next ?? []), ...(becauseItems ?? [])].flatMap((i) => [i.id, i.seriesId ?? i.id]));
  $: more = moreRaw.map((r) => ({ ...r, items: r.items.filter((i) => !taken.has(i.id)) })).filter((r) => r.items.length >= 4);
  // engine v2: the recommendation rows in the order the server chose (friends, because, more:<n>); a row without titles is skipped by <Row>
  type OrderedRow = { key: string; title: string; items: Item[]; tag: { row: 'friends' | 'because' | 'because_more'; engine: 'v1' | 'v2' } };
  $: ordered = (homeOrder ?? []).flatMap((key): OrderedRow[] => {
    if (key === 'friends') return [{ key, title: $t('home.rows.friendsRated'), items: friendsRated ?? [], tag: { row: 'friends', engine: becauseEngine } }];
    if (key === 'because') return because ? [{ key, title: $t('home.rows.because', { name: because.name }), items: becauseItems ?? [], tag: { row: 'because', engine: becauseEngine } }] : [];
    const m = /^more:(\d+)$/.exec(key) ? moreRaw[Number(key.slice(5))] : undefined;
    const left = m ? m.items.filter((i) => !taken.has(i.id)) : [];
    // the same floor as the v1 path: a "more" row that shrinks below 4 titles after removing what the first rows show is skipped
    return m && left.length >= 4 ? [{ key, title: $t('together.because', { name: m.because.name }), items: left, tag: { row: 'because_more', engine: m.engine ?? becauseEngine } }] : [];
  });
  // the first visible row loads its images eagerly with high priority
  $: firstRow = firstNonEmptyTab(['resume', 'next', 'recs', 'friends'] as const, { resume, next: nextOnly, recs, friends: friendsRated });
  const viewLoader = (id: string) => () => items({ parentId: id, sort: 'DateCreated', desc: 'true', limit: '24' });
  const genreLoader = (g: string) => () => items({ types: 'Movie,Series', genre: g, sort: 'Random', limit: '24' });

  // ---- TV: focus tile instead of the hero; the rows own the vertical scroll position (spatial.focusEl leaves it to us) ----
  let tv = false, rowsEl: HTMLElement | undefined, frame = 0;
  onMount(() => {
    tvFocus.set(null); tvRank.set(null); // the tile starts on the hero, whatever the last visit left behind
    const sync = () => { tv = document.documentElement.classList.contains('tv'); };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  });
  onDestroy(() => { if (frame) cancelAnimationFrame(frame); });
  /** desktop browse: the trailer billboard instead of the hero (phones, TV and kids profiles keep theirs) */
  $: desk = deskUi({ tv, mobile: $mobile, kids: $kidsMode });
  /**
   * phone (not kids, not TV): the swipe carousel instead of the poster hero. Its cards come from lists the page already
   * loads (the billboard title, the recommendation row, the newest titles); fresh-labelled titles go first. No picks: the hero.
   */
  $: phone = $mobile && !$kidsMode && !tv;
  $: candidates = phone ? [...(recs ?? []), ...(latest ?? [])] : [];
  // the rows ask for the same badges; asks of one frame share one request
  $: for (const c of candidates) wantBadge(c.type === 'Episode' ? c.seriesId : c.id);
  $: picks = phone ? phonePicks(hero, candidates, $badges) : [];
  /**
   * The carousel holds its place (cards as placeholders) until every list its cards come from has answered; only then may
   * zero picks fall back to the hero. Swapping the taller hero for the carousel under a reader who already scrolled changed
   * the height above the rows, and the browser's scroll anchoring moved the page (to the top when scrolled less than the difference).
   */
  $: picksPending = phone && !(heroSettled && recs !== null && latest !== null);
  function phonePicks(h: Item | null, list: Item[], b: Record<string, Badge | null>): Item[] {
    // badges are kept per series for episodes
    const key = new Map([...(h ? [h] : []), ...list].map((c) => [c.id, c.seriesId ?? c.id]));
    return carouselPicks({ hero: h, candidates: list, fresh: (id) => b[key.get(id) ?? id]?.fresh ?? null });
  }
  /**
   * The focused row slides under the tile: its top goes to where the tile ends. The page position jumps there at once and the
   * rows glide the difference with a spring (lib/tv/motion.ts, FLIP), so scroll-based code always sees the resting position.
   * `fromY` is the position the viewer saw before this focus change (focusEl may already have scrolled the window).
   */
  let fromY: number | null = null;
  function onRowsFocus(e: FocusEvent) {
    if (!tv) return;
    const sec = (e.target as HTMLElement).closest<HTMLElement>('section.row, section.cr');
    if (!sec) return;
    fromY ??= window.scrollY;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      const y0 = fromY ?? window.scrollY;
      fromY = null;
      if (!rowsEl || !sec.isConnected) return;
      glidePage(y0, () => {
        const tile = document.querySelector<HTMLElement>('section.tile');
        const tileBottom = tile ? tile.getBoundingClientRect().bottom : window.innerHeight / 2;
        return rowScrollTarget(sec.getBoundingClientRect().top, window.scrollY, tileBottom);
      });
    });
  }
  /** scrolls the window to `target()` (measured with the rows untransformed) and glides the rows from where they were seen at `y0` */
  function glidePage(y0: number, target: () => number) {
    if (!rowsEl) return;
    glide(rowsEl, 'y', () => { window.scrollTo({ top: target(), behavior: 'auto' }); return window.scrollY - y0; });
  }
  const navAction = (n: HTMLElement) => { n.addEventListener('ff-nav', onRowsNav); return { destroy: () => n.removeEventListener('ff-nav', onRowsNav) }; };
  /** Up from the topmost row goes back to the tile: it shows the hero again with its buttons */
  async function onRowsNav(e: Event) {
    const d = (e as CustomEvent<{ dir: string }>).detail;
    const a = e.target as HTMLElement;
    if (!tv || d?.dir !== 'up' || !rowsEl) return;
    const top = a.getBoundingClientRect().top;
    const above = [...rowsEl.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].some((el) => el !== a && usable(el) && el.getBoundingClientRect().top < top - 10);
    if (above) return;
    e.preventDefault(); // handled here
    tvFocus.set(null); tvRank.set(null);
    await tick();
    const play = document.querySelector<HTMLElement>('section.tile [data-autofocus]');
    play?.focus({ preventScroll: true });
    glidePage(window.scrollY, () => 0);
  }
</script>

<svelte:head><title>{$t('common.appName')}</title></svelte:head>
{#if tv}
  <TvFocusTile {hero} {heroRank}>
    <HandoffCard slot="handoff" handoff={tvOffer} layout="tv" tvVisible={$tvFocus === null} {focusTile} on:dismiss={onHandoffDismiss} />
  </TvFocusTile>
{:else if desk}
  <DeskBillboard item={hero} rank={heroRank}>
    <HandoffCard slot="handoff" handoff={offerReady && hero ? offer : null} layout="desk" on:dismiss={onHandoffDismiss} />
  </DeskBillboard>
  <BrandHubs {hubs} />
{:else if phone && (picks.length || picksPending)}
  <!-- the phone home's page heading (the carousel has no title of its own; WCAG 1.3.1 / 2.4.6) -->
  <h1 class="sr-only">{$t('common.appName')}</h1>
  <!-- the "continue here" card follows the heading in reading order; its zero-height host is the containing block of the absolute card -->
  <div class="hoffhost"><HandoffCard handoff={offerReady ? offer : null} layout="phone" on:dismiss={onHandoffDismiss} /></div>
  <Carousel items={picks} />
  <BrandHubs {hubs} />
{:else}
  <Hero item={hero} rank={heroRank} portrait>
    <HandoffCard slot="handoff" handoff={offerReady && hero ? offer : null} layout="phone" on:dismiss={onHandoffDismiss} />
  </Hero>
  <BrandHubs {hubs} />
{/if}
<div class="rows" bind:this={rowsEl} data-own-scroll={tv ? '' : undefined} on:focusin={onRowsFocus} use:navAction>
  {#if error}<p class="err" style="margin:1rem var(--pad-x)">{error}</p>{/if}
  <Row title={$t('home.rows.resume')} items={resume} landscape removable priority={firstRow === 'resume'} on:remove={(e) => removeResume(e.detail.id)} />
  <Row title={$t('home.rows.nextUp')} items={nextOnly} landscape priority={firstRow === 'next'} />
  <!-- featured themed lists (worker S1) follow the second row -->
  <ThemedListRows lists={themed} />
  {#if leaving?.length}<Row title={$t('fresh.row.leaving')} items={leaving} />{/if}
  <Row title={$t('home.rows.recs')} items={recs} priority={firstRow === 'recs'} />
  {#if tv}<TvCategoryRow />{/if}
  {#if homeOrder}
    {#each ordered as r (r.key)}<Row title={r.title} items={r.items} reco={r.tag} />{/each}
    <Row title={$t('home.rows.latest')} items={latest} href="/new" />
    <Row title={$t('home.rows.trending')} items={trending} ranked />
    {#each featured as f (f.id)}<Row title={$t('home.rows.featured', { name: f.name, owner: f.owner.name })} items={f.items} href="/lists/{f.id}" />{/each}
    <Row title={$t('home.rows.myList')} items={mine} href="/watchlist" />
  {:else}
  <Row title={$t('home.rows.friendsRated')} items={friendsRated} priority={firstRow === 'friends'} />
  {#if because}<Row title={$t('home.rows.because', { name: because.name })} items={becauseItems} reco={{ row: 'because', engine: becauseEngine }} />{/if}
  <Row title={$t('home.rows.latest')} items={latest} href="/new" />
  <Row title={$t('home.rows.trending')} items={trending} ranked />
  {#if more[0]}<Row title={$t('together.because', { name: more[0].because.name })} items={more[0].items} reco={{ row: 'because_more', engine: more[0].engine ?? becauseEngine }} />{/if}
  {#each featured as f (f.id)}<Row title={$t('home.rows.featured', { name: f.name, owner: f.owner.name })} items={f.items} href="/lists/{f.id}" />{/each}
  <Row title={$t('home.rows.myList')} items={mine} href="/watchlist" />
  {#if more[1]}<Row title={$t('together.because', { name: more[1].because.name })} items={more[1].items} reco={{ row: 'because_more', engine: more[1].engine ?? becauseEngine }} />{/if}
  {/if}
  <UpcomingRow type="movie" title={$t('home.rows.upcomingWish')} />
  <!-- the second ranked row never directly follows the first one -->
  {#each views as v, i (v.id)}
    <LazyRow title={v.name} href="/library/{v.id}" cacheKey="view:{v.id}" load={viewLoader(v.id)} />
    {#if i === 0}<Row title={$t('home.rows.top10')} items={top} ranked />{/if}
  {/each}
  {#if !views.length}<Row title={$t('home.rows.top10')} items={top} ranked />{/if}
  {#each genres as g, i (g)}
    <LazyRow title={g} href="/browse/movies?genre={encodeURIComponent(g)}" cacheKey="genre:{g}" load={genreLoader(g)} />
    {#if i === 0 && !homeOrder && more[2]}<Row title={$t('together.because', { name: more[2].because.name })} items={more[2].items} reco={{ row: 'because_more', engine: more[2].engine ?? becauseEngine }} />{/if}
  {/each}
</div>

<style>.hoffhost { position: relative; height: 0; }
  .rows { position: relative; z-index: 2; padding-bottom: 5rem; }
  @media (max-width: 720px) { .rows { padding-top: .4rem; } }
  :global(html.tv) .rows { padding-bottom: 40vh; --pad-x: var(--tv-gutter); } /* the last rows can still slide up under the tile; row titles and first cards sit on the 56 px gutter */
  :global(html.tv) .rows :global(section.up h2) { font-size: 1.625rem; font-weight: 600; line-height: 1.2; color: var(--tv-white-88); margin-bottom: 1rem; }
  :global(html.tv) .rows :global(.why) { font-size: 1.375rem; font-weight: 500; margin-top: -.5rem; margin-bottom: 1rem; }</style>
