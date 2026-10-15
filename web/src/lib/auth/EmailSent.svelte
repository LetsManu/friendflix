<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Bestätigungslink gesendet" after an e-mail change: the masked new address and the note that the address changes only once the link is
   * opened. No resend: the attempt is over on the server (the link works without a session). Never navigates: emits `done`.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import './auth.css';

  /** the masked address (a•••@example.com), null when it cannot be shown */
  export let to: string | null;

  const dispatch = createEventDispatcher<{ done: void }>();
  let heading: HTMLElement;
  onMount(() => heading?.focus());
</script>

<div class="af-form af-center">
  <div class="af-big" aria-hidden="true"><Icon name="mail" size={30} /></div>
  <h1 bind:this={heading} tabindex="-1">{$t('login.sec.emailSent.title')}</h1>
  <p class="af-sub">{to ? $t('login.sec.emailSent.text', { to }) : $t('login.sec.emailSent.textNoTo')}</p>
  <button class="af-pri" type="button" on:click={() => dispatch('done')}>{$t('login.sec.done')}</button>
</div>
