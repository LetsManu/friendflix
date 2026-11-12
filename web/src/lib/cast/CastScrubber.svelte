<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The TV's position track, shared by the remote screen and the expanded cast bar: a slider (pointer drag with a time bubble,
   * keys, intro / recap marks, a buffering line) and the elapsed / remaining times under it. It reads the engine's session and
   * calls `castEngine.seek`; a TV that does not play (connecting, reconnect, failed) leaves it disabled.
   */
  import { get } from 'svelte/store';
  import { api, fmtClock } from '#lib/api';
  import { segmentShown, serverCaps } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  import type { Segment } from '#lib/player/nextup';
  import { castEngine, type CastSession } from './engine';
  import { scrubberTarget, segmentMarks, timeLine } from './remotescreen';

  export let session: CastSession;
  /** the slider's accessible name */
  export let label: string;
  /** the range is this one episode (continuous play): the marks and times are the episode's, not the whole row's */
  export let episodeOnly = false;
  /** episodeOnly: the middle of the times row ("Folge 1 von 3") */
  export let episodeLine = '';

  /** takes the keyboard focus (the host moved its own focus target away) */
  export function focus() { scrubEl?.focus(); }

  $: live = session.state === 'playing';
  $: dur = session.duration;
  $: pos = session.position;

  // ---- intro / recap marks on the track ----
  let segs: Segment[] = [], segFor = '';
  $: if (session.itemId !== segFor) { segFor = session.itemId; segs = []; void loadSegments(session.itemId); }
  async function loadSegments(id: string) {
    const caps = get(serverCaps);
    if (!caps.segments.length) return;
    try {
      const r = await api<{ segments: Segment[] } | null>(`/api/items/${id}/segments`);
      if (segFor === id) segs = (r?.segments ?? []).map((x) => ({ ...x, type: String(x.type).toLowerCase() })).filter((x) => segmentShown(caps, x.type));
    } catch { /* no marks */ }
  }
  $: marks = segmentMarks(segs, dur);

  // ---- the track ----
  let railW = 0, drag: number | null = null, scrubEl: HTMLDivElement | undefined;
  $: frac = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
  $: shown = drag ?? frac;
  $: tl = timeLine(drag === null ? session : { position: drag * dur, duration: dur }, $t);
  const BUBBLE_W = 64;
  $: bubbleX = Math.min(Math.max(0, shown * railW - BUBBLE_W / 2), Math.max(0, railW - BUBBLE_W));
  const fracAt = (e: PointerEvent): number => {
    const r = scrubEl!.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
  };
  function scrubDown(e: PointerEvent) {
    if (!live || !(dur > 0) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    scrubEl?.setPointerCapture(e.pointerId);
    drag = fracAt(e);
  }
  function scrubMove(e: PointerEvent) { if (drag !== null) drag = fracAt(e); }
  function scrubUp(e: PointerEvent) {
    if (drag === null) return;
    const f = fracAt(e);
    drag = null;
    castEngine.seek(f * dur);
  }
  function scrubKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const to = scrubberTarget(e.key, pos, dur);
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation(); // the Player's own seek keys would seek a second time
    if (live) castEngine.seek(to);
  }
</script>

<div class="scrubwrap" data-episode-only={episodeOnly ? '' : undefined}>
  <div class="scrub" bind:this={scrubEl} bind:clientWidth={railW} role="slider" tabindex="0" aria-disabled={live ? undefined : 'true'}
    aria-label={label}
    aria-valuemin={0} aria-valuemax={Math.floor(dur)} aria-valuenow={Math.floor(pos)} aria-valuetext={tl.valueText}
    on:keydown={scrubKey} on:pointerdown={scrubDown} on:pointermove={scrubMove} on:pointerup={scrubUp} on:pointercancel={() => (drag = null)} on:lostpointercapture={() => (drag = null)}>
    <div class="rail"><i class="fill" style="transform:scaleX({shown})"></i></div>
    <div class="markbar" aria-hidden="true">
      {#each marks as m}<i class="mk" style="left:{m.left * 100}%;width:{m.width * 100}%"><b class="mkl">{$t(`player.segment.${m.type}`)}</b></i>{/each}
    </div>
    <div class="bufwrap" aria-hidden="true"><i class="buf" class:on={session.buffering}></i></div>
    <i class="knob" aria-hidden="true" style="transform:translateX({shown * railW}px)"></i>
    <span class="bubble" class:on={drag !== null} aria-hidden="true" style="transform:translateX({bubbleX}px)">{fmtClock(drag === null ? 0 : drag * dur)}</span>
  </div>
  {#if episodeOnly}
    <div class="times ep" aria-hidden="true"><span>{$t('player.castRemote.played', { time: tl.elapsed })}</span><span class="mid">{episodeLine}</span><span>{$t('player.castRemote.left', { time: tl.remaining.replace('\u2212', '') })}</span></div>
  {:else}
    <div class="times" aria-hidden="true"><span>{tl.elapsed}</span><span>{tl.remaining}</span></div>
  {/if}
</div>

<style>
  .scrubwrap { display: grid; color: #fff; }
  .scrub { user-select: none; -webkit-user-select: none; position: relative; height: 44px; display: flex; align-items: center; cursor: pointer; touch-action: pan-y; }
  .scrub[aria-disabled='true'] { cursor: default; }
  .rail { position: relative; width: 100%; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, .28); overflow: hidden; }
  .fill { position: absolute; inset: 0; background: var(--acc); transform-origin: left; }
  .markbar { position: absolute; left: 0; right: 0; top: 50%; height: 5px; margin-top: -2.5px; pointer-events: none; }
  .mk { position: absolute; top: 0; bottom: 0; background: rgba(255, 255, 255, .38); border-left: 2px solid rgba(255, 255, 255, .9); border-radius: 2px; }
  .mkl { position: absolute; left: 0; bottom: 9px; font-size: .7rem; font-weight: 700; letter-spacing: .02em; color: rgba(255, 255, 255, .85); white-space: nowrap; }
  .knob { position: absolute; left: -8px; top: 50%; margin-top: -8px; width: 16px; height: 16px; border-radius: 50%; background: var(--acc); box-shadow: 0 0 0 2px #fff; pointer-events: none; }
  .scrub[aria-disabled='true'] .knob { opacity: .5; }
  .scrub:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 8px; }
  .bubble { position: absolute; left: 0; bottom: calc(100% + 2px); width: 64px; padding: 4px 0; text-align: center; border-radius: 8px; background: var(--fr-solid); border: 1px solid var(--fr-line); font-variant-numeric: tabular-nums; font-weight: 700; font-size: .85rem; opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
  .bubble.on { opacity: 1; }
  .bufwrap { position: absolute; left: 0; right: 0; bottom: 8px; height: 2px; overflow: hidden; pointer-events: none; }
  .buf { display: block; height: 2px; width: 100%; background: rgba(255, 255, 255, .85); opacity: 0; transform-origin: left; transform: scaleX(.3) translateX(-100%); }
  .buf.on { opacity: .9; animation: cs-buf 1.3s ease-in-out infinite; }
  @keyframes cs-buf { from { transform: scaleX(.3) translateX(-100%); } to { transform: scaleX(.3) translateX(333%); } }
  .times { display: flex; justify-content: space-between; font-size: .85rem; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, .78); margin-top: -4px; }

  .times.ep { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; }
  .times.ep .mid { text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* calm mode and reduced motion: nothing moves */
  :global(html.m-still) .scrubwrap :is(*, *::before, *::after) { transition: none !important; animation: none !important; }
  :global(html.m-still) .buf.on { transform: none; opacity: .5; }
  @media (prefers-reduced-motion: reduce) {
    .scrubwrap :is(*, *::before, *::after) { transition: none !important; animation: none !important; }
    .buf.on { transform: none; opacity: .5; }
  }
</style>
