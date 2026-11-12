<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The frame of the small modal dialogs (confirm, name, delete role): dimmed backdrop, glass panel, fade/scale in and out, Tab stays
   * inside, Escape or a press on the backdrop asks to close (`close`), and the focus returns to `trigger` after a close.
   * The content (a form with its own title and buttons) goes in the slot; `aria-labelledby` / `aria-describedby` name ids inside it.
   * Mounted while open. `locked` (a running save) ignores Escape and backdrop. Call `dismiss()` from a Cancel button for the same path.
   *   <ModalShell role="alertdialog" labelledby="x-t" focus="select" {trigger} on:close={cancel}> … </ModalShell>
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dialogKeys } from '#lib/actions';
  import { dur } from './motion';

  export let role: 'dialog' | 'alertdialog' = 'dialog';
  export let labelledby: string;
  export let describedby: string | undefined = undefined;
  /** CSS selector of the control that starts focused (none: the owner focuses it) */
  export let focus: string | null = null;
  /** gets the focus back after a close (the owner may also manage that itself) */
  export let trigger: HTMLElement | null = null;
  export let locked = false;
  /** stacking order of the backdrop */
  export let layer = 100;
  /** the panel, for owners that place focus themselves */
  export let box: HTMLElement | undefined = undefined;

  const dispatch = createEventDispatcher<{ close: void }>();
  export function dismiss() {
    if (locked) return;
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  onMount(() => { if (focus) box?.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true }); });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events (Escape is handled by dialogKeys) -->
<div class="ov" style:z-index={layer} transition:fade={{ duration: dur(140) }} role="presentation" on:click|self={dismiss}>
  <div class="dlg" {role} aria-modal="true" aria-labelledby={labelledby} aria-describedby={describedby} bind:this={box}
    in:scale={{ start: .96, duration: dur(160) }} use:dialogKeys={{ close: dismiss }}>
    <slot />
  </div>
</div>

<style>
  .ov { position: fixed; inset: 0; background: rgba(0, 0, 0, .7); display: grid; place-items: center; padding: max(1rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); }
  .dlg { width: min(460px, 100%); background: #1b2127; border: 1px solid #323a43; border-radius: 12px; padding: 1.4rem 1.4rem 1.2rem; box-shadow: var(--shadow-pop); }
  :global(html.m-still) .ov, :global(html.m-still) .ov :global(*) { transition: none !important; animation: none !important; }
</style>
