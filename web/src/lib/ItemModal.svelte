<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, backdrop, fmtMin, logoUrl, type Item } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  import { listIds, toggleList } from '$lib/stores';

  export let id: string;
  let item: Item | null = null, next: Item | null = null, closeBtn: HTMLButtonElement, box: HTMLDivElement, failed = false, logoFailed = false;
  let opener: Element | null = null;

  $: id, load();
  async function load() {
    item = null; failed = false; logoFailed = false;
    try {
      item = (await api(`/api/items/${id}`)).item;
      if (item?.type === 'Series') next = (await api('/api/library/nextup')).items.find((e: Item) => e.seriesId === id) ?? null;
      // TV: the play button is the natural first stop (the close button is reached with Back)
      if (document.documentElement.classList.contains('tv')) tick().then(() => box?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    } catch { failed = true; }
  }
  $: inList = item ? $listIds.has(item.id) : false;
  $: play = item ? (item.type === 'Series' ? (next ? `/watch/${next.id}` : `/item/${item.id}`) : `/watch/${item.id}`) : '';

  const close = () => history.back();
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab' && box) { // keep focus inside the dialog
      const f = [...box.querySelectorAll<HTMLElement>('a[href],button:not([disabled])')];
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
    tick().then(() => closeBtn?.focus());
    return () => { document.body.style.overflow = ''; (opener as HTMLElement | null)?.focus?.(); };
  });
</script>

<svelte:window on:keydown={key} />
<div class="scrim" on:click={close} role="presentation"></div>
<div class="modal" role="dialog" aria-modal="true" aria-label={item?.name ?? 'Details'} bind:this={box}>
  <button class="x" bind:this={closeBtn} aria-label="Schließen" on:click={close}><Icon name="x" size={22} /></button>
  <div class="top">
    {#if item?.backdrop}<img class="bg" src={backdrop(item.id, 1000)} alt="" />{/if}
    <div class="fade"></div>
    {#if item}
      <div class="cap">
        {#if item.logo && !logoFailed}<img class="tlogo" src={logoUrl(item.id)} alt={item.name} on:error={() => (logoFailed = true)} />{:else}<h2>{item.name}</h2>{/if}
        <div class="btns">
          <a class="btn light" data-autofocus href={play}><Icon name="play" size={22} />{item.type === 'Series' && next ? `S${next.parentIndexNumber}:E${next.indexNumber}` : 'Abspielen'}</a>
          <button class="round" aria-pressed={inList} aria-label={inList ? 'Von Meine Liste entfernen' : 'Zu Meine Liste hinzufügen'} on:click={() => toggleList(item!.id, inList)}><Icon name={inList ? 'check' : 'plus'} size={20} /></button>
        </div>
      </div>
    {:else if failed}<p class="err pad">Titel konnte nicht geladen werden.</p>{:else}<div class="skeleton fillsk"></div>{/if}
  </div>
  {#if item}
    <div class="info">
      <div>
        <p class="meta">{#if item.communityRating}<span class="match">{Math.round(item.communityRating * 10)}% Match</span>{/if}{#if item.year}<span>{item.year}</span>{/if}{#if item.rating}<span class="age">{item.rating}</span>{/if}{#if item.type !== 'Series' && item.runtimeTicks}<span>{fmtMin(item.runtimeTicks)}</span>{/if}</p>
        <p>{item.overview ?? 'Keine Beschreibung vorhanden.'}</p>
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
  @media (max-width: 640px) { .modal { top: 0; width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; } .info { grid-template-columns: 1fr; padding: 1rem 1.2rem 5rem; } .cap { left: 1.2rem; } }
</style>
