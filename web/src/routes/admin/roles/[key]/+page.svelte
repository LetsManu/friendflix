<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: one role (roles redesign §5.3). Head: back to *Rollen*, the name as an inline field (staged; an env-only role's name is
   * locked: "Steht in der .env"), the people as a link to Personen, the ⋯ menu (*Duplizieren*: the copy's page opens, *Verlauf*,
   * *Löschen*: back to the list). Then *Bereiche* (AreaGrid: the area switches with the coupling of areas.ts) and a section per
   * area that is on, in the fixed order Mediathek, Live-TV (shown while Live TV is installed: its groups stay listed, dimmed, when
   * it is off), Wünsche, Gemeinsam, Downloads, then *Allgemein* (streams, casting, the invitable switch). Every edit is staged
   * (stageArea / stageField), counted in the save bar, listed by *Änderungen prüfen* and written with one PUT (save.ts); a partial
   * policy failure offers *Erneut anwenden*. Leaving with staged edits asks first. `?field=<key>` focuses that control.
   */
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { locale, t, tr } from '#lib/i18n';
  import { pageStore } from '#lib/page';
  import { leaveGuard, leavesRoute } from '#lib/admin/leaveGuard';
  import AreaGrid from '#lib/admin/rights/AreaGrid.svelte';
  import AreaSection from '#lib/admin/rights/AreaSection.svelte';
  import { AREA_ICON, AREA_KEYS, areaLabel, fieldsOfArea, stageArea, stagedAreas, stageField, type AreaKey, type Areas } from '#lib/admin/rights/areas';
  import DeleteRoleDialog from '#lib/admin/rights/DeleteRoleDialog.svelte';
  import GroupChips from '#lib/admin/rights/GroupChips.svelte';
  import { PERM_SET, peopleLine, policyLine, reviewLines, roleName, saveBarText, stageCounts, stageSet, type MatrixField, type MatrixRole, type RoleMatrix, type Stage } from '#lib/admin/rights/model';
  import NameDialog from '#lib/admin/rights/NameDialog.svelte';
  import ReviewSheet from '#lib/admin/rights/ReviewSheet.svelte';
  import RoleHistory from '#lib/admin/rights/RoleHistory.svelte';
  import { canDelete, copyRole, deleteMoving, deleteRole, moveTargetsOf } from '#lib/admin/rights/roleDelete';
  import { createSave, keepKnownGroups } from '#lib/admin/rights/save';
  import SaveBar from '#lib/admin/rights/SaveBar.svelte';
  import { reducedMotion } from '#lib/ui/motion';
  import ActionMenu from '#lib/ui/ActionMenu.svelte';
  import { errorText } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { toast } from '#lib/ui/toast';

  const page$ = pageStore();
  $: key = $page$.params.key ?? '';

  let matrix: RoleMatrix | null = null, error: string | null = null, loadedKey = '';
  let stage: Stage = {};
  $: role = matrix?.roles.find((r) => r.key === key) ?? null;

  async function load() {
    error = null;
    try {
      const r = await api<{ matrix?: RoleMatrix }>('/api/admin/roles');
      if (!r.matrix) throw new Error('no matrix');
      matrix = r.matrix;
      stage = {};
      void focusField();
    } catch { error = tr('adminPeople.loadFailed'); }
  }
  // the page stays mounted from one role to another (a copy's page opens): each key loads afresh
  $: if (key && key !== loadedKey) { loadedKey = key; matrix = null; stage = {}; typed = null; void load(); }

  // ---- staging: the area switches and the fields keep the coupling (areas.ts); the name and the groups are plain staged keys
  $: areas = role ? stagedAreas(stage, role) : null;
  $: counts = matrix ? stageCounts(stage, matrix) : null;
  $: dirty = counts?.roles ?? 0;
  const toggleArea = (a: AreaKey, on: boolean) => { if (matrix && role) stage = stageArea(stage, matrix, role, a, on); };
  function setField(k: string, v: unknown) {
    if (!matrix || !role) return;
    const before = stagedAreas(stage, role);
    stage = stageField(stage, matrix, role, k, v);
    void keepFocus(before);
  }
  /**
   * A press that switched its own area off (the last library unticked, the last of Watch-Partys and Kommentare off) removes the
   * section with the focused control in it: the focus goes to that area's card, where it can be switched on again (WCAG 2.4.3).
   */
  async function keepFocus(before: Areas) {
    const at = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-section]') : null;
    const a = at?.dataset.section as AreaKey | undefined;
    if (!a || !role || !before[a] || stagedAreas(stage, role)[a] || a === 'livetv') return;
    await tick();
    document.querySelector<HTMLElement>(`[data-area="${a}"] [role="switch"]`)?.focus();
  }
  const put = (k: string, v: unknown) => { if (matrix && role) stage = stageSet(stage, matrix, role.key, k, v); };
  const staged = (s: Stage, r: MatrixRole, k: string): unknown => (Object.hasOwn(s[r.key] ?? {}, k) ? s[r.key]![k] : undefined);

  /** a section's fields; the admin role's switches are locked on (the note says so), its numbers stay editable */
  const fieldsOf = (m: RoleMatrix, r: MatrixRole, a: AreaKey | 'general'): MatrixField[] => fieldsOfArea(m, a).filter((f) => !(r.base === 'admin' && PERM_SET.has(f.key)));
  /** the sections below the grid, in the fixed order: the areas that are on (Live-TV while installed, its groups dormant when off), then Allgemein */
  $: sections = matrix && role && areas
    ? AREA_KEYS.filter((a) => (a === 'livetv' ? matrix!.features.livetv
      // a section with nothing to edit is not shown (the admin role's Gemeinsam: only switches, all locked on)
      : areas![a] && (a !== 'requests' || matrix!.features.requests) && fieldsOf(matrix!, role!, a).length > 0))
    : [];

  // ---- the name: staged once it is 1-30 characters (the role write's bounds); a bad text shows the error and stages nothing
  let typed: string | null = null;
  const nameOf = (s: Stage, r: MatrixRole | null, _l: unknown): string => (!r ? '' : staged(s, r, 'label') !== undefined ? String(staged(s, r, 'label')) : roleName(r));
  $: shownName = nameOf(stage, role, $locale);
  $: nameValue = typed ?? shownName;
  $: nameErr = typed !== null && (typed.trim().length < 1 || typed.trim().length > 30) ? $t('adminPeople.roles.errLabel') : '';
  function onName(e: Event) {
    if (!role) return;
    typed = (e.target as HTMLInputElement).value;
    const v = typed.trim();
    put('label', v.length >= 1 && v.length <= 30 ? v : roleName(role));
  }

  // ---- the groups (ids in group order), staged as livetvGroups
  $: chosenGroups = role ? ((staged(stage, role, 'livetvGroups') as string[] | undefined) ?? role.livetvGroupIds ?? []) : [];

  // ---- save: the review sheet and the shared sequential save (one PUT for this role)
  // a saved name is the loaded one now: the field shows it (a name typed meanwhile stays)
  const save = createSave({
    matrix: () => matrix, stage: () => stage,
    stored: (m, s) => { matrix = m; stage = s; if (!Object.hasOwn(s[key] ?? {}, 'label') && !nameErr) typed = null; },
    // a group was taken back or merged meanwhile: the groups are read again, what still exists stays staged for a check
    groupsChanged: async () => {
      try {
        const r = await api<{ matrix?: RoleMatrix }>('/api/admin/roles');
        if (r.matrix) { matrix = r.matrix; stage = keepKnownGroups(stage, r.matrix); }
      } catch { /* the stale list stays; the message still asks to check it */ }
    },
  });
  $: saving = $save.saving;
  let reviewing = false, reviewBtn: HTMLElement | null = null, bar: SaveBar | undefined;
  function openReview() { reviewBtn = document.activeElement instanceof HTMLElement ? document.activeElement : null; reviewing = true; }
  async function saveReviewed() { reviewing = false; await tick(); bar?.focus(); await save.apply(); }
  function discardAll() { stage = {}; typed = null; save.discard(); }

  // a reload or a closed tab asks too (the browser's own question)
  leaveGuard((nav) => (nav.willUnload || leavesRoute(nav)) && dirty > 0, () => leaveQuestion());

  // ---- ?field=<key>: that control is focused and centred (an area's own switch, or `area:<key>` from the compare view: its card;
  // `livetvGroups`: the first channel group); no smooth scroll with reduced motion
  const AREA_OF_SWITCH: Record<string, AreaKey> = { liveTv: 'livetv', requests: 'requests', download: 'downloads' };
  async function focusField() {
    const f = $page$.url.searchParams.get('field');
    if (!f) return;
    await tick();
    const area = f.startsWith('area:') ? f.slice(5) : AREA_OF_SWITCH[f];
    const sel = area ? `[data-area="${CSS.escape(area)}"] [role="switch"]` : f === 'livetvGroups' ? '[data-groups]' : `[data-field="${CSS.escape(f)}"]`;
    const host = document.querySelector<HTMLElement>(sel);
    const el = host?.matches('button, input, select') ? host : host?.querySelector<HTMLElement>('input:not([disabled]), select, button:not([disabled]), textarea');
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // ---- the ⋯ menu: duplicate (the copy's page opens), history, delete (back to the list)
  const here = (): HTMLElement | null => (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  let dup: { trigger: HTMLElement | null } | null = null, dupBusy = false, dupErr = '';
  let history: { trigger: HTMLElement | null } | null = null;
  let del: { trigger: HTMLElement | null; accounts: number; invites: number } | null = null, delBusy = false, delErr = '';
  $: deletable = !!role && canDelete(role);
  const leaveQuestion = () => ({ title: tr('adminPeople.roles.leaveTitle'), body: tr('adminPeople.roles.leaveBody', { n: dirty }), danger: true, confirmLabel: tr('adminPeople.roles.leaveConfirm') });
  /** *Duplizieren* opens the copy's page: with staged edits it asks first, before anything is created (they are dropped on Verwerfen) */
  async function startDuplicate(trigger: HTMLElement | null) {
    if (dirty > 0) {
      if (!(await confirm(leaveQuestion()))) { void tick().then(() => trigger?.focus({ preventScroll: true })); return; }
      discardAll();
    }
    dup = { trigger }; dupErr = ''; dupBusy = false;
  }
  /** a menu item runs after the menu closed and gave the focus back to its button: that is where the focus returns to */
  const itemsOf = (busy: boolean, canGo: boolean, _l: unknown) => [
    { id: 'duplicate', label: tr('adminPeople.roles.duplicate'), icon: 'copy', disabled: busy, run: () => void startDuplicate(here()) },
    { id: 'history', label: tr('adminPeople.roles.history'), icon: 'clock', run: () => { history = { trigger: here() }; } },
    ...(canGo ? [{ id: 'delete', label: tr('adminPeople.roles.delete'), icon: 'x', danger: true, disabled: busy, run: () => void removeRole(here()) }] : []),
  ];
  $: items = itemsOf(saving, deletable, $locale);

  async function duplicate(label: string) {
    if (!role || dupBusy) return;
    dupBusy = true; dupErr = '';
    let made: string;
    try { made = await copyRole(label, role.key); } catch (e) { dupErr = errorText(e); dupBusy = false; return; }
    dup = null; dupBusy = false;
    toast.success(tr('adminPeople.roles.duplicated', { name: label }));
    await goto(`/admin/roles/${encodeURIComponent(made)}`);
  }
  /** the delete (roleDelete.ts): nobody holds the role → a confirm; people do → the server's 409 role_in_use opens the dialog */
  async function removeRole(trigger: HTMLElement | null) {
    if (!role) return;
    const name = roleName(role);
    const r = await deleteRole(role, trigger);
    if (r === 'deleted') await gone(name);
    else if (r !== 'kept') { del = { trigger, ...r }; delErr = ''; delBusy = false; }
  }
  async function removeMoved(to: string) {
    if (!role || !del || delBusy) return;
    delBusy = true; delErr = '';
    const name = roleName(role);
    const r = await deleteMoving(role.key, to);
    delBusy = false;
    if (r.ok) { await gone(name); return; }
    if (r.counts && del) del = { ...del, ...r.counts };
    delErr = r.error;
  }
  /** the role is gone: its staged edits with it (nothing to ask about), back to the list */
  async function gone(name: string) {
    del = null; stage = {}; typed = null; save.discard();
    toast.success(tr('adminPeople.roles.deleted', { name }));
    await goto('/admin/roles');
  }
  $: moveTargets = moveTargetsOf(matrix?.roles ?? [], role?.key);
</script>

<div class="rp">
<p class="back"><a href="/admin/roles"><Icon name="chevron-left" size={16} />{$t('adminPeople.roles.page.back')}</a></p>

{#if error}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{error}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
{:else if matrix === null}
  <!-- the head and the grid at their final size: nothing moves when the role arrives -->
  <div class="head" aria-busy="true"><div class="who"><Skeleton w="12rem" h="2.75rem" /><Skeleton w="10rem" h="1rem" /></div></div>
  <div class="skgrid" aria-hidden="true">{#each [0, 1, 2, 3] as i (i)}<div class="panel sk"><Skeleton w="40%" h="1.1rem" /><Skeleton w="70%" h=".9rem" /></div>{/each}</div>
{:else if !role}
  <div class="state"><Icon name="info" size={22} /><p>{$t('adminPeople.roles.page.missing')}</p><Button variant="secondary" icon="chevron-left" href="/admin/roles">{$t('adminPeople.roles.page.back')}</Button></div>
{:else if areas}
  <header class="head">
    <div class="who">
      <h2>
        {#if role.stored}
          <input class="name" aria-label={$t('adminPeople.roles.fLabel')} value={nameValue} maxlength={30} disabled={saving} aria-invalid={nameErr ? 'true' : undefined}
            aria-describedby="rp-name-e" autocomplete="off" spellcheck="false" on:input={onName} />
        {:else}<span class="fixed">{shownName}</span>{/if}
      </h2>
      <!-- the line under the name is always there: an error or the env lock, never a jump -->
      <p class="nl" id="rp-name-e" class:err={!!nameErr}>
        {#if nameErr}{nameErr}{:else if !role.stored}<Icon name="lock" size={14} />{$t('adminPeople.roles.page.envLocked')}{/if}
      </p>
      <p class="meta">
        <a class="pp" href="/admin/users?role={encodeURIComponent(role.key)}"><Icon name="users" size={16} /><span>{$locale && peopleLine(role)}</span></a>
        {#if role.envGone}<span class="chip">{$t('adminPeople.roles.envGone')}</span>{:else if role.origin === 'env'}<span class="chip">{$t('adminPeople.roles.fromEnv')}</span>{/if}
      </p>
    </div>
    <span class="acts"><ActionMenu label={$locale && $t('ui.table.actionsFor', { name: shownName })} title={shownName} {items} /></span>
  </header>

  <AreaGrid {role} {areas} features={matrix.features} disabled={saving} on:toggle={(e) => toggleArea(e.detail.area, e.detail.on)} />

  <div class="secs">
    {#each sections as a (a)}
      {#if a === 'livetv'}
        <AreaSection area={a} title={areaLabel(a)} icon={AREA_ICON[a]} fields={fieldsOf(matrix, role, a)} {role} {stage} {matrix} disabled={saving} on:change={(e) => setField(e.detail.key, e.detail.value)}>
          <GroupChips roleName={shownName} groups={matrix.livetv?.groups ?? []} chosen={chosenGroups} pending={matrix.livetv?.pending ?? 0}
            mode={role.key === 'admin' ? 'admin' : role.stored ? 'edit' : 'env'} dormant={!areas.livetv} disabled={saving} on:change={(e) => put('livetvGroups', e.detail)} />
        </AreaSection>
      {:else}
        <AreaSection area={a} title={areaLabel(a)} icon={AREA_ICON[a]} fields={fieldsOf(matrix, role, a)} {role} {stage} {matrix} disabled={saving} on:change={(e) => setField(e.detail.key, e.detail.value)} />
      {/if}
    {/each}
    <AreaSection title={$t('adminPeople.roles.areas.general')} icon="settings" fields={fieldsOf(matrix, role, 'general')} {role} {stage} {matrix} disabled={saving} on:change={(e) => setField(e.detail.key, e.detail.value)}>
      {#if role.base === 'admin'}<p class="note"><Icon name="lock" size={15} />{$t('adminPeople.roles.adminLocked')}</p>{/if}
      {#if role.base !== 'admin' && role.stored}
        <div class="fr" data-field="invitable">
          <Toggle label={$t('adminPeople.roles.fInvitable')} hint={$t('adminPeople.roles.invitableHint')} disabled={saving}
            checked={Boolean(staged(stage, role, 'invitable') ?? role.invitable)} on:change={(e) => put('invitable', e.detail)} />
        </div>
      {/if}
    </AreaSection>
  </div>
{/if}
</div>

{#if counts}
  <SaveBar bind:this={bar} count={counts.changes} text={saveBarText(counts)} busy={saving} progress={$save.progress} error={$save.error}
    on:discard={discardAll} on:review={openReview} on:retry={() => void save.retry()} />
{/if}
{#if reviewing && matrix && counts}
  <ReviewSheet lines={reviewLines(stage, matrix)} policy={counts.policy ? policyLine(counts) : null} trigger={reviewBtn}
    on:close={() => (reviewing = false)} on:save={saveReviewed} />
{/if}
{#if dup && role}
  <NameDialog title={tr('adminPeople.roles.duplicateTitle', { name: shownName })} hint={$t('adminPeople.roles.duplicateHint')} label={$t('adminPeople.roles.fLabel')} confirmLabel={$t('adminPeople.roles.create')}
    busy={dupBusy} error={dupErr} trigger={dup.trigger} on:submit={(e) => void duplicate(e.detail)} on:cancel={() => (dup = null)} />
{/if}
{#if history && role}
  <RoleHistory {role} trigger={history.trigger} names={(k) => { const r = matrix?.roles.find((x) => x.key === k); return r ? roleName(r) : null; }} on:close={() => (history = null)} />
{/if}
{#if del && role}
  <DeleteRoleDialog name={shownName} targets={moveTargets} accounts={del.accounts} invites={del.invites} busy={delBusy} error={delErr} trigger={del.trigger}
    on:confirm={(e) => void removeMoved(e.detail)} on:cancel={() => (del = null)} />
{/if}

<style>
  /* the save bar's room at the page's end (set before it rises in): nothing above it moves, the last section stays above it */
  .rp { max-width: 960px; padding-bottom: var(--savebar-h, 0px); display: flex; flex-direction: column; gap: 1.4rem; }
  .back { margin: -.6rem 0 -.6rem; }
  .back a { display: inline-flex; align-items: center; gap: .3rem; min-height: 44px; color: var(--mut); font-size: .9rem; }
  .back a:hover { color: var(--fg); text-decoration: underline; }
  .head { display: flex; align-items: flex-start; gap: 1rem; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
  h2 { margin: 0; font-size: 1.6rem; font-weight: 800; line-height: 1.2; }
  /* the name: a heading you can type into (a light edge on hover, the field look while focused) */
  .name { font: inherit; color: var(--fg); width: min(100%, 22ch); min-height: 48px; box-sizing: border-box; padding: .1rem .5rem; margin-left: -.5rem; border-radius: 12px;
    background: transparent; border: 1px solid transparent; }
  .name:hover:not(:disabled) { border-color: var(--fr-line); }
  .name:focus { background: rgba(var(--fr-scrim-rgb), .35); border-color: rgba(255, 255, 255, .42); }
  .name[aria-invalid='true'] { border-color: var(--err); }
  .fixed { display: inline-flex; align-items: center; min-height: 48px; overflow-wrap: anywhere; }
  .nl { margin: 0; min-height: 1.3em; display: flex; align-items: center; gap: .35rem; font-size: .82rem; color: var(--mut); }
  .nl.err { color: var(--err); }
  .meta { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .8rem; }
  .pp { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; color: var(--mut); font-size: .9rem; }
  .pp:hover { color: var(--fg); text-decoration: underline; text-underline-offset: 3px; }
  .chip { display: inline-flex; align-items: center; min-height: 22px; padding: 0 .55rem; border-radius: 99px; background: var(--wash-muted); color: var(--mut); font-size: .75rem; font-weight: 600; }
  .acts { flex: none; padding-top: .2rem; }
  .secs { display: flex; flex-direction: column; gap: 1rem; }
  .note { margin: 0; display: flex; align-items: center; gap: .4rem; color: var(--mut); font-size: .88rem; }
  .fr { min-width: 0; }
  .skgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; margin-top: 1.9rem; }
  .sk { margin: 0; min-height: 96px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; gap: .5rem; padding: .9rem 1rem; }
  @media (max-width: 599px) { .skgrid { grid-template-columns: minmax(0, 1fr); } h2 { font-size: 1.4rem; } }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--mut); }
  .state p { margin: 0; color: var(--fg); }
  .state[role='alert'] :global(svg) { color: var(--err); }
</style>
