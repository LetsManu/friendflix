<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The installed view of Admin → Live-TV until the full area arrives (Task 26): the version, the GPU advice (spec §4.4; no advice
   * = no line, never "CPU only"), the outcome of the speed measurement started on enabling, and "Live-TV ausschalten …".
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import JobSteps from '../JobSteps.svelte';
  import UpdaterNotes from './UpdaterNotes.svelte';
  import { errorKey, gpuKey, jobRunning, livetvJob, livetvRunning, livetvSteps, otherJobRunning, type LivetvAdminState } from './state';

  export let s: LivetvAdminState;
  /** a disable finished and detection has not caught up yet: never "läuft", the page keeps asking (1b review I4) */
  export let stopping = false;
  /** the dialog grows out of the button that was pressed */
  const dispatch = createEventDispatcher<{ off: HTMLElement | null }>();

  $: job = livetvJob(s);
  $: running = livetvRunning(s);
  $: busy = jobRunning(s);
  $: other = otherJobRunning(s);
  $: gpu = gpuKey(s.gpu.advice);
  $: gpuIcon = s.gpu.advice?.level === 'warn' ? 'alert' : s.gpu.advice?.level === 'ok' ? 'check' : 'info';
  $: failed = job && job.state !== 'running' && job.state !== 'succeeded' ? job : null;
  $: bench = s.benchmark;
</script>

<AdminCard title={$t('adminLive.mini.title')}>
  {#if stopping}
    <div class="prog" aria-live="polite" data-stopping><Progress value={null} label={$t('adminLive.mini.working')} /></div>
  {:else}
    <p class="ok" role="status"><Icon name="check" size={18} />{$t('adminLive.mini.running')}</p>
  {/if}
  <dl class="ver"><div><dt>{$t('adminLive.mini.version')}</dt><dd><code>{s.version ?? '–'}</code></dd></div></dl>

  <UpdaterNotes {s} />

  {#if gpu}
    <p class="note" data-gpu={s.gpu.advice?.key} data-level={s.gpu.advice?.level}>
      <Icon name={gpuIcon} size={18} /><span><Rich key={`adminLive.gpu.${gpu}` as 'adminLive.gpu.both'} params={{ driver: s.gpu.advice?.driver }} /></span>
    </p>
  {/if}

  {#if bench}
    <p class="note" data-bench={bench}>
      <Icon name={bench === 'started' ? 'check' : 'info'} size={18} />
      <span>{$t(`adminLive.bench.${bench}` as 'adminLive.bench.started')}{#if bench !== 'started'} {$t('adminLive.bench.later')} <a href="/admin/playback">{$t('adminLive.bench.link')}</a>{/if}</span>
    </p>
  {/if}

  {#if running && job}
    <div class="prog" aria-live="polite">
      <Progress value={null} label={$t('adminLive.mini.working')} />
      <JobSteps {job} steps={livetvSteps(job)} />
    </div>
  {/if}
  <div class="slot">
    {#if failed}<p class="note err" role="alert" data-result={failed.state}><Icon name="alert" size={18} /><span>{$t(`adminLive.err.${errorKey(failed.error)}` as 'adminLive.err.generic')}</span></p>{/if}
  </div>

  <div class="row">
    <Button variant="secondary" icon="x" disabled={busy || stopping} on:click={(e) => dispatch('off', e.currentTarget instanceof HTMLElement ? e.currentTarget : null)}>{$t('adminLive.status.off')}</Button>
    {#if other}<span class="muted small" role="status" data-other-job><Icon name="clock" size={16} /> {$t('adminLive.err.updaterBusy')}</span>{/if}
  </div>
</AdminCard>

<style>
  .ok { display: flex; gap: .5rem; align-items: center; margin: 0 0 .8rem; font-weight: 600; }
  .ok :global(svg) { color: var(--ok); }
  .ver { margin: 0 0 .8rem; }
  .ver > div { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: .6rem; align-items: center; }
  dt { color: var(--mut); font-size: .9rem; } dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.07); padding: .05rem .4rem; border-radius: 4px; }
  .note { display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 .8rem; padding: .6rem .8rem; border-radius: 8px; background: rgba(255,255,255,.05); overflow-wrap: anywhere; min-width: 0; }
  .note :global(svg) { flex: none; margin-top: .1rem; }
  .note.err :global(svg) { color: var(--err); }
  .note :global(kbd) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .prog { display: grid; gap: .8rem; max-width: 36rem; min-width: 0; margin: 0 0 .8rem; }
  .slot { min-height: 0; }
  .row { display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; }
  .small { font-size: .88rem; }
  @media (max-width: 560px) { .ver > div { grid-template-columns: minmax(0, 1fr); gap: .2rem; } }
</style>
