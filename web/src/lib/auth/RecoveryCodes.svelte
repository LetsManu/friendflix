<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The new recovery codes, shown once. "Ich habe die Codes gespeichert" confirms them (the old codes stop working only then).
   * Never navigates: emits `next` / `done`.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t } from '#lib/i18n';
  import { answer, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'recovery-codes' }>;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let busy = false;
  let heading: HTMLElement;
  onMount(() => heading?.focus());

  async function confirmSaved() {
    if (busy) return;
    busy = true;
    try {
      const r = await answer(step, {});
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
    }
  }
</script>

<div class="af-form" aria-busy={busy}>
  <h1 bind:this={heading} tabindex="-1">{$t('login.sec.codes.title')}</h1>
  <p class="af-sub">{$t('login.sec.codes.text')}</p>
  <ul class="codes" aria-label={$t('login.sec.codes.list')}>
    {#each step.codes as c (c)}<li><code>{c}</code></li>{/each}
  </ul>
  <button class="af-pri" type="button" disabled={busy} on:click={confirmSaved}>{$t('login.sec.codes.confirm')}</button>
</div>

<style>
  .codes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .5rem; }
  .codes li { background: var(--surface-2); border-radius: 8px; padding: .55rem .7rem; text-align: center; }
  .codes code { font-size: 1rem; letter-spacing: .04em; overflow-wrap: anywhere; user-select: all; }
</style>
