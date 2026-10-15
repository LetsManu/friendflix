<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 5: the first admin signs in (/auth/login?setup=1, a full page load: the backend starts the sign-in). The callback makes this
   * account admin, completes setup and lands on /setup/extras. Steps that are still open are listed instead of the button.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import type { SetupState } from './api';

  export let state: SetupState;
  const dispatch = createEventDispatcher<{ go: 2 | 3 | 4 }>();
  const OPEN = [[2, 'publicUrl'], [3, 'media'], [4, 'signin']] as const;
  $: missing = OPEN.filter(([, k]) => state.steps[k] === 'todo');
</script>

<h2 id="setup-step-h">{$t('setup.admin.title')}</h2>
{#if missing.length}
  <p>{$t('setup.admin.missing')}</p>
  <ul class="todo">
    {#each missing as [n, k] (k)}
      <li><Button variant="secondary" size="sm" icon="chevron-right" on:click={() => dispatch('go', n)}>{$t(`setup.steps.${k}`)}</Button></li>
    {/each}
  </ul>
{:else}
  <p>{$t('setup.admin.text')}</p>
  <p class="muted">{$t('setup.admin.after')}</p>
  <div class="acts"><Button href="/auth/login?setup=1" icon="user" data-sveltekit-reload>{$t('setup.admin.signIn')}</Button></div>
{/if}

<style>
  .todo { list-style: none; margin: 0 0 1rem; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } }
</style>
