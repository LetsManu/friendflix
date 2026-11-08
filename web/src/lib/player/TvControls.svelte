<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { fmtClock } from '#lib/api';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { chapterIndexAt, chapterLabel, chapterMarks, trickFrame, type Chapter, type Trickplay } from '#lib/player/chapters';
  import { SPEEDS, speedLabel } from '#lib/player/bar';
  import type { SeekPreview } from '#lib/player/tvSeek';
  import type { TvButton } from '#lib/player/tvLayer';

  /**
   * TV control layer (spec 4, 5.1): back + title top left, a thin progress bar with chapter ticks and the remaining time,
   * a row of labelled buttons under it. Seek preview: a marker with the trickplay still, the target time and the chapter.
   * Speed / Quality open a small list above their button. Everything moves with transform / opacity only (spec 5.2);
   * the keys are handled by the Player (keydown bubbles to it from here).
   */
  export let shown = false;
  export let title = '';
  export let sub = '';
  export let paused = false;
  export let current = 0;
  export let duration = 0;
  export let buffered = 0;
  export let preview: SeekPreview = { active: false, target: 0 };
  export let trickplay: Trickplay | null | undefined = null;
  export let chapters: Chapter[] = [];
  export let buttons: TvButton[] = [];
  export let menu = '';
  export let rate = 1;
  export let qualities: Array<[string, number]> = [];
  export let quality = 0;
  export let canControl = true;
  /** the credits sequence's corner beat: the hidden bar takes no focus and no keys (nothing behind the sequence is reachable) */
  export let inert = false;
  /** AirPlay (Safari only, so the TV-mode preview in a Mac browser): a trailing button that opens the system picker; null = none */
  export let airplay: { on: boolean; label: string } | null = null;
  /** height of the bottom block (the skip button and the page's cards sit above it) */
  export let height = 0;

  const dispatch = createEventDispatcher<{ back: void; button: TvButton; speed: number; quality: number; airplay: void }>();

  let track: HTMLDivElement | undefined, trackW = 0, row: HTMLDivElement | undefined;
  const frac = (s: number) => (duration > 0 ? Math.max(0, Math.min(1, s / duration)) : 0);
  $: played = frac(current);
  $: buf = frac(buffered);
  $: marks = chapterMarks(chapters, duration);
  $: remaining = duration ? $t('tv.player.remaining', { time: fmtClock(Math.max(0, duration - current)) }) : '';
  // the preview card: 16:9, about a sixth of the screen wide, centred over the marker and kept inside the bar's width
  let cardW = 320;
  $: frame = preview.active ? trickFrame(trickplay, preview.target, cardW) : null;
  $: chapterName = preview.active ? chapterAt(preview.target) : '';
  $: cardX = Math.max(0, Math.min(Math.max(0, trackW - cardW), frac(preview.target) * trackW - cardW / 2));
  function chapterAt(s: number) { const i = chapterIndexAt(chapters, s); return chapters.length > 1 && i >= 0 ? chapterLabel(chapters[i]!, i) : ''; }

  const ICON: Record<TvButton, string> = { episodes: 'list', next: 'skip-next', tracks: 'subtitles', speed: 'gauge', quality: 'monitor' };
  function label(b: TvButton, tf: typeof $t): string {
    switch (b) {
      case 'episodes': return tf('player.controls.episodes');
      case 'next': return tf('player.controls.next');
      case 'tracks': return tf('player.controls.tracks');
      case 'speed': return tf('player.speed.short');
      default: return tf('player.quality.title');
    }
  }
  const btnEls: Partial<Record<TvButton, HTMLButtonElement>> = {};
  /** a list item was picked: the list closes (Player), the focus goes back to its button */
  function pick(kind: 'speed' | 'quality', v: number) {
    dispatch(kind, v);
    void tick().then(() => btnEls[kind]?.focus());
  }
  /** a small list opens on its current value */
  function focusOn(el: HTMLElement) { void tick().then(() => (el.querySelector<HTMLElement>('[aria-checked="true"]') ?? el.querySelector<HTMLElement>('button'))?.focus()); }

  onMount(() => {
    cardW = Math.max(160, Math.round(window.innerWidth / 6));
    // Down from the bar lands on the first button (the geometric neighbour would be the one under the bar's centre)
    const nav = (e: Event) => {
      const dir = (e as CustomEvent<{ dir: string }>).detail?.dir;
      if (dir !== 'down') return;
      const first = row?.querySelector<HTMLElement>('button');
      if (first) { e.preventDefault(); first.focus(); }
    };
    track?.addEventListener('ff-nav', nav);
    return () => track?.removeEventListener('ff-nav', nav);
  });
</script>

<div class="tvc ui ctl" {inert} class:hide={!shown} class:seeking={preview.active} data-nav role="toolbar" tabindex="-1" aria-label={$t('player.controls.toolbar')} on:click|stopPropagation on:keydown>
  <div class="scrim top" aria-hidden="true"></div>
  <div class="scrim bot" aria-hidden="true"></div>

  <div class="head">
    <button type="button" class="back" aria-label={$t('player.watch.back')} on:click={() => dispatch('back')}><Icon name="arrow-left" size={30} /></button>
    {#if title}
      <div class="ttl">
        <h2 class="tv-display">{title}</h2>
        {#if sub}<p class="tv-meta">{sub}</p>{/if}
      </div>
    {/if}
  </div>

  <div class="foot" bind:offsetHeight={height}>
    <div class="line">
      <span class="tv-meta now"><Icon name={paused ? 'pause' : 'play'} size={20} />{fmtClock(current)}</span>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="sbar" class:locked={!canControl} bind:this={track} bind:clientWidth={trackW} data-tvtrack role="slider" tabindex="0" aria-label={$t('player.positionLabel')}
        aria-valuemin="0" aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(preview.active ? preview.target : current)}
        aria-valuetext={$t('player.valueText', { a: fmtClock(preview.active ? preview.target : current), b: fmtClock(duration) })}>
        <div class="rl">
          <i class="buf" style="transform:scaleX({buf})"></i>
          <i class="played" style="transform:scaleX({played})"></i>
          {#each marks as m (m.i)}<i class="tick" style="left:{m.pct}%"></i>{/each}
        </div>
        <i class="knob" style="transform:translate3d({played * trackW}px,0,0)" aria-hidden="true"><i class="kd"></i></i>
        {#if preview.active}
          <i class="marker" style="transform:translate3d({frac(preview.target) * trackW}px,0,0)" aria-hidden="true"></i>
          <div class="pv" style="width:{cardW}px;transform:translate3d({cardX}px,0,0)" data-testid="seek-preview" aria-hidden="true">
            <div class="pcard" style="--w:{cardW}px">
              {#if frame}
                <div class="still" style="height:{frame.h}px"><div style="width:{frame.sw}px;height:{frame.sh}px;background-image:url({frame.url});background-size:{frame.bw}px {frame.bh}px;background-position:-{frame.x}px -{frame.y}px;transform:scale({frame.k});transform-origin:0 0"></div></div>
              {/if}
              <b class="pt">{fmtClock(preview.target)}</b>
              {#if chapterName}<span class="pc">{chapterName}</span>{/if}
            </div>
          </div>
        {/if}
      </div>
      <span class="tv-meta left">{remaining}</span>
    </div>

    <div class="btns" bind:this={row} role="group">
      {#each buttons as b (b)}
        {@const lbl = label(b, $t)}
        <div class="bw">
          <button type="button" class="tv-btn rb" bind:this={btnEls[b]} aria-label={lbl} aria-expanded={b === 'next' ? undefined : menu === b}
            on:click={() => dispatch('button', b)}><Icon name={ICON[b]} size={26} /><span>{lbl}</span>{#if b === 'speed' && rate !== 1}<span class="val">{$t('player.speed.rate', { r: rate })}</span>{/if}</button>
          {#if menu === 'speed' && b === 'speed'}
            <div class="list" data-nav data-scope role="dialog" aria-label={$t('player.speed.title')} use:focusOn>
              {#each SPEEDS as r (r)}
                <button type="button" class="li" role="menuitemradio" aria-checked={rate === r} on:click={() => pick('speed', r)}><span class="ck">{#if rate === r}<Icon name="check" size={22} />{/if}</span>{speedLabel(r, $t)}</button>
              {/each}
            </div>
          {:else if menu === 'quality' && b === 'quality'}
            <div class="list" data-nav data-scope role="dialog" aria-label={$t('player.quality.title')} use:focusOn>
              <button type="button" class="li" role="menuitemradio" aria-checked={quality === 0} on:click={() => pick('quality', 0)}><span class="ck">{#if quality === 0}<Icon name="check" size={22} />{/if}</span>{$t('player.quality.auto')}</button>
              {#each qualities as [q, bps] (bps)}
                <button type="button" class="li" role="menuitemradio" aria-checked={quality === bps} on:click={() => pick('quality', bps)}><span class="ck">{#if quality === bps}<Icon name="check" size={22} />{/if}</span>{q}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
      {#if airplay}
        <div class="bw"><button type="button" class="tv-btn rb" data-testid="airplay" aria-label={airplay.label} aria-pressed={airplay.on} on:click={() => dispatch('airplay')}><Icon name="airplay" size={26} /><span>{airplay.label}</span></button></div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* the layer covers the stage but only its controls take the pointer (skip button, next-up card and the picture stay hittable) */
  .tvc { position: absolute; inset: 0; z-index: 8; pointer-events: none; color: #fff; }
  .tvc :global(button), .sbar { pointer-events: auto; }
  .tvc.hide :global(button), .tvc.hide .sbar { pointer-events: none; }

  /* scrims (spec 5.1): black -> transparent, no blur; they fade, they never slide */
  .scrim { position: absolute; left: 0; right: 0; opacity: 1; transition: opacity var(--tv-d-m) var(--tv-emph-out); }
  .scrim.top { top: 0; height: 30%; background: linear-gradient(180deg, rgba(0, 0, 0, .72) 0%, rgba(0, 0, 0, .35) 45%, rgba(0, 0, 0, 0) 100%); }
  .scrim.bot { bottom: 0; height: 46%; background: linear-gradient(0deg, #000 0%, rgba(0, 0, 0, .78) 30%, rgba(0, 0, 0, .3) 65%, rgba(0, 0, 0, 0) 100%); }

  /* top left: back + title; it only fades (spec 4) */
  .head { position: absolute; top: var(--tv-safe-y, 5vh); left: var(--tv-safe-x, 5vw); right: var(--tv-safe-x, 5vw); display: flex; align-items: flex-start; gap: 1.25rem; transition: opacity var(--tv-d-m) var(--tv-emph-out); }
  :global(html.tv) .back { flex: none; width: 3.5rem; min-height: 3.5rem; padding: 0; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: #fff; transition: transform var(--tv-d-s) var(--tv-emph-out); }
  :global(html.tv) .back:focus-visible { outline: none; background: #fff; color: #000; transform: scale(1.05); transition: transform var(--tv-d-spring) var(--tv-spring); }
  .ttl { min-width: 0; padding-top: .35rem; text-shadow: 0 1px 12px rgba(0, 0, 0, .45); }
  :global(html.tv) .ttl .tv-display { font-size: 2.2rem; line-height: 1.1; -webkit-line-clamp: 1; line-clamp: 1; }
  :global(html.tv) .ttl .tv-meta { margin: .4rem 0 0; color: var(--tv-white-78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* bottom: the bar and the button row rise 24 px + fade in (--tv-emph-out 320 ms), leave with --tv-emph-in 200 ms */
  .foot { position: absolute; left: var(--tv-safe-x, 5vw); right: var(--tv-safe-x, 5vw); bottom: var(--tv-safe-y, 5vh); display: flex; flex-direction: column; gap: 1.5rem;
    transform: translate3d(0, 0, 0); transition: transform var(--tv-d-m) var(--tv-emph-out), opacity var(--tv-d-m) var(--tv-emph-out); }
  .tvc.hide .scrim, .tvc.hide .head, .tvc.hide .foot { opacity: 0; transition-duration: var(--tv-d-s); transition-timing-function: var(--tv-emph-in); }
  .tvc.hide .foot { transform: translate3d(0, 24px, 0); }

  .line { display: flex; align-items: center; gap: 1.5rem; }
  :global(html.tv) .line .tv-meta { flex: none; margin: 0; color: var(--tv-white-88); min-width: 5.5ch; }
  .now { display: inline-flex; align-items: center; gap: .6rem; }
  .now :global(svg) { opacity: .8; }
  .left { text-align: right; }

  /* the bar: 4 px, 6 px with focus (a scaleY, not a height change), coral on 22 % white, chapter ticks as small gaps */
  .sbar { position: relative; flex: 1 1 auto; min-width: 0; height: 2.25rem; display: flex; align-items: center; }
  /* focus shows as the thicker bar + the knob, not as a ring around it */
  :global(html.tv) .sbar:focus-visible { outline: none; }
  .rl { position: relative; width: 100%; height: 4px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .22); transform-origin: center; transition: transform var(--tv-d-s) var(--tv-emph-out); }
  .rl i { position: absolute; top: 0; bottom: 0; left: 0; }
  .buf, .played { width: 100%; transform-origin: left center; }
  .buf { background: rgba(255, 255, 255, .28); }
  .played { background: var(--acc); }
  .tick { width: 3px; margin-left: -1.5px; background: rgba(0, 0, 0, .75); }
  .sbar:focus-visible .rl { transform: scaleY(1.5); }
  /* the knob: the outer box follows the position (translate), the dot inside scales (transform, not the `scale` property: webOS 22/23) */
  .knob { position: absolute; left: -.5rem; top: 50%; width: 1rem; height: 1rem; margin-top: -.5rem; }
  .kd { position: absolute; inset: 0; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .5); opacity: 0; transform: scale(.6); transition: opacity var(--tv-d-xs) ease-out, transform var(--tv-d-spring) var(--tv-spring); }
  .sbar:focus-visible .kd { opacity: 1; transform: scale(1); }
  .seeking .kd { opacity: .5; transform: scale(.6); }
  .marker { position: absolute; left: -1.5px; top: 50%; width: 3px; height: 1.6rem; margin-top: -.8rem; border-radius: 2px; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .35); }

  /* the preview card: above the marker, kept inside the bar; it scales in from .92 with the spring */
  .pv { position: absolute; left: 0; bottom: calc(100% + 1rem); }
  .pcard { display: flex; flex-direction: column; align-items: center; gap: .5rem; transform-origin: 50% 100%; animation: tv-pv-in var(--tv-d-spring) var(--tv-spring) both; }
  .still { position: relative; width: 100%; overflow: hidden; border-radius: var(--tv-radius, 6px); background: #141414; box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 18px 40px rgba(0, 0, 0, .55); }
  .pt { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; text-shadow: 0 1px 10px rgba(0, 0, 0, .6); }
  .pc { max-width: 100%; font-size: 1.1rem; font-weight: 500; color: var(--tv-white-78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 10px rgba(0, 0, 0, .6); margin-top: -.25rem; }
  @keyframes tv-pv-in { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }

  /* the button row: transparent icon + label rows (the detail page's buttons, laid out horizontally); white fill on focus */
  .btns { display: flex; align-items: flex-end; gap: .75rem; margin-left: -1.25rem; }
  .bw { position: relative; }
  :global(html.tv) .rb { min-height: 3.5rem; padding: 0 1.25rem; gap: .7rem; font-size: 1.2rem; white-space: nowrap; transform-origin: center; }
  :global(html.tv) .rb:not(:focus-visible) { background: transparent; color: var(--tv-white-78); }
  :global(html.tv) .rb[aria-expanded='true']:not(:focus-visible) { background: var(--tv-btn-rest); color: #fff; }
  .val { font-variant-numeric: tabular-nums; color: var(--acc); font-weight: 600; }
  :global(html.tv) .rb:focus-visible .val { color: inherit; }

  /* Speed / Quality: a small vertical list above its button */
  .list { position: absolute; left: 0; bottom: calc(100% + .75rem); min-width: 15rem; padding: .5rem; display: flex; flex-direction: column; gap: .25rem; border-radius: 8px; background: rgba(20, 20, 20, .96); box-shadow: 0 18px 50px rgba(0, 0, 0, .6);
    transform-origin: 50% 100%; animation: tv-list-in var(--tv-d-m) var(--tv-emph-out) both; }
  @keyframes tv-list-in { from { opacity: 0; transform: translate3d(0, 12px, 0); } to { opacity: 1; transform: translate3d(0, 0, 0); } }
  :global(html.tv) .li { justify-content: flex-start; gap: .6rem; min-height: 3.5rem; padding: 0 1.25rem 0 .75rem; border: 0; border-radius: var(--tv-radius, 6px); background: transparent; color: var(--tv-white-78); font-size: 1.2rem; font-weight: 500; white-space: nowrap; }
  :global(html.tv) .li[aria-checked='true'] { color: #fff; font-weight: 600; }
  :global(html.tv) .li:focus-visible { outline: none; background: #fff; color: #000; }
  .ck { display: inline-grid; place-items: center; width: 1.5rem; flex: none; }

  @media (prefers-reduced-motion: reduce) {
    .pcard, .list { animation: none; }
    .tvc.hide .foot { transform: none; }
  }
</style>
