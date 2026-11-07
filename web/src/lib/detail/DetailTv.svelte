<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { backdrop, logoUrl, srcset, HERO_WIDTHS, type Item } from '#lib/api';
  import { t } from '#lib/i18n';
  import { badges, loadStory, wantBadge, type Facts } from '#lib/fresh';
  import { motionAllowed, previewFailed, toggleSound } from '#lib/preview';
  import { playPrefetch } from '#lib/player/prefetch';
  import type { Thumb } from '#lib/rating';
  import type { About } from '#lib/detail/about';
  import type { Person } from '#lib/detail/format';
  import { tvDetailButtons, type TvButtonId } from '#lib/detail/tvButtons';
  import { tileInfo } from '#lib/tv/focusTile';
  import { animateTo, decodeFade, EMPH_OUT, motionLevel, stagger } from '#lib/tv/motion';
  import Icon from '#lib/Icon.svelte';
  import QualityChips from '#lib/QualityChips.svelte';
  import RatingButton from '#lib/RatingButton.svelte';
  import LangPick from '#lib/LangPick.svelte';

  /**
   * TV detail page (spec section 3): no scrolling. A full-screen backdrop fading to the left (the trailer preview plays in it),
   * the title block in a left column and one vertical button list under it. The list is a window that glides (spring) when the
   * focus walks past its edge. Everything here comes from DetailView (same loads); only the "story so far" check is local.
   */
  export let item: Item;
  export let about: About | null | undefined = undefined;
  export let facts: Facts | null = null;
  export let people: Person[] = [];
  export let extras: Array<Item & { kind?: 'trailer' | 'extra' }> = [];
  /** what Play starts (a series: its next episode) and the links DetailView built for it */
  export let playTarget = '';
  export let playBase = '';
  export let playHref = '';
  export let playLabel = '';
  /** audio / subtitle choice as a query string for the player links */
  export let qs = '';
  /** the title Play resumes (a series: its next episode) */
  export let resumeFrom: Item | null = null;
  export let resumeLine = '';
  export let tagline = '';
  export let overview = '';
  export let inList = false;
  export let titleId = 'detail-title';
  export let thumb: Thumb = 0;
  export let audio = '';
  export let sub = '';
  /** the backdrop trailer (DetailView owns the preview: playPreview into `video`) */
  export let playing = false;
  export let loop = true;
  export let video: HTMLVideoElement | undefined = undefined;
  export let loaded = false;
  export let onMyList: () => void = () => {};
  export let onTrailer: () => void = () => {};
  export let onThumb: (e: CustomEvent<{ value: Thumb }>) => void = () => {};
  export let onEnded: () => void = () => {};
  /** false while the play target is still loading (a series: seasons + next-up); the list waits, so Play is the first focus */
  export let ready = true;

  // ---- text model (the same meta line as the focus tile) ----
  $: badgeId = item.type === 'Episode' ? item.seriesId : item.id;
  $: wantBadge(badgeId);
  $: info = tileInfo(item, $t, $badges[badgeId ?? ''], Date.now());
  $: eyebrow = info.labels.join(' · ');
  $: actors = people.filter((p) => p.type === 'Actor' && p.name).slice(0, 3).map((p) => p.name);
  $: pct = resumeFrom?.positionTicks && resumeFrom.runtimeTicks ? Math.min(100, Math.max(2, (resumeFrom.positionTicks / resumeFrom.runtimeTicks) * 100)) : 0;
  let logoFailed: Record<string, boolean> = {};

  // ---- "story so far" (series): the button only when there is one to show ----
  let story = false, storySeq = 0;
  $: checkStory(item.id, item.type);
  function checkStory(id: string, type: string) {
    const my = ++storySeq;
    story = false;
    if (type !== 'Series') return;
    loadStory(id).then((s) => { if (my === storySeq) story = !!s; }).catch(() => undefined);
  }

  // ---- the button list ----
  $: localTrailer = extras.find((x) => x.kind === 'trailer') ?? null;
  $: hasProgress = Boolean(resumeFrom?.positionTicks);
  $: ids = tvDetailButtons({
    type: item.type, hasProgress, hasPlayTarget: Boolean(playBase),
    hasTrailer: Boolean(localTrailer) || ((item.trailers ?? 0) > 0 && !previewFailed(item.id)),
    hasCollection: Boolean(about?.collection) && item.type === 'Movie',
    hasExtras: extras.length > (localTrailer ? 1 : 0),
    hasStory: story,
  });
  const withQs = (base: string, extra = '') => { const q = [extra, qs].filter(Boolean).join('&'); return q ? `${base}?${q}` : base; };
  $: restartHref = playBase ? withQs(playBase, 't=0') : '';
  const sub_ = (s: string) => `/item/${item.id}/${s}`;
  const LINKS: Partial<Record<TvButtonId, { sub: string; icon: string }>> = {
    episodes: { sub: 'episodes', icon: 'list' }, more: { sub: 'more', icon: 'grid' }, collection: { sub: 'collection', icon: 'bookmark' },
    extras: { sub: 'extras', icon: 'star' }, story: { sub: 'story', icon: 'clock' }, info: { sub: 'info', icon: 'info' },
  };
  const label = (id: TvButtonId): string => ({
    episodes: $t('tv.detail.episodes'), more: $t('detail.more.title'), collection: $t('tv.detail.collection'), extras: $t('hubs.extras.tab'),
    story: $t('fresh.story.title'), info: $t('home.hero.moreInfo'),
  } as Partial<Record<TvButtonId, string>>)[id] ?? '';

  // ---- the list window: shows as many buttons as fit; a focus near its edge glides the list (spring, transform only) ----
  let win: HTMLDivElement | undefined, strip: HTMLDivElement | undefined, shift = 0, above = false, below = false;
  function follow(e: FocusEvent) {
    if (!win || !strip) return;
    const li = (e.target as HTMLElement).closest<HTMLElement>('.it');
    if (!li || li.parentElement !== strip) return;
    const view = inner(win), total = strip.offsetHeight, top = li.offsetTop, h = li.offsetHeight;
    const peek = h * 0.6; // the next / previous button stays partly in view, so the list says there is more
    let s = shift;
    if (top - peek < s) s = top - peek;
    else if (top + h + peek > s + view) s = top + h + peek - view;
    s = Math.max(0, Math.min(Math.max(0, total - view), s));
    edges(s, view, total);
    if (Math.abs(s - shift) < 1) return;
    shift = s;
    animateTo(strip, 'y', -s);
  }
  /** the window's content height (its padding is room for the focus scale, not for buttons) */
  function inner(el: HTMLElement) { const cs = getComputedStyle(el); return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0); }
  function edges(s = shift, view = win ? inner(win) : 0, total = strip?.offsetHeight ?? 0) { above = s > 1; below = s + view < total - 1; }
  // the list grows while the optional parts load (trailer, collection, story): re-check the edge fades
  $: if (ids && win) void tick().then(() => edges());

  // ---- entry (spec 5.2): the backdrop settles in (scale 1.04 -> 1, 480 ms); text and buttons stagger in, 30 ms apart ----
  let col: HTMLDivElement | undefined, entered = '', listed = '', textEnd = 0;
  $: if (col && item.id !== entered) enter(item.id);
  function enter(id: string) {
    entered = id;
    void tick().then(() => {
      if (!col || entered !== id) return;
      const parts = [...col.querySelectorAll<HTMLElement>('.info [data-st]')];
      textEnd = performance.now() + parts.length * 30;
      stagger(parts, { gap: 30 });
    });
  }
  // the button list follows the text (it may arrive later: a series waits for its next episode)
  $: if (strip && item.id !== listed) enterList(item.id);
  function enterList(id: string) {
    listed = id;
    shift = 0;
    if (strip) animateTo(strip, 'y', 0);
    void tick().then(() => { if (strip && listed === id) stagger([...strip.querySelectorAll<HTMLElement>(':scope > [data-st]')], { gap: 30, delay: Math.max(0, textEnd - performance.now()) }); });
  }
  /** Svelte action on the backdrop image: the settle once it is there (reduced set: a plain 150 ms fade; calm: nothing) */
  function settle(img: HTMLImageElement) {
    const run = () => {
      if (!motionAllowed() || typeof img.animate !== 'function') return;
      if (motionLevel() === 'reduced') img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
      else img.animate([{ transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 480, easing: EMPH_OUT });
    };
    if (img.complete && img.naturalWidth > 0) run(); else img.addEventListener('load', run, { once: true });
    return { destroy: () => img.removeEventListener('load', run) };
  }

  // ---- trailer in the backdrop: the still fades out (600 ms) only once the first frame is there ----
  let framed = false, muted = true;
  function onFrame() {
    if (!video || framed) return;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => { if (playing) framed = true; });
    else if (playing) framed = true;
  }
  function clearVideo() { framed = false; if (!video || !video.getAttribute('src')) return; video.pause(); video.removeAttribute('src'); video.load(); }
  $: if (!playing) clearVideo();
  onDestroy(clearVideo);

  onMount(() => edges());
</script>

<div class="tvd">
  <!-- data-vt-art: the card / tile artwork morphs into this box (View Transition name set by html.ff-vt-art, see app.css) -->
  <div class="hero" data-vt-art="">
    {#if item.backdrop}
      {#key item.id}
        <img class="bg" data-play-art src={backdrop(item.id, 1280)} srcset={srcset('Backdrop', item.id, HERO_WIDTHS)} sizes="72vw" alt="" fetchpriority="high"
          use:decodeFade use:settle on:load={() => (loaded = true)} />
      {/key}
    {/if}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="vid" class:on={playing && framed} bind:this={video} {loop} playsinline aria-hidden="true" tabindex="-1"
      on:playing={onFrame} on:loadeddata={onFrame} on:ended={onEnded} on:volumechange={() => (muted = !!video?.muted)}></video>
    <div class="shade"></div>
  </div>

  <div class="col" bind:this={col}>
    <div class="info">
      {#if eyebrow}<p class="tv-eyebrow eb" data-st>{eyebrow}</p>{/if}
      <h1 id={titleId} class="tv-display" class:sr-only={item.logo && !logoFailed[item.id]} data-st={item.logo && !logoFailed[item.id] ? undefined : ''}>{item.name}</h1>
      {#if item.logo && !logoFailed[item.id]}
        {@const lid = item.id}
        <img class="logo" data-st src={logoUrl(lid)} alt="" on:error={() => (logoFailed = { ...logoFailed, [lid]: true })} />
      {/if}
      {#if info.meta.length || facts?.traits}
        <div class="meta" data-st>
          <p class="tv-meta line">{#each info.meta as m, i}{#if i}<span class="sep" aria-hidden="true">·</span>{/if}<span class:age={!!item.rating && m === item.rating}>{m}</span>{/each}</p>
          <QualityChips traits={facts?.traits} />
        </div>
      {/if}
      {#if tagline}<p class="tag" data-st>{tagline}</p>{/if}
      {#if overview}<p class="tv-body ov" data-st>{overview}</p>{/if}
      {#if actors.length}<p class="tv-meta with" data-st>{$t('tv.detail.with', { names: actors.join(', ') })}</p>{/if}
      {#if resumeLine}
        <p class="tv-meta resume" data-st>{#if pct}<span class="bar" aria-hidden="true"><span style="transform:scaleX({pct / 100})"></span></span>{/if}<span>{resumeLine}</span></p>
      {/if}
    </div>

    {#if !ready}
      <div class="win" aria-hidden="true"><div class="btns">{#each [0, 1, 2] as k (k)}<div class="skeleton ph"></div>{/each}</div></div>
    {:else}
    <div class="win" class:above class:below bind:this={win}>
      <div class="btns" role="group" aria-label={$t('tv.detail.actions')} bind:this={strip} on:focusin={follow}>
        {#each ids as id, i (id)}
          <div class="it" data-st>
            {#if id === 'play'}
              <a class="tv-btn play" data-autofocus={i === 0 ? '' : undefined} href={playHref} use:playPrefetch><Icon name="play" size={28} />{playLabel}</a>
            {:else if id === 'restart'}
              <a class="tv-btn" href={restartHref} use:playPrefetch><Icon name="refresh" size={28} />{$t('tv.detail.restart')}</a>
            {:else if id === 'trailer'}
              {#if localTrailer}
                <a class="tv-btn" href={withQs(`/watch/${localTrailer.id}`)}><Icon name="film" size={28} />{$t('home.trailer.button')}</a>
              {:else}
                <button type="button" class="tv-btn" on:click={onTrailer}><Icon name="film" size={28} />{$t('home.trailer.button')}</button>
              {/if}
            {:else if id === 'mylist'}
              <button type="button" class="tv-btn" class:on={inList} aria-pressed={inList} on:click={onMyList}><Icon name={inList ? 'check' : 'plus'} size={28} />{$t('detail.view.myList')}</button>
            {:else if id === 'rate'}
              <RatingButton tv itemId={item.id} bind:value={thumb} size={56} on:change={onThumb} />
            {:else if id === 'langs'}
              <LangPick tv targetId={playTarget} storeKey={item.id} bind:audio bind:sub />
            {:else if LINKS[id]}
              {@const l = LINKS[id]!}
              <a class="tv-btn" data-autofocus={i === 0 ? '' : undefined} href={sub_(l.sub)}><Icon name={l.icon} size={28} />{label(id)}</a>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    {/if}
  </div>

  {#if playing && framed}
    <button type="button" class="tv-btn snd" aria-label={muted ? $t('detail.view.soundOn') : $t('detail.view.soundOff')} aria-pressed={!muted} on:click={() => toggleSound(video)}><Icon name={muted ? 'volume-off' : 'volume'} size={28} /></button>
  {/if}
</div>

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
  /* one screen, never a scroll container (overflow: clip), so spatial navigation's scrollIntoView finds nothing to move */
  .tvd { position: relative; height: 100vh; overflow: clip; background: var(--bg); color: #fff; }

  /* backdrop (spec 5.1): 72 vw, anchored right/top; the fades live on the same box, so there is no seam at the image edge */
  .hero { position: absolute; top: 0; right: 0; width: 72vw; height: 100%; overflow: hidden; pointer-events: none; }
  .bg, .vid { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; }
  .bg { display: block; transform-origin: 60% 40%; }
  .vid { opacity: 0; background: transparent; transition: opacity calc(var(--tv-fade) * .7) ease-in; }
  .vid.on { opacity: 1; transition: opacity 600ms ease-out; }
  .shade { position: absolute; inset: 0; background:
    linear-gradient(180deg, rgba(0, 0, 0, .35) 0%, rgba(0, 0, 0, 0) 20%),
    linear-gradient(0deg, #000 0%, rgba(0, 0, 0, .6) 22%, rgba(0, 0, 0, 0) 48%),
    linear-gradient(90deg, #000 0%, #000 18%, rgba(0, 0, 0, .82) 34%, rgba(0, 0, 0, .35) 58%, rgba(0, 0, 0, 0) 78%); }

  /* left column (~40 %): the title block on top, the button list fills the rest down to the 5 vh safe area */
  .col { position: absolute; z-index: 1; top: 0; bottom: 0; left: var(--tv-gutter); width: 40vw; display: flex; flex-direction: column; padding: 9vh 0 5vh; box-sizing: border-box; }
  .info { flex: none; display: flex; flex-direction: column; align-items: flex-start; }
  .eb { margin: 0 0 .75rem; }
  .logo { display: block; max-width: min(32.5rem, 100%); max-height: 10rem; object-fit: contain; object-position: left bottom; }
  .meta { margin: 1rem 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .9rem; }
  .line { margin: 0; display: flex; flex-wrap: wrap; align-items: center; }
  .sep { margin: 0 .625rem; color: var(--tv-sep); }
  .age { padding: .05rem .4rem; border: 1px solid rgba(255, 255, 255, .45); border-radius: 3px; font-size: .9em; line-height: 1.2; }
  /* quality chips: the same quiet outlined boxes as the age rating */
  .meta :global(.qc) { margin: 0; gap: .4rem; }
  .meta :global(.qc li) { font-size: 1rem; font-weight: 600; line-height: 1.5; padding: 0 .45rem; color: var(--mut); border-color: rgba(255, 255, 255, .35); }
  .tag { margin: .9rem 0 0; font-size: 1.375rem; font-weight: 500; line-height: 1.35; color: var(--tv-white-88); max-width: 46ch; }
  .ov { margin: .75rem 0 0; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .with { margin: .75rem 0 0; max-width: 46ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(html.tv) .resume { margin: .75rem 0 0; display: flex; align-items: center; gap: .9rem; color: var(--tv-white-88); }
  .bar { position: relative; flex: none; width: 7.5rem; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, .22); overflow: hidden; }
  .bar span { position: absolute; inset: 0; background: var(--acc); transform-origin: left center; border-radius: 2px; }

  /* the button list window: clips vertically only (the focused button may grow sideways), soft fades where more buttons wait */
  .win { flex: 1 1 auto; min-height: 0; margin: 2rem -1.5rem 0; padding: .75rem 1.5rem; overflow-x: visible; overflow-y: clip; }
  .win.below { -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 4.5rem), transparent); mask-image: linear-gradient(180deg, #000 calc(100% - 4.5rem), transparent); }
  .win.above { -webkit-mask-image: linear-gradient(0deg, #000 calc(100% - 4.5rem), transparent); mask-image: linear-gradient(0deg, #000 calc(100% - 4.5rem), transparent); }
  .win.above.below { -webkit-mask-image: linear-gradient(180deg, transparent, #000 4.5rem, #000 calc(100% - 4.5rem), transparent); mask-image: linear-gradient(180deg, transparent, #000 4.5rem, #000 calc(100% - 4.5rem), transparent); }
  /* one column, as wide as the longest label (at least 22 rem); every row is a 56 px .tv-btn */
  .btns { position: relative; display: flex; flex-direction: column; gap: .75rem; width: max-content; min-width: 22rem; max-width: 100%; }
  .it { position: relative; display: flex; }
  .ph { height: 3.5rem; }
  .it > :global(*) { flex: 1 1 auto; }
  .btns :global(.tv-btn) { justify-content: flex-start; transform-origin: left center; white-space: nowrap; }
  .btns > .it > :global(a.tv-btn), .btns > .it > :global(button.tv-btn) { width: 100%; }
  /* the one primary action: a stronger rest fill and a heavier label; focus is the same white fill as every button */
  :global(html.tv) .btns .play:not(:focus-visible) { background: rgba(255, 255, 255, .28); }
  .play { font-weight: 700; }
  .btns .on :global(svg) { color: var(--acc); }
  .btns .on:focus-visible :global(svg) { color: inherit; }

  :global(html.tv) .snd { position: absolute; z-index: 2; right: var(--tv-safe-x); bottom: var(--tv-safe-y); width: 3.5rem; padding: 0; justify-content: center; animation: tvd-in var(--tv-d-s) ease-out; }
  @keyframes tvd-in { from { opacity: 0; } }
</style>
