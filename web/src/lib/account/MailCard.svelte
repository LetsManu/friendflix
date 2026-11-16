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
  import { ADMIN_MAIL_TYPES, MAIL_TYPES, PERSON_MAIL_TYPES, saveMailPref, type MailState, type MailType } from './mail';

  export let account: Account;

  /** the switch texts per type (literal keys, so the key check covers them) */
  const TEXT = {
    available: { label: 'account.account.mail.types.available.label', hint: 'account.account.mail.types.available.hint' },
    recording: { label: 'account.account.mail.types.recording.label', hint: 'account.account.mail.types.recording.hint' },
    licence: { label: 'account.account.mail.types.licence.label', hint: 'account.account.mail.types.licence.hint' },
    digest: { label: 'account.account.mail.types.digest.label', hint: 'account.account.mail.types.digest.hint' },
    update: { label: 'account.account.mail.types.update.label', hint: 'account.account.mail.types.update.hint' },
    updatefailed: { label: 'account.account.mail.types.updatefailed.label', hint: 'account.account.mail.types.updatefailed.hint' },
    syscheck: { label: 'account.account.mail.types.syscheck.label', hint: 'account.account.mail.types.syscheck.hint' },
    storage: { label: 'account.account.mail.types.storage.label', hint: 'account.account.mail.types.storage.hint' },
  } as const;

  /** GET /api/account/mail, read by the page together with the account (so the card appears whole); null = it could not be read */
  export let mail: MailState | null;

  /** every type has a value (the ones the backend did not list stay off and unshown), so the switches can bind to it */
  let prefs = { ...Object.fromEntries(MAIL_TYPES.map((x) => [x, false])), ...mail?.prefs } as Record<MailType, boolean>;
  /** the error line: the switches could not be read, or the last switch was not saved */
  let err: '' | 'loadFailed' | 'saveFailed' = mail ? '' : 'loadFailed';
  let pending = Object.fromEntries(MAIL_TYPES.map((x) => [x, false])) as Record<MailType, boolean>;
  const configured = mail?.configured ?? true, hasAddress = mail?.hasAddress ?? true;
  /** the admin switches are part of the first render: the backend lists them for admins only, and the card already has them */
  const admin = mail?.admin === true;

  $: address = hasAddress ? account.email : null;
  $: locked = !mail || !configured || !hasAddress;

  async function flip(type: MailType, on: boolean) {
    err = '';
    pending = { ...pending, [type]: true };
    // only this switch takes the answer: another switch still saving keeps the value it shows (its own answer brings its own)
    try {
      const saved = await saveMailPref(type, on);
      prefs = { ...prefs, [type]: saved[type] ?? on }; // read after the await: the other switches as they are now
    }
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
    {/if}
    <!-- the address is set and changed under "Sicherheit", as the profile card says too -->
    <a class="ext" href="#sec-email">{$t('account.account.profile.emailManage')}</a>
  </div>
  {#if !configured}<p class="note">{$t('account.account.mail.notConfigured')}</p>{/if}
  <ul class="list">
    {#each PERSON_MAIL_TYPES as type (type)}
      <li>
        <Toggle id="acc-mail-{type}" label={$t(TEXT[type].label)} hint={$t(TEXT[type].hint)}
          bind:checked={prefs[type]} disabled={locked} pending={pending[type]} on:change={(e) => flip(type, e.detail)} />
      </li>
    {/each}
  </ul>
  {#if admin}
    <h3 id="acc-mail-admin">{$t('account.account.mail.admin')}</h3>
    <ul class="list" aria-labelledby="acc-mail-admin">
      {#each ADMIN_MAIL_TYPES as type (type)}
        <li>
          <Toggle id="acc-mail-{type}" label={$t(TEXT[type].label)} hint={$t(TEXT[type].hint)}
            bind:checked={prefs[type]} disabled={locked} pending={pending[type]} on:change={(e) => flip(type, e.detail)} />
        </li>
      {/each}
    </ul>
  {/if}
  <p class="err line">{#if err}<span role="alert">{$t(`account.account.mail.${err}`)}</span>{/if}</p>
  <p class="muted hint">{$t('account.account.mail.footer')}</p>
</section>

<style>
  .card { display: flex; flex-direction: column; gap: .75rem; margin: 0; min-width: 0; }
  h2 { font-size: 1.15rem; margin: 0; }
  h3 { font-size: .95rem; margin: .5rem 0 0; }
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
