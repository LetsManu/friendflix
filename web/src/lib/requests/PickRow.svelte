<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * One choosable line of the season picker and the collection sheet: a check box, an optional poster, the name and a second line
   * (meta text and a state pill). The whole row is the click / touch target (at least 52 px high); the real checkbox lies over it
   * (invisible), so Tab, Space / Enter (OK on a remote) and the TV d-pad (lib/spatial.ts measures the focused element) land on the row. A row that cannot be
   * chosen has no checkbox (not focusable) but keeps the box column, so every name starts at the same x. The pill sits on the second
   * line: when it changes (state -> result) the name never rewraps and the row keeps its height.
   */
  import Icon from '#lib/Icon.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';

  export let label: string;
  export let meta = '';
  export let checked = false;
  /** false: shown for information only (no checkbox) */
  export let selectable = true;
  export let disabled = false;
  /** the "all" row: some but not all are chosen */
  export let mixed = false;
  /** show the poster column (collection parts) */
  export let posterCol = false;
  export let poster: string | undefined = undefined;
  export let pill: { tone: Tone; label: string; icon?: string } | null = null;
  /** the "all" row is set apart (bold, a line under it) */
  export let head = false;

  /** OK on a TV remote (and Enter on a keyboard) ticks the row like Space; it never sends the form */
  const okKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).click();
  };
  const setMixed = (node: HTMLInputElement, v: boolean) => {
    node.indeterminate = v;
    return { update: (n: boolean) => { node.indeterminate = n; } };
  };
</script>

<label class="pr" class:off={!selectable} class:on={checked && selectable} class:head class:dim={disabled}>
  {#if selectable}<input type="checkbox" {checked} {disabled} use:setMixed={mixed} on:change on:keydown={okKey} />{/if}
  <span class="box" aria-hidden="true">{#if selectable && checked}<Icon name="check" size={16} />{:else if selectable && mixed}<span class="dash"></span>{/if}</span>
  {#if posterCol}<span class="po" aria-hidden="true">{#if poster}<img src={poster} alt="" loading="lazy" decoding="async" width="40" height="60" />{/if}</span>{/if}
  <span class="tx">
    <span class="nm">{label}</span>
    {#if meta || pill}<span class="mt">{#if meta}<span class="mx">{meta}</span>{/if}{#if pill}<StatusPill tone={pill.tone} icon={pill.icon} label={pill.label} />{/if}</span>{/if}
  </span>
</label>

<style>
  .pr { position: relative; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 6px 10px; border-radius: 12px; cursor: pointer; }
  .pr.off { cursor: default; }
  .pr:not(.off):hover { background: rgba(255, 255, 255, .06); }
  .pr.dim { opacity: .6; cursor: default; }
  .pr.head { font-weight: 700; }
  input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
  .pr:has(input:focus-visible), :global(html.tv) .pr:has(input:focus) { outline: 2px solid #fff; outline-offset: 0; box-shadow: 0 0 0 4px var(--ring-dark, #000); }
  .box { flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .55); color: #1a1a1a; }
  .off .box { visibility: hidden; }
  .on .box, .box:has(.dash) { background: var(--acc); box-shadow: none; }
  .dash { width: 10px; height: 2px; border-radius: 1px; background: #1a1a1a; }
  .po { flex: none; width: 40px; height: 60px; border-radius: 6px; overflow: hidden; background: #1c2228; }
  .po img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .nm { font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
  .mt { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 22px; font-size: 13px; color: var(--mut); white-space: nowrap; overflow: hidden; }
  .mx { flex: none; }
  .mt :global(.pill) { min-width: 0; }
</style>
