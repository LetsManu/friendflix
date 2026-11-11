<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { fmtDateTime, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { cleanName, deviceName } from '#lib/handoff/deviceName';
  import { confirm } from '#lib/ui/confirm';
  import Rich from '#lib/i18n/Rich.svelte';
  import { onMount, tick } from 'svelte';
  import { api, ApiError, type OwnDevice } from '#lib/api';
  type Dev = OwnDevice;
  let devices: Dev[] = [], me: { deviceApproved: boolean } | null = null, msg = '', err = '', busy = '';
  const load = async () => { devices = (await api('/api/devices')).devices; };
  onMount(() => {
    void load();
    api('/api/me').then((m) => (me = m)).catch(() => undefined);
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000); // a newly signed-in device shows up by itself
    return () => clearInterval(t);
  });
  $: pending = devices.filter((d) => !d.approved && !d.current);
  $: others = devices.filter((d) => d.approved || d.current);
  async function approve(d: Dev) {
    busy = d.id; err = ''; msg = '';
    try { await api(`/api/devices/${d.id}/approve`, { method: 'POST' }); msg = tr('account.devices.approved', { name: shown(d) }); }
    catch (e) {
      err = e instanceof ApiError && e.status === 403
        ? tr('account.devices.approveForbidden')
        : tr('account.devices.approveFailed');
    } finally { busy = ''; await load(); }
  }
  // renaming (spec 2.8): one row at a time becomes a form; the status line below the heading always keeps its space
  let editing = '', draft = '', invalid = false, saving = false;
  /** the name shown for a device */
  const shown = (d: Dev) => deviceName(d, tr);
  /** what the device is called without its own name (the field's placeholder, and the name after "use the detected name") */
  const auto = (d: Dev) => deviceName({ ...d, name: null }, tr);
  function startEdit(d: Dev) { msg = ''; err = ''; invalid = false; draft = d.name ?? ''; editing = d.id; }
  const focusField = (el: HTMLInputElement) => { el.focus(); el.select(); };
  async function stopEdit(id: string) {
    editing = ''; invalid = false;
    await tick();
    document.querySelector<HTMLElement>(`[data-rename="${id}"]`)?.focus();
  }
  async function saveName(d: Dev, raw: string | null) {
    const r = raw === null ? { ok: true as const, name: null } : cleanName(raw);
    if (!r.ok) { invalid = true; err = tr('account.devices.nameInvalid'); msg = ''; return; }
    saving = true; err = ''; msg = '';
    try {
      await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: { name: r.name } });
      msg = tr('account.devices.renamed', { name: r.name ?? auto(d) });
      await load();
      await stopEdit(d.id);
    } catch { err = tr('account.devices.renameFailed'); }
    finally { saving = false; }
  }
  async function revokeOthers() { const r = await api('/api/sessions/revoke-others', { method: 'POST' }); msg = tr('account.devices.revoked', { n: Number(r.revoked) }); }
  async function remove(d: Dev) { if (!(await confirm({ title: tr('account.devices.confirmRemove', { name: shown(d) }), danger: true, confirmLabel: tr('account.devices.remove') }))) return; await api(`/api/devices/${d.id}`, { method: 'DELETE' }); await load(); }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.devices.pageTitle') })}</title></svelte:head>
<h1>{$t('account.devices.title')}</h1>

<section class="panel how" aria-label={$t('account.devices.addAria')}>
  <h2>{$t('account.devices.addTitle')}</h2>
  <ol>
    <li>{$t('account.devices.step1')}</li>
    <li><Rich text={$t('account.devices.step2')} /></li>
    <li><Rich text={$t('account.devices.step3')} /></li>
  </ol>
  {#if me && !me.deviceApproved}<p class="warn">{$t('account.devices.notApprovedSelf')}</p>{/if}
</section>

<!-- both lines are always in the page (live regions announce reliably) and the block keeps its height: no row ever moves -->
<div class="status">
  <p class="ok" role="status">{msg}</p>
  <p class="err" id="dev-err" role="alert">{err}</p>
</div>

{#if pending.length}
  <section class="panel waiting" aria-label={$t('account.devices.waitingAria')}>
    <h2>{$t('account.devices.waiting', { n: pending.length })}</h2>
    {#each pending as d (d.id)}
      <div class="flex row">
        <div><b>{shown(d)}</b><div class="muted">{$t('account.devices.lastSeenAt', { when: fmtDateTime(d.last_seen) })}</div></div>
        <span class="sp"></span>
        <button disabled={busy === d.id} on:click={() => approve(d)}>{busy === d.id ? $t('account.devices.approving') : $t('account.devices.approve')}</button>
        <button class="sec" on:click={() => remove(d)}>{$t('account.devices.reject')}</button>
      </div>
    {/each}
  </section>
{:else}
  <p class="muted">{$t('account.devices.noneWaiting')}</p>
{/if}

<h2>{$t('account.devices.approvedTitle')}</h2>
<p><button class="sec" on:click={revokeOthers}>{$t('account.devices.revokeOthers')}</button></p>
<table>
  <thead><tr><th class="c-name">{$t('account.devices.device')}</th><th class="c-seen">{$t('account.devices.lastSeen')}</th><th class="c-act"></th></tr></thead>
  <tbody>
    {#each others as d (d.id)}
      <tr>
        <td class="c-name">
          <div class="cell">
            {#if editing === d.id}
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape on any control of the form cancels it) -->
              <form class="edit" on:submit|preventDefault={() => saveName(d, draft)} on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void stopEdit(d.id); } }}>
                <input class="fld" type="text" maxlength="40" autocomplete="off" spellcheck="false" aria-label={$t('account.devices.nameLabel')} placeholder={auto(d)} bind:value={draft}
                  aria-invalid={invalid ? 'true' : undefined} aria-describedby={invalid ? 'dev-err' : undefined} on:input={() => { if (invalid) { invalid = false; err = ''; } }} use:focusField />
                <button type="submit" disabled={saving}>{$t('common.save')}</button>
                <button type="button" class="sec" on:click={() => stopEdit(d.id)}>{$t('common.cancel')}</button>
                {#if d.name}<button type="button" class="ghost" disabled={saving} on:click={() => saveName(d, null)}>{$t('account.devices.useAuto')}</button>{/if}
              </form>
            {:else}
              <span class="nm">{shown(d)} {#if d.current}<span class="badge">{$t('account.devices.thisDevice')}</span>{/if}</span>
            {/if}
          </div>
        </td>
        <td class="c-seen">{fmtDateTime(d.last_seen)}</td>
        <td class="c-act">
          <div class="acts">
            {#if editing !== d.id}
              <button type="button" class="ghost ico" data-rename={d.id} aria-label={$t('account.devices.renameAria', { name: shown(d) })} title={$t('account.devices.rename')} on:click={() => startEdit(d)}><Icon name="pencil" size={18} /></button>
            {/if}
            {#if !d.current}<button class="sec" on:click={() => remove(d)}>{$t('account.devices.remove')}</button>{/if}
          </div>
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .how ol { margin: .3rem 0 0; padding-left: 1.3rem; display: grid; gap: .3rem; color: var(--mut); } .how b { color: var(--fg); }
  .waiting { border-color: var(--warn); }
  .row { padding: .5rem 0; border-top: 1px solid var(--line); } .row:first-of-type { border-top: 0; }
  .sp { flex: 1; }
  h2 { font-size: 1.15rem; }
  /* the result line keeps two lines of room even when empty, so showing a message moves nothing */
  .status { min-height: 3.4em; margin: .4rem 0; } .status p { margin: 0; }
  table { table-layout: fixed; }
  .c-name { width: 62%; } .c-seen { width: 20%; } .c-act { width: 18%; }
  /* every row reserves the height of the rename form (44 px field), so opening it moves nothing */
  .cell { min-height: 44px; display: flex; align-items: center; }
  .nm { overflow-wrap: anywhere; }
  .edit { display: flex; gap: .5rem; align-items: center; flex-wrap: nowrap; width: 100%; min-width: 0; }
  .fld { flex: 1 1 8rem; min-width: 0; height: 44px; padding-block: 0; box-sizing: border-box; }
  .fld::placeholder { color: #a9b3bd; opacity: 1; }
  .fld[aria-invalid='true'] { border-color: var(--err); }
  .edit button { flex: none; padding-inline: .8rem; }
  .acts { display: flex; gap: .5rem; justify-content: flex-end; align-items: center; min-height: 44px; }
  .ico { padding: .5rem; width: 44px; }
  @media (max-width: 700px) {
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border-bottom: 1px solid var(--line); }
    td { border-bottom: 0; }
    .c-name { grid-column: 1 / -1; width: auto; padding-bottom: 0; } .c-seen { width: auto; } .c-act { width: auto; }
    /* field on one line, its buttons on a second: both lines reserved in every row */
    .cell { min-height: 96px; }
    .edit { flex-wrap: wrap; } .fld { flex: 1 0 100%; }
  }
</style>
