<script lang="ts">
  import { api, backdrop, img, srcset, CARD_SIZES, CARD_WIDTHS, fmtMin, type Item } from '#lib/api';
  import { listIds, toggleList } from '#lib/stores';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import ListMenu from '#lib/ListMenu.svelte';
  import { openModal } from '#lib/modal';
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { prefs } from '#lib/stores';
  import { isSpoiler } from '#lib/spoiler';
  import { hasNewEpisodes } from '#lib/badges';
  import { playPreview, previewFailed, stopPreview, previewOwner, toggleSound } from '#lib/preview';

  export let item: Item;
  /** shows a remove (X) button and emits `remove` (used for Weiterschauen) */
  export let removable = false;
  const dispatch = createEventDispatcher<{ remove: Item }>();
  let fav = item.favorite;
  $: fav = item.favorite; // follow the item when the list re-renders with fresh data
  $: href = item.type === 'Episode' ? `/watch/${item.id}` : item.type === 'BoxSet' ? `/library/${item.id}` : `/item/${item.id}`;
  $: detail = item.type === 'Episode' && item.seriesId ? `/item/${item.seriesId}` : `/item/${item.id}`;
  $: src = item.backdrop ? backdrop(item.id, 520) : item.image ? img(item.id, 520) : '';
  // one URL for blur + main image (identical strings: a single request); the srcset widths are the same for both
  $: srcs = item.backdrop ? srcset('Backdrop', item.id, CARD_WIDTHS) : item.image ? srcset('Primary', item.id, CARD_WIDTHS) : '';
  $: epSub = item.type === 'Episode' && item.seriesName ? `S${item.parentIndexNumber ?? '?'}·E${item.indexNumber ?? '?'} ${item.name}` : '';
  $: posterOnly = !item.backdrop && item.image; // poster (2:3) in a 16:9 slot: show it contained on a blurred copy
  $: sub = item.type === 'Episode' ? `${item.seriesName ?? ''} · S${item.parentIndexNumber ?? '?'}:E${item.indexNumber ?? '?'}` : '';
  $: pct = item.positionTicks && item.runtimeTicks ? Math.min(100, (item.positionTicks / item.runtimeTicks) * 100) : 0;
  $: inList = $listIds.has(item.seriesId ?? item.id);
  $: fresh = hasNewEpisodes(item, Date.now());
  $: score = item.communityRating ? Math.round(item.communityRating * 10) : 0;

  // Trailer preview (with sound once the browser allows it, toggle button on the video) after hovering ~1.2 s (only titles with a local trailer, only real pointers, one at a time)
  let pv: HTMLVideoElement, hoverT: ReturnType<typeof setTimeout>, previewing = false, vmuted = true;
  const canHover = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  function enter() {
    clearTimeout(hoverT); // mouseenter + focusin both call this: never keep two timers (two previews) alive
    if (previewing || !canHover || previewFailed(item.id) || !$prefs.hoverTrailers || !(item.trailers || ($prefs.hoverClip && (item.type === 'Movie' || item.type === 'Series')))) return;
    hoverT = setTimeout(async () => { previewing = true; if (!(await playPreview(item.id, () => pv))) previewing = false; }, 1200);
  }
  // keyboard focus only: a mouse click on the heart/plus must not start (or pin) a preview
  function onFocusIn(e: FocusEvent) { if ((e.target as HTMLElement).matches(':focus-visible')) enter(); }
  // after a mouse click drop the focus again, otherwise :focus-within keeps the card scaled and the pop-up open forever
  function release(e: MouseEvent) { if (e.detail > 0) (e.currentTarget as HTMLElement).blur(); }
  function leave() { clearTimeout(hoverT); if (previewing) { stopPreview(item.id); previewing = false; } }
  $: if ($previewOwner !== item.id && previewing) previewing = false; // owner is claimed synchronously in playPreview()
  onDestroy(leave);

  // ---- touch action sheet (the hover pop-up is not reachable without a pointer) ----
  let sheet = false, sheetEl: HTMLDivElement, moreBtn: HTMLButtonElement;
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  async function openSheet() { sheet = true; await tick(); sheetEl?.querySelector<HTMLElement>('a[href],button')?.focus(); }
  function closeSheet(refocus = true) { sheet = false; if (refocus) moreBtn?.focus(); }
  function sheetKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const f = [...sheetEl.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')];
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  async function toggleFav() { fav = !fav; try { await api(`/api/items/${item.id}/favorite`, { method: fav ? 'POST' : 'DELETE' }); } catch { fav = !fav; } }
</script>

<article class="card" on:mouseenter={enter} on:mouseleave={leave} on:focusin={onFocusIn} on:focusout={leave}>
  <div class="media">
  <a class="thumb" {href} aria-label={item.name + (sub ? ', ' + sub : '')}>
    {#if posterOnly}<img class="blur" loading="lazy" decoding="async" {src} srcset={srcs} sizes={CARD_SIZES} alt="" aria-hidden="true" />{/if}
    {#if src}<img class:contain={posterOnly} class:spoil={isSpoiler(item, $prefs)} loading="lazy" decoding="async" {src} srcset={srcs} sizes={CARD_SIZES} alt="" width="320" height="180" />{/if}
    <span class="brand" aria-hidden="true"><Logo size={18} label="" /></span>
    {#if fresh}<span class="newep">Neue Folgen</span>{/if}
    {#if previewing}<!-- svelte-ignore a11y_media_has_caption --><video bind:this={pv} class="pv" loop playsinline on:volumechange={() => (vmuted = pv.muted)} on:playing={() => (vmuted = pv.muted)}></video>{/if}
    <span class="cap" class:big={!src}>{#if epSub}<span class="l1">{item.seriesName}</span><span class="l2">{epSub}</span>{:else}{item.name}{/if}</span>
    {#if pct}<span class="progress"><i style="width:{pct}%"></i></span>{/if}
  </a>
  {#if removable}<button class="rm" aria-label="Aus Weiterschauen entfernen" on:click={() => dispatch('remove', item)}><Icon name="x" size={14} /></button>{/if}
  <button type="button" class="mb" bind:this={moreBtn} aria-label="Aktionen für {item.name}" aria-haspopup="dialog" aria-expanded={sheet} on:click={openSheet}><span aria-hidden="true">⋯</span></button>
  {#if previewing}<button class="snd" aria-label={vmuted ? 'Ton einschalten' : 'Ton ausschalten'} aria-pressed={!vmuted} on:click={(e) => { release(e); toggleSound(pv); }}><Icon name={vmuted ? 'volume-off' : 'volume'} size={16} /></button>{/if}
  </div>
  <div class="pop">
    <div class="acts">
      <a class="round play" href={href} aria-label="Abspielen"><Icon name="play" size={18} /></a>
      <button class="round" aria-label={inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste hinzufügen'} on:click={(e) => { release(e); toggleList(item.seriesId ?? item.id, inList); }}><Icon name={inList ? 'check' : 'plus'} size={18} /></button>
      <button class="round" class:on={fav} aria-label={fav ? 'Favorit entfernen' : 'Als Favorit markieren'} aria-pressed={fav} on:click={(e) => { release(e); toggleFav(); }}><Icon name="heart" size={17} fill={fav} /></button>
      {#if item.type !== 'BoxSet'}<ListMenu itemId={item.seriesId ?? item.id} variant="round" />{/if}
      {#if removable}<button class="round" aria-label="Aus Weiterschauen entfernen" title="Aus Weiterschauen entfernen" on:click={(e) => { release(e); dispatch('remove', item); }}><Icon name="x" size={17} /></button>{/if}
      <a class="round more" href={detail} aria-label="Mehr Infos" aria-haspopup="dialog" on:click={(e) => openModal(e, detail)}><Icon name="chevron-down" size={18} /></a>
    </div>
    <div class="meta">
      {#if score}<span class="match">{score}% Match</span>{/if}
      {#if item.rating}<span class="age">{item.rating}</span>{/if}
      {#if item.runtimeTicks && item.type !== 'Series'}<span>{fmtMin(item.runtimeTicks)}</span>{/if}
      {#if item.type === 'Series'}<span>Serie</span>{/if}
    </div>
    {#if item.caption}<div class="sub cap2">{item.caption}</div>{:else if sub}<div class="sub">{sub}</div>{:else if item.genres.length}<div class="sub">{item.genres.slice(0, 3).join(' • ')}</div>{/if}
  </div>
</article>

{#if sheet}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="scrim" use:portal on:click={() => closeSheet()} role="presentation"></div>
  <div class="sheet" tabindex="-1" use:portal bind:this={sheetEl} role="dialog" aria-modal="true" aria-label="Aktionen für {item.name}" on:keydown={sheetKey}>
    <p class="st">{item.name}</p>
    <a class="act" href={href} on:click={() => closeSheet(false)}><Icon name="play" size={20} />Abspielen</a>
    <button type="button" class="act" aria-haspopup="dialog" on:click={(e) => { moreBtn?.focus(); openModal(e, detail); closeSheet(false); }}><Icon name="chevron-down" size={20} />Mehr Infos</button>
    <button type="button" class="act" on:click={() => { toggleList(item.seriesId ?? item.id, inList); closeSheet(); }}><Icon name={inList ? 'check' : 'plus'} size={20} />{inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste'}</button>
    <button type="button" class="act" aria-pressed={fav} on:click={() => { toggleFav(); closeSheet(); }}><Icon name="heart" size={20} fill={fav} />{fav ? 'Favorit entfernen' : 'Als Favorit markieren'}</button>
    {#if item.type !== 'BoxSet'}<ListMenu itemId={item.seriesId ?? item.id} variant="row" up />{/if}
    {#if removable}<button type="button" class="act" on:click={() => { dispatch('remove', item); closeSheet(false); }}><Icon name="x" size={20} />Aus Weiterschauen entfernen</button>{/if}
    <button type="button" class="act cancel" on:click={() => closeSheet()}>Schließen</button>
  </div>
{/if}

<style>
  .card { position: relative; width: 100%; transform-origin: center; transition: transform var(--t-med) var(--ease) 0s; }
  .thumb { display: block; position: relative; aspect-ratio: 16 / 9; border-radius: var(--radius); overflow: hidden; background: linear-gradient(135deg, #2b2b2b, #1a1a1a); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pv { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; background: #000; }
  .l1 { display: block; } .l2 { display: block; font-weight: 500; font-size: .75rem; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cap.big { align-content: center; }
  .cap2 { color: #f5c518; }
  .media { position: relative; }
  .snd::after, .rm::after { content: ''; position: absolute; inset: -8px; } /* >=44px hit area, visual size unchanged */
  .snd { position: absolute; right: .5rem; bottom: .5rem; z-index: 3; width: 30px; min-height: 30px; height: 30px; padding: 0; border-radius: 50%; background: rgba(20,20,20,.7); border: 1.5px solid rgba(255,255,255,.6); color: #fff; }
  .snd:hover:not(:disabled) { background: rgba(20,20,20,.9); border-color: #fff; }
  .brand { position: absolute; left: .45rem; top: .4rem; z-index: 2; pointer-events: none; opacity: .95; }
  .newep { position: absolute; left: .45rem; top: 1.9rem; z-index: 2; pointer-events: none; padding: .1rem .45rem; border-radius: 3px; background: var(--acc); color: #fff; font-size: .68rem; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; }
  .blur { position: absolute; inset: -10%; width: 120%; height: 120%; object-fit: cover; filter: blur(18px) brightness(.55); }
  .thumb img.spoil { filter: blur(14px); transform: scale(1.1); }
  .thumb img.contain { position: relative; object-fit: contain; }
  .cap { position: absolute; left: .6rem; bottom: .5rem; right: .6rem; font-weight: 700; font-size: .85rem; text-shadow: 0 1px 6px #000, 0 0 2px #000; line-height: 1.2; }
  .cap.big { top: 0; display: grid; place-items: center; text-align: center; font-size: 1rem; padding: .5rem; }
  .thumb::after { content: ''; position: absolute; inset: 0; background: linear-gradient(transparent 55%, rgba(0,0,0,.65)); pointer-events: none; }
  .cap { z-index: 1; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.3); z-index: 2; }
  .progress i { display: block; height: 100%; background: var(--acc); }
  .pop { position: absolute; left: 0; right: 0; top: 100%; background: var(--surface); padding: .6rem .7rem .8rem; border-radius: 0 0 var(--radius) var(--radius); opacity: 0; visibility: hidden; box-shadow: 0 14px 28px rgba(0,0,0,.6); transition: opacity var(--t-fast); pointer-events: none; }
  .acts { display: flex; gap: .4rem; }
  .round { width: 34px; min-height: 34px; height: 34px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); color: #fff; display: grid; place-items: center; }
  .round:hover:not(:disabled) { border-color: #fff; background: rgba(42,42,42,.9); }
  .round.play { background: #fff; color: #000; border-color: #fff; }
  .round.play:hover { background: rgba(255,255,255,.8); }
  .round.on { color: var(--acc); border-color: var(--acc); }
  .more { margin-left: auto; }
  .rm { display: none; position: absolute; right: .4rem; top: .4rem; z-index: 3; width: 28px; min-height: 28px; height: 28px; padding: 0; border-radius: 50%; background: rgba(20,20,20,.7); border: 1.5px solid rgba(255,255,255,.6); color: #fff; place-items: center; }
  .meta { display: flex; gap: .6rem; align-items: center; margin-top: .55rem; font-size: .78rem; color: var(--mut); flex-wrap: wrap; }
  .match { color: var(--ok); font-weight: 700; }
  .age { border: 1px solid rgba(255,255,255,.4); padding: 0 .35rem; }
  .sub { font-size: .76rem; margin-top: .3rem; color: #d2d2d2; }

  /* Hover preview only for real pointers; touch devices simply tap through to the detail page. */
  @media (hover: hover) and (pointer: fine) {
    .card:hover, .card:has(:focus-visible) { z-index: 6; transform: scale(1.32); transition-delay: .35s; }
    :global(.slot:first-child) .card { transform-origin: left center; }
    :global(.slot:last-child) .card { transform-origin: right center; }
    .card:hover .pop, .card:has(:focus-visible) .pop { opacity: 1; visibility: visible; pointer-events: auto; transition-delay: .35s; }
  }
  .mb { display: none; position: absolute; right: 0; bottom: 0; z-index: 3; width: 44px; min-height: 44px; height: 44px; padding: 0; background: none; border: 0; color: #fff; place-items: center; }
  .mb span { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: rgba(20,20,20,.7); border: 1.5px solid rgba(255,255,255,.6); font-size: 1rem; line-height: 1; padding-bottom: .3rem; }
  @media (hover: none), (pointer: coarse) { .pop { display: none; } .rm { display: grid; } .mb { display: grid; } .cap { right: 2.8rem; } }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 84; }
  .sheet { outline: none; position: fixed; z-index: 85; left: 0; right: 0; bottom: 0; max-width: 560px; margin: 0 auto; background: var(--surface); border-radius: 14px 14px 0 0; padding: .6rem .6rem calc(.6rem + env(safe-area-inset-bottom)); box-shadow: 0 -10px 40px rgba(0,0,0,.7); display: flex; flex-direction: column; gap: .1rem; }
  .st { margin: .2rem 1rem .5rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act { display: flex; gap: .8rem; align-items: center; min-height: 48px; padding: 0 1rem; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; text-decoration: none; }
  .act:hover, .act:focus-visible { background: rgba(255,255,255,.08); }
  .cancel { justify-content: center; color: var(--mut); margin-top: .2rem; }
</style>
