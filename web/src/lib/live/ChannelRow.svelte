<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { nowLines, type LiveChannel } from './api';
  import { fadeIn } from './fade';
  import { progressAt, rowName } from './progress';

  /**
   * One channel of the list (spec §11.1 item 3, §11.2): number, a 48 px logo tile, the name and two text lines that are always
   * reserved (Jetzt / Danach, or Live / Kein Programm verfügbar, or the gap and the not-receiving lines), a thin progress line and
   * the star. The row is one button named like spec §21; the star is a toggle of its own. No time left on rows, so nothing
   * changes width when a minute passes. Phones show a 64 px row without the Danach line (it lives in the info panel).
   */
  export let channel: LiveChannel;
  export let now: Date;

  const dispatch = createEventDispatcher<{ open: LiveChannel; star: LiveChannel }>();

  $: lines = nowLines(channel);
  /** the programme lines carry their labels; the state lines (Live, gap, not receiving) are plain text */
  $: running = channel.receiving !== false && channel.epg === 'ok' && !!channel.now;
  $: p = running && channel.now ? progressAt(channel.now, now) : 0;
</script>

<li class="row">
  <button type="button" class="main" aria-label={rowName(channel, now)} on:click={() => dispatch('open', channel)}>
    <span class="num" aria-hidden="true">{channel.number}</span>
    <span class="logo frost-flat frost-tile" aria-hidden="true">
      {#if channel.logo}<img src={channel.logo} alt="" width="48" height="48" loading="lazy" decoding="async" use:fadeIn />{/if}
    </span>
    <span class="txt" aria-hidden="true">
      <span class="name">{channel.name}</span>
      <span class="ln now">{#if running}<i class="lb">{$t('live.now')}</i>{/if}<span class="tx">{lines.now}</span></span>
      <span class="ln next">{#if running && lines.next}<i class="lb">{$t('live.next')}</i>{/if}{#if lines.next}<span class="tx">{lines.next}</span>{/if}</span>
      <span class="bar"><i style="transform:scaleX({p})"></i></span>
    </span>
  </button>
  <button type="button" class="star" class:on={channel.favourite} aria-pressed={channel.favourite} aria-label={`${$t(channel.favourite ? 'live.unfavourite' : 'live.favourite')}: ${channel.name}`} on:click={() => dispatch('star', channel)}>
    <Icon name="star" size={22} fill={channel.favourite} />
  </button>
</li>

<style>
  .row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 44px; align-items: center; height: 72px; box-sizing: border-box; border-radius: 12px; list-style: none; }
  /* the row fill on hover / focus: a layer under the content that fades in by opacity */
  .row::before { content: ''; position: absolute; left: 0; right: 0; top: 0; bottom: 0; border-radius: inherit; background: rgba(255, 255, 255, .09); opacity: 0; pointer-events: none; transition: opacity 150ms ease-out; }
  .row:hover::before, .row:focus-within::before { opacity: 1; }
  :global(html.m-still) .row::before { transition: none; }
  /* the global coral button look does not apply here: restated, also for hover and press */
  .main, .main:hover:not(:disabled), .main:active:not(:disabled) {
    position: relative; display: grid; grid-template-columns: 2.4rem 48px minmax(0, 1fr); column-gap: .7rem; align-items: center; width: 100%; height: 72px; min-height: 0; box-sizing: border-box;
    padding: 0 .4rem 0 .6rem; margin: 0; border: 0; border-radius: 12px; background: transparent; color: #fff; font: inherit; font-weight: 400; text-align: left; transform: none;
  }
  .num { font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; color: rgba(255, 255, 255, .78); }
  .logo { position: relative; display: grid; place-items: center; width: 48px; height: 48px; overflow: hidden; border-radius: 12px; }
  .logo img { width: 40px; height: 40px; object-fit: contain; opacity: 0; transition: opacity 200ms ease-out; }
  .logo :global(img.in) { opacity: 1; }
  :global(html.m-still) .logo img { transition: none; }
  /* name, Jetzt, Danach and the progress line: four rows of fixed height, so nothing moves when programme data arrives */
  .txt { display: grid; grid-template-rows: 20px 17px 17px 3px; row-gap: 2px; min-width: 0; }
  .name { font-weight: 700; font-size: .98rem; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ln { display: flex; gap: .45rem; min-width: 0; font-size: .84rem; line-height: 17px; color: rgba(255, 255, 255, .78); }
  .lb { flex: none; width: 3.7em; font-style: normal; font-weight: 600; color: rgba(255, 255, 255, .78); }
  .tx { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .bar { align-self: end; height: 3px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .22); }
  .bar > i { display: block; height: 100%; background: #fff; transform-origin: 0 50%; }
  /* the star: a 44 px target */
  .star, .star:hover:not(:disabled), .star:active:not(:disabled) { position: relative; z-index: 1; width: 44px; height: 44px; min-height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: rgba(255, 255, 255, .78); transform: none; }
  .star.on { color: #fff; }
  .star:hover:not(:disabled) { color: #fff; }

  /* phone: 64 px rows, no Danach line (it moves into the info panel) */
  @media (max-width: 720px) {
    .row, .main, .main:hover:not(:disabled), .main:active:not(:disabled) { height: 64px; }
    .main, .main:hover:not(:disabled), .main:active:not(:disabled) { grid-template-columns: 1.9rem 48px minmax(0, 1fr); column-gap: .6rem; padding-left: .3rem; }
    .txt { grid-template-rows: 20px 17px 3px; }
    .next { display: none; }
  }
</style>
