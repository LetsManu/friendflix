<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { img } from '#lib/api';
  import { playOrCast } from '#lib/cast/playOrCast';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { SCRIM_SAFE_DIM } from '#lib/glass/tone';
  import { handoffAge, handoffDevice, handoffHref, handoffTime, handoffTitle, type Handoff } from './handoff';

  /**
   * "Continue here" (device hand-off spec 2.4): what another device played last, with a button that goes on from that position.
   * An overlay: the host puts it in its `handoff` slot, which is out of the flow (absolute), so it never moves anything; it fades in
   * with a 8 px drop and fades out (opacity only). Not a live region: it is found in reading order, right after the page's heading.
   */
  export let handoff: Handoff | null;
  export let layout: 'desk' | 'phone' | 'tv' = 'desk';
  const dispatch = createEventDispatcher<{ dismiss: string }>();

  /** the leave fade (opacity) is under way */
  let leaving = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** the moment the card was built: the age counts from there, so the line does not change while it shows */
  const now = Date.now();
  const LEAVE_MS = 180;

  $: h = handoff;
  $: device = h ? handoffDevice(h, $t) : '';
  $: time = h ? handoffTime(h.positionTicks) : '';
  $: title = h ? handoffTitle(h, $t) : '';
  $: last = h ? $t('home.handoff.last', { device, age: handoffAge(h.ageSec, $t, now) }) : '';
  $: label = h ? $t('home.handoff.playAria', { title, time, device }) : '';

  const still = () => document.documentElement.classList.contains('m-still') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  function close() {
    if (!h || leaving) return;
    const id = h.id;
    if (still()) { dispatch('dismiss', id); return; }
    leaving = true;
    timer = setTimeout(() => dispatch('dismiss', id), LEAVE_MS);
  }
  function go(e: MouseEvent) {
    if (h) playOrCast(e, { id: h.itemId, positionTicks: h.positionTicks }, { explicitStart: true });
  }
  onDestroy(() => clearTimeout(timer));
</script>

{#if h}
  <div class="hc frost frost-safe frost-panel {layout}" class:leaving style="--fr-scrim-safe:{SCRIM_SAFE_DIM}" role="region" aria-label={$t('home.handoff.region')} data-handoff>
    {#if layout !== 'phone'}<img class="thumb" src={img(h.imageId, 320)} alt="" width="96" height="54" loading="eager" decoding="async" />{/if}
    <div class="txt">
      <p class="last">{last}</p>
      <p class="name">{title}</p>
    </div>
    <a class="play" href={handoffHref(h)} aria-label={label} on:click={go}><Icon name="play" size={20} /><span>{$t('home.handoff.play', { time })}</span></a>
    <button type="button" class="x frost-btn round" aria-label={$t('home.handoff.dismiss')} title={$t('home.handoff.dismiss')} on:click={close}><Icon name="x" size={18} /></button>
  </div>
{/if}

<style>
  /* out of the flow: the host's slot is absolute (DeskBillboard / Hero / the page's phone wrapper), so the rows below never move */
  .hc { position: absolute; z-index: 6; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 14px; align-items: start; padding: 14px; color: #fff; pointer-events: auto;
    animation: hc-in 240ms cubic-bezier(.22, 1, .36, 1) both; transition: opacity 180ms linear; }
  .hc.desk { top: 0; right: var(--pad-x); width: 380px; max-width: calc(100% - 2 * var(--pad-x)); }
  .hc.phone { top: calc(var(--nav-total) + 8px); left: 16px; right: 16px; }
  .hc.tv { top: 0; right: var(--tv-gutter, 3.5rem); width: 520px; font-size: 1.25rem; }
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
