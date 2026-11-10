<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The Alles / Serien / Filme control of the new-titles page: a glass segment bar (a solid panel on TV) with a radio group's
   * keys (Left / Right move and select, Home / End jump; one Tab stop on the selected entry). On a TV the D-pad moves the focus
   * between the entries and OK selects. The page keeps the value in the URL.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { t, type TKey } from '#lib/i18n';
  import { SCRIM_SAFE_DIM } from '#lib/glass/tone';
  import { filterKeyTarget, NEW_FILTERS, type NewFilter } from '#lib/newpage';

  export let value: NewFilter;
  /** phone: separate chips instead of a full-width segment bar */
  export let chips = false;
  const dispatch = createEventDispatcher<{ change: NewFilter }>();
  const LABEL: Record<NewFilter, TKey> = { all: 'home.new.all', series: 'home.new.series', movie: 'home.new.movies' };
  let bar: HTMLElement;

  async function key(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const to = filterKeyTarget(e.key, value);
    if (!to) return;
    e.preventDefault();
    if (to !== value) dispatch('change', to);
    await tick();
    bar.querySelector<HTMLElement>(`[data-f="${to}"]`)?.focus();
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (the roving tab stop is on the selected entry; the container only receives the bubbling keys) -->
<div class="seg frost frost-pill frost-safe" class:chips style="--fr-scrim-safe:{SCRIM_SAFE_DIM}" role="radiogroup" aria-label={$t('home.new.filter')} bind:this={bar} on:keydown={key}>
  {#each NEW_FILTERS as f (f)}
    <button type="button" role="radio" class="s" class:on={value === f} data-f={f} aria-checked={value === f} tabindex={value === f ? 0 : -1} on:click={() => value !== f && dispatch('change', f)}>{$t(LABEL[f])}</button>
  {/each}
</div>

<style>
  .seg { display: inline-flex; box-sizing: border-box; gap: 4px; padding: 6px; max-width: 100%; }
  .s { position: relative; flex: 1 0 auto; height: 44px; min-height: 44px; padding: 0 22px; background: transparent; border: 0; border-radius: 999px; color: rgba(255, 255, 255, .9); font-size: 15px; font-weight: 700; white-space: nowrap; }
  .s:hover:not(:disabled) { background: transparent; color: #fff; }
  .s.on, .s.on:hover:not(:disabled) { background: #fff; color: #111; }
  .s:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px var(--ring-dark); }
  :global(html.tv) .seg { gap: 8px; padding: 8px; }
  :global(html.tv) .s { height: 56px; min-height: 56px; padding: 0 28px; font-size: 1.375rem; }
  :global(html.tv) .s:focus-visible { outline: 3px solid var(--tv-ring); outline-offset: 3px; box-shadow: none; }
  @media (max-width: 720px) { .seg { display: flex; width: 100%; } .s { flex: 1 1 0; padding: 0 8px; } }
  /* phone chips: each filter is its own pill, the bar itself has no glass */
  .seg.chips { background: none; border: 0; box-shadow: none; padding: 0; gap: 8px; width: auto; -webkit-backdrop-filter: none; backdrop-filter: none; }
  .seg.chips::before, .seg.chips::after { display: none; }
  .chips .s { flex: 0 0 auto; padding: 0 20px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); background: rgba(var(--fr-scrim-rgb), .5); }
  .chips .s.on, .chips .s.on:hover:not(:disabled) { background: #fff; }
</style>
