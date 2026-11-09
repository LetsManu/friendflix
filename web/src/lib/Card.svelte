<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script context="module" lang="ts">
  /** last wheel / scroll anywhere on the page (Date.now()): the desktop preview waits for the page to rest */
  let lastScroll = 0, scrollTracked = false;
  function trackScroll() {
    if (scrollTracked || typeof window === 'undefined') return;
    scrollTracked = true;
    const on = () => { lastScroll = Date.now(); };
    window.addEventListener('wheel', on, { passive: true, capture: true });
    window.addEventListener('scroll', on, { passive: true, capture: true });
  }
</script>

<script lang="ts">
  import { api, backdrop, img, primeItem, srcset, CARD_SIZES, CARD_WIDTHS, type Item } from '#lib/api';
  import { prefetchModal } from '#lib/lazy';
  import { listIds, toggleList } from '#lib/stores';
  import { t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import { kidsMode } from '#lib/kids';
  import { openModal } from '#lib/modal';
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { prefs } from '#lib/stores';
  import { isSpoiler } from '#lib/spoiler';
  import { cardTag } from '#lib/badges';
  import { badges, wantBadge } from '#lib/fresh';
  import HoverPreview from '#lib/HoverPreview.svelte';
  import DeskPreview from '#lib/desk/DeskPreview.svelte';
  import { deskActive, deskUi } from '#lib/desk/bar';
  import { HOVER_CLOSE_MS, HOVER_DELAY_MS, hoverAllowed } from '#lib/desk/preview';
  import { mobile } from '#lib/viewport';
  import { get } from 'svelte/store';
  import { hoverOwner, nextHoverUid } from '#lib/hover';
  import { isBackKey } from '#lib/spatial';
  import { tvFocus } from '#lib/tv/focus';
  import { decodeFade } from '#lib/tv/motion';
  import { tilt } from '#lib/glass/pointer';
  import { SCRIM_MENU, toneFor } from '#lib/glass/tone';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';

  export let item: Item;
  /** shows a remove (X) button and emits `remove` (used for Weiterschauen) */
  export let removable = false;
  /** portrait 2:3 poster instead of the 16:9 thumbnail (Top-10 rows) */
  export let poster = false;
  /** eager + high priority image (first visible row of the home page) */
  export let priority = false;
  /** the link the card opens instead of the title's own page (TV extras grid: the clip plays) */
  export let to = '';
  const dispatch = createEventDispatcher<{
    remove: Item;
    /** "Merkliste" was toggled for this card (after the server accepted it) */
    listtoggle: { item: Item; inList: boolean };
    /** favourite was toggled (after the server accepted it) */
    favchange: { item: Item; favorite: boolean };
    /** a list from the ListMenu picker was changed */
    listchanged: { listId: string; contains: boolean };
  }>();
  let fav = item.favorite;
  $: fav = item.favorite; // follow the item when the list re-renders with fresh data
  $: href = to ? to : item.type === 'Episode' ? `/watch/${item.id}` : item.type === 'BoxSet' ? `/library/${item.id}` : `/item/${item.id}`;
  $: detail = item.type === 'Episode' && item.seriesId ? `/item/${item.seriesId}` : `/item/${item.id}`;
  $: posterId = item.type === 'Episode' && item.seriesId ? item.seriesId : item.id;
  $: posterSrc = poster && (item.image || item.type === 'Episode') ? img(posterId, 320) : '';
  $: src = posterSrc || (item.backdrop ? backdrop(item.id, 520) : item.image ? img(item.id, 520) : '');
  // one URL for blur + main image (identical strings: a single request); the srcset widths are the same for both
  $: srcs = posterSrc ? srcset('Primary', posterId, [200, 320, 480]) : item.backdrop ? srcset('Backdrop', item.id, CARD_WIDTHS) : item.image ? srcset('Primary', item.id, CARD_WIDTHS) : '';
  $: sizes = posterSrc ? '(min-width: 1400px) 9vw, (min-width: 1100px) 11vw, 14vw' : CARD_SIZES;
  $: epSub = item.type === 'Episode' && item.seriesName ? `S${item.parentIndexNumber ?? '?'}·E${item.indexNumber ?? '?'} ${item.name}` : '';
  $: posterOnly = !posterSrc && !item.backdrop && item.image; // poster (2:3) in a 16:9 slot: show it contained on a blurred copy
  $: sub = item.type === 'Episode' ? `${item.seriesName ?? ''} · S${item.parentIndexNumber ?? '?'}:E${item.indexNumber ?? '?'}` : '';
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  $: inList = $listIds.has(item.seriesId ?? item.id);
  // one tag per card from the server (fresh label or "Nur noch N Tage"); episodes ask for their series' removal date
  $: badgeId = item.type === 'Episode' ? item.seriesId : item.id;
  $: wantBadge(badgeId);
  $: tag = cardTag(badgeId ? $badges[badgeId] : undefined, item, Date.now());
  let imgEl: HTMLImageElement | undefined;

  // ---- pop-out preview (portal). Desktop browse layout: the wide DeskPreview after a 500 ms rest of the pointer (never on keyboard
  // focus: Enter on the card opens the title). Elsewhere with a fine pointer (kids UI): HoverPreview after ~450 ms hover / 600 ms focus.
  const canHover = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  const uid = nextHoverUid();
  let hp = false, hpComp: HoverPreview | undefined, thumbEl: HTMLAnchorElement, cardEl: HTMLElement, twEl: HTMLElement;
  /** the desktop hover card: kept mounted while it shrinks back (`closing`); every open mounts a fresh one (`openSeq`) */
  let dpvComp: DeskPreview | undefined, closing = false, openSeq = 0;
  /** the open preview is the desktop one (decided when it opens) */
  let wide = false;
  let overCard = false, focusCard = false, overPrev = false, focusPrev = false;
  let openT: ReturnType<typeof setTimeout>, closeT: ReturnType<typeof setTimeout>;
  const tvMode = () => document.documentElement.classList.contains('tv');
  const deskNow = () => deskUi({ tv: tvMode(), mobile: get(mobile), kids: get(kidsMode) });
  trackScroll();
  function scheduleOpen(delay: number) {
    clearTimeout(openT);
    if (hp || !canHover || tvMode()) return;
    openT = setTimeout(() => { wide = false; hp = true; hoverOwner.set(uid); }, delay);
  }
  /** desktop: open once the pointer rested HOVER_DELAY_MS on the card and the page did not scroll meanwhile */
  function scheduleWide(delay = HOVER_DELAY_MS) {
    clearTimeout(openT);
    // the hover card's tone (glass spec §1.3) is sampled from this card's artwork while the pointer rests
    const art = imgEl?.currentSrc || src;
    if (art) void toneFor(item.seriesId ?? item.id, art);
    openT = setTimeout(() => {
      if (hp || !overCard || !deskNow()) return;
      const since = Date.now() - lastScroll;
      const scrolling = since < HOVER_DELAY_MS;
      if (!hoverAllowed({ width: window.innerWidth, height: window.innerHeight, coarse: !canHover, scrolling })) { if (scrolling) scheduleWide(HOVER_DELAY_MS - since); return; }
      if (closing) { dpvComp?.finish(); closing = false; } // a new open finishes the running close at once
      untilt();
      openSeq++;
      wide = true; hp = true; hoverOwner.set(uid);
    }, delay);
  }
  /** the poster tilt settles back when the hover card opens (its leave logic); `.dpv-dim` takes over the row */
  function untilt() { if (typeof PointerEvent !== 'undefined') twEl?.dispatchEvent(new PointerEvent('pointerleave')); }
  /** the desktop hover card shrinks back into the card before it unmounts (glass spec §3) */
  function shutWide() {
    if (!dpvComp) return;
    closing = true;
    const seq = openSeq;
    void dpvComp.leave().then(() => { if (seq === openSeq) closing = false; });
  }
  function closePreview(refocus = false) {
    clearTimeout(openT); clearTimeout(closeT);
    const had = hp;
    hp = false; overPrev = false; focusPrev = false;
    if (had && wide) shutWide();
    if (had && refocus) thumbEl?.focus();
    hoverOwner.update((o) => (o === uid ? '' : o));
  }
  // the wide desktop preview never holds on focus: a mouse click on its rating or "⋯" leaves focus inside, and it must still close
  // HOVER_CLOSE_MS after the pointer left (open pickers keep it open through the .lm-pop/.ma-pop check below)
  $: held = overCard || overPrev || (!wide && (focusCard || focusPrev));
  $: syncHold(hp, held);
  function syncHold(open: boolean, h: boolean) {
    clearTimeout(closeT);
    if (!open || h) return;
    // grace period so the pointer can travel from the card onto the pop-out; stay open while a list picker is open
    const check = () => { if (held) return; if (document.querySelector('.lm-pop:not([inert]), .ma-pop:not([inert])')) { closeT = setTimeout(check, 400); return; } closePreview(); };
    closeT = setTimeout(check, wide ? HOVER_CLOSE_MS : 120);
  }
  $: if ($hoverOwner !== uid && hp) { hp = false; overPrev = false; focusPrev = false; if (wide) shutWide(); }
  // desktop: the neighbours in the row dim while this card's wide preview is open
  $: dimRow(hp && wide);
  let dimmed: Element | null = null;
  function dimRow(on: boolean) {
    if (typeof document === 'undefined') return;
    if (on && !dimmed) { dimmed = cardEl?.closest('section.row') ?? null; dimmed?.classList.add('dpv-dim'); }
    else if (!on && dimmed) { dimmed.classList.remove('dpv-dim'); dimmed = null; }
  }
  function cardEnter() {
    overCard = true;
    if (canHover && !tvMode() && deskNow()) scheduleWide();
    else scheduleOpen(450);
  }
  function cardLeave() { overCard = false; clearTimeout(openT); }
  // keyboard focus only: a mouse click on a button must not open (or pin) the preview; the desktop preview never opens on focus
  function onFocusIn(e: FocusEvent) { if (tvMode()) tvFocus.set(item); if ((e.target as HTMLElement).matches(':focus-visible')) { focusCard = true; if (!deskNow()) scheduleOpen(600); } }
  function onFocusOut(e: FocusEvent) { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) { focusCard = false; clearTimeout(openT); } }
  // TV: OK held on a card opens its actions sheet (the small remove / more buttons are hidden there); a short OK opens the title
  const LONG_PRESS_MS = 600;
  let pressT: ReturnType<typeof setTimeout> | null = null;
  function thumbKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || !tvMode()) return;
    e.preventDefault(); // the link would follow on keydown; a short press follows it on keyup instead
    if (e.repeat || pressT) return;
    pressT = setTimeout(() => { pressT = null; void openSheet(); }, LONG_PRESS_MS);
  }
  function thumbKeyUp(e: KeyboardEvent) {
    if (e.key !== 'Enter' || !tvMode() || !pressT) return;
    clearTimeout(pressT); pressT = null;
    e.preventDefault(); thumbEl?.click();
  }
  function onKey(e: KeyboardEvent) {
    // Tab from the thumbnail walks into the open pop-out (it lives in <body>, outside the tab order of the row)
    if (hp && !wide && e.key === 'Tab' && !e.shiftKey && e.target === thumbEl) { e.preventDefault(); hpComp?.focusFirst(); }
  }
  function exitPreview(dir: 1 | -1) {
    if (dir === -1) { thumbEl?.focus(); return; }
    const all = [...document.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((n) => !n.closest('.hp') && n.getClientRects().length);
    const next = all[all.indexOf(thumbEl) + 1];
    closePreview();
    (next ?? thumbEl)?.focus();
  }
  onDestroy(() => { clearTimeout(openT); clearTimeout(closeT); if (pressT) clearTimeout(pressT); dimRow(false); hoverOwner.update((o) => (o === uid ? '' : o)); });

  // ---- poster tilt (glass spec §8.7): desktop rows only, never while this card's hover card is open or closing; `tilt` itself
  // stays still in calm mode / reduced motion / a tripped guard, on TV, on kids profiles and without a fine pointer
  function rowTilt(node: HTMLElement) {
    const gate = (e: Event) => { if (hp || closing || !node.closest('section.row.dk')) e.stopImmediatePropagation(); };
    node.addEventListener('pointerenter', gate); // added first: it runs before the tilt's own enter
    const t = tilt(node, { card: '.thumb', glare: '.tw-glare', band: '.tw-band', shadow: '.tw-shadow', row: 'section.row.dk' });
    return { destroy() { node.removeEventListener('pointerenter', gate); t.destroy(); } };
  }

  // ---- touch action sheet (the hover pop-up is not reachable without a pointer) ----
  let sheet = false, sheetEl: HTMLDivElement, moreBtn: HTMLButtonElement;
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  async function openSheet() { sheet = true; await tick(); sheetEl?.querySelector<HTMLElement>('a[href],button')?.focus(); }
  function closeSheet(refocus = true) { sheet = false; if (refocus) moreBtn?.focus(); }
  /** the glass sheet slides up and back down (glass spec §5); on TV (a centred dialog) it appears at once, as before */
  const sheetT = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, mode: tvMode() ? 'still' : undefined })); // reverses mid-flight
  const scrimT = (node: Element) => scrimFade(node, { mode: tvMode() ? 'still' : undefined });
  function sheetKey(e: KeyboardEvent) {
    if (e.key === 'Escape' || (tvMode() && isBackKey(e))) { e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheetEl.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')];
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ---- feedback for failed saves (heart / Merkliste); role="status" region over the thumbnail ----
  let fb = '', fbT: ReturnType<typeof setTimeout>, favBusy = false;
  function flash() { fb = tr('home.card.saveFailed'); clearTimeout(fbT); fbT = setTimeout(() => (fb = ''), 4500); }
  onDestroy(() => clearTimeout(fbT));
  async function toggleFav() {
    if (favBusy) return;
    favBusy = true;
    const want = !fav;
    fav = want;
    try { await api(`/api/items/${item.id}/favorite`, { method: want ? 'POST' : 'DELETE' }); dispatch('favchange', { item, favorite: want }); }
    catch { fav = !want; flash(); }
    favBusy = false;
  }
  async function toggleInList() {
    const was = inList;
    if (await toggleList(item.seriesId ?? item.id, was)) { if (inList !== was) dispatch('listtoggle', { item, inList: !was }); } else flash();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article class="card" class:poster={!!posterSrc} class:dpv-src={hp && wide} bind:this={cardEl} on:mouseenter={cardEnter} on:mouseleave={cardLeave} on:focusin={onFocusIn} on:focusout={onFocusOut} on:keydown={onKey}>
  <div class="tw" bind:this={twEl} use:rowTilt>
  <span class="tw-shadow" aria-hidden="true"></span>
  <div class="media">
  <a class="thumb" class:art={!!src} {href} bind:this={thumbEl} on:keydown={thumbKeyDown} on:keyup={thumbKeyUp} aria-label={epSub ? `${item.seriesName}, ${epSub}` : item.name + (sub ? ', ' + sub : '')}>
    {#if posterOnly}<img class="blur" loading="lazy" decoding="async" {src} srcset={srcs} {sizes} alt="" aria-hidden="true" />{/if}
    {#if src}<img bind:this={imgEl} use:decodeFade class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} loading={priority ? 'eager' : 'lazy'} fetchpriority={priority ? 'high' : undefined} decoding="async" {src} srcset={srcs} {sizes} alt="" width={posterSrc ? 200 : 320} height={posterSrc ? 300 : 180} />{/if}
    {#if tag?.kind === 'leaving'}<span class="newep leave">{$t(tag.key, { n: tag.n })}</span>
    {:else if tag && (tag.label === 'new' || tag.label === 'newSeries')}<span class="brand"><Logo size={16} label="" /><span class="neu">{$t(tag.key)}</span></span>
    {:else if tag}<span class="newep">{$t(tag.key)}</span>{/if}
    <span class="cap" class:big={!src}>{#if epSub}<span class="l1">{item.seriesName}</span> <span class="l2">{epSub}</span>{:else}{item.name}{/if}</span>
    {#if pct}<span class="progress"><i style="width:{pct}%"></i></span>{/if}
    <span class="tw-band" aria-hidden="true"></span><span class="tw-glare" aria-hidden="true"></span>
  </a>
  {#if removable}<button class="rm" aria-label={$t('home.card.removeResume')} on:click={() => dispatch('remove', item)}><Icon name="x" size={14} /></button>{/if}
  <div class="fb" role="status">{#if fb}<span>{fb}</span>{/if}</div>
  <button type="button" class="mb" bind:this={moreBtn} aria-label={$t('home.card.actionsFor', { name: item.name })} aria-haspopup="dialog" aria-expanded={sheet} on:click={openSheet}><span aria-hidden="true">⋯</span></button>
  </div>
  </div>
</article>
{#if (hp && wide) || closing}
  {#key openSeq}<DeskPreview
    bind:this={dpvComp} {item} anchor={thumbEl} {href} {detail} {removable} {fav} startSrc={!posterSrc && imgEl?.complete ? imgEl.currentSrc : ''}
    bind:over={overPrev} bind:focused={focusPrev}
    on:close={(e) => closePreview(e.detail.refocus)}
    on:remove={(e) => { closePreview(); dispatch('remove', e.detail); }}
    on:listtoggle={(e) => dispatch('listtoggle', e.detail)}
    on:favchange={(e) => { fav = e.detail.favorite; dispatch('favchange', e.detail); }}
    on:listchanged={(e) => dispatch('listchanged', e.detail)}
  />{/key}
{:else if hp}
  <HoverPreview
    bind:this={hpComp} {item} anchor={thumbEl} {href} {detail} {removable} {fav} startSrc={!posterSrc && imgEl?.complete ? imgEl.currentSrc : ''}
    bind:over={overPrev} bind:focused={focusPrev}
    on:close={(e) => closePreview(e.detail.refocus)} on:exit={(e) => exitPreview(e.detail.dir)}
    on:remove={(e) => { closePreview(); dispatch('remove', e.detail); }}
    on:listtoggle={(e) => dispatch('listtoggle', e.detail)}
    on:favchange={(e) => { fav = e.detail.favorite; dispatch('favchange', e.detail); }}
    on:listchanged={(e) => dispatch('listchanged', e.detail)}
  />
{/if}

{#if sheet}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="scrim" use:portal on:click={() => closeSheet()} role="presentation" transition:scrimT></div>
  <div class="sheet tvsheet frost frost-sheet frost-safe" tabindex="-1" use:portal bind:this={sheetEl} transition:sheetT style="--fr-scrim-safe:{SCRIM_MENU}" role="dialog" aria-modal="true" aria-label={$t('home.card.actionsFor', { name: item.name })} on:keydown={sheetKey}>
    <p class="st">{item.name}</p>
    <a class="act" href={href} on:click={() => closeSheet(false)}><Icon name="play" size={20} />{$t('home.card.play')}</a>
    <button type="button" class="act" aria-haspopup={$deskActive ? undefined : 'dialog'} on:pointerenter={prefetchModal} on:click={(e) => { if (item.type !== 'Episode') primeItem(item); moreBtn?.focus(); openModal(e, detail); closeSheet(false); }}><Icon name="chevron-down" size={20} />{$t('home.card.moreInfo')}</button>
    <button type="button" class="act" on:click={() => { void toggleInList(); closeSheet(); }}><Icon name={inList ? 'check' : 'plus'} size={20} />{inList ? $t('home.card.removeFromList') : $t('home.card.addToList')}</button>
    <button type="button" class="act" aria-pressed={fav} on:click={() => { toggleFav(); closeSheet(); }}><Icon name="heart" size={20} fill={fav} />{fav ? $t('home.card.favRemove') : $t('home.card.favAdd')}</button>
    {#if item.type !== 'BoxSet' && !$kidsMode}<ListMenu itemId={item.seriesId ?? item.id} variant="row" up on:changed={(e) => dispatch('listchanged', e.detail)} />{/if}
    {#if removable}<button type="button" class="act" on:click={() => { dispatch('remove', item); closeSheet(false); }}><Icon name="x" size={20} />{$t('home.card.removeResume')}</button>{/if}
    <button type="button" class="act cancel" on:click={() => closeSheet()}>{$t('common.close')}</button>
  </div>
{/if}

<style>
  .card { position: relative; width: 100%; transform-origin: center; transition: transform var(--t-med) var(--ease) 0s; }
  .thumb { display: block; position: relative; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; transition: transform var(--t-fast) var(--ease); background: linear-gradient(135deg, #242b33, #151a20); }
  .thumb:active { transform: scale(.97); }
  .thumb:focus-visible { outline: 2px solid #fff; outline-offset: 3px; border-radius: var(--radius); }
  /* the ring's dark companion (app.css), restated here: the row card's own shadow would otherwise win over it (TV has its own ring) */
  :global(html:not(.tv)) .thumb:focus-visible { box-shadow: 0 0 0 7px var(--ring-dark); }
  :global(html:not(.tv) section.row.dk) .thumb:focus-visible { box-shadow: 0 0 0 7px var(--ring-dark), var(--fr-shadow-card); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .l1 { display: block; } .l2 { display: block; font-weight: 500; font-size: .75rem; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cap.big { align-content: center; }
  .media { position: relative; }
  .poster .thumb { aspect-ratio: 2 / 3; }
  .poster .thumb::after { background: linear-gradient(transparent 70%, rgba(0,0,0,.6)); }
  .poster .cap { font-size: .8rem; }
  .fb { position: absolute; left: .5rem; right: .5rem; top: 2.2rem; z-index: 4; pointer-events: none; }
  .fb span { display: inline-block; padding: .25rem .6rem; border-radius: 6px; background: rgba(16,20,24,.92); border: 1px solid var(--err, #e5646e); color: #fff; font-size: .78rem; font-weight: 600; }
  .rm::after { content: ''; position: absolute; inset: -8px; } /* >=44px hit area, visual size unchanged */
  /* desktop rows: while a card's wide preview is open its neighbours dim to 55 % (a black veil, opacity only) */
  :global(section.row.dk) .media::before { content: ''; position: absolute; inset: 0; z-index: 4; border-radius: var(--radius); background: #000; opacity: 0; pointer-events: none; transition: opacity 200ms ease; }
  :global(section.row.dk.dpv-dim) .card:not(.dpv-src) .media::before { opacity: .45; }
  :global(html.calm section.row.dk) .media::before { transition: none; }
  /* desktop rows (glass spec §8.7): glass-era cards (12 px radius, soft shadow) that lean toward the pointer. The tilt action moves
     the thumb, the glare, the band and the shadow by transform; the row's other cards step back while one tilts. */
  :global(section.row.dk) .media::before, :global(section.row.dk) .thumb, :global(section.row.dk) .thumb:focus-visible { border-radius: var(--fr-r-card); }
  :global(section.row.dk) .thumb { box-shadow: var(--fr-shadow-card); transform-style: preserve-3d; transition: none; }
  /* the caption floats above the art only while the card tilts (a 3D layer per caption on the whole page would cost memory) */
  :global(section.row.dk .tw.tilt-on) .cap { transform: translateZ(28px); }
  :global(section.row.dk) .tw { position: relative; perspective: 650px; }
  .tw-shadow, .tw-band, .tw-glare { display: none; }
  :global(section.row.dk) .tw-shadow { display: block; position: absolute; left: 10%; right: 10%; bottom: -8px; height: 28px; border-radius: 50%; background: rgba(0, 0, 0, .65); filter: blur(14px); opacity: .55; transform: scale(.9); pointer-events: none; }
  :global(section.row.dk) .tw-glare { display: block; position: absolute; left: 0; top: 0; z-index: 2; width: 220px; height: 220px; margin: -110px 0 0 -110px; border-radius: 50%; background: radial-gradient(closest-side, rgba(255, 255, 255, .42), rgba(255, 255, 255, .1) 55%, transparent); mix-blend-mode: soft-light; opacity: 0; transition: opacity .3s; pointer-events: none; }
  :global(section.row.dk) .tw-band { display: block; position: absolute; inset: -40% -60%; z-index: 2; background: linear-gradient(105deg, transparent 42%, rgba(255, 255, 255, .22) 50%, transparent 58%); opacity: 0; transition: opacity .3s; pointer-events: none; }
  :global(section.row.dk .tw.tilt-on) .tw-glare, :global(section.row.dk .tw.tilt-on) .tw-band { opacity: 1; }
  :global(html.m-still) .tw-shadow, :global(html.m-still) .tw-band, :global(html.m-still) .tw-glare,
  :global(html.tv) .tw-shadow, :global(html.tv) .tw-band, :global(html.tv) .tw-glare,
  :global(html.kids) .tw-shadow, :global(html.kids) .tw-band, :global(html.kids) .tw-glare { display: none; }
  :global(section.row.dk) .card { transition: transform 350ms var(--fr-out), opacity 350ms var(--fr-out); }
  :global(section.row.dk.tilt-row .card:not(:has(.tilt-on))) { opacity: .62; transform: scale(.97); }
  :global(html.m-still section.row.dk) .card { transition: none; }
  .brand { position: absolute; left: .45rem; top: .4rem; z-index: 2; pointer-events: none; display: flex; align-items: center; gap: .3rem; }
  .neu { padding: .05rem .4rem; border-radius: 3px; background: rgba(16,20,24,.78); color: #fff; font-size: .66rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
  .newep { position: absolute; left: .45rem; top: .45rem; z-index: 2; pointer-events: none; padding: .1rem .45rem; border-radius: 3px; background: var(--acc-fill); color: #fff; font-size: .68rem; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
  .newep.leave { background: #b3261e; }
  .blur { position: absolute; inset: -10%; width: 120%; height: 120%; object-fit: cover; filter: blur(18px) brightness(.55); }
  .thumb img.spoil { filter: blur(14px); transform: scale(1.1); }
  .thumb img.contain { position: relative; object-fit: contain; }
  .cap { position: absolute; left: .6rem; bottom: .5rem; right: .6rem; font-weight: 700; font-size: .85rem; text-shadow: 0 1px 6px #000, 0 0 2px #000; line-height: 1.2; }
  .cap.big { top: 0; display: grid; place-items: center; text-align: center; font-size: 1rem; padding: .5rem; }
  .thumb::after { content: ''; position: absolute; inset: 0; background: linear-gradient(transparent 55%, rgba(0,0,0,.65)); pointer-events: none; }
  .cap { z-index: 1; }
  /* the caption's own scrim (WCAG 1.4.3): a dark band under the caption only, so the picture above stays bright. It starts
     1.6rem above the text and is at least .62 black under every letter: white text then keeps 6:1 over a pure white poster
     (lib/a11y/contrast.test.ts reads these stops). Sized in rem so a small card gets the same cover as a big one. */
  .cap::before { content: ''; position: absolute; z-index: -1; left: -.6rem; right: -3rem; top: -1.6rem; bottom: -.5rem; background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, .62) 1.6rem, rgba(0, 0, 0, .8)); pointer-events: none; }
  .cap.big::before { display: none; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.3); z-index: 2; }
  .progress i { display: block; height: 100%; background: var(--acc); }
  .rm { display: none; position: absolute; right: .4rem; top: .4rem; z-index: 3; width: 28px; min-height: 28px; height: 28px; padding: 0; border-radius: 50%; background: rgba(16,20,24,.7); border: 1.5px solid rgba(255,255,255,.6); color: #fff; place-items: center; }
  /* desktop: the card stays static; the pop-out (HoverPreview) is rendered in <body>. Subtle brightness only (switched at once:
     only transform / opacity animate) */
  @media (hover: hover) and (pointer: fine) {
    .thumb { transition: transform var(--t-fast) var(--ease); }
    .card:hover .thumb { filter: brightness(1.12); }
  }
  .mb { display: none; position: absolute; right: 0; bottom: 0; z-index: 3; width: 44px; min-height: 44px; height: 44px; padding: 0; background: none; border: 0; color: #fff; place-items: center; }
  .mb span { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: rgba(16,20,24,.7); border: 1.5px solid rgba(255,255,255,.6); font-size: 1rem; line-height: 1; padding-bottom: .3rem; }
  @media (hover: none), (pointer: coarse) { .rm { display: grid; } .mb { display: grid; } .cap { right: 2.8rem; } }
  /* TV: no small overlay buttons on the card (hard to reach with a remote); OK held opens the same actions */
  :global(html.tv) .rm, :global(html.tv) .mb { display: none; }
  :global(html.tv) .cap { right: .6rem; }
  /* TV card treatment (spec 5.1): 6 px radius, no border, the artwork speaks for itself; the title is burned in only when there is no image */
  /* focus (spec 5.2): the scale springs in (fast, tiny overshoot) and leaves on the exit curve at ~70 % of that; the ring + soft
     shadow is a layer of its own that fades in 120 ms, 60 ms after the scale started, so it never pops (opacity only) */
  :global(html.tv) .card { transition: transform calc(var(--tv-d-spring) * .7) var(--tv-emph-out) 0s; }
  :global(html.tv) .card:focus-within { transition: transform var(--tv-d-spring) var(--tv-spring) 0s; }
  :global(html.tv) .media::after { content: ''; position: absolute; inset: 0; z-index: 4; border-radius: var(--tv-radius); box-shadow: var(--tv-card-ring); opacity: 0; pointer-events: none; transition: opacity calc(var(--tv-d-xs) * .7) ease-in; }
  :global(html.tv) .card:focus-within .media::after { opacity: 1; transition: opacity var(--tv-d-xs) ease-out 60ms; }
  :global(html.tv) .thumb { border-radius: var(--tv-radius); background: #1a1a1a; }
  :global(html.tv) .thumb.art .cap, :global(html.tv) .thumb.art::after { display: none; }
  :global(html.tv) .cap.big { font-size: 1.25rem; font-weight: 600; line-height: 1.25; text-shadow: none; color: var(--tv-white-88); padding: 1rem; }
  :global(html.tv) .cap.big .l2 { font-size: .9375rem; font-weight: 500; color: var(--mut); }
  :global(html.tv) .progress { left: .625rem; right: .625rem; bottom: .625rem; height: 4px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .22); }
  :global(html.tv) .progress i { border-radius: 2px; }
  :global(html.tv) .newep, :global(html.tv) .neu { padding: .15rem .5rem; border-radius: 4px; font-size: .9375rem; font-weight: 600; letter-spacing: .02em; text-transform: none; }
  :global(html.tv) .newep { left: .625rem; top: .625rem; }
  :global(html.tv) .brand { left: .625rem; top: .625rem; }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 84; }
  /* a glass bottom sheet (glass spec §5: .frost .frost-sheet, top corners 26 px) */
  .sheet { outline: none; position: fixed; z-index: 85; left: 0; right: 0; bottom: 0; max-width: 560px; margin: 0 auto; border-bottom: 0; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding: .6rem .6rem calc(.6rem + var(--safe-bottom)); display: flex; flex-direction: column; gap: .1rem; }
  /* TV: the card's actions (OK held) as a centred dialog instead of a bottom sheet */
  :global(html.tv) .sheet { top: 50%; bottom: auto; left: 50%; right: auto; width: min(36rem, 80vw); transform: translate(-50%, -50%); border-radius: 14px; border-bottom: 1px solid var(--fr-line); padding: 1rem; }
  :global(html.tv) .act { min-height: 56px; font-size: 1.1rem; justify-content: flex-start; }
  .st { margin: .2rem 1rem .5rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act { display: flex; gap: .8rem; align-items: center; min-height: 48px; padding: 0 1rem; border: 0; border-radius: 12px; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; text-decoration: none; }
  .act:hover, .act:focus-visible { background: var(--fr-sel); }
  .cancel { justify-content: center; color: rgba(255,255,255,.9); margin-top: .2rem; }
  .cancel:hover, .cancel:focus-visible { color: #fff; } /* on the light pill: white */
</style>
