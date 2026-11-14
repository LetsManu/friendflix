<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Kanäle* (spec §9.2, list mode): the server-paged channel list (DataTable, 100 per page) with search (name, number,
   * tvg-id), the filters *Quelle*, *Gruppe*, *Sichtbar / Ausgeblendet / Fehlt*, *Ohne Programm* and *Mit Fehler*, the result count, and
   * per row: checkbox, logo tile (the number when there is none), number, name (inline edit: double click or Enter; Escape cancels; empty =
   * the import's name), group (inline select), source, kind chip, mode chip (from the last test), EPG state, visibility switch and the
   * menu (*Testen*, *Logo ändern*, *Programm-Zeit verschieben…*, *Umbenennen* for touch, *Zurücksetzen*, *Programm zuordnen…* (PinSheet)).
   * A hand pin shows its guide's name under the EPG state ("Von Hand: …"; "Programmführer ausgeschaltet" when that guide is off). A small dot says what the
   * import had ("geändert (Import: …)", never for own feeds). The selection is kept by id across pages and filters; the bulk bar acts on
   * it. Every write answers the updated channel, which replaces its row; the list is read again after a bulk action. The view toggle *Liste / Reihenfolge*:
   * *Reihenfolge* (OrderView, `PUT /channels/order`) works on one group or one source of at most 500 channels, loaded on their own (by
   * number, never narrowed by the list's other filters); otherwise it says why. Loading keeps the old rows (no skeleton flash on paging); a late answer of an older request is dropped.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import { uid } from '#lib/ui/ids';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import type { MoreAction } from '#lib/MoreActions.svelte';
  import type { Column, Query, SortState } from '#lib/ui/table';
  import { toast } from '#lib/ui/toast';
  import { listGroups, listSources, type GroupOption, type SourceView } from './api';
  import BulkBar from './BulkBar.svelte';
  import { confirmOrderDiscard, guardLeave } from './discard';
  import {
    afterOrderSave, bulkChannels, channelError, emptyFilter, forOrder, failText, getChannel, kindChip, listChannels, logoSrc, ORDER_MAX, orderChannels, orderFilter, overrideHint, patchChannel, PAGE_SIZE, mergeSynced, SYNC_POLL_MS, syncing,
    type AdminChannel, type BulkBody, type ChannelFilter, type ChannelPatch, type ChannelSort,
  } from './channels';
  import EpgShiftSheet from './EpgShiftSheet.svelte';
  import LogoSheet from './LogoSheet.svelte';
  import OrderView from './OrderView.svelte';
  import PinSheet from './PinSheet.svelte';
  import TestSheet from './TestSheet.svelte';

  let filter: ChannelFilter = emptyFilter();
  let rows: AdminChannel[] | null = null;
  let total = 0;
  let loadError: string | null = null;
  let q = '';
  let sort: SortState | null = { key: 'number', dir: 'asc' };
  let page = 0;
  let sources: SourceView[] = [];
  let groups: GroupOption[] = [];
  /** the selection by id, with the name it had (for the bulk test's list), kept across pages and filters */
  let selected = new Map<string, string>();
  let loading = false;
  /** the bulk bar's measured height: the list reserves it at its end (the pager stays reachable) */
  let bulkH = 0;
  let gone = false;

  // ---- loading
  let seq = 0;
  let ctl: AbortController | undefined;
  async function load() {
    const mine = ++seq;
    ctl?.abort();
    ctl = new AbortController();
    loading = true;
    try {
      const r = await listChannels(filter, ctl.signal);
      if (mine !== seq || gone) return;
      rows = r.channels; total = r.total; loadError = null;
    } catch (e) {
      if (mine !== seq || gone || (e instanceof DOMException && e.name === 'AbortError')) return;
      if (rows) toast.error(errorText(e)); else loadError = tr('adminLive.ch.loadFailed');
    } finally { if (mine === seq) loading = false; }
  }

  // ---- the view toggle: Liste / Reihenfolge
  type View = 'list' | 'order';
  const VIEWS: View[] = ['list', 'order'];
  const vid = uid('chview');
  let view: View = 'list';
  /** the filter or the stored numbers changed while the list was not shown: it reads again when it comes back */
  let listStale = false;
  $: if (view === 'list' && listStale) { listStale = false; void load(); }
  /** the rows of the one group / source (by number); null until they arrive */
  let orderRows: AdminChannel[] | null = null;
  let orderTotal = 0;
  let orderLoading = false;
  let orderFailed = false;
  /** OrderView's `bind:dirty`: the shown order is not stored yet */
  let orderDirty = false;
  let oseq = 0;
  let octl: AbortController | undefined;
  /** rows are only ever those of the current selection: every (re)load and every leave starts from none (the skeleton), so no old row shows under new labels */
  function dropOrder() { orderRows = null; orderTotal = 0; orderFailed = false; orderDirty = false; }
  async function loadOrder() {
    const f = orderFilter(filter);
    const mine = ++oseq;
    octl?.abort();
    dropOrder();
    if (!f) { orderLoading = false; return; }
    octl = new AbortController();
    orderLoading = true;
    try {
      const r = await listChannels(f, octl.signal, ORDER_MAX);
      if (mine !== oseq || gone) return;
      orderRows = r.channels; orderTotal = r.total;
    } catch (e) {
      if (mine !== oseq || gone || (e instanceof DOMException && e.name === 'AbortError')) return;
      orderRows = null; orderFailed = true;
    } finally { if (mine === oseq) orderLoading = false; }
  }
  /** the order rows load again when the view opens or the group / source changes (and only then) */
  $: orderKey = view === 'order' ? JSON.stringify([filter.source, filter.group]) : '';
  function closeOrder() { oseq++; octl?.abort(); orderLoading = false; dropOrder(); }
  $: { void orderKey; if (view === 'order') void loadOrder(); else closeOrder(); }
  $: orderSet = view === 'order' && orderFilter(filter) !== null;
  $: tooMany = orderRows !== null && orderTotal > ORDER_MAX;
  const viewKey = (v: View) => (v === 'list' ? 'adminLive.grp.viewList' : 'adminLive.grp.viewOrder') as 'adminLive.grp.viewList';
  /** the one gate before anything that drops the shown order (the *Liste* radio, the source / group select, *Wiederholen*): false = the person kept ordering */
  async function leaveOk(): Promise<boolean> {
    if (view !== 'order' || !orderDirty) return true;
    const ok = await confirmOrderDiscard();
    if (ok) orderDirty = false;
    return ok;
  }
  // an area tab, a `?tab=` link, a sidebar link or Back: the unsaved order asks first, like the controls above
  guardLeave(() => view === 'order' && orderDirty, () => { orderDirty = false; }, confirmOrderDiscard);
  async function setView(v: View): Promise<boolean> {
    if (v === view) return true;
    if (!(await leaveOk())) return false;
    // "Ohne Gruppe" is no choice of the order view: the select would read it while the whole source is listed
    const f = forOrder(filter);
    if (v === 'order' && f !== filter) { filter = f; listStale = true; }
    view = v;
    return true;
  }
  async function viewKeys(e: KeyboardEvent) {
    const i = VIEWS.indexOf(view);
    const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % VIEWS.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i + VIEWS.length - 1) % VIEWS.length : -1;
    if (n < 0) return;
    e.preventDefault();
    const v = VIEWS[n]!;
    if (await setView(v)) queueMicrotask(() => document.getElementById(`${vid}-v-${v}`)?.focus());
  }
  /** a select of the order view: a refused change (the order stays) shows the old value again, on a fresh select that keeps the focus */
  let selRev = 0;
  async function orderSelect(e: Event, id: string, patch: (v: string) => Partial<ChannelFilter>) {
    const v = (e.target as HTMLSelectElement).value;
    if (await leaveOk()) { setFilter(patch(v)); return; }
    selRev++;
    await tick();
    document.getElementById(id)?.focus();
  }
  async function retryOrder() { if (await leaveOk()) void loadOrder(); }
  /** the stored order is the new numbering: the shown rows take the answer's numbers, the list reads it again */
  async function saveOrder(ids: string[]) {
    const mine = oseq;
    const r = await orderChannels(ids);
    if (mine === oseq && orderRows && typeof r?.from === 'number') orderRows = afterOrderSave(orderRows, ids, r.from);
    listStale = true;
  }
  onMount(() => {
    void load();
    listSources().then((s) => { sources = s; }).catch(() => undefined);
    listGroups().then((g) => { groups = g; }).catch(() => undefined);
  });
  onDestroy(() => { gone = true; ctl?.abort(); octl?.abort(); if (syncTimer) clearTimeout(syncTimer); });

  // ---- own feeds: "wird übertragen …" while livetv has not taken the change; the page is read again until the flag clears
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** a poll's list read is running: the next poll is scheduled only when it has finished (success or error), so slow reads never overlap */
  let polling = false;
  $: if (!gone && !syncTimer && !polling && (rows ?? []).some(syncing)) syncTimer = setTimeout(pollSynced, SYNC_POLL_MS);
  async function pollSynced() {
    syncTimer = undefined;
    if (gone || !rows?.some(syncing)) return;
    polling = true;
    try {
      const mine = seq; // a load that started meanwhile owns the rows
      const r = await listChannels(filter);
      if (!gone && mine === seq && rows) rows = mergeSynced(rows, r.channels);
    } catch { /* the next poll tries again */ }
    polling = false;
    if (!gone && !syncTimer && rows?.some(syncing)) syncTimer = setTimeout(pollSynced, SYNC_POLL_MS);
  }

  function onQuery(e: CustomEvent<Query>) {
    const { q: text, sort: s, offset } = e.detail;
    filter = { ...filter, q: text, sort: (s?.key as ChannelSort | undefined) ?? 'number', dir: s?.dir ?? 'asc', offset };
    void load();
  }
  /** a chip, select or reset: starts at the first page again */
  function setFilter(patch: Partial<ChannelFilter>) {
    page = 0;
    filter = { ...filter, ...patch, offset: 0 };
    if (view === 'list') void load(); else listStale = true;
  }
  function clearFilters() {
    q = ''; page = 0; sort = { key: 'number', dir: 'asc' };
    filter = emptyFilter();
    void load();
  }
  $: filtered = Boolean(filter.q.trim() || filter.source || filter.group || filter.state || filter.epg || filter.error);

  const replaceRow = (c: AdminChannel) => {
    if (rows) rows = rows.map((r) => (r.id === c.id ? c : r));
    if (selected.has(c.id)) selected = new Map(selected).set(c.id, c.name);
  };
  async function refreshRow(id: string) {
    try { replaceRow(await getChannel(id)); } catch { /* the next load shows it */ }
  }

  // ---- names the rows show
  $: sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? '–';
  $: ownSource = (id: string) => sources.find((s) => s.id === id)?.kind === 'feeds';
  $: groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? null;
  $: hintOf = (c: AdminChannel) => overrideHint(c, { own: ownSource(c.sourceId), group: groupName });
  $: sourceOptions = [{ value: '', label: $t('adminLive.ch.filters.allSources') }, ...sources.map((s) => ({ value: s.id, label: s.name }))];
  $: groupFilterOptions = [{ value: '', label: $t('adminLive.ch.filters.allGroups') }, { value: 'none', label: $t('adminLive.ch.filters.noGroup') }, ...groups.map((g) => ({ value: g.id, label: g.name }))];
  /** the order view has no "Ohne Gruppe": a set of channels without a group is no group to order */
  $: groupOrderOptions = groupFilterOptions.filter((o) => o.value !== 'none');
  const IMPORT = '__import';
  // reactive on the group list: the template calls it, so a list that arrives later reaches the open selects
  $: groupOptions = (c: AdminChannel) => {
    const known = groups.some((g) => g.id === c.groupId);
    return [
      { value: '', label: $t('adminLive.ch.filters.noGroup'), disabled: true },
      ...(c.groupId && !known ? [{ value: c.groupId, label: '–' }] : []),
      ...groups.map((g) => ({ value: g.id, label: g.name })),
      ...('group' in c.overridden ? [{ value: IMPORT, label: $t('adminLive.ch.groupImport') }] : []),
    ];
  };

  // ---- the columns
  $: columns = [
    { key: 'sel', label: $t('adminLive.ch.col.select'), hideLabel: true, sortable: false, width: '3.2rem' },
    { key: 'logo', label: $t('adminLive.ch.col.logo'), hideLabel: true, sortable: false, width: '4.4rem' },
    { key: 'number', label: $t('adminLive.ch.col.number'), sortable: true, value: (c) => c.number, width: '5rem' },
    { key: 'name', label: $t('adminLive.ch.col.name'), sortable: true, value: (c) => c.name, primary: true },
    { key: 'group', label: $t('adminLive.ch.col.group'), sortable: false },
    { key: 'source', label: $t('adminLive.ch.col.source'), sortable: true },
    { key: 'kind', label: $t('adminLive.ch.col.kind'), sortable: false },
    { key: 'mode', label: $t('adminLive.ch.col.mode'), sortable: false },
    { key: 'epg', label: $t('adminLive.ch.col.epg'), sortable: false },
    { key: 'visible', label: $t('adminLive.ch.col.visible'), sortable: false },
  ] as Column<AdminChannel>[];

  // ---- writes
  const busyKey = (c: AdminChannel) => `ltv-ch:${c.id}`;
  async function patchRow(c: AdminChannel, body: ChannelPatch, success: string) {
    const r = await runAction({ key: busyKey(c), run: () => patchChannel(c.id, body), success, error: failText });
    if (r.ok && r.value) replaceRow(r.value);
    return r;
  }
  function setHidden(c: AdminChannel, visible: boolean) {
    const hidden = !visible;
    void runAction({
      key: busyKey(c),
      apply: () => { const prev = c; replaceRow({ ...c, hidden }); return () => replaceRow(prev); },
      run: () => patchChannel(c.id, { hidden }),
      success: hidden ? tr('adminLive.ch.hiddenDone') : tr('adminLive.ch.shown'),
      error: failText,
    }).then((r) => { if (r.ok && r.value) replaceRow(r.value); });
  }
  /** a select that is refused must show the value the channel still has again */
  let rev: Record<string, number> = {};
  async function setGroup(c: AdminChannel, v: string) {
    const r = await patchRow(c, { groupId: v === IMPORT ? null : v }, tr('adminLive.ch.saved'));
    if (!r.ok) rev = { ...rev, [c.id]: (rev[c.id] ?? 0) + 1 };
  }

  // ---- inline rename
  let editId: string | null = null;
  let editVal = '';
  function startEdit(c: AdminChannel) { editId = c.id; editVal = c.name; }
  function editInit(el: HTMLInputElement) { el.focus(); el.select(); }
  function commitEdit(c: AdminChannel) {
    if (editId !== c.id) return;
    const v = editVal.trim();
    editId = null;
    if (v === c.name || (!v && c.overridden.name === undefined)) return;
    void patchRow(c, { name: v || null }, tr('adminLive.ch.saved'));
  }
  function editKey(e: KeyboardEvent, c: AdminChannel) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(c); void focusName(c.id); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editId = null; void focusName(c.id); }
  }
  async function focusName(id: string) {
    await tick();
    document.querySelector<HTMLElement>(`[data-name-of="${id}"]`)?.focus({ preventScroll: true });
  }

  // ---- selection
  const toggleRow = (c: AdminChannel, on: boolean) => {
    const next = new Map(selected);
    if (on) next.set(c.id, c.name); else next.delete(c.id);
    selected = next;
  };
  $: pageAll = Boolean(rows?.length) && (rows ?? []).every((r) => selected.has(r.id));
  function togglePage(on: boolean) {
    const next = new Map(selected);
    for (const r of rows ?? []) { if (on) next.set(r.id, r.name); else next.delete(r.id); }
    selected = next;
  }

  // ---- bulk
  $: ids = [...selected.keys()];
  async function bulk(body: BulkBody) {
    const r = await runAction({
      key: 'ltv-ch-bulk', run: () => bulkChannels(body), error: failText,
      success: (v) => tr('adminLive.ch.bulk.done', { n: v?.changed ?? 0 }),
    });
    if (!r.ok) return;
    selected = new Map();
    await load();
    // a narrowing filter can empty the page we were on: step back to the last page that still has rows
    if (rows && !rows.length && total > 0 && filter.offset > 0) {
      const last = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
      page = last; filter = { ...filter, offset: last * PAGE_SIZE };
      await load();
    }
  }
  async function bulkReset() {
    const ok = await confirm({ title: tr('adminLive.ch.bulk.resetTitle'), body: tr('adminLive.ch.bulk.resetBody'), confirmLabel: tr('adminLive.ch.menu.reset') });
    if (ok) await bulk({ ids, action: 'reset' });
  }
  async function resetOne(c: AdminChannel) {
    const r = await runAction({ key: busyKey(c), run: () => bulkChannels({ ids: [c.id], action: 'reset' }), success: tr('adminLive.ch.resetDone'), error: failText });
    if (r.ok) await refreshRow(c.id);
  }

  // ---- sheets
  type Sheet =
    | { kind: 'test'; channel: AdminChannel; label: string }
    | { kind: 'logo'; channel: AdminChannel; label: string }
    | { kind: 'shift'; channel: AdminChannel; label: string }
    | { kind: 'pin'; channel: AdminChannel; label: string }
    | { kind: 'bulktest'; ids: string[]; names: Record<string, string> };
  let sheet: Sheet | null = null;
  const menuLabel = (c: AdminChannel) => tr('ui.table.actionsFor', { name: c.name });
  const menuButton = (label: string) => () => document.querySelector<HTMLElement>(`button[aria-label="${label.replace(/"/g, '\\"')}"]`);
  let bulkTrigger: HTMLElement | null = null;
  const hasOverrides = (c: AdminChannel) => Object.keys(c.overridden).length > 0 || c.epgShift.from === 'channel';
  function actions(c: AdminChannel): MoreAction[] {
    const label = menuLabel(c);
    return [
      { id: 'test', label: $t('adminLive.ch.menu.test'), icon: 'play', run: () => { sheet = { kind: 'test', channel: c, label }; } },
      { id: 'logo', label: $t('adminLive.ch.menu.logo'), icon: 'image', run: () => { sheet = { kind: 'logo', channel: c, label }; } },
      { id: 'shift', label: $t('adminLive.ch.menu.shift'), icon: 'clock', run: () => { sheet = { kind: 'shift', channel: c, label }; } },
      { id: 'rename', label: $t('adminLive.ch.menu.rename'), icon: 'pencil', run: () => startEdit(c) },
      { id: 'reset', label: $t('adminLive.ch.menu.reset'), icon: 'refresh', disabled: !hasOverrides(c), run: () => resetOne(c) },
      { id: 'pin', label: $t('adminLive.ch.menu.pin'), icon: 'calendar', run: () => { sheet = { kind: 'pin', channel: c, label }; } },
    ];
  }
  function bulkTest() {
    bulkTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const names: Record<string, string> = {};
    for (const [id, n] of selected) names[id] = n;
    sheet = { kind: 'bulktest', ids: [...selected.keys()], names };
  }
  const closeSheet = () => { sheet = null; };
  const brokenLogos = new Set<string>();
  let logoRev = 0;
  const logoFailed = (hash: string) => { brokenLogos.add(hash); logoRev++; };
</script>

<div class="ch" style="--bb-h:{bulkH}px" aria-busy={loading || orderLoading ? 'true' : undefined}>
  <div class="viewbar">
    <div class="views" role="radiogroup" aria-label={$t('adminLive.grp.view')}>
      {#each VIEWS as v (v)}
        <button type="button" role="radio" id="{vid}-v-{v}" class="vw" class:on={view === v} aria-checked={view === v} tabindex={view === v ? 0 : -1} on:click={() => void setView(v)} on:keydown={viewKeys}>{$t(viewKey(v))}</button>
      {/each}
    </div>
    {#if view === 'order'}
      {#key selRev}
        <div class="chips">
          <Select id="{vid}-src" hideLabel label={$t('adminLive.ch.filters.source')} value={filter.source ?? ''} options={sourceOptions} on:change={(e) => orderSelect(e, `${vid}-src`, (v) => ({ source: v || null }))} />
          <Select id="{vid}-grp" hideLabel label={$t('adminLive.ch.filters.group')} value={filter.group ?? ''} options={groupOrderOptions} on:change={(e) => orderSelect(e, `${vid}-grp`, (v) => ({ group: v || null }))} />
        </div>
      {/key}
    {:else}
      <!-- the select row's space is kept in the list view: the bar does not grow when the toggle flips -->
      <div class="chips ph" aria-hidden="true"></div>
    {/if}
  </div>
  {#if view === 'order'}
    {#if !orderSet}
      <p class="why">{$t('adminLive.ch.orderNeedsFilter')}</p>
    {:else if orderFailed}
      <div class="why"><p>{$t('adminLive.ch.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={retryOrder}>{$t('ui.retry')}</Button></div>
    {:else if !orderRows}
      <!-- the rows of this selection are on their way: the bar and the list keep their places and size (nothing jumps when they arrive), and nothing can be saved -->
      <div class="order skel">
        <p class="sr-only" role="status">{$t('common.loading')}</p>
        <div class="bar">
          <Button variant="ghost" size="sm" disabled>{$t('adminPeople.roles.discard')}</Button>
          <Button size="sm" disabled>{$t('common.save')}</Button>
        </div>
        <div class="list panel" aria-hidden="true">
          {#each [0, 1, 2] as i (i)}<div class="srow"><span class="sg"></span><span class="st"></span><span class="sn"></span></div>{/each}
        </div>
      </div>
    {:else if tooMany}
      <p class="why">{$t('adminLive.ch.orderTooMany', { n: orderTotal, max: ORDER_MAX })}</p>
    {:else if orderRows && !orderRows.length}
      <p class="why">{$t('adminLive.ch.filters.empty')}</p>
    {:else if orderRows}
      <OrderView rows={orderRows.map((c) => ({ id: c.id, name: c.name, number: c.number, logoHash: c.logoHash }))} locked={$busyKeys.has('ltv-ch-bulk')} save={saveOrder} bind:dirty={orderDirty} />
    {/if}
  {:else}
  <DataTable
    {rows} {columns} key={(c) => c.id} caption={$t('adminLive.ch.caption')} filterable filterPlaceholder={$t('adminLive.ch.search')}
    bind:q bind:sort bind:page pageSize={PAGE_SIZE} {total} error={loadError} on:retry={load} on:query={onQuery}
    {actions} rowLabel={(c) => c.name} busyKey={busyKey} emptyText={$t('adminLive.ch.filters.none')}
  >
    <svelte:fragment slot="toolbar">
      <div class="chips">
        <Select hideLabel label={$t('adminLive.ch.filters.source')} value={filter.source ?? ''} options={sourceOptions} on:change={(e) => setFilter({ source: (e.target as HTMLSelectElement).value || null })} />
        <Select hideLabel label={$t('adminLive.ch.filters.group')} value={filter.group ?? ''} options={groupFilterOptions} on:change={(e) => setFilter({ group: (e.target as HTMLSelectElement).value || null })} />
        {#each [['visible', 'filters.visible'], ['hidden', 'filters.hidden'], ['missing', 'filters.missing']] as const as [k, label] (k)}
          <button type="button" class="chip" aria-pressed={filter.state === k} on:click={() => setFilter({ state: filter.state === k ? null : k })}>{$t(`adminLive.ch.${label}`)}</button>
        {/each}
        <button type="button" class="chip" aria-pressed={filter.epg === 'no'} on:click={() => setFilter({ epg: filter.epg === 'no' ? null : 'no' })}>{$t('adminLive.ch.filters.noEpg')}</button>
        <button type="button" class="chip" aria-pressed={filter.error} on:click={() => setFilter({ error: !filter.error })}>{$t('adminLive.ch.filters.error')}</button>
      </div>
      <div class="meta">
        <span class="count" data-count aria-live="polite">{rows ? $t('adminLive.ch.count', { n: total }) : ''}</span>
        <label class="pageall">
          <input type="checkbox" checked={pageAll} disabled={!rows?.length} on:change={(e) => togglePage(e.currentTarget.checked)} />
          <span>{$t('adminLive.ch.selectPage')}</span>
        </label>
      </div>
    </svelte:fragment>

    <svelte:fragment slot="cell" let:row let:col>
      {#if col.key === 'sel'}
        <label class="ck"><input type="checkbox" checked={selected.has(row.id)} aria-label={$t('adminLive.ch.selectRow', { name: row.name })} on:change={(e) => toggleRow(row, e.currentTarget.checked)} /></label>
      {:else if col.key === 'logo'}
        {#key logoRev}
          <div class="logo" data-logo>
            {#if row.logoHash && !brokenLogos.has(row.logoHash)}<img src={logoSrc(row.logoHash)} alt="" width="40" height="40" loading="lazy" on:error={() => logoFailed(row.logoHash ?? '')} />
            {:else}<span>{row.number ?? '–'}</span>{/if}
          </div>
        {/key}
      {:else if col.key === 'number'}
        <span data-number>{row.number ?? '–'}</span>{#if row.dupNumber}<span class="dup" title={$t('adminLive.ch.dup')}><Icon name="alert" size={16} /><span class="sr-only">{$t('adminLive.ch.dup')}</span></span>{/if}
      {:else if col.key === 'name'}
        <div class="namecell">
          {#if editId === row.id}
            <input class="nm-in" bind:value={editVal} maxlength="60" aria-label={$t('adminLive.ch.renameLabel', { name: row.name })} use:editInit on:keydown={(e) => editKey(e, row)} on:blur={() => commitEdit(row)} />
          {:else}
            <button type="button" class="nm" data-name-of={row.id} title={$t('adminLive.ch.renameHint')} on:dblclick={() => startEdit(row)} on:click={(e) => { if (e.detail === 0) startEdit(row); }}>{row.name}</button>
            {#if hintOf(row)}<span class="dot" data-changed title={hintOf(row)}><span class="pt" aria-hidden="true"></span><span class="tx">{hintOf(row)}</span></span>{/if}
            {#if row.missing}<StatusPill tone="warn" label={$t('adminLive.ch.missingPill')} />{/if}
            <!-- an own feed always has this line's room; only its opacity changes, so the row never moves -->
            {#if row.push}<span class="sync" class:on={syncing(row)} data-syncing={syncing(row) ? '' : undefined} aria-hidden={syncing(row) ? undefined : 'true'}>{$t('adminLive.ch.syncing')}</span>{/if}
          {/if}
        </div>
      {:else if col.key === 'group'}
        {#key rev[row.id] ?? 0}
          <div class="gsel"><Select hideLabel label={$t('adminLive.ch.groupOf', { name: row.name })} value={row.groupId ?? ''} options={groupOptions(row)} on:change={(e) => setGroup(row, (e.target as HTMLSelectElement).value)} /></div>
        {/key}
      {:else if col.key === 'source'}
        {sourceName(row.sourceId)}
      {:else if col.key === 'kind'}
        <StatusPill tone="muted" icon="" label={$t(kindChip(row))} />
      {:else if col.key === 'mode'}
        {#if row.probeError}<span title={channelError(row.probeError)}><StatusPill tone="err" label={$t('adminLive.ch.mode.error')} /><span class="sr-only">{channelError(row.probeError)}</span></span>
        {:else if row.mode}<StatusPill tone="ok" label={$t(`adminLive.ch.mode.${row.mode}`)} />
        {:else}<StatusPill tone="muted" icon="" label={$t('adminLive.ch.mode.none')} />{/if}
      {:else if col.key === 'epg'}
        <div class="epgc">
          {#if row.epgPin?.guideDisabled}<StatusPill tone="warn" label={$t('adminLive.ch.pin.guideOff')} />
          {:else if row.epg}<StatusPill tone="ok" icon="check" label={$t('adminLive.ch.epgOk')} />{:else}<StatusPill tone="muted" icon="" label={$t('adminLive.ch.epgNone')} />{/if}
          {#if row.epgPin}<span class="pinned" data-pin>{$t('adminLive.ch.pin.by', { guide: row.epgPin.sourceName })}</span>{/if}
        </div>
      {:else if col.key === 'visible'}
        <Toggle hideLabel label={$t('adminLive.ch.visibleLabel', { name: row.name })} checked={!row.hidden} pending={$busyKeys.has(busyKey(row))} on:change={(e) => setHidden(row, e.detail)} />
      {/if}
    </svelte:fragment>

    <svelte:fragment slot="empty">
      <p>{filtered ? $t('adminLive.ch.filters.empty') : $t('adminLive.ch.filters.none')}</p>
      {#if filtered}<Button variant="ghost" size="sm" on:click={clearFilters}>{$t('adminLive.ch.filters.clear')}</Button>{/if}
    </svelte:fragment>
  </DataTable>
  {/if}
</div>

<BulkBar count={view === 'list' ? selected.size : 0} bind:height={bulkH} {groups} busy={$busyKeys.has('ltv-ch-bulk')}
  on:clear={() => (selected = new Map())}
  on:hide={() => bulk({ ids, action: 'hide' })} on:show={() => bulk({ ids, action: 'show' })}
  on:group={(e) => bulk({ ids, action: 'group', groupId: e.detail.groupId })} on:renumber={(e) => bulk({ ids, action: 'renumber', from: e.detail.from })}
  on:reset={bulkReset} on:test={bulkTest} />

{#if sheet?.kind === 'test'}
  <TestSheet channel={sheet.channel} returnTo={menuButton(sheet.label)} on:tested={() => sheet?.kind === 'test' && refreshRow(sheet.channel.id)} on:close={closeSheet} />
{:else if sheet?.kind === 'bulktest'}
  <TestSheet bulk={{ ids: sheet.ids, names: sheet.names }} returnTo={() => bulkTrigger} on:tested={load} on:close={closeSheet} />
{:else if sheet?.kind === 'logo'}
  <LogoSheet channel={sheet.channel} returnTo={menuButton(sheet.label)} on:changed={(e) => replaceRow(e.detail)} on:close={closeSheet} />
{:else if sheet?.kind === 'shift'}
  <EpgShiftSheet channel={sheet.channel} returnTo={menuButton(sheet.label)} on:changed={(e) => replaceRow(e.detail)} on:close={closeSheet} />
{:else if sheet?.kind === 'pin'}
  <PinSheet channel={sheet.channel} {sources} returnTo={menuButton(sheet.label)} on:changed={(e) => replaceRow(e.detail)} on:close={closeSheet} />
{/if}

<style>
  .ch { min-width: 0; }
  /* the bulk bar floats above the bottom edge: the list pads its end by the bar's measured height (--bb-h, 0 without a selection) plus the
     bar's distance from the edge, never less than 7rem, so the pager and the last rows stay reachable and the bar's arrival moves nothing */
  .ch { padding-bottom: max(7rem, calc(var(--bb-h, 0px) + 2rem)); }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; flex: 1 1 100%; }
  .chips :global(.field) { flex: 0 1 12rem; min-width: 9rem; }
  .viewbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; margin-bottom: .75rem; }
  .viewbar .chips { flex: 1 1 20rem; }
  .views { display: inline-flex; padding: 3px; border-radius: 12px; background: rgba(var(--fr-scrim-rgb), .25); box-shadow: inset 0 0 0 1px var(--fr-line, var(--line)); }
  .vw { min-height: 44px; min-width: 44px; padding: 0 1rem; border-radius: 9px; background: transparent; color: var(--mut); font-weight: 600; }
  .vw.on { background: var(--acc); color: #1a1a1a; }
  .vw:focus-visible { outline: 2px solid #fff; outline-offset: 1px; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  /* the selects' row (a field is about 45 px high) has one height with or without the selects */
  .viewbar .chips { min-height: 48px; }
  .why { margin: .5rem 0; color: var(--mut); }
  /* the loading box has the bar and list of the OrderView (same gap, bar, row height, list padding) with room for three rows */
  .skel { display: flex; flex-direction: column; gap: .75rem; }
  .skel .bar { display: flex; justify-content: flex-end; gap: .5rem; }
  .skel .list { margin: 0; padding: 8px; min-height: calc(3 * 56px + 16px); box-sizing: border-box; }
  .srow { display: flex; align-items: center; gap: 12px; height: 56px; padding: 6px 10px 6px 4px; box-sizing: border-box; }
  .srow span { display: block; border-radius: 8px; background: rgba(255, 255, 255, .08); }
  .sg { flex: none; width: 44px; height: 24px; }
  .st { flex: none; width: 40px; height: 40px; border-radius: 10px; }
  .sn { flex: 0 1 12rem; height: 14px; }
  .chip { min-height: 44px; padding: 0 1rem; border-radius: 999px; background: rgba(255, 255, 255, .06); border: 1px solid var(--fr-line, rgba(255, 255, 255, .2)); color: rgba(255, 255, 255, .85); font-weight: 600; }
  .chip:hover:not(:disabled) { background: rgba(255, 255, 255, .12); color: #fff; }
  .chip[aria-pressed='true'] { background: #fff; color: #101418; border-color: #fff; }
  /* the count line keeps its height before the first answer */
  .meta { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem 1rem; min-height: 44px; }
  .count { font-weight: 700; font-variant-numeric: tabular-nums; min-height: 1.5em; }
  .pageall, .ck { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; cursor: pointer; }
  .ck { justify-content: center; min-width: 44px; margin: -.4rem 0; }
  .logo { box-sizing: border-box; width: 40px; height: 40px; display: grid; place-items: center; overflow: hidden; border-radius: 10px; background: rgba(var(--fr-scrim-rgb, 18, 16, 24), .5); border: 1px solid var(--fr-line, rgba(255, 255, 255, .2)); font-weight: 800; font-size: .8rem; font-variant-numeric: tabular-nums; }
  .logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .dup { display: inline-flex; vertical-align: middle; margin-left: .3rem; color: var(--warn); }
  .namecell { display: flex; align-items: center; flex-wrap: wrap; gap: .1rem .5rem; min-width: 0; }
  .nm { min-height: 44px; padding: 0 .2rem; background: transparent; color: inherit; font: inherit; font-weight: 600; text-align: left; overflow-wrap: anywhere; border-radius: 6px; }
  .nm:hover:not(:disabled) { background: rgba(255, 255, 255, .06); }
  .nm-in { min-height: 44px; width: min(100%, 22rem); box-sizing: border-box; }
  .dot { display: inline-flex; align-items: center; }
  .dot .pt { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
  .dot .tx { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .sync { font-size: .85rem; color: var(--mut); opacity: 0; transition: opacity .2s; }
  .sync.on { opacity: 1; }
  :global(html.m-still) .sync { transition: none; }
  .gsel { min-width: 9rem; }
  .epgc { display: flex; flex-direction: column; align-items: flex-start; gap: .2rem; min-width: 0; }
  .pinned { font-size: .85rem; color: var(--mut); overflow-wrap: anywhere; }
  /* phone: a card per row. The name leads (it is the card's title), the checkbox and the rest follow; the changed hint is text there,
     where there is no hover */
  @media (max-width: 720px) {
    .ch :global(table tbody tr) { display: flex; flex-direction: column; }
    .ch :global(table tbody td.primary) { order: -1; }
    .dot .tx { position: static; width: auto; height: auto; overflow: visible; clip: auto; white-space: normal; font-size: .85rem; color: var(--mut); }
    .dot .pt { display: none; }
    .gsel { min-width: 0; flex: 1 1 10rem; }
    .ch { padding-bottom: max(7rem, calc(var(--bb-h, 0px) + var(--tabbar-h, 0px) + var(--safe-bottom, 0px) + 1.6rem)); }
    .chips :global(.field) { flex: 1 1 100%; }
    /* the bar's two selects share one row: the row has the same height in both views */
    .viewbar .chips :global(.field) { flex: 1 1 9rem; }
  }
</style>
