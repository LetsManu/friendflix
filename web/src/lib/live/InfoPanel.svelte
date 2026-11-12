<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { scrimFade, sheetSlide, type FxMode } from '#lib/glass/fx';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { clock, nowLines, type LiveChannel } from './api';
  import { progressAt, timeLeft, timeLeftText } from './progress';

  /**
   * The info panel (spec §12.1): a glass sheet on phones, a side panel on desktop and TV. *Jetzt* (title, time, progress, time left,
   * subtitle, *Von Anfang an*), *Danach*, and *Letzter Sender* ("Zurück zu 4 Hafenkanal"). Opening and closing both slide; calm mode,
   * reduced motion, TV and kids: at once, on a solid panel, and no transition inside it either (the CastBar pattern, both triggers).
   * A modal dialog (role="dialog" on a plain container) whose buttons are a D-pad scope (`data-nav data-scope`); the first button
   * takes the focus. Back / Escape (the player's keys), the close button or a tap outside close it. The *Von Anfang an* slot is
   * reserved, so the panel never shifts when it appears.
   */
  export let channel: LiveChannel | null = null;
  export let now: Date;
  export let canRestart = false;
  export let last: LiveChannel | null = null;
  export let phone = false;
  export let still = false;

  const dispatch = createEventDispatcher<{ close: void; restart: void; last: void }>();
  let panel: HTMLElement | undefined;
  $: mode = (still ? 'still' : undefined) as FxMode | undefined;
  $: side = (phone ? 'bottom' : 'right') as 'bottom' | 'right';
  $: prog = channel && channel.epg === 'ok' && channel.receiving !== false ? channel.now ?? null : null;
  $: lines = channel ? nowLines(channel) : null;
  $: left = prog ? timeLeftText(timeLeft(prog, now)) : '';
  $: p = prog ? progressAt(prog, now) : 0;
  onMount(() => { panel?.querySelector<HTMLElement>('button')?.focus(); });
</script>

<div class="ipdim" role="presentation" on:click={() => dispatch('close')} in:scrimFade={{ mode }} out:scrimFade={{ mode }}></div>
<div bind:this={panel} class="ipanel" class:frost={!still} class:frost-safe={!still} class:solid={still} class:phone role="dialog" aria-modal="true" aria-labelledby="lip-title"
  tabindex="-1" data-nav data-scope in:sheetSlide={{ dir: 'in', mode, side }} out:sheetSlide={{ dir: 'out', mode, side }}>
  <header>
    <h2 id="lip-title">{$t('live.player.info')}</h2>
    <button type="button" class="x" aria-label={$t('common.close')} on:click={() => dispatch('close')}><Icon name="x" size={22} /></button>
  </header>
  {#if channel}
    <p class="who">{channel.number} {channel.name}</p>
    <div class="blk">
      <h3>{$t('live.now')}</h3>
      {#if prog}
        <p class="ti">{prog.title}</p>
        <p class="sub">{prog.subtitle ?? ''}</p>
        <p class="tm"><span>{clock(prog.start)}–{clock(prog.end)}</span><span class="left">{left}</span></p>
        <div class="pg"><i style="transform:scaleX({p})"></i></div>
      {:else if lines}
        <p class="ti">{lines.now}</p>
        <p class="sub">{lines.next ?? ''}</p>
      {/if}
      <div class="rslot">
        {#if canRestart}<button type="button" class="frost-btn act" on:click={() => dispatch('restart')}>{$t('live.player.restart')}</button>{/if}
      </div>
    </div>
    {#if prog && channel.next}
      <div class="blk">
        <h3>{$t('live.next')}</h3>
        <p class="ti">{clock(channel.next.start)} {channel.next.title}</p>
      </div>
    {/if}
  {/if}
  {#if last}
    <button type="button" class="frost-btn act" on:click={() => dispatch('last')}>{$t('live.player.lastChannelTo', { number: last.number, name: last.name })}</button>
  {/if}
</div>

<style>
  .ipdim { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 10; background: rgba(8, 7, 11, .45); }
  .ipanel { position: absolute; z-index: 11; top: 16px; right: 16px; bottom: 16px; width: min(420px, calc(100% - 32px)); box-sizing: border-box; overflow-y: auto;
    padding: 18px 20px 22px; border-radius: var(--fr-r-panel); color: #fff; outline: none; }
  .ipanel.solid { background: var(--fr-solid); }
  .ipanel.phone { top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 82%; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0;
    padding-bottom: calc(22px + var(--safe-bottom, 0px)); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { margin: 0; font-size: 1.25rem; }
  h3 { margin: 0 0 4px; font-size: .85rem; font-weight: 600; color: rgba(255, 255, 255, .72); }
  .x { width: 44px; height: 44px; padding: 0; border-radius: 50%; background: transparent; color: #fff; }
  .who { margin: 8px 0 14px; font-weight: 700; }
  .blk { margin-bottom: 16px; }
  .ti { margin: 0; font-weight: 700; min-height: 1.4em; }
  .sub { margin: 2px 0 0; min-height: 1.3em; color: rgba(255, 255, 255, .78); }
  .tm { display: flex; justify-content: space-between; margin: 6px 0 0; }
  .left { width: 10.5em; text-align: right; font-variant-numeric: tabular-nums; }
  .pg { height: 3px; margin-top: 6px; border-radius: 2px; background: rgba(255, 255, 255, .2); overflow: hidden; }
  .pg i { display: block; height: 100%; background: #fff; transform-origin: left center; }
  .rslot { min-height: 44px; margin-top: 12px; }
  .act { width: 100%; }
  .ipanel > .act { margin-top: 4px; }
  /* calm mode and reduced motion (both triggers, the CastBar pattern): the panel, its dim and its buttons do not move */
  :global(html.m-still) .ipdim, :global(html.m-still) .ipanel, :global(html.m-still) .ipanel :global(*), :global(html.m-still) .ipanel :global(*::before) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .ipdim, .ipanel, .ipanel :global(*), .ipanel :global(*::before) { transition: none !important; animation: none !important; }
  }
  :global(html.tv) .ipanel { width: calc(100vw / 1920 * 640); font-size: calc(100vw / 1920 * 28); }
  :global(html.tv) .ipanel button { min-height: 54px; }
  :global(html.tv) .rslot { min-height: 54px; }
</style>
