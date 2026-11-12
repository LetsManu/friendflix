<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** User detail, audit tab (*Verlauf* of the person, spec 6.6): entries where the user is the target or the actor, newest first, as sentences with from → to chips and details (server paging). */
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import { describeActivity, type AuditEntry } from '#lib/admin/activity';
  import { auditDetails } from '#lib/admin/people';
  import { entrySentence, fetchRoleNames, type RoleNames } from '#lib/admin/rights/auditText';
  import { fetchRoles, type RolesLoader } from '#lib/admin/rights/rolesAnswer';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import type { Column, Query } from '#lib/ui/table';

  export let userId: string;
  /** GET /api/admin/roles for the role names (the person page shares one answer) */
  export let loadRoles: RolesLoader = fetchRoles;
  const PAGE = 25;
  let rows: AuditEntry[] | null = null, total = 0, error: string | null = null, page = 0;
  let cur: Query = { q: '', sort: null, offset: 0, limit: PAGE };
  let seq = 0;
  let names: RoleNames | null = null;

  async function load() {
    const my = ++seq;
    try {
      const r = await api<{ entries: AuditEntry[]; total: number }>(`/api/admin/users/${userId}/audit?limit=${cur.limit}&offset=${cur.offset}`);
      if (my === seq) { rows = r.entries; total = r.total; error = null; }
    } catch {
      if (my === seq) error = tr('adminPeople.loadFailed');
    }
  }
  onMount(() => { void load(); void fetchRoleNames(loadRoles).then((n) => { names = n; }); });
  function onQuery(e: CustomEvent<Query>) { cur = e.detail; void load(); }
  function retry() { error = null; rows = null; void load(); }

  $: columns = [
    { key: 'entry', label: $t('adminPeople.audit.col.entry'), primary: true, sortable: false },
    { key: 'time', label: $t('adminPeople.audit.col.time'), sortable: false, width: '12rem' },
  ] satisfies Column<AuditEntry>[];
</script>

<DataTable caption={$t('adminPeople.detail.tabs.audit')} {rows} {columns} key={(e) => String(e.id)} {total} {error} pageSize={PAGE} bind:page
  emptyText={$t('adminPeople.detail.audit.empty')} on:query={onQuery} on:retry={retry}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'entry'}
      {@const a = describeActivity(row)}
      {@const rs = entrySentence(row, names)}
      {@const details = auditDetails(row.meta)}
      <div class="ent">
        <span class="ic" aria-hidden="true"><Icon name={a.icon} size={16} /></span>
        <div class="tx">
          <span class="line">{rs?.text ?? a.text}</span>
          {#if rs?.chips.length}
            <ul class="chips">{#each rs.chips as c (c.label)}<li class="chip">{$t('adminPeople.roles.auditChip', { field: c.label, from: c.from, to: c.to })}</li>{/each}</ul>
          {/if}
          {#if details.length}
            <details>
              <summary>{$t('adminPeople.audit.details')}</summary>
              <dl>{#each details as d (d.label)}<dt>{d.label}</dt><dd>{d.value}</dd>{/each}</dl>
            </details>
          {/if}
        </div>
      </div>
    {:else if col.key === 'time'}
      <time datetime={row.at} title={fmtDateTime(row.at, { dateStyle: 'full', timeStyle: 'medium' })}>{fmtRelative(row.at)}</time>
    {/if}
  </svelte:fragment>
</DataTable>
<p class="more"><Button variant="ghost" icon="list" href="/admin/audit?target={encodeURIComponent(userId)}">{$t('adminPeople.audit.openInLog')}</Button></p>

<style>
  .ent { display: flex; align-items: flex-start; gap: .7rem; min-width: 0; text-align: left; }
  .ic { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 50%; background: rgba(255,255,255,.08); color: var(--mut); }
  .tx { min-width: 0; flex: 1; }
  .line { display: block; font-weight: 500; padding-top: .15rem; overflow-wrap: anywhere; }
  .chips { list-style: none; margin: .3rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip { padding: .2rem .7rem; border-radius: 99px; background: rgba(255,255,255,.08); font-size: .85rem; font-weight: 600; overflow-wrap: anywhere; }
  .more { margin: .6rem 0 0; }
  summary { cursor: pointer; color: var(--info); font-size: .85rem; font-weight: 600; min-height: 32px; display: inline-flex; align-items: center; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem 1rem; margin: .3rem 0 .4rem; font-size: .88rem; }
  dt { color: var(--mut); }
  dd { margin: 0; overflow-wrap: anywhere; }
  time { white-space: nowrap; }
</style>
