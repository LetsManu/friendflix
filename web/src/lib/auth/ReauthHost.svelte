<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Renders lib/account/reauth.ts `reauthenticate()` as the in-app re-authentication (ReauthDialog, no follow-up flow). Mounted once
   * in the root layout, next to the confirm dialog: `done` answers true (the page repeats its action), `close` false. The dialog's own
   * redirects ("use a passkey instead", the classic page) come back to the request's `next`. The dialog (and the sign-in steps) load
   * on the first request only; a chunk that cannot load answers false.
   */
  import { onMount } from 'svelte';
  import { finishReauth, reauthRequest, registerReauthHost } from '#lib/account/reauth';

  type DialogModule = typeof import('./ReauthDialog.svelte');
  let Dialog: DialogModule['default'] | null = null;
  let loading: Promise<void> | null = null;

  onMount(registerReauthHost);

  $: if ($reauthRequest && !Dialog && !loading) {
    loading = import('./ReauthDialog.svelte').then(
      (m) => { Dialog = m.default; },
      () => { loading = null; finishReauth(false); },
    );
  }
</script>

{#if $reauthRequest && Dialog}
  {#key $reauthRequest.id}
    <svelte:component this={Dialog} next={$reauthRequest.next} on:done={() => finishReauth(true)} on:close={() => finishReauth(false)} />
  {/key}
{/if}
