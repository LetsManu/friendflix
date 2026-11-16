<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The brand's mark (lib/brand.ts): the uploaded symbol, else FriendFlix's own F tile (its middle bar a play button) for the shipped
   * name, else the name's initial on the accent fill. `wordmark` adds the name next to it, `byline` the byline under the name (the
   * sign-in and start screens), `header` lets the brand's header style decide (wordmark, symbol plus name, or the uploaded logo).
   * The default brand renders exactly today's mark and lettering (on narrow phones the F tile alone, as before; another brand keeps
 * its name there, since a letter tile does not name it). The name never grows past its box (ellipsis), so a long name moves
   * nothing beside it; an uploaded logo sits in a fixed 4:1 box (Admin → Branding fits it into 2048×512), so it cannot jump on load.
   */
  import { brand, brandInitial, builtInMark, headerParts } from '#lib/brand';
  export let size = 32;
  export let wordmark = false;
  /** a header bar: the brand's header style decides what shows (lib/brand.ts headerParts) */
  export let header = false;
  /** the byline under the name (sign-in, TV and Chromecast start screens) */
  export let byline = false;
  /** the accessible name (default: the brand's name); '' = decorative */
  export let label: string | undefined = undefined;
  /** soft drop shadow (header over video); off by default: a filter per instance costs a paint layer (cards, rows) */
  export let shadow = false;
  const uid = 'ffl' + Math.random().toString(36).slice(2, 7);

  $: b = $brand;
  $: lbl = label ?? b.name;
  $: parts = header ? headerParts(b) : { mark: true, name: wordmark, logo: null };
  $: by = byline && parts.name ? b.brand.byline.trim() : '';
  $: textShown = parts.name;
</script>

<!-- an empty label means decorative (next to its own text): hidden from assistive tech, never an unnamed image -->
<span class="logo" class:wm={textShown} class:shadow class:own={!builtInMark(b)} role={textShown || parts.logo || !lbl ? undefined : 'img'} aria-label={textShown || parts.logo || !lbl ? undefined : lbl} aria-hidden={lbl ? undefined : 'true'}>
  {#if parts.logo}
    <img class="limg" src={parts.logo} alt={lbl} width={size * 4} height={size} style:width="{size * 4}px" style:height="{size}px" draggable="false" />
  {:else}
    {#if parts.mark}
      {#if b.images.symbol}
        <img class="sym" src={b.images.symbol} alt="" aria-hidden="true" width={size} height={size} style:width="{size}px" style:height="{size}px" draggable="false" />
      {:else if builtInMark(b)}
        <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="{uid}g" x1="8" y1="2" x2="56" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" class="g0" /><stop offset="1" class="g1" /></linearGradient>
          </defs>
          <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#{uid}g)" />
          <path fill="#fff" d="M19 18a4 4 0 0 1 4-4h23a4 4 0 0 1 0 8H28v28a4.500 4.500 0 0 1-9 0z" />
          <path fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round" d="M33.500 29.500 45.500 36 33.500 42.500z" />
        </svg>
      {:else}
        <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <rect x="2" y="2" width="60" height="60" rx="15" class="fill" />
          <text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-size="34" font-weight="800" fill="#fff">{brandInitial(b.name)}</text>
        </svg>
      {/if}
    {/if}
    {#if textShown}
      {#if by}
        <span class="names"><span class="txt">{b.name}</span><span class="by">{by}</span></span>
      {:else}
        <span class="txt">{b.name}</span>
      {/if}
    {/if}
  {/if}
</span>

<style>
  .logo { display: inline-flex; align-items: center; gap: .55rem; line-height: 1; min-width: 0; max-width: 100%; }
  svg, .sym, .limg { flex: none; display: block; }
  .g0 { stop-color: var(--mark-from); }
  .g1 { stop-color: var(--mark-to); }
  .fill { fill: var(--acc-fill); }
  .sym { border-radius: 23%; object-fit: cover; }
  .limg { object-fit: contain; object-position: left center; }
  .shadow :is(svg, .sym, .limg) { filter: drop-shadow(0 2px 6px rgba(0, 0, 0, .45)); }
  /* the name ellipsizes in its box; the padding (cancelled by the margin) keeps descenders inside the clip without changing the box */
  .txt { font-weight: 800; letter-spacing: -.01em; font-size: clamp(1.15rem, 2.1vw, 1.55rem); color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    min-width: 0; max-width: var(--logo-name-max, 12em); padding: .2em 0; margin: -.2em 0; }
  .names { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
  .by { font-size: .82rem; font-weight: 600; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: .15em 0; margin: -.15em 0; }
  /* narrow phones: FriendFlix's F tile names the app on its own (today's look); another brand keeps its name, ellipsized */
  @media (max-width: 420px) { .logo:not(.own) :is(.txt, .names) { display: none; } }
</style>
