<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Authenticator app setup: the QR code (drawn from the otpauth address as one SVG path by qrPath, no markup injected), the key for
   * manual entry, and the first 6-digit code. The secret is the person's own and shown only here. Never navigates: emits `next` / `done`.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t } from '#lib/i18n';
  import { qrPath } from '#lib/qr';
  import Errors from './Errors.svelte';
  import { answer, type FlowError, type FlowReply, type FlowStep } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'totp-setup' }> & { errors?: FlowError[] };
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string } }>();
  let code = '', busy = false;
  let input: HTMLInputElement;
  $: qr = qrPath(step.otpauth);
  $: secret = (new URLSearchParams(step.otpauth.split('?')[1] ?? '').get('secret') ?? '').replace(/(.{4})/g, '$1 ').trim();

  onMount(() => input?.focus());

  async function submit() {
    if (busy || !/^\d{6}$/.test(code)) return;
    busy = true;
    try {
      const r = await answer(step, { code });
      if (r.stage === 'done') dispatch('done', { next: r.next });
      else dispatch('next', r);
    } finally {
      busy = false;
      code = '';
    }
    input?.focus();
  }
</script>

<form class="af-form" on:submit|preventDefault={submit} aria-busy={busy}>
  <h1>{$t('login.sec.totp.title')}</h1>
  <p class="af-sub">{$t('login.sec.totp.text')}</p>
  <svg class="qr" viewBox="-2 -2 {qr.size + 4} {qr.size + 4}" role="img" aria-label={$t('login.sec.totp.qr')} shape-rendering="crispEdges"><rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" /><path d={qr.d} fill="#000" /></svg>
  <details class="manual">
    <summary>{$t('login.sec.totp.manual')}</summary>
    <code>{secret}</code>
  </details>
  <div class="af-field">
    <label for="af-totp">{$t('login.sec.totp.label')}</label>
    <input id="af-totp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required bind:value={code} bind:this={input} disabled={busy} />
  </div>
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="submit" disabled={busy || code.length !== 6}>{$t('login.sec.totp.submit')}</button>
</form>

<style>
  .qr { width: 200px; max-width: 100%; height: auto; justify-self: center; border-radius: 8px; }
  .manual { font-size: .85rem; color: var(--mut); text-align: center; }
  .manual summary { cursor: pointer; min-height: 32px; }
  .manual code { display: block; margin-top: .4rem; overflow-wrap: anywhere; letter-spacing: .05em; color: var(--fg); user-select: all; }
</style>
