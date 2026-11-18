<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The notifications center (spec variant B): a right-hand glass sheet over the shared feed store (store.ts). From the top: the
   * header (title, unread count, the settings gear, close; it never moves), the filter chips, a reserved 44-px slot for the *N neu*
   * pill (new entries never land above the reading position), the scroll list with its sections and rows, and the footer (*Alle
   * gelesen*, the clear button of the current filter). Scrolling to the end loads the next page into two reserved skeleton rows;
   * the end text takes the same room. A clear can be undone from the toast for 5 s (held open for keyboard use: until the server
   * forgets the undo). A sign-out or profile switch while open loads the next person's first page. A modal dialog: Escape and the
   * dim close it, Tab stays inside, the focus goes back to `trigger`. The caller mounts it while open and removes it on `close`.
   *   <NotificationSheet trigger={bellBtn} on:close={() => (bell = false)} />
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { sheetRoom } from '#lib/glass/sheetRoom';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { locale, t, tr } from '#lib/i18n';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { toast } from '#lib/ui/toast';
  import { uid } from '#lib/ui/ids';
  import NoteRow from './NoteRow.svelte';
  import { categoryKey, sectionLabel } from './look';
  import { feedStore, latestCounts } from './store';
  import type { Category, Filter, Selection } from './types';

  /** the element the focus returns to on close (the bell) */
  export let trigger: HTMLElement | null = null;
  /** the whole screen (phones) instead of a sheet beside the page */
  export let full = false;

  /** the person's notification settings (push and delivery: the settings page's *Benachrichtigungen* section) */
  const SETTINGS_HREF = '/settings#push';
  /** how long the server keeps an entry (backend RETENTION_DAYS) */
  const RETENTION_DAYS = 90;
  const ORDER: Category[] = ['downloads', 'devices', 'series', 'achievements', 'livetv', 'system', 'requests', 'social', 'other'];

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = uid('ns');
  let panel: HTMLDivElement | undefined, list: HTMLDivElement | undefined, tail: HTMLDivElement | undefined;
  let io: IntersectionObserver | null = null;
  /** the first load was asked for (before it, the list shows the skeleton, never "empty") */
  let started = false;
  /** which load failed last: the first page (the whole list shows it) or the next one (the tail shows it) */
  let failed: 'first' | 'more' | null = null;

  $: s = $feedStore;
  $: hasRows = s.sections.some((x) => x.groups.length > 0);
  $: unread = s.unread + s.fresh;
  /** Alle, Ungelesen, then the categories with entries (the current filter stays, also once it is emptied) */
  $: chips = ['all', 'unread', ...ORDER.filter((c) => c === s.filter || s.categories.some((x) => x.key === c && x.n > 0))] as Filter[];
  $: chipLabel = (f: Filter) => (f === 'all' ? $t('notes.filter.all') : f === 'unread' ? $t('notes.filter.unread') : $t(categoryKey(f)));
  $: clearLabel = s.filter === 'all' ? $t('notes.clearAll') : s.filter === 'unread' ? $t('notes.clearUnread') : $t('notes.clearCategory', { category: $t(categoryKey(s.filter)) });
  $: pill = s.fresh > 0 && s.loading !== 'refresh';
  $: showSkeleton = !hasRows && (!started || s.loading === 'first');
  // new entries while the list sits at its top with no group open: the first page is replaced in place (nothing is above the
  // reader). Once per new count: a failed reload is not retried in a loop.
  let freshSeen = 0;
  $: if (s.fresh !== freshSeen) {
    freshSeen = s.fresh;
    if (s.fresh > 0 && s.loading === 'idle' && s.open.size === 0 && list && list.scrollTop <= 1) void loadFirst(s.filter, true);
  }
  // a sign-out or profile switch while open (the layout's reset): the next person's first page, never "empty" until reopened
  let personSeen = get(feedStore).person;
  $: if (s.person !== personSeen) { personSeen = s.person; list?.scrollTo({ top: 0 }); void loadFirst(s.filter); }
  // the layout read the counts again (the 60-s poll, `ff-notes`): what arrived since the first page becomes the *N neu* pill
  let countsSeen = get(latestCounts);
  $: if ($latestCounts !== countsSeen) { countsSeen = $latestCounts; if ($latestCounts) feedStore.noteFresh($latestCounts.unread); }
  // the end of the list in view (or still in view after a page arrived): the next page; after a failed one only Nochmal goes on
  $: watchTail(io, tail, s.loading, s.next, failed);

  let watched: { el: HTMLElement; next: string } | null = null;
  function watchTail(o: IntersectionObserver | null, el: HTMLElement | undefined, loading: string, next: string | null, f: typeof failed) {
    if (!o || !el || loading !== 'idle' || !next || f === 'more' || (watched?.el === el && watched.next === next)) return;
    if (watched) o.unobserve(watched.el);
    watched = { el, next };
    o.observe(el); // observing (again) reports the current state at once
  }
  async function loadFirst(filter: Filter, keepRows = false) {
    failed = null;
    started = true;
    await (keepRows ? feedStore.refresh() : feedStore.load(filter));
    if (get(feedStore).error) failed = 'first';
  }
  async function loadMore() {
    const st = get(feedStore);
    if (!st.next || st.loading !== 'idle') return;
    failed = null;
    await feedStore.more();
    if (get(feedStore).error) failed = 'more';
  }
  /** the layout reloads the bell's count (shared with the phone header) */
  const notify = () => window.dispatchEvent(new Event('ff-notes'));
  const failedToast = () => toast.error(tr('common.failed'));

  async function read(sel?: Selection) {
    if (await feedStore.read(sel)) notify();
    else failedToast();
  }
  async function clear(sel: Selection) {
    const r = await feedStore.hide(sel);
    if (!r) { failedToast(); return; }
    notify();
    const t = toast.info(tr('notes.cleared', { n: r.n }), {
      action: { label: tr('notes.undo'), run: async () => { if (await feedStore.undo(r.undo)) notify(); else failedToast(); } },
    });
    // a toast held open (keyboard use) goes when the server forgets the undo, so Rückgängig never ends in "failed" for that
    setTimeout(() => toast.close(t), feedStore.undoLeft(r.undo));
  }
  function pick(f: Filter) {
    if (f === s.filter && !failed) return;
    list?.scrollTo({ top: 0 });
    void loadFirst(f);
  }
  /** the *N neu* pill: back to the top, the first page again */
  function toTop() {
    list?.scrollTo({ top: 0 });
    void loadFirst(s.filter, true);
  }
  function close() {
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function follow(e: CustomEvent<string>) {
    const g = s.sections.flatMap((x) => x.groups).find((x) => x.id === e.detail);
    if (g?.unread) void read({ groups: [g.id] });
    close();
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: 'right' }));

  onMount(() => {
    panel?.focus({ preventScroll: true });
    const st = get(feedStore);
    // a page from an earlier open shows at once and is brought up to date in place; else the first page
    void loadFirst(st.filter, st.sections.length > 0 && !st.error);
    if (typeof IntersectionObserver === 'function' && list) {
      io = new IntersectionObserver((es) => { if (failed !== 'more' && es.some((x) => x.isIntersecting)) void loadMore(); }, { root: list, rootMargin: '0px 0px 240px 0px' });
    }
    return () => io?.disconnect();
  });
</script>

<div class="ns-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={close} transition:scrimFade|global></div>
  <div class="ns frost frost-safe frost-sheet" class:full id="ff-notes" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close }} use:sheetRoom={'right'} transition:slide|global>
    <header>
      <h2 id="{id}-t">{$t('notes.title')}</h2>
      {#if unread > 0}<span class="hc" data-testid="notes-unread">{unread}<span class="sr-only">{' '}{$t('notes.newLabel')}</span></span>{/if}
      <a class="ic gear" href={SETTINGS_HREF} aria-label={$t('notes.settings')} title={$t('notes.settings')} on:click={close}><Icon name="settings" size={20} /></a>
      <button type="button" class="ic" aria-label={$t('notes.close')} title={$t('notes.close')} on:click={close}><Icon name="x" size={20} /></button>
    </header>
    <div class="chips" role="group" aria-label={$t('notes.title')}>
      {#each chips as f (f)}
        <button type="button" class="chip" aria-pressed={s.filter === f} on:click={() => pick(f)}>{chipLabel(f)}</button>
      {/each}
    </div>
    <div class="slot">
      {#if pill}<button type="button" class="pill" on:click={toTop}><Icon name="chevron-up" size={16} />{$t('notes.fresh', { n: s.fresh })}</button>{/if}
    </div>
    <div class="list" bind:this={list} aria-busy={s.loading !== 'idle'}>
      {#if showSkeleton}
        {#each [0, 1, 2, 3, 4, 5] as i (i)}<div class="sk" aria-hidden="true"><Skeleton w="40px" h="40px" radius="12px" /><Skeleton lines={2} h=".8rem" /></div>{/each}
      {:else if !hasRows && failed === 'first'}
        <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('notes.error')}</p>
          <button type="button" class="ghost" on:click={() => loadFirst(s.filter)}>{$t('notes.retry')}</button></div>
      {:else if !hasRows}
        <p class="state empty">{$t('notes.empty')}</p>
      {:else}
        {#each s.sections as sec (sec.key)}
          <section aria-labelledby="{id}-s-{sec.key}">
            <h3 id="{id}-s-{sec.key}">{sectionLabel(sec.key, $locale)}</h3>
            <ul>
              {#each sec.groups as g (g.id)}
                <NoteRow group={g} open={s.open.has(g.id)} on:toggle={(e) => feedStore.toggle(e.detail)} on:read={(e) => read({ groups: [e.detail] })}
                  on:hide={(e) => clear({ groups: [e.detail] })} on:follow={follow} />
              {/each}
            </ul>
          </section>
        {/each}
        <!-- the room of the next page (two skeleton rows) or the end text: the same height, so nothing above or below moves -->
        <div class="tail" bind:this={tail}>
          {#if s.next && failed === 'more'}
            <div class="state" role="alert"><p>{$t('notes.error')}</p><button type="button" class="ghost" on:click={loadMore}>{$t('notes.retry')}</button></div>
          {:else if s.next}
            {#each [0, 1] as i (i)}<div class="sk" aria-hidden="true"><Skeleton w="40px" h="40px" radius="12px" /><Skeleton lines={2} h=".8rem" /></div>{/each}
          {:else}
            <p class="end">{$t('notes.end', { days: RETENTION_DAYS })}</p>
          {/if}
        </div>
      {/if}
    </div>
    <footer>
      <button type="button" class="ghost" disabled={unread === 0} on:click={() => read()}><Icon name="check" size={18} />{$t('notes.readAll')}</button>
      <button type="button" class="ghost" disabled={!hasRows} on:click={() => clear({ category: s.filter })}><Icon name="x" size={18} />{clearLabel}</button>
    </footer>
  </div>
</div>

<style>
  .ns-wrap { position: fixed; inset: 0; z-index: 90; }
  .ns { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(440px, 100%); display: flex; flex-direction: column; outline: none; color: #fff;
    border-right: 0; border-radius: var(--fr-r-sheet) 0 0 var(--fr-r-sheet); padding: 14px 0 0; }
  .ns.full { width: 100%; border-radius: 0; border-left: 0; padding-top: calc(14px + var(--safe-top, 0px)); }
  header { flex: none; display: flex; align-items: center; gap: 4px; padding: 0 12px 6px 18px; }
  h2 { flex: 0 1 auto; min-width: 0; margin: 0; font-size: 1.15rem; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hc { flex: none; margin-left: 6px; min-width: 22px; height: 22px; padding: 0 7px; box-sizing: border-box; border-radius: 99px; display: grid; place-items: center;
    background: var(--acc-fill); color: #fff; font-size: .75rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .gear { margin-left: auto; }
  .ic { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: #fff; }
  .ic:hover { background: rgba(255, 255, 255, .1); text-decoration: none; }
  .chips { flex: none; display: flex; gap: 8px; padding: 4px 18px 8px; overflow-x: auto; scrollbar-width: none; }
  .chips::-webkit-scrollbar { display: none; }
  .chip { flex: none; min-height: 36px; padding: 0 14px; border-radius: 99px; border: 1px solid rgba(255, 255, 255, .22); background: transparent; color: #fff; font-size: .85rem; font-weight: 600; white-space: nowrap; }
  .chip:hover { background: rgba(255, 255, 255, .1); }
  .chip[aria-pressed='true'] { background: #fff; border-color: #fff; color: #101418; }
  /* the pill's room: always there, so nothing moves when it comes */
  .slot { flex: none; height: 44px; display: flex; align-items: center; justify-content: center; }
  .pill { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 16px; border: 0; border-radius: 99px; background: var(--acc-fill); color: #fff; font-size: .85rem; font-weight: 700;
    box-shadow: 0 6px 18px rgba(0, 0, 0, .35); animation: pill-in 180ms var(--fr-out, ease-out); }
  @keyframes pill-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 10px 12px 12px; }
  section + section { margin-top: 8px; }
  h3 { margin: 0; padding: 10px 8px 4px; font-size: .78rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: rgba(255, 255, 255, .9); }
  ul { list-style: none; margin: 0; padding: 0; }
  /* a placeholder row: exactly a row's height (4 + 10 + 40 + 10) */
  .sk { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; align-items: center; height: 64px; box-sizing: border-box; padding: 2px 8px; }
  .tail { height: 128px; display: flex; flex-direction: column; justify-content: center; }
  .tail .sk { flex: none; }
  .end { margin: 0; padding: 0 12px; text-align: center; font-size: .82rem; color: rgba(255, 255, 255, .9); }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; margin: 0; padding: 1.5rem 12px; text-align: center; color: rgba(255, 255, 255, .9); }
  .state p { margin: 0; }
  .tail .state { padding: 0 12px; }
  footer { flex: none; display: flex; gap: 8px; justify-content: space-between; padding: 10px 14px calc(12px + var(--safe-bottom, 0px)); border-top: 1px solid rgba(255, 255, 255, .12); }
  .ghost { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 14px; border: 0; border-radius: 12px; background: transparent; color: #fff; font-size: .88rem; font-weight: 700; }
  .ghost:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .ghost:disabled { opacity: .5; cursor: default; }
  .ns :global(:focus-visible) { outline: 2px solid #fff; outline-offset: -2px; }
  @media (pointer: coarse) { .chip { min-height: 44px; } .pill { min-height: 44px; } }
  :global(html.m-still) .ns-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .ns-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
