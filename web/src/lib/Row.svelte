<script lang="ts">
  import { onMount } from 'svelte';
  import type { Item } from '$lib/api';
  import Card from '$lib/Card.svelte';
  import Icon from '$lib/Icon.svelte';

  export let title: string;
  /** null = loading (skeleton) */
  export let items: Item[] | null;
  export let href = '';
  /** big rank numbers (Top 10 style) */
  export let ranked = false;
  let track: HTMLDivElement;
  let canLeft = false, canRight = true;

  function update() {
    if (!track) return;
    canLeft = track.scrollLeft > 8;
    canRight = track.scrollLeft + track.clientWidth < track.scrollWidth - 8;
  }
  function go(dir: number) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: reduce ? 'auto' : 'smooth' });
  }
  onMount(update);
  $: if (items) setTimeout(update, 50);
</script>

{#if items === null || items.length}
  <section class="row" aria-label={title} aria-busy={items === null}>
    <h2>{#if href}<a {href}>{title}<span class="more"> Alle anzeigen</span><Icon name="chevron-right" size={18} /></a>{:else}{title}{/if}</h2>
    <div class="wrap">
      <button class="arrow left" class:hide={!canLeft} aria-label="Zurückblättern" on:click={() => go(-1)}><Icon name="chevron-left" size={34} /></button>
      <div class="track" bind:this={track} on:scroll={update} role="list">
        {#if items === null}
          {#each Array(8) as _}<div class="slot"><div class="skeleton ph"></div></div>{/each}
        {:else}
          {#each items as it, idx (it.id)}<div class="slot" class:ranked role="listitem">{#if ranked}<span class="rank" aria-label="Platz {idx + 1}">{idx + 1}</span>{/if}<Card item={it} /></div>{/each}
        {/if}
      </div>
      <button class="arrow right" class:hide={!canRight} aria-label="Weiterblättern" on:click={() => go(1)}><Icon name="chevron-right" size={34} /></button>
    </div>
  </section>
{/if}

<style>
  .row { position: relative; z-index: 1; margin: 2rem 0 0; --n: 2.4; --gap: .45rem; }
  .row:hover, .row:focus-within { z-index: 4; }
  @media (min-width: 560px) { .row { --n: 3; } }
  @media (min-width: 800px) { .row { --n: 4; } }
  @media (min-width: 1100px) { .row { --n: 5; } }
  @media (min-width: 1500px) { .row { --n: 6; } }
  h2 { font-size: clamp(1.15rem, 1.8vw, 1.55rem); font-weight: 600; margin: 0 var(--pad-x) .35rem; letter-spacing: -.005em; }
  h2 a { display: inline-flex; align-items: center; gap: .2rem; }
  .more { font-size: .8rem; color: #54b9c5; max-width: 0; overflow: hidden; white-space: nowrap; opacity: 0; transition: max-width var(--t-med), opacity var(--t-med), margin var(--t-med); }
  h2 a:hover .more, h2 a:focus-visible .more { max-width: 10rem; opacity: 1; margin-left: .6rem; }
  .wrap { position: relative; }
  /* vertical padding leaves room for the scaled hover card (overflow-x forces clipping on y) */
  .track { display: flex; gap: var(--gap); overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; scrollbar-width: none; padding: 2.6rem var(--pad-x) 10.4rem; margin: -2.2rem 0 -9.9rem; scroll-padding: 0 var(--pad-x); }
  .track::-webkit-scrollbar { display: none; }
  .slot { flex: 0 0 calc((100% - 2 * var(--pad-x) - (var(--n) - 1) * var(--gap)) / var(--n)); scroll-snap-align: start; min-width: 0; }
  .slot.ranked { display: flex; align-items: flex-end; flex-basis: calc((100% - 2 * var(--pad-x) - (var(--n) - 1) * var(--gap)) / var(--n) * 1.25); }
  .slot.ranked :global(.card) { width: 66%; flex: none; }
  .rank { font-size: clamp(5rem, 11vw, 9.5rem); font-weight: 900; line-height: .8; color: #141414; -webkit-text-stroke: 3px #777; width: 34%; text-align: right; padding-right: .15rem; letter-spacing: -.08em; overflow: hidden; user-select: none; }
  .ph { aspect-ratio: 16 / 9; width: 100%; }
  .arrow { position: absolute; top: 2.4rem; bottom: 10.4rem; width: var(--pad-x); min-width: 44px; border-radius: 0; background: rgba(20, 20, 20, .55); opacity: 0; z-index: 7; padding: 0; }
  .arrow:hover:not(:disabled) { background: rgba(20, 20, 20, .8); }
  .arrow.left { left: 0; } .arrow.right { right: 0; }
  .arrow.hide { display: none; }
  .row:hover .arrow, .arrow:focus-visible { opacity: 1; }
  @media (hover: none), (pointer: coarse) { .arrow { display: none; } }
</style>
