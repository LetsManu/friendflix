<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Phone, controls hidden (spec 2026-11-08 §1): a 3 px progress line at the bottom edge, inside the safe area; fades with opacity. */
  export let pct = 0;
  export let shown = false;
  $: k = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0)) / 100;
</script>

<div class="pline" class:on={shown} aria-hidden="true"><i style="transform: scaleX({k})"></i></div>

<style>
  .pline { position: absolute; left: var(--safe-left, 0px); right: calc(var(--safe-right, 0px) + var(--inset, 0px)); bottom: var(--safe-bottom, 0px); z-index: 8;
    height: 3px; background: rgba(255, 255, 255, .18); pointer-events: none; opacity: 0; transition: opacity 250ms ease; }
  .pline.on { opacity: 1; }
  i { position: absolute; inset: 0; background: var(--acc, #ff4f6d); transform-origin: 0 50%; }
  @media (prefers-reduced-motion: reduce) { .pline { transition: none; } }
</style>
