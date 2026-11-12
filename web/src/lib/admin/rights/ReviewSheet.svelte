<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Änderungen prüfen* (spec §6.1): a glass sheet sliding up (`sheetSlide`, the page dimmed behind) that lists every staged
   * change ("Gast · Altersfreigabe: ab 12 → ab 16") and, when the media server's policy is re-applied, what follows; then
   * *Speichern*. A modal dialog: Tab stays inside, Escape or a press on the dimmed page closes it, the focus goes back to
   * `trigger` (on *Speichern* the page decides where it goes). Mounted while open.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { sheetRoom } from '#lib/glass/sheetRoom';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { uid } from '#lib/ui/ids';

  export let lines: Array<{ role: string; field: string; from: string; to: string }>;
  /** the policy sentence, or null when no media server field changes */
  export let policy: string | null = null;
  /** the button it came from (the focus returns there on close) */
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ save: void; close: void }>();
  const id = uid('rv');
  let panel: HTMLDivElement | undefined;

  function close() {
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir }));
  onMount(() => { panel?.focus({ preventScroll: true }); });
</script>

<div class="rv-wrap" use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={close} transition:scrimFade|global></div>
  <div class="rv frost frost-safe frost-sheet" bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close }} use:sheetRoom transition:slide|global>
    <header>
      <h2 id="{id}-t">{$t('adminPeople.roles.review')}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} on:click={close}><Icon name="x" size={20} /></button>
    </header>
    <ul>
      {#each lines as l, i (i)}
        <li>{$t('adminPeople.roles.reviewLine', l)}</li>
      {/each}
    </ul>
    {#if policy}<p class="pol"><Icon name="info" size={18} /><span>{policy}</span></p>{/if}
    <footer>
      <Button variant="ghost" on:click={close}>{$t('common.cancel')}</Button>
      <Button on:click={() => dispatch('save')}>{$t('adminPeople.roles.save')}</Button>
    </footer>
  </div>
</div>

<style>
  .rv-wrap { position: fixed; inset: 0; z-index: 90; }
  .rv { position: absolute; left: 0; right: 0; bottom: 0; box-sizing: border-box; max-width: 640px; max-height: 82vh; margin: 0 auto; overflow: auto; overscroll-behavior: contain;
    outline: none; color: #fff; border-bottom: 0; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding: 14px 18px calc(16px + var(--safe-bottom, 0px)); }
  header { display: flex; align-items: center; gap: .5rem; margin-bottom: .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  li { padding: .55rem .2rem; border-bottom: 1px solid rgba(255, 255, 255, .1); overflow-wrap: anywhere; }
  .pol { display: flex; gap: .55rem; align-items: flex-start; margin: .9rem 0 0; color: rgba(255, 255, 255, .9); }
  .pol :global(svg) { flex: none; margin-top: .15rem; }
  footer { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1rem; flex-wrap: wrap; }
  /* calm mode and reduced motion: nothing moves */
  :global(html.m-still) .rv-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .rv-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
