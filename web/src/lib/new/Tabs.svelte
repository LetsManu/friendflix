<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The tabs of the new-titles page (Für dich / Neu in der Bibliothek / Wünsche & demnächst): a tab list with roving focus
   * (Left / Right wrap and select, Home / End jump), a glass segment bar on the phone and an underlined list on the desktop. The
   * wishes tab carries the number of open requests. The page keeps the selected tab in the URL and renders the panel.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { t, type TKey } from '#lib/i18n';
  import { SCRIM_SAFE_DIM } from '#lib/glass/tone';
  import { tabKeyTarget, type NewTab } from '#lib/newpage';

  export let tabs: readonly NewTab[];
  export let value: NewTab;
  /** open requests (badge of the wishes tab); 0 = no badge */
  export let open = 0;
  /** short labels (phone) */
  export let short = false;
  /** id of the panel the selected tab controls */
  export let panel = 'np-panel';
  const dispatch = createEventDispatcher<{ change: NewTab }>();
  const LABEL: Record<NewTab, [TKey, TKey]> = {
    foryou: ['home.new.tabForYou', 'home.new.tabForYou'],
    library: ['home.new.tabLibrary', 'home.new.tabLibraryShort'],
    wishes: ['home.new.tabWishes', 'home.new.tabWishesShort'],
  };
  let list: HTMLElement;

  async function key(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const to = tabKeyTarget(e.key, value, tabs);
    if (!to) return;
    e.preventDefault();
    if (to !== value) dispatch('change', to);
    await tick();
    list.querySelector<HTMLElement>(`[data-tab="${to}"]`)?.focus();
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (the roving tab stop is on the selected entry; the container only receives the bubbling keys) -->
<div class="tabs" class:short class:frost={short} class:frost-pill={short} class:frost-safe={short} style={short ? `--fr-scrim-safe:${SCRIM_SAFE_DIM}` : undefined} role="tablist" aria-label={$t('home.new.tabs')} bind:this={list} on:keydown={key}>
  {#each tabs as tab (tab)}
    <button type="button" role="tab" id="np-tab-{tab}" class="tab" class:on={value === tab} data-tab={tab} aria-selected={value === tab} aria-controls={value === tab ? panel : undefined} tabindex={value === tab ? 0 : -1} on:click={() => value !== tab && dispatch('change', tab)}>
      <span>{$t(LABEL[tab][short ? 1 : 0])}</span>
      {#if tab === 'wishes' && open > 0}<span class="bd" aria-hidden="true">{open}</span><span class="sr-only">{$t('home.new.openCount', { n: open })}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .tabs { display: flex; gap: 2rem; box-sizing: border-box; border-bottom: 1px solid var(--fr-line); }
  .tab { position: relative; display: inline-flex; align-items: center; gap: .5rem; min-height: 48px; padding: 0 .1rem; background: transparent; border: 0; border-radius: 0; color: rgba(255, 255, 255, .78); font-size: 1rem; font-weight: 700; white-space: nowrap; }
  .tab:hover:not(:disabled) { background: transparent; color: #fff; }
  .tab.on, .tab.on:hover:not(:disabled) { color: #fff; }
  /* the underline slides by opacity only: every tab has its own */
  .tab::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 3px; border-radius: 3px 3px 0 0; background: var(--acc); opacity: 0; }
  .tab.on::after { opacity: 1; }
  .tab:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); border-radius: 8px; }
  .bd { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 6px; box-sizing: border-box; border-radius: 999px; background: var(--acc-fill); color: #fff; font-size: .78rem; font-weight: 800; line-height: 1; }
  /* phone: a glass segment bar, the selected segment is a white pill */
  .tabs.short { gap: 4px; padding: 6px; border-bottom: 0; display: flex; width: 100%; }
  .short .tab { flex: 1 1 0; justify-content: center; min-height: 44px; padding: 0 8px; border-radius: 999px; font-size: 15px; color: rgba(255, 255, 255, .9); }
  .short .tab::after { display: none; }
  .short .tab.on, .short .tab.on:hover:not(:disabled) { background: #fff; color: #111; }
  .short .bd { background: var(--acc-fill); }
  .short .tab:focus-visible { border-radius: 999px; }
  :global(html.tv) .tabs { display: none; }
</style>
