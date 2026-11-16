<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** /me/account (owner profile only): profile, security (2FA state), sessions & devices, e-mails, your data (export), delete the account, and the privacy note. */
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError, type Account, type AccountSecurity, type Me, type OwnDevice } from '#lib/api';
  import DataCard from '#lib/account/DataCard.svelte';
  import { clearPending } from '#lib/admin/settings/form';
  import DeleteCard from '#lib/account/DeleteCard.svelte';
  import MailCard from '#lib/account/MailCard.svelte';
  import { loadMailPrefs, type MailState } from '#lib/account/mail';
  import ProfileCard from '#lib/account/ProfileCard.svelte';
  import SecurityCard from '#lib/account/SecurityCard.svelte';
  import SessionsCard from '#lib/account/SessionsCard.svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { reducedMotion } from '#lib/ui/motion';

  let account: Account | null = null, mail: MailState | null = null, phase: 'loading' | 'ok' | 'owner' | 'error' = 'loading', reauthFailed = false;
  /** the lists of the sessions and security cards, read with the account so those cards render whole (null = could not be read) */
  let devices: OwnDevice[] | null = null, sec: AccountSecurity | null = null, isAdmin = false;

  async function load() {
    phase = 'loading';
    // both at once; the cards appear together once both answered (nothing pops in). The switches are account level like the account:
    // a kids profile's 403 shows only the hint, whatever the switches answered. Their failure only greys out the E-Mails card.
    // The sessions list, the security state and the admin flag are read right after it, before the cards show, for the same reason: a card that fills in
    // late changes its height and pushes every card below it (about 385 px on a phone). Their failure is shown by the card itself.
    const switches = loadMailPrefs().catch(() => null);
    try {
      account = await api<Account>('/api/account');
      mail = await switches;
      // only after the account answered: a kids profile (403) never asks for the device list
      const lists = Promise.all([
        api<{ devices: OwnDevice[] }>('/api/devices').then((r) => r.devices).catch(() => null),
        api<AccountSecurity>('/api/account/security').catch(() => null),
        api<Me>('/api/me').then((m) => Boolean(m.isAdmin && m.profile?.isOwner)).catch(() => false),
      ]);
      [devices, sec, isAdmin] = await lists;
      phase = 'ok';
    }
    catch (e) { phase = e instanceof ApiError && e.status === 403 ? 'owner' : 'error'; }
  }

  /**
   * A link to a card (/me/account#mail, the settings link in every mail's footer) finds its target only once the cards are rendered:
   * the browser's own jump (a first load) and SvelteKit's (a client navigation) both ran while the skeleton showed. Once, then the
   * person scrolls.
   */
  let scrolled = false;
  $: if (phase === 'ok' && !scrolled) { scrolled = true; void tick().then(scrollToHash); }
  function scrollToHash() {
    const id = location.hash.slice(1);
    if (id && /^[a-z-]+$/.test(id)) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  /** re-reads the account without the loading state (the security section stays mounted) */
  async function refresh() {
    try { account = await api<Account>('/api/account'); } catch { /* the old state stays */ }
  }
  onMount(() => {
    // back from /auth/reauth signed in as somebody else; the flag is dropped from the address so a reload does not repeat it
    const u = new URL(location.href);
    if (u.searchParams.get('reauth') === 'failed') {
      reauthFailed = true;
      clearPending(); // an Admin → Settings change waiting for this sign-in is not repeated
      u.searchParams.delete('reauth');
      void goto(u.pathname + u.search + u.hash, { shallow: true, replace: true });
    }
    void load();
  });
  function saved(a: Account) {
    account = a;
    window.dispatchEvent(new Event('ff-me-changed')); // the shell re-reads /api/me (header name and avatar)
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.account.pageTitle') })}</title></svelte:head>
<div class="acct">
  <h1>{$t('account.account.title')}</h1>
  {#if reauthFailed}<p class="err banner" role="alert">{$t('account.account.reauthFailed')}</p><p class="muted hint" data-hint="reauth-failed">{$t('account.account.reauthFailedHint')}</p>{/if}

  {#if phase === 'loading'}<div class="skeleton sk" aria-hidden="true"></div>
  {:else if phase === 'owner'}<p class="muted">{$t('account.account.ownerOnly')}</p>
  {:else if phase === 'error' || !account}
    <p class="err" role="alert">{$t('account.account.loadFailed')}</p>
    <button type="button" class="sec" on:click={load}>{$t('account.account.retry')}</button>
  {:else}
    <div class="grid">
      <ProfileCard {account} on:saved={(e) => saved(e.detail)} />
      <SecurityCard {account} initial={sec} {isAdmin} on:changed={refresh} />
      <div class="wide"><SessionsCard initial={devices} /></div>
      <MailCard {account} {mail} />
      <DataCard />
      <DeleteCard {account} />
    </div>
    <p class="muted privacy"><Icon name="shield" size={18} />{$t('account.account.privacy')}</p>
  {/if}
</div>

<style>
  .acct { max-width: 1000px; margin: 0 auto; }
  h1 { margin: .4rem 0 1rem; }
  .banner { padding: .7rem 1rem; border: 1px solid currentColor; border-radius: 8px; }
  .hint { margin: .4rem 0 1rem; font-size: .88rem; line-height: 1.4; }
  .sk { height: 320px; border-radius: 8px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; align-items: start; }
  @media (min-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .wide { grid-column: 1 / -1; } }
  .privacy { display: flex; gap: .6rem; align-items: flex-start; margin: 1.2rem 0 0; font-size: .9rem; }
  .privacy :global(svg) { margin-top: .1rem; }
</style>
