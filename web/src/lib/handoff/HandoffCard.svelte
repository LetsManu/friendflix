<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { img } from '#lib/api';
  import { playOrCast } from '#lib/cast/playOrCast';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { SCRIM_SAFE_DIM } from '#lib/glass/tone';
  import { isBackKey } from '#lib/spatial';
  import { handoffAge, handoffDevice, handoffHref, handoffTime, handoffTitle, type Handoff } from './handoff';

  /**
   * "Continue here" (device hand-off spec 2.4): what another device played last, with a button that goes on from that position.
   * An overlay: the host puts it in its `handoff` slot, which is out of the flow (absolute), so it never moves anything; it fades in
   * with a 8 px drop and fades out (opacity only). Not a live region: it is found in reading order, right after the page's heading.
   */
  export let handoff: Handoff | null;
  export let layout: 'desk' | 'phone' | 'tv' = 'desk';
  /**
   * TV: the focus tile shows the billboard (focus in the tile). False fades the card out without dismissing it (the focus is in
   * the rows); it then takes no focus (`inert` + `data-nav-skip`: old TV engines have no native inert, lib/spatial skips both).
   */
  export let tvVisible = true;
  /** TV: puts the focus on the tile's first button (Back on the card, Down, and after Ausblenden) */
  export let focusTile: () => void = () => {};
  const dispatch = createEventDispatcher<{ dismiss: string }>();

  /** the leave fade (opacity) is under way */
  let leaving = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** the moment the card was built: the age counts from there, so the line does not change while it shows */
  const now = Date.now();
  const LEAVE_MS = 180;
  /** another hand-off (a new id) on the same open page is a new card: the leave state of the dismissed one does not carry over */
  let shownId = '';
  $: if ((handoff?.id ?? '') !== shownId) { shownId = handoff?.id ?? ''; leaving = false; clearTimeout(timer); }

  $: h = handoff;
  $: device = h ? handoffDevice(h, $t) : '';
  $: time = h ? handoffTime(h.positionTicks) : '';
  $: title = h ? handoffTitle(h, $t) : '';
  $: last = h ? $t('home.handoff.last', { device, age: handoffAge(h.ageSec, $t, now) }) : '';
  $: label = h ? $t('home.handoff.playAria', { title, time, device }) : '';
  $: tv = layout === 'tv';
  $: away = tv && !tvVisible;
  /** not to be reached (faded for the rows, or fading out after Ausblenden): skipped by the remote, Tab and assistive tech */
  $: off = away || leaving;
  /** the entrance ran (or the card arrived hidden): showing it again is a plain fade, it does not drop in a second time */
  let entered = false;
  $: if (away) entered = true;

  const still = () => document.documentElement.classList.contains('m-still') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  function close() {
    if (!h || leaving) return;
    const id = h.id;
    if (tv) focusTile(); // the focus never stays on a fading button
    if (still()) { dispatch('dismiss', id); return; }
    leaving = true;
    timer = setTimeout(() => dispatch('dismiss', id), LEAVE_MS);
  }
  function go(e: MouseEvent) {
    if (h) playOrCast(e, { id: h.itemId, positionTicks: h.positionTicks }, { explicitStart: true });
  }
  /** TV remote: Back returns to the tile without dismissing (the page's Back, opening the rail, does not run) */
  function onKey(e: KeyboardEvent) {
    if (!tv || !(isBackKey(e) || e.key === 'Escape')) return;
    e.preventDefault();
    e.stopPropagation();
    focusTile();
  }
  /**
   * TV, lib/spatial's step hook: Down goes back to the tile's buttons (not past them into the rows); Up stays (above the card
   * there is only the rail's corner, which would open it). Left / Right between the two buttons are the plain geometric moves.
   */
  function remote(node: HTMLElement) {
    const on = (e: Event) => {
      const dir = (e as CustomEvent<{ dir: string }>).detail?.dir;
      if (!tv || (dir !== 'down' && dir !== 'up')) return;
      e.preventDefault();
      if (dir === 'down') focusTile();
    };
    node.addEventListener('ff-nav', on);
    return { destroy: () => node.removeEventListener('ff-nav', on) };
  }
  /** TV: a refresh took the card away while it held the focus: the focus goes to the tile instead of falling to <body> */
  let root: HTMLElement | undefined;
  $: if (!handoff) release();
  function release() {
    if (!tv || !root?.contains(document.activeElement)) return;
    void tick().then(() => { if (!document.activeElement || document.activeElement === document.body) focusTile(); });
  }
  onDestroy(() => clearTimeout(timer));
</script>

{#if h}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (only the remote's Back, bubbling from the buttons) -->
  <div class="hc frost frost-safe frost-panel {layout}" class:leaving class:away class:entered style="--fr-scrim-safe:{SCRIM_SAFE_DIM}" role="region" aria-label={$t('home.handoff.region')} aria-hidden={off ? 'true' : undefined} inert={off || undefined} data-nav-skip={off ? '' : undefined} data-handoff bind:this={root}
    on:animationend={(e) => { if (e.target === e.currentTarget) entered = true; }} on:keydown={onKey} use:remote>
    {#if layout !== 'phone'}<img class="thumb" src={img(h.imageId, 320)} alt="" width="96" height="54" loading="eager" decoding="async" />{/if}
    <div class="txt">
      <p class="last">{last}</p>
      <p class="name">{title}</p>
    </div>
    {#if tv}
      <!-- the tile's buttons: the focus is the white fill; Right goes from the action to Ausblenden on the same line -->
      <div class="acts">
        <a class="go tv-btn" href={handoffHref(h)} aria-label={label} tabindex={off ? -1 : undefined} on:click={go}><Icon name="play" size={28} /><span>{$t('home.handoff.play', { time })}</span></a>
        <button type="button" class="x2 tv-btn2" aria-label={$t('home.handoff.dismiss')} title={$t('home.handoff.dismiss')} tabindex={off ? -1 : undefined} on:click={close}><Icon name="x" size={28} /></button>
      </div>
    {:else}
      <a class="play" href={handoffHref(h)} aria-label={label} on:click={go}><Icon name="play" size={20} /><span>{$t('home.handoff.play', { time })}</span></a>
      <button type="button" class="x frost-btn round" aria-label={$t('home.handoff.dismiss')} title={$t('home.handoff.dismiss')} on:click={close}><Icon name="x" size={18} /></button>
    {/if}
  </div>
{/if}

<style>
  /* out of the flow: the host's slot is absolute (DeskBillboard / Hero / the page's phone wrapper), so the rows below never move */
  .hc { position: absolute; z-index: 6; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 14px; align-items: start; padding: 14px; color: #fff; pointer-events: auto;
    animation: hc-in 240ms cubic-bezier(.22, 1, .36, 1) backwards; transition: opacity 180ms linear; }
  .hc.desk { top: 0; right: var(--pad-x); width: min(380px, max(220px, calc(100% - var(--pad-x) - 16px - var(--gutter, 32px) - max(420px, min(40vw, 640px))))); }
  /* the billboard is a size container: in a narrow column the thumbnail makes room for the text */
  @container (max-width: 900px) { .hc.desk { grid-template-columns: minmax(0, 1fr); } .desk .thumb { display: none; } .desk .txt { grid-column: 1; } }
  .hc.phone { top: calc(var(--nav-total) + 8px); left: 16px; right: 16px; }
  /* TV (spec 2.4): top right of the focus tile inside the gutter, clear of the tile's text column (left gutter + 52 %), solid
     (html.tv turns .frost into --fr-solid), the tile's type scale (rem: follows the html.tv root size) */
  .hc.tv { top: var(--tv-gutter); right: var(--tv-gutter); width: min(34rem, calc(48% - 2 * var(--tv-gutter) - 1.5rem)); gap: 1rem 1.25rem; padding: 1.5rem; align-items: center; }
  .tv .thumb { width: 10rem; height: 5.625rem; border-radius: var(--tv-radius); }
  .tv .txt { padding-right: 0; gap: .375rem; }
  .tv .last { font-size: 1.125rem; font-weight: 500; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; }
  .tv .name { font-size: 1.5rem; line-height: 1.25; }
  .acts { grid-column: 1 / -1; display: flex; gap: .75rem; min-width: 0; }
  /* a narrow TV viewport wraps the label inside the button rather than overflowing the panel */
  .acts .go { flex: 1 1 auto; min-width: 0; white-space: normal; line-height: 1.2; padding-block: .5rem; }
  .acts .x2 { flex: none; width: 3.5rem; padding: 0; }
  /* smaller TV viewports (1280 x 720; 960 x 540 in the Fire TV WebView): the card stays inside the tile (50vh). A smaller
     thumbnail, tighter panel and a smaller action label without its icon (two lines at most), then no thumbnail, one-line
     device line and the card nearer the top. */
  @media (max-width: 1599px) {
    .hc.tv { padding: 1.125rem; gap: .75rem 1rem; }
    .tv .thumb { width: 7.5rem; height: 4.21875rem; }
    .tv .last { font-size: 1rem; -webkit-line-clamp: 2; line-clamp: 2; }
    .tv .name { font-size: 1.25rem; }
    .acts .go { font-size: 1.125rem; padding-inline: 1rem; }
    .acts .go :global(svg) { display: none; }
  }
  @media (max-width: 1199px) {
    .hc.tv { top: 1.5rem; padding: 1rem; }
    .tv .thumb { display: none; }
    .tv .txt { grid-column: 1 / -1; gap: .25rem; }
    .tv .last { -webkit-line-clamp: 1; line-clamp: 1; }
    .tv .name { font-size: 1.125rem; }
  }
  /* faded out while the focus is in the rows (not dismissed): opacity only, nothing moves */
  .hc.away { opacity: 0; pointer-events: none; }
  .hc.entered, .hc.away { animation: none; }
  .hc.phone { grid-template-columns: minmax(0, 1fr); }
  .phone .txt { grid-column: 1; }
  .hc.leaving { animation: none; opacity: 0; }
  @keyframes hc-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
  .thumb { width: 96px; height: 54px; border-radius: 12px; object-fit: cover; background: rgba(255, 255, 255, .08); }
  .txt { grid-column: -2 / -1; min-width: 0; display: grid; gap: 4px; padding-right: 40px; }
  .last { margin: 0; font-size: .8125rem; line-height: 1.25; color: rgba(255, 255, 255, .9); }
  .name { margin: 0; font-size: 1rem; font-weight: 700; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; }
  .play { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 999px; background: var(--acc-fill); color: #fff; font-weight: 700; font-size: .9375rem; text-decoration: none; text-align: center; }
  .play:hover { background: var(--acc-fill-hover); }
  .play:focus-visible, .x:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
  .x { position: absolute; top: 6px; right: 6px; z-index: 1; }
  @media (prefers-reduced-motion: reduce) { .hc { animation: none; transition: none; } }
  :global(html.m-still) .hc { transition: none !important; animation: none !important; }
</style>
