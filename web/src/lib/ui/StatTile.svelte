<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  /** tiles that already counted during this visit (by label): coming back to a page shows their values at once */
  const counted = new Set<string>();
</script>

<script lang="ts">
  /**
   * Number tile for dashboards (the value is not a heading).
   *   <StatTile icon="users" label={$t('admin.dash.users')} value={12} hint="3 gesperrt" href="/admin/users" tone="warn" />
   * value=null → skeleton. `pressed` (true/false) makes the tile a toggle button (filter tiles; on:click, aria-pressed).
   * A glass tile (glass spec §7). A plain number (`countable`) counts up from 0 the first time the tile is 40 % in view
   * (COUNT_MS, ease-out, rAF); the box keeps the final value's width and tabular figures, so nothing shifts. Calm mode and
   * reduced motion show it at once, as do later value changes; units and dashes (`'3 GB'`, `'–'`) never count. While it
   * counts, the moving figures are hidden from assistive tech and the final value is read instead.
   */
  import { onDestroy, onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtNumber } from '#lib/i18n';
  import { countable } from '#lib/admin/glass';
  import { COUNT_MS, countAt, fxMode } from '#lib/glass/fx';
  import Skeleton from './Skeleton.svelte';
  export let label: string;
  export let value: string | number | null = null;
  export let icon = '';
  export let hint = '';
  export let href: string | undefined = undefined;
  export let tone: 'default' | 'ok' | 'warn' | 'err' = 'default';
  export let pressed: boolean | undefined = undefined;
  $: toggle = !href && pressed !== undefined;

  let el: HTMLElement | undefined, seen = false, used = false, raf = 0;
  /** what the tile shows (the value, or a figure on the way to it) */
  let shown: string | number | null = value;
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function sync(v: string | number | null, inView: boolean) {
    if (used || counted.has(label)) used = true;
    if (used || v === null) { stop(); shown = v; return; }
    const to = countable(v);
    if (to === null || to === 0 || typeof requestAnimationFrame === 'undefined' || fxMode() === 'still') { used = true; shown = v; return; }
    if (!inView) { shown = fmtNumber(0); return; }
    used = true;
    counted.add(label);
    shown = fmtNumber(0);
    const t0 = performance.now();
    const frame = (now: number) => {
      const ms = now - t0;
      // done, or calm mode / reduced motion turned on meanwhile: the value at once
      if (ms >= COUNT_MS || fxMode() === 'still') { raf = 0; shown = v; return; }
      shown = fmtNumber(countAt(to, ms));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  $: sync(value, seen);
  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') { seen = true; return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { seen = true; io.disconnect(); } }, { threshold: 0.4 });
    if (el) io.observe(el);
    return () => io.disconnect();
  });
  onDestroy(stop);
  /** a figure on the way (or 0 before the tile was seen): hidden from assistive tech, which reads the value */
  $: hide = shown !== null && value !== null && shown !== value;
  /** the final value's width: the box never grows while the figures run */
  $: minW = value === null ? undefined : `${String(value).length}ch`;
</script>

{#if toggle}
<button type="button" bind:this={el} aria-pressed={pressed} class="tile frost-flat frost-text edge-hover {tone} link toggle" class:on={pressed} on:click>
  {#if icon}<span class="ic" aria-hidden="true"><Icon name={icon} size={20} /></span>{/if}
  <span class="txt">
    <span class="val" style:min-width={minW} aria-hidden={hide ? 'true' : undefined}>{#if shown === null}<Skeleton w="3rem" h="1.6rem" />{:else}{shown}{/if}</span>{#if hide}<span class="sr-only">{value}</span>{/if}
    <span class="lbl">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
</button>
{:else}
<svelte:element this={href ? 'a' : 'div'} bind:this={el} {href} class="tile frost-flat frost-text {tone}" class:link={!!href} class:edge-hover={!!href}>
  {#if icon}<span class="ic" aria-hidden="true"><Icon name={icon} size={20} /></span>{/if}
  <span class="txt">
    <span class="val" style:min-width={minW} aria-hidden={hide ? 'true' : undefined}>{#if shown === null}<Skeleton w="3rem" h="1.6rem" />{:else}{shown}{/if}</span>{#if hide}<span class="sr-only">{value}</span>{/if}
    <span class="lbl">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  {#if href}<span class="go" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>{/if}
</svelte:element>
{/if}

<style>
  /* a glass tile (frost-flat; 18 px corners, 16 px in the dense admin): hover fades in a lit edge (.edge-hover, opacity only),
     never more fill (more milk would drop the dim text under AA); a selected filter tile carries a coral ring (instant) */
  .tile { display: flex; align-items: flex-start; gap: .8rem; padding: 16px 18px; border-radius: var(--fr-r-tile); min-width: 0; }
  .toggle { width: 100%; min-height: 44px; font: inherit; font-weight: 400; color: inherit; text-align: left; justify-content: flex-start; cursor: pointer; }
  .toggle:hover:not(:disabled) { background: linear-gradient(180deg, rgba(var(--fr-milk-top), var(--fr-milk-a2)), rgba(var(--fr-milk), var(--fr-milk-a1))), rgba(var(--fr-scrim-rgb), var(--fr-scrim)); }
  .toggle.on, .toggle.on:hover { border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc), inset 0 1px 0 var(--fr-hi); }
  /* glass never nests: a tile inside a glass card is part of it */
  :global(:is(.frost, .frost-flat, .panel)) .tile, :global(:is(.frost, .frost-flat, .panel)) .tile:hover:not(:disabled) { background: rgba(var(--fr-scrim-rgb), .3); box-shadow: none; }
  :global(:is(.frost, .frost-flat, .panel)) .toggle.on { box-shadow: inset 0 0 0 1px var(--acc); }
  /* the solid fallback (calm mode, reduced motion, TV, kids) keeps its hover solid too */
  :global(html:not(.m-glass)) .toggle:hover:not(:disabled), :global(html.tv) .toggle:hover:not(:disabled), :global(html.kids) .toggle:hover:not(:disabled) { background: var(--fr-solid-hover); }
  :global(:is(.frost, .frost-flat, .panel)) .tile::before { display: none; }
  .ic { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: 50%; background: rgba(255,255,255,.08); }
  .ok .ic { background: var(--tone-ok); color: var(--ok); }
  .warn .ic { background: var(--tone-warn); color: var(--warn); }
  .err .ic { background: var(--tone-err); color: var(--err); }
  .txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .val { display: inline-block; align-self: flex-start; font-size: 1.6rem; font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .lbl { color: var(--mut); font-size: .88rem; }
  .hint { font-size: .8rem; color: var(--hint, var(--mut)); margin-top: .15rem; }
  .warn .hint { color: var(--warn); } .err .hint { color: var(--err); }
  .go { align-self: center; color: var(--mut); }
</style>
