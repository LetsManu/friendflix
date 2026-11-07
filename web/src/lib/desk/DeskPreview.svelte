<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { backdrop, img, logoUrl, primeItem, srcset, type Item } from '#lib/api';
  import { playPrefetch } from '#lib/player/prefetch';
  import { listIds, toggleList, prefs } from '#lib/stores';
  import { t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import { kidsMode } from '#lib/kids';
  import RatingButton from '#lib/RatingButton.svelte';
  import MoreActions from '#lib/MoreActions.svelte';
  import type { Thumb } from '#lib/rating';
  import { openModal } from '#lib/modal';
  import { isSpoiler } from '#lib/spoiler';
  import { loadFacts, type MediaTraits } from '#lib/fresh';
  import QualityChips from '#lib/QualityChips.svelte';
  import { lengthLabel } from '#lib/hover';
  import { reasonText } from '#lib/reason';
  import { autoplayAllowed, holdBillboard, previewOwner, stopPreview, playPreview, toggleSound } from '#lib/preview';
  import { artClick as openFromArt, clipEnv, hoverClipAllowed, portal, previewActions, ratingLoader, releaseClick as release, saveFavorite } from '#lib/hoverShared';
  import { EMPH_OUT, motionLevel } from '#lib/tv/motion';
  import { wideBox } from '#lib/desk/preview';

  /**
   * Desktop wide hover preview (spec desktop browse §2): a portal on <body> that grows sideways out of the card into a tile
   * ~2.5 cards wide. Left: the trailer (or backdrop) with the title, mute and progress; right: Play, My list, rating, more,
   * ⌄ (detail), the meta line with the match score, a two-line synopsis and the engine's reason. It never takes focus: keyboard
   * users open the title with Enter on the card.
   */
  export let item: Item;
  /** the card's thumbnail; the tile grows out of exactly this rect */
  export let anchor: HTMLElement;
  export let href: string;
  export let detail: string;
  export let removable = false;
  export let fav = false;
  /** the image the card already shows (currentSrc): painted at once, the sharper image fades in over it */
  export let startSrc = '';
  /** pointer over the tile / focus inside it (the card keeps it open while true) */
  export let over = false;
  export let focused = false;

  const dispatch = createEventDispatcher<{
    close: { refocus: boolean };
    remove: Item;
    listtoggle: { item: Item; inList: boolean };
    favchange: { item: Item; favorite: boolean };
    listchanged: { listId: string; contains: boolean };
  }>();

  let el: HTMLDivElement, pv: HTMLVideoElement | undefined;
  let box: ReturnType<typeof wideBox> | null = null, ready = false, playing = false, vmuted = true, hiLoaded = false, logoFailed = false;
  let thumb: Thumb = 0, fb = '', fbT: ReturnType<typeof setTimeout>, favBusy = false;
  let startT: ReturnType<typeof setTimeout>;

  $: listId = item.seriesId ?? item.id;
  $: inList = $listIds.has(listId);
  $: ep = item.type === 'Episode';
  $: src = item.backdrop ? backdrop(item.id, 780) : item.image ? img(item.id, 520) : '';
  $: srcs = item.backdrop ? srcset('Backdrop', item.id, [520, 780, 1280]) : item.image ? srcset('Primary', item.id, [320, 520, 780]) : '';
  $: posterOnly = !item.backdrop && item.image;
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  $: title = ep && item.seriesName ? item.seriesName : item.name;
  $: logo = !ep && item.logo && !logoFailed;
  $: epLine = ep ? `S${item.parentIndexNumber ?? '?'}·E${item.indexNumber ?? '?'} ${item.name}` : '';
  $: match = item.communityRating && item.communityRating > 0 ? $t('home.hero.match', { pct: Math.round(item.communityRating * 10) }) : '';
  $: len = lengthLabel(item);
  $: why = reasonText(item.reason, $t);
  $: playHref = item.type === 'Series' || item.type === 'BoxSet' ? href : `/watch/${item.id}`;
  // quality chips (4K / HDR / Atmos ...) arrive a moment after the tile opened; nothing is shown while unknown
  let traits: MediaTraits | null = null;
  $: if (item.type !== 'BoxSet') void loadFacts(listId).then((f) => { if (f && listId === (item.seriesId ?? item.id)) traits = f.traits; });
  $: if ($previewOwner !== item.id && playing) playing = false; // somebody else took over / the preview failed

  function measure() {
    const r = anchor.getBoundingClientRect();
    box = wideBox({ left: r.left, top: r.top, width: r.width, height: r.height }, { w: window.innerWidth, h: window.innerHeight });
    return r;
  }

  // the billboard trailer pauses while the preview is open (with or without a clip of its own) and comes back when it closes
  let releaseBillboard: (() => void) | undefined;
  onMount(() => {
    releaseBillboard = holdBillboard();
    const r = measure();
    void tick().then(() => {
      ready = true;
      // grow out of the card: FLIP from its rect (transform + opacity only); instant under reduced motion / calm mode
      if (!box || !el?.animate || motionLevel() !== 'full') return;
      const s = r.width / box.width;
      const ox = box.origin === 'left' ? box.left : box.origin === 'right' ? box.left + box.width : box.left + box.width / 2;
      const cx = box.origin === 'left' ? r.left : box.origin === 'right' ? r.right : r.left + r.width / 2;
      el.animate([{ transform: `translate(${cx - ox}px, ${r.top - box.top}px) scale(${s})`, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EMPH_OUT });
    });
    startT = setTimeout(startVideo, 1000);
    if (!ep) primeItem(item);
    void loadThumb();
  });
  onDestroy(() => { releaseBillboard?.(); clearTimeout(startT); clearTimeout(fbT); if (playing || $previewOwner === item.id) stopPreview(item.id); });

  /** muted trailer after 1 s, same rules as every other preview (#lib/preview) */
  async function startVideo() {
    if (!hoverClipAllowed(item, $prefs, clipEnv(autoplayAllowed()))) return;
    playing = true;
    if (!(await playPreview(item.id, () => pv))) playing = false;
  }

  const rating = ratingLoader(item.seriesId ?? item.id, (v) => (thumb = v));
  const loadThumb = () => rating.load();
  function onThumb(e: CustomEvent<{ value: Thumb }>) { rating.changed(e.detail.value); }
  function flash() { fb = tr('home.card.saveFailed'); clearTimeout(fbT); fbT = setTimeout(() => (fb = ''), 4500); }
  async function toggleInList(e: MouseEvent) {
    release(e);
    const was = inList;
    if (await toggleList(listId, was)) { if (inList !== was) dispatch('listtoggle', { item, inList: !was }); } else flash();
  }
  async function toggleFav() {
    if (favBusy) return;
    favBusy = true;
    const want = !fav;
    fav = want;
    if (await saveFavorite(item.id, want)) dispatch('favchange', { item, favorite: want });
    else { fav = !want; flash(); }
    favBusy = false;
  }
  $: actions = previewActions({ fav, removable, t: $t, toggleFav, remove: () => { dispatch('remove', item); } });
  /** ⌄ / the picture navigated to the detail page: the tile stays until the page swaps, its picture morphs into the backdrop */
  let opening = false;
  function more(e: MouseEvent) {
    if (!ep) primeItem(item);
    opening = !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0);
    if (!opening) dispatch('close', { refocus: false });
    openModal(e, detail);
  }
  /** a click on the picture (not on one of its buttons) opens the title like ⌄ */
  const artClick = (e: MouseEvent) => openFromArt(e, detail, more);

  // ---- closing: Escape, scroll, resize, navigation ----
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || document.querySelector('.lm-pop, .ma-pop')) return;
    e.stopPropagation(); // one Esc closes the preview only (not also the search field or a bar menu behind it)
    dispatch('close', { refocus: Boolean(el?.contains(document.activeElement)) });
  }
  function onScroll(e: Event) {
    const tg = e.target;
    if (tg instanceof Element && (el?.contains(tg) || tg.closest('.lm-pop, .ma-pop'))) return;
    dispatch('close', { refocus: false });
  }
  beforeNavigate((nav) => {
    if (!opening) { dispatch('close', { refocus: false }); return; }
    // the detail navigation was cancelled or failed (it never swaps the page): the tile closes like for any other navigation
    nav.complete?.catch(() => { if (!opening) return; opening = false; dispatch('close', { refocus: false }); });
  });
  // (a page that keeps this card, e.g. a same-page navigation, still closes the tile)
  afterNavigate(() => { if (opening) { opening = false; dispatch('close', { refocus: false }); } });
  function leaveFocus(e: FocusEvent) { if (!el?.contains(e.relatedTarget as Node | null)) focused = false; }
</script>

<svelte:window on:keydown|capture={onKey} on:scroll|capture={onScroll} on:resize={() => dispatch('close', { refocus: false })} on:blur={() => dispatch('close', { refocus: false })} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="dpv" class:ready data-play-scope use:portal bind:this={el} role="dialog" aria-label={$t('home.card.preview', { name: item.name })}
  data-origin={box?.origin ?? 'left'}
  style={box ? `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;border-radius:${Math.max(4, Math.round(box.width * 0.007))}px;transform-origin:${box.origin} top;` : 'left:0;top:0;width:0;height:0;'}
  on:mouseenter={() => (over = true)} on:mouseleave={() => (over = false)}
  on:focusin={() => (focused = true)} on:focusout={leaveFocus}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="dpv-art" data-play-art on:click={artClick} on:auxclick={artClick}>
    {#if posterOnly}<img class="blur" src={startSrc || src} alt="" aria-hidden="true" />{/if}
    {#if startSrc}<img class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} src={startSrc} alt="" />{/if}
    {#if src}<img class="hi" class:on={hiLoaded || !startSrc} class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} {src} srcset={srcs} sizes="{Math.round((box?.width ?? 600) * 0.55)}px" alt="" on:load={() => (hiLoaded = true)} />{/if}
    {#if playing}<!-- svelte-ignore a11y_media_has_caption --><video bind:this={pv} class="pv" loop playsinline on:volumechange={() => pv && (vmuted = pv.muted)} on:playing={() => pv && (vmuted = pv.muted)}></video>{/if}
    <span class="shade"></span>
    <div class="dpv-title">{#if logo}<img class="tlogo" src={logoUrl(item.id)} alt={title} on:error={() => (logoFailed = true)} />{:else}{title}{/if}</div>
    {#if playing}<button type="button" class="snd" aria-label={vmuted ? $t('home.card.soundOn') : $t('home.card.soundOff')} aria-pressed={!vmuted} on:click={(e) => { release(e); toggleSound(pv); }}><Icon name={vmuted ? 'volume-off' : 'volume'} size={16} /></button>{/if}
    {#if pct}<span class="dpv-progress"><i style="transform:scaleX({pct / 100})"></i></span>{/if}
  </div>
  <div class="dpv-info">
    <div class="acts">
      <a class="round play" href={playHref} use:playPrefetch aria-label={$t('home.card.playName', { name: item.name })} title={$t('home.card.play')}><Icon name="play" size={18} fill /></a>
      <button type="button" class="round" aria-label={inList ? $t('home.card.removeFromList') : $t('home.card.addToListLong')} title={$t('home.card.myList')} on:click={toggleInList}><Icon name={inList ? 'check' : 'plus'} size={18} /></button>
      {#if item.type !== 'BoxSet'}<RatingButton itemId={listId} size={36} bind:value={thumb} on:change={onThumb} on:error={flash} />{/if}
      <span class="right">
        <MoreActions {actions} size={36} title={item.name} label={$t('home.card.moreActionsFor', { name: item.name })}>
          {#if item.type !== 'BoxSet' && !$kidsMode}<ListMenu itemId={listId} variant="row" on:changed={(e) => dispatch('listchanged', e.detail)} />{/if}
        </MoreActions>
        <a class="round dpv-more" href={detail} aria-label={$t('home.card.moreInfoFor', { name: item.name })} title={$t('home.card.moreInfo')} on:click={more}><Icon name="chevron-down" size={18} /></a>
      </span>
    </div>
    <div class="fb" role="status">{#if fb}<span>{fb}</span>{/if}</div>
    <div class="dpv-meta">
      {#if match}<span class="dpv-match">{match}</span>{/if}
      {#if item.rating}<span class="dpv-age">{item.rating}</span>{/if}
      {#if len}<span class="len">{len}</span>{/if}
      <QualityChips {traits} />
    </div>
    {#if epLine}<p class="dpv-ep">{epLine}</p>{/if}
    {#if item.overview}<p class="dpv-syn">{item.overview}</p>{/if}
    {#if why}<p class="dpv-why">{why}</p>{/if}
  </div>
</div>

<style>
  .dpv {
    --dpv-bg: #18181c;
    position: fixed; z-index: 65; display: grid; grid-template-columns: 1.15fr 1fr; overflow: hidden;
    background: var(--dpv-bg); color: var(--fg); border-radius: 6px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, .6), 0 8px 20px rgba(0, 0, 0, .35), 0 0 0 1px rgba(255, 255, 255, .07);
    visibility: hidden;
  }
  .dpv.ready { visibility: visible; }
  .dpv-art { position: relative; overflow: hidden; background: #0c0c0f; min-width: 0; cursor: pointer; }
  .dpv-art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .dpv-art img.contain { object-fit: contain; }
  .blur { inset: -10%; width: 120%; height: 120%; filter: blur(18px) brightness(.55); }
  .dpv-art img.spoil { filter: blur(14px); transform: scale(1.1); }
  .dpv-art img.hi { opacity: 0; transition: opacity .15s linear; }
  .dpv-art img.hi.on { opacity: 1; }
  :global(html.calm) .dpv-art img.hi { transition: none; }
  .pv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
  /* the picture fades into the panel on the right and darkens under the title */
  .shade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, transparent 70%, var(--dpv-bg)), linear-gradient(transparent 45%, rgba(0, 0, 0, .7)); }
  .dpv-title { position: absolute; left: 16px; right: 56px; bottom: 16px; font-weight: 900; font-size: 1.25rem; letter-spacing: -.02em; line-height: 1.05; text-shadow: 0 1px 12px rgba(0, 0, 0, .6); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; pointer-events: none; }
  .tlogo { position: static !important; width: auto !important; height: auto !important; max-width: 70%; max-height: 56px; object-fit: contain; object-position: left bottom; }
  .snd { position: absolute; right: 16px; bottom: 14px; z-index: 2; width: 32px; min-height: 32px; height: 32px; padding: 0; border-radius: 50%; background: rgba(0, 0, 0, .35); border: 1.5px solid rgba(255, 255, 255, .7); color: #fff; display: grid; place-items: center; }
  .snd::after { content: ''; position: absolute; inset: -6px; }
  .snd:hover { border-color: #fff; }
  .dpv-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255, 255, 255, .22); }
  .dpv-progress i { display: block; height: 100%; background: var(--acc, #ff4f6d); transform-origin: left; }
  .dpv-info { min-width: 0; padding: 16px 16px 16px 12px; display: flex; flex-direction: column; justify-content: center; gap: 8px; overflow: hidden; }
  .acts { display: flex; gap: 8px; align-items: center; }
  .round { width: 36px; min-height: 36px; height: 36px; padding: 0; border-radius: 50%; background: transparent; border: 1.5px solid rgba(255, 255, 255, .55); color: #fff; display: grid; place-items: center; position: relative; flex: none; }
  .round::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; }
  .round:hover { border-color: #fff; background: rgba(255, 255, 255, .08); }
  .round:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .round.play { background: #fff; border-color: #fff; color: #111; }
  .round.play:hover { background: rgba(255, 255, 255, .86); }
  /* the shared round controls (rating, more) in the tile's 1.5 px outline style */
  .acts :global(.rb .trig), .acts :global(.ma.round) { background: transparent; border: 1.5px solid rgba(255, 255, 255, .55); }
  .acts :global(.rb .trig:hover:not(:disabled)), .acts :global(.ma.round:hover) { border-color: #fff; background: rgba(255, 255, 255, .08); }
  .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .fb:empty { display: none; }
  .fb span { display: inline-block; padding: .2rem .55rem; border-radius: 6px; background: rgba(16, 20, 24, .92); border: 1px solid var(--err, #e5646e); font-size: .78rem; font-weight: 600; }
  .dpv-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-size: .8rem; color: #d4d4d8; font-variant-numeric: tabular-nums; }
  .dpv-meta :global(.qc) { margin: 0; }
  .dpv-match { color: var(--ok, #4ade80); font-weight: 700; }
  .dpv-age { border: 1px solid rgba(255, 255, 255, .45); padding: 0 4px; line-height: 1.35; border-radius: 2px; }
  .dpv-ep { margin: 0; font-size: .82rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dpv-syn { margin: 0; font-size: .8rem; line-height: 1.4; color: #c4c4cc; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .dpv-why { margin: 0; font-size: .78rem; line-height: 1.35; font-weight: 600; color: #ff4f6d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(html.tv) .dpv { display: none; }
</style>
