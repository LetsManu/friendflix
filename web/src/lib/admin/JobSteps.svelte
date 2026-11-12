<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** The step list of an updater job (pull → verify → restart → health, rollback when it ran), shared by Admin → Update and Admin → Live-TV. */
  import { t } from '#lib/i18n';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { visibleSteps, type StepName, type StepState, type UpdaterJob } from './updater';

  export let job: Pick<UpdaterJob, 'state' | 'step' | 'steps'> & { action: string };
  /** which steps to list; default: the update's (visibleSteps) */
  export let steps: StepName[] | null = null;
  $: running = job.state === 'running';
  $: list = steps ?? visibleSteps(job as UpdaterJob);
  const stepTone = (st: StepState) => (st === 'ok' ? 'ok' : st === 'failed' ? 'err' : st === 'running' ? 'warn' : 'muted');
</script>

<ol class="steps">
  {#each list as st (st)}
    <li data-step={st} data-state={job.steps[st]} aria-current={job.step === st && running ? 'step' : undefined}>
      <span class="name">{$t(`admin.update.updater.step.${st}` as 'admin.update.updater.step.pull')}</span>
      <StatusPill tone={stepTone(job.steps[st])} label={$t(`admin.update.updater.state.${job.steps[st]}` as 'admin.update.updater.state.ok')} />
    </li>
  {/each}
</ol>

<style>
  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  .steps li { display: flex; align-items: center; justify-content: space-between; gap: .7rem; flex-wrap: wrap; min-width: 0; }
  .steps li[aria-current='step'] .name { font-weight: 600; }
</style>
