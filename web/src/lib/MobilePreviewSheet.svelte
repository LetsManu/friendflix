<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import DownloadButton from '#lib/DownloadButton.svelte';
  import RatingButton from '#lib/RatingButton.svelte';
  import { dialogKeys } from '#lib/actions';
  import { isSpoiler } from '#lib/spoiler';
  import { listIds, prefs, toggleList } from '#lib/stores';
  import { closePreview, previewSheet } from '#lib/previewSheet';
  import { itemPath, playPath, runtimeLabel, shareData } from '#lib/mobile';
  import { playOrCast } from '#lib/cast/playOrCast';
  import { kidsMode } from '#lib/kids';
  import { motionAllowed } from '#lib/preview';
  import { reasonText } from '#lib/reason';
  import { ratingLoader } from '#lib/hoverShared';
  import type { Thumb } from '#lib/rating';
  import { dragClose } from '#lib/phone/dragClose';
  import { t, tr } from '#lib/i18n';

  /**
   * Bottom sheet that opens when a poster is tapped (phone layout; spec 2026-11-08 §3). Mounted once in +layout.svelte while the
   * phone layout is on; state in `previewSheet`. It springs up over a dim; drag down / the dim / Esc / ✕ close it with an exit
   * (instant under reduced motion or calm), drag up or Details open the full page. A close from outside (navigation, leaving
   * the phone layout) drops it at once: the page transition carries it away.
   */
  /** `me.downloads.allowed` (the layout's `canDownload`) */
  export let canDownload = false;

  const OUT_MS = 280;
  let shown: { item: Item; opener?: HTMLElement | null } | null = null, leaving = false, outT: ReturnType<typeof setTimeout> | undefined;
  let sheetEl: HTMLElement | undefined, note = '', noteT: ReturnType<typeof setTimeout>, thumb: Thumb = 0;

  $: sync($previewSheet);
  function sync(s: typeof $previewSheet) {
    if (s && s !== shown) { gone(); shown = s; open(s.item); }
    else if (!s && shown && !leaving) gone(); // closed from outside (navigation, desktop layout): no exit
  }
  function gone() { clearTimeout(outT); outT = undefined; leaving = false; shown = null; }
  function open(it: Item) {
    thumb = 0; note = '';
    if (it.type !== 'BoxSet') { const id = it.seriesId ?? it.id; void ratingLoader(id, (v) => { if (shown?.item === it) thumb = v; }).load(); }
    void tick().then(() => sheetEl?.querySelector<HTMLElement>('.close')?.focus());
  }
  onDestroy(() => { clearTimeout(outT); clearTimeout(noteT); });

  /** close with the exit animation (unless motion is off); the opener gets focus back */
  function close(refocus = true, instant = false) {
    if (!shown || leaving) return;
    const op = shown.opener;
    if (!instant && motionAllowed()) { leaving = true; clearTimeout(outT); outT = setTimeout(gone, OUT_MS + 80); }
    closePreview();
    if (instant || !leaving) gone();
    if (refocus && op && document.contains(op)) op.focus();
  }
  function outEnd(e: TransitionEvent) { if (leaving && e.target === e.currentTarget && e.propertyName === 'transform') gone(); }
  /** the full page; the navigation closes the sheet (layout) and the page transition crossfades it away */
  function details() { if (shown && !leaving) void goto(itemPath(shown.item)); }

  $: item = shown?.item;
  $: listId = item ? item.seriesId ?? item.id : '';
  $: posterId = item ? (item.type === 'Episode' && item.seriesId ? item.seriesId : item.id) : '';
  $: hasPoster = item ? (item.type === 'Episode' ? Boolean(item.seriesId) : item.image) : false;
  $: inList = item ? $listIds.has(listId) : false;
  $: meta = item ? [item.year ? String(item.year) : '', runtimeLabel(item)].filter(Boolean) : [];
  $: hidden = item ? isSpoiler(item, $prefs) : false;
  $: downloadable = canDownload && !!item && (item.type === 'Movie' || item.type === 'Episode');
  $: why = reasonText(item?.reason, $t);

  function say(msg: string) { note = msg; clearTimeout(noteT); noteT = setTimeout(() => (note = ''), 3500); }
  async function share() {
    if (!item) return;
    const d = shareData(item, location.origin);
    try {
      if (navigator.share) { await navigator.share(d); return; }
    } catch (e) { if ((e as DOMException)?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(d.url); say(tr('home.card.linkCopied')); }
    catch { say(d.url); }
  }
  async function list() {
    if (!item) return;
    if (!(await toggleList(listId, inList))) say(tr('home.card.saveFailed'));
  }
  function play(e: MouseEvent) {
    if (!item) return;
    if (item.type !== 'Series' && item.type !== 'BoxSet') playOrCast(e, item);
    close(false, !e.defaultPrevented); // to the player: gone at once; cast to the TV: the sheet leaves normally
  }
</script>

{#if item}
  {#key shown}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="dim" class:out={leaving} on:click={() => close()}></div>
    <div class="sheet" class:out={leaving} inert={leaving || undefined} role="dialog" aria-modal="true" aria-label={$t('home.card.preview', { name: item.name })} tabindex="-1" bind:this={sheetEl} use:dialogKeys={{ close: () => close() }} use:dragClose={{ close: () => close(), open: details }} on:transitionend={outEnd}>
      <div class="grab"><span class="handle" aria-hidden="true"></span></div>
      {#if why}<p class="why">{why}</p>{/if}
      <div class="hd">
        {#if hasPoster}<img class="poster" src={img(posterId, 240)} alt="" width="92" height="138" />{:else}<span class="poster none" aria-hidden="true"></span>{/if}
        <div class="info">
          <h2>{item.type === 'Episode' && item.seriesName ? item.seriesName : item.name}</h2>
          <p class="meta">
            {#each meta.slice(0, 1) as m}<span>{m}</span>{/each}
            {#if item.rating}{#if meta.length}<span class="dot" aria-hidden="true">·</span>{/if}<span class="age" aria-label={$t('home.card.ageRating', { rating: item.rating })}>{item.rating}</span>{/if}
            {#each meta.slice(1) as m}<span class="dot" aria-hidden="true">·</span><span>{m}</span>{/each}
          </p>
          {#if item.type === 'Episode'}<p class="ep">S{item.parentIndexNumber ?? '?'}:E{item.indexNumber ?? '?'} · {item.name}</p>{/if}
          {#if item.overview}<p class="ov">{hidden ? $t('home.card.spoilerHidden') : item.overview}</p>{/if}
        </div>
        <button type="button" class="close" aria-label={$t('common.close')} on:click={() => close()}><Icon name="x" size={16} /></button>
      </div>
      <div class="acts">
        <a class="play" href={playPath(item)} on:click={play}><Icon name="play" size={20} />{item.positionTicks ? $t('home.card.resume') : $t('home.card.play')}</a>
        {#if downloadable}<span class="dlw"><DownloadButton itemId={item.id} seriesId={item.seriesId ?? ''} block /></span>{/if}
      </div>
      <div class="row">
        <button type="button" class="act" aria-pressed={inList} on:click={list}><Icon name={inList ? 'check' : 'plus'} size={22} /><small>{$t('home.card.myList')}</small></button>
        {#if item.type !== 'BoxSet'}<span class="act rate"><RatingButton itemId={listId} bind:value={thumb} size={44} showLabel up on:error={() => say(tr('home.card.saveFailed'))} /></span>{/if}
        {#if !$kidsMode}<button type="button" class="act" on:click={share}><Icon name="share" size={22} /><small>{$t('home.card.share')}</small></button>{/if}
        <a class="act details" href={itemPath(item)}><Icon name="info" size={22} /><small>{$t('detail.view.details')}</small></a>
      </div>
      <p class="note" role="status">{note}</p>
    </div>
  {/key}
{/if}

<style>
  /* spring in (the shared --m-spring), leave at the release point with the emphasised ease-in; html.m-still: no motion */
  .dim { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.55); animation: fade 300ms ease-out; }
  .dim.out { opacity: 0; transition: opacity 280ms var(--m-emph-in); pointer-events: none; }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 91; max-width: 560px; margin: 0 auto; max-height: min(88dvh, calc(100dvh - var(--safe-top) - .5rem)); overflow-y: auto; overscroll-behavior: contain; outline: none; background: #18181c; border-radius: 22px 22px 0 0; padding: 0 max(var(--pad-x), var(--safe-right)) calc(1.2rem + var(--safe-bottom)) max(var(--pad-x), var(--safe-left)); box-shadow: 0 -10px 40px rgba(0,0,0,.5); animation: rise var(--m-d-spring) var(--m-spring); transition: transform var(--m-d-spring) var(--m-spring); }
  .sheet:global(.dragging) { transition: none; }
  .sheet.out { transform: translateY(100%); transition: transform 280ms var(--m-emph-in); pointer-events: none; }
  :global(html.m-still) .sheet, :global(html.m-still) .dim { animation: none; transition: none; }
  .grab { position: sticky; top: 0; z-index: 2; touch-action: none; cursor: grab; padding: 8px 0 12px; margin: 0 calc(var(--pad-x) * -1); background: #18181c; }
  .handle { display: block; width: 38px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.3); margin: 0 auto; }
  .why { margin: 0 0 .45rem; font-size: .78rem; color: var(--mut); overflow-wrap: anywhere; }
  .hd { display: grid; grid-template-columns: 92px minmax(0, 1fr) 28px; gap: 12px; align-items: start; }
  .poster { width: 92px; height: auto; aspect-ratio: 2 / 3; border-radius: 8px; object-fit: cover; background: #242b33; display: block; }
  .info { min-width: 0; }
  h2 { font-size: 1.15rem; font-weight: 800; letter-spacing: -.01em; margin: 0 0 .25rem; line-height: 1.2; overflow-wrap: anywhere; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .4rem; margin: 0 0 .35rem; color: #d2d2d2; font-size: .82rem; }
  .dot { color: var(--mut); }
  .age { border: 1px solid #8a8a8a; padding: 0 .3rem; border-radius: 3px; font-size: .72rem; line-height: 1.45; }
  .ep { margin: 0 0 .3rem; color: var(--mut); font-size: .8rem; }
  .ov { margin: 0; font-size: .82rem; line-height: 1.4; color: #cfcfd6; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  /* 28px circle, 44px hit area */
  .close { position: relative; width: 28px; min-height: 28px; height: 28px; padding: 0; border-radius: 50%; background: rgba(255,255,255,.12); color: #fff; display: grid; place-items: center; }
  .close::after { content: ''; position: absolute; inset: -8px; }
  .close:hover:not(:disabled) { background: rgba(255,255,255,.22); }
  .acts { display: flex; gap: 8px; margin: 14px 0 12px; }
  .acts > * { flex: 1 1 0; min-width: 0; }
  .play { display: inline-flex; align-items: center; justify-content: center; gap: .45rem; min-height: 44px; background: #fff; color: #0b0b0d; font-weight: 700; font-size: .95rem; border-radius: 8px; padding: 0 .8rem; white-space: nowrap; }
  .play:hover { background: rgba(255,255,255,.85); }
  .dlw { display: flex; }
  .dlw :global(.dlb) { min-height: 44px; border-radius: 8px; background: rgba(255,255,255,.17); font-size: .95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dlw:not(:has(:global(.dlb))) { display: none; } /* unsupported here: DownloadButton renders nothing */
  .row { display: flex; justify-content: space-around; padding-top: 10px; border-top: 1px solid #26262c; }
  .act { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 4px; background: transparent; border: 0; border-radius: 6px; padding: 4px 0; min-height: 48px; line-height: 1; color: #fff; font-weight: 500; text-decoration: none; }
  .act:hover:not(:disabled) { background: transparent; }
  .act small { font-size: .7rem; font-weight: 500; color: #c4c4cc; line-height: 1.15; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .rate { padding: 0; }
  .rate :global(.trig) { padding: 4px 0; gap: 4px; color: #fff; min-height: 48px; justify-content: flex-start; }
  .rate :global(.trig .ic) { width: 22px; height: 22px; }
  .rate :global(.trig .tx) { font-size: .7rem; color: #c4c4cc; font-weight: 500; }
  .note { min-height: 1.2em; margin: .4rem 0 0; font-size: .82rem; color: var(--mut); text-align: center; }
  @keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
</style>
