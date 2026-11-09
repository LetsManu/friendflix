<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Item, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Row from '#lib/Row.svelte';
  import { avatarBg, initial } from '#lib/avatars';
  import { groupLinks, linksFor } from '#lib/menu';
  import { features, linkShown, serverCaps } from '#lib/capabilities';
  import { logout } from '#lib/session';
  import { goto } from '$app/navigation';
  import { locale, localeName, t, type TKey } from '#lib/i18n';
  import { isTvApp } from '#lib/tvapp';
  import { isFireTvApp, postFireTv } from '#lib/firetv/detect';
  import { changeServerViaHome } from '#lib/webos/home';
  import { toast } from '#lib/ui/toast';

  type Note = { id: number; title: string; link?: string; read: boolean };
  let me: Me | null = null, notes: Note[] | null = null, resume: Item[] | null = null, allNotes = false;
  let tvApp = false; // TV app (LG, Fire TV): "Change server" (same as the header's account menu; the TV reaches it only here)

  onMount(() => {
    tvApp = isTvApp();
    api<Me>('/api/me').then((m) => (me = m)).catch(() => undefined);
    api('/api/library/resume').then((r) => (resume = r.items)).catch(() => (resume = []));
    api('/api/notifications').then(async (r) => {
      notes = r.notifications;
      // seeing them here counts as reading (same as opening the bell)
      if (notes!.some((n) => !n.read)) { await api('/api/notifications/read', { method: 'POST' }).catch(() => undefined); setTimeout(() => window.dispatchEvent(new Event('ff-notes')), 1200); }
    }).catch(() => (notes = []));
  });
  /** Fire TV: the app opens its server screen; LG: back to the app's start page */
  function changeServer() {
    const stuck = () => toast.info($t('shell.account.changeServerBlue'));
    if (isFireTvApp()) { if (!postFireTv('changeServer')) stuck(); } // no message port: never silently nothing
    else changeServerViaHome(stuck);
  }
  async function removeResume(id: string) {
    const prev = resume;
    resume = resume ? resume.filter((i) => i.id !== id) : resume;
    try { await api(`/api/library/resume/${id}`, { method: 'DELETE' }); } catch { resume = prev; }
  }
  async function surprise() {
    try { await goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { await goto('/browse/movies'); }
  }
  $: canDownload = Boolean(me?.downloads?.allowed);
  $: groups = groupLinks(linksFor(canDownload).filter(([href]) => linkShown($serverCaps, href, $features)));
  $: admin = Boolean(me?.isAdmin && me?.profile?.isOwner);
  $: owner = Boolean(me?.profile?.isOwner && !me.kids); // the account page is the owner profile's
  $: shown = notes ? (allNotes ? notes : notes.slice(0, 5)) : [];
  $: tiles = [['/watchlist', 'shell.menu.myList', 'plus'], ...(canDownload ? [['/downloads', 'shell.menu.downloads', 'download']] : []), ['/lists', 'shell.menu.lists', 'list'], ['/history', 'shell.menu.history', 'calendar']] as Array<[string, TKey, string]>;
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('account.me.title') })}</title></svelte:head>
<h1 class="sr-only">{$t('account.me.title')}</h1>
<div class="me frost-text">
  <header class="prof">
    <span class="face" style={me?.profile ? `background:${avatarBg(me.profile.avatar)}` : undefined} aria-hidden="true">{me ? initial(me.profile?.name ?? me.name) : ''}</span>
    <div class="who">
      {#if me}<b>{me.profile?.name ?? me.name}</b><span class="muted">{me.roleLabel}</span>{:else}<span class="skeleton sk"></span>{/if}
      <span class="pl"><a class="swap" href="/profiles"><Icon name="users" size={16} />{$t('account.me.switchProfile')}</a><a class="swap" href="/profiles?manage=1">{$t('account.me.manageProfiles')}</a></span>
    </div>
  </header>

  <ul class="tiles2" aria-label={$t('account.me.quick')}>
    {#each tiles as [href, label, icon] (href)}<li><a class="frost-flat frost-tile" {href}><span class="ti"><Icon name={icon} size={24} /></span><span class="tl">{$t(label)}</span></a></li>{/each}
  </ul>

  <section aria-labelledby="h-notes">
    <div class="sech"><h2 id="h-notes">{$t('account.me.notifications')}</h2>{#if notes && notes.length > 5}<button type="button" class="lnk" aria-expanded={allNotes} on:click={() => (allNotes = !allNotes)}>{allNotes ? $t('account.me.less') : $t('account.me.all', { n: notes.length })}</button>{/if}</div>
    {#if notes === null}<div class="skeleton nsk"></div>
    {:else if !notes.length}<p class="muted pad">{$t('account.me.noNotifications')}</p>
    {:else}
      <ul class="notes frost-flat frost-tile">
        {#each shown as n (n.id)}
          <li class:muted={n.read}>{#if n.link}<a href={n.link}><span class="nd" class:unread={!n.read} aria-hidden="true"></span><span class="nt">{n.title}</span><Icon name="chevron-right" size={18} /></a>{:else}<span class="plainn"><span class="nd" class:unread={!n.read} aria-hidden="true"></span><span class="nt">{n.title}</span></span>{/if}</li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if resume === null || resume.length}
    <div class="bleed"><Row title={$t('account.me.continueWatching')} items={resume} landscape removable on:remove={(e) => removeResume(e.detail.id)} /></div>
  {/if}

  <div class="groups">
    {#each groups as g (g.title)}
      {@const isAcc = g.title === 'shell.menu.groups.account'}
      {#if g.items.length || isAcc}
        <section class="grp" aria-label={$t(g.title)}>
          <h2 class="gh">{$t(g.title)}</h2>
          <ul class="lst frost-flat frost-tile">
            {#if g.title === 'shell.menu.groups.discover'}<li><button type="button" class="rowbtn" on:click={surprise}><Icon name="shuffle" size={20} />{$t('shell.menu.surprise')}<Icon name="chevron-right" size={18} /></button></li>{/if}
            {#each g.items as [href, label, icon] (href)}<li><a {href}><Icon name={icon} size={20} />{$t(label)}<Icon name="chevron-right" size={18} /></a></li>{/each}
            {#if isAcc && owner}<li><a href="/me/account"><Icon name="user" size={20} />{$t('account.account.title')}<Icon name="chevron-right" size={18} /></a></li>{/if}
            {#if isAcc}<li><a href="/settings#language"><Icon name="globe" size={20} />{$t('account.me.language', { name: localeName($locale) })}<Icon name="chevron-right" size={18} /></a></li>{/if}
            {#if isAcc}<li><button type="button" class="rowbtn" on:click={() => window.dispatchEvent(new Event('ff-help'))}><Icon name="info" size={20} />{$t('shell.menu.help')}<Icon name="chevron-right" size={18} /></button></li>{/if}
            {#if isAcc && admin}<li><a href="/admin"><Icon name="shield" size={20} />{$t('shell.menu.admin')}<Icon name="chevron-right" size={18} /></a></li>{/if}
            {#if isAcc && admin}<li><a href="/diagnose" data-testid="me-diagnose"><Icon name="info" size={20} />{$t('diagnose.title')}<Icon name="chevron-right" size={18} /></a></li>{/if}
          </ul>
        </section>
      {/if}
    {/each}
  </div>

  {#if tvApp}<button type="button" class="out srv frost-btn" on:click={changeServer}><Icon name="tv" size={20} />{$t('shell.account.changeServer')}</button>{/if}
  <button type="button" class="out frost-btn" on:click={() => logout(me?.tv)}><Icon name="log-out" size={20} />{$t('account.me.logout')}</button>
</div>

<style>
  .me { max-width: 1000px; margin: 0 auto; }
  .prof { display: flex; align-items: center; gap: 1.1rem; padding: .6rem 0 1.2rem; }
  .face { width: 72px; height: 72px; flex: none; border-radius: 24%; display: grid; place-items: center; font-size: 2rem; font-weight: 800; box-shadow: 0 0 0 1px rgba(255,255,255,.12); background: linear-gradient(135deg, #ff6b81, #9a2440); }
  .who { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; gap: .1rem; }
  .who b { font-size: 1.4rem; line-height: 1.2; overflow-wrap: anywhere; }
  .sk { width: 9rem; height: 1.6rem; }
  .swap { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; color: var(--link); font-weight: 600; }
  .swap:hover { text-decoration: underline; }
  .tiles2 { list-style: none; margin: 0 0 1.6rem; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: .5rem; }
  @media (min-width: 721px) { .tiles2 { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); } }
  .tiles2 a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .45rem; min-height: 86px; padding: .5rem .25rem; font-size: .8rem; font-weight: 600; text-align: center; white-space: nowrap; transition: border-color var(--t-fast); }
  .tiles2 li { min-width: 0; }
  .tiles2 .tl { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .pl { display: flex; flex-wrap: wrap; column-gap: 1.2rem; }
  .rowbtn { width: 100%; display: flex; align-items: center; justify-content: flex-start; gap: .8rem; min-height: 48px; padding: .5rem 1rem; background: transparent; border-radius: 12px; font-weight: 400; color: inherit; transition: none; }
  .rowbtn:hover:not(:disabled) { background: var(--row-hover); }
  .rowbtn :global(svg:last-child) { margin-left: auto; color: var(--mut); }
  /* hover lights the edge, never the fill (more milk would cost the text its contrast) */
  .tiles2 a:hover { border-color: rgba(255,255,255,.42); }
  .ti { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,.08); }
  section { margin-bottom: 1.4rem; }
  .sech { display: flex; align-items: baseline; justify-content: space-between; }
  h2 { font-size: 1.1rem; font-weight: 700; margin: 0 0 .5rem; }
  .gh { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); margin: 0 0 .3rem .2rem; }
  .lnk { background: transparent; color: var(--link); padding: 0 .4rem; font-weight: 600; }
  .lnk:hover:not(:disabled) { background: transparent; text-decoration: underline; }
  .pad { padding: .4rem 0; margin: 0; }
  /* glass cards (glass spec §6); a row on hover: 12 px corners on a darker fill (a lighter one would cost the text its AA) */
  .notes, .lst { --row-hover: rgba(var(--fr-scrim-rgb), .3); list-style: none; margin: 0; padding: 6px; display: grid; gap: 2px; box-shadow: inset 0 1px 0 var(--fr-hi), var(--fr-shadow-card); }
  .notes a, .plainn, .lst a { display: flex; align-items: center; gap: .8rem; min-height: 48px; padding: .5rem 1rem; border-radius: 12px; }
  .notes a:hover, .lst a:hover { background: var(--row-hover); }
  .nt { flex: 1; min-width: 0; font-size: .93rem; }
  .nd { flex: none; width: 8px; height: 8px; border-radius: 50%; background: transparent; }
  .nd.unread { background: var(--acc); }
  li.muted { color: var(--mut); }
  .nsk { height: 120px; border-radius: var(--fr-r-tile); }
  .lst a :global(svg:last-child) { margin-left: auto; color: var(--mut); }
  .notes a :global(svg:last-child) { color: var(--mut); }
  .bleed { margin: 0 calc(var(--pad-x) * -1) 1.4rem; }
  .groups { display: grid; grid-template-columns: 1fr; gap: 0; }
  @media (min-width: 900px) { .groups { grid-template-columns: repeat(3, 1fr); gap: 1.2rem; align-items: start; } }
  .out { width: 100%; justify-content: flex-start; gap: .8rem; min-height: 52px; padding: 0 1.2rem; font-weight: 600; margin-top: .2rem; }
  .srv { margin-bottom: .6rem; }
  @media (min-width: 900px) { .out { width: auto; } }
</style>
