<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * User detail, Rechte tab (spec §6.3): the groups of the role matrix, one row per right: label, the role's value (muted), the control
   * and where the effective value comes from (Rolle / Ausnahme / Kinderprofil / Admin / .env). A switch is a three-way radiogroup
   * (Wie Rolle · Erlauben · Verbieten), a number or preset the shared `FieldControl` plus a *Wie Rolle* reset. Edits are staged into the
   * save bar (review sheet, then `PUT …/rights` with only the changed keys); a *Notiz* says why. 502 `policy_partial`: stored, the
   * bar offers *Erneut anwenden* (the repair, which applies the policy again). An admin account's switches are locked.
   */
  import { onMount } from 'svelte';
  import { api, apiCode, ApiError } from '#lib/api';
  import { cellText, fieldLabel, partialText, visibleFields, type FieldGroup, type MatrixField, type RoleMatrix } from '#lib/admin/rights/model';
  import { leaveGuard } from '#lib/admin/leaveGuard';
  import { fetchRoles, type RolesLoader } from '#lib/admin/rights/rolesAnswer';
  import FieldControl from '#lib/admin/rights/FieldControl.svelte';
  import ReviewSheet from '#lib/admin/rights/ReviewSheet.svelte';
  import SaveBar from '#lib/admin/rights/SaveBar.svelte';
  import { locale, t, tr, trDynamic } from '#lib/i18n';
  import { PERM_KEYS } from '#lib/perms';
  import { fetchGroups, groupErrorOf, putUserGroups, type GroupView, type UserGroups } from '#lib/admin/livetv/groups';
  import Icon from '#lib/Icon.svelte';
  import { errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import { uid } from '#lib/ui/ids';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import { leaveQuestion, NOTE_MAX, rightsPatch, sourceLabel, stagedValue, triOf, type RightSource, type RightsRow, type RightsView, type Tri } from './rights';

  export let userId: string;
  /** the person's name (toasts, review sheet) */
  export let name: string;
  /** read-only for the page (bind:dirty): something is staged; the header's role change asks first then (its key remounts this tab) */
  export let dirty = false;
  /** GET /api/admin/roles for the matrix (the person page shares one answer) */
  export let loadRoles: RolesLoader = fetchRoles;

  const id = uid('rt');
  const TRIS: Tri[] = ['role', 'allow', 'deny'];
  const PERMS: ReadonlySet<string> = new Set(PERM_KEYS);

  let view: RightsView | null = null, matrix: RoleMatrix | null = null, error: string | null = null;
  /** unsaved changes: key → value in the PUT encoding (null = as role, 'unlimited' = no cap) */
  let staged: Record<string, unknown> = {};
  let note = '';
  let saving = false, barError: string | null = null, partial = false;
  /** a refused library list (400 unknown_library): shown at the row, not in the bar (a retry would fail the same way) */
  let libError: string | null = null;
  let reviewing = false, reviewBtn: HTMLElement | null = null;
  let bar: SaveBar | undefined;

  async function load(keepStage = false): Promise<boolean> {
    try {
      const [v, r] = await Promise.all([api<RightsView>(`/api/admin/users/${userId}/rights`), matrix ? Promise.resolve({ matrix }) : loadRoles()]);
      if (!r.matrix) throw new Error('no matrix');
      view = v; matrix = r.matrix; error = null;
      if (!keepStage) { staged = {}; note = v.note ?? ''; }
      return true;
    } catch {
      if (view) toast.error(tr('adminPeople.loadFailed')); else error = tr('adminPeople.loadFailed');
      return false;
    }
  }
  onMount(() => { void load(); });

  // ---- Kanalgruppen-Ausnahmen (Live TV spec §8): saved at once through their own route, not through the save bar. An admin sees every
  // released group and takes none (the backend answers 400 admin_groups_locked: the section says so instead of offering them).
  let exc: UserGroups = { allow: [], deny: [] }, released: GroupView[] | null = null, groupsFailed = false;
  let addPlus = '', addMinus = '', excBusy = false;
  $: if (view) exc = view.livetvGroups ?? { allow: [], deny: [] };
  $: if (matrix?.features.livetv && !released && !groupsFailed) void loadGroups();
  let groupsAsked = false;
  async function loadGroups() {
    if (groupsAsked) return;
    groupsAsked = true;
    try { released = (await fetchGroups()).groups.filter((g) => g.released); } catch { groupsFailed = true; }
  }
  /** an exception on a group that is not released does not reach anybody (ruling 39): its chip says so and is not styled as a grant */
  $: liveIds = new Set((released ?? []).map((g) => g.id));
  const exName = (g: { id: string; name: string }, live: ReadonlySet<string>): string => (live.has(g.id) ? tr('adminPeople.rights.livetvRemove', { name: g.name }) : `${tr('adminPeople.rights.livetvRemove', { name: g.name })}. ${tr('adminLive.grp.unreleased')}: ${tr('adminLive.grp.unreleasedLine')}`);
  $: taken = new Set([...exc.allow, ...exc.deny].map((g) => g.id));
  // a plus adds a group the role does not see, a minus takes away one it does
  $: plusOptions = (released ?? []).filter((g) => !taken.has(g.id) && !g.roles.includes(view?.role ?? ''));
  $: minusOptions = (released ?? []).filter((g) => !taken.has(g.id) && g.roles.includes(view?.role ?? ''));
  async function saveExceptions(allow: string[], deny: string[]) {
    if (excBusy) return;
    excBusy = true;
    const r = await runAction({ run: () => putUserGroups(userId, allow, deny), success: tr('adminPeople.rights.livetvSaved', { name }), error: groupErrorOf });
    excBusy = false;
    if (r.ok && r.value) exc = r.value;
  }
  const ids = (l: Array<{ id: string }>) => l.map((g) => g.id);
  function addTo(kind: 'allow' | 'deny', gid: string) {
    if (!gid) return;
    void saveExceptions(kind === 'allow' ? [...ids(exc.allow), gid] : ids(exc.allow), kind === 'deny' ? [...ids(exc.deny), gid] : ids(exc.deny));
  }
  const dropFrom = (gid: string) => saveExceptions(ids(exc.allow).filter((x) => x !== gid), ids(exc.deny).filter((x) => x !== gid));

  $: isAdmin = view?.role === 'admin';
  $: rowOf = new Map((view?.rows ?? []).map((r) => [r.key, r]));
  $: fields = matrix ? visibleFields(matrix).filter((f) => rowOf.has(f.key)) : [];
  $: groups = ((): Array<{ g: FieldGroup; fields: MatrixField[] }> => {
    const out: Array<{ g: FieldGroup; fields: MatrixField[] }> = [];
    for (const f of fields) {
      const last = out[out.length - 1];
      if (last && last.g === f.group) last.fields.push(f); else out.push({ g: f.group, fields: [f] });
    }
    return out;
  })();

  $: patch = view ? rightsPatch(view.rows, staged, note, view.note) : null;
  $: changes = patch ? Object.keys(patch.overrides).length + (patch.note !== undefined ? 1 : 0) : 0;
  $: barText = $t('adminPeople.rights.saveBar', { n: changes, name });
  $: dirty = changes > 0;

  /** the library names the media server no longer has that the (staged) list still holds */
  $: missing = ((): string[] => {
    const row = rowOf.get('libraries');
    const list = row ? stagedValue(row, staged) : null;
    return Array.isArray(list) ? (view?.missingLibraries ?? []).filter((n) => list.includes(n)) : [];
  })();

  const isLocked = (f: MatrixField) => isAdmin && PERMS.has(f.key);
  const stage = (k: string, v: unknown) => { if (k === 'libraries') libError = null; staged = { ...staged, [k]: v }; };
  const triValue = (o: Tri): boolean | null => (o === 'role' ? null : o === 'allow');
  const triNow = (row: RightsRow, st: Record<string, unknown>): Tri => (Object.hasOwn(st, row.key) ? (st[row.key] === null ? 'role' : st[row.key] ? 'allow' : 'deny') : triOf(row));
  /** the FieldControl's null = no cap, spelled 'unlimited' in the PUT */
  const fromControl = (k: string, v: unknown) => stage(k, v === null ? 'unlimited' : v);
  /** a stored or staged exception that *Wie Rolle* can take away */
  const hasException = (row: RightsRow, st: Record<string, unknown>): boolean => (Object.hasOwn(st, row.key) ? st[row.key] !== null : row.override !== null && row.override !== undefined);
  function chip(row: RightsRow): RightSource {
    const v = patch?.overrides[row.key];
    if (v === undefined) return row.source;
    return v === null ? (row.source === 'user' ? 'role' : row.source) : 'user';
  }

  const word = (v: unknown) => tr(v ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied');
  const valueText = (f: MatrixField, v: unknown): string => (f.kind === 'bool' ? word(v) : cellText(f, v));
  const roleText = (f: MatrixField, row: RightsRow): string => tr('adminPeople.rights.roleIs', { value: valueText(f, row.roleValue) });
  const triText = (o: Tri): string => tr(`adminPeople.rights.${o === 'role' ? 'asRole' : o}` as 'adminPeople.rights.allow');

  $: reviewLines = ((): Array<{ role: string; field: string; from: string; to: string }> => {
    if (!view || !patch) return [];
    const lines = fields.filter((f) => patch.overrides[f.key] !== undefined).map((f) => {
      const row = rowOf.get(f.key)!;
      return { role: name, field: fieldLabel(f.key), from: valueText(f, row.value), to: valueText(f, stagedValue(row, { [f.key]: patch.overrides[f.key] })) };
    });
    if (patch.note !== undefined) lines.push({ role: name, field: tr('adminPeople.rights.note'), from: view.note || '–', to: patch.note || '–' });
    return lines;
  })();

  /** the PUT was stored: the staged edits go (they would show as unsaved), also when the reload after it failed */
  function settle(sent: { note?: string | null }) {
    if (!view) return;
    staged = {}; view = { ...view, note: sent.note !== undefined ? sent.note : view.note }; note = view.note ?? '';
  }
  async function save() {
    if (!patch || saving) return;
    const sent = patch;
    saving = true; barError = null; partial = false; libError = null;
    try {
      await api(`/api/admin/users/${userId}/rights`, { method: 'PUT', body: sent });
      saving = false;
      toast.success(tr('adminPeople.rights.saved', { name }));
      if (!(await load())) settle(sent);
    } catch (e) {
      const code = apiCode(e);
      if (e instanceof ApiError && e.status === 502 && code === 'policy_partial') {
        // stored either way: reload the stored values while the bar still shows the save running, then show the error once with
        // its final buttons (*Schließen* · *Erneut anwenden*): no staged edits left, so nothing swaps under the pointer
        if (!(await load())) settle(sent);
        partial = true;
        barError = partialText(Number((e.body as { failed?: number }).failed) || 0);
      } else if (e instanceof ApiError && e.status === 400 && code === 'unknown_library') {
        libError = tr('adminPeople.rights.unknownLibrary');
      } else barError = errorText(e);
      saving = false;
    }
    bar?.focus();
  }
  /** *Erneut anwenden*: after a partial failure the policy again (a repeated PUT would change nothing and so apply nothing); else the save again */
  async function retry() {
    if (!partial) { await save(); return; }
    saving = true; barError = null;
    try {
      // /repair answers 200 with ok:false while identities still fail: a partial repair is not a success
      const r = await api<{ ok?: boolean; jellyfin?: { failed?: number } }>(`/api/admin/users/${userId}/repair`, { method: 'POST' });
      if (r?.ok) { partial = false; toast.success(tr('adminPeople.rights.reapplied', { name })); }
      else { const n = Number(r?.jellyfin?.failed) || 0; barError = n > 0 ? partialText(n) : tr('adminPeople.detail.overview.repairPartial'); }
    } catch (e) {
      barError = errorText(e);
    }
    saving = false;
  }
  function discard() { staged = {}; note = view?.note ?? ''; barError = null; partial = false; libError = null; }
  function openReview() { reviewBtn = document.activeElement as HTMLElement | null; reviewing = true; }
  // staged edits are not lost silently: a tab switch or any navigation asks first, as Rollen & Rechte does
  leaveGuard(() => changes > 0, () => leaveQuestion(name));
  async function saveReviewed() { reviewing = false; await save(); }
</script>

{#if error}
  <div class="state" role="alert"><p>{error}</p><Button variant="secondary" icon="refresh" on:click={() => { error = null; void load(); }}>{$t('ui.retry')}</Button></div>
{:else if !view || !matrix}
  <div class="skel" aria-busy="true"><Skeleton w="40%" h="1.2rem" /><Skeleton w="100%" h="3rem" /><Skeleton w="100%" h="3rem" /><Skeleton w="100%" h="3rem" /></div>
{:else}
  <div class="rights" aria-busy={saving ? 'true' : undefined}>
    {#each groups as grp (grp.g)}
      <section class="grp" aria-labelledby="{id}-{grp.g}">
        <h3 id="{id}-{grp.g}">{$locale && trDynamic(`adminPeople.roles.groups.${grp.g}`)}</h3>
        <ul class="card rows">
          {#each grp.fields as f (f.key)}
            {@const row = rowOf.get(f.key)!}
            {@const label = $locale && fieldLabel(f.key)}
            <li class="row">
              <div class="lab"><span class="nm">{label}</span><span class="role">{roleText(f, row)}</span></div>
              <div class="ctl">
                {#if isLocked(f)}
                  <span class="locked">{$t('adminPeople.roles.adminLocked')}</span>
                {:else if f.kind === 'bool'}
                  {@const cur = triNow(row, staged)}
                  {@const gid = `${id}-${f.key}`}
                  <div class="tri" role="radiogroup" aria-label={label} style:--i={TRIS.indexOf(cur)}>
                    <span class="thumb" aria-hidden="true"></span>
                    {#each TRIS as o (o)}
                      <label class="seg" class:on={cur === o}>
                        <input type="radio" name={gid} value={o} checked={cur === o} disabled={saving} on:change={() => stage(f.key, triValue(o))} />
                        <span>{triText(o)}</span>
                      </label>
                    {/each}
                  </div>
                {:else}
                  <FieldControl field={f} value={stagedValue(row, staged)} placeholder={row.roleValue} libraries={matrix.libraries} disabled={saving} on:change={(e) => fromControl(f.key, e.detail)} />
                  <Button variant="ghost" disabled={saving || !hasException(row, staged)} on:click={() => stage(f.key, null)}>{$t('adminPeople.rights.asRole')}</Button>
                {/if}
              </div>
              <span class="src"><StatusPill tone={chip(row) === 'user' ? 'info' : 'muted'} label={sourceLabel(chip(row))} icon="" /></span>
              {#if f.key === 'libraries' && libError}<p class="lib-err" role="alert">{libError}</p>{/if}
              {#if f.key === 'libraries' && missing.length}
                <ul class="miss">
                  {#each missing as n (n)}<li><span class="mn">{n}</span><StatusPill tone="warn" icon="alert" label={$t('adminPeople.rights.missingLibrary')} /></li>{/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}

    {#if matrix.features.livetv}
      <section class="grp" aria-labelledby="{id}-lg">
        <h3 id="{id}-lg">{$t('adminPeople.rights.livetvGroups')}</h3>
        <div class="card lg" aria-busy={excBusy ? 'true' : undefined}>
          {#if isAdmin}
            <p class="mut">{$t('adminLive.grp.adminAll')}</p>
          {:else if groupsFailed}
            <p class="mut" role="alert">{$t('adminLive.loadFailed')}</p>
          {:else if !released}
            <div class="lsk" aria-busy="true"><Skeleton w="60%" h="1.2rem" /><Skeleton w="100%" h="2.6rem" /></div>
          {:else}
            <p class="mut">{$t('adminPeople.rights.livetvHint')}</p>
            <div class="lrow" role="group" aria-label={$t('adminPeople.rights.livetvPlus')}>
              <span class="ll">{$t('adminPeople.rights.livetvPlus')}</span>
              <ul class="lchips">
                {#each exc.allow as g (g.id)}
                  <li><button type="button" class="lc allow" class:off={!liveIds.has(g.id)} disabled={excBusy} aria-label={$locale && exName(g, liveIds)} title={liveIds.has(g.id) ? undefined : $t('adminLive.grp.unreleasedLine')} on:click={() => dropFrom(g.id)}><span aria-hidden="true">+ {g.name} ×</span>{#if !liveIds.has(g.id)}<span class="lm" aria-hidden="true"><Icon name="eye-off" size={14} />{$t('adminLive.grp.unreleased')}</span>{/if}</button></li>
                {:else}<li class="mut">{$t('adminPeople.rights.livetvNone')}</li>{/each}
              </ul>
              <div class="lsel">
                <Select label={$t('adminPeople.rights.livetvAddPlus')} bind:value={addPlus} disabled={excBusy || plusOptions.length === 0}
                  options={[{ value: '', label: $t('adminPeople.rights.livetvPick') }, ...plusOptions.map((g) => ({ value: g.id, label: g.name }))]} on:change={() => { const v = addPlus; addPlus = ''; addTo('allow', v); }} />
              </div>
            </div>
            <div class="lrow" role="group" aria-label={$t('adminPeople.rights.livetvMinus')}>
              <span class="ll">{$t('adminPeople.rights.livetvMinus')}</span>
              <ul class="lchips">
                {#each exc.deny as g (g.id)}
                  <li><button type="button" class="lc deny" class:off={!liveIds.has(g.id)} disabled={excBusy} aria-label={$locale && exName(g, liveIds)} title={liveIds.has(g.id) ? undefined : $t('adminLive.grp.unreleasedLine')} on:click={() => dropFrom(g.id)}><span aria-hidden="true">− {g.name} ×</span>{#if !liveIds.has(g.id)}<span class="lm" aria-hidden="true"><Icon name="eye-off" size={14} />{$t('adminLive.grp.unreleased')}</span>{/if}</button></li>
                {:else}<li class="mut">{$t('adminPeople.rights.livetvNone')}</li>{/each}
              </ul>
              <div class="lsel">
                <Select label={$t('adminPeople.rights.livetvAddMinus')} bind:value={addMinus} disabled={excBusy || minusOptions.length === 0}
                  options={[{ value: '', label: $t('adminPeople.rights.livetvPick') }, ...minusOptions.map((g) => ({ value: g.id, label: g.name }))]} on:change={() => { const v = addMinus; addMinus = ''; addTo('deny', v); }} />
              </div>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <section class="grp note">
      <Field label={$t('adminPeople.rights.note')} bind:value={note} maxlength={NOTE_MAX} hint={$t('adminPeople.rights.noteHint')} disabled={saving} />
      <span class="count">{$t('adminPeople.rights.noteCount', { n: note.length, max: NOTE_MAX })}</span>
    </section>
  </div>

  <SaveBar bind:this={bar} count={changes} text={barText} busy={saving} progress={null} error={barError} on:discard={discard} on:review={openReview} on:retry={retry} />
  {#if reviewing}
    <ReviewSheet lines={reviewLines} trigger={reviewBtn} on:close={() => (reviewing = false)} on:save={saveReviewed} />
  {/if}
{/if}

<style>
  .rights { display: flex; flex-direction: column; gap: 1.4rem; padding-bottom: var(--savebar-h, 0px); }
  .skel { display: flex; flex-direction: column; gap: .8rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; }
  .grp h3 { margin: 0 0 .5rem; font-size: 1rem; font-weight: 700; }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto; align-items: center; gap: .4rem 1rem; padding: .55rem 1rem; border-top: 1px solid var(--line); }
  .row:first-child { border-top: 0; }
  .lab { display: flex; flex-direction: column; min-width: 0; }
  .nm { overflow-wrap: anywhere; }
  .role { font-size: .82rem; color: var(--mut); overflow-wrap: anywhere; }
  .ctl { display: flex; align-items: center; gap: .6rem; min-width: 0; }
  .ctl > :global(.fc) { flex: 1; }
  /* the row's own label names the control: the control's label stays for assistive technology only */
  .ctl :global(.field > label), .ctl :global(legend) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .locked { color: var(--mut); font-size: .9rem; }
  .src { justify-self: end; }
  .lib-err { grid-column: 1 / -1; margin: 0; color: var(--err); font-weight: 600; font-size: .9rem; }
  .miss { grid-column: 1 / -1; list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem 1rem; }
  .miss li { display: inline-flex; align-items: center; gap: .5rem; }
  .mn { overflow-wrap: anywhere; }

  /* three-way switch: native radios (arrow keys), the selection is a thumb that moves by transform only */
  .tri { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; max-width: 22rem; padding: 3px; border-radius: 12px; background: rgba(var(--fr-scrim-rgb), .25); box-shadow: inset 0 0 0 1px var(--fr-line, var(--line)); }
  .thumb { position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px) / 3); border-radius: 9px; background: var(--acc); transform: translateX(calc(var(--i, 0) * 100%)); transition: transform 240ms var(--fr-out, ease-out); }
  .seg { position: relative; display: flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 .4rem; text-align: center; cursor: pointer; border-radius: 9px; font-size: .9rem; font-weight: 600; color: var(--mut); }
  .seg > span { position: relative; z-index: 1; overflow-wrap: anywhere; }
  .seg.on { color: #1a1a1a; }
  .seg input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .seg:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 1px; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  .seg:has(input:disabled) { cursor: default; opacity: .6; }
  :global(html.m-still) .thumb { transition: none; }
  @media (prefers-reduced-motion: reduce) { .thumb { transition: none; } }

  .lg { padding: 1rem; display: flex; flex-direction: column; gap: .8rem; }
  .lg .mut, .lg p { margin: 0; color: var(--mut); overflow-wrap: anywhere; }
  .lsk { display: flex; flex-direction: column; gap: .6rem; min-height: 5rem; }
  .lrow { display: grid; grid-template-columns: 9rem minmax(0, 1fr) minmax(0, 15rem); align-items: center; gap: .4rem 1rem; }
  .ll { font-weight: 600; }
  .lchips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem; min-height: 44px; align-items: center; }
  .lc { min-height: 44px; min-width: 44px; padding: 0 .9rem; border-radius: 99px; font-weight: 600; font-size: .88rem; background: rgba(var(--fr-scrim-rgb), .25); box-shadow: inset 0 0 0 1px var(--fr-line, var(--line)); overflow-wrap: anywhere; }
  .lc.allow { color: var(--ok); }
  .lc.deny { color: var(--warn); }
  /* on a group that is not released: neutral (not a grant, not a block), with the marker */
  .lc.off { color: var(--mut); }
  .lc { display: inline-flex; align-items: center; gap: .5rem; }
  .lm { display: inline-flex; align-items: center; gap: .25rem; font-size: .78rem; font-weight: 600; color: var(--mut); }
  .lc:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  .note { max-width: 40rem; }
  .count { display: block; margin-top: .25rem; font-size: .82rem; color: var(--hint, var(--mut)); text-align: right; }

  /* phone: label, control and source stack; the page does not scroll sideways */
  @media (max-width: 720px) {
    .row { grid-template-columns: minmax(0, 1fr); padding: .7rem .8rem; }
    .src { justify-self: start; }
    .tri { max-width: none; }
    .ctl { flex-wrap: wrap; }
    .lrow { grid-template-columns: minmax(0, 1fr); }
  }
</style>
