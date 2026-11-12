<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: Rollen & Rechte (spec §6.1). Desktop (≥ 900 px): the role matrix; edits are staged into the save bar, *Änderungen
   * prüfen* lists them, *Speichern* writes one role after the other (PUT /api/admin/roles/:role) with the progress in the bar;
   * a partial policy failure (502 policy_partial: the values are stored) offers *Erneut anwenden* with the role's last body.
   * The column menus run here: *Duplizieren* (POST, asks for the name), *Löschen* (confirm, or the dialog that moves the people
   * first, from the server's 409 role_in_use), *Nach links/rechts* and the drag handle (PUT /order, applied at once and reloaded).
   * Below 900 px: a card per role (tap: the role sheet, the same menu) and *Vergleich* (one right, every role), switched by a
   * segmented control; the same staging, save bar and review. An unsaved-changes guard asks before leaving, at any width.
   */
  import { onMount, tick } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { errorText } from '#lib/ui/action';
  import { SCRIM_BAR } from '#lib/glass/tone';
  import SlidePill from '#lib/glass/SlidePill.svelte';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import { toast } from '#lib/ui/toast';
  import CompareView from '#lib/admin/rights/CompareView.svelte';
  import DeleteRoleDialog from '#lib/admin/rights/DeleteRoleDialog.svelte';
  import { partialText, policyLine, reviewLines, roleName as roleLabel, saveBarText, stageBodies, stageCounts, stageSet, type MatrixRole, type RoleMatrix, type Stage } from '#lib/admin/rights/model';
  import NameDialog from '#lib/admin/rights/NameDialog.svelte';
  import ReviewSheet from '#lib/admin/rights/ReviewSheet.svelte';
  import RoleCards from '#lib/admin/rights/RoleCards.svelte';
  import RoleMatrixView from '#lib/admin/rights/RoleMatrix.svelte';
  import SaveBar from '#lib/admin/rights/SaveBar.svelte';

  let matrix: RoleMatrix | null = null, error: string | null = null;

  /** the matrix from 900 px on (the admin sidebar's breakpoint); below it the cards */
  const WIDE = '(min-width: 900px)';
  let wide = typeof matchMedia === 'undefined' || matchMedia(WIDE).matches;
  onMount(() => {
    const mq = matchMedia(WIDE);
    const sync = () => {
      if (wide === mq.matches) return;
      // the matrix and the cards swap: the focus follows to the same role instead of falling to <body>
      const key = document.activeElement?.closest('[data-role]')?.getAttribute('data-role');
      wide = mq.matches;
      if (key) void tick().then(() => view?.focusHead(key, 'menu'));
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
      stage = {};
    } catch { error = tr('adminPeople.loadFailed'); }
  }
  onMount(load);
  /** the matrix again after a role was created, deleted or moved: staged edits stay (those of a role that is gone drop) */
  async function refresh() {
    const r = await api<{ matrix?: RoleMatrix }>('/api/admin/roles');
    if (!r.matrix) return;
    const keys = new Set(r.matrix.roles.map((x) => x.key));
    matrix = r.matrix;
    stage = Object.fromEntries(Object.entries(stage).filter(([k]) => keys.has(k)));
    // a failed write of a role that is gone can never be applied again: it leaves the retry, and the bar's error with it
    if (failures.some((j) => !keys.has(j.role)) || pending.some((j) => !keys.has(j.role))) {
      failures = failures.filter((j) => keys.has(j.role));
      pending = pending.filter((j) => keys.has(j.role));
      if (!saving) barError = failures.length ? partialText([...new Map(failures.map((f) => [f.role, f.failed])).values()].reduce((a, n) => a + n, 0)) : pending.length ? barError : null;
    }
  }

  // ---- the phone's two views
  type View = 'roles' | 'compare';
  const VIEWS: View[] = ['roles', 'compare'];
  let mode: View = 'roles', tabsEl: HTMLDivElement | undefined;
  function tabKey(e: KeyboardEvent) {
    const i = VIEWS.indexOf(mode), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key !== 'Home' && e.key !== 'End' && !d) return;
    e.preventDefault();
    mode = e.key === 'Home' ? VIEWS[0]! : e.key === 'End' ? VIEWS[VIEWS.length - 1]! : VIEWS[(i + d + VIEWS.length) % VIEWS.length]!;
    void tick().then(() => document.getElementById(`rv-${mode}`)?.focus());
  }

  // ---- the matrix: staged changes, the save bar, the review sheet, the sequential save
  let stage: Stage = {};
  $: counts = matrix ? stageCounts(stage, matrix) : null;
  /** staged roles, at any width (the guard and the save bar count the same edits) */
  $: dirtyCount = counts?.roles ?? 0;
  type Body = Record<string, unknown>;
  /** one role write: its body and, for staged values, what was staged when it was built (null: re-sending a stored body) */
  interface Job { role: string; body: Body; fields: Record<string, unknown> | null }
  /** roles whose values are stored but whose accounts did not all take the policy (502 policy_partial): the body to re-send */
  let failures: Array<Job & { failed: number }> = [];
  /** staged writes a hard error left unsent (that run's bodies; *Erneut anwenden* sends them, never newer edits) */
  let pending: Job[] = [];
  let saving = false, progress: string | null = null, barError: string | null = null;
  let reviewing = false, reviewBtn: HTMLElement | null = null;
  let bar: SaveBar | undefined;
  let view: RoleMatrixView | RoleCards | undefined;

  /** a written role: the values it carried become the loaded ones (set in the role itself now); staged entries equal to them go */
  function stored(j: Job) {
    const r = matrix?.roles.find((x) => x.key === j.role);
    if (!r || !matrix || !j.fields) return;
    for (const [k, v] of Object.entries(j.fields)) {
      if (k === 'label') { r.label = String(v); r.builtinLabel = false; } else if (k === 'invitable') r.invitable = Boolean(v);
      else { r.values[k] = v; r.sources[k] = 'role'; }
    }
    for (const [k, v] of Object.entries(stage[j.role] ?? {})) stage = stageSet(stage, matrix, j.role, k, v);
    matrix = matrix;
  }
  /** the staged roles as writes, in matrix order */
  function stagedJobs(): Job[] {
    const bodies = stageBodies(stage);
    return (matrix?.roles ?? []).filter((r) => bodies[r.key]).map((r) => ({ role: r.key, body: bodies[r.key]!, fields: { ...stage[r.key] } }));
  }
  /** one PUT after the other, the progress in the bar; 502 policy_partial stores the values and keeps the body for a retry */
  async function run(jobs: Job[]) {
    if (!matrix || saving || !jobs.length) return;
    saving = true; barError = null;
    const failed: typeof failures = [];
    let hard: string | null = null, i = 0;
    for (; i < jobs.length; i++) {
      const j = jobs[i]!;
      progress = tr('adminPeople.roles.applying', { i: i + 1, n: jobs.length });
      try {
        await api(`/api/admin/roles/${encodeURIComponent(j.role)}`, { method: 'PUT', body: j.body });
        stored(j);
      } catch (e) {
        if (e instanceof ApiError && e.status === 502 && e.body?.error === 'policy_partial') {
          stored(j); // stored either way
          failed.push({ role: j.role, body: j.body, fields: null, failed: Number(e.body?.failed) || 0 });
        } else { hard = errorText(e); break; }
      }
    }
    // a hard error stops the run: what it did not send stays to be sent again (staged values also stay staged)
    const rest = jobs.slice(i);
    failures = [...failed, ...rest.filter((j) => !j.fields).map((j) => failures.find((f) => f.role === j.role && f.body === j.body)!).filter(Boolean)];
    pending = rest.filter((j) => j.fields);
    saving = false; progress = null;
    // a role written twice (failed before, staged again) counts with its latest answer
    const accounts = [...new Map(failures.map((f) => [f.role, f.failed])).values()].reduce((a, n) => a + n, 0);
    barError = hard ?? (failures.length ? partialText(accounts) : null);
    // all written: "Änderungen gespeichert." only when nothing is left staged (a retry leaves newer edits staged)
    if (!barError) {
      const roles = new Set(jobs.map((j) => j.role)).size;
      toast.success(Object.keys(stage).length ? tr('adminPeople.roles.retryDone', { n: roles }) : tr('adminPeople.roles.savedAll'));
    }
  }
  /** *Speichern* in the review sheet: the failed roles again, then everything staged */
  const apply = () => run([...failures, ...stagedJobs()]);
  /** *Erneut anwenden*: only what failed (each role's last body) and what a hard error left unsent, never newer edits */
  const retry = () => run([...failures, ...pending]);
  function discardAll() { stage = {}; failures = []; pending = []; barError = null; }
  function openReview() {
    reviewBtn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reviewing = true;
  }
  async function saveReviewed() {
    reviewing = false;
    await tick();
    bar?.focus();
    await apply();
  }

  // ---- role menu: duplicate, delete (with a move), order
  let status = '';
  interface Ask { role: MatrixRole; trigger: HTMLElement | null }
  let dup: Ask | null = null, dupBusy = false, dupErr = '';
  let del: (Ask & { accounts: number; invites: number }) | null = null, delBusy = false, delErr = '';
  const inUse = (e: unknown) => (e instanceof ApiError && e.status === 409 && e.body?.error === 'role_in_use' ? { accounts: Number(e.body.accounts) || 0, invites: Number(e.body.invites) || 0 } : null);

  /** the matrix again after a write that went through: a failed read must not look like a failed write (the stale matrix stays, the person is told) */
  async function reload(): Promise<boolean> {
    try { await refresh(); return true; } catch { toast.error(tr('adminPeople.loadFailed')); return false; }
  }
  function startDuplicate(a: Ask) { dup = a; dupErr = ''; dupBusy = false; }
  async function duplicate(label: string) {
    if (!dup || dupBusy) return;
    dupBusy = true; dupErr = '';
    let key: string;
    try { key = (await api<{ key: string }>('/api/admin/roles', { method: 'POST', body: { label, from: dup.role.key } })).key; } catch (e) { dupErr = errorText(e); dupBusy = false; return; }
    dup = null; dupBusy = false;
    toast.success(tr('adminPeople.roles.duplicated', { name: label }));
    if (await reload()) await view?.focusHead(key);
  }

  /** the delete of a role: nobody holds it → a confirm; people do → the server's 409 role_in_use opens the dialog with its counts */
  async function removeRole(a: Ask) {
    const name = roleLabel(a.role);
    if (a.role.accounts === 0 && !(await confirm({ title: tr('adminPeople.roles.deleteTitle', { name }), body: tr('adminPeople.roles.deleteNone'), danger: true, confirmLabel: tr('adminPeople.roles.delete') }))) { void tick().then(() => a.trigger?.focus({ preventScroll: true })); return; }
    try {
      await api(`/api/admin/roles/${encodeURIComponent(a.role.key)}`, { method: 'DELETE' });
    } catch (e) {
      const n = inUse(e);
      if (n) { del = { ...a, ...n }; delErr = ''; delBusy = false; } else toast.error(errorText(e));
      return;
    }
    await deleted(name);
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
    try {
      await api(`/api/admin/roles/${encodeURIComponent(del.role.key)}`, { method: 'DELETE', body: { moveTo: to } });
    } catch (e) {
      const n = inUse(e);
      if (n && del) del = { ...del, ...n };
      delErr = errorText(e);
      delBusy = false;
      return;
    }
    delBusy = false;
    await deleted(name);
  }
  $: moveTargets = (matrix?.roles ?? []).filter((r) => r.key !== del?.role.key && r.base !== 'admin').map((r) => ({ key: r.key, name: roleLabel(r) }));

  /** a column to a new place: shown at once, written with PUT /order (every key, the server ignores env-only ones), then read back */
  async function moveRole({ key, to }: { key: string; to: number }) {
    if (!matrix || saving) return;
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
    if (hadFocus) void view?.focusHead(key, 'menu');
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

  let leaving = false;
  beforeNavigate((nav) => {
    if (leaving || !dirtyCount) return;
    nav.cancel(); // unload: the browser asks itself
    if (nav.willUnload || !nav.to) return;
    const to = nav.to.url;
    void confirm({ title: tr('adminPeople.roles.leaveTitle'), body: tr('adminPeople.roles.leaveBody', { n: dirtyCount }), danger: true, confirmLabel: tr('adminPeople.roles.leaveConfirm') })
      .then((ok) => { if (ok) { leaving = true; void goto(to); } });
  });

</script>

<div class="roles">
<p class="intro">{$t('adminPeople.roles.intro')}</p>

{#if error}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{error}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
{:else if matrix === null && wide}
  <div class="panel loading" aria-busy="true"><Skeleton w="30%" h="1.2rem" /><Skeleton lines={8} /></div>
{:else if matrix === null}
  <div class="grid" aria-busy="true">
    {#each [0, 1, 2] as i (i)}
      <div class="card panel" aria-hidden="true"><Skeleton w="40%" h="1.2rem" /><Skeleton lines={3} /></div>
    {/each}
  </div>
{:else if !matrix.roles.length}
  <div class="state"><p>{$t('adminPeople.roles.empty')}</p></div>
{:else if wide}
  <RoleMatrixView bind:this={view} {matrix} bind:stage disabled={saving} {status} on:duplicate={(e) => startDuplicate(e.detail)} on:remove={(e) => void removeRole(e.detail)} on:move={(e) => void moveRole(e.detail)} />
{:else}
  <div class="seg frost frost-pill frost-safe" style="--fr-scrim-safe:{SCRIM_BAR}" role="tablist" aria-label={$t('adminPeople.roles.viewLabel')} tabindex="-1" on:keydown={tabKey} bind:this={tabsEl}>
    {#each VIEWS as v (v)}
      <button type="button" role="tab" id="rv-{v}" class="tab" class:on={mode === v} aria-selected={mode === v} aria-controls="rv-panel" tabindex={mode === v ? 0 : -1} on:click={() => (mode = v)}>{$t(v === 'roles' ? 'adminPeople.roles.viewRoles' : 'adminPeople.roles.compare')}</button>
    {/each}
    {#if tabsEl}<SlidePill host={tabsEl} selector={'[role="tab"][aria-selected="true"]'} tone="white" />{/if}
  </div>
  <div id="rv-panel" role="tabpanel" aria-labelledby="rv-{mode}">
    {#if mode === 'roles'}
      <RoleCards bind:this={view} {matrix} bind:stage disabled={saving} {status} on:duplicate={(e) => startDuplicate(e.detail)} on:remove={(e) => void removeRole(e.detail)} on:move={(e) => void moveRole(e.detail)} />
    {:else}
      <CompareView {matrix} bind:stage disabled={saving} />
    {/if}
  </div>
{/if}
</div>

{#if counts}
  <SaveBar bind:this={bar} count={counts.changes} text={saveBarText(counts)} busy={saving} {progress} error={barError}
    on:discard={discardAll} on:review={openReview} on:retry={retry} />
{/if}
{#if reviewing && matrix && counts}
  <ReviewSheet lines={reviewLines(stage, matrix)} policy={counts.policy ? policyLine(counts) : null} trigger={reviewBtn}
    on:close={() => (reviewing = false)} on:save={saveReviewed} />
{/if}
{#if dup}
  <NameDialog title={tr('adminPeople.roles.duplicateTitle', { name: roleLabel(dup.role) })} hint={$t('adminPeople.roles.duplicateHint')} label={$t('adminPeople.roles.fLabel')} confirmLabel={$t('adminPeople.roles.create')}
    busy={dupBusy} error={dupErr} trigger={dup.trigger} on:submit={(e) => void duplicate(e.detail)} on:cancel={() => (dup = null)} />
{/if}
{#if del}
  <DeleteRoleDialog name={roleLabel(del.role)} targets={moveTargets} accounts={del.accounts} invites={del.invites} busy={delBusy} error={delErr} trigger={del.trigger}
    on:confirm={(e) => void removeMoved(e.detail)} on:cancel={() => (del = null)} />
{/if}

<style>
  /* the save bar's room at the page's end (set before it rises in): nothing above it moves */
  .roles { padding-bottom: var(--savebar-h, 0px); }
  .loading { display: flex; flex-direction: column; gap: 1rem; }
  .intro { color: var(--mut); margin: 0 0 1rem; max-width: 60ch; }
  .grid { display: flex; flex-direction: column; gap: .8rem; }
  .card { margin-bottom: 0; display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  /* the phone's segmented control: a glass pill bar, the white pill (SlidePill) glides to the selected view */
  .seg { display: flex; width: 100%; box-sizing: border-box; gap: 4px; margin: 0 0 1rem; padding: 6px; }
  .tab { position: relative; z-index: 1; flex: 1 1 0; min-height: 44px; padding: 0 1rem; background: transparent; color: rgba(255, 255, 255, .9); border: 0; border-radius: 999px; font-weight: 700; white-space: nowrap; }
  .tab:hover:not(:disabled) { background: transparent; color: #fff; }
  .tab.on, .tab.on:hover:not(:disabled) { color: #111; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--mut); }
  .state p { margin: 0; }
  .state[role='alert'] { color: var(--fg); }
  .state[role='alert'] :global(svg) { color: var(--err); }
</style>
