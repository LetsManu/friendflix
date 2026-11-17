<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 3's managed path (spec "Admin and wizard", wizard step 3) for one kind: *Basisordner* → *Ordner* → *Grafikkarte*
   * (+ *Metadaten aus dem Internet*) → *Einrichten*, built from the Admin card's sections bound to the setup routes (setupMediaApi():
   * setup session, no re-authentication; what the wizard has no route for, those sections hide by `api.scope`). User and media group
   * stay what runs (else 1000:1000): they are set later in Admin. After *Einrichten* the first run's progress is followed every 2 s
   * (*Nochmal* on a failed step); once a followed first run is done the step goes on (`done`) and stays as it is while the page moves.
   * Opened on a server already set up: *Übernehmen* for changes and *Weiter*. The error line has its room from the start: nothing above
   * the progress moves while it runs.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { apiCode } from '#lib/api';
  import { t, tr } from '#lib/i18n';
  import type { FolderInput, Gpu, Kind, MediaApi, MediaView } from '#lib/admin/mediaserver/api';
  import BaseFolder from '#lib/admin/mediaserver/BaseFolder.svelte';
  import FolderPicker from '#lib/admin/mediaserver/FolderPicker.svelte';
  import GpuSection from '#lib/admin/mediaserver/GpuSection.svelte';
  import SetupProgress from '#lib/admin/mediaserver/SetupProgress.svelte';
  import { choiceDisabled, folderRowsError, initialRows, keptLibraries, mediaErrorText, nameTakenRow, setupActive } from '#lib/admin/mediaserver/model';
  import Button from '#lib/ui/Button.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';

  export let api: MediaApi;
  /** the step's requests (a setup session that is gone goes back to the code step) */
  export let call: <T>(fn: () => Promise<T>) => Promise<T>;
  /** the backend's view, read again here (the step's choice control follows it) */
  export let view: MediaView;
  export let kind: Kind;
  const dispatch = createEventDispatcher<{ done: void }>();

  async function load(): Promise<void> {
    try {
      const v = await call(() => api.view());
      const was = view.mode === 'managed' ? view.managed.setup : null;
      view = v;
      if (hdrWait && ((v.status?.hdr?.at ?? null) !== hdrBefore || ++hdrPolls >= HDR_POLLS)) hdrWait = false;
      if (was !== null && was !== 'done' && v.mode === 'managed' && v.managed.setup === 'done') {
        // the first run this step followed is done: on to the sign-in
        leaving = true;
        dispatch('done');
      }
    } catch { /* the next poll tries again; a session that is gone was handed to the page */ }
  }

  $: active = view.mode === 'managed' && setupActive(view.managed);
  // the HDR test's job is not followed here (the wizard has no job view): its result arrives with the view, or the wait ends
  const HDR_POLLS = 60;
  let hdrWait = false, hdrPolls = 0, hdrBefore: string | null = null;
  $: following = active || hdrWait;
  let timer: ReturnType<typeof setTimeout> | undefined, gone = false;
  function schedule() {
    clearTimeout(timer);
    if (gone || !following) return;
    timer = setTimeout(async () => { await load(); schedule(); }, 2000);
  }
  $: if (following) schedule();
  onDestroy(() => { gone = true; clearTimeout(timer); });

  // the form: what runs when it is this kind, else the defaults
  const same = view.managed.kind === kind;
  const desired = same ? view.status?.desired ?? null : null;
  let rows: FolderInput[] = same ? initialRows(view) : [];
  let gpu: Gpu = desired?.gpu ?? 'off', egress = desired?.egress ?? true;
  const preselectGpu = !desired;
  const ids = { uid: desired?.uid ?? 1000, gid: desired?.gid ?? 1000, mediaGid: desired?.mediaGid ?? null };
  let rowErrors: Record<string, string> = {}, error = '', applying = false, acting: '' | 'retry' | 'hdr-test' = '', leaving = false;

  $: isCurrent = view.mode === 'managed' && view.managed.kind === kind;
  $: locked = !view.status?.available || (!isCurrent && Boolean(choiceDisabled(view, kind)));
  $: base = view.status?.base ?? { set: false, path: null, pending: false, expiresAt: null };
  $: kept = isCurrent ? keptLibraries(view) : [];
  $: working = applying || acting !== '' || active || hdrWait;
  /** set up before this step was opened: *Übernehmen* for changes and *Weiter* */
  $: finished = isCurrent && view.managed.setup === 'done' && !leaving;
  const edited = () => { rowErrors = {}; error = ''; };

  async function apply() {
    if (working) return;
    edited();
    if (!base.set) { error = tr('mediaserver.apply.needBase'); return; }
    const bad = folderRowsError(rows);
    if (bad) { error = tr(`mediaserver.folders.error.${bad}`); return; }
    applying = true;
    try {
      await call(() => api.apply({ kind, folders: rows.map((r) => ({ ...r, name: r.name.trim() })), ...ids, gpu, egress }));
      await load();
    } catch (e) {
      const code = apiCode(e);
      error = mediaErrorText(code);
      const i = code === 'library_name_taken' ? nameTakenRow(rows, kept) : -1;
      if (i >= 0) rowErrors = { [rows[i]!.rel]: tr('mediaserver.folders.nameTaken') };
    } finally { applying = false; }
  }
  /** *Nochmal* (the failed first-run step) and *HDR-Test*: the two actions the setup routes have */
  async function act(op: 'retry' | 'hdr-test') {
    acting = op; error = '';
    try {
      hdrBefore = view.status?.hdr?.at ?? null;
      await call(() => api.action(op === 'retry' ? { op } : { op, kind }));
      if (op === 'hdr-test') { hdrWait = true; hdrPolls = 0; }
      await load();
    } catch (e) {
      error = mediaErrorText(apiCode(e));
    } finally { acting = ''; }
  }
</script>

<p class="intro">{$t('setup.media.managedText')}</p>
<div class="secs">
  <BaseFolder {api} {call} {base} inUse={Boolean(view.status?.container)} userSection={false} disabled={locked || working} on:changed={() => load()} on:job={() => load()} />
  {#if base.set}
    <FolderPicker {api} {call} bind:rows libraries={isCurrent ? view.managed.libraries : []} {kept} {rowErrors} disabled={locked || working} on:changed={edited} />
    <GpuSection {api} {call} bind:gpu preselect={preselectGpu} hdr={view.status?.hdr ?? null}
      canTest={isCurrent && Boolean(view.status?.container) && !working} deployed={isCurrent ? view.status?.desired?.gpu ?? null : null}
      testing={acting === 'hdr-test' || hdrWait} disabled={locked || working} on:hdr={() => act('hdr-test')} />
    <section class="sec">
      <Toggle label={$t('mediaserver.metadata.label')} hint={$t('mediaserver.metadata.hint')} bind:checked={egress} disabled={locked || working} />
    </section>
  {/if}
</div>
<div class="apply">
  <div class="acts">
    {#if finished}<Button variant="secondary" icon="chevron-right" disabled={working} on:click={() => dispatch('done')}>{$t('setup.next')}</Button>{/if}
    <Button class="go" icon="check" pending={applying} disabled={locked || working || !base.set} data-testid="media-apply" on:click={apply}>
      {finished ? $t('mediaserver.apply.apply') : $t('mediaserver.apply.setup')}
    </Button>
  </div>
  <p class="msg" class:err={error} role={error ? 'alert' : 'status'} data-testid="media-apply-error">{error}</p>
</div>
{#if isCurrent && view.managed.setup !== 'none'}
  <SetupProgress managed={view.managed} busy={acting === 'retry'} canRecreate={false} on:retry={() => act('retry')} />
{/if}

<style>
  .intro { margin: 0 0 .8rem; }
  .secs { display: grid; gap: 1.2rem; }
  .secs > :global(section + section) { padding-top: 1rem; border-top: 1px solid var(--line); }
  .apply { display: grid; gap: .3rem; margin-top: 1.2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  /* one width for *Einrichten* and *Übernehmen* */
  .apply :global(.go) { min-width: 11rem; }
  .msg { margin: 0; min-height: 2.6em; font-size: .9rem; color: var(--mut); text-align: right; }
  .msg.err { color: var(--err-mark); }
  .apply ~ :global(.sp) { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } }
</style>
