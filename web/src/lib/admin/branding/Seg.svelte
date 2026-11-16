<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" generics="T extends string">
  /**
   * A segmented choice of Admin → Branding (the mockup's `.seg`): a radiogroup with a visible label, arrow keys move the choice
   * (roving tabindex), 44 px targets, the chosen segment light. Colours switch at once (only transform / opacity animate).
   *   <Seg label={$t('…')} options={[{ value: 'a', label: 'A' }]} value={v} on:change={(e) => (v = e.detail)} />
   */
  import { createEventDispatcher } from 'svelte';
  import { uid } from '#lib/ui/ids';

  export let label: string;
  export let options: ReadonlyArray<{ value: T; label: string }>;
  export let value: T;
  const dispatch = createEventDispatcher<{ change: T }>();
  const id = uid('seg');
  let btns: HTMLButtonElement[] = [];

  function key(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + options.length) % options.length;
    btns[j]?.focus();
    dispatch('change', options[j]!.value);
  }
</script>

<div class="wrap">
  <span class="lab" id={id}>{label}</span>
  <div class="seg" role="radiogroup" aria-labelledby={id}>
    {#each options as o, i (o.value)}
      <button type="button" role="radio" aria-checked={value === o.value} tabindex={value === o.value ? 0 : -1} class:on={value === o.value} bind:this={btns[i]}
        on:click={() => dispatch('change', o.value)} on:keydown={(e) => key(e, i)}>{o.label}</button>
    {/each}
  </div>
</div>

<style>
  .wrap { display: grid; gap: .5rem; justify-items: start; min-width: 0; }
  .lab { font-size: .9rem; font-weight: 700; color: rgba(255, 255, 255, .85); }
  .seg { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; max-width: 100%; border-radius: 26px; background: rgba(255, 255, 255, .06); border: 1px solid var(--fr-line, rgba(255, 255, 255, .2)); }
  .seg button { min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: var(--fr-r-pill); border: 0; background: transparent; color: rgba(255, 255, 255, .8); font-weight: 600; font-size: .88rem; }
  .seg button:hover:not(.on) { background: rgba(255, 255, 255, .08); }
  .seg button.on { background: #f5f5f5; color: #101418; }
</style>
