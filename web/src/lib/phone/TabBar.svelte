<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { t, type TKey } from '#lib/i18n';
  import { phoneTabs, type PhoneTab } from '#lib/phone/logic';

  /**
   * Phone tab bar (not kids): a floating glass pill above the home indicator with Home, New, My list and (where the
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

<nav class="tabbar" aria-label={$t('shell.mobile.tabbar')} style="--n:{tabs.length};--i:{Math.max(0, active)}">
  <span class="hl" class:off={active < 0} aria-hidden="true"></span>
  {#each tabs as tab, k (tab.key)}
    {@const full = $t(LABEL[tab.key][0])}
    {@const short = $t(LABEL[tab.key][1])}
    <a href={tab.href} class:active={k === active} aria-current={k === active ? 'page' : undefined} aria-label={short !== full ? full : undefined}><span class="ico"><Icon name={tab.icon} size={22} /></span><span>{short}</span></a>
  {/each}
</nav>

<style>
  .tabbar { display: none; }
  @media (max-width: 720px) {
    /* 60 px pill, 10 px above the home indicator: --tabbar-h (app.css) is the 70 px it takes above the safe area */
    .tabbar {
      display: flex; position: fixed; z-index: 60; left: 14px; right: 14px; bottom: calc(10px + var(--safe-bottom));
      box-sizing: border-box; height: 60px; padding: 5px; border-radius: 30px;
      background: rgba(22,22,26,.94); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 10px 30px rgba(0,0,0,.45);
    }
    :global(html.m-glass) .tabbar { background: rgba(22,22,26,.72); -webkit-backdrop-filter: blur(20px) saturate(1.5); backdrop-filter: blur(20px) saturate(1.5); }
    .hl {
      position: absolute; top: 5px; bottom: 5px; left: 5px; width: calc((100% - 10px) / var(--n)); border-radius: 24px;
      background: rgba(255,255,255,.13); pointer-events: none; transform: translateX(calc(var(--i) * 100%));
      transition: transform var(--m-d-spring) var(--m-spring), opacity var(--m-d-s) ease-out;
    }
    .hl.off { opacity: 0; }
    a {
      position: relative; flex: 1 1 0; min-width: 0; min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2px; padding: 0 2px; border-radius: 24px; font-size: .66rem; font-weight: 600; letter-spacing: -.005em; color: #9b9ba5; transition: color var(--m-d-s) ease-out;
    }
    a.active { color: #fff; }
    .ico { flex: none; width: 24px; height: 24px; display: grid; place-items: center; }
    span:not(.ico):not(.hl) { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    a:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
    :global(html.m-still) .hl, :global(html.m-still) .tabbar a { transition: none; }
  }
</style>
