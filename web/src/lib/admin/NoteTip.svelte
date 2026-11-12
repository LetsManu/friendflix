<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The admin's note of a person: a button (44 px on touch) that opens a small popover with the text. Opens on click, tap, Enter
   * and Space; Escape, a press outside, a scroll or leaving the button with Tab closes it. The popover is `fixed` next to the
   * button (the table clips overflow), opens above it when there is no room below, and grows out of the button and back
   * (growBoth: opacity and transform only; calm mode and reduced motion make it instant or a fade).
   */
  import { onDestroy, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { growBoth } from '#lib/glass/fx';
  import { t } from '#lib/i18n';
  import { placePopover, placedStyle } from '#lib/popover';
  import { uid } from '#lib/ui/ids';

  export let note: string;
  const id = uid('nt');
  let open = false, btn: HTMLButtonElement | undefined, pop: HTMLSpanElement | undefined, style = '';

  function place() {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    style = placedStyle(placePopover({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: 280 }, { w: window.innerWidth, h: window.innerHeight }, { wide: true }));
  }
  const off = () => { document.removeEventListener('pointerdown', onDoc, true); window.removeEventListener('scroll', hide, true); };
  function hide() { open = false; off(); }
  function onDoc(e: Event) { if (e.target instanceof Node && !btn?.contains(e.target) && !pop?.contains(e.target)) hide(); }
  async function toggle() {
    if (open) { hide(); return; }
    place(); open = true;
    await tick();
    document.addEventListener('pointerdown', onDoc, true);
    window.addEventListener('scroll', hide, true);
  }
  function key(e: KeyboardEvent) { if (e.key === 'Escape' && open) { e.stopPropagation(); hide(); btn?.focus(); } }
  onDestroy(() => { if (typeof document !== 'undefined') off(); });
</script>

<span class="nt" on:keydown={key} role="presentation">
  <button type="button" class="b" bind:this={btn} aria-expanded={open} aria-controls={id} aria-label={$t('adminPeople.users.noteLabel')} on:click={toggle} on:blur={(e) => { if (!pop?.contains(e.relatedTarget as Node | null)) hide(); }}>
    <Icon name="message" size={14} />
  </button>
  {#if open}<span class="pop" {id} role="note" bind:this={pop} {style} transition:growBoth|global={{ trigger: btn }}>{note}</span>{/if}
</span>

<style>
  .nt { display: inline-flex; }
  /* the hit area is 44 px on every pointer; the visible disc stays 28 px (the ::before) */
  .b { position: relative; margin: -8px; min-height: 44px; min-width: 44px; padding: 0; background: transparent; color: var(--mut); border-radius: 50%; display: inline-grid; place-items: center; }
  .b::before { content: ''; position: absolute; inset: 50% auto auto 50%; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; }
  .b > :global(*) { position: relative; }
  .b:hover:not(:disabled) { background: transparent; color: var(--fg); }
  .b:hover:not(:disabled)::before { background: rgba(255, 255, 255, .08); }
  .pop { position: fixed; z-index: 40; box-sizing: border-box; padding: .6rem .8rem; border-radius: 8px; background: var(--fr-solid); color: var(--fg); border: 1px solid var(--line); font-size: .9rem; font-weight: 400; overflow-wrap: anywhere; white-space: pre-wrap; overflow: auto; overscroll-behavior: contain; }
  :global(html.m-still) .pop { transition: none; animation: none; }
</style>
