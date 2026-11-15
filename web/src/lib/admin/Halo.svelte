<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** A ring that breathes out of the primary "Update now" button while an update runs (motion mock-up); still under reduced motion. */
  export let live = false;
</script>

<span class="halo" class:live><slot /></span>

<style>
  .halo { position: relative; display: inline-flex; border-radius: var(--fr-r-pill); }
  .halo::after { content: ''; position: absolute; inset: -6px; border-radius: inherit; border: 2px solid color-mix(in srgb, var(--acc) 50%, transparent); opacity: 0; pointer-events: none; }
  .live::after { animation: ff-halo 1.8s var(--fr-out) infinite; }
  @keyframes ff-halo { 0% { opacity: .8; transform: scale(.96); } 100% { opacity: 0; transform: scale(1.12); } }
  @media (prefers-reduced-motion: reduce) { .live::after { animation: none; opacity: .6; transform: none; } }
  :global(html.m-still) .live::after { animation: none; opacity: .6; transform: none; }
</style>
