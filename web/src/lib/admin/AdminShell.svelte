<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin frame: grouped sidebar (≥900px), page header with breadcrumb + <h1> + per-page <title>, pending badges from
   * /api/admin/summary. Phone: /admin is a grouped list (like /me), sub-pages get a back chevron to /admin.
   * Pages render only their content; they must not add their own <h1> or <title>.
   */
  import { onMount } from 'svelte';
  import { pageStore } from '#lib/page';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { GROUPS, OVERVIEW, activeItem, badgeCount, badgeTone, chipShown, groupOf } from './nav';
  import { navGuess, navShown, rememberNav } from './livetv/state';
  import { refreshSummary, summary } from './summary';
  import { features, linkShown, serverCaps } from '#lib/capabilities';
  import { perms } from '#lib/perms';
  import SlidePill from '#lib/glass/SlidePill.svelte';

  const page = pageStore();
  $: item = activeItem($page.url.pathname);
  $: group = groupOf(item);
  $: overview = item === OVERVIEW;
  $: title = item && !overview ? $t(item.label) : $t('admin.title');
  // entries of a service this instance has not set up (e.g. requests) are left out
  $: groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => linkShown($serverCaps, i.href, $features, $perms) && (!isLt(i.href) || ($summary ? navShown($summary) : guess))) }));

  // the Live-TV row: until the summary is there a placeholder of the same height stands in by the last known answer, so nothing below shifts
  const guess = navGuess();
  $: if ($summary) rememberNav(navShown($summary));
  const isLt = (href: string) => href === '/admin/livetv';

  let sideEl: HTMLElement | undefined;

  onMount(() => {
    void refreshSummary();
    const iv = setInterval(() => { if (document.visibilityState === 'visible') void refreshSummary(); }, 60_000);
    return () => clearInterval(iv);
  });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: overview ? $t('admin.title') : `${title} · ${$t('admin.title')}` })}</title></svelte:head>

<div class="adm" class:overview>
  <aside class="side frost-flat frost-panel frost-text" bind:this={sideEl}>
    <!-- the light pill glides to the current page (glass spec §7); entries sit above it -->
    <SlidePill host={sideEl} selector={'.ni[aria-current="page"]'} tone="light" />
    <nav aria-label={$t('admin.nav.label')}>
      <a class="ni fill-hover" href={OVERVIEW.href} aria-current={overview ? 'page' : undefined}><Icon name={OVERVIEW.icon} size={20} /><span class="nl">{$t(OVERVIEW.label)}</span></a>
      {#each groups as g (g.id)}
        <h2 class="gh" id="adm-g-{g.id}">{$t(g.label)}</h2>
        <ul aria-labelledby="adm-g-{g.id}">
          {#each g.items as it (it.href)}
            {@const n = badgeCount($summary, it.badge)}
            {#if isLt(it.href) && !$summary}
              <li class="ph" aria-hidden="true"></li>
            {:else}
            <li>
              <a class="ni fill-hover" href={it.href} aria-current={item === it ? 'page' : undefined}>
                <Icon name={it.icon} size={20} /><span class="nl">{$t(it.label)}</span>{#if chipShown($summary, it)}<span class="chip">{$t(it.chip!)}</span>{/if}
                {#if n && it.badge}<span class="cnt {badgeTone(it.badge)}" aria-hidden="true">{n}</span><span class="sr-only">({badgeTone(it.badge) === 'err' ? $t('admin.nav.failing', { n }) : $t('admin.nav.pending', { n })})</span>{/if}
              </a>
            </li>
            {/if}
          {/each}
        </ul>
      {/each}
    </nav>
  </aside>

  <div class="body">
    <header class="ah">
      {#if !overview}<a class="back" href="/admin" aria-label={$t('admin.nav.back')}><Icon name="chevron-left" size={24} /></a>{/if}
      <div class="ht">
        {#if !overview && group}<p class="crumb"><a href="/admin">{$t('admin.title')}</a><Icon name="chevron-right" size={14} /><span>{$t(group.label)}</span></p>{/if}
        <h1>{title}</h1>
      </div>
    </header>

    {#if overview}
      <!-- phone: the admin index is a grouped list (same look as /me); hidden next to the sidebar -->
      <nav class="plist" aria-label={$t('admin.nav.label')}>
        {#each groups as g (g.id)}
          <section aria-labelledby="adm-p-{g.id}">
            <h2 class="pgh" id="adm-p-{g.id}">{$t(g.label)}</h2>
            <ul class="lst frost-flat frost-text">
              {#each g.items as it (it.href)}
                {@const n = badgeCount($summary, it.badge)}
                {#if isLt(it.href) && !$summary}<li class="ph" aria-hidden="true"></li>{:else}
                <li><a class="fill-hover" href={it.href}><Icon name={it.icon} size={20} /><span class="nl">{$t(it.label)}</span>{#if chipShown($summary, it)}<span class="chip">{$t(it.chip!)}</span>{/if}
                  {#if n && it.badge}<span class="cnt {badgeTone(it.badge)}" aria-hidden="true">{n}</span><span class="sr-only">({badgeTone(it.badge) === 'err' ? $t('admin.nav.failing', { n }) : $t('admin.nav.pending', { n })})</span>{/if}
                  <Icon name="chevron-right" size={18} /></a></li>
                {/if}
              {/each}
            </ul>
          </section>
        {/each}
      </nav>
    {/if}

    <div class="content"><slot /></div>
  </div>
</div>

<style>
  /* the remaining plain surfaces (empty / error states, the sticky bulk bar) take the glass's solid colour, separators the
     glass hairline */
  .adm { --surface: var(--fr-solid); --line: rgba(255, 255, 255, .1); display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; max-width: 1400px; margin: 0 auto; }
  .side { display: none; }
  .body { min-width: 0; }
  .content { min-width: 0; }

  /* page header */
  .ah { display: flex; align-items: center; gap: .6rem; margin: 0 0 1.2rem; min-height: 44px; }
  .ht { min-width: 0; }
  h1 { margin: 0; font-size: clamp(1.45rem, 2.4vw, 1.9rem); font-weight: 800; letter-spacing: -.02em; overflow-wrap: anywhere; }
  .crumb { display: none; margin: 0 0 .15rem; color: var(--mut); font-size: .85rem; align-items: center; gap: .3rem; }
  .crumb a:hover { color: var(--fg); text-decoration: underline; }
  .back { display: grid; place-items: center; width: 44px; height: 44px; flex: none; margin-left: -.5rem; border-radius: 50%; color: var(--fg); }
  .back:hover { background: rgba(255,255,255,.08); }

  /* sidebar: a glass panel (frost-flat, no blur: a static card) with the sliding light pill on the current page. Links are
     white .75 (the mockup's nav level), the current one white on the pill; hover fades in a darker fill (.fill-hover: only
     adds contrast, lib/admin/glass.test.ts). The entries' offsetParent is .side itself (nothing between them is positioned),
     the box SlidePill draws in. One weight for every entry: the label does not change width under the gliding pill. */
  .gh { margin: 1.1rem 0 .3rem .9rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); }
  .side ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .ni { position: relative; z-index: 1; display: flex; align-items: center; gap: .75rem; min-height: 44px; padding: .45rem .9rem; border-radius: 14px; color: rgba(255, 255, 255, .75); font-weight: 600; font-size: .92rem; }
  .ni:hover { color: #fff; }
  .ni[aria-current='page'] { color: #fff; }
  .ni[aria-current='page']::after { opacity: 0; }
  .nl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cnt { flex: none; min-width: 1.5rem; height: 1.5rem; padding: 0 .4rem; border-radius: 99px; display: inline-grid; place-items: center; font-size: .75rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  /* a word, not a colour: the small "optional" tag after the label */
  .chip { flex: none; font-size: .7rem; font-weight: 700; letter-spacing: .02em; padding: .1rem .5rem; border-radius: 99px; border: 1px solid currentColor; white-space: nowrap; }
  .side .ph { min-height: 44px; }
  .lst .ph { min-height: 48px; }
  .cnt.warn { background: var(--warn); color: #1a1200; }
  .cnt.err { background: var(--err); color: #200; }

  /* phone list (like /me): one glass card per group, rows 12 px corners with a darker hover (.fill-hover) */
  .plist { margin-bottom: 1.6rem; }
  .plist section { margin-bottom: 1.2rem; }
  .pgh { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); margin: 0 0 .3rem .2rem; font-weight: 700; }
  .lst { list-style: none; margin: 0; padding: 6px; display: grid; gap: 2px; }
  .lst a { display: flex; align-items: center; gap: .8rem; min-height: 48px; padding: .5rem 1rem; border-radius: 12px; }
  .lst a > :global(svg:last-child) { color: var(--mut); }

  /* the dense admin look (glass spec §7): cards, tiles and lists 16 px corners, 16 px 18 px padding */
  .adm :global(.panel), .adm :global(.tile.frost-flat), .adm :global(.lst) { border-radius: 16px; }
  .adm :global(.panel), .adm :global(.tile.frost-flat) { padding: 16px 18px; }

  @media (min-width: 900px) {
    .adm { grid-template-columns: 248px minmax(0, 1fr); gap: 2rem; }
    .side { display: block; position: sticky; top: calc(var(--nav-total) + 1rem); align-self: start; max-height: calc(100vh - var(--nav-total) - 2rem); overflow-y: auto; overscroll-behavior: contain; padding: 10px; border-radius: var(--fr-r-panel); }
    .plist, .back { display: none; }
    .crumb { display: flex; }
  }
  :global(html.tv) .ni { min-height: 52px; font-size: 1.05rem; }
</style>
