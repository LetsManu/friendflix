<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Renders lib/account/reauth.ts `reauthenticate()` as the in-app re-authentication (ReauthDialog, no follow-up flow). Mounted once
   * in the root layout, next to the confirm dialog: `done` answers true (the page repeats its action), `close` false. The dialog's own
   * redirects ("use a passkey instead", the classic page) come back to the request's `next`. The dialog (and the sign-in steps) load
   * on the first request only; a chunk that cannot load answers false. Each request gets a fresh dialog ({#key}); an in-app
   * navigation gives an open one up (reauthHost.ts).
   */
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { finishReauth, reauthRequest, registerReauthHost } from '#lib/account/reauth';
  import { dialogLoader, navigatedAway } from './reauthHost';

  type DialogModule = typeof import('./ReauthDialog.svelte');
  let Dialog: DialogModule['default'] | null = null;
  const load = dialogLoader(() => import('./ReauthDialog.svelte'));

  onMount(registerReauthHost);
  beforeNavigate(navigatedAway);

  $: if ($reauthRequest && !Dialog) void load().then((m) => { if (m) Dialog = m.default; });
</script>

{#if $reauthRequest && Dialog}
  {#key $reauthRequest.id}
    <svelte:component this={Dialog} next={$reauthRequest.next} on:done={() => finishReauth(true)} on:close={() => finishReauth(false)} />
  {/key}
{/if}
