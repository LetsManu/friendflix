<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import { nowLines, type LiveChannel } from './api';
  import { fadeIn } from './fade';
  import { progressAt, rowName } from './progress';

  /**
   * One compact row of the *Senderliste* panel (spec §12.2, ruling 59): number, logo, name, the *Jetzt* line with its progress (the
   * honest data-state lines of nowLines() otherwise: Live, Programm gerade nicht verfügbar, Gerade keine Übertragung). Every line is
   * reserved, so every row has the same height whatever data it has. `focused` makes it the panel's one tab stop (roving tabindex;
   * the player moves the real focus); `playing` marks the channel that plays (aria-current). Phase 2's mini-guide sets `showNext`
   * and gets a reserved *Danach* line; Phase 1 never does.
   */
  export let channel: LiveChannel;
  export let focused = false;
  export let playing = false;
  export let showNext = false;
  export let now: Date;

  const dispatch = createEventDispatcher<{ pick: LiveChannel }>();
  $: lines = nowLines(channel);
  $: running = channel.receiving !== false && channel.epg === 'ok' && !!channel.now;
  $: p = running && channel.now ? progressAt(channel.now, now) : 0;
</script>

<li class="pr" class:nx={showNext}>
  <button type="button" class="prow" class:on={focused} class:playing data-ch={channel.id} tabindex={focused ? 0 : -1} aria-current={playing ? 'true' : undefined}
    aria-label={rowName(channel, now)} on:click={() => dispatch('pick', channel)}>
    <span class="num" aria-hidden="true">{channel.number}</span>
    <span class="logo" aria-hidden="true">{#if channel.logo}<img src={channel.logo} alt="" width="40" height="40" loading="lazy" decoding="async" use:fadeIn />{/if}</span>
    <span class="txt" aria-hidden="true">
      <span class="name"><span class="nm">{channel.name}</span>{#if playing}<i class="dot"></i>{/if}</span>
      <span class="ln">{#if running}<b class="lb">{$t('live.now')}</b>{/if}<span class="tx">{lines.now}</span></span>
      {#if showNext}<span class="ln next">{#if running && lines.next}<b class="lb">{$t('live.next')}</b>{/if}<span class="tx">{lines.next ?? ''}</span></span>{/if}
      <span class="bar" class:off={!running}><i style="transform:scaleX({p})"></i></span>
    </span>
  </button>
</li>

<style>
  .pr { list-style: none; margin: 0 0 4px; }
  /* the global coral button look does not apply: restated, also for hover and press; fills switch at once */
  .prow, .prow:hover:not(:disabled), .prow:active:not(:disabled) {
    position: relative; display: grid; grid-template-columns: 2.4rem 40px minmax(0, 1fr); column-gap: .7rem; align-items: center; width: 100%; height: 64px; min-height: 0;
    box-sizing: border-box; padding: 0 .6rem 0 .4rem; margin: 0; border: 0; border-radius: 12px; background: transparent; color: #fff; font: inherit; font-weight: 400;
    text-align: left; justify-content: start; transform: none;
  }
  .prow:hover:not(:disabled), .prow.on { background: rgba(255, 255, 255, .09); }
  .num { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; color: rgba(255, 255, 255, .78); }
  .logo { position: relative; display: grid; place-items: center; width: 40px; height: 40px; overflow: hidden; border-radius: 10px; background: rgba(255, 255, 255, .08); }
  .logo img { width: 34px; height: 34px; object-fit: contain; opacity: 0; transition: opacity 200ms ease-out; }
  .logo :global(img.in) { opacity: 1; }
  /* name, Jetzt (and the Danach line of Phase 2), progress: rows of fixed height, so programme data arriving moves nothing */
  .txt { display: grid; grid-template-rows: 20px 18px 3px; row-gap: 3px; min-width: 0; }
  .nx .txt { grid-template-rows: 20px 18px 18px 3px; }
  .nx .prow, .nx .prow:hover:not(:disabled), .nx .prow:active:not(:disabled) { height: 84px; }
  .name { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 700; line-height: 20px; }
  .nm { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #fff; }
  .ln { display: flex; gap: .45rem; min-width: 0; font-size: .86rem; line-height: 18px; color: rgba(255, 255, 255, .78); }
  .lb { flex: none; font-weight: 600; }
  .tx { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .bar { align-self: end; height: 3px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .22); }
  .bar.off { opacity: 0; }
  .bar > i { display: block; height: 100%; background: #fff; transform-origin: 0 50%; }
  :global(html.m-still) .logo img { transition: none; }
  @media (prefers-reduced-motion: reduce) { .logo img { transition: none; } }

  /* TV: 1u = 1 px at a 1080p viewport; 96 u rows with 28 u text, the one focus = scale(1.08) + the 3 px white ring (app.css), still */
  :global(html.tv) .pr { --u: calc(100vw / 1920); margin-bottom: calc(var(--u) * 8); }
  :global(html.tv) .prow, :global(html.tv) .prow:hover:not(:disabled), :global(html.tv) .prow:active:not(:disabled) {
    grid-template-columns: calc(var(--u) * 76) calc(var(--u) * 64) minmax(0, 1fr); column-gap: calc(var(--u) * 20); height: calc(var(--u) * 96);
    padding: 0 calc(var(--u) * 20) 0 0; font-size: calc(var(--u) * 28); transition: none;
  }
  :global(html.tv) .nx .prow, :global(html.tv) .nx .prow:hover:not(:disabled) { height: calc(var(--u) * 128); }
  :global(html.tv) .prow:focus-visible, :global(html.tv) .prow:focus-visible:hover:not(:disabled) { background: rgba(255, 255, 255, .14); transform: scale(1.08); z-index: 2; }
  :global(html.tv) .num { font-size: calc(var(--u) * 30); }
  :global(html.tv) .logo { width: calc(var(--u) * 64); height: calc(var(--u) * 64); }
  :global(html.tv) .logo img { width: 80%; height: 80%; transition: none; }
  :global(html.tv) .txt { grid-template-rows: calc(var(--u) * 36) calc(var(--u) * 34) calc(var(--u) * 4); row-gap: calc(var(--u) * 4); }
  :global(html.tv) .nx .txt { grid-template-rows: calc(var(--u) * 36) calc(var(--u) * 34) calc(var(--u) * 34) calc(var(--u) * 4); }
  :global(html.tv) .name { line-height: calc(var(--u) * 36); }
  :global(html.tv) .dot { width: calc(var(--u) * 12); height: calc(var(--u) * 12); }
  :global(html.tv) .ln { font-size: calc(var(--u) * 28); line-height: calc(var(--u) * 34); }
  :global(html.tv) .bar { height: calc(var(--u) * 4); }
</style>
