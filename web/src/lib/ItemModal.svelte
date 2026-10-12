<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, backdrop, srcset, MODAL_SIZES, MODAL_WIDTHS, fmtMin, logoUrl, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { listIds, toggleList, prefs } from '#lib/stores';
  import ListMenu from '#lib/ListMenu.svelte';
  import { isSpoiler } from '#lib/spoiler';
  import DownloadButton from '#lib/DownloadButton.svelte';

  export let id: string;
  let item: Item | null = null, next: Item | null = null, closeBtn: HTMLButtonElement, box: HTMLDivElement, scrim: HTMLDivElement, failed = false, logoFailed = false;
  let opener: Element | null = null;

  $: id, load();
  let seq = 0;
  async function load() {
    const my = ++seq, want = id;
    item = null; next = null; failed = false; logoFailed = false;
    let it: Item;
    try { it = (await api(`/api/items/${want}`)).item; } catch { if (my === seq) failed = true; return; }
    if (my !== seq) return;
    item = it;
    if (it.type === 'Series') {
      // next-up is a nicety: without it the play button just opens the detail page
      try { const n = ((await api('/api/library/nextup')).items as Item[]).find((e) => e.seriesId === want) ?? null; if (my === seq) next = n; } catch { /* optional */ }
      if (my !== seq) return;
    }
    // TV: the play button is the natural first stop (the close button is reached with Back)
    if (document.documentElement.classList.contains('tv')) tick().then(() => box?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
  }
  $: inList = item ? $listIds.has(item.id) : false;
  $: play = item ? (item.type === 'Series' ? (next ? `/watch/${next.id}` : `/item/${item.id}`) : `/watch/${item.id}`) : '';

  const close = () => history.back();
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab' && box) { // keep focus inside the dialog
      const f = [...box.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  const full = () => goto(`/item/${id}`);

  onMount(() => {
    opener = document.activeElement;
    document.body.style.overflow = 'hidden';
    // everything behind the dialog (siblings of the scrim/dialog in the app root) becomes inert
    const inerted: HTMLElement[] = [];
    for (const el of Array.from(scrim?.parentElement?.children ?? []) as HTMLElement[]) {
      if (el === scrim || el === box || el.tagName === 'SCRIPT' || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', ''); inerted.push(el);
    }
    tick().then(() => closeBtn?.focus());
    return () => { document.body.style.overflow = ''; for (const el of inerted) el.removeAttribute('inert'); (opener as HTMLElement | null)?.focus?.(); };
  });
</script>

<svelte:window on:keydown={key} />
<div class="scrim" bind:this={scrim} on:click={close} role="presentation"></div>
<div class="modal" role="dialog" aria-modal="true" aria-label={item ? undefined : 'Details'} aria-labelledby={item ? 'modal-title' : undefined} bind:this={box}>
  <button class="x" bind:this={closeBtn} aria-label="Schließen" on:click={close}><Icon name="x" size={22} /></button>
  <div class="top">
    {#if item?.backdrop}<img class="bg" src={backdrop(item.id, 960)} srcset={srcset('Backdrop', item.id, MODAL_WIDTHS)} sizes={MODAL_SIZES} alt="" />{/if}
    <div class="fade"></div>
    {#if item}
      <div class="cap">
        {#if item.logo && !logoFailed}<img class="tlogo" src={logoUrl(item.id)} alt="" on:error={() => (logoFailed = true)} /><h2 id="modal-title" class="sr">{item.name}</h2>{:else}<h2 id="modal-title">{item.name}</h2>{/if}
        <div class="btns">
          <a class="btn light" data-autofocus href={play}><Icon name="play" size={22} />{item.type === 'Series' && next ? `S${next.parentIndexNumber}:E${next.indexNumber}` : 'Abspielen'}</a>
          <button class="round" aria-pressed={inList} aria-label={inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste hinzufügen'} on:click={() => toggleList(item!.id, inList)}><Icon name={inList ? 'check' : 'plus'} size={20} /></button>
          <ListMenu itemId={item.id} variant="round" size={44} />
          {#if item.type !== 'Series'}<DownloadButton itemId={item.id} compact />{/if}
        </div>
      </div>
    {:else if failed}<p class="err pad">Titel konnte nicht geladen werden.</p>{:else}<div class="skeleton fillsk"></div>{/if}
  </div>
  {#if item}
    <div class="info">
      <div>
        <p class="meta">{#if item.communityRating}<span class="match">{Math.round(item.communityRating * 10)}% Match</span>{/if}{#if item.year}<span>{item.year}</span>{/if}{#if item.rating}<span class="age">{item.rating}</span>{/if}{#if item.type !== 'Series' && item.runtimeTicks}<span>{fmtMin(item.runtimeTicks)}</span>{/if}</p>
        <p>{isSpoiler(item, $prefs) ? 'Beschreibung ausgeblendet (Spoilerschutz).' : (item.overview ?? 'Keine Beschreibung vorhanden.')}</p>
      </div>
      <div class="side">
        {#if item.genres.length}<p><span class="muted">Genres:</span> {item.genres.join(', ')}</p>{/if}
        <button class="sec" on:click={full}>Alle Details &amp; Folgen<Icon name="chevron-right" size={18} /></button>
      </div>
    </div>
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.75); z-index: 80; animation: fade var(--t-med) var(--ease); }
  .modal { position: fixed; z-index: 81; left: 50%; top: 5vh; transform: translateX(-50%); width: min(880px, 96vw); max-height: 90vh; overflow: auto; background: var(--surface); border-radius: 10px; box-shadow: 0 20px 60px #000; animation: pop var(--t-med) var(--ease); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
  .x { position: absolute; right: .8rem; top: .8rem; z-index: 5; width: 40px; min-height: 40px; height: 40px; padding: 0; border-radius: 50%; background: rgba(24,24,24,.85); }
  .top { position: relative; aspect-ratio: 16 / 9; background: #0e0e0e; overflow: hidden; }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .fade { position: absolute; inset: 0; background: linear-gradient(to top, var(--surface) 2%, transparent 55%); }
  .fillsk { position: absolute; inset: 0; border-radius: 0; }
  .cap { position: absolute; left: 2.2rem; right: 2rem; bottom: 1.6rem; z-index: 2; display: flex; flex-direction: column; gap: 1rem; }
  h2 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.6rem); text-shadow: 0 2px 14px rgba(0,0,0,.7); }
  .tlogo { max-width: min(70%, 22rem); max-height: 7rem; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 4px 14px rgba(0,0,0,.7)); }
  .btns { display: flex; gap: .7rem; align-items: center; }
  .round { width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.7); border: 2px solid rgba(255,255,255,.55); }
  .round:hover:not(:disabled) { border-color: #fff; }
  .info { display: grid; grid-template-columns: 2fr 1fr; gap: 2rem; padding: 1rem 2.2rem 2rem; }
  .meta { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; color: #d2d2d2; margin: 0 0 .6rem; }
  .match { color: var(--ok); font-weight: 700; } .age { border: 1px solid rgba(255,255,255,.4); padding: 0 .35rem; font-size: .85rem; }
  .side { display: flex; flex-direction: column; gap: 1rem; font-size: .92rem; } .pad { padding: 2rem; }
  @keyframes fade { from { opacity: 0; } } @keyframes pop { from { opacity: 0; transform: translate(-50%, 18px) scale(.97); } }
  @media (hover: none), (pointer: coarse) { .x { width: 44px; min-height: 44px; height: 44px; } }
  @media (max-width: 640px) { .modal { top: 0; width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; } .info { grid-template-columns: 1fr; padding: 1rem 1.2rem 5rem; } .cap { left: 1.2rem; } }
</style>
