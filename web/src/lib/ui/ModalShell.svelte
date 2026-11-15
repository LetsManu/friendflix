<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The frame of the small modal dialogs (confirm, name, delete role): a dimmed backdrop and a glass panel (frost, 24 px corners,
   * the glass shadow) that fades and rises 10 px into place and goes back the same way (`dialogBoth`: text never scales; calm mode
   * and reduced motion: at once). The page behind stays put (`lockScroll`, ref-counted, with the scrollbar's width padded). Tab
   * stays inside, Escape or a press on the backdrop asks to close (`close`), and the focus returns to `trigger` after a close.
   * The content (a form with its own title and buttons: the global `.dlg-title`, `.dlg-body`, `.dlg-err`, `.dlg-acts`) goes in the
   * slot; `aria-labelledby` / `aria-describedby` name ids inside it. The panel scrolls when it is taller than the window.
   * Mounted while open. `focus` picks the control that starts focused (none: the first focusable one; the owner may move it).
   * `locked` (a running save) ignores Escape and backdrop. Call `dismiss()` from a Cancel button for the same path.
   *   <ModalShell role="alertdialog" labelledby="x-t" focus="select" {trigger} on:close={cancel}> … </ModalShell>
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { dialogKeys, FOCUSABLE } from '#lib/actions';
  import { dialogBoth, scrimFade } from '#lib/glass/fx';
  import { lockScroll } from './scrollLock';

  export let role: 'dialog' | 'alertdialog' = 'dialog';
  export let labelledby: string;
  export let describedby: string | undefined = undefined;
  /** CSS selector of the control that starts focused (none: the first focusable control in the panel) */
  export let focus: string | null = null;
  /** gets the focus back after a close (the owner may also manage that itself) */
  export let trigger: HTMLElement | null = null;
  export let locked = false;
  /** stacking order of the backdrop */
  export let layer = 100;
  /** the panel's width in px (it never gets wider than the window) */
  export let width = 440;
  /** the panel, for owners that place focus themselves */
  export let box: HTMLElement | undefined = undefined;

  const dispatch = createEventDispatcher<{ close: void }>();
  export function dismiss() {
    if (locked) return;
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  onMount(() => {
    const unlock = lockScroll();
    box?.querySelector<HTMLElement>(focus ?? FOCUSABLE)?.focus({ preventScroll: true });
    return unlock;
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events (Escape is handled by dialogKeys) -->
<div class="ov" style:z-index={layer} transition:scrimFade role="presentation" on:click|self={dismiss}>
  <div class="dlg ff-dlg frost frost-panel frost-safe" style:--dlg-w="{width}px" {role} aria-modal="true" aria-labelledby={labelledby} aria-describedby={describedby} bind:this={box}
    transition:dialogBoth use:dialogKeys={{ close: dismiss }}>
    <slot />
  </div>
</div>

<style>
  /* one column as wide as the window (minus the gutter): long one-line texts inside cannot widen the panel past the screen */
  .ov { position: fixed; inset: 0; background: rgba(0, 0, 0, .6); display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: max(1rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); }
  /* the glass material, its 24 px corners and shadow come from .frost / .frost-panel / .frost-safe (app.css) */
  .dlg { width: min(var(--dlg-w), 100%); max-height: calc(100dvh - 2rem); overflow: auto; overscroll-behavior: contain; padding: 28px 28px 22px; }
  @media (max-width: 420px) { .dlg { padding: 24px 20px 16px; } }
  :global(html.m-still) .ov, :global(html.m-still) .ov :global(*) { transition: none !important; animation: none !important; }
</style>
