<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The desktop search sheet (glass spec §2): one frosted sheet below the top-bar pill while its field is open (off /search).
   * Idle (fewer than two characters): recent searches, Popular here and the genres. Typing: top results (matched letters
   * underlined in coral), people, posters, genre chips and All results. It grows out of the field and folds back into it (§8.3), the page
   * behind dims, and new results cascade in (§8.6). The field in the bar stays the combobox; this is its popup.
   */
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { api, backdrop, getActiveProfile, img, type Item } from '#lib/api';
  import { clearRecent, loadRecent } from '#lib/discovery';
  import { kidsMode } from '#lib/kids';
  import { categoryHref, itemPath, runtimeLabel } from '#lib/mobile';
  import { t } from '#lib/i18n';
  import { fxMode, growFrom, REDUCED_MS, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import { GLASS_OUT } from '#lib/tv/motion';
  import { CASCADE_GAP, CASCADE_MS, cascadeKey, hitIds, marks, MIN_Q, sheetModel, type SearchResult } from './searchSheet';

  export let q: string;
  export let open: boolean;
  /** the top-bar pill: the sheet is centred below it and grows out of its field */
  export let anchor: HTMLElement;
  /** the hit the field's arrow keys made active (aria-activedescendant) */
  export let activeId: string | null;

  /**
   * close: `focus` 'field' = back to the field (Esc inside the sheet, Clear, Shift+Tab off its first control; the sheet stays
   * open); 'after' = Tab off its last control (close, focus to what follows the field); null = the dim (close)
   */
  const dispatch = createEventDispatcher<{ close: { focus: 'field' | 'after' | null }; pick: { href: string }; items: { ids: string[] }; fill: { q: string } }>();

  // ---- idle content: recent searches (re-read on each open), Popular here (not on kids profiles) and the genres (once) ----
  let recent: string[] = [], popular: Item[] = [], genres: string[] = [], idleLoaded = false;
  function loadIdle() {
    recent = loadRecent(getActiveProfile());
    if (idleLoaded) return;
    idleLoaded = true;
    if (!$kidsMode) api('/api/library/trending').then((r) => (popular = (r.items as Item[]) ?? [])).catch(() => {});
    api('/api/library/genres').then((r) => (genres = (r.genres as string[]) ?? [])).catch(() => {});
  }
  /** Clear: the list goes, the focus back to the field (the button it was on is gone) */
  function forget() { clearRecent(getActiveProfile()); recent = []; dispatch('close', { focus: 'field' }); }

  // ---- results: 250 ms after the last keystroke; a newer query aborts the older one, and a late answer (older sequence, or
  // after the sheet closed) is dropped ----
  let res: SearchResult | null = null, failed = false, seq = 0, ctl: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let wasOpen = false;
  $: onOpen(open);
  function onOpen(o: boolean) {
    if (o === wasOpen) return;
    wasOpen = o;
    if (o) { res = null; failed = false; idleShown = false; loadIdle(); }
  }
  $: schedule(q, open);
  function schedule(query: string, isOpen: boolean) {
    clearTimeout(timer);
    const s = query.trim();
    const my = ++seq;
    if (!isOpen || s.length < MIN_Q) {
      ctl?.abort();
      if (isOpen) { res = null; failed = false; } // (a closing sheet keeps what it shows while it folds away)
      return;
    }
    timer = setTimeout(async () => {
      ctl?.abort();
      const c = (ctl = new AbortController());
      try {
        const r = await api<SearchResult>(`/api/search?q=${encodeURIComponent(s)}`, { signal: c.signal });
        if (my === seq && open) { res = r; failed = false; }
      } catch (e) {
        // aborted: a newer query or the close took over; failed: a short line says so (the last results stay)
        if (my === seq && open && (e as { name?: string } | null)?.name !== 'AbortError') failed = true;
      }
    }, 250);
  }
  onDestroy(() => { clearTimeout(timer); ctl?.abort(); });

  $: model = sheetModel(q, res, { recent, popular: $kidsMode ? [] : popular, genres });
  /**
   * the result count for screen readers (WCAG 4.1.3), in a status region that always exists (a live region added together with
   * its text is often not read): set when an answer arrives (the fetch already waits 250 ms after the last keystroke)
   */
  $: hitCount = res ? res.titles.length + res.episodes.length + res.people.length + res.genres.length : 0;
  $: status = open && res && q.trim().length >= MIN_Q ? (hitCount ? $t('home.search.hits', { n: hitCount }) : $t('home.search.noHits', { term: q.trim() })) : '';
  $: ids = hitIds(model);
  $: dispatch('items', { ids });
  $: term = q.trim();
  $: allHref = `/search?q=${encodeURIComponent(term)}`;

  const meta = (i: Item) => (i.type === 'Episode' ? [i.seriesName, i.name] : [i.year, runtimeLabel(i)]).filter(Boolean).join(' · ');
  const thumb = (i: Item) => (i.type !== 'Episode' && i.backdrop ? backdrop(i.id, 200) : img(i.id, 200));
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  const pick = (href: string) => dispatch('pick', { href });

  // ---- place: centred on the pill, min(940 px, window − 2 · the bar's side padding) wide, 12 px below it ----
  let el: HTMLElement | undefined;
  let box = { left: 0, top: 0, width: 0 };
  function place() {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const pad = anchor.parentElement ? parseFloat(getComputedStyle(anchor.parentElement).paddingLeft) || 0 : 0;
    const width = Math.max(0, Math.min(940, vw - 2 * pad));
    const left = Math.max(pad, Math.min(r.left + r.width / 2 - width / 2, vw - pad - width));
    box = { left: Math.round(left), top: Math.round(r.bottom + 12), width: Math.round(width) };
  }
  $: if (open && anchor) place();
  let ro: ResizeObserver | undefined;
  $: { ro?.disconnect(); ro = open && anchor && typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : undefined; if (ro && anchor) ro.observe(anchor); }
  onDestroy(() => ro?.disconnect());

  /**
   * grows out of the field and folds back into it (the pill's field, else the pill). Bidirectional (`transition:`): a reopen
   * while it folds away (or a close while it grows) turns around from where it is (glass spec §8.3). The origin is measured
   * once per open, while the sheet is unscaled (growFrom caches it per node), so a turn mid-flight keeps it.
   */
  const sheetT = (node: Element) => twoWay((dir) => growFrom(node, { trigger: anchor?.querySelector<HTMLElement>('.psearch') ?? anchor, dir }));
  /** the page dim: an opacity fade (200 ms; the reduced set's crossfade; instant when still), reversible like the sheet */
  function dimT(_node: Element) {
    const mode = fxMode();
    return { duration: mode === 'still' ? 0 : mode === 'reduced' ? REDUCED_MS : 200, css: (t: number) => `opacity:${t}` };
  }

  // ---- the cascade (§8.6): when the results change, each [data-cascade] item rises in, 45 ms after the one before; the idle
  // content cascades once per open (not again as Popular here and the genres arrive) ----
  let shownKey = '', running: Animation[] = [], idleShown = false;
  $: key = open ? cascadeKey(model) : '';
  $: if (key !== shownKey) {
    shownKey = key;
    if (key && !(model.kind === 'idle' && idleShown)) { if (model.kind === 'idle') idleShown = true; void tick().then(cascade); }
  }
  function cascade() {
    running.forEach((a) => a.cancel());
    running = [];
    if (!el || fxMode() !== 'full') return;
    el.querySelectorAll<HTMLElement>('[data-cascade]').forEach((n, i) => {
      if (typeof n.animate !== 'function') return;
      running.push(n.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: CASCADE_MS, delay: i * CASCADE_GAP, easing: GLASS_OUT, fill: 'backwards' }));
    });
  }

  // the active hit stays in view
  $: if (activeId && el) el.querySelector(`#${activeId}`)?.scrollIntoView?.({ block: 'nearest' });

  /** the controls Tab moves through (the top hits are reached with the arrows from the field) */
  const tabbable = () => (el ? [...el.querySelectorAll<HTMLElement>('a[href]:not([tabindex="-1"]), button:not(:disabled)')] : []);
  /** puts the focus on the sheet's first control (Tab from the field); false when there is none */
  export function focusFirst(): boolean {
    const f = tabbable()[0];
    f?.focus();
    return !!f;
  }
  /**
   * Esc with the focus inside the sheet: back to the field (it then clears and closes as usual). Tab moves through the sheet's
   * controls; off its last one the sheet closes and the focus goes on past the field, Shift+Tab off its first one goes back.
   */
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      dispatch('close', { focus: 'field' });
      return;
    }
    if (e.key !== 'Tab') return;
    const list = tabbable();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); dispatch('close', { focus: 'field' }); }
    else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); dispatch('close', { focus: 'after' }); }
  }
  /** a press on the sheet's empty space keeps the focus (and typing) in the field */
  function onDown(e: MouseEvent) {
    if (!(e.target as Element | null)?.closest?.('a[href], button')) e.preventDefault();
  }

  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
</script>

<svelte:window on:resize={() => open && place()} />
<p class="sr-only" role="status" data-ds-status>{status}</p>

{#if open}
  <!-- one root node (portalled to <body>): the dim and the sheet -->
  <div class="ds-layer" use:portal>
    <div class="frost-dim ds-dim" role="presentation" transition:dimT on:click={() => dispatch('close', { focus: null })}></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc / Tab inside the sheet; a press on its empty space keeps the field's focus; the field is the combobox) -->
    <div id="ds-sheet" class="frost frost-sheet frost-safe ds" role="region" aria-label={$t('desk.search.sheet')} bind:this={el}
      style:left="{box.left}px" style:top="{box.top}px" style:width="{box.width}px" style:max-height="calc(100vh - {box.top + 16}px)" style:--fr-scrim-safe={SCRIM_MENU}
      transition:sheetT on:keydown={onKey} on:mousedown={onDown}>
      {#if failed}<p class="err" role="status">{$t('home.search.errorTitle')}</p>{/if}
      {#if model.kind === 'results' && model.empty}
        <p class="none" data-cascade>{$t('home.search.noHits', { term })}</p>
      {:else if model.kind === 'results'}
        <div class="col">
          <!-- the combobox's listbox: the top hits, and All results (in the other column) through aria-owns -->
          {#if model.top.length}<h2 class="h">{$t('desk.search.top')}</h2>{/if}
          <div class="hits" id="ds-list" role="listbox" aria-label={$t('desk.search.top')} aria-owns="ds-all">
              {#each model.top as it, i (it.id)}
                <a class="hit" class:on={activeId === `ds-hit-${i}`} id="ds-hit-{i}" role="option" aria-selected={activeId === `ds-hit-${i}`} tabindex="-1" href={itemPath(it)} data-cascade on:click={() => pick(itemPath(it))}>
                  <img src={thumb(it)} alt="" loading="lazy" width="96" height="54" />
                  <span class="ht"><b>{#each marks(it.name, q) as p}{#if p.m}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}</b>{#if meta(it)}<small>{meta(it)}</small>{/if}</span>
                </a>
              {/each}
          </div>
          {#if model.people.length}
            <h2 class="h">{$t('home.search.people')}</h2>
            <ul class="ppl">{#each model.people as p (p.id)}
              <li data-cascade><a href="/person/{p.id}" on:click={() => pick(`/person/${p.id}`)}><span class="av">{#if p.image}<img src={img(p.id, 160)} alt="" loading="lazy" width="54" height="54" />{:else}<span aria-hidden="true">{initials(p.name)}</span>{/if}</span><span class="nm">{p.name}</span></a></li>
            {/each}</ul>
          {/if}
        </div>
        <div class="col">
          {#if model.posters.length}
            <h2 class="h">{$t('home.search.titles')}</h2>
            <ul class="posters">{#each model.posters as it (it.id)}
              <li data-cascade><a href={itemPath(it)} on:click={() => pick(itemPath(it))}><img src={img(it.id, 200)} alt="" loading="lazy" width="96" height="144" /><span>{it.name}</span></a></li>
            {/each}</ul>
          {/if}
          {#if model.genres.length}
            <h2 class="h">{$t('home.search.byGenre')}</h2>
            <ul class="chips">{#each model.genres as g (g)}<li data-cascade><a class="frost-btn chip" href={categoryHref('movies', g)} on:click={() => pick(categoryHref('movies', g))}>{g}</a></li>{/each}</ul>
          {/if}
          <a id="ds-all" class="all" class:on={activeId === 'ds-all'} role="option" aria-selected={activeId === 'ds-all'} href={allHref} data-cascade on:click={() => pick(allHref)}>{$t('desk.search.all')}</a>
        </div>
      {:else}
        <div class="col">
          {#if model.recent.length}
            <div class="rhead"><h2 class="h">{$t('home.search.recent')}</h2><button type="button" class="clr fill-hover" on:click={forget}>{$t('home.search.clearRecent')}</button></div>
            <ul class="chips">{#each model.recent as r (r)}<li data-cascade><button type="button" class="chip edge-hover" on:click={() => dispatch('fill', { q: r })}>{r}</button></li>{/each}</ul>
          {:else}
            <p class="hint">{$t('home.search.hint')}</p>
          {/if}
        </div>
        <div class="col">
          {#if model.popular.length}
            <h2 class="h">{$t('home.search.popularHere')}</h2>
            <ul class="posters">{#each model.popular as it (it.id)}
              <li data-cascade><a href={itemPath(it)} on:click={() => pick(itemPath(it))}><img src={img(it.id, 200)} alt="" loading="lazy" width="96" height="144" /><span>{it.name}</span></a></li>
            {/each}</ul>
          {/if}
          {#if model.genres.length}
            <h2 class="h">{$t('home.search.byGenre')}</h2>
            <ul class="chips">{#each model.genres as g (g)}<li data-cascade><a class="frost-btn chip" href={categoryHref('movies', g)} on:click={() => pick(categoryHref('movies', g))}>{g}</a></li>{/each}</ul>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ds-dim { z-index: 48; }
  /* the sheet (glass spec §2): 26 px radius (.frost-sheet), 22 px padding, two columns; over the dim and over the bar (z 50),
     so the bar's scroll shade never darkens its top (it starts below the pill, so nothing of the bar is covered) */
  .ds { position: fixed; z-index: 51; box-sizing: border-box; padding: 22px; display: grid; grid-template-columns: minmax(0, 330px) minmax(0, 1fr); gap: 24px; align-content: start;
    overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
  .ds:focus { outline: none; }
  .col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .col > .h ~ .h { margin-top: 8px; }
  .h { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: rgba(255, 255, 255, .9); }
  .err { grid-column: 1 / -1; margin: 0; font-size: .9rem; font-weight: 700; color: #fff; }
  .none, .hint { grid-column: 1 / -1; margin: 0; color: rgba(255, 255, 255, .9); }
  .hint { grid-column: auto; font-size: .9rem; }

  /* top results: a 96×54 thumbnail, the title (matched letters underlined in coral) and a meta line */
  .hits { display: flex; flex-direction: column; gap: 2px; }
  .hit { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; align-items: center; padding: 8px; border-radius: 14px; color: #fff; text-decoration: none; }
  .hit:hover, .hit.on { background: var(--fr-sel); text-decoration: none; }
  .hit img { width: 96px; height: 54px; border-radius: 9px; object-fit: cover; background: rgba(255, 255, 255, .08); }
  .ht { min-width: 0; }
  .ht b { display: block; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ht small { display: block; margin-top: 3px; font-size: 12px; color: rgba(255, 255, 255, .9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* the matched letters: white (AA wherever the title is) with a 2 px brand-coral underline */
  mark { background: none; color: #fff; text-decoration: underline; text-decoration-color: var(--acc); text-decoration-thickness: 2px; text-underline-offset: 3px; }

  ul { list-style: none; margin: 0; padding: 0; }
  .ppl { display: flex; gap: 10px; }
  .ppl a { display: grid; justify-items: center; gap: 6px; width: 74px; font-size: 12px; font-weight: 700; text-align: center; color: #fff; text-decoration: none; }
  .ppl .av { width: 54px; height: 54px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; background: rgba(255, 255, 255, .12); font-weight: 800; }
  .ppl .av img { width: 100%; height: 100%; object-fit: cover; }
  .ppl .nm { overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  .posters { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
  .posters a { position: relative; display: block; aspect-ratio: 2 / 3; border-radius: var(--fr-r-card); overflow: hidden; box-shadow: var(--fr-shadow-card); background: rgba(255, 255, 255, .08); color: #fff; text-decoration: none; }
  .posters img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .posters span { position: absolute; left: 6px; right: 6px; bottom: 6px; font-size: 11px; font-weight: 800; line-height: 1.2; text-shadow: 0 1px 8px rgba(0, 0, 0, .8); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }

  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { position: relative; display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border-radius: 999px; font: inherit; font-size: 13px; font-weight: 700; color: #fff; text-decoration: none; }
  /* recent searches: light chips whose hover lights the edge (.edge-hover; more fill would cost the text its AA); the genre
     chips are glass pills (.frost-btn, its edge-light hover and solid fallback) */
  .chip:not(.frost-btn), .chip:not(.frost-btn):hover:not(:disabled) { background: rgba(255, 255, 255, .12); border: 1px solid rgba(255, 255, 255, .16); }
  .chip:hover { text-decoration: none; }
  .rhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  /* Clear: its hover fades in a darker fill (.fill-hover: only adds contrast) */
  .clr, .clr:hover:not(:disabled) { min-height: 32px; padding: 0 10px; border-radius: 999px; background: transparent; color: rgba(255, 255, 255, .9); font-size: 12px; font-weight: 700; }
  .all { align-self: flex-start; display: inline-flex; align-items: center; min-height: 40px; margin-top: 4px; padding: 0 16px; border-radius: 999px; font-weight: 800; font-size: 14px; color: #fff; text-decoration: none; }
  .all:hover, .all.on { background: var(--fr-sel); text-decoration: none; }
  .ds a:focus-visible, .ds button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; --ring-o: 2px; }
  .hit:focus-visible { outline-offset: -2px; box-shadow: inset 0 0 0 4px var(--ring-dark), 0 0 0 2px var(--ring-dark); }
</style>
