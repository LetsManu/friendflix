<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * A prompt stage (invite sign-up, the new password of a reset): one input per field the flow asks for. Labels go through
   * `fieldLabel()` (FriendFlix's own `ff:` labels are localised; Authentik's text is shown as plain text, never as markup). Password
   * fields are cleared after every answer. Never navigates: emits `next` / `done`.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t, type TKey } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import { answer, fieldLabel, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'prompt' }> & { errors?: FlowError[] };
  export let classicHref: string;
  export let title: string;
  export let text = '';
  export let submitLabel: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let values: Record<string, string> = {};
  let busy = false, show = false;
  let form: HTMLFormElement;
  const label = (l: string) => fieldLabel(l, (k: TKey) => $t(k));
  const auto = (type: string) => (type === 'password' ? 'new-password' : type === 'email' ? 'email' : type === 'username' ? 'username' : 'off');

  onMount(() => form?.querySelector('input')?.focus());

  async function submit() {
    if (busy) return;
    busy = true;
    const fields = step.fields; // the reply replaces the step (and this screen): the clean-up below uses this copy
    try {
      const body: Record<string, string> = {};
      for (const f of fields) if ((values[f.key] ?? '') !== '') body[f.key] = values[f.key]!;
      const r = await answer(step, body);
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      for (const f of fields) if (f.type === 'password') values[f.key] = '';
      values = values;
    }
  }
</script>

<form class="af-form" bind:this={form} on:submit|preventDefault={submit} aria-busy={busy}>
  <h1>{title}</h1>
  {#if text}<p class="af-sub">{text}</p>{/if}
  {#each step.fields as f, i (f.key)}
    <div class="af-field">
      <label for="af-f-{i}">{label(f.label)}</label>
      {#if f.type === 'password'}
        <div class="af-secret">
          <input id="af-f-{i}" type={show ? 'text' : 'password'} autocomplete="new-password" autocapitalize="none" spellcheck="false" maxlength="1024" required={f.required}
            value={values[f.key] ?? ''} on:input={(e) => (values[f.key] = e.currentTarget.value)} />
          {#if i === step.fields.findIndex((x) => x.type === 'password')}
            <button class="icon-btn" type="button" aria-label={$t('login.password.show')} title={show ? $t('login.password.hide') : $t('login.password.show')} aria-pressed={show} on:click={() => (show = !show)}>
              <Icon name={show ? 'eye-off' : 'eye'} size={20} />
            </button>
          {/if}
        </div>
      {:else}
        <input id="af-f-{i}" type={f.type === 'email' ? 'email' : 'text'} autocomplete={auto(f.type)} autocapitalize="none" spellcheck="false" maxlength={f.type === 'email' ? 254 : 1024}
          required={f.required} value={values[f.key] ?? ''} on:input={(e) => (values[f.key] = e.currentTarget.value)} />
      {/if}
    </div>
  {/each}
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="submit" disabled={busy}>{submitLabel}</button>
</form>
