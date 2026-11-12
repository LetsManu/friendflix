<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import { nowLines, type LiveChannel } from './api';
  import { fadeIn } from './fade';
  import { progressAt, rowName, timeLeft, timeLeftText } from './progress';

  /**
   * "Läuft gerade bei dir" (spec §11.1 item 1, §11.2): the person's favourites in their own order (at most 12) as 16:9 glass tiles.
   * A preview shows only while the channel is running, else the logo sits centred on the tile's glass. Bottom: number and name,
   * the programme title with the time left right-aligned in a slot reserved for the longest form (tabular figures), and a 3 px
   * progress line (`scaleX`, minute steps). A tile is one button named like a row. The head leaves a slot for *Ordnen* (Task 38).
   * On a desktop the tiles wrap into rows (at most 12, no sideways scrolling a mouse could not reach); on phones they form a
   * swipeable strip (scroll snap).
   */
  export let channels: LiveChannel[];
  export let now: Date;
  /** the list has not arrived yet: tiles of the final size stand in */
  export let loading = false;

  const MAX = 12;
  const dispatch = createEventDispatcher<{ open: LiveChannel }>();

  $: tiles = channels.slice(0, MAX);
  /** the longest time left of the ACTIVE language (long form with the widest digits, the short one, "ending now"): it sizes the reserved slot */
  $: longest = [$t('live.timeLeftLong', { h: 9, m: 59 }), $t('live.timeLeft', { n: 59 }), $t('live.endingNow')].reduce((a, b) => (b.length > a.length ? b : a));
  const text = (c: LiveChannel): string => (c.receiving !== false && c.epg === 'ok' && c.now ? c.now.title : nowLines(c).now);
</script>

{#if loading || tiles.length}
  <section class="fav" aria-labelledby="live-fav-h" aria-busy={loading ? 'true' : undefined}>
    <div class="head">
      <h2 id="live-fav-h">{$t('live.favourites')}</h2>
      <span class="order"><slot name="order" /></span>
    </div>
    <ul class="strip">
      {#if loading}
        {#each [0, 1, 2, 3] as k (k)}<li class="cell"><span class="tile skeleton" aria-hidden="true"></span></li>{/each}
      {:else}
        {#each tiles as c (c.id)}
          {@const left = c.receiving !== false && c.epg === 'ok' ? timeLeft(c.now, now) : null}
          <li class="cell">
            <button type="button" class="tile frost frost-tile" aria-label={rowName(c, now)} on:click={() => dispatch('open', c)}>
              <span class="media" aria-hidden="true">
                {#if c.running && c.preview}
                  <img class="pv" src={c.preview} alt="" loading="lazy" decoding="async" use:fadeIn />
                {:else if c.logo}
                  <img class="lg" src={c.logo} alt="" loading="lazy" decoding="async" use:fadeIn />
                {/if}
              </span>
              <span class="cap" aria-hidden="true">
                <span class="l1"><b class="num">{c.number}</b><span class="nm">{c.name}</span></span>
                <span class="l2"><span class="ti">{text(c)}</span><span class="left"><span class="sz" aria-hidden="true">{longest}</span><span class="tl">{timeLeftText(left)}</span></span></span>
                <span class="bar"><i style="transform:scaleX({c.receiving !== false && c.epg === 'ok' && c.now ? progressAt(c.now, now) : 0})"></i></span>
              </span>
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  </section>
{/if}

<style>
  .fav { margin: 0 0 1.4rem; }
  /* the head always keeps the height of a 44 px button, so *Ordnen* arriving there moves nothing */
  .head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 44px; margin-bottom: .4rem; }
  h2 { margin: 0; font-size: 1.15rem; }
  .order { display: inline-flex; align-items: center; min-height: 44px; }
  .strip { display: flex; flex-wrap: wrap; gap: .9rem; margin: 0; padding: 4px 4px 10px; list-style: none; }
  .cell { flex: none; scroll-snap-align: start; --tw: 304px; width: var(--tw); height: calc(var(--tw) * 9 / 16); }
  /* the global coral button look does not apply: restated, also for hover and press */
  .tile, .tile:hover:not(:disabled), .tile:active:not(:disabled) {
    position: relative; display: block; width: 100%; height: 100%; min-height: 0; padding: 0; margin: 0; overflow: hidden; color: #fff; font: inherit; font-weight: 400; text-align: left; transform: none;
  }
  .tile:hover:not(:disabled) { border-color: rgba(255, 255, 255, .5); }
  .tile.skeleton { display: block; border-radius: var(--fr-r-tile); }
  .media { position: absolute; left: 0; right: 0; top: 0; bottom: 0; display: grid; place-items: center; }
  .media img { opacity: 0; transition: opacity 200ms ease-out; }
  .media :global(img.in) { opacity: 1; }
  :global(html.m-still) .media img { transition: none; }
  .pv { width: 100%; height: 100%; object-fit: cover; }
  .lg { width: 38%; height: 38%; object-fit: contain; margin-bottom: 1.6rem; }
  /* the caption sits on a dark ramp, so white text stays readable over any preview */
  .cap { position: absolute; left: 0; right: 0; bottom: 0; display: grid; gap: 1px; padding: 1.6rem .7rem .55rem; background: linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, .78) 55%); }
  .l1, .l2 { display: flex; align-items: baseline; gap: .45rem; min-width: 0; line-height: 18px; }
  .l1 { font-size: .92rem; }
  .num { flex: none; font-variant-numeric: tabular-nums; }
  .nm { min-width: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .l2 { font-size: .84rem; color: rgba(255, 255, 255, .86); }
  .ti { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* the longest form of the active language, tabular figures: a changing value never moves its neighbours */
  /* the slot is as wide as the longest form of the active language (an invisible sizer in the same grid cell), tabular figures */
  .left { flex: none; display: grid; justify-items: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .left > span { grid-area: 1 / 1; }
  .sz { visibility: hidden; height: 0; overflow: hidden; }
  .bar { height: 3px; margin-top: 5px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .28); }
  .bar > i { display: block; height: 100%; background: #fff; transform-origin: 0 50%; }

  @media (max-width: 720px) {
    .cell { --tw: min(78vw, 300px); }
    .strip { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; scroll-snap-type: x mandatory; scroll-padding-left: 4px; }
    .strip::-webkit-scrollbar { display: none; }
  }
</style>
