<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The first run of the managed media server as six rows (backend mediaserver/firstRun.ts, model.ts setupSteps): done, running,
   * failed or still to do. A failed step names its reason and offers *Nochmal* (the step runs again); a startup wizard someone else
   * completed offers *Neu anlegen* (remove with data, set up again). The reason line and the button row keep their place from the
   * start: nothing below moves when a step fails. Only the dots' opacity changes; text never scales.
   */
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import type { MediaManaged } from './api';
  import { mediaErrorText, setupSteps } from './model';

  export let managed: Pick<MediaManaged, 'setup' | 'setupError'>;
  export let busy = false;
  /** the wizard has no remove: no *Neu anlegen* there */
  export let canRecreate = true;
  const dispatch = createEventDispatcher<{ retry: void; recreate: void }>();

  $: rows = setupSteps(managed);
  $: failed = rows.find((r) => r.state === 'failed') ?? null;
  $: taken = managed.setup === 'failed';
  $: done = managed.setup === 'done';
</script>

<div class="sp" data-testid="media-setup" data-setup={managed.setup}>
  <h3>{$t('mediaserver.setup.title')}</h3>
  <ol>
    {#each rows as r (r.step)}
      <li class="st-{r.state}" data-step={r.step} data-state={r.state} aria-current={r.state === 'running' ? 'step' : undefined}>
        <span class="dot" aria-hidden="true">
          <span class="ic ok"><Icon name="check" size={14} /></span><span class="ic bad"><Icon name="x" size={14} /></span><span class="spin"></span>
        </span>
        <span class="name">{$t(`mediaserver.setup.step.${r.step}`)}</span>
        <span class="state">{$t(`mediaserver.setup.state.${r.state}`)}</span>
      </li>
    {/each}
  </ol>
  <!-- reserved: the outcome line and the button row are there from the start -->
  <p class="line" class:bad={failed} role="status">
    {#if failed && (managed.setupError || taken)}{$t('mediaserver.setup.failedAt', { step: $t(`mediaserver.setup.step.${failed.step}`), reason: mediaErrorText(managed.setupError ?? 'wizard_taken') })}
    {:else if done}{$t('mediaserver.setup.done')}{/if}
  </p>
  <div class="acts">
    {#if failed && !taken}<Button variant="secondary" size="sm" icon="refresh" pending={busy} on:click={() => dispatch('retry')}>{$t('mediaserver.setup.again')}</Button>{/if}
    {#if taken && canRecreate}<Button variant="danger" size="sm" pending={busy} on:click={() => dispatch('recreate')}>{$t('mediaserver.setup.recreate')}</Button><span class="muted small">{$t('mediaserver.setup.recreateHint')}</span>{/if}
  </div>
</div>

<style>
  .sp { display: grid; gap: .4rem; }
  h3 { margin: 0; font-size: 1rem; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: .6rem; min-height: 36px; padding: 0 .4rem; border-radius: var(--fr-r-card); }
  li.st-running { background: rgba(var(--acc-rgb), .1); }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .state { color: var(--mut); font-size: .85rem; }
  .dot { position: relative; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line); display: grid; place-items: center; }
  .ic, .spin { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; transition: opacity .2s ease; }
  .st-done .dot { border-color: var(--ok); background: var(--ok); color: #101418; }
  .st-done .ok, .st-failed .bad { opacity: 1; }
  .st-failed .dot { border-color: var(--err); background: var(--err); color: #fff; }
  .st-running .dot { border-color: var(--acc); }
  .st-running .spin { opacity: 1; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--acc); margin: -2px; animation: sp-spin 1s linear infinite; }
  @keyframes sp-spin { to { transform: rotate(360deg); } }
  .line { margin: 0; min-height: 2.6em; font-size: .9rem; color: var(--mut); }
  .line.bad { color: var(--fg); }
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .8rem; min-height: 44px; }
  .small { font-size: .85rem; }
  @media (prefers-reduced-motion: reduce) { .st-running .spin { animation: none; } .ic, .spin { transition: none; } }
  :global(html.m-still) .st-running .spin { animation: none; }
</style>
