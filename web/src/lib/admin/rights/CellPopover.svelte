<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The editor of one matrix cell (spec §6.1): a small glass popover that grows out of the cell (`growBoth`) with the field's
   * control. Mounted while open (the matrix keys it by cell, so a new cell grows out of its own trigger). Edits are staged at
   * once (`change`); Escape or × closes and gives the focus back to the cell, a press outside closes and leaves the focus
   * where it went. Portaled to <body> and placed `fixed` next to the cell (kept there while the page or the panel scrolls).
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { growBoth } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { placePopover, placedStyle } from '#lib/popover';
  import { uid } from '#lib/ui/ids';
  import FieldControl from './FieldControl.svelte';
  import type { MatrixField } from './model';

  /** the cell it grows out of and returns the focus to */
  export let trigger: HTMLElement;
  /** "Gast · Altersfreigabe" */
  export let title: string;
  export let field: MatrixField;
  export let value: unknown;
  export let libraries: Array<{ id: string; name: string }> = [];

  const dispatch = createEventDispatcher<{ change: unknown; close: void }>();
  const id = uid('cp');
  /** popover width (px) */
  const W = 300;
  let panel: HTMLDivElement | undefined;
  let style = '';

  function place() {
    const r = trigger.getBoundingClientRect();
    const box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: Math.max(r.width, W) };
    style = placedStyle(placePopover(box, { w: window.innerWidth, h: window.innerHeight }, { wide: true }));
  }
  if (typeof window !== 'undefined') place(); // before the first paint: growBoth measures the placed box

  function close(refocus: boolean) {
    dispatch('close');
    if (refocus) void tick().then(() => { if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function onDoc(e: Event) {
    const n = e.target;
    if (n instanceof Node && (panel?.contains(n) || trigger.contains(n))) return;
    close(false);
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }

  onMount(() => {
    document.addEventListener('pointerdown', onDoc, true);
    void tick().then(() => panel?.querySelector<HTMLElement>('.ctl :is(select, input, button):not(:disabled)')?.focus({ preventScroll: true }));
  });
  onDestroy(() => { if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onDoc, true); });
</script>

<svelte:window on:resize={place} on:scroll|capture={(e) => { if (!panel?.contains(e.target as Node)) place(); }} />

<div class="cp frost frost-safe frost-menu" use:portal bind:this={panel} role="dialog" aria-labelledby="{id}-t" tabindex="-1"
  style="--fr-scrim-safe:{SCRIM_MENU};{style}" use:dialogKeys={{ close: () => close(true) }} transition:growBoth|global={{ trigger }}>
  <header>
    <h2 id="{id}-t">{title}</h2>
    <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={() => close(true)}><Icon name="x" size={18} /></button>
  </header>
  <div class="ctl"><FieldControl {field} {value} {libraries} on:change /></div>
</div>

<style>
  .cp { position: fixed; z-index: 88; box-sizing: border-box; overflow: auto; overscroll-behavior: contain; outline: none; padding: 10px 14px 14px; color: #fff; }
  header { display: flex; align-items: center; gap: .5rem; margin-bottom: .4rem; }
  h2 { flex: 1; min-width: 0; margin: 0; font-size: .95rem; font-weight: 700; overflow-wrap: anywhere; }
  /* the × is a 44 px target */
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; margin-right: -8px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .x:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  /* calm mode and reduced motion: nothing moves */
  :global(html.m-still) .cp { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .cp { transition: none !important; animation: none !important; } }
</style>
