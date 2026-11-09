<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Button with the kit's variants (docs/ui-kit.md). Renders <a> when `href` is set.
   *   <Button variant="danger" pending={busy} on:click={remove} icon="x">{$t('ui.confirm.delete')}</Button>
   * `pending`: spinner, aria-busy, disabled (the label stays so the width does not jump).
   * `done`: a save went through: the label becomes "Saved" with a drawn checkmark (glass spec §8.8; the caller resets it after
   * 2.2 s). The check's `stroke-dashoffset` runs 24 → 0 in 420 ms (GLASS_OUT); calm mode and reduced motion: drawn at once.
   */
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { fxMode } from '#lib/glass/fx';
  import { GLASS_OUT } from '#lib/tv/motion';
  export let variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'primary';
  export let pending = false;
  export let disabled = false;
  export let type: 'button' | 'submit' | 'reset' = 'button';
  export let href: string | undefined = undefined;
  /** name from Icon.svelte, shown before the label */
  export let icon = '';
  export let size: 'md' | 'sm' = 'md';
  /** full width */
  export let block = false;
  /** a solid red danger button (the confirm button of a dialog) */
  export let solid = false;
  export let done = false;
  let cls = '';
  export { cls as class };
  const guard = (e: MouseEvent) => { if (pending) { e.preventDefault(); e.stopImmediatePropagation(); } };
  /** draws the check (the named exception: a 20 px path's stroke-dashoffset) */
  function draw(el: SVGPathElement) {
    if (fxMode() !== 'still') el.animate([{ strokeDashoffset: '24' }, { strokeDashoffset: '0' }], { duration: 420, easing: GLASS_OUT });
  }
  $: klass = ['ui-btn', done ? 'done' : '', variant === 'secondary' ? 'sec' : variant === 'primary' ? '' : variant, size === 'sm' ? 'sm' : '', block ? 'block' : '', solid ? 'solid' : '', cls].filter(Boolean).join(' ');
</script>

{#if href && !disabled}
  <a {href} class="btn {klass}" {...$$restProps} on:click>{#if icon}<Icon name={icon} size={18} />{/if}<slot /></a>
{:else}
  <!-- pending keeps focus (aria-disabled instead of disabled) and swallows clicks before any on:click handler runs -->
  <button {type} class={klass} {disabled} aria-disabled={pending ? 'true' : undefined} aria-busy={pending ? 'true' : undefined} {...$$restProps} on:click|capture={guard} on:click>
    {#if done}<svg class="chk" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" use:draw /></svg>{$t('common.saved')}
    {:else}{#if pending}<span class="spinner" aria-hidden="true"></span>{:else if icon}<Icon name={icon} size={18} />{/if}<slot />{/if}
  </button>
{/if}

<style>
  .sm { min-height: 36px; padding: .35rem .8rem; font-size: .9rem; }
  @media (pointer: coarse) { .sm { min-height: 44px; } }
  .block { width: 100%; }
  [aria-disabled='true'] { opacity: .75; }
  /* saved: white with the green drawn check (#1a8f4c on white) */
  /* the fill switches at once (the global button rule transitions background; only transform / opacity may animate) */
  .done, .done:hover:not(:disabled) { background: #fff; color: #111; box-shadow: none; transition: transform var(--t-fast), opacity var(--t-fast); }
  .chk { flex: none; fill: none; stroke: #1a8f4c; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
  .chk path { stroke-dasharray: 24; stroke-dashoffset: 0; }
  :global(html.tv) .sm { min-height: 48px; }
</style>
