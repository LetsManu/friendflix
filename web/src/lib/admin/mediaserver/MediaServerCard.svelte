<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Einstellungen → Medienserver, card *Medienserver* (spec "Admin and wizard"): the three choices as a segmented control
   * (*Ferrofin (eigener)* with *Test* while it is a trial, *Jellyfin (offiziell, verwaltet)*, *Bestehender Jellyfin/Plex (Adresse)*;
   * a choice that cannot be taken is disabled and says why). A managed kind shows *Basisordner*, *Ordner*, *Benutzer*, *Grafikkarte*
   * and *Metadaten aus dem Internet*, then *Einrichten* / *Übernehmen*; below them the first run's progress, the *Status* with the
   * last job, the actions that fit (model.ts actionsFor), *Protokoll* and the backups. The external choice keeps today's address
   * fields (the settings group card under this one, shown by the page while `mode` is external) and, while managed, switches back
   * with the id warning (*Zurück zu <address>* when one is saved). A request that needs a recent sign-in asks for it in place and runs
   * once more (isReauthError / reauthenticate, like the settings page). While a job or the first run runs, the card polls every 2 s;
   * so it does while the updater has not read the media status yet since it started (model.ts statusStarting): the card then waits
   * as on its first load, with the neutral line in its kept place, and shows no form and no actions.
   * New things only ever appear below what was clicked; every line that comes and goes (codes, countdowns, errors, results) has
   * its room from the start.
   * The move from Jellyfin (stage 2): *Von Jellyfin umziehen* (MediaChoice) opens MoveSheet; the card polls while its scan, the move
   * or a way back runs (model.ts moveFollow) and shows a running move with *Fortschritt ansehen*. A moved server shows "Umgezogen von
   * „<name>“ am …", how the old Jellyfin is (stopped and kept, running, gone) and *Zurück zu Jellyfin* (its warning first; re-auth; it
   * runs in the background and the card follows it); a gone old Jellyfin turns it into the stage 1 switch (an address). The request
   * service warning names the manual step while it does not point at the server FriendFlix uses.
   */
  import { onDestroy, onMount } from 'svelte';
  import { apiCode } from '#lib/api';
  import { isReauthError, reauthenticate } from '#lib/account/reauth';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtDate, t, tr } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import ModalShell from '#lib/ui/ModalShell.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { confirm, typedOk } from '#lib/ui/confirm';
  import { toast } from '#lib/ui/toast';
  import { saveSettings } from '../settings/api';
  import { MEDIA_TAB, type UpdaterJob } from '../updater';
  import { adminMediaApi, type FolderInput, type Gpu, type Kind, type MediaApi, type MediaView } from './api';
  import {
    actionsFor, backActive, choiceDisabled, currentChoice, folderRowsError, idError, initialRows, keptLibraries, kindName, livetvOffer, mediaErrorText, moveActive, moveFollow,
    nameTakenRow, setupActive, sourceLine, statusStarting, type ActionOp, type Choice,
  } from './model';
  import BackupDialogs from './BackupDialogs.svelte';
  import BaseFolder from './BaseFolder.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import GpuSection from './GpuSection.svelte';
  import LogDialog from './LogDialog.svelte';
  import MediaChoice from './MediaChoice.svelte';
  import MediaStatus from './MediaStatus.svelte';
  import MoveSheet from './MoveSheet.svelte';
  import SetupProgress from './SetupProgress.svelte';

  export let api: MediaApi = adminMediaApi;
  /** the server's mode once loaded (the page shows the address card only while external); null until then */
  export let mode: MediaView['mode'] | null = null;

  let view: MediaView | null = null, loadFailed = false;
  let choice: Choice = 'external';
  let job: UpdaterJob | null = null;

  /** runs a request; a 401 reauth_required asks for a fresh sign-in in place and runs it once more (a second refusal is an error) */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isReauthError(e) || api.scope !== 'admin' || !(await reauthenticate(MEDIA_TAB))) throw e;
      return fn();
    }
  }

  // ------------------------------------------------------------------ loading and following
  let seenMode: MediaView['mode'] | null = null;
  async function load(): Promise<boolean> {
    try {
      const [v, j] = await Promise.all([api.view(), api.lastJob().catch(() => job)]);
      view = v; job = j; loadFailed = false;
      // the choice follows the server when its mode changes (first load, a switch, a remove), never on a poll; not before the
      // updater read the media status (the form starts from what is deployed)
      if (seenMode !== v.mode && !statusStarting(v)) { seenMode = v.mode; pick(currentChoice(v)); }
      mode = v.mode;
      return true;
    } catch {
      if (!view) { loadFailed = true; mode = 'external'; }
      return false;
    }
  }
  $: starting = Boolean(view && statusStarting(view));
  $: following = Boolean(job?.state === 'running' || starting || (view && view.mode === 'managed' && setupActive(view.managed)) || (view && api.scope === 'admin' && moveFollow(view)));
  let timer: ReturnType<typeof setTimeout> | undefined, gone = false;
  function schedule() {
    clearTimeout(timer);
    if (gone || !following) return;
    timer = setTimeout(async () => { await load(); schedule(); }, 2000);
  }
  $: if (following) schedule();
  onMount(() => { void load(); });
  onDestroy(() => { gone = true; clearTimeout(timer); });
  function started(j: UpdaterJob | null | undefined) {
    if (j) job = j;
    void load().then(schedule);
  }
  const refresh = () => void load().then(schedule);

  // ------------------------------------------------------------------ the form of a managed kind
  let rows: FolderInput[] = [], uid = '1000', gid = '1000', groupInput = '', mediaGid: number | null = null, gpu: Gpu = 'off', egress = true, preselectGpu = true;
  let rowErrors: Record<string, string> = {}, applyError = '', baseUnreadable = false;
  /** a new form for the chosen kind: what runs now when it is this kind, else the defaults */
  function pick(c: Choice) {
    choice = c;
    if (c === 'external' || !view) return;
    const same = view.managed.kind === c;
    const d = same ? view.status?.desired : null;
    rows = same ? initialRows(view) : [];
    uid = String(d?.uid ?? 1000); gid = String(d?.gid ?? 1000); mediaGid = d?.mediaGid ?? null; groupInput = '';
    gpu = d?.gpu ?? 'off'; preselectGpu = !d; egress = d?.egress ?? true;
    rowErrors = {}; applyError = '';
  }

  $: managedKind = choice === 'external' ? null : choice;
  $: isCurrent = Boolean(view && managedKind && view.mode === 'managed' && view.managed.kind === managedKind);
  $: available = Boolean(view?.status?.available);
  $: locked = !available || Boolean(view && managedKind && !isCurrent && choiceDisabled(view, managedKind));
  $: base = view?.status?.base ?? { set: false, path: null, pending: false, expiresAt: null };
  $: kept = view && isCurrent ? keptLibraries(view) : [];
  $: offer = view && isCurrent && api.scope === 'admin' ? livetvOffer(view, rows) : null;
  $: firstRun = !isCurrent || view?.managed.setup !== 'done';
  $: actions = view ? actionsFor(view) : [];
  $: running = job?.state === 'running';
  const num = (s: string) => (/^\d{1,5}$/.test(s.trim()) ? Number(s.trim()) : NaN);
  $: uidErr = idError(num(uid)) ? $t('mediaserver.user.idError') : '';
  $: gidErr = idError(num(gid)) ? $t('mediaserver.user.idError') : '';
  $: groupOk = !idError(num(groupInput));
  const edited = () => { rowErrors = {}; applyError = ''; };

  async function apply() {
    if (!view || !managedKind) return;
    rowErrors = {}; applyError = '';
    if (!base.set) { applyError = tr('mediaserver.apply.needBase'); return; }
    const bad = folderRowsError(rows);
    if (bad) { applyError = tr(`mediaserver.folders.error.${bad}`); return; }
    if (uidErr || gidErr) { applyError = tr('mediaserver.user.idError'); return; }
    applying = true;
    try {
      const r = await call(() => api.apply({ kind: managedKind!, folders: rows.map((x) => ({ ...x, name: x.name.trim() })), uid: num(uid), gid: num(gid), gpu, mediaGid, egress }));
      toast.success(tr(firstRun ? 'mediaserver.apply.started' : 'mediaserver.apply.applied'));
      started(r.job);
    } catch (e) {
      const code = apiCode(e);
      applyError = mediaErrorText(code);
      if (code === 'library_name_taken') {
        const i = nameTakenRow(rows, kept);
        if (i >= 0) rowErrors = { [rows[i]!.rel]: tr('mediaserver.folders.nameTaken') };
      } else if (code === 'library_referenced' && api.scope === 'admin') await markReferenced();
    } finally { applying = false; }
  }
  /** library_referenced: the rows whose existing library was renamed or retyped name their reference counts */
  async function markReferenced() {
    if (!view) return;
    try {
      const { libraries } = await call(() => api.libraries());
      const out: Record<string, string> = {};
      for (const r of rows) {
        const l = libraries.find((x) => x.rel === r.rel && x.created);
        if (!l || (l.name === r.name.trim() && l.type === r.type)) continue;
        const refs = l.references ?? { lists: 0, resume: 0, recordings: 0 };
        out[r.rel] = tr('mediaserver.folders.referenced', { lists: refs.lists, resume: refs.resume, recordings: refs.recordings });
      }
      rowErrors = out;
    } catch { /* the line above already says why */ }
  }

  // ------------------------------------------------------------------ actions
  let applying = false, acting = '', actionError = '';
  async function act(op: MainAction | 'hdr-test' | 'retry') {
    if (op === 'remove') { openRemove(false); return; }
    acting = op; actionError = '';
    try {
      const body = op === 'hdr-test' ? { op, kind: managedKind ?? 'jellyfin' } as const : { op };
      const r = await call(() => api.action(body));
      started('job' in r ? r.job : null);
    } catch (e) {
      actionError = mediaErrorText(apiCode(e));
    } finally { acting = ''; }
  }
  const RETRY: Record<string, 'apply' | 'start' | 'stop' | 'restart' | 'update' | 'hdr-test'> = {
    'mediaserver-apply': 'apply', 'mediaserver-start': 'start', 'mediaserver-stop': 'stop', 'mediaserver-restart': 'restart', 'mediaserver-update': 'update', 'mediaserver-hdr-test': 'hdr-test',
  };
  $: retryable = Boolean(job && RETRY[job.action] && available && (RETRY[job.action] === 'apply' || RETRY[job.action] === 'hdr-test' || actions.includes(RETRY[job.action] as ActionOp)));
  function retryJob(j: UpdaterJob) {
    const op = RETRY[j.action];
    if (op === 'apply') void apply(); else if (op) void act(op);
  }

  // *Entfernen*: data kept unless *Daten löschen* is chosen and the kind's name typed; a managed server becomes external (restore: false)
  let removeOpen = false, removeData = false, removeTyped = '', removeError = '', removing = false, removeTrigger: HTMLElement | null = null, removeShell: ModalShell;
  /** after *Neu anlegen*: the kind to set up again once the remove ran */
  let again: Kind | null = null;
  function openRemove(data: boolean, recreate = false) {
    removeTrigger = (document.activeElement as HTMLElement | null) ?? null;
    removeData = data; removeTyped = ''; removeError = ''; removeOpen = true;
    again = recreate ? view?.managed.kind ?? null : null;
  }
  $: removeKind = view?.status?.container?.kind ?? view?.managed.kind ?? 'jellyfin';
  $: removeReady = !removeData || typedOk(kindName(removeKind), removeTyped);
  async function remove() {
    if (!removeReady || removing) return;
    removing = true; removeError = '';
    try {
      const r = await call(() => api.action({ op: 'remove', data: removeData }));
      removeOpen = false;
      const k = again;
      // *Neu anlegen*: the same kind comes back with what was chosen, ready for *Einrichten*
      const form = { rows, uid, gid, mediaGid, gpu, egress };
      started('job' in r ? r.job : null);
      if (k) { await load(); pick(k); ({ rows, uid, gid, mediaGid, gpu, egress } = form); preselectGpu = false; }
    } catch (e) {
      removeError = mediaErrorText(apiCode(e));
    } finally { removing = false; }
  }

  // back to the external server: the id warning first; *Zurück zu <address>* puts the saved address and key back
  let switching = false;
  async function toExternal(restore: boolean) {
    if (!view) return;
    const address = view.external.url ?? '';
    const ok = await confirm({
      title: restore ? tr('mediaserver.external.backTitle', { address }) : tr('mediaserver.external.switchTitle'),
      body: `${tr('mediaserver.external.idWarning')} ${tr(restore ? 'mediaserver.external.backBody' : 'mediaserver.external.switchBody')}`,
      danger: true, confirmLabel: restore ? tr('mediaserver.external.back', { address }) : tr('mediaserver.external.switch'),
    });
    if (!ok) return;
    switching = true; actionError = '';
    try {
      await call(() => api.mode(restore));
      toast.success(tr('mediaserver.external.switched'));
      await load();
    } catch (e) {
      actionError = mediaErrorText(apiCode(e));
    } finally { switching = false; }
  }

  // ------------------------------------------------------------------ the move from Jellyfin and the way back (stage 2)
  let moveOpen = false, moveWatch = false, moveTrigger: HTMLElement | null = null;
  function openMove(watch: boolean) {
    moveTrigger = (document.activeElement as HTMLElement | null) ?? null;
    moveWatch = watch; moveOpen = true;
  }
  $: mv = api.scope === 'admin' ? view?.move ?? null : null;
  $: moved = Boolean(view && mv?.migratedFrom && view.mode === 'managed');
  $: source = view ? sourceLine(view) : null;
  /** the way back asked for here: its end is told once (a toast when done, the reason when it failed) */
  let goingBack = false, backError = '';
  $: if (goingBack && mv?.state?.back === 'done') { goingBack = false; toast.success(tr('mediaserver.move.backDone')); }
  $: if (goingBack && mv?.state?.back === 'failed') goingBack = false;
  $: backLine = backError
    || (mv?.state?.back === 'failed' ? tr('mediaserver.move.backFailed', { reason: mediaErrorText(mv.state.backError) }) : '')
    || (view && backActive(view) ? tr('mediaserver.move.backRunning') : '');
  $: backBad = Boolean(backError || mv?.state?.back === 'failed');
  async function wayBack() {
    if (!view) return;
    // the old container is gone: the stage 1 switch (FriendFlix stops Ferrofin, the address is entered below)
    if (source === 'missing') { await toExternal(false); return; }
    const ok = await confirm({ title: tr('mediaserver.move.wayBackTitle'), body: tr('mediaserver.move.wayBackBody'), danger: true, confirmLabel: tr('mediaserver.move.wayBack') });
    if (!ok) return;
    backError = ''; goingBack = true;
    try {
      await call(() => api.back());
      refresh();
    } catch (e) {
      goingBack = false;
      backError = tr('mediaserver.move.backFailed', { reason: mediaErrorText(apiCode(e)) });
    }
  }

  async function saveLivetv(target: string) {
    try {
      await call(() => saveSettings({ LIVETV_RECORD_LIBRARY_JF_PATH: target }));
      toast.success(tr('mediaserver.folders.livetvSaved'));
      await load();
    } catch (e) {
      toast.error(mediaErrorText(apiCode(e)));
    }
  }

  let logOpen = false, logTrigger: HTMLElement | null = null;
  type MainAction = Exclude<ActionOp, 'backup' | 'restore'>;
  const MAIN_ACTIONS: readonly ActionOp[] = ['start', 'stop', 'restart', 'update', 'remove'];
  const ICON: Partial<Record<ActionOp, string>> = { start: 'play', stop: 'stop', restart: 'refresh', update: 'download' };
  /** the row's actions (backup and restore live with the backups) */
  $: mainActions = actions.filter((a): a is MainAction => MAIN_ACTIONS.includes(a));
</script>

<AdminCard id="settings-mediaserver" title={$t('mediaserver.title')} description={$t('mediaserver.description')}>
  {#if loadFailed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('mediaserver.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !view || starting}
    <!-- the line keeps its place while loading too: the neutral line of a starting updater moves nothing -->
    <div class="sk" aria-hidden="true"><Skeleton h="3rem" /><Skeleton h="2.4rem" /></div>
    <p class="wait" role="status" data-testid="media-starting">{#if starting}{$t('mediaserver.reason.starting')}{:else}<span class="sr-only">{$t('ui.table.loading')}</span>{/if}</p>
  {:else}
    <MediaChoice {view} {choice} canMove={api.scope === 'admin'} moveDisabled={running} on:pick={(e) => pick(e.detail)} on:move={() => openMove(false)} />

    {#if mv}
      {#if moveActive(view)}
        <div class="mvline" data-testid="media-moving">
          <p><Icon name="activity" size={18} />{$t('mediaserver.move.running')}</p>
          <Button variant="secondary" size="sm" on:click={() => openMove(true)}>{$t('mediaserver.move.show')}</Button>
        </div>
      {:else if mv.state?.phase === 'failed' && view.mode === 'external' && !mv.state.back}
        <p class="muted small mvfail">{$t('mediaserver.move.lastFailed', { reason: mediaErrorText(mv.state.error) })}</p>
      {/if}
      {#if moved && mv.migratedFrom}
        <section class="moved" data-testid="media-moved" aria-labelledby="ms-moved-t">
          <h3 id="ms-moved-t">{$t('mediaserver.move.moved', { name: mv.migratedFrom.name, date: fmtDate(mv.migratedFrom.at) })}</h3>
          {#if source}<p class="muted small">{$t(source === 'stopped' ? 'mediaserver.move.oldStopped' : source === 'running' ? 'mediaserver.move.oldRunning' : 'mediaserver.move.oldMissing')}</p>{/if}
          <div class="acts">
            <Button variant="secondary" icon="arrow-left" pending={goingBack || backActive(view) || switching} disabled={running || backActive(view)} on:click={wayBack}>{$t('mediaserver.move.wayBack')}</Button>
          </div>
          <p class="msg" class:err={backBad} role={backBad ? 'alert' : 'status'}>{backLine}</p>
        </section>
      {:else if backActive(view)}
        <p class="msg" role="status" data-testid="media-back">{backLine}</p>
      {/if}
      {#if mv.requestsWarning}
        <p class="warn" data-testid="media-requests-warning"><Icon name="alert" size={18} />{$t(view.mode === 'managed' ? 'mediaserver.move.requestsWarning' : 'mediaserver.move.requestsWarningBack')}</p>
      {/if}
    {/if}

    {#if choice === 'external'}
      <div class="ext">
        {#if view.mode === 'managed'}
          <p>{$t('mediaserver.external.idWarning')}</p>
          <div class="acts">
            <Button variant="secondary" pending={switching} disabled={running} on:click={() => toExternal(false)}>{$t('mediaserver.external.switch')}</Button>
            <!-- after a move the way back is *Zurück zu Jellyfin* (above): the stage 1 restore would skip its user repair (use_way_back) -->
            {#if view.external.url && !view.move?.migratedFrom}<Button pending={switching} disabled={running} on:click={() => toExternal(true)}>{$t('mediaserver.external.back', { address: view.external.url })}</Button>{/if}
          </div>
        {:else}
          <p class="muted">{$t('mediaserver.external.current')}</p>
          {#if actions.includes('remove')}<div class="acts"><Button variant="danger" disabled={running} on:click={() => openRemove(false)}>{$t('mediaserver.action.remove')}</Button></div>{/if}
        {/if}
      </div>
    {:else}
      {#if view.mode === 'managed' && !isCurrent}<p class="muted note">{$t('mediaserver.choice.kindChange')}</p>{/if}
      <div class="secs">
        {#key managedKind}
          <BaseFolder {api} {call} {base} inUse={Boolean(view.status?.container)} disabled={locked || running} on:changed={() => load()} on:job={(e) => started(e.detail)} on:unreadable={(e) => (baseUnreadable = e.detail)} />
          {#if base.set}
            <FolderPicker {api} {call} bind:rows libraries={isCurrent ? view.managed.libraries : []} {kept} {rowErrors} livetv={offer} disabled={locked || running}
              on:changed={() => { edited(); }} on:deleted={() => load()} on:livetv={(e) => saveLivetv(e.detail)} />

            <section class="sec" aria-labelledby="ms-user-t">
              <h3 id="ms-user-t"><Icon name="user" size={18} />{$t('mediaserver.user.title')}</h3>
              <p class="muted small">{$t('mediaserver.user.intro')}</p>
              <div class="ids">
                <Field label={$t('mediaserver.user.uid')} bind:value={uid} maxlength={5} autocomplete="off" disabled={locked || running} error={uidErr} reserve on:input={edited} />
                <Field label={$t('mediaserver.user.gid')} bind:value={gid} maxlength={5} autocomplete="off" disabled={locked || running} error={gidErr} reserve on:input={edited} />
              </div>
              {#if mediaGid === null}
                <div class="grp">
                  <Field label={$t('mediaserver.user.group')} bind:value={groupInput} maxlength={5} autocomplete="off" disabled={locked || running} hint={baseUnreadable ? $t('mediaserver.base.unreadable') : ''} />
                  <Button variant="secondary" disabled={locked || running || !groupOk} on:click={() => { mediaGid = num(groupInput); edited(); }}>{$t('mediaserver.user.addGroup', { gid: groupOk ? groupInput.trim() : '…' })}</Button>
                </div>
              {:else}
                <p class="grpset">{$t('mediaserver.user.groupSet', { gid: mediaGid })}
                  <Button variant="ghost" size="sm" disabled={locked || running} on:click={() => { mediaGid = null; edited(); }}>{$t('mediaserver.user.removeGroup')}</Button></p>
              {/if}
            </section>

            <GpuSection {api} {call} bind:gpu preselect={preselectGpu} hdr={view.status?.hdr ?? null} canTest={isCurrent && Boolean(view.status?.container) && available && !running}
              deployed={isCurrent ? view.status?.desired?.gpu ?? null : null}
              testing={acting === 'hdr-test'} disabled={locked || running} on:hdr={() => act('hdr-test')} />

            <section class="sec">
              <Toggle label={$t('mediaserver.metadata.label')} hint={$t('mediaserver.metadata.hint')} bind:checked={egress} disabled={locked || running} />
            </section>
          {/if}
        {/key}
      </div>
      <div class="apply">
        <Button class="go" icon="check" pending={applying} disabled={locked || running || !base.set} data-testid="media-apply" on:click={apply}>{firstRun ? $t('mediaserver.apply.setup') : $t('mediaserver.apply.apply')}</Button>
        <p class="msg" class:err={applyError} role={applyError ? 'alert' : 'status'} data-testid="media-apply-error">{applyError}</p>
      </div>
    {/if}

    {#if view.mode === 'managed' && (choice !== 'external' || view.status?.container)}
      {#if isCurrent && view.managed.setup !== 'none'}
        <SetupProgress managed={view.managed} busy={acting === 'retry' || removing} canRecreate={api.scope === 'admin'} on:retry={() => act('retry')} on:recreate={() => openRemove(true, true)} />
      {/if}
      <MediaStatus {view} {job} canRetry={retryable && !running} busy={applying || acting !== '' || running} canRecreate={api.scope === 'admin' && isCurrent && actions.includes('remove')}
        on:retry={(e) => retryJob(e.detail)} on:recreate={() => openRemove(false, true)} />
      <div class="acts" role="group" aria-label={$t('mediaserver.action.label')} data-testid="media-actions">
        {#each mainActions as a (a)}
          <Button variant={a === 'remove' ? 'danger' : 'secondary'} icon={ICON[a] ?? ''} pending={acting === a} disabled={running || (acting !== '' && acting !== a)} data-action={a}
            on:click={() => act(a)}>{$t(`mediaserver.action.${a}`)}</Button>
        {/each}
        {#if api.scope === 'admin' && view.status?.container}
          <Button variant="secondary" icon="list" on:click={(e) => { logTrigger = e.currentTarget as HTMLElement; logOpen = true; }}>{$t('mediaserver.action.logs')}</Button>
        {/if}
      </div>
      <p class="msg" class:err={actionError} role={actionError ? 'alert' : 'status'}>{actionError}</p>
      {#if isCurrent || view.status?.backups.length}
        <BackupDialogs {api} {call} {view} {actions} busy={running} on:job={(e) => started(e.detail)} on:changed={() => load()} />
      {/if}
    {/if}
  {/if}
</AdminCard>

{#if moveOpen && view}
  <MoveSheet {api} {call} {view} follow={moveWatch} trigger={moveTrigger} on:close={() => { moveOpen = false; refresh(); }} on:changed={refresh} on:started={(e) => started(e.detail)} />
{/if}

{#if logOpen}<LogDialog {api} {call} trigger={logTrigger} on:close={() => (logOpen = false)} />{/if}

{#if removeOpen}
  <ModalShell bind:this={removeShell} role="alertdialog" labelledby="ms-rm-t" describedby="ms-rm-d" focus=".dlg-acts button" trigger={removeTrigger} locked={removing} on:close={() => (removeOpen = false)}>
    <form novalidate on:submit|preventDefault={remove}>
      <h2 id="ms-rm-t" class="dlg-title">{$t('mediaserver.remove.title')}</h2>
      <div class="dlg-main">
        <p id="ms-rm-d" class="dlg-body">{view?.mode === 'managed' ? $t('mediaserver.remove.body') : $t('mediaserver.remove.leftover')}</p>
        <div class="rm-data">
          <Toggle label={$t('mediaserver.remove.data')} hint={$t('mediaserver.remove.dataHint')} bind:checked={removeData} disabled={removing} />
          <!-- the typed confirmation's place is kept while the switch is off: the dialog never changes height -->
          <div class="typed" class:off={!removeData} aria-hidden={removeData ? undefined : 'true'}>
            <Field label={$t('mediaserver.remove.typed', { name: kindName(removeKind) })} bind:value={removeTyped} autocomplete="off" disabled={!removeData || removing} />
          </div>
        </div>
      </div>
      <p class="dlg-err" role={removeError ? 'alert' : undefined}>{removeError}</p>
      <div class="dlg-acts">
        <Button variant="glass" disabled={removing} on:click={() => removeShell.dismiss()}>{$t('common.cancel')}</Button>
        <Button type="submit" variant="danger" pending={removing} disabled={!removeReady}>{$t('mediaserver.remove.confirm')}</Button>
      </div>
    </form>
  </ModalShell>
{/if}

<style>
  .sk { display: grid; gap: 1rem; }
  .wait { margin: .6rem 0 0; min-height: 1.5em; font-size: .9rem; color: var(--mut); }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 1.4rem 1rem; }
  .state p { margin: 0; }
  .state :global(svg) { color: var(--err); }
  .note { margin: 0 0 .6rem; font-size: .9rem; }
  .ext { display: grid; gap: .6rem; }
  .ext p { margin: 0; }
  .secs { display: grid; gap: 1.2rem; }
  .sec { display: grid; gap: .5rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .secs > :global(section:first-child) { padding-top: 0; }
  .secs > :global(section + section) { padding-top: 1rem; border-top: 1px solid var(--line); }
  .sec h3 { display: flex; align-items: center; gap: .45rem; margin: 0; font-size: 1rem; }
  .small { font-size: .88rem; margin: 0; }
  .ids { display: grid; grid-template-columns: repeat(2, minmax(0, 10rem)); gap: .6rem; }
  .grp { display: grid; grid-template-columns: minmax(0, 14rem) auto; align-items: end; gap: .6rem; }
  .grpset { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .8rem; margin: 0; }
  /* one width for *Einrichten* and *Übernehmen*: the label switching at the end of the first run moves nothing */
  .apply :global(.go) { min-width: 11rem; }
  .apply { display: grid; gap: .3rem; justify-items: start; margin-top: 1.2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .acts { display: flex; flex-wrap: wrap; gap: .5rem; }
  .msg { margin: 0; min-height: 2.6em; font-size: .9rem; color: var(--mut); }
  .msg.err { color: var(--err-mark); }
  .apply ~ :global(.sp), .apply ~ :global(section) { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .mvline { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem .8rem; margin: 0 0 .8rem; padding: .5rem .8rem;
    border-radius: var(--fr-r-card); background: rgba(var(--acc-rgb), .1); }
  .mvline p { display: flex; align-items: center; gap: .45rem; margin: 0; }
  .mvfail { margin: 0 0 .8rem; }
  .moved { display: grid; gap: .4rem; margin: 0 0 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .moved h3 { margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
  .moved p { margin: 0; }
  .warn { display: flex; align-items: flex-start; gap: .45rem; margin: 0 0 1rem; padding: .6rem .8rem; border-radius: var(--fr-r-card); border: 1px solid var(--line);
    background: rgba(255, 255, 255, .04); font-size: .9rem; overflow-wrap: anywhere; }
  .warn :global(svg) { flex: none; margin-top: .1rem; color: var(--warn); }
  .rm-data { display: grid; gap: .5rem; margin-top: 12px; }
  .typed { transition: opacity .2s ease; }
  .typed.off { opacity: .35; }
  @media (max-width: 420px) { .grp { grid-template-columns: minmax(0, 1fr); } }
  @media (prefers-reduced-motion: reduce) { .typed { transition: none; } }
</style>
