<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { t, type TKey } from '#lib/i18n';
  import { phoneTabs, type PhoneTab } from '#lib/phone/logic';
  import { press } from '#lib/glass/press';
  import { SCRIM_TAB } from '#lib/glass/tone';
  import { features } from '#lib/capabilities';

  /**
   * Phone tab bar (not kids): a floating glass pill (the glass material with its own safe scrim, SCRIM_TAB: the inactive labels
   * at white .72 and the active one on the light pill pass AA over pure white, as posters and artwork scroll under it; glass
   * spec §6, press feedback §8.9) above the home indicator with Home, New, My list and (where the
   * account may download) Downloads. A highlight springs to the active tab (transform only). Visible only on phones;
   * hidden on wider screens here and in TV mode by app.css (`html.tv .tabbar`).
   */
  export let path: string;
  export let canDownload: boolean;

  /** full name (accessible name) and the short visible label that fits a quarter of a 320 px pill */
  const LABEL: Record<PhoneTab['key'], [TKey, TKey]> = {
    home: ['shell.tabs.home', 'shell.tabs.home'],
    new: ['shell.tabs.new', 'shell.tabs.newShort'],
    myList: ['shell.tabs.myList', 'shell.tabs.myList'],
    downloads: ['shell.tabs.downloads', 'shell.tabs.downloadsShort'],
  };
  const isOn = (href: string, p: string) => (href === '/' ? p === '/' : p === href || p.startsWith(href + '/'));

  $: tabs = phoneTabs(canDownload);
  $: active = tabs.findIndex((tab) => isOn(tab.href, path));
</script>

<nav class="tabbar frost frost-pill frost-safe" aria-label={$t('shell.mobile.tabbar')} style="--n:{tabs.length};--i:{Math.max(0, active)};--fr-scrim-safe:{SCRIM_TAB}">
  <span class="hl" class:off={active < 0} aria-hidden="true"></span>
  {#each tabs as tab, k (tab.key)}
    {@const only = tab.key === 'new' && !$features.requests}
    {@const full = $t(only ? 'shell.tabs.newOnly' : LABEL[tab.key][0])}
    {@const short = $t(only ? 'shell.tabs.newOnly' : LABEL[tab.key][1])}
    <a href={tab.href} use:press class:active={k === active} aria-current={k === active ? 'page' : undefined} aria-label={short !== full ? full : undefined}><span class="ico"><Icon name={tab.icon} size={22} /></span><span>{short}</span></a>
  {/each}
</nav>

<style>
  .tabbar { display: none; }
  @media (max-width: 720px) {
    /* 60 px pill, 10 px above the home indicator: --tabbar-h (app.css) is the 70 px it takes above the safe area */
    .tabbar {
      display: flex; position: fixed; z-index: 60; left: 14px; right: 14px; bottom: calc(10px + var(--safe-bottom));
      box-sizing: border-box; height: 60px; padding: 5px;
    }
    .hl {
      position: absolute; top: 5px; bottom: 5px; left: 5px; width: calc((100% - 10px) / var(--n)); border-radius: 24px;
      background: var(--fr-sel); pointer-events: none; /* the light pill (.13): the white label stays AA on it (lib/glass/pages.test.ts) */ transform: translateX(calc(var(--i) * 100%));
      transition: transform var(--m-d-spring) var(--m-spring), opacity var(--m-d-s) ease-out;
    }
    .hl.off { opacity: 0; }
    a {
      position: relative; flex: 1 1 0; min-width: 0; min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2px; padding: 0 2px; border-radius: 24px; font-size: .66rem; font-weight: 600; letter-spacing: -.005em; color: rgba(255,255,255,.72);
    }
    a.active { color: #fff; }
    .ico { flex: none; width: 24px; height: 24px; display: grid; place-items: center; }
    span:not(.ico):not(.hl) { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    a:focus-visible { outline: 2px solid #fff; outline-offset: -2px; box-shadow: inset 0 0 0 4px var(--ring-dark), 0 0 0 2px var(--ring-dark); }
    :global(html.m-still) .hl, :global(html.m-still) .tabbar a { transition: none; }
  }
</style>
