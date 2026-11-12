<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The optional Live-TV entry before installation (spec §4.3, §4.5): what it is, what it needs, and how to turn it on: the button
   * (updater, own stack), the .env line with a copy button (no updater), or the Portainer line (foreign stack). While a job runs the
   * card shows its steps. A refused request says so and nothing is claimed as turned on. The message slot keeps its space, so the
   * card does not jump when a result appears.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Button from '#lib/ui/Button.svelte';
  import CopyField from '#lib/ui/CopyField.svelte';
  import JobSteps from '../JobSteps.svelte';
  import UpdaterNotes from './UpdaterNotes.svelte';
  import { errorKey, livetvJob, livetvSteps, otherJobRunning, type EnableMode, type LivetvAdminState, type Phase } from './state';

  export let s: LivetvAdminState;
  export let mode: EnableMode;
  export let phase: Phase;
  export let pending = false;
  /** the key of a refused request's message (adminLive.err.<key>), '' = none */
  export let refused = '';
  export let hiding = false;
  export let hideError = false;
  const dispatch = createEventDispatcher<{ enable: void; hide: void }>();

  $: job = livetvJob(s);
  $: working = phase === 'working' || phase === 'settling';
  $: ended = job && job.state !== 'running' ? job : null;
  /** why it is not there although a job ran or an update dropped it */
  $: reason = (c: string | null) => $t(`adminLive.err.${errorKey(c)}` as 'adminLive.err.generic');
  $: otherJob = otherJobRunning(s);
  $: resultText = ended && ended.state === 'rolled_back' ? $t('adminLive.err.rolled_back', { reason: reason(ended.error) })
    : ended && ended.state === 'failed' ? reason(ended.error) : '';
</script>

<AdminCard title={$t('adminLive.offer.title')}>
  <p class="what">{$t('adminLive.offer.body')}</p>
  <p class="muted needs">{$t('adminLive.offer.needs')}</p>

  {#if working && job && mode === 'updater'}
    <div class="prog" aria-live="polite">
      <Progress value={null} label={$t(phase === 'settling' ? 'adminLive.offer.checking' : 'adminLive.offer.working')} />
      <JobSteps {job} steps={livetvSteps(job)} />
    </div>
  {:else if phase === 'settling'}
    <p class="muted" role="status"><Icon name="refresh" size={16} /> {$t('adminLive.offer.checking')}</p>
  {:else}
    {#if phase === 'wantedDown'}
      <p class="banner" role="status" data-wanted-down><Icon name="info" size={18} />{$t('adminLive.offer.wantedDown')}</p>
    {/if}

    {#if mode === 'updater'}
      <div class="row">
        <Button icon="play" {pending} disabled={otherJob} on:click={() => dispatch('enable')}>{$t(phase === 'wantedDown' ? 'adminLive.offer.restart' : 'adminLive.offer.enable')}</Button>
        {#if otherJob}<span class="muted small" role="status" data-other-job><Icon name="clock" size={16} /> {$t('adminLive.err.updaterBusy')}</span>{/if}
      </div>
    {:else if mode === 'portainer'}
      <p class="manual" data-mode="portainer"><Icon name="info" size={18} />{$t('adminLive.offer.portainer')}</p>
    {:else}
      <div class="manual env" data-mode="env">
        <h3>{$t('adminLive.offer.envTitle')}</h3>
        <CopyField label={$t('adminLive.offer.envBody')} value={s.envLine} hint={$t('adminLive.offer.envProfilesNote')} />
        <p class="small muted">{$t('adminLive.offer.envCommand')} <code>docker compose up -d</code></p>
      </div>
    {/if}
  {/if}

  {#if mode === 'updater' && !working}
    <p class="muted small tip"><Rich key="adminLive.offer.persistTip" /></p>
  {/if}

  <div class="row foot">
    <Button variant="ghost" pending={hiding} disabled={working} on:click={() => dispatch('hide')}>{$t('adminLive.offer.hide')}</Button>
  </div>

  <!-- below the controls: the messages can grow without moving them -->
  <!-- the slot for a refusal or the result of a job: its space is always reserved -->
  <div class="slot">
    {#if !working}<UpdaterNotes {s} />{/if}
    {#if refused}
      <p class="msg err" role="alert"><Icon name="alert" size={18} /><span>{$t(`adminLive.err.${refused}` as 'adminLive.err.generic')} {$t('adminLive.err.notEnabled')}</span></p>
    {:else if resultText && !working}
      <p class="msg err" role="alert" data-result={ended?.state}><Icon name="alert" size={18} /><span>{resultText}</span></p>
    {/if}
    {#if hideError}<p class="msg err" role="alert"><Icon name="alert" size={18} /><span>{$t('adminLive.offer.hideFailed')}</span></p>{/if}
  </div>

</AdminCard>

<style>
  .what { margin: 0 0 .3rem; max-width: 70ch; overflow-wrap: anywhere; }
  .needs { margin: 0 0 1rem; max-width: 70ch; overflow-wrap: anywhere; }
  .row { display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; min-width: 0; }
  .foot { margin-top: .6rem; }
  .prog { display: grid; gap: .8rem; max-width: 36rem; min-width: 0; margin: 0 0 .5rem; }
  .banner, .manual { display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 1rem; padding: .6rem .8rem; border-radius: 8px; background: rgba(255,255,255,.05); overflow-wrap: anywhere; min-width: 0; }
  .manual.env { display: grid; gap: .6rem; max-width: 36rem; }
  .manual h3 { margin: 0; font-size: 1rem; }
  .manual :global(svg), .banner :global(svg), .msg :global(svg) { flex: none; margin-top: .1rem; }
  .small { font-size: .88rem; margin: 0; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.07); padding: .05rem .4rem; border-radius: 4px; }
  .slot { min-height: 3.2rem; margin-top: .4rem; display: grid; gap: .4rem; align-content: start; min-width: 0; }
  .msg { display: flex; gap: .5rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; min-width: 0; }
  .msg.err :global(svg) { color: var(--err); }
  .tip { margin: .4rem 0 0; max-width: 70ch; }
  .tip :global(kbd) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
</style>
