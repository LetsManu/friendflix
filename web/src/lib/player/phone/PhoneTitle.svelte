<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Phone dock, first row (spec 2026-11-08 §1): chapter eyebrow, title, episode line / year · length. Landscape: the text takes
   * at most 58 % of the row and the skip button (slot `skip`) sits at its end; portrait: the text spans the row and the skip
   * button gets its own row below it, end-aligned. A long title wraps upward (two lines, then an ellipsis), never over the timeline.
   */
  import { onMount } from 'svelte';
  import { motionAllowed } from '#lib/preview';
  import type { PhoneOrient } from './logic';

  export let chapter = '';
  export let title = '';
  export let sub = '';
  export let orient: PhoneOrient = 'landscape';
  /** a panel is open: the text fades out (opacity, then visibility), the skip button stays */
  export let hidden = false;

  /**
   * The dock is anchored at the bottom: when the skip button's own row (portrait) comes or goes, the text would jump by that row.
   * FLIP instead: the text is put back where it was (translateY) and glides to its new place (transform only, 250 ms). Not on a
   * rotation (everything re-lays out anyway) and not with reduced motion / calm mode (instant).
   */
  let row: HTMLDivElement, ptx: HTMLDivElement;
  onMount(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const natural = () => {
      const m = new DOMMatrixReadOnly(getComputedStyle(ptx).transform === 'none' ? undefined : getComputedStyle(ptx).transform);
      return ptx.getBoundingClientRect().top - m.m42;
    };
    let top = natural(), win = `${innerWidth}x${innerHeight}`;
    const ro = new ResizeObserver(() => {
      const now = natural(), w = `${innerWidth}x${innerHeight}`, d = top - now;
      const glide = w === win && Math.abs(d) > 1 && motionAllowed() && typeof ptx.animate === 'function';
      top = now; win = w;
      if (!glide) return;
      // Web Animations: starts from where the text was, independent of the style before this frame
      ptx.animate([{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }], { duration: 250, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    });
    ro.observe(row);
    return () => ro.disconnect();
  });
</script>

<div class="ptitle" class:port={orient === 'portrait'} bind:this={row}>
  <div class="ptx" class:off={hidden} bind:this={ptx}>
    {#if chapter}<em>{chapter}</em>{/if}
    {#if title}<b {title}>{title}</b>{/if}
    {#if sub}<span>{sub}</span>{/if}
  </div>
  <slot name="skip" />
</div>

<style>
  .ptitle { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; min-width: 0; }
  .ptitle.port { flex-direction: column; align-items: stretch; gap: 10px; }
  .ptitle > :global(*:not(.ptx)) { flex: none; }
  .ptitle.port > :global(*:not(.ptx)) { align-self: flex-end; }
  .ptx { display: grid; gap: 3px; min-width: 0; max-width: 58%; text-shadow: 0 1px 10px rgba(0, 0, 0, .5);
    transition: opacity 200ms ease, visibility 0s linear 0s; }
  .ptx.off { opacity: 0; visibility: hidden; transition: opacity 200ms ease, visibility 0s linear 200ms; }
  .port .ptx { max-width: 100%; }
  /* the chapter eyebrow is white with a coral bar (WCAG 1.4.3: coral text sank to 1:1 over a bright frame) */
  em { font-style: normal; color: #fff; border-left: 3px solid var(--acc, #ff4f6d); padding-left: 6px; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  b { font-size: 28px; font-weight: 900; line-height: 1.1; letter-spacing: -.01em; overflow-wrap: break-word;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
  .port b { font-size: 24px; }
  span { font-size: 13px; color: rgba(255, 255, 255, .92); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (prefers-reduced-motion: reduce) { .ptx, .ptx.off { transition: none; } }
</style>
