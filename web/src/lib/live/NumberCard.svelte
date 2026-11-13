<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { t } from '#lib/i18n';
  import type { LiveChannel } from './api';
  import { fadeIn } from './fade';
  import { NUMBER_MAX_DIGITS } from './numberEntry';
  import { channelHead } from './progress';

  /**
   * The number card (spec §12.4): a small glass card top right showing the typed digits ("1 2 _") and, as soon as the number
   * matches a channel, its logo and name. A lone 0 stands for the last channel ("0 · Letzter Sender: 4 Hafenkanal"); a refused
   * number says "Kein Sender 123" (`message`). The card has a fixed size, so nothing in it moves when the match changes. It is one
   * polite status region (the typed digits and the match are announced); on a TV it is a solid panel.
   */
  export let digits = '';
  /** the channel with exactly this number, if any */
  export let match: LiveChannel | null = null;
  /** exactly "0" so far */
  export let zero = false;
  /** the last watched channel (what a lone 0 switches to) */
  export let last: LiveChannel | null = null;
  /** a text that replaces the digits ("Kein Sender 123") */
  export let message = '';

  $: typed = digits.split('').join(' ') + (digits.length < NUMBER_MAX_DIGITS ? (digits ? ' _' : '_') : '');
  $: line = message || (zero ? (last ? $t('live.number.last', { channel: channelHead(last) }) : $t('live.number.noLast')) : '');
</script>

<div class="ncard panel" role="status">
  {#if !message}<p class="digits">{typed}</p>{/if}
  <p class="line">
    {#if line}{line}{:else if match}
      <span class="logo" aria-hidden="true">{#if match.logo}<img src={match.logo} alt="" width="40" height="40" decoding="async" use:fadeIn />{/if}</span>
      <span class="who">{channelHead(match)}</span>
    {/if}
  </p>
</div>

<style>
  .ncard { --u: calc(100vw / 1920); position: fixed; z-index: 70; top: calc(var(--u) * 48); right: calc(var(--u) * 64); width: calc(var(--u) * 560); min-height: calc(var(--u) * 150); box-sizing: border-box; padding: calc(var(--u) * 18) calc(var(--u) * 28); border-radius: 12px; }
  .digits { margin: 0; font-size: calc(var(--u) * 48); line-height: calc(var(--u) * 60); font-weight: 700; letter-spacing: .08em; font-variant-numeric: tabular-nums; white-space: pre; }
  /* the second line always keeps its height (the match, the last channel or the refusal arrive in it) */
  .line { display: flex; align-items: center; gap: calc(var(--u) * 14); min-height: calc(var(--u) * 44); margin: 0; font-size: calc(var(--u) * 28); line-height: calc(var(--u) * 36); overflow: hidden; }
  .logo { flex: none; display: grid; place-items: center; width: calc(var(--u) * 44); height: calc(var(--u) * 44); }
  .logo img { width: 100%; height: 100%; object-fit: contain; opacity: 0; }
  .logo :global(img.in) { opacity: 1; }
  .who { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
</style>
