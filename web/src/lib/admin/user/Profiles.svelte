<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * User detail, profiles tab (spec §6.3): per profile the kids switch (not on the owner), the age limit (kids only; its room is reserved
   * so a switch never moves the list), PIN state with reset, last use, and the menu Rename / Delete (kids profiles only, with confirm).
   * *Kinderprofil anlegen* opens a small sheet; at the profile limit it is disabled with its reason next to it.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { avatarBg, initial } from '#lib/avatars';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { uid } from '#lib/ui/ids';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column } from '#lib/ui/table';
  import Toggle from '#lib/ui/Toggle.svelte';
  import type { MoreAction } from '#lib/MoreActions.svelte';
  import type { DetailProfile } from './detail';
  import KidsSheet from './KidsSheet.svelte';
  import { CAPS, capLabel, MAX_PROFILES, profileError, reloadAfter, type ProfileOp } from './profiles';

  export let userId: string;
  export let profiles: DetailProfile[];
  const dispatch = createEventDispatcher<{ changed: void }>();
  /** the DB limit of a profile name */
  const NAME_MAX = 20;

  const CREATE_ID = uid('pr-create');
  const hintId = uid('pr-hint');
  let editing: string | null = null, draft = '';
  let creating = false, createErr = '';
  /** a refused switch / limit is put back by mounting its controls again */
  let rev: Record<string, number> = {};
  $: full = profiles.length >= MAX_PROFILES;
  $: columns = [
    { key: 'name', label: $t('adminPeople.detail.profiles.col.name'), primary: true },
    { key: 'kind', label: $t('adminPeople.detail.profiles.col.kind') },
    { key: 'kids', label: $t('adminPeople.profiles.kidsSwitch'), width: '6rem' },
    { key: 'cap', label: $t('adminPeople.profiles.maxRating'), width: '12rem' },
    { key: 'pin', label: $t('adminPeople.detail.profiles.col.pin') },
    { key: 'lastUsed', label: $t('adminPeople.detail.profiles.col.lastUsed') },
  ] satisfies Column<DetailProfile>[];
  const kind = (p: DetailProfile): string => (p.isOwner ? tr('adminPeople.detail.profiles.owner') : p.kids ? tr('adminPeople.detail.profiles.kids') : tr('adminPeople.detail.profiles.regular'));
  const capOptions = () => CAPS.map((n) => ({ value: String(n), label: capLabel(n) }));
  const menu = (p: DetailProfile): MoreAction[] => [
    { id: 'rename', label: tr('adminPeople.detail.profiles.renameShort'), icon: 'pencil', run: () => edit(p) },
    ...(p.kids && !p.isOwner ? [{ id: 'delete', label: tr('common.delete'), danger: true, run: () => remove(p) }] : []),
  ];
  const key = (p: DetailProfile) => `profile:${p.id}`;

  async function edit(p: DetailProfile) {
    editing = p.id; draft = p.name;
    await tick();
    document.getElementById(`udp-name-${p.id}`)?.focus();
  }
  const update = (p: DetailProfile, body: Record<string, unknown>) => () =>
    api<{ profile: { name: string; hasPin: boolean } }>(`/api/admin/users/${userId}/profiles/${p.id}`, { method: 'PATCH', body });
  const nameError = (e: unknown): string => (e instanceof ApiError && e.status === 409 ? tr('adminPeople.detail.profiles.nameTaken') : errorText(e));

  async function save(p: DetailProfile) {
    const name = draft.trim();
    if (!name || name === p.name) { editing = null; return; }
    const r = await runAction({ key: key(p), run: update(p, { name }), error: nameError, success: (res) => tr('adminPeople.detail.profiles.renamed', { name: res?.profile.name ?? name }) });
    if (r.ok) { editing = null; dispatch('changed'); }
  }
  async function resetPin(p: DetailProfile) {
    const ok = await confirm({
      title: tr('adminPeople.detail.profiles.resetPinTitle', { name: p.name }), body: tr('adminPeople.detail.profiles.resetPinBody'),
      danger: true, confirmLabel: tr('adminPeople.detail.profiles.resetPin'),
    });
    if (!ok) return;
    const r = await runAction({ key: key(p), run: update(p, { resetPin: true }), success: tr('adminPeople.detail.profiles.pinReset', { name: p.name }) });
    if (r.ok) dispatch('changed');
  }
  /** a refused control goes back to what is stored; a write that stored anyway (or a profile that is gone) reloads */
  function undo(p: DetailProfile, e: unknown, op: ProfileOp) {
    rev = { ...rev, [p.id]: (rev[p.id] ?? 0) + 1 };
    if (reloadAfter(e, op)) dispatch('changed');
  }
  async function setKids(p: DetailProfile, on: boolean) {
    const r = await runAction({ key: key(p), run: update(p, { kids: on }), error: (e) => profileError(e, 'update'), success: tr(on ? 'adminPeople.profiles.kidsOn' : 'adminPeople.profiles.kidsOff', { name: p.name }) });
    if (r.ok) dispatch('changed'); else undo(p, r.error, 'update');
  }
  async function setCap(p: DetailProfile, maxRating: number) {
    const r = await runAction({ key: key(p), run: update(p, { maxRating }), error: (e) => profileError(e, 'update'), success: tr('adminPeople.profiles.capSaved', { name: p.name }) });
    if (r.ok) dispatch('changed'); else undo(p, r.error, 'update');
  }
  async function remove(p: DetailProfile) {
    const ok = await confirm({
      title: tr('adminPeople.profiles.deleteTitle', { name: p.name }), body: tr('adminPeople.profiles.deleteBody'),
      danger: true, confirmLabel: tr('adminPeople.profiles.delete'),
    });
    if (!ok) return;
    const r = await runAction({
      key: key(p), run: () => api(`/api/admin/users/${userId}/profiles/${p.id}`, { method: 'DELETE' }),
      error: (e) => profileError(e, 'delete'), success: tr('adminPeople.profiles.deleted', { name: p.name }),
    });
    if (r.ok || reloadAfter(r.error, 'delete')) dispatch('changed');
  }
  async function create(b: { name: string; maxRating: number }) {
    createErr = '';
    // the sheet shows a refusal itself (next to its button), not a toast over it
    const r = await runAction({
      key: 'profile:new', run: () => api(`/api/admin/users/${userId}/profiles`, { method: 'POST', body: { name: b.name, kids: true, maxRating: b.maxRating } }),
      error: false, success: tr('adminPeople.profiles.created', { name: b.name }),
    });
    if (r.ok) {
      creating = false;
      dispatch('changed');
      await tick();
      document.getElementById(CREATE_ID)?.focus({ preventScroll: true });
    } else if (!r.skipped) {
      createErr = profileError(r.error, 'create');
      if (reloadAfter(r.error, 'create')) dispatch('changed');
    }
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); editing = null; } }
</script>

<div class="bar">
  <Button id={CREATE_ID} icon="plus" disabled={full} aria-describedby={full ? hintId : undefined} on:click={() => { createErr = ''; creating = true; }}>{$t('adminPeople.profiles.createKids')}</Button>
  {#if full}<span class="sub" id={hintId}>{$t('adminPeople.profiles.limitHint', { n: MAX_PROFILES })}</span>{/if}
</div>

<DataTable caption={$t('adminPeople.detail.tabs.profiles')} rows={profiles} {columns} key={(p) => p.id} pageSize={0} busyKey={key} actions={menu} rowLabel={(p) => p.name} emptyText={$t('adminPeople.detail.profiles.empty')}>
  <svelte:fragment slot="cell" let:row let:col>
    {#if col.key === 'name'}
      {#if editing === row.id}
        <form class="ren" on:submit|preventDefault={() => save(row)}>
          <Field id="udp-name-{row.id}" label={$t('adminPeople.detail.profiles.newName')} bind:value={draft} maxlength={NAME_MAX} hideLabel required on:keydown={onKey} />
          <Button type="submit" size="sm" disabled={$busyKeys.has(key(row))}>{$t('adminPeople.detail.profiles.save')}</Button>
          <Button variant="ghost" size="sm" on:click={() => (editing = null)}>{$t('adminPeople.detail.profiles.cancel')}</Button>
        </form>
      {:else}
        <span class="who">
          <span class="av" style:background={avatarBg(row.avatar ?? undefined)} aria-hidden="true">{initial(row.name)}</span>
          <span class="n">{row.name}</span>
        </span>
      {/if}
    {:else if col.key === 'kind'}{kind(row)}
    {:else if col.key === 'kids'}
      <!-- the owner profile is never a kids profile: no switch -->
      {#if !row.isOwner}
        {#key rev[row.id] ?? 0}
          <Toggle label={$t('adminPeople.profiles.kidsSwitchFor', { name: row.name })} hideLabel checked={row.kids} pending={$busyKeys.has(key(row))} on:change={(e) => setKids(row, e.detail)} />
        {/key}
      {/if}
    {:else if col.key === 'cap'}
      <!-- the row of the limit exists for every profile, so switching kids on or off never moves the list -->
      <span class="cap">
        {#key rev[row.id] ?? 0}
          <span class="sel" class:ghost={!row.kids} aria-hidden={row.kids ? undefined : 'true'} inert={!row.kids}>
            <Select label={$t('adminPeople.profiles.maxRatingFor', { name: row.name })} hideLabel value={String(row.maxRating ?? 12)} options={capOptions()} disabled={!row.kids || $busyKeys.has(key(row))}
              on:change={(e) => setCap(row, Number((e.target as HTMLSelectElement).value))} />
          </span>
        {/key}
        {#if !row.kids}<span class="dash sub" aria-hidden="true">–</span>{/if}
      </span>
    {:else if col.key === 'lastUsed'}
      {#if row.lastUsed}<time datetime={row.lastUsed} title={fmtDateTime(row.lastUsed)}>{fmtRelative(row.lastUsed)}</time>{:else}<span class="sub">{$t('adminPeople.never')}</span>{/if}
    {:else if col.key === 'pin'}
      <span class="pin">
        {#if row.hasPin}
          <StatusPill tone="info" icon="lock" label={$t('adminPeople.detail.profiles.hasPin')} />
          <Button variant="ghost" icon="key" aria-label={$t('adminPeople.detail.profiles.resetPinFor', { name: row.name })} on:click={() => resetPin(row)}>{$t('adminPeople.detail.profiles.resetPin')}</Button>
        {:else}<span class="sub">{$t('adminPeople.detail.profiles.noPin')}</span>{/if}
      </span>
    {/if}
  </svelte:fragment>
</DataTable>

{#if creating}
  <KidsSheet trigger={document.getElementById(CREATE_ID)} pending={$busyKeys.has('profile:new')} error={createErr} on:edit={() => (createErr = '')} on:create={(e) => create(e.detail)} on:close={() => (creating = false)} />
{/if}

<style>
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .9rem; margin-bottom: .8rem; }
  .cap, .pin { display: flex; align-items: center; flex-wrap: wrap; gap: .3rem .6rem; min-height: 44px; }
  .cap { position: relative; }
  .sel { display: block; width: 100%; max-width: 11rem; }
  /* a grown-up profile: the same select, unseen and out of reach, holds the room so the row keeps its height */
  .ghost { visibility: hidden; }
  .dash { position: absolute; left: .2rem; top: 50%; transform: translateY(-50%); }
  .who { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .7rem; min-width: 0; }
  .av { width: 30px; height: 30px; flex: none; border-radius: 6px; display: grid; place-items: center; font-weight: 800; font-size: .9rem; color: #fff; }
  .n { font-weight: 600; overflow-wrap: anywhere; }
  .ren { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .ren :global(.field) { flex: 1 1 10rem; max-width: 16rem; }
  .sub { color: var(--mut); font-size: .85rem; }
  time { white-space: nowrap; }
</style>
