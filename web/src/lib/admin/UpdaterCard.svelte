<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Update with the updater (lib/admin/updater.ts): what is installed (the build the backend runs, then one row per
   * service: its commit and "Update verfügbar" / "unverändert", after a job its report; fixed row heights, so nothing moves while
   * values come or change), the previous build and the target, "Update now", "Back to previous version", "Update the updater"
   * (inline confirmation, no dialog), the last activity as the animated step list (StepList.svelte, lib/admin/steps.ts) and the automatic updates. The last activity is whatever runs,
   * else the newer of the last update job and the last Portainer redeploy (shownActivity: on a Portainer stack an old updater job
   * is not shown, a Live TV job never). A job restarts the backend: failed polls show "reconnecting" and the page picks the result
   * up when it answers again (also after a reload: the updater keeps the last job, the backend the redeploy record). While Portainer
   * recreates the updater too, the last status stays (mergeView). An admin session is enough to start a job or to change the
   * automatic updates (no second sign-in). A Portainer stack (status.stack foreign) is never recreated by the updater: a note up
   * front, "Update now" goes through Portainer when it is set up (the Portainer API set up only in part: which settings are missing).
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { saveSettings } from '#lib/admin/settings/api';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Halo from './Halo.svelte';
  import StepList from './StepList.svelte';
  import { jobFlow, redeployFlow } from './steps';
  import { watcher } from './watch';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import {
    TIME_RE, canRollback, foreignMode, foreignText, installedOf, mediaPhaseMemo, isRunning, mergeView, portainerMissing, previousText, redeployRunning, rollbackConfirm, serviceRows, shownActivity,
    startError, statusOf, tagText,
    type UpdaterAction, type UpdaterJob, type UpdaterView,
  } from './updater';

  export let view: UpdaterView;
  const dispatch = createEventDispatcher<{ finished: void }>();

  $: s = statusOf(view);
  /** any job of the updater runs (also one of Live TV's): nothing else can start */
  $: running = isRunning(s?.job);
  /** Portainer's stack: "portainer" = the update goes through Portainer, "manual" = nothing to start here */
  $: foreign = foreignMode(view);
  // $t: re-rendered on a language switch
  $: foreignNote = foreign ? (void $t, foreignText(foreign, s)) : '';
  $: missingNote = (void $t, portainerMissing(view.portainer));
  /** the last update handed to Portainer; running: followed like a job */
  $: redeploy = view.redeploy ?? null;
  $: redeploying = redeployRunning(view);
  $: shown = shownActivity(s, redeploy, foreign !== null);
  $: installed = (void $t, installedOf(s));
  $: svc = (void $t, serviceRows(s));
  $: prev = s ? (void $t, previousText(s)) : null;
  let confirming: UpdaterAction | null = null;
  /** a poll failed (the backend restarts), or the updater is away while Portainer recreates it */
  let reconnecting = false, watchTimeout = false, away = false;
  let now = Date.now();
  let watchedId: string | null = null;
  /** a redeploy this page started or found running: the page reloads its data once it ended */
  let watchedRedeploy: string | null = null;
  /** whether an update lists its media server phase: decided once per job, never from poll to poll */
  const mediaPhase = mediaPhaseMemo();
  $: flow = (void $t, shown === 'job' && s?.job ? jobFlow(s.job, { reconnecting, now, mediaPhase: mediaPhase(s.job, s) }) : shown === 'redeploy' && redeploy ? redeployFlow(redeploy, { reconnecting, now }) : null);

  async function refresh(signal?: AbortSignal): Promise<boolean> {
    try {
      const m = mergeView(view, await api<UpdaterView>('/api/admin/updater', { signal }));
      view = m.view; away = m.away;
      return true;
    } catch { return false; }
  }
  /** polls while the job or the redeploy runs; a failed poll (the backend restarts) is "reconnecting", never an error */
  const w = watcher({
    poll: refresh,
    busy: () => isRunning(statusOf(view)?.job) || redeployRunning(view),
    tick: (ok) => { now = Date.now(); reconnecting = !ok || away; },
    done: () => {
      reconnecting = false;
      const j = statusOf(view)?.job;
      if ((watchedId && j?.id === watchedId) || (watchedRedeploy && view.redeploy?.id === watchedRedeploy)) dispatch('finished');
      watchedId = null; watchedRedeploy = null;
    },
    timeout: () => { watchTimeout = true; reconnecting = false; },
  });
  function watch() { watchTimeout = false; w.start(); }
  onMount(() => {
    if (running) watchedId = s?.job?.id ?? null;
    if (redeploying) watchedRedeploy = view.redeploy?.id ?? null;
    if (running || redeploying) watch();
  });
  onDestroy(w.stop);
  const clock = setInterval(() => { if (w.running) now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(clock));

  async function start(action: UpdaterAction) {
    confirming = null;
    const res = await runAction({ key: `updater:${action}`, run: () => api<{ job: UpdaterJob } | { portainer: { mode: string } }>(`/api/admin/updater/${action}`, { method: 'POST' }), error: false });
    if (res.ok && res.value && 'portainer' in res.value) {
      // a Portainer stack: Portainer redeploys it; the backend records the redeploy, the page follows its phases
      toast.success(tr('admin.update.updater.foreign.started'));
      await refresh();
      watchedRedeploy = view.redeploy?.id ?? null;
      watch();
      return;
    }
    if (res.ok && res.value && 'job' in res.value) {
      const started = res.value.job;
      watchedId = started.id;
      if (s) view = { ...view, present: true, status: { ...s, busy: true, job: started } } as UpdaterView;
      watch();
      return;
    }
    toast.error(startError(res.error));
    // a refusal Portainer gave is recorded too: show it with its step
    if (foreign === 'portainer') await refresh();
  }
  /** "try again" on a failed outcome: the same confirmation as the button (a failed rollback asks for the rollback again) */
  function retry() {
    const a = shown === 'job' && s?.job && (s.job.action === 'rollback' || s.job.action === 'self-update') ? s.job.action : 'update';
    confirming = a;
  }

  /** "update" through Portainer asks about a Portainer redeploy, not about the updater's tag */
  const confirmKey = (a: UpdaterAction, f: typeof foreign) =>
    (a === 'update' && f === 'portainer' ? 'admin.update.updater.confirm.updatePortainer' : `admin.update.updater.confirm.${a}`) as 'admin.update.updater.confirm.update';
  /** the confirmation's question (an update names the target tag; a rollback the sha tag, or the images before the last update) */
  $: confirmText = (a: UpdaterAction, f: typeof foreign): string => (void $t, a === 'rollback' ? rollbackConfirm(s) : $t(confirmKey(a, f), { tag: s?.targetTag ?? '' }));

  // automatic updates (settings AUTO_UPDATE / AUTO_UPDATE_TIME)
  let autoMode = view.autoUpdate?.mode ?? 'off', autoTime = view.autoUpdate?.time ?? '04:00', autoErr = '';
  $: autoLocked = (view.autoUpdate?.locked ?? []).length > 0;
  $: autoOptions = [{ value: 'off', label: $t('admin.update.updater.auto.off') }, { value: 'nightly-window', label: $t('admin.update.updater.auto.window') }];
  async function saveAuto() {
    autoErr = '';
    if (autoMode === 'nightly-window' && !TIME_RE.test(autoTime)) { autoErr = tr('admin.update.updater.auto.timeInvalid'); return; }
    const r = await runAction({ key: 'updater:auto', run: () => saveSettings({ AUTO_UPDATE: autoMode, AUTO_UPDATE_TIME: autoTime }), success: tr('admin.update.updater.auto.saved'), error: (e) => errorText(e) });
    if (r.ok) await refresh();
  }
</script>

<AdminCard title={$t('admin.update.updater.title')}>
  <p class="muted intro">{$t('admin.update.updater.intro')}</p>

  {#if view.present && 'error' in view}
    <p class="banner warn" role="alert"><Icon name="alert" size={18} />{view.error === 'unauthorized' ? $t('admin.update.updater.unauthorized') : $t('admin.update.updater.invalid')}</p>
  {:else if s}
    {#if foreign}
      <p class="banner" class:warn={foreign !== 'portainer'} role={foreign !== 'portainer' ? 'alert' : 'note'} data-foreign={foreign}>
        <Icon name={foreign !== 'portainer' ? 'alert' : 'info'} size={18} />{foreignNote}
      </p>
    {/if}
    {#if missingNote}
      <p class="banner warn" role="alert" data-portainer-missing><Icon name="alert" size={18} />{missingNote}</p>
    {/if}
    <!-- installed: what the backend runs (not the updater's record of a moving tag); the previous build only where a rollback can use it -->
    <dl class="ver" data-updater>
      <div class:top={svc.rows.length > 0}><dt>{$t('admin.update.updater.installed')}</dt><dd data-installed>
        {#if installed}{#if installed.version}<span class="v">{installed.version}</span>{' '}{/if}<code>{installed.tag}</code>{#if tagText(installed.tag)}{' '}<span class="muted">({tagText(installed.tag)})</span>{/if}
        {:else}<code>{$t('admin.update.updater.none')}</code>{/if}
        {#if svc.rows.length}
          <!-- one row per service, each the same height whether its status is known yet or not; "alles unverändert" spans the job's rows -->
          <table class="svcs" data-services>
            <tbody>
              {#each svc.rows as r, i (r.service)}
                <tr data-service={r.service} data-mark={r.mark ?? undefined}>
                  <th scope="row">{r.service}</th>
                  <td><code>{r.commit ?? '–'}</code></td>
                  {#if svc.span && i === 0}<td class="st all" rowspan={svc.span} data-all>{svc.all}</td>
                  {:else if i >= svc.span}<td class="st" class:avail={r.mark === 'changed'}>{r.text}</td>{/if}
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}</dd></div>
      {#if !foreign && prev}<div><dt>{$t('admin.update.updater.previous')}</dt><dd data-previous>{#if prev.code}<code>{prev.text}</code>{:else}{prev.text}{/if}</dd></div>{/if}
      <div><dt>{$t('admin.update.updater.target')}</dt><dd data-target>{#if tagText(s.targetTag)}<span class="v">{tagText(s.targetTag)}</span>{' '}{/if}<code>{s.targetTag ?? $t('admin.update.updater.none')}</code></dd></div>
    </dl>

    {#if confirming}
      <div class="confirm" role="group" aria-label={confirmText(confirming, foreign)}>
        <p>{confirmText(confirming, foreign)}</p>
        <div class="row">
          <Button variant={confirming === 'self-update' ? 'primary' : 'danger'} icon="check" on:click={() => confirming && start(confirming)}>{$t('admin.update.updater.confirmGo')}</Button>
          <Button variant="secondary" on:click={() => (confirming = null)}>{$t('admin.update.updater.cancel')}</Button>
        </div>
      </div>
    {:else}
      <div class="row actions">
        <Halo live={running || redeploying}><Button icon="download" pending={$busyKeys.has('updater:update') || running || redeploying} disabled={running || redeploying || s.busy || !s.targetTag || (foreign !== null && foreign !== 'portainer')} on:click={() => (confirming = 'update')}>{$t('admin.update.updater.updateNow')}</Button></Halo>
        <Button variant="secondary" icon="arrow-left" pending={$busyKeys.has('updater:rollback')} disabled={!canRollback(s) || foreign !== null} on:click={() => (confirming = 'rollback')}>{$t('admin.update.updater.rollback')}</Button>
      </div>
    {/if}

    {#if running && shown !== 'job'}
      <!-- another job of the updater runs (Live TV's): it is shown on its own page, the buttons wait for it -->
      <p class="muted small busy" role="status" data-busy>{$t('admin.update.updater.error.busy')}</p>
    {/if}
    {#if flow}
      <div class="prog" data-redeploy={shown === 'redeploy' && redeploy ? redeploy.phase : undefined} data-job={shown === 'job' ? s.job?.state : undefined}>
        {#key shown === 'redeploy' ? redeploy?.id : s.job?.id}
          <StepList {flow} title={shown === 'redeploy' ? $t('admin.update.updater.redeploy.title') : ''} on:retry={retry} />
        {/key}
        {#if watchTimeout}
          <p class="err small" role="alert">{$t('admin.update.updater.watchTimeout')}</p>
          <Button variant="secondary" icon="refresh" on:click={() => { void refresh().then(() => { if (isRunning(statusOf(view)?.job) || redeployRunning(view)) watch(); else watchTimeout = false; }); }}>{$t('admin.update.check')}</Button>
        {/if}
      </div>
    {/if}

    {#if s.log.length}
      <details class="log"><summary>{$t('admin.update.updater.log')}</summary><pre>{s.log.join('\n')}</pre></details>
    {/if}

    <div class="auto">
      <h3>{$t('admin.update.updater.auto.title')}</h3>
      <p class="muted small">{$t('admin.update.updater.auto.hint')}</p>
      <div class="row">
        <Select label={$t('admin.update.updater.auto.label')} bind:value={autoMode} options={autoOptions} disabled={autoLocked} />
        {#if autoMode === 'nightly-window'}<Field label={$t('admin.update.updater.auto.time')} type="time" bind:value={autoTime} disabled={autoLocked} error={autoErr} width="8rem" />{/if}
        <Button variant="secondary" pending={$busyKeys.has('updater:auto')} disabled={autoLocked} on:click={saveAuto}>{$t('admin.update.updater.auto.save')}</Button>
      </div>
      {#if autoLocked}<p class="muted small" role="note">{$t('admin.update.updater.auto.locked')}</p>{/if}
    </div>

    <details class="self">
      <summary>{$t('admin.update.updater.advanced')}</summary>
      <p class="muted small">{$t('admin.update.updater.selfHint', { version: s.updater.version ?? $t('admin.update.updater.none') })}</p>
      <Button variant="secondary" icon="refresh" pending={$busyKeys.has('updater:self-update')} disabled={running || s.busy || confirming !== null || foreign !== null} on:click={() => (confirming = 'self-update')}>{$t('admin.update.updater.selfUpdate')}</Button>
    </details>
  {/if}
</AdminCard>

<style>
  .intro { margin: 0 0 1rem; max-width: 70ch; }
  .ver { margin: 0 0 1rem; display: grid; gap: .5rem; }
  .ver > div { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: .6rem; align-items: center; }
  .ver > div.top { align-items: start; }
  dt { color: var(--mut); font-size: .9rem; } dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.07); padding: .05rem .4rem; border-radius: 4px; }
  .row { display: flex; flex-wrap: wrap; gap: .8rem; align-items: flex-end; min-width: 0; }
  .confirm { border: 1px solid var(--warn); border-radius: 8px; padding: .8rem 1rem; display: grid; gap: .6rem; max-width: 40rem; }
  .confirm p { margin: 0; overflow-wrap: anywhere; }
  .prog { margin-top: 1.2rem; display: grid; gap: .8rem; max-width: 40rem; min-width: 0; }
  .v { font-weight: 600; }
  .small { font-size: .88rem; margin: 0; }
  .busy { margin-top: 1rem; }
  .err { color: var(--err); }
  .log { margin-top: 1rem; } .log summary, .self summary { cursor: pointer; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
  .log pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8rem; max-height: 16rem; overflow: auto; margin: 0; }
  .auto { margin-top: 1.2rem; border-top: 1px solid var(--line); padding-top: .9rem; display: grid; gap: .6rem; }
  .auto h3 { margin: 0; font-size: 1rem; }
  .self { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: .4rem; display: grid; gap: .6rem; }
  .banner { display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 1rem; padding: .6rem .8rem; border-radius: 8px; background: rgba(255,255,255,.05); overflow-wrap: anywhere; }
  .banner.warn { border: 1px solid var(--warn); }
  /* fixed row heights: a status that arrives or changes (a slow registry, the job's report) never moves anything */
  .svcs { margin-top: .4rem; border-collapse: collapse; font-size: .88rem; }
  .svcs tr { height: 1.9rem; }
  .svcs th, .svcs td { padding: 0 .9rem 0 0; text-align: left; vertical-align: middle; line-height: 1.2; }
  .svcs th { font-weight: 400; color: var(--mut); }
  .svcs .st { padding-right: 0; overflow-wrap: anywhere; }
  .svcs .avail { color: var(--fg); font-weight: 600; }
  @media (max-width: 560px) {
    .ver > div { grid-template-columns: minmax(0, 1fr); gap: .2rem; }
    /* room for a status on two lines (the longer languages) */
    .svcs tr { height: 2.7rem; }
  }
</style>
