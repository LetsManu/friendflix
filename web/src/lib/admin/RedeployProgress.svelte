<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * An update handed to Portainer (lib/admin/updater.ts Redeploy): the phase as steps (Portainer pulls the images → recreate
   * containers, with how many services already run the new build → health check), the elapsed time while it runs, and the
   * outcome once it ended (done, nothing recreated, refused with the HTTP status and step, no change in 15 minutes).
   */
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, t } from '#lib/i18n';
  import Progress from '#lib/ui/Progress.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { REDEPLOY_STEPS, redeployResult, redeploySteps, type Redeploy, type StepState } from './updater';

  export let redeploy: Redeploy;
  /** seconds since the start, while it runs */
  export let elapsed = 0;
  export let reconnecting = false;

  $: steps = redeploySteps(redeploy);
  $: ok = redeploy.phase === 'done';
  // $t: re-rendered on a language switch
  $: result = redeploy.running ? '' : (void $t, redeployResult(redeploy));
  const tone = (st: StepState) => (st === 'ok' ? 'ok' : st === 'failed' ? 'err' : st === 'running' ? 'warn' : 'muted');
</script>

<div class="redeploy" data-redeploy={redeploy.phase} aria-live="polite">
  {#if redeploy.running}
    <Progress value={null} label={$t('admin.update.updater.redeploy.running', { s: elapsed })} />
    {#if reconnecting}<p class="muted small" role="status" data-reconnecting><Icon name="refresh" size={16} /> {$t('admin.update.updater.reconnecting')}</p>{/if}
  {:else}
    <p class="small"><span class="muted">{$t('admin.update.updater.redeploy.last')}</span> <time datetime={redeploy.finishedAt ?? redeploy.startedAt}>{fmtDateTime(redeploy.finishedAt ?? redeploy.startedAt)}</time></p>
    <p class="result" class:ok class:bad={!ok} role={ok ? 'status' : 'alert'} data-result={redeploy.phase}>
      <Icon name={ok ? 'check' : 'alert'} size={18} /> {result}
    </p>
  {/if}
  <ol class="steps">
    {#each REDEPLOY_STEPS as st (st)}
      <li data-step={st} data-state={steps[st]} aria-current={steps[st] === 'running' ? 'step' : undefined}>
        <span class="name">{$t(`admin.update.updater.redeploy.step.${st}` as 'admin.update.updater.redeploy.step.pulling')}{#if st === 'recreating' && redeploy.services && steps[st] !== 'skipped'}<span class="muted count" data-count> · {$t('admin.update.updater.redeploy.count', { n: redeploy.services.updated, total: redeploy.services.total })}</span>{/if}</span>
        <StatusPill tone={tone(steps[st])} label={$t(`admin.update.updater.state.${steps[st]}` as 'admin.update.updater.state.ok')} />
      </li>
    {/each}
  </ol>
</div>

<style>
  .redeploy { display: grid; gap: .8rem; min-width: 0; }
  .small { font-size: .88rem; margin: 0; }
  .result { display: flex; gap: .5rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; }
  .result.ok :global(svg) { color: var(--ok); } .result.bad :global(svg) { color: var(--err); }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  .steps li { display: flex; align-items: center; justify-content: space-between; gap: .7rem; flex-wrap: wrap; min-width: 0; }
  .steps li[aria-current='step'] .name { font-weight: 600; }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .count { font-weight: 400; }
</style>
