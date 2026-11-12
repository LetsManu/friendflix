<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { grow, scrimFade, sheetSlide, type FxMode } from '#lib/glass/fx';
  import { t } from '#lib/i18n';
  import type { RunningChannel } from './api';
  import { fadeIn } from './fade';

  /**
   * "Gerade sind alle Live-Plätze belegt" (spec §12.5): the channels that already run start at once, a tap joins one; *Schließen*.
   * The provider's own connection limit (provider_limit) shows the same list under its own heading. A bottom sheet on phones, a
   * panel that grows in elsewhere; calm mode / reduced motion / TV / kids: at once, solid, and no transition inside it either (the
   * CastBar pattern, both triggers). A modal dialog (role="dialog" on a plain container) whose buttons are a D-pad scope
   * (`data-nav data-scope`); the first row takes the focus, Back / Escape (the player's keys) or *Schließen* close it.
   */
  export let ui: { k: 'full'; running: RunningChannel[] } | { k: 'providerLimit'; max: number; running: RunningChannel[] };
  export let phone = false;
  export let still = false;

  const dispatch = createEventDispatcher<{ join: RunningChannel; close: void }>();
  let box: HTMLElement | undefined;
  $: mode = (still ? 'still' : undefined) as FxMode | undefined;
  $: heading = ui.k === 'full' ? $t('live.full.title') : $t('live.providerLimit', { n: ui.max });
  const fx = (node: Element, p: { dir: 'in' | 'out'; mode?: FxMode }) => (phone ? sheetSlide(node, p) : grow(node, { ...p, origin: '50% 50%' }));
  onMount(() => { box?.querySelector<HTMLElement>('button')?.focus(); });
</script>

<div class="fsdim" role="presentation" on:click={() => dispatch('close')} in:scrimFade={{ mode }} out:scrimFade={{ mode }}></div>
<div class="fswrap" class:phone>
  <div bind:this={box} class="fsheet" class:frost={!still} class:frost-safe={!still} class:solid={still} role="dialog" aria-modal="true" aria-labelledby="lfs-title"
    tabindex="-1" data-nav data-scope in:fx={{ dir: 'in', mode }} out:fx={{ dir: 'out', mode }}>
    <h2 id="lfs-title">{heading}</h2>
    {#if ui.running.length}
      <p class="body">{$t('live.full.body')}</p>
      <ul>
        {#each ui.running as c (c.id)}
          <li>
            <button type="button" class="row" aria-label={$t('live.full.join', { name: c.name })} on:click={() => dispatch('join', c)}>
              <span class="lg" aria-hidden="true">{#if c.logo}<img src={c.logo} alt="" width="40" height="40" decoding="async" use:fadeIn />{/if}</span>
              <span class="nm">{c.number} {c.name}</span>
              <span class="ti">{c.now?.title ?? ''}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <button type="button" class="frost-btn close" on:click={() => dispatch('close')}>{$t('common.close')}</button>
  </div>
</div>

<style>
  .fsdim { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 12; background: rgba(8, 7, 11, .45); }
  .fswrap { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 13; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .fswrap.phone { align-items: flex-end; }
  .fsheet { pointer-events: auto; width: min(520px, calc(100% - 32px)); max-height: 80%; overflow-y: auto; box-sizing: border-box; padding: 20px 22px; border-radius: var(--fr-r-panel); color: #fff; outline: none; }
  .fswrap.phone .fsheet { width: 100%; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding-bottom: calc(20px + var(--safe-bottom, 0px)); }
  .fsheet.solid { background: var(--fr-solid); }
  h2 { margin: 0 0 6px; font-size: 1.2rem; }
  .body { margin: 0 0 12px; color: rgba(255, 255, 255, .78); }
  ul { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 6px; }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 6px 10px; border-radius: 12px; background: rgba(255, 255, 255, .06); color: #fff; text-align: left; justify-content: flex-start; }
  .lg { flex: none; width: 40px; height: 40px; border-radius: 8px; overflow: hidden; background: rgba(255, 255, 255, .08); }
  .lg img { display: block; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 200ms var(--fr-out); }
  .lg :global(img.in) { opacity: 1; }
  .nm { flex: none; font-weight: 700; }
  .ti { flex: 1 1 auto; min-width: 0; color: rgba(255, 255, 255, .78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .close { width: 100%; }
  /* calm mode and reduced motion (both triggers, the CastBar pattern): the sheet, its dim, its rows and logos do not move */
  :global(html.m-still) .fsdim, :global(html.m-still) .fsheet, :global(html.m-still) .fsheet :global(*), :global(html.m-still) .fsheet :global(*::before) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .fsdim, .fsheet, .fsheet :global(*), .fsheet :global(*::before) { transition: none !important; animation: none !important; }
  }
  :global(html.tv) .row, :global(html.tv) .close { min-height: 54px; }
</style>
