<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Status* of the managed media server: the container's state and health, the kind and its upstream version, the image against this
   * build's pin (model.ts pinState: "neuer als dieser FriendFlix-Stand" after a FriendFlix rollback), a tampered container, the
   * last error, and the last media job with its steps (JobSteps.svelte: steps.ts lists a media job's steps and keeps its rollback's
   * slot). A failed job offers *Erneut versuchen*, a tampered container *Neu anlegen*. The result line keeps its room while the job runs.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import JobSteps from '../JobSteps.svelte';
  import { mediaActionLabel, type UpdaterJob } from '../updater';
  import type { MediaView } from './api';
  import { kindName, mediaErrorText, pinState } from './model';

  export let view: MediaView;
  export let job: UpdaterJob | null = null;
  /** *Erneut versuchen* is offered for a failed job */
  export let canRetry = false;
  export let busy = false;
  /** *Neu anlegen* for a container changed outside FriendFlix (the wizard has no remove) */
  export let canRecreate = false;
  const dispatch = createEventDispatcher<{ retry: UpdaterJob; recreate: void }>();

  const STATES = ['running', 'exited', 'created', 'restarting', 'paused', 'dead'] as const;
  const known = (s: string): s is (typeof STATES)[number] => (STATES as readonly string[]).includes(s);
  $: c = view.status?.container ?? null;
  $: pin = pinState(view);
  const stateOf = (state: string | undefined): (typeof STATES)[number] | 'unknown' => (state && known(state) ? state : 'unknown');
  $: stateKey = stateOf(c?.state);
  $: running = job?.state === 'running';
  $: failed = Boolean(job && !running && job.state !== 'succeeded');
  $: jobText = !job ? '' : running ? $t('mediaserver.status.job.running')
    : job.state === 'succeeded' ? $t('mediaserver.status.job.succeeded')
      : $t(job.state === 'rolled_back' ? 'mediaserver.status.job.rolled_back' : 'mediaserver.status.job.failed', { reason: mediaErrorText(job.error) });
</script>

<section class="sec" aria-labelledby="ms-status-t" data-testid="media-status">
  <h3 id="ms-status-t"><Icon name="activity" size={18} />{$t('mediaserver.status.title')}</h3>
  {#if c}
    <dl>
      <div><dt>{$t('mediaserver.status.state')}</dt><dd data-state={c.state}>{$t(`mediaserver.status.states.${stateKey}`)}</dd></div>
      <div><dt>{$t('mediaserver.status.health')}</dt><dd>{$t(`mediaserver.status.healths.${c.health || 'none'}`)}</dd></div>
      <div><dt>{$t('mediaserver.status.server')}</dt><dd>{$t('mediaserver.status.serverValue', { kind: kindName(c.kind), version: c.image.upstream })}</dd></div>
      <div><dt>{$t('mediaserver.status.image')}</dt><dd data-pin={pin} class:newer={pin === 'newer'}>{$t(`mediaserver.status.pin.${pin}`, { version: view.status?.pin?.upstream ?? '' })}</dd></div>
    </dl>
    {#if c.tampered}
      <p class="warn"><Icon name="alert" size={16} />{$t('mediaserver.status.tampered')}</p>
      {#if canRecreate}<div><Button variant="secondary" size="sm" disabled={busy} on:click={() => dispatch('recreate')}>{$t('mediaserver.status.recreate')}</Button></div>{/if}
    {/if}
  {:else}
    <p class="muted small">{$t('mediaserver.status.none')}</p>
  {/if}
  {#if view.status?.error}<p class="muted small">{$t('mediaserver.status.error', { reason: mediaErrorText(view.status.error) })}</p>{/if}
  {#if job}
    <div class="job" data-testid="media-job" data-job={job.action} data-job-state={job.state}>
      <h4>{$t('mediaserver.status.lastJob', { action: mediaActionLabel(job.action as Parameters<typeof mediaActionLabel>[0]) })}</h4>
      <JobSteps {job} />
      <p class="res" class:bad={failed} role={failed ? 'alert' : 'status'}>{jobText}</p>
      <div class="acts">{#if failed && canRetry}<Button variant="secondary" size="sm" icon="refresh" pending={busy} on:click={() => job && dispatch('retry', job)}>{$t('mediaserver.status.retry')}</Button>{/if}</div>
    </div>
  {/if}
</section>

<style>
  .sec { display: grid; gap: .5rem; }
  h3 { display: flex; align-items: center; gap: .45rem; margin: 0; font-size: 1rem; }
  h4 { margin: 0; font-size: .92rem; }
  .small { font-size: .88rem; margin: 0; }
  dl { margin: 0; display: grid; gap: .1rem; }
  dl div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .2rem .8rem; padding: .3rem 0; border-top: 1px solid var(--line); }
  dl div:first-child { border-top: 0; }
  dt, dd { margin: 0; min-width: 0; }
  dt { color: var(--mut); }
  dd { font-weight: 600; overflow-wrap: anywhere; }
  .newer { color: var(--warn); }
  .warn { display: flex; align-items: center; gap: .4rem; margin: 0; color: var(--warn); font-size: .9rem; }
  .job { display: grid; gap: .4rem; padding-top: .4rem; border-top: 1px solid var(--line); }
  .res { margin: 0; min-height: 2.6em; font-size: .9rem; color: var(--mut); }
  .res.bad { color: var(--fg); }
  .acts { min-height: 44px; display: flex; align-items: center; }
</style>
