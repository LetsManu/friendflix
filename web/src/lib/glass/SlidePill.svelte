<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { pillParts } from '#lib/glass/fx';
  import { alphaOf } from '#lib/desk/bar';

  /**
   * The sliding selection pill (glass spec §8.4): a left cap, a middle part scaled on X and a right cap, all placed by
   * `transform`, so the pill glides to the selected entry and seems to change width without animating `width`. It sits
   * absolutely inside `host` (which must be positioned, e.g. `.frost`) under the entries (give them `position: relative`).
   * It follows the entry `selector` matches: on mount, when the host resizes and when the selection changes (`aria-selected`,
   * `aria-current` or `class` on any element inside the host but the pill, entries added / removed, or a label's text changed:
   * the host's width is capped, so a longer label does not always resize it). The glide (450 ms, the spring)
   * runs only with full motion off TV and kids (`html.m-glass`); otherwise, and on the first placement, it jumps.
   */
  export let host: HTMLElement | undefined;
  export let selector: string;
  /** 'white': a solid white pill (the selected label is then #111); 'light': the light selected fill (`--fr-sel`) */
  export let tone: 'light' | 'white' = 'light';

  let l = '', m = '', r = '', h = 0, y = 0, on = false, ready = false, raf = 0, sp: HTMLSpanElement | undefined;
  /** the light fill's alpha (white at the `--fr-sel` token's alpha), read from the host: the parts are drawn opaque and the
   * pill fades as a group, so where the caps overlap the middle part nothing adds up (no seam) */
  let selA: number | null = null;
  function place() {
    const el = host?.querySelector<HTMLElement>(selector);
    if (!el || !el.offsetWidth) { on = false; return; }
    if (selA === null && host) selA = alphaOf(getComputedStyle(host).getPropertyValue('--fr-sel'));
    h = el.offsetHeight; y = el.offsetTop;
    ({ l, mid: m, r } = pillParts({ x: el.offsetLeft, w: el.offsetWidth }, h));
    on = true;
    // the first placement does not glide in: transitions turn on after it was painted
    if (!ready && !raf) raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { raf = 0; ready = true; }); });
  }

  let ro: ResizeObserver | undefined, mo: MutationObserver | undefined, bound: HTMLElement | undefined;
  function bind(node: HTMLElement | undefined) {
    if (node === bound) return;
    ro?.disconnect(); mo?.disconnect();
    bound = node;
    if (!node) return;
    place();
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(place); ro.observe(node); }
    if (typeof MutationObserver !== 'undefined') {
      // the pill's own class flips (on, ready) are not a change of the selection; a label's text is (a new language)
      mo = new MutationObserver((list) => { if (list.some((x) => !sp?.contains(x.target))) place(); });
      mo.observe(node, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current', 'class'] });
    }
  }
  $: bind(host);
  /** a new selector (another entry kind) is measured again */
  $: if (bound && selector) place();
  onDestroy(() => { ro?.disconnect(); mo?.disconnect(); if (raf) cancelAnimationFrame(raf); });
</script>

<!-- the entry's top is a translateY on each part too, so a vertical list (the settings side navigation) glides as well -->
<span class="sp" bind:this={sp} class:ready class:on class:white={tone === 'white'} aria-hidden="true" style="--sp-h:{h}px" style:--sp-a={tone === 'white' ? undefined : selA ?? undefined}>
  <i class="l" style="transform:translateY({y}px) {l}"></i><i class="m" style="transform:translateY({y}px) {m}"></i><i class="r" style="transform:translateY({y}px) {r}"></i>
</span>

<style>
  .sp { position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: 0; }
  /* the light fill is the --fr-sel token (white at .13): the parts are drawn opaque white and the whole pill takes the token's
     alpha as its opacity (--sp-a, read from the token on the first placement), so the 1 px where a cap overlaps the middle part
     is not lit twice (a translucent fill per part drew a hard light seam there) */
  .sp.on { opacity: var(--sp-a, .13); }
  .sp i { position: absolute; left: 0; top: 0; height: var(--sp-h); background: #fff; transform-origin: 0 50%; }
  .sp.white.on { opacity: 1; }
  /* the caps are circles cut in half, reaching 1 px over the middle part: the scaled middle part's edges are resampled (soft),
     so the overlap hides the seam; the middle part is 100 px before scaling */
  .sp .l, .sp .r { width: var(--sp-h); border-radius: 50%; }
  .sp .l { clip-path: inset(0 calc(50% - 1px) 0 0); }
  .sp .r { clip-path: inset(0 0 0 calc(50% - 1px)); }
  .sp .m { width: 100px; }
  /* the glide: full motion only (calm mode, reduced motion, a tripped frame guard, TV and kids: it jumps) */
  :global(html.m-glass:not(.tv):not(.kids)) .sp.ready i { transition: transform 450ms var(--fr-spring); }
  :global(html.m-still) .sp i { transition: none; }
</style>
