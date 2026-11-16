<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { fmtDate, t } from '#lib/i18n';
  import { fadeIn } from './fade';
  import { minutesOf, progressOf, rowRecordings, type Recording } from './recordings';

  /**
   * The *Aufnahmen* row of the Live-TV tab (spec §15.7, plan Phase 3 Task 8): the profile's latest 12 recordings as tiles (the channel
   * logo on the glass, title, date, length; a red dot + "läuft" while one records; a progress line once started). The dot and the
   * progress line keep their room on every tile, so nothing moves when a recording starts or progress arrives. *Alle* opens
   * *Meine Aufnahmen*. Hidden when there is nothing to show and the person may not record; a kids profile gets the shared
   * kid-friendly recordings read-only (no *Alle*, the tile only plays). With `wrap` (a TV's *Meine Aufnahmen*) the tiles fill a grid
   * and there is no head. A TV: one focused tile with the 1.08 ring, OK plays (the shell's D-pad moves the focus).
   */
  /** null while loading */
  export let recordings: Recording[] | null;
  export let canRecord = false;
  export let kids = false;
  export let tv = false;
  /** a grid of every given recording instead of the row (no head) */
  export let wrap = false;
  /** the first tile takes the entry focus (a TV page) */
  export let autofocus = false;

  $: shown = recordings ? (wrap ? recordings : rowRecordings(recordings)) : [];
  $: visible = wrap || (recordings === null ? canRecord : shown.length > 0 || (canRecord && !kids));
  const day = (iso: string) => fmtDate(iso, { weekday: 'short', day: 'numeric', month: 'short' });
  const open = (r: Recording) => void goto(`/live/recordings/${encodeURIComponent(r.id)}`);
</script>

{#if visible}
  <section class="recrow" class:tv class:kids class:wrap aria-labelledby={wrap ? undefined : 'lrr-h'} aria-label={wrap ? $t('live.recordings') : undefined} aria-busy={recordings === null ? 'true' : undefined}>
    {#if !wrap}
      <div class="hd">
        <h2 id="lrr-h">{$t('live.recordings')}</h2>
        {#if !kids}<a class="all" href="/live/recordings">{$t('live.all')}</a>{/if}
      </div>
    {/if}
    {#if recordings === null}
      <ul class="tiles" aria-hidden="true">{#each Array(4) as _, k (k)}<li class="sk"></li>{/each}</ul>
    {:else if !shown.length}
      <p class="empty">{$t('live.mine.emptyRow')}</p>
    {:else}
      <ul class="tiles">
        {#each shown as r, i (r.id)}
          <li>
            <button type="button" class="rtile" data-autofocus={autofocus && i === 0 ? '' : undefined} aria-label={$t('live.mine.play', { title: r.subtitle ? `${r.title}, ${r.subtitle}` : r.title })} on:click={() => open(r)}>
              <span class="pic" aria-hidden="true">
                {#if r.channel.logo}<img src={r.channel.logo} alt="" width="64" height="64" loading="lazy" decoding="async" use:fadeIn />{/if}
                <span class="live" class:on={r.state === 'recording'}>{#if r.state === 'recording'}<i class="rdot"></i>{$t('live.rec.recording')}{/if}</span>
              </span>
              <span class="ti" aria-hidden="true">{r.title}</span>
              <span class="meta" aria-hidden="true">{day(r.start)} · {$t('live.rec.minutes', { n: minutesOf(r) })}</span>
              <span class="pg" aria-hidden="true"><i style="transform:scaleX({progressOf(r)})"></i></span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .recrow { margin: 1.6rem 0 1rem; }
  .hd { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 44px; margin-bottom: .5rem; }
  h2 { margin: 0; font-size: 1.25rem; }
  .all { display: inline-flex; align-items: center; min-height: 44px; padding: 0 .9rem; border-radius: 999px; color: var(--acc-text); font-weight: 700; text-decoration: none; }
  .all:hover { text-decoration: underline; }
  .tiles { display: flex; gap: 14px; margin: 0; padding: 4px 2px 10px; list-style: none; overflow-x: auto; scrollbar-width: thin; }
  .tiles > li { flex: none; width: 220px; list-style: none; }
  .wrap .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); overflow: visible; }
  .wrap .tiles > li { width: auto; min-width: 0; }
  .sk { height: 196px; border-radius: var(--fr-r-tile); background: rgba(255, 255, 255, .06); }
  .empty { margin: 0; min-height: 44px; display: flex; align-items: center; color: rgba(255, 255, 255, .78); }
  /* a tile: the global coral button look is restated away, also for hover and press */
  .rtile, .rtile:hover:not(:disabled), .rtile:active:not(:disabled) {
    display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1.4em 1.3em 3px; row-gap: 4px; width: 100%; padding: 0 0 8px; margin: 0; border: 0; border-radius: var(--fr-r-tile);
    background: transparent; color: #fff; font: inherit; font-weight: 400; text-align: left; justify-items: stretch; transform: none;
  }
  .rtile { transition: transform 200ms var(--fr-out); }
  .rtile:hover:not(:disabled) { transform: translateY(-2px); }
  /* 16:9 by its padding (the TV engines are Chromium 85, see compat.test.ts) */
  .pic { position: relative; display: block; height: 0; padding-top: 56.25%; border-radius: var(--fr-r-tile); overflow: hidden; background: rgba(255, 255, 255, .07); box-shadow: inset 0 0 0 1px var(--fr-line); }
  .pic img { position: absolute; left: 35%; top: 20%; width: 30%; height: 60%; object-fit: contain; opacity: 0; transition: opacity 200ms var(--fr-out); }
  .pic :global(img.in) { opacity: 1; }
  /* the running badge keeps its corner whether shown or not */
  .live { position: absolute; left: 8px; top: 8px; display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 8px; border-radius: 999px; font-size: .8rem; font-weight: 700; opacity: 0; }
  .live.on { opacity: 1; background: rgba(0, 0, 0, .62); }
  .rdot { width: 8px; height: 8px; border-radius: 50%; background: var(--err-mark); }
  .ti { padding: 0 4px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { padding: 0 4px; font-size: .88rem; color: rgba(255, 255, 255, .78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .pg { margin: 0 4px; height: 3px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .16); }
  .pg i { display: block; height: 100%; background: var(--acc); transform-origin: 0 50%; }
  :global(html.m-still) .rtile, :global(html.m-still) .pic img { transition: none; }
  @media (max-width: 720px) {
    .tiles > li { width: 168px; }
    .sk { height: 160px; }
  }
  /* kids: solid white tiles in the kids ink */
  .kids h2 { color: #20233a; font-weight: 900; }
  .kids .rtile, .kids .rtile:hover:not(:disabled), .kids .rtile:active:not(:disabled) { color: #20233a; transition: none; transform: none; }
  .kids .pic { background: #fff; box-shadow: 0 6px 16px rgba(32, 35, 58, .15); }
  .kids .meta { color: #3c4a8f; }
  .kids .empty { color: #20233a; }
  /* TV: 1u = 1 px at 1080p; tiles of 360 px, 28 px text, the focus ring and scale 1.08 (one focused element) */
  .tv { --u: calc(100vw / 1920); margin: calc(var(--u) * 28) 0; padding: 0 calc(var(--u) * 28); }
  .tv h2 { font-size: calc(var(--u) * 36); }
  .tv .all { min-height: 54px; font-size: calc(var(--u) * 28); }
  .tv .tiles { gap: calc(var(--u) * 28); padding: calc(var(--u) * 16) calc(var(--u) * 8); }
  .tv .tiles > li { width: calc(var(--u) * 360); }
  .tv.wrap .tiles { grid-template-columns: repeat(auto-fill, calc(var(--u) * 360)); }
  .tv .rtile, .tv .rtile:hover:not(:disabled) { min-height: 54px; transition: none; grid-template-rows: auto calc(var(--u) * 38) calc(var(--u) * 34) 4px; font-size: calc(var(--u) * 28); }
  .tv .meta { font-size: calc(var(--u) * 28); }
  .tv .rtile:focus-visible { position: relative; z-index: 2; transform: scale(1.08); }
</style>
