<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  /** the room (px) the layout keeps free for the bar at the page's end (`--savebar-h`): the bar plus the gaps around it */
  export const SAVEBAR_H = { desktop: 96, phone: 148 } as const;
</script>

<script lang="ts">
  /**
   * The save bar of staged rights (spec §6.1): a glass bar at the bottom while something is staged, saving or failed. It sets
   * `--savebar-h` on <html> before it rises in (`barRise`), so pages that pad their end by it never move, and clears it once it
   * has gone. A named region ("Ungespeicherte Änderungen"); the count, the progress and an error are announced politely.
   *   <SaveBar count={c.changes} text={saveBarText(c)} {busy} {progress} {error} on:discard on:review on:retry />
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { BAR_OUT_MS, barRise } from '#lib/glass/fx';
  import { SCRIM_BAR } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { MOBILE_QUERY } from '#lib/viewport';

  /** staged changes */
  export let count: number;
  /** "3 Änderungen in 2 Rollen · betrifft 11 Personen" */
  export let text: string;
  /** a save runs */
  export let busy: boolean;
  /** "Aktualisiere 1 von 2 …" while saving */
  export let progress: string | null;
  /** what went wrong; the bar offers *Erneut anwenden* */
  export let error: string | null;

  const dispatch = createEventDispatcher<{ discard: void; review: void; retry: void }>();
  let box: HTMLDivElement | undefined;

  $: shown = count > 0 || busy || progress !== null || error !== null;
  $: line = progress ?? error ?? text;

  let clearing: ReturnType<typeof setTimeout> | undefined;
  function reserve(on: boolean) {
    if (typeof document === 'undefined') return;
    clearTimeout(clearing);
    const st = document.documentElement.style;
    if (on) st.setProperty('--savebar-h', `${typeof matchMedia !== 'undefined' && matchMedia(MOBILE_QUERY).matches ? SAVEBAR_H.phone : SAVEBAR_H.desktop}px`);
    // the room goes once the bar has gone down (its outro); a bar shown again meanwhile keeps it
    else clearing = setTimeout(() => { if (!shown) st.removeProperty('--savebar-h'); }, BAR_OUT_MS + 40);
  }
  // reactive statements run before the DOM update: the room is there before the bar is inserted and rises in
  $: reserve(shown);
  onDestroy(() => { clearTimeout(clearing); if (typeof document !== 'undefined') document.documentElement.style.removeProperty('--savebar-h'); });

  /** moves the focus into the bar (after the review sheet saved: its button has gone) */
  export function focus(): void { box?.focus({ preventScroll: true }); }
</script>

<p class="sr-only" aria-live="polite">{shown ? line : ''}</p>
{#if shown}
  <div class="sb-wrap">
    <div class="sb frost frost-safe frost-panel" style="--fr-scrim-safe:{SCRIM_BAR}" role="region" aria-label={$t('adminPeople.roles.unsavedRegion')} tabindex="-1"
      bind:this={box} in:barRise out:barRise={{ dir: 'out' }}>
      <p class="tx" class:err={error !== null && !busy}>
        {#if busy}<span class="spinner" aria-hidden="true"></span>{:else if error !== null}<Icon name="alert" size={18} />{/if}
        <span class="l">{line}</span>
      </p>
      {#if !busy}
        <div class="acts">
          {#if count > 0}
            <Button variant="ghost" on:click={() => dispatch('discard')}>{$t('adminPeople.roles.discard')}</Button>
          {:else if error !== null}
            <Button variant="ghost" on:click={() => dispatch('discard')}>{$t('common.close')}</Button>
          {/if}
          {#if error !== null}<Button variant={count > 0 ? 'secondary' : 'primary'} icon="refresh" on:click={() => dispatch('retry')}>{$t('adminPeople.roles.applyAgain')}</Button>{/if}
          {#if count > 0}<Button on:click={() => dispatch('review')}>{$t('adminPeople.roles.review')}</Button>{/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* desktop: floating, centred, 16 px above the bottom edge (above the cast bar's room); the page pads its end by --savebar-h */
  .sb-wrap { position: fixed; z-index: 85; left: 0; right: 0; bottom: calc(16px + var(--castbar-h, 0px)); display: flex; justify-content: center; padding: 0 16px; pointer-events: none; }
  .sb { pointer-events: auto; box-sizing: border-box; width: min(760px, 100%); min-height: 64px; padding: 10px 12px 10px 20px; display: flex; align-items: center; gap: 12px; outline: none; }
  .sb:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--ring-dark); }
  .tx { flex: 1; min-width: 0; margin: 0; display: flex; align-items: center; gap: .55rem; font-weight: 600; }
  .tx.err { color: #ffbdbd; } /* the cast bar's error colour: AA on the bar scrim over any backdrop (lib/admin/glass.test.ts) */
  .tx :global(svg) { flex: none; }
  .l { min-width: 0; overflow-wrap: anywhere; }
  .acts { flex: none; display: flex; gap: 8px; align-items: center; }
  /* phone: above the tab bar, the buttons under the line */
  @media (max-width: 720px) {
    .sb-wrap { bottom: calc(var(--tabbar-h, 0px) + var(--safe-bottom, 0px) + .6rem + var(--castbar-h, 0px)); padding: 0 .6rem; }
    .sb { flex-direction: column; align-items: stretch; padding: 12px; }
    .acts { justify-content: flex-end; flex-wrap: wrap; }
  }
  /* calm mode and reduced motion: nothing moves */
  :global(html.m-still) .sb-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .sb-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
