<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The right-hand glass sheet of the *Kanäle* tab (the frame of StreamSheet): scrim, slide in and out (`sheetSlide`, both ways), the
   * title with a close button (≥ 44 px), Escape and Tab kept inside (`dialogKeys`), the body in the default slot. The focus starts on
   * the sheet and goes back to `returnTo()` once it is closed. The caller removes it on `close`.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { uid } from '#lib/ui/ids';

  export let title: string;
  /** the element the focus returns to on close (looked up then, so a re-rendered row still works) */
  export let returnTo: (() => HTMLElement | null) | null = null;

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = uid('chs');
  let panel: HTMLDivElement | undefined;
  onMount(() => panel?.focus({ preventScroll: true }));

  function close() {
    dispatch('close');
    void tick().then(() => returnTo?.()?.focus({ preventScroll: true }));
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: 'right' }));
</script>

<div class="cs-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={close} transition:scrimFade|global></div>
  <div class="cs frost frost-safe frost-sheet" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close }} transition:slide|global>
    <header>
      <h2 id="{id}-t">{title}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={close}><Icon name="x" size={20} /></button>
    </header>
    <div class="body"><slot {close} /></div>
  </div>
</div>

<style>
  .cs-wrap { position: fixed; inset: 0; z-index: 90; }
  .cs { position: absolute; top: 0; right: 0; bottom: 0; box-sizing: border-box; width: min(480px, 100%); display: flex; flex-direction: column; outline: none; color: #fff;
    border-right: 0; border-radius: var(--fr-r-sheet) 0 0 var(--fr-r-sheet); padding: 14px 0 0; }
  header { flex: none; display: flex; align-items: center; gap: .5rem; padding: 0 18px .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; overflow-wrap: anywhere; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: .4rem 18px calc(18px + var(--safe-bottom, 0px)); display: flex; flex-direction: column; gap: 1rem; }
  :global(html.m-still) .cs-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .cs-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
