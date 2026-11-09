<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { backdrop, HERO_WIDTHS, logoUrl, srcset, type Item } from '#lib/api';
  import { cardTag, FRESH_KEYS, LEAVING_BADGE_DAYS } from '#lib/badges';
  import { badges, wantBadge, type Facts } from '#lib/fresh';
  import { fmtDate, t } from '#lib/i18n';
  import { lengthLabel } from '#lib/hover';
  import { motionAllowed, toggleSound } from '#lib/preview';
  import { playPrefetch } from '#lib/player/prefetch';
  import type { Thumb } from '#lib/rating';
  import type { About } from '#lib/detail/about';
  import { remainingLabel, type Person } from '#lib/detail/format';
  import { AUTOSTART_COUNTDOWN_S, countdownLabel } from '#lib/detail/autostart';
  import { detailTabs, type DetailTab } from '#lib/desk/tabs';
  import { canGoBack } from '#lib/desk/back';
  import { EMPH_IN, EMPH_OUT, motionLevel } from '#lib/tv/motion';
  import { cachedTone, SCRIM_SAFE, toneFor, toneVars, type Tone } from '#lib/glass/tone';
  import { sheen } from '#lib/glass/pointer';
  import SlidePill from '#lib/glass/SlidePill.svelte';
  import Icon from '#lib/Icon.svelte';
  import QualityChips from '#lib/QualityChips.svelte';
  import RatingButton from '#lib/RatingButton.svelte';
  import MoreActions, { type MoreAction } from '#lib/MoreActions.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import StatusPicker from '#lib/StatusPicker.svelte';
  import LangPick from '#lib/LangPick.svelte';
  import CastRow from '#lib/CastRow.svelte';
  import FriendsStrip from '#lib/FriendsStrip.svelte';
  import EpisodeList from '#lib/detail/EpisodeList.svelte';
  import MoreLikeThis from '#lib/detail/MoreLikeThis.svelte';
  import Extras from '#lib/detail/Extras.svelte';
  import DetailsTab from '#lib/detail/DetailsTab.svelte';
  import CollectionRow from '#lib/detail/CollectionRow.svelte';
  import StoryCard from '#lib/detail/StoryCard.svelte';
  import RatingsLine from '#lib/detail/RatingsLine.svelte';
  import Safe from '#lib/detail/Safe.svelte';

  /**
   * Desktop detail page (spec desktop browse §3, "cinematic"): a full-viewport backdrop that stays put while the page scrolls
   * (the muted trailer fades in after 1.5 s, DetailView owns it), a left column with eyebrow, title, meta, synopsis and the
   * actions, and below it the tabs that have content. Everything comes from DetailView (same loads as the other variants).
   */
  export let item: Item;
  export let about: About | null | undefined = undefined;
  export let facts: Facts | null = null;
  export let people: Person[] = [];
  export let extras: Array<Item & { kind?: 'trailer' | 'extra' }> = [];
  /** null = loading */
  export let more: Item[] | null = null;
  export let seasons: Item[] = [];
  export let season = '';
  export let episodes: Item[] | null = null;
  export let next: Item | null = null;
  export let qs = '';
  export let playTarget = '';
  export let playBase = '';
  export let playHref = '';
  export let playLabel = '';
  /** the title Play resumes (a series: its next episode) */
  export let resumeFrom: Item | null = null;
  export let tagline = '';
  export let overview = '';
  /** audio / subtitle languages ("Ton: … · Untertitel: …") for the Details tab */
  export let langs = '';
  export let inList = false;
  export let titleId = 'detail-title';
  export let thumb: Thumb = 0;
  export let audio = '';
  export let sub = '';
  export let moreActions: MoreAction[] = [];
  /** kids profiles: no social entry points */
  export let social = true;
  /** the trailer may be started by hand (a preview exists and none runs) */
  export let canTrailer = false;
  /** the backdrop trailer (DetailView owns the preview: playPreview into `video`) */
  export let playing = false;
  export let loop = true;
  export let video: HTMLVideoElement | undefined = undefined;
  export let loaded = false;
  /** the in-flow first screen: DetailView watches it (IntersectionObserver) and stops the trailer once it scrolled away */
  export let stage: HTMLDivElement | undefined = undefined;
  /** auto start countdown (DetailView's timer) */
  export let counting = false;
  export let autoLeft = 0;
  export let autoEl: HTMLDivElement | undefined = undefined;
  export let onCancelAuto: () => void = () => {};
  export let onMyList: () => void = () => {};
  export let onThumb: (e: CustomEvent<{ value: Thumb }>) => void = () => {};
  export let onTrailer: () => void = () => {};
  export let onEnded: () => void = () => {};
  export let onTimeUpdate: () => void = () => {};
  export let onPlay: (e: MouseEvent) => void = () => {};
  export let onRated: (average: number | null) => void = () => {};

  // ---- title block ----
  let logoFailed = false, bgFailed = false, shownId = '';
  $: if (item.id !== shownId) { shownId = item.id; logoFailed = false; bgFailed = false; synOpen = false; tab = ''; shown = ''; }
  $: showBg = Boolean(item.backdrop) && !bgFailed;
  $: logo = Boolean(item.logo) && !logoFailed;
  $: badgeId = item.type === 'Episode' ? item.seriesId : item.id;
  $: wantBadge(badgeId);
  $: tag = cardTag($badges[badgeId ?? ''], item, Date.now());
  // the eyebrow: the card's label (badges), else what the title's facts say (leaving soon wins over a fresh label)
  $: leaving = facts?.leaving ?? null;
  $: factsKey = leaving && leaving.days <= LEAVING_BADGE_DAYS ? (leaving.days === 0 ? 'fresh.leaving.today' : 'fresh.leaving.days')
    : facts?.fresh && item.type !== 'Episode' ? FRESH_KEYS[facts.fresh] : undefined;
  $: eyebrow = tag ? $t(tag.key, tag.kind === 'leaving' ? { n: tag.n } : undefined) : factsKey ? $t(factsKey, { n: leaving?.days ?? 0 }) : '';
  /** "2026-10-24" as a local calendar day; odd data (not a date) gives nothing instead of breaking the page */
  function untilDate(iso: unknown): string {
    if (typeof iso !== 'string') return '';
    const [y, m, d] = iso.split('-').map(Number);
    const day = new Date(y!, m! - 1, d);
    return Number.isNaN(day.getTime()) ? '' : fmtDate(day, { day: 'numeric', month: 'long' });
  }
  $: untilText = leaving ? untilDate(leaving.leavesAt) : '';
  $: until = untilText ? $t('fresh.leaving.until', { date: untilText }) : '';
  $: match = item.communityRating && item.communityRating > 0 ? $t('home.hero.match', { pct: Math.round(item.communityRating * 10) }) : '';
  $: len = lengthLabel(item);
  $: deskPlay = item.type === 'Series' && next
    ? $t('desk.detail.continueEp', { s: String(next.parentIndexNumber ?? '?'), e: String(next.indexNumber ?? '?') })
    : playLabel;
  $: progress = resumeFrom?.positionTicks && resumeFrom.runtimeTicks ? Math.min(1, Math.max(0.02, resumeFrom.positionTicks / resumeFrom.runtimeTicks)) : 0;
  $: remaining = resumeFrom ? remainingLabel(resumeFrom.positionTicks, resumeFrom.runtimeTicks) : '';
  $: restartHref = progress && playBase ? `${playBase}?${['t=0', qs].filter(Boolean).join('&')}` : '';
  $: localTrailer = extras.find((x) => x.kind === 'trailer') ?? null;
  // the backdrop has nothing to wait for when there is none (the trailer may still start)
  function bgGone() { bgFailed = true; loaded = true; }

  // ---- the glass info panel's tone (glass spec §4, §8.2): the backdrop's colour as a tint, and the scrim white text needs ----
  // Without a tone the panel keeps the safe scrim (.frost-safe, passes AA over pure white). A tone the card sampled before
  // (same key as the hover card: the series for an episode) applies at once. Otherwise the backdrop is sampled once it
  // loaded: its tint crossfades in, and its scrim applies only while the panel is not on screen yet (no jump under the text).
  // The card's tone came from the card's picture, not this backdrop: the backdrop is sampled too, and a brighter one raises
  // the scrim (contrast first). While the trailer plays (frames nobody sampled) the scrim is at least the safe one.
  const toneKey = (i: Item) => i.seriesId ?? i.id;
  const tintOf = (x: Tone) => x.tint.join(', ');
  let tone: Tone | null = null, scrim: number | null = null, tints: [string, string] = ['', ''], front = 0, cardTone = false, toneId = '', panelShown = false;
  function toneReset(i: Item) {
    toneId = i.id;
    const c = cachedTone(toneKey(i));
    cardTone = Boolean(c);
    tone = c ?? null; scrim = c ? c.scrim : null; tints = [c ? tintOf(c) : '', '']; front = 0;
  }
  $: if (item.id !== toneId) toneReset(item);
  $: scrimNow = scrim === null ? null : playing ? Math.max(scrim, SCRIM_SAFE) : scrim;
  $: panelStyle = tone && scrimNow !== null ? toneVars({ ...tone, scrim: scrimNow }) : tone ? `--fr-tint:${tintOf(tone)}` : '';
  function bgLoaded(e: Event) {
    loaded = true;
    const im = e.currentTarget as HTMLImageElement, src = im.currentSrc || im.src, id = item.id;
    if (!src) return;
    if (cardTone) {
      void toneFor('bd:' + id, src).then((b) => { if (b && id === item.id && scrim !== null && b.scrim > scrim) scrim = b.scrim; });
      return;
    }
    // a picture that could not be read before (cached null) is not asked again under the shared key
    const key = cachedTone(toneKey(item)) === null ? 'bd:' + id : toneKey(item);
    void toneFor(key, src).then((t) => {
      if (!t || id !== item.id) return;
      const back = 1 - front;
      tints[back] = tintOf(t);
      front = back;
      tone = t;
      if (!panelShown) scrim = t.scrim;
    });
  }
  /** the light sheen, clipped by its own layer (the panel itself does not clip: the rating pill grows past it) */
  function panelSheen(node: HTMLElement) {
    const a = sheen(node);
    const s = node.querySelector(':scope > .frost-sheen'), clip = node.querySelector(':scope > .pclip');
    if (s && clip) clip.appendChild(s);
    return a;
  }

  // ---- synopsis: 4 lines, "More" only when the text is longer ----
  let synOpen = false, synClamped = false, synEl: HTMLParagraphElement | undefined, synRo: ResizeObserver | undefined;
  function measure() { if (synEl && !synOpen) synClamped = synEl.scrollHeight > synEl.clientHeight + 1; }
  /** re-measure once the text is rendered (`_text`: whenever it changes) */
  function measureLater(_text: string) { void tick().then(measure); }
  $: if (synEl) measureLater(overview);
  $: if (synEl && !synRo && typeof ResizeObserver !== 'undefined') { synRo = new ResizeObserver(measure); synRo.observe(synEl); }

  // ---- the column stays put visually when the ratings block changes height: FLIP of its parts (transform only) ----
  let colEl: HTMLDivElement | undefined;
  function glideOnResize(node: HTMLElement) {
    if (typeof ResizeObserver === 'undefined') return {};
    let tops: Map<Element, number> | null = null;
    // positions against the first screen (the column itself moves: it sits on the screen's bottom edge)
    const measureTops = () => {
      const base = stage?.getBoundingClientRect().top ?? 0;
      return new Map([...(colEl?.children ?? [])].map((c) => [c, c.getBoundingClientRect().top - base] as const));
    };
    const ro = new ResizeObserver(() => {
      const now = measureTops();
      if (tops && motionAllowed() && motionLevel() === 'full') {
        for (const [c, top] of now) {
          const was = tops.get(c);
          if (was === undefined || Math.abs(was - top) < 1 || typeof (c as HTMLElement).animate !== 'function') continue;
          (c as HTMLElement).animate([{ transform: `translate3d(0px, ${was - top}px, 0px)` }, { transform: 'translate3d(0px, 0px, 0px)' }], { duration: 320, easing: EMPH_OUT });
        }
      }
      tops = now;
    });
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }

  // ---- "‹ Back": in-app history when there is some, else home ----
  function back(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (canGoBack()) history.back();
    else void goto('/');
  }

  // ---- tabs: only those with content, the first one selected ----
  // A movie's first tab depends on "More like this", so its tab bar waits for that answer (a placeholder keeps the height): no
  // tab appears and vanishes again, no selection jumps. The selection is then pinned, so a later answer (extras) only adds a tab.
  $: tabsReady = item.type === 'Series' || more !== null;
  $: tabs = detailTabs({ series: item.type === 'Series', similar: more?.length ?? 0, extras: extras.length });
  let tab: DetailTab | '' = '';
  $: if (tabsReady && !tab && tabs.length) tab = tabs[0]!;
  $: cur = (tab && tabs.includes(tab) ? tab : tabs[0]) as DetailTab;
  /** the panel on screen (trails `cur` by the 120 ms fade-out) */
  let shown: DetailTab | '' = '';
  $: if (tabsReady && (!shown || (!tabs.includes(shown) && !switching))) shown = cur;
  const tabLabel = (n: DetailTab): string => n === 'episodes' ? $t('detail.episodes.title') : n === 'details' ? $t('detail.about.tab') : n === 'extras' ? $t('desk.detail.extras') : $t('detail.more.title');
  let panelEl: HTMLDivElement | undefined, switchSeq = 0, switching = false, fadeOut: Animation | undefined;
  async function select(n: DetailTab) {
    if (n === cur && n === shown) return;
    tab = n;
    const my = ++switchSeq;
    const level = motionAllowed() ? motionLevel() : 'off';
    if (level === 'off' || !panelEl || typeof panelEl.animate !== 'function') { shown = n; return; }
    switching = true;
    // out: 120 ms, emphasised accelerate; in: 200 ms, rises 8 px (the reduced set: opacity only)
    if (shown !== n) {
      // a switch during the fade-out rides on it (no restart from full opacity); the newest switch decides what comes in
      if (!fadeOut || fadeOut.playState !== 'running') fadeOut = panelEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: EMPH_IN, fill: 'forwards' });
      try { await fadeOut.finished; } catch { /* cancelled */ }
      if (my !== switchSeq) return;
    }
    shown = n;
    switching = false;
    await tick();
    fadeOut?.cancel();
    if (my !== switchSeq || !panelEl) return;
    const rise = level === 'full';
    panelEl.animate(rise
      ? [{ opacity: 0, transform: 'translate3d(0px, 8px, 0px)' }, { opacity: 1, transform: 'translate3d(0px, 0px, 0px)' }]
      : [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EMPH_OUT });
  }
  let tabsEl: HTMLDivElement | undefined;
  function tabKeys(e: KeyboardEvent) {
    const i = tabs.indexOf(cur);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : d ? (i + d + tabs.length) % tabs.length : -1;
    if (j < 0) return;
    e.preventDefault();
    const n = tabs[j]!;
    void select(n);
    void tick().then(() => tabsEl?.querySelector<HTMLElement>('#dd-tab-' + n)?.focus());
  }

  // ---- the backdrop darkens as the tabs climb to the top (opacity of one layer, rAF-throttled scroll) ----
  let dim = 0, raf = 0, ro: ResizeObserver | undefined, roOn: HTMLElement | undefined, lowerEl: HTMLDivElement | undefined;
  function shade() {
    raf = 0;
    if (!lowerEl) return;
    const top = lowerEl.getBoundingClientRect().top + scrollY;
    const t = Math.min(1, Math.max(0, scrollY / Math.max(1, top - 96)));
    dim = +(0.82 * t).toFixed(3);
  }
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(shade); };
  // the tab bar may arrive after the first paint (a movie waits for "More like this"): the shade follows its place
  $: if (tabsEl && tabsEl !== roOn && typeof ResizeObserver !== 'undefined') {
    ro ??= new ResizeObserver(() => onScroll());
    ro.disconnect(); ro.observe(tabsEl); roOn = tabsEl;
  }
  onMount(() => {
    requestAnimationFrame(() => (panelShown = true)); // painted: a tone arriving later only crossfades the tint
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    shade();
  });
  onDestroy(() => {
    if (typeof window === 'undefined') return;
    removeEventListener('scroll', onScroll); removeEventListener('resize', onScroll);
    cancelAnimationFrame(raf); ro?.disconnect(); synRo?.disconnect(); fadeOut?.cancel(); switchSeq++;
  });

  // ---- trailer: mute state follows the video ----
  let muted = true;
</script>

<div class="dd">
  <!-- data-vt-art: the card / preview artwork morphs into this box (View Transition, Task 7; same convention as TV) -->
  <div class="bd" data-vt-art="">
    {#if showBg}
      <img class="bg" data-play-art class:loaded src={backdrop(item.id, 1280)} srcset={srcset('Backdrop', item.id, HERO_WIDTHS)} sizes="100vw" alt="" fetchpriority="high"
        on:load={bgLoaded} on:error={bgGone} />
    {/if}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="hv" class:on={playing} bind:this={video} {loop} playsinline aria-hidden="true" tabindex="-1"
      on:volumechange={() => (muted = !!video?.muted)} on:playing={() => (muted = !!video?.muted)} on:timeupdate={onTimeUpdate} on:ended={onEnded}></video>
    <div class="shade"></div>
    <div class="dim" style="opacity:{dim}"></div>
  </div>

  <div class="stage" bind:this={stage}>
    <a class="dback" href="/" on:click={back}><Icon name="chevron-left" size={20} /><span>{$t('desk.detail.back')}</span></a>
    <div class="col frost frost-panel frost-safe" style={panelStyle} use:panelSheen>
      <span class="frost-tint" aria-hidden="true"><i class:on={tints[0] && front === 0} style={tints[0] ? `--t:${tints[0]}` : undefined}></i><i class:on={tints[1] && front === 1} style={tints[1] ? `--t:${tints[1]}` : undefined}></i></span>
      <span class="pclip" aria-hidden="true"></span>
    <div class="top" bind:this={colEl}>
      {#if eyebrow}<p class="eyebrow" data-st>{eyebrow}</p>{/if}
      <h1 class="title" class:haslogo={logo} id={titleId} data-st>
        {#if logo}<span class="sr-only">{item.name}</span><img class="tlogo" src={logoUrl(item.id)} alt="" on:error={() => (logoFailed = true)} />{:else}{item.name}{/if}
      </h1>
      <div class="facts" data-st>
        <div class="meta">
          {#if match}<span class="match">{match}</span>{/if}
          {#if item.year}<span>{item.year}</span>{/if}
          {#if item.rating}<span class="age" title={$t('detail.view.ageRating')}>{item.rating}</span>{/if}
          {#if len}<span>{len}</span>{/if}
          <QualityChips traits={facts?.traits} />
          {#if until}<span class="until">{until}</span>{/if}
        </div>
        <!-- ratings line + tagline: a placeholder of the line's height while "about" loads; when the block settles, the column
             glides to its new place (transform only) instead of jumping -->
        <div class="lead" use:glideOnResize><Safe name="ratings" key={item.id}><RatingsLine {about} /></Safe>{#if tagline}<p class="tagline">{tagline}</p>{/if}</div>
      </div>
      <div class="synbox" data-st>
        <p class="syn ov" class:open={synOpen} id="dd-syn" bind:this={synEl}>{overview || $t('detail.view.noOverview')}</p>
        {#if synClamped || synOpen}
          <button type="button" class="lnk" aria-expanded={synOpen} aria-controls="dd-syn" on:click={() => (synOpen = !synOpen)}>{synOpen ? $t('detail.about.less') : $t('detail.about.more')}</button>
        {/if}
      </div>
      <div class="acts" data-st>
        <a class="play" data-autofocus href={playHref} use:playPrefetch on:click={onPlay}><Icon name="play" size={24} /><span>{deskPlay}</span></a>
        {#if restartHref}
          <a class="rb frost-btn round" use:sheen href={restartHref} use:playPrefetch aria-label={$t('tv.detail.restart')} title={$t('tv.detail.restart')}><Icon name="refresh" size={20} /></a>
        {/if}
        <button type="button" class="rb frost-btn round" use:sheen class:on={inList} aria-pressed={inList} aria-label={inList ? $t('detail.view.removeFromList') : $t('detail.view.addToList')} title={$t('detail.view.myList')} on:click={onMyList}><Icon name={inList ? 'check' : 'plus'} size={22} /></button>
        <RatingButton itemId={item.id} bind:value={thumb} size={44} on:change={onThumb} />
        {#if localTrailer}
          <a class="rb frost-btn round" use:sheen href={qs ? `/watch/${localTrailer.id}?${qs}` : `/watch/${localTrailer.id}`} aria-label={$t('detail.actions.trailer')} title={$t('detail.actions.trailer')}><Icon name="film" size={20} /></a>
        {:else if canTrailer}
          <button type="button" class="rb frost-btn round" use:sheen aria-label={$t('detail.actions.trailer')} title={$t('detail.actions.trailer')} on:click={onTrailer}><Icon name="film" size={20} /></button>
        {/if}
        {#if playing}
          <button type="button" class="rb frost-btn round" use:sheen aria-label={muted ? $t('detail.view.soundOn') : $t('detail.view.soundOff')} aria-pressed={!muted} on:click={() => toggleSound(video)}><Icon name={muted ? 'volume-off' : 'volume'} size={20} /></button>
        {/if}
        <MoreActions actions={moreActions} variant="ring" size={44} title={item.name}>
          <div class="mslot">
            {#if social}<ListMenu itemId={item.id} variant="row" />{/if}
            <StatusPicker id={item.id} />
            {#if playTarget}<LangPick targetId={playTarget} storeKey={item.id} bind:audio bind:sub />{/if}
          </div>
        </MoreActions>
      </div>
      {#if progress && remaining}
        <p class="resume"><span class="bar" aria-hidden="true"><span style="transform:scaleX({progress})"></span></span><span>{remaining}</span></p>
      {/if}
      <slot />
    </div>
    </div>
    {#if counting}
      <div class="auto frost frost-pill frost-safe" role="status" bind:this={autoEl}>
        <svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" class="tr" /><circle cx="18" cy="18" r="15" class="pr" style="stroke-dashoffset:{(autoLeft / AUTOSTART_COUNTDOWN_S) * 94.25}" /></svg>
        <span>{countdownLabel(item.type === 'Series' ? 'episode' : 'movie', autoLeft)}</span>
        <button type="button" class="sec" on:click={onCancelAuto}>{$t('detail.view.cancel')}</button>
      </div>
    {/if}
  </div>

  <div class="lower" bind:this={lowerEl}>
    {#if !tabsReady}
      <div class="tabbar" aria-hidden="true"><div class="tabsk"></div></div>
    {:else}
    <div class="tabbar">
      <div class="tabs frost frost-pill frost-safe" role="tablist" aria-label={$t('hubs.extras.tabs')} tabindex="-1" bind:this={tabsEl} on:keydown={tabKeys}>
        {#each tabs as n (n)}
          <button type="button" role="tab" id="dd-tab-{n}" class="tab" class:on={cur === n} aria-selected={cur === n} aria-controls={cur === n ? 'dd-panel-' + n : undefined}
            tabindex={cur === n ? 0 : -1} on:click={() => select(n)}>{tabLabel(n)}</button>
        {/each}
        {#if tabsEl}<SlidePill host={tabsEl} selector={'[aria-selected="true"]'} tone="white" />{/if}
      </div>
    </div>
    {/if}

    {#if shown}
      <div class="tpanel" id="dd-panel-{shown}" role="tabpanel" aria-labelledby="dd-tab-{shown}" tabindex="-1" bind:this={panelEl}>
        {#if shown === 'episodes' && item.type === 'Series'}
          <Safe name="story" key={item.id}><StoryCard seriesId={item.id} /></Safe>
          <Safe name="episodes" key={item.id}><EpisodeList layout="row" seriesId={item.id} {seasons} bind:season {episodes} {next} {qs} /></Safe>
        {:else if shown === 'more'}
          <Safe name="more" key={item.id}><MoreLikeThis items={more} /></Safe>
        {:else if shown === 'extras'}
          <h2 class="sr-only">{$t('detail.view.extras')}</h2>
          <Safe name="extras" key={item.id}><Extras items={extras} {qs} /></Safe>
        {:else if shown === 'details'}
          <Safe name="cast" key={item.id}><CastRow id={item.id} {people} /></Safe>
          {#if langs}<p class="langs">{langs}</p>{/if}
          <Safe name="details" key={item.id}><DetailsTab {item} {people} {facts} {about} download={item.type !== 'Series'} on:rated={(e) => onRated(e.detail.average)} /></Safe>
          {#if about?.collection && item.type === 'Movie'}<Safe name="collection" key={item.id}><CollectionRow collection={about.collection} canRequest={about.canRequest} variant="page" /></Safe>{/if}
          {#if social}<Safe name="friends" key={item.id}><FriendsStrip id={item.id} /></Safe>{/if}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .dd { --ink: 16, 20, 24; --gutter: max(32px, 4vw); position: relative; z-index: 0; isolation: isolate; min-height: 100vh; color: #fff; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }

  /* ---- backdrop: fixed to the viewport, the page scrolls over it ---- */
  .bd { position: fixed; inset: 0; z-index: -1; overflow: hidden; background: var(--bg); pointer-events: none; }
  .bg, .hv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: right 22%; }
  .bg { opacity: 0; transition: opacity 240ms ease-out; }
  .bg.loaded { opacity: 1; }
  .hv { opacity: 0; transition: opacity 900ms ease-out; background: transparent; }
  .hv.on { opacity: 1; }
  /* left fade (0 → 70 %), bottom fade into the page colour, a light top shade for the pill bar */
  .shade { position: absolute; inset: 0; background:
      linear-gradient(to right, rgba(var(--ink), .95) 0, rgba(var(--ink), .78) 26%, rgba(var(--ink), .32) 50%, rgba(var(--ink), 0) 70%),
      linear-gradient(to top, var(--bg) 0, rgba(var(--ink), .7) 14%, rgba(var(--ink), 0) 42%),
      linear-gradient(to bottom, rgba(var(--ink), .55) 0, rgba(var(--ink), 0) 160px); }
  .dim { position: absolute; inset: 0; background: var(--bg); opacity: 0; will-change: opacity; }

  /* ---- first screen: back link under the bar, the left column sits on the lower part ---- */
  .stage { position: relative; min-height: max(560px, 84vh); display: flex; flex-direction: column; padding: 88px var(--gutter) 40px; box-sizing: border-box; }
  .dback { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; height: 36px; padding: 0 12px 0 6px; margin-left: -6px; border-radius: 18px; color: rgba(255, 255, 255, .86); font-size: 15px; font-weight: 600; text-decoration: none; transition: background-color 160ms ease-out; }
  .dback:hover { background: rgba(255, 255, 255, .1); color: #fff; }
  /* the glass info panel (glass spec §4): one frost surface over the backdrop, as wide as the column was; .frost-safe until
     the backdrop's tone is known (inline toneVars win); its sheen sits in a clip layer (the panel does not clip its content) */
  .col { margin-top: auto; width: 42vw; min-width: 440px; max-width: 720px; box-sizing: border-box; padding: 28px; border-radius: var(--fr-r-sheet); }
  .pclip { position: absolute; inset: 0; z-index: 1; border-radius: inherit; overflow: hidden; pointer-events: none; }
  .top { position: relative; }
  .eyebrow { margin: 0 0 12px; color: var(--acc); font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; line-height: 16px; }
  .title { margin: 0 0 16px; font-size: min(4.5vw, 80px); font-weight: 900; letter-spacing: -.035em; line-height: .98; text-wrap: balance; overflow-wrap: anywhere; }
  .title.haslogo { line-height: 0; }
  .tlogo { display: block; max-width: min(100%, 480px); max-height: clamp(88px, 18vh, 168px); object-fit: contain; object-position: left bottom; }
  .facts { margin: 0 0 16px; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 16px; font-weight: 500; line-height: 24px; color: rgba(255, 255, 255, .86); font-variant-numeric: tabular-nums; }
  .match { color: var(--ok); font-weight: 700; }
  .age { border: 1px solid rgba(255, 255, 255, .55); border-radius: 4px; padding: 0 6px; font-size: 13px; line-height: 20px; }
  .meta :global(.qc) { margin: 0; gap: 6px; }
  .meta :global(.qc li) { font-size: 12px; line-height: 20px; padding: 0 6px; border-color: rgba(255, 255, 255, .55); border-radius: 4px; }
  .until { font-size: 14px; color: rgba(255, 255, 255, .7); }
  .lead { margin-top: 8px; display: flow-root; }
  .lead :global(.rl) { margin: 0; }
  .tagline { margin: 4px 0 0; font-style: italic; color: rgba(255, 255, 255, .78); line-height: 1.45; }
  .synbox { margin: 0 0 24px; max-width: 36rem; }
  .syn { margin: 0; font-size: 17px; line-height: 1.5; color: rgba(255, 255, 255, .92); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden; }
  .syn.open { display: block; -webkit-line-clamp: unset; line-clamp: none; }
  .lnk { margin-top: 4px; min-height: 32px; padding: 0; background: none; border: 0; color: #fff; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
  .lnk:hover:not(:disabled) { background: none; text-decoration: underline; }

  /* ---- actions: Play (white) and a row of round buttons ---- */
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  /* Play: a solid white pill; the round buttons are 44 px glass circles (.frost-btn.round, with the sheen) */
  .play { display: inline-flex; align-items: center; gap: 10px; height: 48px; padding: 0 28px 0 22px; border-radius: 999px; background: #fff; color: #000; font-size: 18px; font-weight: 700; text-decoration: none; white-space: nowrap; font-variant-numeric: tabular-nums; transition: transform var(--t-fast), opacity var(--t-fast); }
  .play:hover { background: #fff; opacity: .88; }
  .rb { flex: none; color: #fff; text-decoration: none; }
  .rb.on { border-color: #fff; }
  .rb :global(svg) { pointer-events: none; }
  /* the shared round controls (rating, more) as the same glass circles (.frost-btn's look and its solid fallback) */
  .acts :global(.rb .trig), .acts :global(.ma.ring) {
    background: linear-gradient(180deg, rgba(var(--fr-milk-top), var(--fr-milk-a2)), rgba(var(--fr-milk), var(--fr-milk-a1))), rgba(var(--fr-scrim-rgb), var(--fr-scrim));
    border: 1px solid var(--fr-line); box-shadow: inset 0 1px 0 var(--fr-hi);
  }
  .acts :global(.rb .trig:hover:not(:disabled)), .acts :global(.ma.ring:hover), .acts :global(.ma.ring.on) {
    background: linear-gradient(180deg, rgba(var(--fr-milk-top), var(--fr-milk-a2)), rgba(var(--fr-milk), var(--fr-milk-a1))), rgba(var(--fr-scrim-rgb), var(--fr-scrim));
    border-color: rgba(255, 255, 255, .42); box-shadow: inset 0 1px 0 var(--fr-hi), inset 0 0 0 1px rgba(255, 255, 255, .14);
  }
  :global(html:not(.m-glass)) .acts :global(.rb .trig), :global(html:not(.m-glass)) .acts :global(.ma.ring) { background: var(--fr-solid); }
  :global(html:not(.m-glass)) .acts :global(.rb .trig:hover:not(:disabled)), :global(html:not(.m-glass)) .acts :global(.ma.ring:hover) { background: var(--fr-solid-hover); }
  .play:focus-visible, .rb:focus-visible, .dback:focus-visible, .lnk:focus-visible, .tab:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
  .mslot { display: grid; gap: .6rem; padding: .3rem .4rem .4rem; }
  .mslot :global(.status), .mslot :global(.lang) { margin: 0; }
  .resume { display: flex; align-items: center; gap: 12px; margin: 16px 0 0; font-size: 14px; font-weight: 600; color: rgba(255, 255, 255, .86); font-variant-numeric: tabular-nums; }
  .bar { position: relative; flex: none; width: 120px; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .25); overflow: hidden; }
  .bar span { position: absolute; inset: 0; background: var(--acc); transform-origin: left center; }

  /* auto start countdown: bottom right of the first screen */
  .auto { position: absolute; right: var(--gutter); bottom: 40px; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 12px; font-weight: 600; }
  .auto svg { width: 30px; height: 30px; transform: rotate(-90deg); }
  .auto circle { fill: none; stroke-width: 3.5; }
  .auto .tr { stroke: rgba(255, 255, 255, .25); }
  .auto .pr { stroke: #fff; stroke-dasharray: 94.25; transition: stroke-dashoffset 1s linear; }
  .auto .sec { min-height: 40px; padding: 4px 16px; font-size: 15px; }

  /* ---- tabs: a glass segment bar; the selected tab sits on a sliding white pill (SlidePill, glass spec §8.4) ---- */
  .lower { position: relative; padding: 0 var(--gutter) 80px; }
  .tabbar { margin-bottom: 24px; }
  .tabs { display: inline-flex; max-width: 100%; box-sizing: border-box; gap: 4px; padding: 6px; overflow-x: auto; scrollbar-width: none; vertical-align: top; }
  .tabs::-webkit-scrollbar { display: none; }
  /* 40 px tall in a 52 px bar; the hit area is 44 px (::after) */
  .tab { position: relative; z-index: 1; flex: none; height: 40px; min-height: 40px; padding: 0 18px; background: transparent; border: 0; border-radius: 999px; color: rgba(255, 255, 255, .72); font-size: 15px; font-weight: 700; white-space: nowrap; }
  .tab::after { content: ''; position: absolute; inset: -2px; border-radius: inherit; }
  .tab:hover:not(:disabled) { background: transparent; color: #fff; }
  .tab.on, .tab.on:hover:not(:disabled) { color: #111; }
  /* the label colour follows the pill in 250 ms (the named exception), with full motion only */
  :global(html.m-glass:not(.tv):not(.kids)) .tab { transition: color 250ms var(--fr-out); }
  .tabsk { height: 54px; }
  .tpanel { outline: none; }
  .langs { margin: 0; color: var(--mut); font-size: 14px; }
  .tpanel :global(.cast) { margin-top: 0; }
  .tpanel > :global(* + *) { margin-top: 32px; }

  @media (prefers-reduced-motion: reduce) {
    .bg, .hv, .auto .pr { transition: none; }
  }
</style>
