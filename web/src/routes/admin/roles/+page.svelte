<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: Rollen & Rechte (roles redesign §5.1, §5.5). *Rollen* (the default view, every width): the role list, each row a link
   * to the role's page, with its areas, its people and the ⋯ menu. *Vergleichen* (`?view=compare`, switched by the segmented
   * control without a reload): from 900 px the role matrix, below it the one-right view; both read-only, every value a link to
   * the role page at that right (the role page is the one editor, §1.1). Nothing is staged here, so there is no save bar and no
   * leave guard. The menus run here: *+ Neue Rolle* and *Duplizieren* (the new-role dialog: a name and a template or a copy, then
   * the new role's page opens), *Löschen* (confirm, or the dialog that moves the people first, from the server's 409 role_in_use),
   * the order (PUT /order, applied at once and reloaded).
   */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { SCRIM_BAR } from '#lib/glass/tone';
  import SlidePill from '#lib/glass/SlidePill.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { toast } from '#lib/ui/toast';
  import { pageStore } from '#lib/page';
  import CompareView from '#lib/admin/rights/CompareView.svelte';
  import DeleteRoleDialog from '#lib/admin/rights/DeleteRoleDialog.svelte';
  import { roleName as roleLabel, type MatrixRole, type RoleMatrix } from '#lib/admin/rights/model';
  import { deleteMoving, deleteRole, moveTargetsOf } from '#lib/admin/rights/roleDelete';
  import { createError, createRole, templateGone, type CreateBody } from '#lib/admin/rights/newRole';
  import NewRoleDialog from '#lib/admin/rights/NewRoleDialog.svelte';
  import RoleList from '#lib/admin/rights/RoleList.svelte';
  import RoleMatrixView from '#lib/admin/rights/RoleMatrix.svelte';

  let matrix: RoleMatrix | null = null, error: string | null = null;

  /** the matrix from 900 px on (the admin sidebar's breakpoint); below it the cards */
  const WIDE = '(min-width: 900px)';
  let wide = typeof matchMedia === 'undefined' || matchMedia(WIDE).matches;
  onMount(() => {
    const mq = matchMedia(WIDE);
    const sync = () => {
      if (wide === mq.matches) return;
      // the matrix and the one-right view swap: the focus follows to the same role's head link instead of falling to <body>
      const key = document.activeElement?.closest('[data-role]')?.getAttribute('data-role');
      wide = mq.matches;
      if (key && mode === 'compare' && wide) void tick().then(() => grid?.focusHead(key));
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  async function load() {
    error = null;
    try {
      const r = await api<{ matrix?: RoleMatrix }>('/api/admin/roles');
      if (!r.matrix) throw new Error('no matrix');
      matrix = r.matrix;
    } catch { error = tr('adminPeople.loadFailed'); }
  }
  onMount(load);
  /** the matrix again after a role was created, deleted or moved */
  async function refresh() {
    const r = await api<{ matrix?: RoleMatrix }>('/api/admin/roles');
    if (r.matrix) matrix = r.matrix;
  }

  // ---- the two views: the list, and *Vergleichen* (?view=compare); the control replaces the entry (Back leaves the page)
  type View = 'roles' | 'compare';
  const VIEWS: View[] = ['roles', 'compare'];
  const page$ = pageStore();
  $: mode = ($page$.url.searchParams.get('view') === 'compare' ? 'compare' : 'roles') as View;
  let tabsEl: HTMLDivElement | undefined;
  function show(v: View) {
    if (v === mode) return;
    const url = new URL($page$.url.href);
    if (v === 'compare') url.searchParams.set('view', 'compare'); else url.searchParams.delete('view');
    void goto(url, { replace: true, reset: false });
  }
  function tabKey(e: KeyboardEvent) {
    const i = VIEWS.indexOf(mode), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key !== 'Home' && e.key !== 'End' && !d) return;
    e.preventDefault();
    const next = e.key === 'Home' ? VIEWS[0]! : e.key === 'End' ? VIEWS[VIEWS.length - 1]! : VIEWS[(i + d + VIEWS.length) % VIEWS.length]!;
    show(next);
    void tick().then(() => document.getElementById(`rv-${next}`)?.focus());
  }

  let list: RoleList | undefined, grid: RoleMatrixView | undefined;
  /** the focus to a moved role's menu button in the list */
  const focusRole = (key: string, what: 'name' | 'menu' = 'name') => list?.focusHead(key, what);

  // ---- role menu: *+ Neue Rolle* and *Duplizieren* (the new-role dialog), delete (with a move), order
  let status = '';
  interface Ask { role: MatrixRole; trigger: HTMLElement | null }
  /** the new-role dialog: *+ Neue Rolle* (Freund picked) or *Duplizieren* (the copy of its role picked, `from`) */
  let fresh: { trigger: HTMLElement | null; from: string } | null = null, freshBusy = false, freshErr = '';
  function startNew(e: MouseEvent) { openNew(e.currentTarget instanceof HTMLElement ? e.currentTarget : null, ''); }
  function openNew(trigger: HTMLElement | null, from: string) { fresh = { trigger, from }; freshErr = ''; freshBusy = false; }
  let del: (Ask & { accounts: number; invites: number }) | null = null, delBusy = false, delErr = '';

  /** the matrix again after a write that went through: a failed read must not look like a failed write (the stale matrix stays, the person is told) */
  async function reload(): Promise<boolean> {
    try { await refresh(); return true; } catch { toast.error(tr('adminPeople.loadFailed')); return false; }
  }
  /** POST the new role (a template or a copy); the dialog closes and the new role's page opens (§5.2) */
  async function create(body: CreateBody) {
    if (freshBusy) return;
    freshBusy = true; freshErr = '';
    let key: string;
    try { key = await createRole(body); } catch (e) {
      freshErr = createError(e); freshBusy = false;
      // a template the server no longer offers: the start points are read again (the option goes, the dialog falls back)
      if (templateGone(e)) await reload();
      return;
    }
    fresh = null; freshBusy = false;
    toast.success(tr('adminPeople.roles.duplicated', { name: body.label }));
    await goto(`/admin/roles/${encodeURIComponent(key)}`);
  }

  /** the delete of a role (roleDelete.ts): nobody holds it → a confirm; people do → the server's 409 role_in_use opens the dialog with its counts */
  async function removeRole(a: Ask) {
    const name = roleLabel(a.role);
    const r = await deleteRole(a.role, a.trigger);
    if (r === 'deleted') await deleted(name);
    else if (r !== 'kept') { del = { ...a, ...r }; delErr = ''; delBusy = false; }
  }
  /** the role is gone: say so first, then read the matrix again */
  async function deleted(name: string) {
    del = null;
    toast.success(tr('adminPeople.roles.deleted', { name }));
    await reload();
  }
  async function removeMoved(to: string) {
    if (!del || delBusy) return;
    delBusy = true; delErr = '';
    const name = roleLabel(del.role);
    const r = await deleteMoving(del.role.key, to);
    delBusy = false;
    if (r.ok) { await deleted(name); return; }
    if (r.counts && del) del = { ...del, ...r.counts };
    delErr = r.error;
  }
  $: moveTargets = moveTargetsOf(matrix?.roles ?? [], del?.role.key);

  /** a column to a new place: shown at once, written with PUT /order (every key, the server ignores env-only ones), then read back */
  async function moveRole({ key, to }: { key: string; to: number }) {
    if (!matrix) return;
    const from = matrix.roles.findIndex((r) => r.key === key);
    // only roles with a table row can be ordered, and they stay in front of the env-only ones
    const storedCount = matrix.roles.filter((r) => r.stored).length;
    if (from < 0 || from === to || to < 0 || to >= storedCount || !matrix.roles[from]!.stored) return;
    const hadFocus = document.querySelector(`[data-role="${CSS.escape(key)}"]`)?.contains(document.activeElement) ?? false;
    const next = [...matrix.roles];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m!);
    matrix = { ...matrix, roles: next.map((r, position) => ({ ...r, position })) };
    status = tr('adminPeople.roles.movedTo', { name: roleLabel(m!), n: to + 1, total: next.length });
    if (hadFocus) void focusRole(key, 'menu');
    // the writes go one after the other (each carries the whole order as it was shown), and the matrix is read back only after the
    // last one: the optimistic order stays on screen meanwhile, so two quick moves never flicker back and forth
    movesOpen++;
    orderQueue = orderQueue.then(async () => {
      try { await api('/api/admin/roles/order', { method: 'PUT', body: { keys: next.map((r) => r.key) } }); } catch { toast.error(tr('adminPeople.roles.orderFailed')); }
      if (--movesOpen > 0) return;
      await refresh().catch(() => undefined); // read back (after a failure: back to what the server has; the optimistic order stays if the read fails)
    });
    await orderQueue;
  }
  let orderQueue: Promise<void> = Promise.resolve(), movesOpen = 0;

</script>

<div class="roles" class:cmp={mode === 'compare'}>
<div class="top">
  <p class="intro">{$t('adminPeople.roles.intro')}</p>
  <div class="tools">
    <div class="seg frost frost-pill frost-safe" style="--fr-scrim-safe:{SCRIM_BAR}" role="tablist" aria-label={$t('adminPeople.roles.viewLabel')} tabindex="-1" on:keydown={tabKey} bind:this={tabsEl}>
      {#each VIEWS as v (v)}
        <button type="button" role="tab" id="rv-{v}" class="tab" class:on={mode === v} aria-selected={mode === v} aria-controls="rv-panel" tabindex={mode === v ? 0 : -1} on:click={() => show(v)}>{$t(v === 'roles' ? 'adminPeople.roles.viewRoles' : 'adminPeople.roles.compare.tab')}</button>
      {/each}
      {#if tabsEl}<SlidePill host={tabsEl} selector={'[role="tab"][aria-selected="true"]'} tone="white" />{/if}
    </div>
    <Button icon="plus" disabled={!matrix} on:click={startNew}>{$t('adminPeople.roles.new.title')}</Button>
  </div>
</div>

<div id="rv-panel" role="tabpanel" aria-labelledby="rv-{mode}">
{#if error}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{error}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
{:else if matrix === null && mode === 'compare' && wide}
  <div class="panel loading" aria-busy="true"><Skeleton w="30%" h="1.2rem" /><Skeleton lines={8} /></div>
{:else if matrix === null}
  <!-- the rows' final size: nothing moves when they arrive -->
  <div class="grid" aria-busy="true">
    {#each [0, 1, 2, 3] as i (i)}
      <div class="sk panel" aria-hidden="true"><Skeleton w="35%" h="1.1rem" /><Skeleton w="60%" h=".9rem" /></div>
    {/each}
  </div>
{:else if !matrix.roles.length}
  <div class="state"><p>{$t('adminPeople.roles.empty')}</p></div>
{:else if mode === 'roles'}
  <RoleList bind:this={list} {matrix} {status} on:duplicate={(e) => openNew(e.detail.trigger, e.detail.role.key)} on:remove={(e) => void removeRole(e.detail)} on:move={(e) => void moveRole(e.detail)} />
{:else if wide}
  <RoleMatrixView bind:this={grid} {matrix} />
{:else}
  <CompareView {matrix} />
{/if}
</div>
</div>

{#if fresh && matrix}
  <NewRoleDialog {matrix} from={fresh.from} busy={freshBusy} error={freshErr} trigger={fresh.trigger} on:submit={(e) => void create(e.detail)} on:cancel={() => (fresh = null)} />
{/if}
{#if del}
  <DeleteRoleDialog name={roleLabel(del.role)} targets={moveTargets} accounts={del.accounts} invites={del.invites} busy={delBusy} error={delErr} trigger={del.trigger}
    on:confirm={(e) => void removeMoved(e.detail)} on:cancel={() => (del = null)} />
{/if}

<style>
  /* the list is one column of at most 760 px, on the page heading's edge (a centred column stood off the heading above it); the
     head keeps that column in the compare view too (it never moves), the matrix below takes the whole width */
  .top, .roles:not(.cmp) #rv-panel { max-width: 760px; }
  .loading { display: flex; flex-direction: column; gap: 1rem; }
  .intro { color: var(--mut); margin: 0 0 1rem; max-width: 60ch; }
  .tools { display: flex; align-items: center; justify-content: space-between; gap: .8rem; margin: 0 0 1rem; flex-wrap: wrap; }
  .grid { display: flex; flex-direction: column; gap: .6rem; }
  .sk { margin: 0; min-height: 64px; box-sizing: border-box; padding: .9rem 1.1rem; display: flex; flex-direction: column; justify-content: center; gap: .45rem; }
  /* the segmented control: a glass pill bar, the white pill (SlidePill) glides to the selected view */
  .seg { display: flex; flex: 0 1 340px; min-width: 0; box-sizing: border-box; gap: 4px; padding: 6px; }
  .tab { position: relative; z-index: 1; flex: 1 1 0; min-height: 44px; padding: 0 1rem; background: transparent; color: rgba(255, 255, 255, .9); border: 0; border-radius: 999px; font-weight: 700; white-space: nowrap; }
  .tab:hover:not(:disabled) { background: transparent; color: #fff; }
  .tab.on, .tab.on:hover:not(:disabled) { color: #111; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--mut); }
  .state p { margin: 0; }
  .state[role='alert'] { color: var(--fg); }
  .state[role='alert'] :global(svg) { color: var(--err); }
  /* phones: the control over the whole width, the button under it */
  @media (max-width: 600px) { .seg { flex-basis: 100%; } .tools > :global(.ui-btn) { width: 100%; } }
</style>
