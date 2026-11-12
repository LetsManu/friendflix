<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: audit log – server paging, filters (who, area incl. *Personen*, the target from a link `?target=<person id | role key>`, date range,
   * search), entries as sentences (people's rights and roles with from → to chips, auditText.ts) with expandable key/value details.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '#lib/api';
  import { pageStore } from '#lib/page';
  import { entrySentence, fetchRoleNames, type RoleNames } from '#lib/admin/rights/auditText';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, t, tr, trDynamic } from '#lib/i18n';
  import { describeActivity, type AuditEntry } from '#lib/admin/activity';
  import { auditArea, auditDetails, dayEnd, dayStart } from '#lib/admin/people';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import type { Column, Query, SortState } from '#lib/ui/table';

  type E = AuditEntry & { actor_id?: string | null };
  const PAGE = 25;
  let rows: E[] | null = null, total = 0, error: string | null = null;
  let actors: Array<{ id: string; name: string }> = [], hasSystem = false, categories: string[] = [];
  let q = '', sort: SortState | null = { key: 'time', dir: 'desc' }, page = 0;
  let actor = '', area = '', from = '', to = '';
  const page$ = pageStore();
  /** the target filter of the link (a person id or a role key); changes with the URL */
  let target = '', mounted = false, names: RoleNames | null = null;
  $: urlTarget = $page$.url.searchParams.get('target')?.slice(0, 64) ?? '';
  $: if (urlTarget !== target) { target = urlTarget; if (mounted) refilter(); }
  let cur: Query = { q: '', sort: { key: 'time', dir: 'desc' }, offset: 0, limit: PAGE };
  let seq = 0;

  async function load() {
    const my = ++seq;
    const p = new URLSearchParams({ limit: String(cur.limit), offset: String(cur.offset), dir: cur.sort?.dir === 'asc' ? 'asc' : 'desc' });
    if (cur.q.trim()) p.set('q', cur.q.trim());
    if (actor) p.set('actor', actor);
    if (area === 'people') p.set('area', 'people');
    else if (area) p.set('action', area);
    if (target) p.set('target', target);
    const f = dayStart(from), u = dayEnd(to);
    if (f) p.set('from', f);
    if (u) p.set('to', u);
    try {
      const r = await api<{ entries: E[]; total: number }>(`/api/admin/audit?${p}`);
      if (my !== seq) return;
      rows = r.entries; total = r.total; error = null;
    } catch {
      if (my === seq) error = tr('adminPeople.loadFailed');
    }
  }
  function retry() { error = null; rows = null; void load(); }
  function onQuery(e: CustomEvent<Query>) { cur = e.detail; void load(); }
  function refilter() { page = 0; cur = { ...cur, offset: 0 }; void load(); }
  function reset() { actor = ''; area = ''; from = ''; to = ''; q = ''; page = 0; cur = { ...cur, q: '', offset: 0 }; if (target) clearTarget(); else void load(); }
  /** drops `?target=` (the URL change reloads the list) */
  function clearTarget() { void goto($page$.url.pathname, { replaceState: true, reset: false }); }
  onMount(() => {
    mounted = true;
    void load();
    void fetchRoleNames().then((n) => { names = n; });
    api<{ actors: Array<{ id: string; name: string }>; system: boolean; categories: string[] }>('/api/admin/audit/filters').then((r) => { actors = r.actors; hasSystem = r.system; categories = r.categories; }, () => undefined);
  });

  $: actorOptions = [{ value: '', label: $t('adminPeople.audit.anyone') }, ...(hasSystem ? [{ value: 'system', label: $t('adminPeople.audit.system') }] : []), ...actors.map((a) => ({ value: a.id, label: a.name }))];
  $: areaOptions = [{ value: '', label: $t('adminPeople.audit.allAreas') }, { value: 'people', label: $t('adminPeople.audit.people') }, ...categories.map((c) => ({ value: c, label: auditArea(`${c}.x`)?.label ?? c }))];
  $: columns = [
    { key: 'entry', label: $t('adminPeople.audit.col.entry'), primary: true, sortable: false },
    { key: 'time', label: $t('adminPeople.audit.col.time'), sortable: true, width: '12rem' },
  ] satisfies Column<E>[];
  $: filtered = Boolean(actor || area || target || from || to || q.trim());
  /** who the target filter is about: a person from the entries, else a role from the matrix */
  $: targetName = rows?.find((r) => r.target === target && r.target_name)?.target_name ?? names?.(target)
    // a deleted role: the label its role.delete / role.create entry carries
    ?? ((l) => (typeof l === 'string' && l ? l : null))(rows?.find((r) => r.target === target && typeof r.meta?.label === 'string')?.meta?.label)
    ?? $t('adminPeople.audit.targetUnknown');
  // a reactive statement: the sentences follow the role names when they arrive
  $: sentence = (e: E) => { const s = entrySentence(e, names), a = describeActivity(e); return { text: s?.text ?? a.text, icon: a.icon, chips: s?.chips ?? [] }; };
</script>

<DataTable
  caption={$t('admin.tabs.audit')} {rows} {columns} key={(e) => String(e.id)} {total} {error} pageSize={PAGE}
  filterable filterPlaceholder={$t('adminPeople.audit.searchPlaceholder')}
  bind:q bind:sort bind:page emptyText={filtered ? $t('adminPeople.audit.emptyFiltered') : $t('adminPeople.audit.empty')}
  on:query={onQuery} on:retry={retry}
>
  <svelte:fragment slot="toolbar">
    <Select label={$t('adminPeople.audit.filterActor')} options={actorOptions} bind:value={actor} on:change={refilter} hideLabel />
    <Select label={$t('adminPeople.audit.filterArea')} options={areaOptions} bind:value={area} on:change={refilter} hideLabel />
    {#if target}
      <div class="tchip" role="group" aria-label={$t('adminPeople.audit.targetFilter', { name: targetName })}>
        <span>{$t('adminPeople.audit.targetFilter', { name: targetName })}</span>
        <button type="button" aria-label={$t('adminPeople.audit.targetClear')} title={$t('adminPeople.audit.targetClear')} on:click={clearTarget}><Icon name="x" size={18} /></button>
      </div>
    {/if}
    <Field label={$t('adminPeople.audit.from')} type="date" bind:value={from} on:change={refilter} />
    <Field label={$t('adminPeople.audit.to')} type="date" bind:value={to} on:change={refilter} />
    {#if filtered}<Button variant="ghost" size="sm" icon="x" on:click={reset}>{$t('adminPeople.audit.reset')}</Button>{/if}
  </svelte:fragment>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'entry'}
      {@const s = sentence(row)}
      {@const details = auditDetails(row.meta)}
      {@const ar = auditArea(row.action)}
      <div class="ent">
        <span class="ic" aria-hidden="true"><Icon name={s.icon} size={16} /></span>
        <div class="tx">
          <span class="line">{s.text}</span>
          {#if s.chips.length}
            <ul class="chips">{#each s.chips as c (c.label)}<li class="chip">{$t('adminPeople.roles.auditChip', { field: c.label, from: c.from, to: c.to })}</li>{/each}</ul>
          {/if}
          <details>
            <summary>{$t('adminPeople.audit.details')}</summary>
            <dl>
              <dt>{$t('adminPeople.audit.when')}</dt><dd>{fmtDateTime(row.at, { dateStyle: 'full', timeStyle: 'medium' })}</dd>
              <dt>{$t('adminPeople.audit.who')}</dt><dd>{row.actor || $t('adminPeople.audit.system')}</dd>
              {#if row.target_name}<dt>{$t('adminPeople.audit.about')}</dt><dd>{row.target_name}</dd>{/if}
              {#if ar}<dt>{$t('adminPeople.audit.area')}</dt><dd>{ar.label}</dd>{/if}
              {#each details as d (d.label)}<dt>{d.label}</dt><dd>{d.value}</dd>{/each}
            </dl>
          </details>
        </div>
      </div>
    {:else if col.key === 'time'}
      <time datetime={row.at} title={fmtDateTime(row.at, { dateStyle: 'full', timeStyle: 'medium' })}>{fmtRelative(row.at)}<span class="abs">{fmtDateTime(row.at)}</span></time>
    {/if}
  </svelte:fragment>
</DataTable>

<style>
  .ent { display: flex; align-items: flex-start; gap: .7rem; min-width: 0; text-align: left; }
  .ic { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 50%; background: rgba(255,255,255,.08); color: var(--mut); }
  .tx { min-width: 0; flex: 1; }
  .line { display: block; font-weight: 500; padding-top: .15rem; overflow-wrap: anywhere; }
  .chips { list-style: none; margin: .3rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip { padding: .2rem .7rem; border-radius: 99px; background: rgba(255,255,255,.08); font-size: .85rem; font-weight: 600; overflow-wrap: anywhere; }
  .tchip { display: inline-flex; align-items: center; gap: .2rem; min-height: 44px; max-width: 100%; padding: 0 .2rem 0 .9rem; border-radius: 99px; background: rgba(255,255,255,.08); font-weight: 600; }
  .tchip span { min-width: 0; overflow-wrap: anywhere; }
  .tchip button { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: inherit; }
  .tchip button:hover { background: rgba(255,255,255,.12); }
  details { margin-top: .2rem; }
  summary { cursor: pointer; color: var(--info); font-size: .85rem; font-weight: 600; min-height: 32px; display: inline-flex; align-items: center; border-radius: 4px; }
  summary:hover { text-decoration: underline; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem 1rem; margin: .3rem 0 .4rem; font-size: .88rem; }
  dt { color: var(--mut); }
  dd { margin: 0; overflow-wrap: anywhere; }
  time { display: inline-flex; flex-direction: column; white-space: nowrap; }
  .abs { color: var(--mut); font-size: .8rem; }
  @media (max-width: 720px) { time { align-items: flex-end; } }
  :global(.dt .bar) { align-items: flex-end; }
  :global(.dt .bar .field) { min-width: 9.5rem; }
  :global(.dt .bar input[type='date']) { min-width: 9.5rem; }
</style>
