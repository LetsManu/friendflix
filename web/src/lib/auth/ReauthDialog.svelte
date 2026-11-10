<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The in-app re-authentication as a modal (account page): `start {kind:'reauth', then?}` and the flow's steps inline (password, second
   * factor, then the follow-up flow's own steps: authenticator app, recovery codes, passkey, new password, new e-mail). The step components
   * only emit events, so this dialog decides what happens: `done` (the flow finished: the parent reloads / retries its action) and `close`
   * (given up: the attempt is cancelled at the server, Authentik's session too). "Stattdessen mit Passkey bestätigen" appears only when
   * the first step says a passkey can confirm here (`passkeyAlt`); it runs the same in-app passkey step as the sign-in screen
   * (PasskeyWait) with the options the first reply prepared, so the prompt starts inside the click, never a redirect. "Andere Methode
   * wählen" returns to the password. Without a follow-up flow the classic fallback is the redirect (the identity provider's forced
   * sign-in).
   * A role=dialog with a name; Escape and the backdrop close it; Tab stays inside.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { t, type TKey } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { reauthHref } from '#lib/account/reauth';
  import Mfa from './Mfa.svelte';
  import Notice from './Notice.svelte';
  import PasskeySetup from './PasskeySetup.svelte';
  import PasskeyWait from './PasskeyWait.svelte';
  import Password from './Password.svelte';
  import PromptFields from './PromptFields.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';
  import EmailSent from './EmailSent.svelte';
  import TotpSetup from './TotpSetup.svelte';
  import {
    answer, cancelFlow, classicHref, flowConfig, FlowRefused, preparedPasskey, runPasskey, startFlow, type FlowReply, type PasskeyCard, type ThenKind,
    type UnavailableReason,
  } from './flow';
  import { reauthLife } from './reauthLife';
  import './auth.css';

  /** the follow-up flow; none = only a fresh sign-in (the parent then repeats its action) */
  export let then: ThenKind | undefined = undefined;
  /** Authentik's own settings page: where an account change continues when it cannot run here (null: not known) */
  export let manageUrl: string | null = null;
  /** where the redirect re-authentication comes back to (without `then`, the classic fallback); null: the account page */
  export let next: string | null = null;

  const dispatch = createEventDispatcher<{ done: void; close: void }>();
  const portal = (node: HTMLElement) => { document.body.appendChild(node); return { destroy() { node.remove(); } }; };
  const DONE_TEXT: Record<ThenKind, TKey> = {
    'setup-totp': 'login.sec.doneText.totp', 'setup-static': 'login.sec.doneText.static', 'setup-webauthn': 'login.sec.doneText.passkey',
    'change-password': 'login.sec.doneText.password', 'change-email': 'login.sec.doneText.email',
  };
  /** null while loading */
  let view: FlowReply | null = null;
  let finished = false;
  let classic = then && manageUrl ? manageUrl : !then && next ? reauthHref(next) : classicHref();
  /** the label of the fallback link: Authentik's settings page for an account change, else its sign-in page */
  $: classicLabel = (then && manageUrl && classic === manageUrl ? 'login.sec.manageClassic' : null) as TKey | null;
  /** a precise text for the notice (a refusal or an unavailable reason); null keeps the notice's own */
  let noticeText: TKey | null = null;
  const UNAVAILABLE_TEXT: Record<UnavailableReason, TKey> = {
    timeout: 'login.notice.unavailableTimeout', unreachable: 'login.notice.unavailableUnreachable',
    service_token: 'login.notice.unavailableServiceToken', error: 'login.notice.unavailableText',
  };
  /** what a refused start means for the person (codes from the backend; anything else is "not possible right now") */
  const REFUSED: Record<string, { stage: 'classic' | 'unavailable' | 'expired'; text: TKey | null }> = {
    classic: { stage: 'classic', text: 'login.sec.refused.classic' },
    flow_not_configured: { stage: 'classic', text: 'login.sec.refused.flow_not_configured' },
    authentik_user_not_found: { stage: 'unavailable', text: 'login.sec.refused.authentik_user_not_found' },
    step_used: { stage: 'expired', text: null },
    csrf: { stage: 'expired', text: null },
  };
  const life = reauthLife(cancelFlow);
  let dlg: HTMLElement;
  /** the first step said a passkey can confirm instead of the password */
  let passkeyAlt = false;
  /** the passkey card (null: the step itself), the identification step it answers, and the running prompt */
  let pk: PasskeyCard | null = null;
  let pkStep: Extract<FlowReply, { stage: 'identify' }> | null = null;
  /** pkStep is the prepared attempt next to the password step (answered with `alt: true`; the password attempt stays until it is accepted) */
  let pkPrepared = false;
  let ceremony: AbortController | null = null;

  onMount(() => { dlg?.focus(); void begin(); }); // the steps move the focus on to their first control

  async function begin() {
    view = null;
    noticeText = null;
    try {
      await flowConfig();
      const r = await startFlow('reauth', then ? { then } : {});
      if (!life.started()) return; // closed while the start was in flight: its provider sessions are cancelled
      passkeyAlt = r.passkeyAlt === true;
      // fetched before any click: the passkey prompt then starts inside the click (Safari refuses one after a round trip)
      pkStep = passkeyAlt ? preparedPasskey(r) : null;
      pkPrepared = pkStep !== null;
      show(r);
    } catch (e) {
      if (e instanceof FlowRefused && e.code === 'passkey_classic') {
        classic = '/auth/flow/classic/webauthn-setup';
        view = { stage: 'classic', reason: 'passkey_origin' };
      } else if (e instanceof FlowRefused && REFUSED[e.code]) {
        const r = REFUSED[e.code]!;
        noticeText = r.text;
        view = r.stage === 'classic' ? { stage: 'classic', reason: 'unsupported_stage' } : { stage: r.stage };
      } else view = { stage: 'unavailable' };
    }
  }
  function show(r: FlowReply) {
    if (r.stage === 'unavailable') noticeText = UNAVAILABLE_TEXT[r.reason ?? 'error'] ?? null;
    if (r.stage !== 'done') view = r;
    else if (then) { finished = true; life.finish(); }
    else { life.finish(); dispatch('done'); }
  }
  /**
   * "Stattdessen mit Passkey bestätigen" and "Erneut versuchen": the browser's prompt with the prepared options (fetched with the
   * password step, so the prompt starts inside the click), and the assertion as the answer. Only without prepared options a new
   * re-authentication stopping at the identification is fetched first (`method: 'passkey'`).
   */
  async function withPasskey() {
    if (pk === 'waiting' || pk === 'checking') return;
    pk = 'waiting';
    const ctrl = (ceremony = new AbortController());
    if (!pkStep) {
      let r: FlowReply | null = null;
      try {
        r = await startFlow('reauth', { ...(then ? { then } : {}), method: 'passkey' });
      } catch { /* refused (no usable options any more) or unreachable: the card says it did not work */ }
      if (ceremony !== ctrl) return; // the person chose another method meanwhile
      if (r && r.stage === 'identify' && r.passkey) pkStep = r;
      else if (r && !('step' in r) && r.stage !== 'done') {
        ceremony = null;
        pk = null;
        return show(r); // unavailable, expired: the notice with its retry
      } else {
        pk = 'failed';
        return;
      }
    }
    const res = await runPasskey(pkStep.passkey!, ctrl.signal);
    if (ceremony !== ctrl) return; // stale: another method chosen, or a newer prompt
    ceremony = null;
    if ('problem' in res) {
      if (res.problem !== 'aborted') pk = res.problem;
      return;
    }
    pk = 'checking';
    const reply = await answer(pkStep, pkPrepared ? { passkey: res.credential, alt: true } : { passkey: res.credential });
    // refused: the prepared attempt stays prepared (and the password step live); accepted: it is the attempt now
    if (reply.stage !== 'identify') pkPrepared = false;
    if (reply.stage === 'identify' && 'errors' in reply && reply.errors?.includes('rate_limited')) {
      pkStep = reply.passkey ? reply : null;
      pk = 'limited'; // too many attempts: said so, and only the way back
      return;
    }
    if (reply.stage === 'identify' && reply.passkey) {
      pkStep = reply; // refused: a new challenge for "Erneut versuchen"
      pk = 'failed';
      return;
    }
    pkStep = null;
    pk = null;
    show(reply);
  }
  /**
   * "Andere Methode wählen": the prompt is aborted. While the prepared attempt is unanswered or was refused, the password step is still
   * live, so the dialog simply shows it again; otherwise the re-authentication starts over with the password.
   */
  function otherMethod() {
    ceremony?.abort();
    ceremony = null;
    pk = null;
    if (pkPrepared && view && 'step' in view) return;
    pkStep = null;
    pkPrepared = false;
    void begin();
  }
  async function close() {
    ceremony?.abort();
    await life.close(); // loading, a step, a refused passkey: the provider sessions are still open unless the flow ended
    dispatch('close');
  }
  function finish() {
    life.finish();
    dispatch('done');
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions (Escape is handled by dialogKeys) -->
<div class="scrim" use:portal on:click={close}></div>
<div class="dlg" use:portal use:dialogKeys={{ close }} bind:this={dlg} tabindex="-1" role="dialog" aria-modal="true" aria-label={$t('login.sec.dialog')}>
  <button class="x icon-btn" type="button" aria-label={$t('login.sec.close')} on:click={close}><Icon name="x" size={20} /></button>
  {#if finished && then}
    <div class="af-form af-center">
      <div class="af-big" aria-hidden="true"><Icon name="check" size={30} /></div>
      <h1>{$t('login.sec.doneTitle')}</h1>
      <p class="af-sub">{$t(DONE_TEXT[then])}</p>
      <button class="af-pri" type="button" on:click={finish}>{$t('login.sec.done')}</button>
    </div>
  {:else if pk}
    <PasskeyWait state={pk} on:retry={withPasskey} on:other={otherMethod} />
  {:else if !view}
    <p class="loading muted" role="status">{$t('login.sec.loading')}</p>
  {:else if view.stage === 'password'}
    <Password step={view} classicHref={classic} canRestart={false} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
    {#if passkeyAlt}<button class="af-link alt" type="button" on:click={withPasskey}>{$t('login.sec.usePasskey')}</button>{/if}
  {:else if view.stage === 'mfa'}
    <Mfa step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'totp-setup'}
    <TotpSetup step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'recovery-codes'}
    <RecoveryCodes step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'prompt'}
    <PromptFields step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'passkey-setup'}
    <PasskeySetup step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={() => show({ stage: 'done', next: '' })} />
  {:else if view.stage === 'email-sent'}
    <EmailSent step={view} classicHref={classic} resend={false} on:done={finish} />
  {:else if view.stage === 'identify'}
    <Notice kind="classic" classicHref={classic} />
  {:else if view.stage === 'denied' || view.stage === 'locked' || view.stage === 'expired' || view.stage === 'unavailable' || view.stage === 'classic'}
    <Notice kind={view.stage} classicHref={classic} text={noticeText} {classicLabel} on:retry={begin} on:restart={begin} />
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, .7); }
  .dlg {
    position: fixed; z-index: 121; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(26rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem); overflow-y: auto; padding: 1.6rem 1.4rem 1.4rem; display: grid; gap: 12px;
    border: 1px solid #323a43; border-radius: 12px; background: #1b2127; color: var(--fg); box-shadow: var(--shadow-pop);
  }
  .x { position: absolute; top: .4rem; right: .4rem; color: var(--mut); }
  .loading { margin: 0; text-align: center; padding: 1rem 0; }
  .alt { justify-self: center; }
  .dlg:focus { outline: none; }
  @media (max-width: 600px) {
    .dlg { top: auto; bottom: 0; left: 0; right: 0; transform: none; width: auto; max-height: calc(100dvh - 1rem); border-radius: 14px 14px 0 0; padding-bottom: calc(1.4rem + var(--safe-bottom)); }
  }
</style>
