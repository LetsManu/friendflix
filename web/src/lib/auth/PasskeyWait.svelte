<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The in-app passkey step: a calm card while the browser's passkey prompt is open ("Bestätige mit deinem Gerät", the hint, "Andere
   * Methode wählen"), the check of the answer (`checking`), and what went wrong with a way back: cancelled or no matching passkey,
   * timeout, unsupported, failed, and too many attempts (`limited`: no retry, only the way back). Never navigates and never starts a
   * ceremony itself: `retry` (a click, so the browser sees a user gesture) and `other` (back to the other methods; the parent aborts a
   * running ceremony) are for the parent. The sign-in page link is only shown when the parent passes one (the sign-in screens'
   * existing fallback for passkeys made on the identity provider's pages).
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { t, type TKey } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import type { PasskeyCard } from './flow';
  import './auth.css';

  export let state: PasskeyCard;
  /** the labelled fallback link (the identity provider's sign-in page); empty: none */
  export let classicHref = '';

  const dispatch = createEventDispatcher<{ retry: void; other: void }>();
  const TEXT: Record<PasskeyCard, { title: TKey; text: TKey }> = {
    waiting: { title: 'login.passkey.waitTitle', text: 'login.passkey.waitText' },
    checking: { title: 'login.passkey.waitTitle', text: 'login.passkey.checking' },
    cancelled: { title: 'login.passkey.cancelledTitle', text: 'login.passkey.cancelledText' },
    timeout: { title: 'login.passkey.timeoutTitle', text: 'login.passkey.timeoutText' },
    unsupported: { title: 'login.passkey.unsupportedTitle', text: 'login.passkey.unsupported' },
    failed: { title: 'login.passkey.failedTitle', text: 'login.passkey.failedText' },
    limited: { title: 'login.passkey.failedTitle', text: 'login.errors.rate_limited' },
  };
  $: busy = state === 'waiting' || state === 'checking';
  let heading: HTMLElement;
  let shown = state;

  onMount(() => heading?.focus());
  // a new state (waiting → cancelled, retry → waiting) is announced and gets the focus, so keyboard users land on its actions
  $: if (state !== shown) {
    shown = state;
    void tick().then(() => heading?.focus());
  }
</script>

<div class="af-form af-center" data-passkey={state} aria-busy={busy}>
  <div class="af-big ring" class:busy aria-hidden="true"><Icon name="fingerprint" size={30} /></div>
  <h1 bind:this={heading} tabindex="-1">{$t(TEXT[state].title)}</h1>
  <p class="af-sub" role="status">{$t(TEXT[state].text)}</p>
  {#if !busy && state !== 'unsupported' && state !== 'limited'}
    <button class="af-pri" type="button" on:click={() => dispatch('retry')}>{$t('login.passkey.retry')}</button>
  {/if}
  <button class="af-sec" type="button" disabled={state === 'checking'} on:click={() => dispatch('other')}>{$t('login.passkey.otherMethod')}</button>
  {#if classicHref && (state === 'cancelled' || state === 'unsupported')}
    <a class="af-link" href={classicHref}>{$t('login.passkey.classic')}</a>
  {/if}
</div>

<style>
  .ring { border-radius: 50%; }
  /* calm: a slow breath while the device prompt is open (transform and opacity only), none with reduced motion */
  .ring.busy { animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.05); opacity: .78; } }
  @media (prefers-reduced-motion: reduce) { .ring.busy { animation: none; } }
</style>
