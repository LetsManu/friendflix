<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Kanäle* (spec §9.2, list mode): the server-paged channel list (DataTable, 100 per page) with search (name, number,
   * tvg-id), the filters *Quelle*, *Gruppe*, *Sichtbar / Ausgeblendet / Fehlt*, *Ohne Programm* and *Mit Fehler*, the result count, and
   * per row: checkbox, logo tile (the number when there is none), number, name (inline edit: double click or Enter; Escape cancels; empty =
   * the import's name), group (inline select), source, kind chip, mode chip (from the last test), EPG state, visibility switch and the
   * menu (*Testen*, *Logo ändern*, *Programm-Zeit verschieben…*, *Umbenennen* for touch, *Zurücksetzen*). A small dot says what the
   * import had ("geändert (Import: …)", never for own feeds). The selection is kept by id across pages and filters; the bulk bar acts on
   * it. Every write answers the updated channel, which replaces its row; the list is read again after a bulk action. *Reihenfolge* is
   * Task 24's. Loading keeps the old rows (no skeleton flash on paging); a late answer of an older request is dropped.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import type { MoreAction } from '#lib/MoreActions.svelte';
  import type { Column, Query, SortState } from '#lib/ui/table';
  import { toast } from '#lib/ui/toast';
  import { listGroups, listSources, type GroupOption, type SourceView } from './api';
  import BulkBar from './BulkBar.svelte';
  import {
    bulkChannels, channelError, emptyFilter, failText, getChannel, kindChip, listChannels, logoSrc, overrideHint, patchChannel, PAGE_SIZE,
    type AdminChannel, type BulkBody, type ChannelFilter, type ChannelPatch, type ChannelSort,
  } from './channels';
  import EpgShiftSheet from './EpgShiftSheet.svelte';
  import LogoSheet from './LogoSheet.svelte';
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
      if (rows) toast.error(failText(e)); else loadError = tr('adminLive.ch.loadFailed');
    } finally { if (mine === seq) loading = false; }
  }
  onMount(() => {
    void load();
    listSources().then((s) => { sources = s; }).catch(() => undefined);
    listGroups().then((g) => { groups = g; }).catch(() => undefined);
  });
  onDestroy(() => { gone = true; ctl?.abort(); });

  function onQuery(e: CustomEvent<Query>) {
    const { q: text, sort: s, offset } = e.detail;
    filter = { ...filter, q: text, sort: (s?.key as ChannelSort | undefined) ?? 'number', dir: s?.dir ?? 'asc', offset };
    void load();
  }
  /** a chip, select or reset: starts at the first page again */
  function setFilter(patch: Partial<ChannelFilter>) {
    page = 0;
    filter = { ...filter, ...patch, offset: 0 };
    void load();
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

<div class="ch" class:has-bar={selected.size > 0} aria-busy={loading ? 'true' : undefined}>
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
        {#if row.probeError}<span title={channelError(row.probeError)}><StatusPill tone="err" label={$t('adminLive.ch.mode.error')} /></span>
        {:else if row.mode}<StatusPill tone="ok" label={$t(`adminLive.ch.mode.${row.mode}`)} />
        {:else}<StatusPill tone="muted" icon="" label={$t('adminLive.ch.mode.none')} />{/if}
      {:else if col.key === 'epg'}
        {#if row.epg}<StatusPill tone="ok" icon="check" label={$t('adminLive.ch.epgOk')} />{:else}<StatusPill tone="muted" icon="" label={$t('adminLive.ch.epgNone')} />{/if}
      {:else if col.key === 'visible'}
        <Toggle hideLabel label={$t('adminLive.ch.visibleLabel', { name: row.name })} checked={!row.hidden} pending={$busyKeys.has(busyKey(row))} on:change={(e) => setHidden(row, e.detail)} />
      {/if}
    </svelte:fragment>

    <svelte:fragment slot="empty">
      <p>{filtered ? $t('adminLive.ch.filters.empty') : $t('adminLive.ch.filters.none')}</p>
      {#if filtered}<Button variant="ghost" size="sm" on:click={clearFilters}>{$t('adminLive.ch.filters.clear')}</Button>{/if}
    </svelte:fragment>
  </DataTable>
</div>

<BulkBar count={selected.size} {groups} busy={$busyKeys.has('ltv-ch-bulk')}
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
{/if}

<style>
  .ch { min-width: 0; }
  /* the bulk bar floats above the bottom edge: the list pads its end while it is there, so the last rows stay reachable */
  .ch.has-bar { padding-bottom: 7rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; flex: 1 1 100%; }
  .chips :global(.field) { flex: 0 1 12rem; min-width: 9rem; }
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
  .gsel { min-width: 9rem; }
  /* phone: a card per row. The name leads (it is the card's title), the checkbox and the rest follow; the changed hint is text there,
     where there is no hover */
  @media (max-width: 720px) {
    .ch :global(table tbody tr) { display: flex; flex-direction: column; }
    .ch :global(table tbody td.primary) { order: -1; }
    .dot .tx { position: static; width: auto; height: auto; overflow: visible; clip: auto; white-space: normal; font-size: .85rem; color: var(--mut); }
    .dot .pt { display: none; }
    .gsel { min-width: 0; flex: 1 1 10rem; }
    .chips :global(.field) { flex: 1 1 100%; }
  }
</style>
