<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * A flow prompt as a form: the fields of the step (labels through fieldLabel: FriendFlix's own `ff:` labels are localised, anything else
   * is Authentik's text, rendered as text only). A password prompt (two password fields) is "Passwort ändern", an e-mail prompt
   * "E-Mail-Adresse ändern". Never navigates: emits `next` / `done`.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t } from '#lib/i18n';
  import Errors from './Errors.svelte';
  import { answer, fieldLabel, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'prompt' }> & { errors?: FlowError[] };
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let values: Record<string, string> = {};
  let busy = false;
  let root: HTMLElement;
  $: isPassword = step.fields.some((f) => f.type === 'password');
  $: isEmail = !isPassword && step.fields.some((f) => f.type === 'email');

  onMount(() => root?.querySelector('input')?.focus());

  async function submit() {
    if (busy) return;
    busy = true;
    try {
      const r = await answer(step, Object.fromEntries(step.fields.map((f) => [f.key, values[f.key] ?? ''])));
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      if (isPassword) values = {};
    }
  }
</script>

<form class="af-form" on:submit|preventDefault={submit} aria-busy={busy} bind:this={root}>
  <h1>{isPassword ? $t('login.sec.prompt.passwordTitle') : isEmail ? $t('login.sec.prompt.emailTitle') : $t('login.sec.prompt.title')}</h1>
  {#each step.fields as f (f.key)}
    <div class="af-field">
      <label for="pf-{f.key}">{fieldLabel(f.label, $t)}</label>
      <input id="pf-{f.key}" name={f.key} type={f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : 'text'} required={f.required} maxlength={f.type === 'email' ? 254 : 1024}
        autocomplete={f.type === 'password' ? 'new-password' : f.type === 'email' ? 'email' : 'off'} autocapitalize="none" spellcheck="false" disabled={busy}
        value={values[f.key] ?? ''} on:input={(e) => (values[f.key] = e.currentTarget.value)} />
    </div>
  {/each}
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="submit" disabled={busy}>{$t('login.sec.prompt.submit')}</button>
</form>
