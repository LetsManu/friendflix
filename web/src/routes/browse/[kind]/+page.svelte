<script lang="ts">
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { goto } from '$app/navigation';
  import { api, type Item } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { activeChips, applyDraft, browseQuery, draftOf, filterCount, parseBrowse, type FilterDraft } from '#lib/discovery';
  import { dialogKeys } from '#lib/actions';
  import { onDestroy, tick } from 'svelte';
  import { langLabel } from '#lib/langs';

  let items: Item[] | null = null, total = 0, start = 0, genres: string[] = [], langs: { audio: Array<{ code: string }>; subs: Array<{ code: string }> } = { audio: [], subs: [] }, busy = false, failed = false, seq = 0, lastKey = '';
  let personName: Record<string, string> = {};
  const PAGE = 60;
  const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950];

  $: kind = $page.params.kind === 'series' ? 'Series' : 'Movie';
  $: s = parseBrowse($page.url.searchParams);
  $: key = kind + '?' + browseQuery(s, kind, 0, PAGE).toString();
  $: if (key !== lastKey) { lastKey = key; void load(true); }
  $: decades = s.decade !== null && !DECADES.includes(s.decade) ? [...DECADES, s.decade].sort((a, b) => b - a) : DECADES;
  $: chips = activeChips(s, { person: s.person ? personName[s.person] : undefined });
  $: if (s.person && personName[s.person] === undefined) void fetchPerson(s.person);
  $: otherKind = kind === 'Series' ? 'movies' : 'series';
  $: search = $page.url.search;

  async function load(reset: boolean) {
    const my = reset ? ++seq : seq; // a newer query invalidates everything still in flight
    busy = true; failed = false;
    if (reset) { start = 0; items = null; total = 0; }
    try {
      const r = await api(`/api/library/items?${browseQuery(s, kind, start, PAGE)}`);
      if (my !== seq) return;
      items = [...(reset ? [] : items ?? []), ...r.items]; total = r.total; start += PAGE;
    } catch {
      if (my !== seq) return;
      failed = true; items = items ?? [];
    }
    if (my === seq) busy = false;
  }
  async function fetchPerson(id: string) {
    personName[id] = ''; // mark as requested (falls back to "Person")
    try { personName[id] = (await api(`/api/people/${id}`)).person?.name ?? ''; } catch { /* keep fallback */ }
    personName = personName;
  }
  $: if (!genres.length) api('/api/library/genres').then((r) => (genres = r.genres)).catch(() => undefined);

  $: if (!langs.audio.length && !langs.subs.length) api('/api/library/languages').then((r) => (langs = { audio: r.audio ?? [], subs: r.subs ?? [] })).catch(() => undefined);
  $: audioCodes = withCurrent(langs.audio.map((l) => l.code), s.audio);
  $: subCodes = withCurrent(langs.subs.map((l) => l.code), s.subs);
  const withCurrent = (codes: string[], cur: string | null) => (cur && !codes.includes(cur) ? [...codes, cur] : codes);

  function set(k: string, value: string) {
    const u = new URL($page.url.href);
    if (value) u.searchParams.set(k, value); else u.searchParams.delete(k);
    if (k === 'year') u.searchParams.delete('decade');
    if (k === 'decade') u.searchParams.delete('year');
    goto(u, { reset: false });
  }
  const reset = () => goto($page.url.pathname, { reset: false });

  // ---- phones: the row of selects becomes one "Filter" button + bottom sheet (same pattern as the "Mehr" sheet in +layout) ----
  let fsheet = false, draft: FilterDraft = { genre: '', decade: '', minRating: '', sort: 'SortName', filter: '', audio: '', subs: '' }, fbtn: HTMLButtonElement, dragY = 0, dragging = false, dragStart = 0;
  $: fcount = filterCount(s);
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };
  $: if (typeof document !== 'undefined') document.documentElement.style.overflow = fsheet ? 'hidden' : ''; // no page scroll behind the sheet
  onDestroy(() => { if (typeof document !== 'undefined') document.documentElement.style.overflow = ''; });
  function openFilters() { draft = draftOf(s); dragY = 0; fsheet = true; }
  async function closeFilters(refocus = true) { fsheet = false; dragY = 0; dragging = false; if (refocus) { await tick(); fbtn?.focus(); } }
  async function applyFilters() { await goto(applyDraft(new URL($page.url.href), draft), { reset: false }); void closeFilters(); }
  async function resetFilters() { await reset(); void closeFilters(); }
  // swipe down on the grab zone closes the sheet (threshold 80 px)
  function dragDown(e: PointerEvent) { dragging = true; dragStart = e.clientY; dragY = 0; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
  function dragMove(e: PointerEvent) { if (dragging) dragY = Math.max(0, e.clientY - dragStart); }
  function dragEnd() { if (!dragging) return; const far = dragY > 80; dragging = false; dragY = 0; if (far) void closeFilters(); }
</script>

<svelte:head><title>{kind === 'Series' ? 'Serien' : 'Filme'} – FriendFlix</title></svelte:head>
<div class="flex head">
  <h1>{kind === 'Series' ? 'Serien' : 'Filme'}{#if s.studio} · {s.studio}{/if}</h1>
  <nav class="kinds" aria-label="Typ">
    <a href="/browse/movies{search}" class:on={kind === 'Movie'} aria-current={kind === 'Movie' ? 'page' : undefined}>Filme</a>
    <a href="/browse/series{search}" class:on={kind === 'Series'} aria-current={kind === 'Series' ? 'page' : undefined}>Serien</a>
  </nav>
</div>
<svelte:window on:resize={() => { if (fsheet && window.innerWidth > 720) void closeFilters(false); }} />
<div class="flex filters">
  <button type="button" class="fbtn" bind:this={fbtn} aria-haspopup="dialog" aria-expanded={fsheet} on:click={openFilters}>Filter{#if fcount}<span class="cnt" aria-hidden="true">{fcount}</span><span class="sr-only"> ({fcount} aktiv)</span>{/if}</button>
  <div class="desk">
  <label class="sr-only" for="g">Genre</label>
  <select id="g" value={s.genre} on:change={(e) => set('genre', e.currentTarget.value)}><option value="">Alle Genres</option>{#each genres as g}<option>{g}</option>{/each}{#if s.genre && !genres.includes(s.genre)}<option>{s.genre}</option>{/if}</select>
  <label class="sr-only" for="dc">Jahrzehnt</label>
  <select id="dc" value={s.decade !== null ? String(s.decade) : ''} on:change={(e) => set('decade', e.currentTarget.value)}><option value="">Alle Jahrzehnte</option>{#each decades as d}<option value={String(d)}>{d}er</option>{/each}</select>
  <label class="sr-only" for="mr">Bewertung</label>
  <select id="mr" value={s.minRating !== null ? String(s.minRating) : ''} on:change={(e) => set('minRating', e.currentTarget.value)}><option value="">Alle Bewertungen</option><option value="6">ab 6 Sterne</option><option value="7">ab 7 Sterne</option><option value="8">ab 8 Sterne</option></select>
  <label class="sr-only" for="s">Sortierung</label>
  <select id="s" value={s.sort} on:change={(e) => set('sort', e.currentTarget.value === 'SortName' ? '' : e.currentTarget.value)}>
    <option value="SortName">A–Z</option><option value="DateCreated">Zuletzt hinzugefügt</option><option value="PremiereDate">Erscheinungsdatum</option><option value="CommunityRating">Beliebtheit</option>
  </select>
  <label class="sr-only" for="f">Status</label>
  <select id="f" value={s.filter} on:change={(e) => set('filter', e.currentTarget.value)}><option value="">Status: alle</option><option value="unplayed">Ungesehen</option><option value="played">Gesehen</option><option value="favorites">Favoriten</option></select>
  {#if audioCodes.length}
    <label class="sr-only" for="au">Ton</label>
    <select id="au" value={s.audio ?? ''} on:change={(e) => set('audio', e.currentTarget.value)}><option value="">Ton: alle</option>{#each audioCodes as c}<option value={c}>Ton: {langLabel(c)}</option>{/each}</select>
  {/if}
  {#if subCodes.length}
    <label class="sr-only" for="ut">Untertitel</label>
    <select id="ut" value={s.subs ?? ''} on:change={(e) => set('subs', e.currentTarget.value)}><option value="">Untertitel: alle</option>{#each subCodes as c}<option value={c}>Untertitel: {langLabel(c)}</option>{/each}</select>
  {/if}
  </div>
  {#if audioCodes.includes('deu')}
    <button type="button" class="chip quick" aria-pressed={s.audio === 'deu'} on:click={() => set('audio', s.audio === 'deu' ? '' : 'deu')}>Deutscher Ton</button>
  {/if}
</div>
{#if fsheet}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" use:portal on:click={() => closeFilters()}></div>
  <div class="sheet" class:dragging use:portal role="dialog" aria-modal="true" aria-label="Filter" use:dialogKeys={{ close: closeFilters, focusFirst: true }} style={dragY ? `transform:translateY(${dragY}px)` : undefined}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="grab" on:pointerdown={dragDown} on:pointermove={dragMove} on:pointerup={dragEnd} on:pointercancel={dragEnd}>
      <span class="handle" aria-hidden="true"></span>
      <h2 class="sht">Filter</h2>
    </div>
    <form on:submit|preventDefault={applyFilters}>
      <label class="fl"><span>Genre</span><select bind:value={draft.genre}><option value="">Alle Genres</option>{#each genres as g}<option value={g}>{g}</option>{/each}{#if draft.genre && !genres.includes(draft.genre)}<option value={draft.genre}>{draft.genre}</option>{/if}</select></label>
      <label class="fl"><span>Jahrzehnt</span><select bind:value={draft.decade}><option value="">Alle Jahrzehnte</option>{#each decades as d}<option value={String(d)}>{d}er</option>{/each}</select></label>
      <label class="fl"><span>Bewertung</span><select bind:value={draft.minRating}><option value="">Alle Bewertungen</option><option value="6">ab 6 Sterne</option><option value="7">ab 7 Sterne</option><option value="8">ab 8 Sterne</option></select></label>
      <label class="fl"><span>Sortierung</span><select bind:value={draft.sort}><option value="SortName">A–Z</option><option value="DateCreated">Zuletzt hinzugefügt</option><option value="PremiereDate">Erscheinungsdatum</option><option value="CommunityRating">Beliebtheit</option></select></label>
      <label class="fl"><span>Status</span><select bind:value={draft.filter}><option value="">Alle</option><option value="unplayed">Ungesehen</option><option value="played">Gesehen</option><option value="favorites">Favoriten</option></select></label>
      {#if audioCodes.length}<label class="fl"><span>Ton</span><select bind:value={draft.audio}><option value="">Alle</option>{#each audioCodes as c}<option value={c}>{langLabel(c)}</option>{/each}</select></label>{/if}
      {#if subCodes.length}<label class="fl"><span>Untertitel</span><select bind:value={draft.subs}><option value="">Alle</option>{#each subCodes as c}<option value={c}>{langLabel(c)}</option>{/each}</select></label>{/if}
      <div class="sacts"><button type="submit">Anwenden</button><button type="button" class="sec" on:click={resetFilters}>Zurücksetzen</button></div>
    </form>
  </div>
{/if}
{#if chips.length}
  <ul class="flex chips" aria-label="Aktive Filter">
    {#each chips as c (c.key)}<li><button type="button" class="chip" aria-label="Filter {c.label} entfernen" on:click={() => set(c.key, '')}>{c.label}<span aria-hidden="true"> ✕</span></button></li>{/each}
    <li><button type="button" class="sec" on:click={reset}>Alle zurücksetzen</button></li>
  </ul>
{/if}
<div class="tiles" aria-busy={items === null}>
  {#if items === null}{#each Array(18) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}
  {:else}{#each items as i (i.id)}<div class="slot"><Card item={i} /></div>{/each}{/if}
</div>
{#if failed}
  <div class="state" role="alert"><p class="err">Titel konnten nicht geladen werden.</p><button type="button" on:click={() => load(!items?.length)}>Erneut versuchen</button></div>
{:else if items && !items.length}
  <div class="state"><p class="muted">Nichts gefunden – probiere andere Filter.</p>{#if chips.length || s.sort !== 'SortName'}<button type="button" class="sec" on:click={reset}>Filter zurücksetzen</button>{/if}</div>
{/if}
{#if items && items.length < total && !failed}<p style="text-align:center"><button class="sec" disabled={busy} on:click={() => load(false)}>Mehr laden</button></p>{/if}

<style>
  .head { margin-bottom: .8rem; } .head h1 { margin: 0 1rem 0 0; }
  .kinds { display: inline-flex; gap: .3rem; }
  .kinds a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1rem; border-radius: 99px; background: var(--surface-2); font-weight: 500; }
  .kinds a.on { background: #fff; color: #000; }
  .filters { margin-bottom: 1rem; }
  .desk { display: contents; }
  .fbtn { display: none; align-items: center; gap: .5rem; min-height: 44px; padding: 0 1.1rem; border-radius: 99px; background: var(--surface-2); font-weight: 600; }
  .cnt { display: inline-grid; place-items: center; min-width: 1.4rem; height: 1.4rem; padding: 0 .3rem; border-radius: 99px; background: #fff; color: #000; font-size: .78rem; font-weight: 800; }
  .backdrop, .sheet { display: none; }
  @media (max-width: 720px) { .desk { display: none; } .fbtn { display: inline-flex; } .backdrop, .sheet { display: block; } .sheet { display: flex; } }
  .filters select { min-height: 44px; max-width: 100%; }
  .quick[aria-pressed='true'] { background: #fff; color: #000; }
  .chips { list-style: none; padding: 0; margin: 0 0 1.2rem; }
  .chip { background: var(--surface-2); border-radius: 99px; padding: 0 1rem; font-weight: 500; }
  .chip:hover:not(:disabled) { background: #3a3a3a; }
  .state { text-align: center; padding: 1rem 0 3rem; }
  .backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.6); animation: fade .2s ease-out; }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 71; flex-direction: column; max-height: 85vh; max-height: 85dvh; overflow-y: auto; overscroll-behavior: contain; background: #121212; border-top: 1px solid #333; border-radius: 16px 16px 0 0; padding: 0 1rem calc(1rem + env(safe-area-inset-bottom)); animation: rise .26s var(--ease, ease-out); }
  .sheet.dragging { transition: none; }
  .grab { touch-action: none; cursor: grab; position: sticky; top: 0; background: #121212; z-index: 1; padding: 0 0 .4rem; margin: 0 -1rem; }
  .handle { display: block; width: 40px; height: 4px; border-radius: 99px; background: #555; margin: 10px auto 8px; }
  .sht { margin: 0 1rem; font-size: 1.1rem; }
  .sheet form { display: grid; gap: .9rem; margin-top: .6rem; }
  .fl { display: grid; gap: .3rem; color: var(--mut); font-size: .82rem; font-weight: 600; }
  .fl select { width: 100%; min-height: 48px; color: var(--fg); font-size: 1rem; font-weight: 400; }
  .sheet form { gap: .7rem; }
  .sacts { display: flex; gap: .6rem; position: sticky; bottom: calc(-1rem - env(safe-area-inset-bottom)); margin: .2rem -1rem calc(-1rem - env(safe-area-inset-bottom)); padding: .7rem 1rem calc(1rem + env(safe-area-inset-bottom)); background: #121212; border-top: 1px solid #262626; }
  .sacts button { flex: 1; min-height: 48px; }
  @keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .sheet, .backdrop { animation: none; } }
</style>
