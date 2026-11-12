<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Gruppen & Rechte* (spec §8, §9.3). Three views of the same groups (a radio group above the list):
   *  - *Liste*: unreleased groups first with the chip *Nicht freigegeben* and "Für niemanden sichtbar", the notice "{n} neue Gruppen
   *    warten auf Freigabe" with *Nur diese zeigen* (also `?pending=1`, the link of the *Quellen* card); per group the channel count,
   *    *Kinderfreundlich*, the role chips and the provider groups mapped into it; a row menu (*Freigeben …* / *Freigabe zurücknehmen*,
   *    *Umbenennen*, *Löschen*); a bulk bar for the selected groups (*Freigeben …*, *Zusammenführen …*); *Gruppe anlegen*.
   *  - *Nach Rolle*: groups × roles switches (GroupMatrix) and the people with exceptions (read from each account, ruling R21).
   *  - *Reihenfolge*: the drag order (OrderView, `PUT /groups/order`).
   * The kids preview line stays above all three. Every write goes through `runAction` and reloads the list; a write that fails says
   * why (`groupErrorOf`) and the switches that were flipped go back.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import { locale, t, tr } from '#lib/i18n';
  import { pageStore } from '#lib/page';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { fetchRoles } from '#lib/admin/rights/rolesAnswer';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { uid } from '#lib/ui/ids';
  import GroupMatrix from './GroupMatrix.svelte';
  import GroupNameDialog from './GroupNameDialog.svelte';
  import MergeDialog from './MergeDialog.svelte';
  import OrderView from './OrderView.svelte';
  import ReleaseSheet from './ReleaseSheet.svelte';
  import {
    createGroup, deleteGroup, exceptionsOf, fetchGroups, groupErrorOf, kidsLine, loadExceptions, mergeGroups, orderGroups, patchGroup, pendingFirst, releaseGroups, rolesFor,
    type GrantRole, type GroupsAnswer, type GroupView, type PersonExceptions,
  } from './groups';

  const id = uid('grp');
  const page$ = pageStore();
  type View = 'list' | 'roles' | 'order';
  const VIEWS: View[] = ['list', 'roles', 'order'];

  let data: GroupsAnswer | null = null, failed = false;
  let roles: GrantRole[] = [];
  let view: View = 'list';
  let selected = new Set<string>();
  /** bumped after a refused write: the switches rebuild from the stored state */
  let rev = 0;
  let people: PersonExceptions[] | null = null, peopleFailed = false;
  let list: HTMLElement | undefined;

  async function load() {
    try { data = await fetchGroups(); failed = false; } catch { if (!data) failed = true; }
    // a group that is gone (deleted, merged) is no longer selected
    if (data) selected = new Set([...selected].filter((x) => data!.groups.some((g) => g.id === x)));
  }
  async function loadRoles() {
    try { roles = rolesFor((await fetchRoles()).matrix?.roles ?? []); } catch { roles = []; }
  }
  async function loadPeople() {
    people = null; peopleFailed = false;
    try { people = exceptionsOf(await loadExceptions(4)); } catch { peopleFailed = true; }
  }
  onMount(() => { void load(); void loadRoles(); });
  $: if (view === 'roles' && people === null && !peopleFailed) void loadPeople();

  /** `?pending=1`: only the groups that wait for a release; gone once none waits */
  $: pending = data?.pending ?? 0;
  $: onlyPending = $page$.url.searchParams.get('pending') === '1' && pending > 0;
  function setOnlyPending(on: boolean) {
    const u = new URL($page$.url.href);
    if (on) u.searchParams.set('pending', '1'); else u.searchParams.delete('pending');
    void goto(`${u.pathname}${u.search}`, { replaceState: true, reset: false });
  }

  $: groups = data?.groups ?? [];
  $: shown = pendingFirst(groups, onlyPending);
  $: byPosition = [...groups].sort((a, b) => a.position - b.position);
  $: orderRows = byPosition.map((g) => ({ id: g.id, name: g.name, number: null, logoHash: null }));
  $: kids = $locale && data ? kidsLine(groups) : '';
  $: pickedGroups = shown.filter((g) => selected.has(g.id));
  $: pickedPending = pickedGroups.filter((g) => !g.released);
  $: busy = $busyKeys;

  const toggleSel = (gid: string) => { const n = new Set(selected); if (n.has(gid)) n.delete(gid); else n.add(gid); selected = n; };

  /** one write: busy key, the sentence of a refusal as the toast, a reload after it; false when it failed */
  async function write(key: string, run: () => Promise<unknown>, success: string): Promise<boolean> {
    const r = await runAction({ key, run, success, error: groupErrorOf });
    if (!r.ok && !r.skipped) rev++;
    await load();
    return r.ok;
  }

  // ---- the row's own switches
  const setKid = (g: GroupView, on: boolean) => write(`grp:${g.id}`, () => patchGroup(g.id, { kidFriendly: on }), tr('common.saved'));
  function setRole(g: GroupView, role: string, on: boolean) {
    const next = on ? [...g.roles.filter((k) => k !== role), role] : g.roles.filter((k) => k !== role);
    return write(`grp:${g.id}:${role}`, () => patchGroup(g.id, { roles: next }), tr('common.saved'));
  }

  // ---- dialogs
  type Dialog = { kind: 'create' } | { kind: 'rename'; group: GroupView } | { kind: 'release'; groups: GroupView[] } | { kind: 'merge'; groups: GroupView[] };
  let dialog: Dialog | null = null, trigger: HTMLElement | null = null, dialogError = '';
  const open = (d: Dialog, from: HTMLElement | null) => { dialogError = ''; trigger = from; dialog = d; };
  const close = () => { dialog = null; dialogError = ''; };
  const rowMenu = (gid: string): HTMLElement | null => list?.querySelector<HTMLElement>(`[data-gid="${CSS.escape(gid)}"] .acts button`) ?? null;
  const here = (e: MouseEvent) => (e.currentTarget instanceof HTMLElement ? e.currentTarget : null);

  async function doCreate(name: string) {
    const r = await runAction({ key: 'grp:new', run: () => createGroup({ name }), success: tr('adminLive.grp.created'), error: false });
    if (r.ok) { close(); await load(); } else if (!r.skipped) dialogError = groupErrorOf(r.error);
  }
  async function doRename(g: GroupView, name: string) {
    if (name === g.name) { close(); return; }
    const r = await runAction({ key: `grp:${g.id}`, run: () => patchGroup(g.id, { name }), success: tr('adminLive.grp.renamed'), error: false });
    if (r.ok) { close(); await load(); } else if (!r.skipped) dialogError = groupErrorOf(r.error);
  }
  async function doRelease(gs: GroupView[], d: { roles: string[]; kidFriendly: boolean }) {
    const ids = gs.map((g) => g.id);
    if (await write('grp:release', () => releaseGroups(ids, d.roles, d.kidFriendly), tr('adminLive.grp.released'))) { selected = new Set(); close(); }
  }
  async function doMerge(gs: GroupView[], d: { ids: string[]; into: string }) {
    const r = await runAction({ key: 'grp:merge', run: () => mergeGroups(d.ids, d.into), success: tr('adminLive.grp.merged'), error: false });
    if (r.ok) { selected = new Set(); close(); await load(); } else if (!r.skipped) dialogError = groupErrorOf(r.error);
  }
  async function unrelease(g: GroupView) {
    const ok = await confirm({ title: tr('adminLive.grp.unreleaseTitle', { name: g.name }), body: tr('adminLive.grp.unreleaseBody'), danger: true, confirmLabel: tr('adminLive.grp.unrelease') });
    if (ok) await write(`grp:${g.id}`, () => patchGroup(g.id, { released: false }), tr('adminLive.grp.unreleaseDone'));
  }
  async function remove(g: GroupView) {
    const ok = await confirm({ title: tr('adminLive.grp.deleteTitle', { name: g.name }), body: tr('adminLive.grp.deleteBody', { n: g.channels, none: tr('adminLive.grp.noGroup') }), danger: true, confirmLabel: tr('adminLive.grp.delete') });
    if (ok) await write(`grp:${g.id}`, () => deleteGroup(g.id), tr('adminLive.grp.deleted'));
  }

  const items = (g: GroupView, _l: unknown) => [
    g.released
      ? { id: 'unrelease', label: tr('adminLive.grp.unrelease'), icon: 'eye-off', run: () => { void unrelease(g); } }
      : { id: 'release', label: tr('adminLive.grp.release'), icon: 'eye', run: () => open({ kind: 'release', groups: [g] }, rowMenu(g.id)) },
    { id: 'rename', label: tr('adminLive.grp.rename'), icon: 'pencil', run: () => open({ kind: 'rename', group: g }, rowMenu(g.id)) },
    { id: 'delete', label: tr('adminLive.grp.delete'), icon: 'x', danger: true, run: () => { void remove(g); } },
  ];
  const viewKey = (v: View) => `adminLive.grp.view${v === 'list' ? 'List' : v === 'roles' ? 'Roles' : 'Order'}` as 'adminLive.grp.viewList';
  function viewKeys(e: KeyboardEvent) {
    const i = VIEWS.indexOf(view);
    const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % VIEWS.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i + VIEWS.length - 1) % VIEWS.length : -1;
    if (n < 0) return;
    e.preventDefault();
    view = VIEWS[n]!;
    queueMicrotask(() => document.getElementById(`${id}-v-${view}`)?.focus());
  }
</script>

{#if !data}
  {#if failed}
    <AdminCard><div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminLive.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div></AdminCard>
  {:else}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="14rem" h="1.6rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {/if}
{:else}
  <div class="tab">
    <div class="bar">
      <div class="views" role="radiogroup" aria-label={$t('adminLive.grp.view')}>
        {#each VIEWS as v (v)}
          <button type="button" role="radio" id="{id}-v-{v}" class="vw" class:on={view === v} aria-checked={view === v} tabindex={view === v ? 0 : -1} on:click={() => (view = v)} on:keydown={viewKeys}>{$t(viewKey(v))}</button>
        {/each}
      </div>
      <Button icon="plus" on:click={(e) => open({ kind: 'create' }, here(e))}>{$t('adminLive.grp.create')}</Button>
    </div>

    <p class="kids" aria-live="polite">{kids}</p>

    {#if pending > 0 && view === 'list'}
      <p class="notice panel" role="status">
        <Icon name="clock" size={16} /><span class="nt">{$t('adminLive.src.pending', { n: pending })}</span>
        <Button size="sm" variant="secondary" on:click={() => setOnlyPending(!onlyPending)}>{$t(onlyPending ? 'adminLive.grp.showAll' : 'adminLive.grp.onlyPending')}</Button>
      </p>
    {/if}

    {#if view === 'list'}
      <div class="bulk" role="group" aria-label={$t('adminLive.grp.bulk')}>
        <span class="count" aria-live="polite">{$t('adminLive.grp.selected', { n: selected.size })}</span>
        <Button size="sm" variant="secondary" disabled={pickedPending.length === 0} on:click={(e) => open({ kind: 'release', groups: pickedPending }, here(e))}>{$t('adminLive.grp.release')}</Button>
        <Button size="sm" variant="secondary" disabled={pickedGroups.length < 2} on:click={(e) => open({ kind: 'merge', groups: pickedGroups }, here(e))}>{$t('adminLive.grp.merge')}</Button>
      </div>
      {#if shown.length}
        <ul class="list panel" bind:this={list}>
          {#each shown as g (g.id)}
            <li class="row" class:pend={!g.released} data-gid={g.id}>
              <label class="sel"><input type="checkbox" checked={selected.has(g.id)} aria-label={$t('adminLive.grp.select', { name: g.name })} on:change={() => toggleSel(g.id)} /></label>
              <div class="main">
                <div class="l1">
                  <span class="name">{g.name}</span>
                  {#if !g.released}<StatusPill tone="warn" icon="eye-off" label={$t('adminLive.grp.unreleased')} />{/if}
                </div>
                <div class="l2">{$t('adminLive.grp.channels', { n: g.channels })}{#if g.providerGroups.length}<span class="dot" aria-hidden="true"> · </span><span>{$t('adminLive.grp.from', { list: g.providerGroups.join(', ') })}</span>{/if}</div>
                {#if !g.released}<div class="l3">{$t('adminLive.grp.unreleasedLine')}</div>{/if}
              </div>
              <div class="ctl">
                {#if g.released}
                  {#key rev}<Toggle hideLabel label={$t('adminLive.grp.kidFor', { name: g.name })} checked={g.kidFriendly} pending={busy.has(`grp:${g.id}`)} on:change={(e) => setKid(g, e.detail)} />{/key}
                  <span class="kidl" aria-hidden="true">{$t('adminLive.grp.kidFriendly')}</span>
                  <div class="chips" role="group" aria-label={$t('adminLive.grp.rolesFor', { name: g.name })}>
                    {#each roles as r (r.key)}
                      {@const on = g.roles.includes(r.key)}
                      <button type="button" class="rc" class:on class:ro={r.readOnly} aria-pressed={on} aria-disabled={r.readOnly ? 'true' : undefined} title={r.readOnly ? $t('adminLive.grp.envRole') : undefined}
                        disabled={busy.has(`grp:${g.id}:${r.key}`)} on:click={() => { if (!r.readOnly) void setRole(g, r.key, !on); }}>{r.name}</button>
                    {/each}
                  </div>
                {:else}
                  <Button size="sm" variant="secondary" on:click={(e) => open({ kind: 'release', groups: [g] }, here(e))}>{$t('adminLive.grp.release')}</Button>
                {/if}
              </div>
              <span class="acts"><ActionMenu label={$t('ui.table.actionsFor', { name: g.name })} title={g.name} busy={busy.has(`grp:${g.id}`)} items={items(g, $locale)} /></span>
            </li>
          {/each}
        </ul>
      {:else}
        <AdminCard><p class="empty">{$t('adminLive.grp.empty')}</p></AdminCard>
      {/if}
    {:else if view === 'roles'}
      <GroupMatrix groups={pendingFirst(groups, false)} {roles} busy={new Set([...busy].filter((k) => k.startsWith('grp:')).map((k) => k.slice(4)))} on:toggle={(e) => setRole(e.detail.group, e.detail.role, e.detail.on)} />
      <section class="people" aria-labelledby="{id}-p">
        <h3 id="{id}-p">{$t('adminLive.grp.people')}</h3>
        {#if peopleFailed}
          <div class="state"><p>{$t('adminLive.grp.peopleFailed')}</p><Button size="sm" variant="secondary" icon="refresh" on:click={() => void loadPeople()}>{$t('ui.retry')}</Button></div>
        {:else if people === null}
          <div class="sk" aria-busy="true"><Skeleton h="2.6rem" /><Skeleton h="2.6rem" /></div>
        {:else if people.length}
          <ul class="plist panel">
            {#each people as p (p.userId)}
              <li>
                <a class="who" href="/admin/users/{p.userId}?tab=rights">{p.name}</a>
                <span class="ex">
                  {#if p.plus.length}<span class="exc plus" aria-label={$t('adminLive.grp.plusLabel', { list: p.plus.join(', ') })}><span aria-hidden="true">+ {p.plus.join(', ')}</span></span>{/if}
                  {#if p.minus.length}<span class="exc minus" aria-label={$t('adminLive.grp.minusLabel', { list: p.minus.join(', ') })}><span aria-hidden="true">− {p.minus.join(', ')}</span></span>{/if}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">{$t('adminLive.grp.peopleNone')}</p>
        {/if}
      </section>
    {:else}
      <p class="hint">{$t('adminLive.grp.orderHint')}</p>
      <OrderView rows={orderRows} save={async (ids) => { await orderGroups(ids); await load(); }} />
    {/if}
  </div>
{/if}

{#if dialog?.kind === 'create'}
  <GroupNameDialog title={$t('adminLive.grp.createTitle')} confirmLabel={$t('adminLive.grp.createDo')} busy={busy.has('grp:new')} error={dialogError} {trigger} on:submit={(e) => doCreate(e.detail)} on:cancel={close} />
{:else if dialog?.kind === 'rename'}
  {@const g = dialog.group}
  <GroupNameDialog title={$t('adminLive.grp.renameTitle', { name: g.name })} confirmLabel={$t('adminLive.grp.rename')} initial={g.name} busy={busy.has(`grp:${g.id}`)} error={dialogError} {trigger} on:submit={(e) => doRename(g, e.detail)} on:cancel={close} />
{:else if dialog?.kind === 'release'}
  {@const gs = dialog.groups}
  <ReleaseSheet groups={gs} {roles} pending={busy.has('grp:release')} {trigger} on:confirm={(e) => doRelease(gs, e.detail)} on:cancel={close} />
{:else if dialog?.kind === 'merge'}
  {@const gs = dialog.groups}
  <MergeDialog groups={gs} pending={busy.has('grp:merge')} error={dialogError} {trigger} on:confirm={(e) => doMerge(gs, e.detail)} on:cancel={close} />
{/if}

<style>
  .tab { min-width: 0; display: flex; flex-direction: column; gap: .8rem; }
  .state { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; min-height: 3rem; }
  .state p { margin: 0; flex: 1 1 14rem; }
  .sk { display: grid; gap: .8rem; min-height: 6rem; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: .8rem; flex-wrap: wrap; }
  /* the three views: a segmented control, the selection is the filled segment (no motion) */
  .views { display: inline-flex; padding: 3px; border-radius: 12px; background: rgba(var(--fr-scrim-rgb), .25); box-shadow: inset 0 0 0 1px var(--fr-line, var(--line)); }
  .vw { min-height: 44px; min-width: 44px; padding: 0 1rem; border-radius: 9px; background: transparent; color: var(--mut); font-weight: 600; }
  .vw.on { background: var(--acc); color: #1a1a1a; }
  .vw:focus-visible { outline: 2px solid #fff; outline-offset: 1px; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  .kids { margin: 0; min-height: 1.5em; color: var(--mut); overflow-wrap: anywhere; }
  .notice { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin: 0; padding: .6rem .9rem; }
  .nt { flex: 1 1 12rem; font-weight: 600; }
  /* the bar is always there; its buttons are disabled while nothing is selected, so nothing moves when they enable */
  .bulk { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; min-height: 44px; }
  .count { margin-right: auto; color: var(--mut); font-variant-numeric: tabular-nums; }
  .list, .plist { list-style: none; margin: 0; padding: 4px 0; }
  .row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: .3rem .8rem; padding: .5rem .9rem .5rem .3rem; border-top: 1px solid rgba(255, 255, 255, .08); min-width: 0; }
  .row:first-child { border-top: 0; }
  .sel { display: grid; place-items: center; width: 44px; height: 44px; cursor: pointer; }
  .sel input { width: 20px; height: 20px; margin: 0; cursor: pointer; }
  .main { min-width: 0; }
  .l1 { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .name { font-weight: 700; overflow-wrap: anywhere; }
  .l2, .l3 { font-size: .85rem; color: var(--mut); overflow-wrap: anywhere; }
  .l3 { font-weight: 600; }
  .ctl { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
  .kidl { font-size: .85rem; color: var(--mut); margin-left: -.3rem; }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; }
  .rc { min-height: 44px; min-width: 44px; padding: 0 .9rem; border-radius: 99px; font-weight: 600; font-size: .88rem; background: rgba(var(--fr-scrim-rgb), .25); color: var(--mut);
    box-shadow: inset 0 0 0 1px var(--fr-line, var(--line)); }
  .rc.on { background: var(--acc); color: #1a1a1a; box-shadow: none; }
  .rc.ro { opacity: .6; cursor: default; }
  .rc:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  .rc:disabled { opacity: .6; cursor: progress; }
  .empty { margin: 0; color: var(--mut); }
  .hint { margin: 0; color: var(--mut); }
  .people h3 { margin: .4rem 0 .5rem; font-size: 1rem; font-weight: 700; }
  .plist li { display: flex; align-items: center; justify-content: space-between; gap: .6rem 1rem; flex-wrap: wrap; min-height: 52px; padding: .3rem .9rem; border-top: 1px solid rgba(255, 255, 255, .08); }
  .plist li:first-child { border-top: 0; }
  .who { display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; overflow-wrap: anywhere; }
  .ex { display: flex; flex-wrap: wrap; gap: .4rem; }
  .exc { display: inline-flex; align-items: center; min-height: 32px; padding: 0 .7rem; border-radius: 99px; font-size: .85rem; font-weight: 600; background: rgba(var(--fr-scrim-rgb), .25); overflow-wrap: anywhere; }
  .exc.plus { color: var(--ok); }
  .exc.minus { color: var(--warn); }
  @media (max-width: 720px) {
    .row { grid-template-columns: auto minmax(0, 1fr) auto; }
    .ctl { grid-column: 2 / -1; justify-content: flex-start; }
    .acts { grid-column: 3; grid-row: 1; }
  }
</style>
