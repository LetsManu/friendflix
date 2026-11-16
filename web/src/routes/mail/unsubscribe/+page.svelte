<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /mail/unsubscribe?t= (E-mail stage B): the footer link of every mail a person can switch off. A public page: it works without a
   * FriendFlix session and never asks /api/me. The token goes into memory and out of the address bar at once, and the page sends no
   * Referer (the <meta> below, and the web server's header for this path). Nothing is sent until the button is pressed (a mail
   * scanner or link preview that only opens the page changes nothing); the token then goes in the JSON body, never in a URL.
   * The type is read from the token (its readable third part), so the question names it without a request. Never shows an address.
   *
   * Views (the brief's names): ready / busy / failed / limited are the question panel (busy disables the button, failed and limited
   * put their sentence in the panel's reserved line, the button tries again); done is "Abbestellt." with "Wieder anmelden";
   * resubscribed; invalid (a token of the wrong shape: no request at all; or a 400 from the backend). The panels sit on top of each
   * other in one grid cell, so the box is as tall as the tallest one in every language and swapping them (opacity) moves nothing.
   */
  import { onMount, tick } from 'svelte';
  import { publicLocale, setLocale, t } from '#lib/i18n';
  import AuthShell from '#lib/auth/AuthShell.svelte';
  import Icon from '#lib/Icon.svelte';
  import { postUnsubscribe, unsubscribeType, type MailType } from '#lib/account/mail';
  import '../../../lib/auth/auth.css';

  type Panel = 'ask' | 'off' | 'on' | 'invalid';
  const PANELS: readonly Panel[] = ['ask', 'off', 'on', 'invalid'];
  /**
   * The account card. A full page load (data-sveltekit-reload): this public page runs without the app shell, which starts (reads
   * /api/me, or sends to the sign-in) only on a load; the account page then scrolls to the card once it has rendered.
   */
  const SETTINGS = '/me/account#mail';

  let token = '';
  let type: MailType = 'available';
  let panel: Panel = 'ask';
  let busy = false;
  let problem: '' | 'limited' | 'failed' = '';
  const leads: Partial<Record<Panel, HTMLElement>> = {};

  onMount(() => {
    const pre = publicLocale();
    if (pre) void setLocale(pre);
    const q = new URLSearchParams(location.search);
    const given = q.get('t') ?? '';
    const known = unsubscribeType(given);
    if (known) { token = given; type = known; } else panel = 'invalid';
    // the token does not stay in the address bar or the history entry. Not SvelteKit's replaceState: it keeps the old URL (with the
    // token) in history.state (`sveltekit:metadata.pageUrl`)
    if (q.has('t')) history.replaceState(history.state, '', location.pathname);
  });

  async function send(on: boolean) {
    if (busy || !token) return;
    busy = true;
    problem = '';
    const r = await postUnsubscribe(token, on);
    busy = false;
    if (r === 'limited' || r === 'failed') { problem = r; return; }
    if (r === 'invalid') token = '';
    panel = r === 'invalid' ? 'invalid' : on ? 'on' : 'off';
    await tick();
    leads[panel]?.focus();
  }

  $: typeText = $t(`login.unsubscribe.types.${type}`);
</script>

<svelte:head>
  <title>{$t('common.pageTitle', { page: $t('login.unsubscribe.pageTitle') })}</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>
<AuthShell>
  <div class="af-form af-center">
    <div class="af-big" aria-hidden="true"><Icon name="mail" size={30} /></div>
    <h1>{$t('login.unsubscribe.title')}</h1>
    <div class="views" aria-busy={busy}>
      {#each PANELS as p (p)}
        <div class="view" class:on={panel === p} aria-hidden={panel !== p} data-view={p}>
          {#if p === 'ask'}
            <p class="lead" tabindex="-1" bind:this={leads.ask}>{$t('login.unsubscribe.ask', { type: typeText })}</p>
            <p class="af-sub">{$t('login.unsubscribe.askText')}</p>
            <p class="af-hint line">{#if panel === p && problem}<span role="alert">{$t(`login.unsubscribe.${problem}`)}</span>{/if}</p>
            <button class="af-pri" type="button" disabled={busy || panel !== p} on:click={() => send(false)}>{$t('login.unsubscribe.button')}</button>
          {:else if p === 'off'}
            <p class="lead" tabindex="-1" bind:this={leads.off}>{$t('login.unsubscribe.doneTitle')}</p>
            <p class="af-sub">{$t('login.unsubscribe.doneText', { type: typeText })}</p>
            <p class="af-hint line">{#if panel === p && problem}<span role="alert">{$t(`login.unsubscribe.${problem}`)}</span>{/if}</p>
            <button class="af-sec" type="button" disabled={busy || panel !== p} on:click={() => send(true)}>{$t('login.unsubscribe.resubscribe')}</button>
            <a class="af-link" href={SETTINGS} data-sveltekit-reload tabindex={panel === p ? undefined : -1}>{$t('login.unsubscribe.settings')}</a>
          {:else if p === 'on'}
            <p class="lead" tabindex="-1" bind:this={leads.on}>{$t('login.unsubscribe.resubscribedTitle')}</p>
            <p class="af-sub">{$t('login.unsubscribe.resubscribedText', { type: typeText })}</p>
            <a class="af-link" href={SETTINGS} data-sveltekit-reload tabindex={panel === p ? undefined : -1}>{$t('login.unsubscribe.settings')}</a>
          {:else}
            <p class="lead" tabindex="-1" bind:this={leads.invalid}>{$t('login.unsubscribe.invalidTitle')}</p>
            <p class="af-sub">{$t('login.unsubscribe.invalidText')}</p>
            <a class="af-link" href={SETTINGS} data-sveltekit-reload tabindex={panel === p ? undefined : -1}>{$t('login.unsubscribe.settings')}</a>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</AuthShell>

<style>
  /* one grid cell for every panel: the box keeps the tallest panel's height, so a swap never moves the heading or the card */
  .views { display: grid; }
  .view { grid-area: 1 / 1; display: grid; gap: 12px; align-content: start; opacity: 0; visibility: hidden;
    transition: opacity 180ms ease, visibility 0s linear 180ms; }
  .view.on { opacity: 1; visibility: visible; transition: opacity 180ms ease; }
  :global(html.m-still) .view { transition: none; }
  @media (prefers-reduced-motion: reduce) { .view, .view.on { transition: none; } }
  .lead { margin: 0; font-size: 1.05rem; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
  .lead:focus { outline: none; }
  .af-sub { margin: 0; overflow-wrap: anywhere; }
  /* a failed try's sentence: its room is kept, so the button below does not jump */
  .line { min-height: 2.6em; color: var(--err, #ffa8a8); }
  .af-link { min-height: 44px; }
</style>
