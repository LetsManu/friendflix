<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /me/account, E-Mails (E-mail stage B): where the mails go and one switch per mail type (lib/account/mail.ts). A switch saves at
   * once and flips back when saving fails; the error line keeps its room so nothing below it moves. The switches stay off-limits
   * while the server sends no mail or the account has no address (the card says why). The page reads the switches before it shows
   * the cards, so nothing appears late and pushes the card around. Mail is account level: the page is owner-only,
   * so a kids profile never sees this card. `id="mail"` is the target of the settings link in every mail's footer.
   */
  import type { Account } from '#lib/api';
  import { t } from '#lib/i18n';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { MAIL_TYPES, saveMailPref, type MailPrefs, type MailState, type MailType } from './mail';

  export let account: Account;

  /** the switch texts per type (literal keys, so the key check covers them) */
  const TEXT = {
    available: { label: 'account.account.mail.types.available.label', hint: 'account.account.mail.types.available.hint' },
    recording: { label: 'account.account.mail.types.recording.label', hint: 'account.account.mail.types.recording.hint' },
    licence: { label: 'account.account.mail.types.licence.label', hint: 'account.account.mail.types.licence.hint' },
  } as const;

  /** GET /api/account/mail, read by the page together with the account (so the card appears whole); null = it could not be read */
  export let mail: MailState | null;

  let prefs: MailPrefs = mail ? { ...mail.prefs } : { available: true, recording: true, licence: true };
  /** the error line: the switches could not be read, or the last switch was not saved */
  let err: '' | 'loadFailed' | 'saveFailed' = mail ? '' : 'loadFailed';
  let pending: Record<MailType, boolean> = { available: false, recording: false, licence: false };
  const configured = mail?.configured ?? true, hasAddress = mail?.hasAddress ?? true;

  $: address = hasAddress ? account.email : null;
  $: locked = !mail || !configured || !hasAddress;

  async function flip(type: MailType, on: boolean) {
    err = '';
    pending = { ...pending, [type]: true };
    try { prefs = await saveMailPref(type, on); }
    catch {
      prefs = { ...prefs, [type]: !on };
      err = 'saveFailed';
    } finally { pending = { ...pending, [type]: false }; }
  }
</script>

<section class="panel card" id="mail" aria-labelledby="acc-mail">
  <h2 id="acc-mail">{$t('account.account.mail.title')}</h2>
  <div class="to">
    {#if address}
      <span class="muted">{$t('account.account.mail.to')}</span> <strong class="addr">{address}</strong>
    {:else}
      <span class="muted">{$t('account.account.mail.noAddress')}</span>
      <a class="ext" href="#sec-email">{$t('account.account.profile.emailManage')}</a>
    {/if}
  </div>
  {#if !configured}<p class="note">{$t('account.account.mail.notConfigured')}</p>{/if}
  <ul class="list">
    {#each MAIL_TYPES as type (type)}
      <li>
        <Toggle id="acc-mail-{type}" label={$t(TEXT[type].label)} hint={$t(TEXT[type].hint)}
          bind:checked={prefs[type]} disabled={locked} pending={pending[type]} on:change={(e) => flip(type, e.detail)} />
      </li>
    {/each}
  </ul>
  <p class="err line">{#if err}<span role="alert">{$t(`account.account.mail.${err}`)}</span>{/if}</p>
  <p class="muted hint">{$t('account.account.mail.footer')}</p>
</section>

<style>
  .card { display: flex; flex-direction: column; gap: .75rem; margin: 0; min-width: 0; }
  h2 { font-size: 1.15rem; margin: 0; }
  .to { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; font-size: .92rem; min-width: 0; }
  .addr { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
  .ext { display: inline-flex; align-items: center; min-height: 44px; color: #54b9c5; font-weight: 600; }
  .ext:hover { text-decoration: underline; }
  .note { margin: 0; padding: .55rem .8rem; border-radius: var(--fr-r-card); background: rgba(255, 255, 255, .06); box-shadow: inset 0 0 0 1px var(--fr-line); font-size: .9rem; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
  /* the error line keeps one line of room: a failed save does not push the hint down */
  .line { margin: 0; min-height: 1.4em; font-size: .88rem; }
  .hint { margin: 0; font-size: .85rem; }
</style>
