<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Screen 4, "check your inbox" (the recovery mail is on its way): the masked address and "Erneut senden (m:ss)", which counts down
   * from 60 s (the backend's resend gap) and then enables. "Zurück zur Anmeldung" emits `cancel` (the page gives the attempt up).
   * Never navigates.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'email-sent' }> & { errors?: FlowError[] };
  export let classicHref: string;
  const GAP_S = 60;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string }; cancel: void }>();
  let left = GAP_S, busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function startCount() {
    left = GAP_S;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      left = Math.max(0, left - 1);
      if (left === 0 && timer) clearInterval(timer);
    }, 1000);
  }
  // a new mail (a new step id) restarts the countdown
  $: if (step.step) startCount();
  onDestroy(() => timer && clearInterval(timer));
  $: time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  async function resend() {
    if (busy || left > 0) return;
    busy = true;
    try {
      const r = await answer(step, {});
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      startCount();
    }
  }
</script>

<div class="af-form af-center" aria-busy={busy}>
  <div class="af-big" aria-hidden="true"><Icon name="mail" size={30} /></div>
  <h1>{$t('login.emailSent.title')}</h1>
  <p class="af-sub">{step.to ? $t('login.emailSent.text', { to: step.to }) : $t('login.emailSent.textNoAddress')}</p>
  <p class="af-hint">{$t('login.emailSent.hint')}</p>
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-sec" type="button" disabled={busy || left > 0} on:click={resend} data-resend>
    {left > 0 ? $t('login.emailSent.resendIn', { time }) : $t('login.emailSent.resend')}
  </button>
  <button class="af-link" type="button" on:click={() => dispatch('cancel')}>{$t('login.emailSent.back')}</button>
</div>
