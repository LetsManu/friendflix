<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The cast bar expanded (desktop): the title and what follows, the TV's position, volume, transport, the audio and subtitle
   * chips, Open remote and Stop. It grows out of the bar's More button (`trigger`) and replaces the collapsed bar in place; Escape,
   * Collapse or a click outside collapse it (event `collapse`, the bar returns the focus). It owns no media: everything calls
   * `castEngine` or the cast helpers, like the remote screen.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import { cachedItem } from '#lib/api';
  import { castSetVolume, castState, castToggleMute } from '#lib/cast';
  import { growBoth } from '#lib/glass/fx';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { confirm } from '#lib/ui/confirm';
  import { barLine2Full, barTitleFull } from './bar';
  import { castEngine, castSession, type CastSession } from './engine';
  import CastScrubber from './CastScrubber.svelte';
  import { castThumbs } from './remoteview';
  import { applePlatform, volumeLine } from './remotescreen';
  import TrackChips from './TrackChips.svelte';

  export let session: CastSession;
  /** the More button it grows out of (its rectangle, measured when this opens) */
  export let trigger: Element | null = null;

  /** `via`: how it was closed, so the bar can decide about the focus (a click elsewhere keeps its own) */
  const dispatch = createEventDispatcher<{ collapse: { via: 'key' | 'button' | 'outside' } }>();

  let root: HTMLDivElement | undefined, collapseBtn: HTMLButtonElement | undefined;
  /** the Stop question is open: Escape and clicks belong to it */
  let asking = false;
  onMount(() => collapseBtn?.focus());

  $: s = session;
  $: air = s.kind === 'airplay';
  $: live = s.state === 'playing';
  $: it = cachedItem(s.itemId);
  $: line1 = barTitleFull(s, it, $t);
  $: l2 = barLine2Full(s, Date.now(), $t);

  // ---- artwork ----
  let thI = 0, artFor = '';
  $: thumbs = castThumbs(s, 320);
  $: if (s.itemId !== artFor) { artFor = s.itemId; thI = 0; }

  // ---- transport ----
  const playPause = () => { if (live) castEngine.playPause(); };
  const seekBy = (d: number) => { if (live) castEngine.seek(Math.min(s.duration, Math.max(0, s.position + d))); };
  const goNext = () => { if (live || s.state === 'ended') void castEngine.next(); };
  $: skip = live ? s.skip ?? null : null;
  let lastSkip = 'intro';
  $: if (skip) lastSkip = skip.type;

  // ---- volume (Chromecast; AirPlay has the Apple device's own buttons) ----
  $: vol = Math.round(Math.min(1, Math.max(0, $castState.volume)) * 100);
  $: muted = $castState.muted;
  const onVolume = (e: Event) => { if (muted) castToggleMute(); castSetVolume(Number((e.currentTarget as HTMLInputElement).value) / 100); };
  $: volHint = volumeLine(s.kind, typeof navigator === 'undefined' ? null : applePlatform(navigator.userAgent, navigator.maxTouchPoints), $t);

  // ---- tracks: a switch clears them until the new token's info arrives; the chips stay (disabled) so the row keeps its room ----
  let kept: Pick<CastSession, 'audioTracks' | 'subtitles'> | null = null;
  $: if (s.audioTracks.length || s.subtitles.length) kept = { audioTracks: s.audioTracks, subtitles: s.subtitles };
  $: chipSession = s.state === 'connecting' && !s.audioTracks.length && !s.subtitles.length && kept ? { ...s, ...kept } : s;
  $: hasChips = chipSession.audioTracks.length > 0 || (!air && chipSession.subtitles.length > 0);

  // ---- actions ----
  function openRemote() { void goto('/watch/' + get(castSession)?.itemId); }
  async function stop() {
    const c = get(castSession);
    if (!c) return;
    asking = true;
    try {
      if (await confirm({ title: tr('player.castBar.stopQuestion', { device: c.device }), danger: true, confirmLabel: tr('player.castBar.stop', { device: c.device }) })) await castEngine.stop();
    } finally { asking = false; }
  }

  // ---- closing ----
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || asking) return;
    e.preventDefault();
    dispatch('collapse', { via: 'key' });
  }
  function onPointer(e: PointerEvent) {
    if (asking || !root) return;
    const el = e.target as Element | null;
    if (!el || root.contains(el) || el.closest('[role=dialog], [role=alertdialog], .toasts')) return;
    dispatch('collapse', { via: 'outside' });
  }
</script>

<svelte:window on:keydown={onKey} on:pointerdown={onPointer} />

<div class="exp frost frost-safe frost-panel" bind:this={root} role="region" aria-label={$t('player.castBar.regionExpanded')} transition:growBoth|global={{ trigger }}>
  <div class="head">
    <div class="thumb">{#if thumbs[thI]}<img src={thumbs[thI]} alt="" on:error={() => thI++} />{:else}<span class="ph"><Icon name="film" size={28} /></span>{/if}</div>
    <div class="txt">
      <p class="t1">{line1}</p>
      <p class="t2" class:warn={l2.tone === 'warn'} class:error={l2.tone === 'error'}>{l2.text}</p>
    </div>
    <button type="button" class="frost-btn round" bind:this={collapseBtn} aria-label={$t('player.castBar.collapse')} title={$t('player.castBar.collapse')} on:click={() => dispatch('collapse', { via: 'button' })}>
      <Icon name="chevron-down" size={22} />
    </button>
  </div>

  <CastScrubber {session} label={$t('player.castRemote.position')} />

  <div class="trow">
    <div class="vol">
      {#if volHint}
        <p class="volhint"><Icon name="airplay" size={16} />{volHint}</p>
      {:else}
        <button type="button" class="tb mute" aria-label={$t(muted ? 'player.castRemote.unmute' : 'player.castRemote.mute')} on:click={castToggleMute}>
          <Icon name={muted ? 'volume-off' : 'volume'} size={22} />
        </button>
        <input class="vslider" type="range" min="0" max="100" step="5" value={muted ? 0 : vol} aria-label={$t('player.castRemote.volume')} aria-valuetext={$t('player.castRemote.volumeValue', { n: muted ? 0 : vol })}
          style="--v:{muted ? 0 : vol}%" on:input={onVolume} on:keydown|stopPropagation />
      {/if}
    </div>
    <div class="tp">
      <button type="button" class="tb" aria-disabled={live ? undefined : 'true'} aria-label={$t('player.controls.back10')} title={$t('player.controls.back10')} on:click={() => seekBy(-10)}><Icon name="rewind10" size={28} /></button>
      <button type="button" class="tb pp" aria-disabled={live ? undefined : 'true'} aria-busy={s.state === 'connecting' ? 'true' : undefined}
        aria-label={$t(s.paused ? 'player.controls.play' : 'player.controls.pause')} on:click={playPause}>
        {#if s.state === 'connecting'}<span class="spin" aria-hidden="true"></span>{:else}<Icon name={s.paused ? 'play' : 'pause'} size={26} />{/if}
      </button>
      <button type="button" class="tb" aria-disabled={live ? undefined : 'true'} aria-label={$t('player.controls.forward10')} title={$t('player.controls.forward10')} on:click={() => seekBy(10)}><Icon name="forward10" size={28} /></button>
      {#if s.isEpisode}
        <button type="button" class="tb" aria-disabled={live || s.state === 'ended' ? undefined : 'true'} aria-label={$t('player.controls.next')} title={$t('player.controls.next')} on:click={goNext}><Icon name="skip-next" size={26} /></button>
      {/if}
    </div>
    <div class="sk">
      <button type="button" class="frost-btn skipb" class:on={Boolean(skip)} inert={!skip} on:click={() => castEngine.skipSegment()}>
        {$t(lastSkip === 'recap' ? 'player.skip.recap' : 'player.skip.intro')}
      </button>
    </div>
  </div>

  <hr class="div" />

  <div class="foot">
    <div class="chips">{#if hasChips}<TrackChips session={chipSession} airplay={air} icons={false} disabled={s.state === 'connecting'} />{/if}</div>
    <div class="acts">
      <button type="button" class="frost-btn" on:click={openRemote}><Icon name="tv" size={18} />{$t('player.castBar.open')}</button>
      <button type="button" class="frost-btn" on:click={stop}>{$t('player.cast.stop')}</button>
    </div>
  </div>
</div>

<style>
  /* anchored at the bottom of the bar's place (it grows upwards), 640 px, as high as its content */
  .exp { position: absolute; bottom: 0; left: 0; right: 0; margin-inline: auto; width: min(640px, 100%); box-sizing: border-box; padding: 16px 20px 16px; display: grid; gap: 4px; }
  button { font: inherit; }
  button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .head { display: flex; align-items: center; gap: 16px; min-width: 0; margin-bottom: 4px; }
  .thumb { flex: none; width: 112px; height: 63px; border-radius: 10px; overflow: hidden; background: #1c2228; display: grid; place-items: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph { color: #9aa4ad; }
  .txt { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; }
  .t1, .t2 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t1 { font-weight: 700; font-size: 1.02rem; }
  .t2 { font-size: .88rem; color: rgba(255, 255, 255, .72); }
  .t2.warn { color: #f7b344; }
  .t2.error { color: #ffa8a8; }

  .trow { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 8px; }
  .vol { justify-self: start; display: flex; align-items: center; gap: 4px; min-width: 0; }
  .volhint { margin: 0; display: flex; align-items: center; gap: 6px; font-size: .8rem; line-height: 1.25; color: rgba(255, 255, 255, .78); }
  .tp { display: flex; align-items: center; gap: 8px; }
  .sk { justify-self: end; }
  .tb { flex: none; width: 48px; height: 48px; min-height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #fff; display: inline-grid; place-items: center; cursor: pointer; }
  .tb:hover:not(:disabled) { background: rgba(255, 255, 255, .16); }
  .tb[aria-disabled='true'] { opacity: .45; cursor: default; }
  .tb[aria-busy='true'] { opacity: .85; }
  .tb.pp, .tb.pp:hover:not(:disabled) { width: 56px; height: 56px; background: var(--acc-fill); }
  .tb.pp:hover:not(:disabled) { background: var(--acc-fill-hover); }
  .mute { width: 44px; height: 44px; }
  .skipb { font-size: .85rem; padding: 0 16px; opacity: 0; transform: translateY(6px); transition: opacity 200ms ease, transform 200ms ease; pointer-events: none; }
  .skipb.on { opacity: 1; transform: none; pointer-events: auto; }
  .vslider { -webkit-appearance: none; appearance: none; width: 104px; height: 44px; margin: 0; background: transparent; cursor: pointer; }
  .vslider::-webkit-slider-runnable-track { height: 5px; border-radius: 3px; background: linear-gradient(to right, var(--acc) var(--v), rgba(255, 255, 255, .28) var(--v)); }
  .vslider::-moz-range-track { height: 5px; border-radius: 3px; background: rgba(255, 255, 255, .28); }
  .vslider::-moz-range-progress { height: 5px; border-radius: 3px; background: var(--acc); }
  .vslider::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -5.5px; border-radius: 50%; background: var(--acc); border: 0; box-shadow: 0 0 0 2px #fff; }
  .vslider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--acc); border: 0; box-shadow: 0 0 0 2px #fff; }
  .vslider:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 8px; }

  .div { margin: 4px 0 8px; border: 0; height: 1px; background: rgba(255, 255, 255, .2); }
  .foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 12px; min-height: 44px; }
  .chips { min-width: 0; }
  .acts { margin-left: auto; display: flex; gap: 10px; }
  .acts :global(.frost-btn) { font-size: .88rem; padding: 0 16px; white-space: nowrap; }

  .spin { width: 24px; height: 24px; border-radius: 50%; border: 3px solid rgba(255, 255, 255, .35); border-top-color: #fff; animation: ce-spin .9s linear infinite; }
  @keyframes ce-spin { to { transform: rotate(360deg); } }

  /* calm mode and reduced motion: nothing moves (the panel is solid through the .frost rules) */
  :global(html.m-still) .exp :global(*), :global(html.m-still) .exp :global(*::before) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .exp :global(*), .exp :global(*::before) { transition: none !important; animation: none !important; }
  }
</style>
