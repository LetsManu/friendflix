<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Live-TV → *Aufnahmen* (spec §9.6, §15.3, §15.9, §26; plan Phase 3 Task 11).
   * - *Speicherort*: FriendFlix-Ordner / Jellyfin-Bibliothek / Beides. The library modes stay disabled, with the setup steps, while the
   *   library folder is not mounted (`GET …/recordings/storage` → `library.mounted`). The library select lists the Jellyfin libraries
   *   with their folders; the one holding the recordings folder is preselected and marked *passt*; saving another one asks first (the
   *   §20 mismatch line); *Bibliothek „Aufnahmen“ anlegen* when none holds it. The visibility note, the security note and (§26) the
   *   roles that may record but cannot see the chosen library (read from the role matrix, `GET /api/admin/roles`).
   * - *Speicher und Regeln*: the usage bar ("143 von 200 GB · noch ca. 41 h in HD") and the registry rows of the settings page
   *   (limit, retention, padding, parallel) through the same settings API (no second store).
   * - The list of scheduled, running and failed recordings (metadata only, never a title) with *Abbrechen*.
   * - *Alle Aufnahmen löschen…* behind the typed "LÖSCHEN" (the only way to empty the recordings volume from FriendFlix).
   * Every slot that loads keeps its room (skeletons of the final height).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { highlightSetting } from '#lib/admin/settings/highlight';
  import { pageStore } from '#lib/page';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { isReauthError, reauthenticate } from '#lib/account/reauth';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { fmtDate, fmtTime, t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import type { Column } from '#lib/ui/table';
  import { toast } from '#lib/ui/toast';
  import { fieldErrors, loadSettings, saveSettings, type SettingView } from '#lib/admin/settings/api';
  import { LIVETV_GROUP, changedValues, errorText, type Draft } from '#lib/admin/settings/form';
  import SettingRow from '#lib/admin/settings/SettingRow.svelte';
  import { recReason } from './status';

  type Mode = 'ff' | 'library' | 'both';
  interface Storage { usedBytes: number; limitBytes: number; freeBytes: number | null; hoursLeftHd: number; library: { mounted: boolean; writable: boolean; dedicated: boolean; freeBytes: number } | null }
  interface Lib { id: string; name: string; paths: string[]; fits: boolean }
  interface Libraries { supported: boolean; jfPath: string; selected: string | null; libraries: Lib[] }
  interface Row { id: string; profile: string | null; channel: string; start: string; end: string; mode: string | null; state: string; error: string | null; bytes: number; keep: boolean }
  /** the parts of a role-matrix row (GET /api/admin/roles, backend roleWrite.ts MatrixRole) the §26 warning reads */
  interface RoleRow { key: string; label: string | null; areas?: { library?: boolean }; values: { libraries?: 'all' | string[]; liveTv?: boolean; liveRecord?: boolean } }

  /** the registry rows shown here (the storage mode and library are the card above) */
  const LIMIT_KEYS = ['LIVETV_RECORD_LIMIT_GB', 'LIVETV_RECORD_RETENTION_DAYS', 'LIVETV_RECORD_PAD_BEFORE_MIN', 'LIVETV_RECORD_PAD_AFTER_MIN', 'LIVETV_RECORD_MAX_PARALLEL'];
  const GB = 1_000_000_000;

  let storage: Storage | null = null;
  let libs: Libraries | null = null, libsFailed = false;
  let settings: SettingView[] | null = null, settingsFailed = false;
  let rows: Row[] | null = null, rowsFailed = false;
  let roles: RoleRow[] = [];
  /** the role list could not be read: the warning says so instead of staying silent */
  let rolesFailed = false;
  let mode: Mode = 'ff', libraryId = '', savedMode: Mode = 'ff', savedLib = '';
  let edits: Record<string, Draft> = {};
  let errors: Record<string, string> = {};

  $: mounted = storage?.library?.mounted === true;
  $: libraryModes = mounted && (libs?.supported ?? false);
  $: chosen = libs?.libraries.find((l) => l.id === libraryId) ?? null;
  $: fitting = libs?.libraries.find((l) => l.fits) ?? null;
  $: storageDirty = mode !== savedMode || (mode !== 'ff' && libraryId !== savedLib);
  $: limitItems = settings ? settings.filter((s) => LIMIT_KEYS.includes(s.key)) : null;
  $: limitChanges = limitItems ? changedValues(limitItems, edits) : {};
  $: limitsDirty = Object.keys(limitChanges).length > 0;
  /**
   * §26: roles that may record, have the Mediathek on and do not see the chosen library. Role library lists hold NAMES, matched
   * without case (backend libraries.ts). A Live-TV-only role (no library) is never named: it plays its recordings through FriendFlix,
   * and adding a library would turn its Mediathek on.
   */
  $: blind = chosen && mode !== 'ff' ? roles.filter((r) => missesLibrary(r, chosen!.name)) : [];
  const roleName = (r: RoleRow) => r.label ?? r.key;
  function missesLibrary(r: RoleRow, name: string): boolean {
    const v = r.values;
    const libraryOn = r.areas?.library ?? (v.libraries === 'all' || (Array.isArray(v.libraries) && v.libraries.length > 0));
    if (v.liveTv !== true || v.liveRecord !== true || !libraryOn || v.libraries === 'all') return false;
    const want = name.toLocaleLowerCase();
    return !(v.libraries ?? []).some((l) => typeof l === 'string' && l.toLocaleLowerCase() === want);
  }

  const val = (key: string): unknown => settings?.find((s) => s.key === key)?.value;
  async function loadAll(): Promise<void> {
    await Promise.all([
      api<Storage>('/api/admin/livetv/recordings/storage').then((s) => (storage = s)).catch(() => (storage = { usedBytes: 0, limitBytes: 0, freeBytes: null, hoursLeftHd: 0, library: null })),
      api<Libraries>('/api/admin/livetv/recordings/libraries').then((l) => { libs = l; libsFailed = false; }).catch(() => { libsFailed = true; }),
      loadSettings().then((v) => { settings = v.groups.find((g) => g.id === LIVETV_GROUP)?.items ?? []; settingsFailed = false; }).catch(() => { if (!settings) settingsFailed = true; }),
      api<{ matrix?: { roles?: RoleRow[] } }>('/api/admin/roles').then((r) => { roles = Array.isArray(r.matrix?.roles) ? r.matrix.roles : []; rolesFailed = !Array.isArray(r.matrix?.roles); })
        .catch(() => { roles = []; rolesFailed = true; }),
      loadRows(),
    ]);
    const m = val('LIVETV_RECORD_STORAGE');
    savedMode = m === 'library' || m === 'both' ? m : 'ff';
    mode = savedMode;
    savedLib = String(val('LIVETV_RECORD_LIBRARY_ID') ?? libs?.selected ?? '');
    libraryId = savedLib || fitting?.id || '';
  }
  async function loadRows(): Promise<void> {
    try {
      const [active, failed] = await Promise.all([
        api<{ items: Row[] }>('/api/admin/livetv/recordings?state=active'),
        api<{ items: Row[] }>('/api/admin/livetv/recordings?state=failed'),
      ]);
      rows = [...active.items, ...failed.items];
      rowsFailed = false;
    } catch { if (!rows) rowsFailed = true; }
  }
  // a deep link `?setting=LIVETV_RECORD_*` (Systemcheck, settings search): highlight its row once loaded, then the plain tab again; a
  // key without a row here (the library, its folder) shows the storage card
  const page$ = pageStore();
  $: linkKey = $page$.url.searchParams.get('setting');
  let followed = '';
  $: if (linkKey && settings && storage && linkKey !== followed) void follow(linkKey);
  async function follow(key: string) {
    followed = key;
    await goto('/admin/livetv?tab=recordings', { replace: true, reset: false });
    if (!(await highlightSetting(key))) await highlightSetting('LIVETV_RECORD_STORAGE');
  }
  onMount(() => { void loadAll(); });

  // ---- storage mode and library ----
  async function saveStorage(again = false): Promise<void> {
    if (mode !== 'ff' && chosen && !chosen.fits && !again) {
      if (!(await confirm({ title: tr('adminLive.rec.libMismatch'), danger: true, confirmLabel: tr('adminLive.recTab.saveAnyway') }))) return;
    }
    const values: Record<string, unknown> = { LIVETV_RECORD_STORAGE: mode, ...(mode !== 'ff' && libraryId ? { LIVETV_RECORD_LIBRARY_ID: libraryId } : {}) };
    const res = await runAction({ key: 'ltv:rec:storage', run: () => saveSettings(values), success: tr('settings.saved'), error: false });
    if (res.ok) { savedMode = mode; savedLib = libraryId; return; }
    if (isReauthError(res.error) && !again) { if (await reauthenticate('/admin/livetv?tab=recordings')) return saveStorage(true); return; }
    toast.error(tr('settings.saveFailed'));
  }
  async function createLibrary(): Promise<void> {
    const res = await runAction({ key: 'ltv:rec:lib', run: () => api<{ id: string | null }>('/api/admin/livetv/recordings/libraries', { method: 'POST', body: {} }), success: tr('adminLive.recTab.libCreated') });
    if (!res.ok) return;
    try { libs = await api<Libraries>('/api/admin/livetv/recordings/libraries'); } catch { /* the old list stays */ }
    if (res.value?.id) libraryId = res.value.id;
  }

  // ---- the registry rows ----
  function edit(key: string, d: Draft | undefined) {
    if (d === undefined) delete edits[key]; else edits[key] = d;
    edits = edits;
    if (errors[key]) { delete errors[key]; errors = errors; }
  }
  async function saveLimits(again = false): Promise<void> {
    const values = limitChanges;
    if (!Object.keys(values).length) return;
    const res = await runAction({ key: 'ltv:rec:limits', run: () => saveSettings(values), success: tr('settings.saved'), error: false });
    if (res.ok) {
      for (const k of Object.keys(values)) delete edits[k];
      edits = edits;
      try { settings = (await loadSettings()).groups.find((g) => g.id === LIVETV_GROUP)?.items ?? settings; } catch { /* keep */ }
      try { storage = await api<Storage>('/api/admin/livetv/recordings/storage'); } catch { /* keep */ }
      return;
    }
    if (isReauthError(res.error) && !again) { if (await reauthenticate('/admin/livetv?tab=recordings')) return saveLimits(true); return; }
    const fe = fieldErrors(res.error);
    if (fe) errors = { ...errors, ...fe };
    else toast.error(tr('settings.saveFailed'));
  }

  // ---- the list ----
  const stateWord = (s: string): string => tr((`live.rec.state.${s === 'starting' ? 'scheduled' : s === 'deleting' ? 'cancelled' : s}`) as 'live.rec.state.done', { n: 0 });
  const stateText = (r: Row): string => (r.error && recReason(r.error) ? tr('adminLive.recTab.stateReason', { state: stateWord(r.state), reason: recReason(r.error) }) : stateWord(r.state));
  const when = (r: Row) => `${fmtDate(r.start, { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(r.start)}–${fmtTime(r.end)}`;
  const modeWord = (m: string | null) => (m === 'passthrough' || m === 'remux' || m === 'transcode' ? tr(`adminLive.ch.mode.${m}` as 'adminLive.ch.mode.remux') : '–');
  $: columns = [
    { key: 'channel', label: $t('adminLive.recTab.colChannel'), value: (r: Row) => r.channel, primary: true },
    { key: 'profile', label: $t('adminLive.recTab.colProfile'), value: (r: Row) => r.profile ?? '–' },
    { key: 'time', label: $t('adminLive.recTab.colTime'), value: (r: Row) => when(r), sort: (a: Row, b: Row) => Date.parse(a.start) - Date.parse(b.start) },
    { key: 'mode', label: $t('adminLive.recTab.colMode'), value: (r: Row) => modeWord(r.mode) },
    { key: 'state', label: $t('adminLive.recTab.colState'), value: (r: Row) => stateText(r) },
    { key: 'act', label: '', hideLabel: true, filter: false, sortable: false, align: 'end', width: '8rem' },
  ] as Column<Row>[];
  async function cancel(r: Row): Promise<void> {
    const res = await runAction({
      key: `ltv:rec:${r.id}`,
      apply: () => { const prev = rows; rows = (rows ?? []).filter((x) => x.id !== r.id); return () => { rows = prev; }; },
      run: () => api(`/api/admin/livetv/recordings/${encodeURIComponent(r.id)}`, { method: 'DELETE' }),
      success: tr('adminLive.recTab.cancelled'),
    });
    if (!res.ok) void loadRows();
  }
  async function deleteAll(): Promise<void> {
    if (!(await confirm({ title: tr('adminLive.recTab.deleteAllTitle'), body: tr('adminLive.recTab.deleteAllBody'), danger: true, typed: 'LÖSCHEN', confirmLabel: tr('adminLive.recTab.deleteAllDo') }))) return;
    const res = await runAction({
      key: 'ltv:rec:all', run: () => api<{ deleted: number; pending: number }>('/api/admin/livetv/recordings/delete-all', { method: 'POST', body: { confirm: 'LÖSCHEN' } }),
      success: (v) => tr('adminLive.recTab.deletedAll', { n: (v?.deleted ?? 0) + (v?.pending ?? 0) }),
    });
    if (res.ok) { await loadRows(); try { storage = await api<Storage>('/api/admin/livetv/recordings/storage'); } catch { /* keep */ } }
  }
  const gb = (b: number) => Math.round(b / GB);
</script>

<div class="stack">
  <AdminCard title={$t('adminLive.recTab.storage')}>
    {#if !storage || !settings}
      <div class="sk" aria-hidden="true"><Skeleton h="2.6rem" /><Skeleton h="2.6rem" /><Skeleton h="2.6rem" /></div>
    {:else}
      <fieldset class="modes" id="setting-LIVETV_RECORD_STORAGE">
        <legend class="sr-only">{$t('adminLive.recTab.modes')}</legend>
        {#each [{ v: 'ff', l: 'modeFf' }, { v: 'library', l: 'modeLibrary' }, { v: 'both', l: 'modeBoth' }] as o (o.v)}
          {@const off = o.v !== 'ff' && !libraryModes}
          <label class="mode" class:off>
            <input type="radio" name="ltv-rec-mode" value={o.v} bind:group={mode} disabled={off} />
            <span class="mt"><b>{$t(`adminLive.recTab.${o.l}` as 'adminLive.recTab.modeFf')}</b><span class="muted">{$t(`adminLive.recTab.${o.l}Hint` as 'adminLive.recTab.modeFfHint')}</span></span>
          </label>
        {/each}
      </fieldset>
      {#if libs && !libs.supported}
        <p class="note muted">{$t('adminLive.recTab.libUnsupported')}</p>
      {:else if !mounted}
        <div class="steps">
          <p>{$t('adminLive.recTab.notMounted')}</p>
          <ol>
            <li><code>{$t('adminLive.recTab.step1')}</code></li>
            <li>{$t('adminLive.recTab.step2')}</li>
            <li>{$t('adminLive.recTab.step3')}</li>
          </ol>
        </div>
      {:else}
        {#if storage.library && !storage.library.dedicated}<p class="warn"><Icon name="alert" size={18} /><span>{$t('adminLive.rec.libNotDedicated')}</span></p>{/if}
        {#if mode !== 'ff'}
          <div class="lib">
            {#if libsFailed}
              <p class="warn"><Icon name="alert" size={18} /><span>{$t('adminLive.recTab.libUnreachable')}</span></p>
            {:else if libs}
              <label class="field" for="ltv-rec-lib">{$t('adminLive.recTab.library')}</label>
              <select id="ltv-rec-lib" bind:value={libraryId}>
                <option value="" disabled>{$t('adminLive.recTab.libPick')}</option>
                {#each libs.libraries as l (l.id)}<option value={l.id}>{l.name}{l.fits ? ` · ${$t('adminLive.rec.libFits')}` : ''}</option>{/each}
              </select>
              <p class="folders muted">{chosen ? $t('adminLive.recTab.libFolders', { paths: chosen.paths.join(', ') }) : ''}</p>
              {#if chosen?.fits}<StatusPill tone="ok" icon="check" label={$t('adminLive.rec.libFits')} />{/if}
              {#if !fitting}
                <Button variant="secondary" size="sm" icon="plus" pending={$busyKeys.has('ltv:rec:lib')} on:click={createLibrary}>{$t('adminLive.rec.libCreate')}</Button>
              {/if}
            {/if}
          </div>
          <p class="note">{$t('adminLive.recTab.libVisible')}</p>
          <p class="note muted">{$t('adminLive.rec.libSecurity')}</p>
          {#if rolesFailed}
            <p class="warn"><Icon name="alert" size={18} /><span>{$t('adminLive.recTab.rolesFailed')}</span></p>
          {:else if blind.length && chosen}
            <p class="warn"><Icon name="alert" size={18} /><span>{$t('adminLive.recTab.roleMissing', { library: chosen.name, roles: blind.map(roleName).join(', ') })}</span></p>
          {/if}
        {/if}
      {/if}
      <div class="foot">
        {#if storageDirty}<StatusPill tone="warn" icon="clock" label={$t('settings.unsaved')} />{/if}
        <Button icon="check" pending={$busyKeys.has('ltv:rec:storage')} disabled={!storageDirty || (mode !== 'ff' && !libraryId)} on:click={() => saveStorage()}>{$t('adminLive.recTab.save')}</Button>
      </div>
    {/if}
  </AdminCard>

  <AdminCard title={$t('adminLive.recTab.limits')}>
    <div class="usage">
      {#if storage}
        <Progress value={Math.min(storage.usedBytes, storage.limitBytes || storage.usedBytes)} max={storage.limitBytes || 1} label={$t('adminLive.recTab.usageAria')} tone={storage.limitBytes && storage.usedBytes >= 0.9 * storage.limitBytes ? 'warn' : 'acc'} />
        <p class="uline">{$t('adminLive.recTab.usage', { used: gb(storage.usedBytes), limit: gb(storage.limitBytes), hours: storage.hoursLeftHd })}</p>
      {:else}<Skeleton h="2.4rem" />{/if}
    </div>
    {#if settingsFailed}
      <p class="warn" role="alert"><Icon name="alert" size={18} /><span>{$t('adminLive.settingsTab.loadFailed')}</span></p>
    {:else if !limitItems}
      <div class="sk" aria-hidden="true"><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div>
    {:else}
      <form novalidate on:submit|preventDefault={() => saveLimits()}>
        {#each limitItems as item (item.key)}
          <SettingRow {item} draft={edits[item.key]} error={errors[item.key] ? errorText(errors[item.key]!, item.key) : ''} on:edit={(e) => edit(item.key, e.detail)} />
        {/each}
        <div class="foot">
          {#if limitsDirty}<StatusPill tone="warn" icon="clock" label={$t('settings.unsaved')} />{/if}
          <Button type="submit" icon="check" pending={$busyKeys.has('ltv:rec:limits')} disabled={!limitsDirty}>{$t('settings.save')}</Button>
        </div>
      </form>
    {/if}
  </AdminCard>

  <AdminCard title={$t('adminLive.recTab.list')}>
    <div class="table">
      <DataTable rows={rows} {columns} key={(r) => r.id} caption={$t('adminLive.recTab.list')} pageSize={0} error={rowsFailed ? $t('adminLive.loadFailed') : null}
        emptyText={$t('adminLive.recTab.empty')} on:retry={loadRows}>
        <svelte:fragment slot="cell" let:row let:col>
          {#if col.key === 'act'}
            {#if row.state === 'scheduled' || row.state === 'starting' || row.state === 'recording'}
              <Button variant="secondary" pending={$busyKeys.has(`ltv:rec:${row.id}`)} on:click={() => cancel(row)}>{$t('adminLive.recTab.cancel')}</Button>
            {/if}
          {:else if col.key === 'state'}
            <StatusPill tone={row.state === 'failed' ? 'err' : row.state === 'recording' ? 'ok' : 'muted'} icon={row.state === 'failed' ? 'alert' : row.state === 'recording' ? 'record' : 'clock'} label={stateText(row)} />
          {:else}{col.value?.(row) ?? ''}{/if}
        </svelte:fragment>
      </DataTable>
    </div>
  </AdminCard>

  <AdminCard title={$t('adminLive.recTab.danger')}>
    <p class="muted dh">{$t('adminLive.recTab.dangerHint')}</p>
    <Button variant="danger" icon="x" pending={$busyKeys.has('ltv:rec:all')} on:click={deleteAll}>{$t('adminLive.recTab.deleteAll')}</Button>
  </AdminCard>
</div>

<style>
  .stack { display: grid; gap: 1rem; max-width: 900px; }
  .sk { display: grid; gap: .8rem; min-height: 9rem; }
  .modes { display: grid; gap: .4rem; margin: 0 0 .8rem; padding: 0; border: 0; }
  .mode { display: flex; align-items: flex-start; gap: .7rem; min-height: 44px; padding: .5rem .6rem; border-radius: 12px; cursor: pointer; }
  .mode input { flex: none; width: 20px; height: 20px; margin: .15rem 0 0; }
  .mode.off { cursor: not-allowed; }
  .mode.off .mt { opacity: .6; }
  .mt { display: grid; gap: .1rem; }
  .steps { margin: 0 0 .8rem; }
  .steps p { margin: 0 0 .4rem; }
  .steps ol { margin: 0; padding-left: 1.3rem; display: grid; gap: .3rem; }
  code { overflow-wrap: anywhere; }
  .lib { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .8rem; margin-bottom: .6rem; }
  .lib .field { flex: 1 0 100%; font-weight: 600; }
  .lib select { min-height: 44px; min-width: min(100%, 18rem); }
  /* the folder line keeps its room whether a library is chosen or not */
  .folders { flex: 1 0 100%; margin: 0; min-height: 1.4em; }
  .note { margin: .3rem 0; }
  .warn { display: flex; gap: .5rem; align-items: flex-start; margin: .5rem 0; color: var(--warn); }
  .warn :global(svg) { flex: none; margin-top: 2px; }
  .foot { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: .6rem; padding-top: .8rem; margin-top: .6rem; border-top: 1px solid var(--line); }
  .usage { display: grid; gap: .4rem; min-height: 3.2rem; margin-bottom: .8rem; }
  .uline { margin: 0; font-variant-numeric: tabular-nums; }
  form { display: grid; gap: .25rem; }
  .table { min-height: 8rem; }
  /* *Abbrechen* and the mode words stay on one line */
  .table :global(td.al-end), .table :global(td.al-end button) { white-space: nowrap; }
  /* names and mode words break between words, never inside one */
  .table :global(td:not(.al-end)) { word-break: normal; overflow-wrap: normal; hyphens: manual; }
  .dh { margin: 0 0 .8rem; }
</style>
