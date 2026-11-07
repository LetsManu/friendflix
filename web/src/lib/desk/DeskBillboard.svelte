<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { backdrop, HERO_WIDTHS, primeItem, srcset, logoUrl, type Item } from '#lib/api';
  import { cardTag } from '#lib/badges';
  import { native } from '#lib/native/bridge';
  import { playOrCast } from '#lib/cast/playOrCast';
  import { badges, wantBadge } from '#lib/fresh';
  import { fmtDuration, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { openModal } from '#lib/modal';
  import { pageStore } from '#lib/page';
  import { playPrefetch } from '#lib/player/prefetch';
  import { autoplayAllowed, billboardHeld, playPreview, previewOwner, stopPreview, toggleSound } from '#lib/preview';
  import { previewSheet } from '#lib/previewSheet';
  import { prefs } from '#lib/stores';

  /**
   * Desktop billboard (spec desktop browse §2): the recommendation engine's hero title over a right-anchored backdrop. After 1.5 s
   * the muted trailer fades in and the synopsis steps back to one line. Same preview rules as the phone/old hero (#lib/preview):
   * one preview owner at a time, held while an overlay covers it, paused out of view and in a hidden tab.
   */
  export let item: Item | null;
  /** position in the top 10 by rating (1-10), 0 = none */
  export let rank = 0;

  /** the trailer starts this long after the backdrop is on screen */
  const TRAILER_MS = 1500;
  /** once the trailer runs, the synopsis collapses after this beat (the picture changes first, then the text) */
  const QUIET_MS = 700;

  const page = pageStore();
  let section: HTMLElement | undefined, hv: HTMLVideoElement;
  let loaded = false, bgFailed = false, logoFailed = false;
  let playing = false, vmuted = true, ended = false, quiet = false, inView = true, paused = false, interrupted = false;
  let timer: ReturnType<typeof setTimeout> | undefined, quietT: ReturnType<typeof setTimeout> | undefined, scheduledFor = '';
  let fullH = 0, oneH = 0;

  $: owner = item ? 'hero:' + item.id : '';
  // a new title (not a refreshed copy of the same one, whose image is already on screen) starts from a clean slate
  let shownId = '';
  $: if ((item?.id ?? '') !== shownId) { shownId = item?.id ?? ''; logoFailed = false; bgFailed = false; loaded = false; }
  $: showBg = Boolean(item?.backdrop) && !bgFailed;
  /** a title without a usable backdrop has nothing to wait for */
  $: ready = loaded || (item !== null && !showBg);
  /** something covers the billboard: the quick-view modal (shallow route), the preview sheet, any overlay holding it */
  $: covered = Boolean(($page.state as { modalId?: string } | undefined)?.modalId) || $previewSheet !== null || $billboardHeld;
  $: hold = covered || !inView;
  $: if (item && ready && item.id !== scheduledFor) schedule(item.id);
  // a hover card took over (or the preview failed)
  $: if (playing && $previewOwner !== owner) { playing = false; quiet = false; clearTimeout(quietT); interrupted = $previewOwner !== ''; if (hv && !hv.paused) hv.pause(); }
  // the hover preview is over: the billboard trailer comes back (from the start)
  $: if (interrupted && $previewOwner === '' && item) { interrupted = false; const id = item.id; clearTimeout(timer); timer = setTimeout(() => void start(id), TRAILER_MS); }
  $: syncHold(hold);

  function eligible() {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    return $prefs.hoverTrailers && autoplayAllowed() && !document.hidden && !document.documentElement.classList.contains('tv') && !nav.connection?.saveData;
  }
  function schedule(id: string) {
    scheduledFor = id;
    stop();
    ended = false;
    timer = setTimeout(() => void start(id), TRAILER_MS);
  }
  async function start(id: string) {
    if (!item || item.id !== id || !eligible() || $previewOwner) return; // never while another preview runs
    if (hold) { paused = true; return; } // starts when the overlay closes / the billboard is back in view
    playing = true; ended = false; // the <video> always exists, this only fades it in
    const ok = await playPreview(id, () => hv, 'hero:' + id);
    if (!ok) { playing = false; return; }
    if (hold && hv && !hv.paused) { hv.pause(); paused = true; }
    clearTimeout(quietT);
    quietT = setTimeout(() => { if (playing) quiet = true; }, QUIET_MS);
  }
  function syncHold(h: boolean) {
    if (typeof window === 'undefined') return;
    if (h) {
      if (playing && hv && !hv.paused) { hv.pause(); paused = true; }
    } else if (paused) {
      paused = false;
      if (playing && hv) void hv.play().catch(() => undefined);
      else if (item && !ended && !playing) { const id = item.id; clearTimeout(timer); timer = setTimeout(() => void start(id), 600); }
    }
  }
  function stop() { clearTimeout(timer); clearTimeout(quietT); if (owner) stopPreview(owner); playing = false; quiet = false; paused = false; }
  function onEnded() { stop(); ended = true; } // trailer over: back to the still, replay button
  function replay() { if (!item) return; ended = false; scheduledFor = item.id; void start(item.id); }
  function onVisibility() { if (document.hidden) { if (playing && hv && !hv.paused) { hv.pause(); paused = true; } } else syncHold(hold); }

  let io: IntersectionObserver | undefined;
  $: if (section && typeof IntersectionObserver !== 'undefined' && !io) {
    io = new IntersectionObserver((es) => { const e = es[es.length - 1]; if (e) inView = e.intersectionRatio > 0.45; }, { threshold: [0, 0.45, 0.6] });
    io.observe(section);
  }
  onMount(() => document.addEventListener('visibilitychange', onVisibility));
  onDestroy(() => { if (typeof window === 'undefined') return; io?.disconnect(); document.removeEventListener('visibilitychange', onVisibility); stop(); });

  // ---- text ----
  $: badgeId = item ? (item.type === 'Episode' ? item.seriesId : item.id) : undefined;
  $: wantBadge(badgeId);
  $: tag = item ? cardTag($badges[badgeId ?? ''], item, Date.now()) : null;
  $: eyebrow = tag ? $t(tag.key, tag.kind === 'leaving' ? { n: tag.n } : undefined) : '';
  $: length = !item ? '' : item.type === 'Series' ? (item.childCount ? $t('home.meta.seasons', { n: item.childCount }) : '') : item.runtimeTicks ? fmtDuration(item.runtimeTicks / 10_000_000) : '';
  $: resumable = Boolean(item && item.type !== 'Series' && item.positionTicks > 0);
  $: playText = $t(resumable ? 'home.card.resume' : 'home.card.play');
  $: playHref = item ? (item.type === 'Series' ? `/item/${item.id}` : `/watch/${item.id}`) : '';
  /** a movie plays in the app's native player (or on a connected TV); a series link goes to its page */
  function play(e: MouseEvent) { if (native.available && item && item.type !== 'Series' && item.type !== 'BoxSet') playOrCast(e, item); }
  /** the full detail page (openModal navigates on desktop; the page renders from the primed card data at once) */
  function more(e: MouseEvent) { if (!item) return; primeItem(item); openModal(e, `/item/${item.id}`); }
</script>

<section class="billboard" class:quiet data-play-scope bind:this={section} aria-label={$t('home.hero.label')} style="--drop: {Math.max(0, fullH - oneH)}px">
  {#if item}
    <div class="art" data-vt-art>
      {#if showBg}<img class="bg" data-play-art class:loaded src={backdrop(item.id, 1280)} srcset={srcset('Backdrop', item.id, HERO_WIDTHS)} sizes="100vw" alt="" fetchpriority="high" on:load={() => (loaded = true)} on:error={() => (bgFailed = true)} />{/if}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={hv} class="hv" class:on={playing} playsinline aria-hidden="true" tabindex="-1" on:ended={onEnded} on:volumechange={() => (vmuted = hv.muted)} on:playing={() => (vmuted = hv.muted)}></video>
    </div>
    <div class="shade" aria-hidden="true"></div>
    <div class="content">
      <div class="head">
        {#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
        {#if item.logo && !logoFailed}
          <h1 class="logoh"><img class="tlogo" src={logoUrl(item.id)} alt={item.name} on:error={() => (logoFailed = true)} /></h1>
        {:else}<h1 class="name">{item.name}</h1>{/if}
        <p class="meta">
          {#if item.year}<span>{item.year}</span>{/if}
          {#if item.rating}{#if item.year}<span class="sep" aria-hidden="true"></span>{/if}<span class="age" aria-label={$t('home.card.ageRating', { rating: item.rating })}>{item.rating}</span>{/if}
          {#if length}{#if item.year || item.rating}<span class="sep" aria-hidden="true"></span>{/if}<span>{length}</span>{/if}
          {#if item.genres[0]}{#if item.year || item.rating || length}<span class="sep" aria-hidden="true"></span>{/if}<span>{item.genres[0]}</span>{/if}
        </p>
        {#if rank > 0}<p class="rank"><span class="no">#{rank}</span>{$t('home.hero.rankTop10')}</p>{/if}
      </div>
      {#if item.overview}
        <div class="synbox">
          <p class="syn full" bind:clientHeight={fullH} aria-hidden={quiet}>{item.overview}</p>
          <p class="syn one" bind:clientHeight={oneH} aria-hidden={!quiet}>{item.overview}</p>
        </div>
      {/if}
      <div class="btns">
        <a class="b play" data-autofocus href={playHref} use:playPrefetch on:click={play}><Icon name="play" size={24} />{playText}</a>
        <a class="b info" href="/item/{item.id}" on:click={more}><Icon name="info" size={24} />{$t('home.hero.moreInfo')}</a>
      </div>
    </div>
    <div class="side">
      {#if playing}
        <button type="button" class="snd" aria-label={vmuted ? $t('home.card.soundOn') : $t('home.card.soundOff')} aria-pressed={!vmuted} on:click={() => toggleSound(hv)}><Icon name={vmuted ? 'volume-off' : 'volume'} size={20} /></button>
      {:else if ended}
        <button type="button" class="snd" aria-label={$t('home.hero.replay')} title={$t('home.hero.replayTitle')} on:click={replay}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 12a8.5 8.5 0 102.6-6.1M3.5 4v4.5H8" /></svg></button>
      {/if}
      {#if item.rating}<span class="agebadge" aria-hidden="true">{item.rating}</span>{/if}
    </div>
  {:else}
    <div class="skeleton fill"></div>
  {/if}
</section>

<style>
  .billboard { --gutter: max(32px, 4vw); --ink: 16, 20, 24; --emph: cubic-bezier(.05, .7, .1, 1); --btn-h: 48px; --foot: max(120px, 22%);
    position: relative; height: max(520px, 80vh); margin-bottom: -48px; overflow: hidden; background: var(--bg); isolation: isolate; }
  .fill { position: absolute; inset: 0; border-radius: 0; }

  /* ---- picture: full bleed, anchored to the right edge ---- */
  .art { position: absolute; inset: 0; z-index: -2; }
  .bg, .hv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: right 22%; }
  .bg { opacity: 0; transition: opacity 240ms ease-out; }
  .bg.loaded { opacity: 1; }
  .hv { opacity: 0; transition: opacity 900ms ease-out; pointer-events: none; background: transparent; }
  .hv.on { opacity: 1; }
  /* left fade (0 → 62 %), bottom fade into the page colour, and a light top shade so the transparent bar stays readable */
  .shade { position: absolute; inset: 0; z-index: -1; pointer-events: none; background:
      linear-gradient(to top, var(--bg) 0, rgba(var(--ink), .78) 12%, rgba(var(--ink), 0) 38%),
      linear-gradient(to right, rgba(var(--ink), .94) 0, rgba(var(--ink), .72) 24%, rgba(var(--ink), .28) 46%, rgba(var(--ink), 0) 62%),
      linear-gradient(to bottom, rgba(var(--ink), .6) 0, rgba(var(--ink), 0) 160px); }

  /* ---- text block ---- */
  .content { position: absolute; left: var(--gutter); bottom: var(--foot); width: min(40vw, 640px); min-width: 420px; }
  .head { transition: transform 640ms var(--emph); }
  .eyebrow { margin: 0 0 12px; color: var(--acc); font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; line-height: 16px; }
  .name { margin: 0 0 16px; font-size: min(4.5vw, 88px); font-weight: 900; letter-spacing: -.035em; line-height: .98; text-wrap: balance; }
  .logoh { margin: 0 0 20px; }
  .tlogo { display: block; max-width: min(100%, 480px); max-height: clamp(88px, 18vh, 168px); object-fit: contain; object-position: left bottom; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 16px; font-size: 16px; font-weight: 500; color: rgba(255, 255, 255, .86); font-variant-numeric: tabular-nums; }
  .sep { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .6; }
  .age { border: 1px solid rgba(255, 255, 255, .55); border-radius: 4px; padding: 0 6px; font-size: 13px; line-height: 20px; }
  .rank { display: flex; align-items: center; gap: 8px; margin: -4px 0 16px; font-size: 16px; font-weight: 600; }
  .no { font-weight: 800; font-variant-numeric: tabular-nums; color: var(--acc); }

  /* synopsis: 3 lines; with the trailer running one line stays, right above the buttons (opacity + translate only) */
  .synbox { position: relative; margin: 0 0 24px; }
  .syn { margin: 0; max-width: 36rem; font-size: 18px; line-height: 1.5; color: rgba(255, 255, 255, .92); display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
  .syn.full { -webkit-line-clamp: 3; line-clamp: 3; transition: opacity 320ms ease-out, transform 640ms var(--emph); }
  .syn.one { position: absolute; left: 0; right: 0; bottom: 0; -webkit-line-clamp: 1; line-clamp: 1; opacity: 0; transform: translateY(8px); transition: opacity 320ms ease-out, transform 640ms var(--emph); }
  .quiet .syn.full { opacity: 0; transform: translateY(-8px); }
  .quiet .syn.one { opacity: 1; transform: none; transition-delay: 120ms; }
  .quiet .head { transform: translateY(var(--drop)); }

  /* ---- buttons ---- */
  .btns { display: flex; gap: 12px; align-items: center; }
  .b { display: inline-flex; align-items: center; gap: 10px; height: var(--btn-h); padding: 0 28px 0 22px; border-radius: 6px; font-size: 18px; font-weight: 600; text-decoration: none; transition: background-color 160ms ease-out; }
  .play { background: #fff; color: #000; }
  .play:hover { background: rgba(255, 255, 255, .78); }
  .info { background: rgba(110, 110, 112, .62); color: #fff; }
  .info:hover { background: rgba(110, 110, 112, .42); }
  .b:focus-visible, .snd:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }

  /* ---- right edge, level with the buttons: mute / replay, then the age strip flush to the screen edge ---- */
  .side { position: absolute; right: 0; bottom: var(--foot); height: var(--btn-h); display: flex; align-items: center; gap: 16px; }
  .snd { width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; background: rgba(var(--ink), .3); border: 1.5px solid rgba(255, 255, 255, .7); color: #fff; }
  .snd:hover:not(:disabled) { background: rgba(255, 255, 255, .12); border-color: #fff; }
  .agebadge { display: inline-flex; align-items: center; height: 36px; padding: 0 calc(var(--gutter) + 8px) 0 12px; border-left: 3px solid rgba(255, 255, 255, .8); background: rgba(51, 51, 51, .6); font-size: 16px; font-weight: 500; }

  @media (prefers-reduced-motion: reduce) {
    .bg, .hv, .head, .syn.full, .syn.one { transition: none; }
  }
</style>
