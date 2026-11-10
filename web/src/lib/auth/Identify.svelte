<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Screen 1, identification: e-mail or username (plus the password when the flow asks for it on the same stage), "Mit Passkey
   * anmelden" and "Noch kein Konto? Einladung einlösen".
   * Never navigates: it answers the step and emits `next` / `done`; `invite` (a pasted invite token) is for the page to act on.
   * Passkey: offered only when the step carries usable WebAuthn options (the RP ID is the app host, checked by the backend); without
   * them there is no passkey button at all, never one that leaves for the sign-in page. While the browser's prompt is open the card
   * shows the waiting step (PasskeyWait, "Andere Methode wählen" aborts it); a cancelled or unmatched passkey, a timeout or an error
   * stay on that card with "Erneut versuchen" and the way back, plus the sign-in page's passkey link, clearly labelled: passkeys made
   * on Authentik's own pages only work there (plan Ruling 1, trade-off). The prompt starts inside the click (the options come with
   * the step), so the browser sees the user gesture.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Errors from './Errors.svelte';
  import PasskeyWait from './PasskeyWait.svelte';
  import { answer, inviteToken, passkeyCeremonies, type FlowError, type FlowReply, type FlowStep, type PasskeyCard } from './flow';
  import './auth.css';

  export let step: Extract<FlowStep, { stage: 'identify' }> & { errors?: FlowError[] };
  /** the sign-in page (keeps a portal invite) */
  export let classicHref: string;

  const dispatch = createEventDispatcher<{ next: FlowReply; done: { next: string }; invite: { token: string } }>();
  let identifier = '', password = '', busy = false;
  /** the passkey card: null = the form; else the waiting step or what went wrong */
  let pk: PasskeyCard | null = null;
  const ceremony = passkeyCeremonies();
  let inviteOpen = false, inviteText = '', inviteBad = false;
  let first: HTMLInputElement, inviteInput: HTMLInputElement, passkeyBtn: HTMLButtonElement | undefined;

  onMount(() => first?.focus());

  function emit(r: FlowReply) {
    if (r.stage === 'done') dispatch('done', { next: r.next });
    else dispatch('next', r);
  }
  /** after an answer that stays on this stage (errors), the first field gets the focus again */
  async function refocus() {
    await tick();
    first?.focus();
  }

  async function submit() {
    const id = identifier.trim();
    if (busy || !id) return;
    busy = true;
    try {
      emit(await answer(step, step.passwordInline && password ? { identifier: id, password } : { identifier: id }));
    } finally {
      busy = false;
      password = '';
    }
    void refocus();
  }

  /** runs in the click handler itself (the browser wants a user gesture for its prompt); the step's own options only */
  async function withPasskey() {
    if (busy || !step.passkey) return;
    busy = true;
    pk = 'waiting';
    const r = await ceremony.run(step.passkey);
    // a prompt that is no longer the current one (another method chosen, a newer prompt) touches nothing, `busy` included
    if (!r) return;
    if ('problem' in r) {
      busy = false;
      if (r.problem !== 'aborted') pk = r.problem;
      return;
    }
    pk = 'checking';
    try {
      emit(await answer(step, { passkey: r.credential }));
    } finally {
      busy = false;
      pk = null; // the reply decides: the next step, or this one again with its errors
    }
    // refused (this step again with its errors): the focus goes back to the passkey button, not to the page
    await tick();
    (passkeyBtn ?? first)?.focus();
  }
  /** "Andere Methode wählen": back to the form; a running prompt is aborted */
  function otherMethod() {
    ceremony.abort();
    busy = false;
    pk = null;
    void refocus();
  }

  async function toggleInvite() {
    inviteOpen = !inviteOpen;
    inviteBad = false;
    if (inviteOpen) {
      await tick();
      inviteInput?.focus();
    }
  }
  function redeem() {
    const token = inviteToken(inviteText);
    inviteBad = !token;
    if (token) dispatch('invite', { token });
  }
</script>

{#if pk}
  <PasskeyWait state={pk} {classicHref} on:retry={withPasskey} on:other={otherMethod} />
{:else}
<form class="af-form" on:submit|preventDefault={submit} aria-busy={busy}>
  <h1>{$t('login.identify.title')}</h1>
  <p class="af-sub">{$t('login.identify.text')}</p>
  <div class="af-field">
    <label for="af-identifier">{$t('login.identify.identifier')}</label>
    <input id="af-identifier" name="username" type="text" autocomplete="username webauthn" autocapitalize="none" spellcheck="false" required maxlength="254" bind:value={identifier} bind:this={first} />
  </div>
  {#if step.passwordInline}
    <div class="af-field">
      <label for="af-inline-password">{$t('login.identify.password')}</label>
      <input id="af-inline-password" name="password" type="password" autocomplete="current-password" maxlength="1024" bind:value={password} />
    </div>
  {/if}
  <Errors errors={step.errors ?? []} {classicHref} />
  <button class="af-pri" type="submit" disabled={busy}>{$t('login.identify.next')}</button>
  {#if step.passkey}
    <div class="af-or">{$t('login.identify.or')}</div>
    <button class="af-sec" type="button" disabled={busy} bind:this={passkeyBtn} on:click={withPasskey}><Icon name="key" size={20} />{$t('login.identify.passkey')}</button>
  {/if}
  <button class="af-link" type="button" aria-expanded={inviteOpen} aria-controls="af-invite" on:click={toggleInvite}>{$t('login.identify.noAccount')}</button>
</form>
{#if inviteOpen}
  <form id="af-invite" class="af-form invite" on:submit|preventDefault={redeem}>
    <div class="af-field">
      <label for="af-invite-input">{$t('login.identify.inviteLabel')}</label>
      <input id="af-invite-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="512" bind:value={inviteText} bind:this={inviteInput} />
    </div>
    <Errors errors={[]} {classicHref} extra={inviteBad ? $t('login.identify.inviteBad') : ''} />
    <button class="af-sec" type="submit">{$t('login.identify.inviteGo')}</button>
  </form>
{/if}
{/if}

<style>
  .invite { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
</style>
