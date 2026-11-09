<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  /** horizontal scroll position per row (title + link), kept across client-side navigation (back to home keeps the rows where they were) */
  const scrollMemo = new Map<string, number>();
</script>

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type { Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import Icon from '#lib/Icon.svelte';
  import PosterCard from '#lib/PosterCard.svelte';
  import { mobile } from '#lib/viewport';
  import { pageCount, pageIndex, INITIAL_EXTRA } from '#lib/home';
  import { t } from '#lib/i18n';
  import { recoTrack, type RecoTag } from '#lib/reco';
  import ReasonCaption from '#lib/ReasonCaption.svelte';
  import { tvRank } from '#lib/tv/focus';
  import { kidsMode } from '#lib/kids';
  import { deskUi } from '#lib/desk/bar';
  import { pageTarget, rowPages } from '#lib/desk/rows';
  import { glide } from '#lib/tv/motion';

  export let title: string;
  /** null = loading (skeleton) */
  export let items: Item[] | null;
  export let href = '';
  /** small rank chip on the corner of portrait posters */
  export let ranked = false;
  /** cards get an X button; the parent handles `remove` */
  export let removable = false;
  /** phone layout: 16:9 cards with progress bar and ⓘ/⋯ bar instead of 2:3 posters (Weiterschauen, Nächste Folge) */
  export let landscape = false;
  /** first visible row of the page: its images load eagerly with high priority (LCP) */
  export let priority = false;
  /** recommendation row: reports one impression and its clicks as counts per row and engine (no titles) */
  export let reco: RecoTag | undefined = undefined;
  let track: HTMLDivElement | undefined, section: HTMLElement | undefined, strip: HTMLDivElement | undefined;
  let prevBtn: HTMLButtonElement | undefined, nextBtn: HTMLButtonElement | undefined;
  let canLeft = false, canRight = false, pages = 1, current = 0;
  // geometry cached by a ResizeObserver: the scroll handler only reads scrollLeft (in a rAF), never forces a layout
  let pageW = 1, maxScroll = 0, perPage = 5, raf = 0;
  const memoKey = title + '|' + href;
  /** scroll position to restore (from an earlier visit); while set, the current position is not remembered */
  let pending = scrollMemo.get(memoKey) ?? 0;

  function measure() {
    if (!track) return;
    const cs = getComputedStyle(track);
    const pad = parseFloat(cs.paddingLeft) || 0, gap = parseFloat(cs.columnGap) || 0;
    const n = parseFloat(getComputedStyle(section ?? track).getPropertyValue('--n')) || 5;
    perPage = Math.max(1, Math.floor(n));
    pageW = Math.max(1, track.clientWidth - 2 * pad + gap); // exactly the visible cards: the next page starts with the first hidden one
    maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    read();
  }
  function read() {
    if (!track) return;
    const x = track.scrollLeft;
    if (!pending) scrollMemo.set(memoKey, x);
    if (desk) {
      // desktop: whole pages of cards (pageW = the visible cards + one gap); the last page is the row's end
      const p = rowPages({ scroll: x, viewport: pageW, content: maxScroll + pageW });
      ({ pages, page: current, canPrev: canLeft, canNext: canRight } = p);
      return;
    }
    canLeft = x > 8;
    canRight = x < maxScroll - 8;
    pages = pageCount(maxScroll, pageW);
    current = pageIndex(x, maxScroll, pageW);
  }
  function onScroll() {
    if (!full) showAll();
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; read(); });
  }
  function go(dir: number) {
    if (!track) return;
    if (!full) showAll();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollBy({ left: dir * pageW, behavior: reduce ? 'auto' : 'smooth' });
  }

  /**
   * Desktop arrows: one page left / right. The scroll position jumps to the target at once and the strip springs back
   * from where it was seen (FLIP, lib/tv/motion.ts): interruptible, transform only, instant under reduced motion / calm mode.
   */
  async function turn(dir: -1 | 1) {
    if (!track) return;
    if (!full) { showAll(); await tick(); measure(); }
    const t = track, to = pageTarget({ scroll: t.scrollLeft, viewport: pageW, content: maxScroll + pageW }, dir);
    const jump = () => { const before = t.scrollLeft; t.scrollLeft = to; return t.scrollLeft - before; };
    if (strip) glide(strip, 'x', jump); else jump();
    read();
    await tick();
    // the pressed arrow hides at the row's end: keep the keyboard focus on the other one
    const gone = dir > 0 ? !canRight && document.activeElement === nextBtn : !canLeft && document.activeElement === prevBtn;
    if (gone) (dir > 0 ? prevBtn : nextBtn)?.focus({ preventScroll: true });
  }

  let ro: ResizeObserver | undefined;
  function trackAction(node: HTMLDivElement) {
    track = node;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => measure()); ro.observe(node); }
    return { destroy() { ro?.disconnect(); ro = undefined; } };
  }
  // the first n+2 cards render at once, the rest on first hover / focus / scroll or when the browser is idle
  let full = false, idleId = 0;
  $: limit = full ? Infinity : perPage + INITIAL_EXTRA;
  function showAll() { full = true; }
  $: if (items && !full && typeof window !== 'undefined' && !idleId) {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    idleId = ric ? ric(showAll, { timeout: 2500 }) : (setTimeout(showAll, 1200) as unknown as number);
  }
  $: if (items && track) void afterItems(items.length, full);
  async function afterItems(_n: number, _full: boolean) {
    await tick();
    if (!track) return;
    if (pending) { if (!full) showAll(); await tick(); restore(pending, 0); }
    requestAnimationFrame(measure);
  }
  /** rows outside the viewport are skipped by content-visibility (no layout = scrollLeft clamps to 0): retry until it sticks */
  function restore(want: number, tries: number) {
    if (!track) return;
    track.scrollLeft = want;
    if (Math.abs(track.scrollLeft - want) <= 2) { pending = 0; read(); return; }
    pending = want;
    if (tries < 60) requestAnimationFrame(() => restore(want, tries + 1));
  }
  $: if (near && pending) requestAnimationFrame(() => pending && restore(pending, 0));
  // skeleton shimmer only while the row is near the viewport
  let near = false, io: IntersectionObserver | undefined;
  $: if (section && !io && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((es) => { const e = es[es.length - 1]; if (e) near = e.isIntersecting; }, { rootMargin: '200px 0px' });
    io.observe(section);
  }
  // TV: poster mode is ignored (every card is 16:9); the layout switches the class on <html> once /api/me answered
  let tvOn = false;
  onMount(() => {
    const sync = () => { tvOn = document.documentElement.classList.contains('tv'); };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  });
  /** desktop browse layout (not phone, TV or the kids UI): paged rows, outlined rank numerals */
  $: desk = deskUi({ tv: tvOn, mobile: $mobile, kids: $kidsMode });
  /** TV: the focus tile labels a card of a ranked row with its rank (the tile cannot know the row) */
  const rankFocus = (id: string, n: number) => { if (tvOn) tvRank.set(ranked ? { id, n } : null); };
  onDestroy(() => { io?.disconnect(); if (raf) cancelAnimationFrame(raf); });
</script>

{#if items === null || items.length}
  <section class="row" class:m={$mobile} class:dk={desk} class:land={landscape} class:near class:rk={ranked && !tvOn} bind:this={section} aria-label={title} aria-busy={items === null} on:pointerenter={() => !full && showAll()} on:focusin={() => !full && showAll()} use:recoTrack={reco}>
    <div class="hd">
      <h2>{#if href}<a {href}>{title}<span class="more"> {$t('home.row.showAll')}</span><Icon name="chevron-right" size={18} /></a>{:else}{title}{/if}</h2>
      {#if desk}
        {#if pages > 1}<ol class="pgdots" aria-label={$t('desk.row.pages')}>{#each Array(pages) as _, i}<li aria-current={i === current ? 'true' : undefined}><span class="sr-only">{$t('desk.row.page', { n: i + 1 })}</span></li>{/each}</ol>{/if}
      {:else if pages > 1 && !$mobile}<ol class="dots" aria-hidden="true">{#each Array(pages) as _, i}<li class:on={i === current}></li>{/each}</ol>{/if}
    </div>
    {#if items && reco}<ReasonCaption {items} />{/if}
    <div class="wrap">
      {#if desk}
        <button type="button" class="pg prev" class:on={canLeft} aria-label={$t('desk.row.prev')} bind:this={prevBtn} on:click={() => turn(-1)}><Icon name="chevron-left" size={32} /></button>
      {:else}
        <button class="arrow left" class:hide={!canLeft} aria-label={$t('home.row.prev')} on:click={() => go(-1)}><Icon name="chevron-left" size={34} /></button>
      {/if}
      <div class="track" use:trackAction on:scroll={onScroll} role="list">
        <!-- the strip only exists as a box on TV and the desktop layout (the row glide / page turn moves it, lib/tv/motion.ts); elsewhere it is display: contents -->
        <div class="strip" data-glide={tvOn ? '' : undefined} bind:this={strip}>
        {#if items === null}
          {#each Array(8) as _}<div class="slot"><div class="skeleton ph" class:poster={(($mobile && !landscape) || ranked) && !tvOn}></div></div>{/each}
        {:else}
          {#each items as it, idx (it.id)}{#if idx < limit}<div class="slot" class:ranked role="listitem" on:focusin={() => rankFocus(it.id, idx + 1)}>{#if ranked}<span class="rank" class:two={idx >= 9} aria-label={$t('home.row.rank', { n: idx + 1 })}>{idx + 1}</span>{/if}{#if $mobile}<PosterCard item={it} {landscape} {removable} {priority} on:remove />{:else}<Card item={it} {removable} poster={ranked && !tvOn} {priority} on:remove />{/if}</div>{/if}{/each}
        {/if}
        </div>
      </div>
      {#if desk}
        <button type="button" class="pg next" class:on={canRight} aria-label={$t('desk.row.next')} bind:this={nextBtn} on:click={() => turn(1)}><Icon name="chevron-right" size={32} /></button>
      {:else}
        <button class="arrow right" class:hide={!canRight} aria-label={$t('home.row.next')} on:click={() => go(1)}><Icon name="chevron-right" size={34} /></button>
      {/if}
    </div>
  </section>
{/if}

<style>
  /* content-visibility skips off-screen rows; the size estimate matches the real height (slot width * card ratio + title)
     so the page height - and the scroll position restored on "back" - stays exact before a row was rendered once */
  .row { position: relative; z-index: 1; margin: 1.6rem 0 0; padding-bottom: .6rem; --n: 2.4; --gap: .45rem; --sw: calc((100vw - 2 * var(--pad-x) - (var(--n) - 1) * var(--gap)) / var(--n)); content-visibility: auto; contain-intrinsic-size: auto calc(var(--sw) * .5625 + 42px); }
  .row.rk { contain-intrinsic-size: auto calc(var(--sw) * .78 + 42px); }
  /* iOS WebKit: skipped rows whose size estimate differs (e.g. cards with a title bar) change the page height mid-scroll;
     the fixed tab bar then jumps into the page and rows paint blank until scrolling stops - render every row there */
  @supports (-webkit-touch-callout: none) { .row, .row.rk { content-visibility: visible; contain-intrinsic-size: none; } }
  .row:hover, .row:focus-within { z-index: 4; }
  @media (min-width: 560px) { .row { --n: 3; } }
  @media (min-width: 800px) { .row { --n: 4; } }
  @media (min-width: 1100px) { .row { --n: 5; } }
  @media (min-width: 1400px) { .row { --n: 6; } }
  .hd { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin: 0 var(--pad-x) .45rem; }
  h2 { font-size: clamp(1.05rem, .55vw + .8rem, 1.45rem); font-weight: 600; margin: 0; letter-spacing: -.005em; line-height: 1.25; }
  /* page indicator (top right, only while the row is hovered) */
  .dots { display: flex; gap: 2px; list-style: none; margin: 0 0 .3rem; padding: 0; opacity: 0; transition: opacity var(--t-fast); }
  .dots li { width: 12px; height: 2px; background: #3c4650; }
  .dots li.on { background: #aaa; }
  .row:hover .dots, .row:focus-within .dots { opacity: 1; }
  h2 a { display: inline-flex; align-items: center; gap: .2rem; }
  .more { font-size: .8rem; color: #54b9c5; max-width: 0; overflow: hidden; white-space: nowrap; opacity: 0; transition: max-width var(--t-med), opacity var(--t-med), margin var(--t-med); }
  h2 a:hover .more, h2 a:focus-visible .more { max-width: 10rem; opacity: 1; margin-left: .6rem; }
  .wrap { position: relative; }
  .track { display: flex; gap: var(--gap); overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; scrollbar-width: none; padding: .4rem var(--pad-x) .6rem; margin: -.4rem 0 -.6rem; /* small room for focus rings; the hover pop-out lives in <body> */ scroll-padding: 0 var(--pad-x); }
  .track::-webkit-scrollbar { display: none; }
  .strip { display: contents; }
  /* 100% = the track content box (inside the pad-x padding): exactly n cards per page, the neighbours peek in the padding */
  .slot { flex: 0 0 calc((100% - (var(--n) - 1) * var(--gap)) / var(--n)); scroll-snap-align: start; min-width: 0; }
  /* ranked row: normal portrait posters with a small filled rank chip on the top-right corner */
  .slot.ranked { position: relative; }
  .rank { position: absolute; right: .45rem; top: .45rem; z-index: 3; display: inline-flex; align-items: center; justify-content: center; min-width: 1.7rem; height: 1.7rem; padding: 0 .5rem; border-radius: 99px; background: var(--acc-fill); color: #fff; font-size: .85rem; font-weight: 800; line-height: 1; box-shadow: 0 2px 8px rgba(0, 0, 0, .45); pointer-events: none; user-select: none; }
  .row:not(.near) :global(.skeleton::after) { animation: none; display: none; }
  .ph { aspect-ratio: 16 / 9; width: 100%; }
  .ph.poster { aspect-ratio: 2 / 3; }
  .arrow { position: absolute; top: .4rem; bottom: .6rem; width: var(--pad-x); min-width: 44px; border-radius: 0; background: rgba(16, 20, 24, .55); opacity: 0; z-index: 7; padding: 0; }
  .arrow:hover:not(:disabled) { background: rgba(16, 20, 24, .8); }
  .arrow.left { left: 0; } .arrow.right { right: 0; }
  .arrow.hide { display: none; }
  .row:hover .arrow, .arrow:focus-visible { opacity: 1; }
  @media (hover: none), (pointer: coarse) { .arrow { display: none; } }

  /* ---- desktop browse (spec §2): paged rows from the logo's gutter, arrows on hover / focus, page dots, rank numerals ---- */
  .row.dk { --gap: 8px; --emph: cubic-bezier(.05, .7, .1, 1); margin-top: 24px; }
  .row.dk .hd { align-items: center; min-height: 28px; margin: 0 var(--pad-x) 8px; }
  .row.dk h2 { font-size: 20px; font-weight: 700; line-height: 28px; letter-spacing: -.01em; }
  /* the strip is a real box here: the page turn moves it (FLIP), the track keeps the scroll position */
  /* no snapping: the page turn sets exact positions, and snap points measured mid-spring (transformed) would pull the row back */
  .row.dk .track { container-type: inline-size; scroll-snap-type: none; }
  /* room above the cards for the poster tilt's lift (glass spec §8.7): the track reaches into the gap under the title (layout
     unchanged), the title stays on top */
  .row.dk .hd { position: relative; z-index: 2; }
  .row.dk .track { padding-top: 16px; margin-top: -16px; }
  .row.dk .pg { top: 16px; } /* the edge areas still start at the cards */
  .row.dk .strip { display: flex; flex: none; gap: var(--gap); }
  /* 100cqw = the track's content box (inside the gutters): exactly n cards per page */
  .row.dk .slot { --sw: calc((100cqw - (var(--n) - 1) * var(--gap)) / var(--n)); flex: 0 0 var(--sw); }
  .pgdots { display: flex; gap: 4px; list-style: none; margin: 0; padding: 0; opacity: 0; transition: opacity 200ms var(--emph); }
  .pgdots li { position: relative; width: 16px; height: 2px; background: rgba(255, 255, 255, .24); }
  .pgdots li::after { content: ''; position: absolute; inset: 0; background: #fff; opacity: 0; transition: opacity 200ms var(--emph); }
  .pgdots li[aria-current]::after { opacity: 1; }
  .row.dk:hover .pgdots, .row.dk:focus-within .pgdots { opacity: 1; }
  /* 56 px edge areas over the peeking neighbours; a fade into the page instead of a box */
  .row .pg { position: absolute; top: .4rem; bottom: .6rem; z-index: 7; width: 56px; min-height: 0; padding: 0; border-radius: 0; color: #fff; opacity: 0; transition: opacity 200ms var(--emph); }
  .row .pg.prev, .row .pg.prev:hover:not(:disabled) { left: 0; background: linear-gradient(to right, rgba(16, 20, 24, .9), rgba(16, 20, 24, .6) 55%, rgba(16, 20, 24, 0)); }
  .row .pg.next, .row .pg.next:hover:not(:disabled) { right: 0; background: linear-gradient(to left, rgba(16, 20, 24, .9), rgba(16, 20, 24, .6) 55%, rgba(16, 20, 24, 0)); }
  .row .pg:not(.on) { visibility: hidden; }
  .row .pg :global(svg) { transition: transform 200ms var(--emph); }
  .row .pg:hover :global(svg), .row .pg:focus-visible :global(svg) { transform: scale(1.2); }
  .row .pg:active:not(:disabled) { transform: none; }
  .row .pg:focus-visible { outline: 2px solid #fff; outline-offset: -6px; }
  .row.dk:hover .pg, .row.dk:focus-within .pg { opacity: 1; }
  @media (hover: none), (pointer: coarse) { .row.dk:hover .pg:not(:focus-visible) { opacity: 0; } }
  /* ranked rows: a large outlined numeral, the poster overlapping its right edge */
  .row.dk.rk { contain-intrinsic-size: auto calc(var(--sw) * .87 + 48px); }
  .row.dk .slot.ranked { display: flex; align-items: flex-end; }
  .row.dk.rk .ph.poster { width: 58%; margin-left: auto; } /* the skeleton takes the poster's place, no jump when it loads */
  .row.dk .slot.ranked > :global(.card) { position: relative; z-index: 1; flex: 0 0 58%; min-width: 0; margin-left: -4%; }
  /* z-index: a flex item stacks even when static; the poster (z 1) must stay above the numeral */
  .row.dk .rank { position: static; z-index: 0; flex: 0 0 46%; display: block; min-width: 0; height: auto; padding: 0; border-radius: 0; background: none; box-shadow: none; text-align: right;
    font-size: calc(var(--sw) * .9); font-weight: 800; line-height: .74; letter-spacing: -.06em; color: var(--bg);
    /* outline only: the page colour fills the glyph over the inner half of the stroke, which also hides the overlapping contours of the variable font */
    -webkit-text-fill-color: var(--bg); -webkit-text-stroke: 4px rgba(255, 255, 255, .5); paint-order: stroke fill; }
  .row.dk .rank.two { font-size: calc(var(--sw) * .66); letter-spacing: -.1em; }

  /* ---- phone: swipeable poster rows (3.2 posters visible), no hover room needed ---- */
  .row.m { --gap: .4rem; --pw: calc((100vw - var(--pad-x) - 3 * var(--gap)) / 3.2); margin-top: 1.4rem; contain-intrinsic-size: auto calc(var(--pw) * 1.5 + 39px); }
  .row.m.land { contain-intrinsic-size: auto calc(var(--pw) * .5625 + 80px); }
  .row.m:hover, .row.m:focus-within { z-index: 1; }
  .row.m .hd { margin: 0 var(--pad-x) .5rem; }
  .row.m h2 { font-size: 1.05rem; font-weight: 700; }
  .row.m .track { padding: 0 var(--pad-x); margin: 0; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }
  .row.m .slot { flex: 0 0 var(--pw); }
  .row.m .arrow { display: none; }
  :global(html.tv) .arrow { display: none; } /* TV: the D-pad scrolls the row; the edge strips only got in the way of the pointer */
  /* ---- TV: 16:9 cards, 6.5 across the safe area, the focused card scales (app.css) ---- */
  /* TV (spec 5.1): --pad-x is the 56 px gutter (set on the home rows); ~6.5 cards between the gutter and the right safe area */
  /* row -> row 48 px: 1.6rem margin + 1.4rem bottom padding; the padding keeps the focused card's ring inside the row (content-visibility clips paint to the row box) */
  :global(html.tv) .row { --gap: .8rem; --cw: calc((100vw - var(--tv-left) - 5vw) / 6.5); margin-top: 1.6rem; padding-bottom: 1.4rem; contain-intrinsic-size: auto calc(var(--cw) * .5625 + 6.9rem); }
  :global(html.tv) .row:hover, :global(html.tv) .row:focus-within { z-index: 4; }
  :global(html.tv) .hd { margin: 0 var(--pad-x) 1rem; }
  :global(html.tv) h2 { font-size: 1.625rem; font-weight: 600; letter-spacing: 0; line-height: 1.2; color: var(--tv-white-88); }
  :global(html.tv) h2 a { color: inherit; }
  :global(html.tv) .dots { display: none; }
  /* the track runs from the rail edge, so cards slide out under the rail; the padding puts the first card on the gutter and leaves room for the focus scale */
  :global(html.tv) .track { padding: 1.4rem 5vw 1.4rem var(--pad-x); margin: -1.4rem 0; scroll-padding: 0 5vw 0 var(--pad-x); overscroll-behavior: contain; }
  /* the strip carries the row glide (FLIP: scrollLeft jumps, the strip's transform springs back; spec 5.2) */
  :global(html.tv) .strip { display: flex; flex: none; gap: var(--gap); }
  :global(html.tv) .slot { flex: 0 0 var(--cw); }
  :global(html.tv) .rank { right: .625rem; top: .625rem; min-width: 2rem; height: 2rem; border-radius: 4px; box-shadow: none; font-size: .9375rem; font-weight: 600; letter-spacing: .02em; font-variant-numeric: tabular-nums; }
  /* phone Top 10: a large outlined numeral, the poster overlapping its right edge (the slot widens to hold both) */
  .row.m .slot.ranked { flex-basis: calc(var(--pw) * 1.42); display: flex; align-items: flex-end; }
  .row.m .slot.ranked > :global(.pc) { position: relative; z-index: 1; flex: 0 0 var(--pw); }
  .row.m .rank { position: static; z-index: 0; flex: 1 1 auto; min-width: 0; height: auto; padding: 0; margin-right: calc(var(--pw) * -.13); border-radius: 0; background: none; box-shadow: none; text-align: right;
    font-size: calc(var(--pw) * .95); font-weight: 900; line-height: .78; letter-spacing: -.08em; color: var(--bg);
    -webkit-text-fill-color: var(--bg); -webkit-text-stroke: 2.5px rgba(255, 255, 255, .45); paint-order: stroke fill; }
  .row.m .rank.two { font-size: calc(var(--pw) * .7); letter-spacing: -.1em; }
  .row.m.land { --pw: calc((100vw - var(--pad-x)) / 2.15); }
</style>
