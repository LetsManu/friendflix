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
  import { EMPH_OUT, GLASS_IN, watchFrames } from '#lib/tv/motion';
  import { HOVER_MARGIN, INFO_UNDERLAY, hoverBox, hoverWidth, type HoverBox } from '#lib/desk/preview';
  import { cachedTone, toneFor, toneVars, type Tone } from '#lib/glass/tone';
  import { sheen } from '#lib/glass/pointer';
  import { fxMode, REDUCED_MS } from '#lib/glass/fx';

  /**
   * Desktop hover card (glass spec §3): a portal on <body>, one frosted card of the same size on every card. On top a 16:9 picture
   * (the trailer or backdrop with the title, mute and progress) centred on the card; below Play, My list, rating, more, ⌄ (detail),
   * the meta line with the match score, the episode line, a three-line synopsis and the engine's reason. It is measured hidden,
   * placed fully inside the window, grows out of the card and shrinks back into it (`leave`). It never takes focus: keyboard
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

  let el: HTMLDivElement, info: HTMLDivElement, pv: HTMLVideoElement | undefined;
  let box: HoverBox | null = null, ready = false, closing = false, w = typeof window === 'undefined' ? 560 : hoverWidth(window.innerWidth), playing = false, vmuted = true, hiLoaded = false, logoFailed = false;
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

  // ---- tone (glass spec §1.3, §8.2): the card sampled its artwork while the pointer rested; known before the card shows, the tint
  // and the computed scrim apply at once. A tone that arrives later only crossfades the tint in; the scrim stays the safe one.
  const toneKey = item.seriesId ?? item.id; // the key the card sampled under (and the detail page reuses)
  let tone: Tone | null = cachedTone(toneKey) ?? null;
  const rgb = (t: Tone) => `${t.tint[0]}, ${t.tint[1]}, ${t.tint[2]}`;
  let tints: [string, string] = [tone ? rgb(tone) : '', ''], front = 0;
  function toneArrived(t: Tone | null) {
    if (!t || closing) return;
    if (!ready) { tone = t; tints = [rgb(t), '']; front = 0; return; }
    const back = 1 - front;
    tints[back] = rgb(t);
    front = back;
  }

  /** the card's centre inside the box, clamped to it: the grow and shrink origin */
  let org = '50% 50%';
  /** measured hidden at the hover width, then placed (glass spec §3); a width change (short window) is measured once more */
  async function place(): Promise<DOMRect> {
    const r = anchor.getBoundingClientRect();
    const vp = { w: window.innerWidth, h: window.innerHeight };
    let b = hoverBox(r, vp, info.offsetHeight);
    if (b.width !== w) { w = b.width; await tick(); b = hoverBox(r, vp, info.offsetHeight); }
    box = b;
    org = `${Math.round(b.ox)}px ${Math.round(b.oy)}px`;
    return r;
  }
  /** the text part's room is short (a 600–630 px window): the synopsis drops to 2 lines; last resort, the text part scrolls */
  let tight = false, infoMax = 0;
  /**
   * Keeps the whole card inside the window when the text grows (the quality chips arrive late, a failed-save note): first the
   * card moves up, then the synopsis drops a line, and as a last resort the text part gets a max height with its own scroll.
   */
  async function refit() {
    if (!box || closing || !info) return;
    const avail = Math.floor(window.innerHeight - 2 * HOVER_MARGIN - box.picH);
    let h = info.offsetHeight;
    if (h > avail && !tight) { tight = true; await tick(); h = info.offsetHeight; }
    if (h > avail && !infoMax) { infoMax = Math.max(0, avail); await tick(); h = info.offsetHeight; }
    if (!box || closing) return;
    const height = box.picH + h;
    const top = Math.max(HOVER_MARGIN, Math.min(box.top, window.innerHeight - HOVER_MARGIN - height));
    if (top !== box.top || height !== box.height) box = { ...box, top, height };
  }

  // the billboard trailer pauses while the preview is open (with or without a clip of its own) and comes back when it closes
  let releaseBillboard: (() => void) | undefined, ro: ResizeObserver | undefined;
  onMount(() => {
    releaseBillboard = holdBillboard();
    if (cachedTone(toneKey) === undefined && (startSrc || src)) void toneFor(toneKey, startSrc || src).then(toneArrived);
    void tick().then(place).then(async (r) => {
      if (closing) return;
      await refit(); // a short window: fit the text before the card shows
      if (closing) return;
      ready = true;
      if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => void refit()); ro.observe(info); }
      // grow out of the card (transform + opacity only, origin = the card centre): full motion scales up from the card's width,
      // the reduced set fades in 160 ms, calm mode / reduced motion show it at once
      const mode = fxMode();
      if (!box || !el?.animate || mode === 'still') return;
      if (mode === 'reduced') grow = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REDUCED_MS, easing: 'linear' });
      else {
        watchFrames(); // the frame guard measures the grow (the card's blur is the most expensive glass moment)
        grow = el.animate([{ transform: `scale(${Math.max(0.1, r.width / box.width)})`, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EMPH_OUT });
      }
    });
    startT = setTimeout(startVideo, 1000);
    if (!ep) primeItem(item);
    void loadThumb();
  });
  onDestroy(() => { ro?.disconnect(); releaseBillboard?.(); clearTimeout(startT); clearTimeout(fbT); if (playing || $previewOwner === item.id) stopPreview(item.id); });

  // ---- closing: the card keeps this mounted until `leave` resolves (glass spec §3) ----
  let shrink: Animation | null = null, grow: Animation | null = null;
  /**
   * Shrinks back into the card: 180 ms GLASS_IN toward the card's rect with opacity → 0 (the reduced set: a 160 ms fade; calm mode /
   * reduced motion: at once). The trailer stops right away.
   */
  export async function leave(): Promise<void> {
    closing = true;
    over = false; focused = false;
    clearTimeout(startT);
    if (playing || $previewOwner === item.id) { stopPreview(item.id); playing = false; }
    const mode = fxMode();
    if (!ready || !box || !el?.animate || mode === 'still') return;
    // a close while it still grows reverses from where it is (no jump to full size first)
    const growing = grow?.playState === 'running';
    const cs = getComputedStyle(el);
    const from = growing ? { transform: cs.transform, opacity: Number(cs.opacity) } : { transform: 'none', opacity: 1 };
    if (growing) grow!.cancel();
    if (mode === 'reduced') shrink = el.animate([{ opacity: from.opacity }, { opacity: 0 }], { duration: REDUCED_MS, easing: 'linear', fill: 'forwards' });
    else {
      // toward where the card is now (it may have scrolled): scale about its centre clamped into the box, then move the rest
      // (mid-grow the origin stays the grow's, so the current transform is read about the same point)
      const r = anchor.getBoundingClientRect();
      const cx = r.left + r.width / 2 - box.left, cy = r.top + r.height / 2 - box.top;
      const ox = growing ? box.ox : Math.min(box.width, Math.max(0, cx)), oy = growing ? box.oy : Math.min(box.height, Math.max(0, cy));
      if (!growing) { org = `${Math.round(ox)}px ${Math.round(oy)}px`; await tick(); }
      const s = Math.max(0.1, (r.width || box.width * 0.2) / box.width);
      watchFrames();
      shrink = el.animate([from, { transform: `translate(${Math.round(cx - ox)}px, ${Math.round(cy - oy)}px) scale(${s})`, opacity: 0 }], { duration: 180, easing: GLASS_IN, fill: 'forwards' });
    }
    try { await shrink.finished; } catch { /* cancelled: closed all the same */ }
  }
  /** a new open during the close: the close ends at once */
  export function finish(): void { shrink?.finish(); }

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
    if (e.key !== 'Escape' || document.querySelector('.lm-pop:not([inert]), .ma-pop:not([inert])')) return;
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
  class="dpv frost" class:frost-safe={!tone} class:ready class:closing data-play-scope use:portal use:sheen bind:this={el} role="dialog" aria-label={$t('home.card.preview', { name: item.name })}
  style="{box ? `left:${box.left}px;top:${box.top}px;` : 'left:0;top:0;'}width:{box?.width ?? w}px;transform-origin:{org};{toneVars(tone)}"
  on:mouseenter={() => { if (!closing) over = true; }} on:mouseleave={() => (over = false)}
  on:focusin={() => { if (!closing) focused = true; }} on:focusout={leaveFocus}
>
  <span class="frost-tint" aria-hidden="true">{#each tints as tn, i}<i class:on={front === i && !!tn} style={tn ? `--t:${tn}` : undefined}></i>{/each}</span>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="dpv-art" data-play-art on:click={artClick} on:auxclick={artClick}>
    {#if posterOnly}<img class="blur" src={startSrc || src} alt="" aria-hidden="true" />{/if}
    {#if startSrc}<img class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} src={startSrc} alt="" />{/if}
    {#if src}<img class="hi" class:on={hiLoaded || !startSrc} class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} {src} srcset={srcs} sizes="{box?.width ?? w}px" alt="" on:load={() => (hiLoaded = true)} />{/if}
    {#if playing}<!-- svelte-ignore a11y_media_has_caption --><video bind:this={pv} class="pv" loop playsinline on:volumechange={() => pv && (vmuted = pv.muted)} on:playing={() => pv && (vmuted = pv.muted)}></video>{/if}
    <span class="shade"></span>
    <div class="dpv-title">{#if logo}<img class="tlogo" src={logoUrl(item.id)} alt={title} on:error={() => (logoFailed = true)} />{:else}{title}{/if}</div>
    {#if playing}<button type="button" class="snd" aria-label={vmuted ? $t('home.card.soundOn') : $t('home.card.soundOff')} aria-pressed={!vmuted} on:click={(e) => { release(e); toggleSound(pv); }}><Icon name={vmuted ? 'volume-off' : 'volume'} size={16} /></button>{/if}
    {#if pct}<span class="dpv-progress"><i style="transform:scaleX({pct / 100})"></i></span>{/if}
  </div>
  <div class="dpv-info" class:tight bind:this={info} style="--dpv-under:{INFO_UNDERLAY};{infoMax ? `max-height:${infoMax}px;overflow-y:auto;` : ''}">
    <div class="acts">
      <a class="play" href={playHref} use:playPrefetch aria-label={$t('home.card.playName', { name: item.name })} title={$t('home.card.play')}><Icon name="play" size={18} fill /></a>
      <button type="button" class="frost-btn round" aria-label={inList ? $t('home.card.removeFromList') : $t('home.card.addToListLong')} title={$t('home.card.myList')} on:click={toggleInList}><Icon name={inList ? 'check' : 'plus'} size={18} /></button>
      {#if item.type !== 'BoxSet'}<RatingButton itemId={listId} size={44} bind:value={thumb} on:change={onThumb} on:error={flash} />{/if}
      <span class="right">
        <MoreActions {actions} size={44} title={item.name} label={$t('home.card.moreActionsFor', { name: item.name })}>
          {#if item.type !== 'BoxSet' && !$kidsMode}<ListMenu itemId={listId} variant="row" on:changed={(e) => dispatch('listchanged', e.detail)} />{/if}
        </MoreActions>
        <a class="frost-btn round dpv-more" href={detail} aria-label={$t('home.card.moreInfoFor', { name: item.name })} title={$t('home.card.moreInfo')} on:click={more}><Icon name="chevron-down" size={18} /></a>
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
  /* the glass card (glass spec §3): .frost gives the milk, scrim, grain and blur; the 1 px edge is drawn on ::after so the picture
     keeps the full width (the same 16:9 height on every card); overflow clips the picture's corners, the sheen and the tint */
  .dpv {
    position: fixed; z-index: 65; display: grid; grid-template-columns: minmax(0, 1fr); overflow: hidden;
    border: 0; border-radius: var(--fr-r-hover); color: var(--fg);
    visibility: hidden;
  }
  .dpv::after { content: ''; position: absolute; inset: 0; z-index: 2; border-radius: inherit; border: 1px solid var(--fr-line); box-shadow: inset 0 1px 0 var(--fr-hi); pointer-events: none; }
  .dpv.ready { visibility: visible; }
  .dpv.closing { pointer-events: none; }
  .dpv-art { position: relative; overflow: hidden; aspect-ratio: 16 / 9; background: #0c0c0f; min-width: 0; cursor: pointer; }
  .dpv-art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .dpv-art img.contain { object-fit: contain; }
  .blur { inset: -10%; width: 120%; height: 120%; filter: blur(18px) brightness(.55); }
  .dpv-art img.spoil { filter: blur(14px); transform: scale(1.1); }
  .dpv-art img.hi { opacity: 0; transition: opacity .15s linear; }
  .dpv-art img.hi.on { opacity: 1; }
  :global(html.calm) .dpv-art img.hi { transition: none; }
  .pv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
  /* the picture darkens under the title */
  .shade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(0deg, rgba(10, 9, 13, .75), transparent 55%); }
  .dpv-title { position: absolute; left: 22px; right: 64px; bottom: 16px; font-weight: 900; font-size: 1.75rem; letter-spacing: -.02em; line-height: 1.05; text-shadow: 0 1px 12px rgba(0, 0, 0, .6); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; pointer-events: none; }
  .tlogo { position: static !important; width: auto !important; height: auto !important; max-width: 60%; max-height: 72px; object-fit: contain; object-position: left bottom; }
  .snd { position: absolute; right: 18px; bottom: 14px; z-index: 2; width: 36px; min-height: 36px; height: 36px; padding: 0; border-radius: 50%; background: rgba(0, 0, 0, .35); border: 1.5px solid rgba(255, 255, 255, .7); color: #fff; display: grid; place-items: center; }
  .snd::after { content: ''; position: absolute; inset: -4px; }
  .snd:hover { border-color: #fff; }
  .dpv-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255, 255, 255, .22); }
  .dpv-progress i { display: block; height: 100%; background: var(--acc, #ff4f6d); transform-origin: left; }
  /* the text part sits over page content nobody sampled (rows, Top 10 posters, the billboard): its own dark underlay, solved for a
     pure white page behind (preview.ts INFO_UNDERLAY), above the tint and the milk; the picture part keeps the tone's glass */
  .dpv-info { min-width: 0; padding: 18px 22px 22px; display: flex; flex-direction: column; gap: 10px; background: rgba(var(--fr-scrim-rgb), var(--dpv-under, .76)); }
  .dpv-info.tight .dpv-syn { -webkit-line-clamp: 2; line-clamp: 2; }
  .acts { display: flex; gap: 10px; align-items: center; }
  .play { width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; background: #fff; color: #111; display: grid; place-items: center; position: relative; flex: none; transition: transform var(--t-fast), opacity var(--t-fast); }
  .play:hover { background: #fff; opacity: .88; }
  .play:focus-visible, .acts .frost-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; --ring-o: 2px; }
  .acts .frost-btn { color: #fff; flex: none; }
  /* the icon never is the click target: the page motion reads the clicked element (an HTMLElement) to find the morph source */
  .play :global(svg), .acts .frost-btn :global(svg) { pointer-events: none; }
  /* the shared round controls (rating, more) as the same glass circles (.frost-btn's look and its solid fallback) */
  .acts :global(.rb .trig), .acts :global(.ma.round) {
    background: linear-gradient(180deg, rgba(var(--fr-milk-top), var(--fr-milk-a2)), rgba(var(--fr-milk), var(--fr-milk-a1))), rgba(var(--fr-scrim-rgb), var(--fr-scrim));
    border: 1px solid var(--fr-line); box-shadow: inset 0 1px 0 var(--fr-hi);
  }
  .acts :global(.rb .trig:hover:not(:disabled)), .acts :global(.ma.round:hover), .acts :global(.ma.round.on) {
    background: linear-gradient(180deg, rgba(var(--fr-milk-top), var(--fr-milk-a2)), rgba(var(--fr-milk), var(--fr-milk-a1))), rgba(var(--fr-scrim-rgb), var(--fr-scrim));
    border-color: rgba(255, 255, 255, .42); box-shadow: inset 0 1px 0 var(--fr-hi), inset 0 0 0 1px rgba(255, 255, 255, .14);
  }
  :global(html:not(.m-glass)) .acts :global(.rb .trig), :global(html:not(.m-glass)) .acts :global(.ma.round) { background: var(--fr-solid); }
  :global(html:not(.m-glass)) .acts :global(.rb .trig:hover:not(:disabled)), :global(html:not(.m-glass)) .acts :global(.ma.round:hover) { background: var(--fr-solid-hover); }
  .right { margin-left: auto; display: flex; gap: 10px; align-items: center; }
  .fb:empty { display: none; }
  .fb span { display: inline-block; padding: .2rem .55rem; border-radius: 6px; background: rgba(16, 20, 24, .92); border: 1px solid var(--err, #e5646e); font-size: .78rem; font-weight: 600; }
  .dpv-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-size: .85rem; color: rgba(255, 255, 255, .9); font-variant-numeric: tabular-nums; }
  .dpv-meta :global(.qc) { margin: 0; }
  .dpv-match { color: var(--ok, #4ade80); font-weight: 800; }
  .dpv-age { border: 1px solid rgba(255, 255, 255, .45); padding: 0 5px; line-height: 1.4; border-radius: 6px; font-size: .75rem; font-weight: 700; }
  .dpv-ep { margin: 0; font-size: .95rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dpv-syn { margin: 0; font-size: .875rem; line-height: 1.45; color: rgba(255, 255, 255, .9); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .dpv-why { margin: 0; font-size: .8125rem; line-height: 1.35; font-weight: 700; color: var(--acc-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(html.tv) .dpv { display: none; }
</style>
