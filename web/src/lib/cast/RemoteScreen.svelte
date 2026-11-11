<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script context="module" lang="ts">
  import type { CastTrack } from './engine';
  /**
   * What the screen knew a moment ago. The watch page follows the TV to the next episode by mounting a new screen, which starts
   * with no tracks until the new token's info arrives: for a few seconds the old state keeps the chips' and the card's room.
   */
  const MEMO_MS = 15_000;
  type Memo = { at: number; audioTracks: CastTrack[]; subtitles: CastTrack[]; episode: boolean };
  let memo: Memo | null = null;
</script>

<script lang="ts">
  /**
   * The watch page while its title plays on a TV: the TV's remote (spec 2026-11-10 §1). It owns no media; it reads the engine's
   * `castSession` and calls `castEngine`. The Player mounts it instead of its own controls and listens for `close` (back, like the
   * Back button) and `pick` (the device chip: the picker).
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { fade } from 'svelte/transition';
  import { api, cachedItem, type Item } from '#lib/api';
  import { castSetVolume, castState, castToggleMute } from '#lib/cast';
  import { serverCaps } from '#lib/capabilities';
  import { SCRIM_BAR } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { motionAllowed } from '#lib/preview';
  import { confirm } from '#lib/ui/confirm';
  import { castEngine, castSession } from './engine';
  import { HINT_SEEN_KEY } from './resume';
  import { castBackdrops, castThumbs, deviceLabel, playingLine } from './remoteview';
  import CastScrubber from './CastScrubber.svelte';
  import { applePlatform, nowLine, remoteLayout, statusOf, upNextLine, upNextOf, volumeLine } from './remotescreen';
  import TrackChips from './TrackChips.svelte';
  import UpNextCard from './UpNextCard.svelte';

  const dispatch = createEventDispatcher<{ close: void; pick: HTMLElement }>();

  $: s = $castSession;
  $: air = s?.kind === 'airplay';
  /** play / pause / seek only drive a TV that plays (connecting, reconnect, failed and ended have no live token) */
  $: live = s?.state === 'playing';
  let w = 0;
  $: layout = remoteLayout(w || 1200);
  $: phone = layout === 'phone';
  $: st = s ? statusOf(s, $t) : null;

  // ---- artwork: the fallback chain advances when an image fails ----
  let bgI = 0, thI = 0, artFor = '';
  $: bgs = s ? castBackdrops(s) : [];
  $: thumbs = s ? castThumbs(s) : [];
  $: if ((s?.itemId ?? '') !== artFor) { artFor = s?.itemId ?? ''; bgI = 0; thI = 0; }

  // ---- what plays ----
  let fetched: Item | undefined;
  $: item = s ? cachedItem(s.itemId) ?? (fetched?.id === s.itemId ? fetched : undefined) : undefined;
  let askedFor = ''; // one request per title, also when it fails
  $: if (s && s.itemId !== askedFor && !cachedItem(s.itemId)) { askedFor = s.itemId; void loadItem(s.itemId); }
  async function loadItem(id: string) {
    try { const r = await api<{ item: Item }>(`/api/items/${id}`); if (get(castSession)?.itemId === id) fetched = r.item; } catch { /* the session's own subtitle */ }
  }
  $: line = s ? nowLine(s, item, $t, phone) : '';

  // ---- scrubber (CastScrubber: the track, its marks, the times) ----
  let scrubber: CastScrubber | undefined;
  $: dur = s?.duration ?? 0;
  $: pos = s?.position ?? 0;

  // ---- transport ----
  const playPause = () => { if (live) castEngine.playPause(); };
  const seekBy = (d: number) => { if (live) castEngine.seek(Math.min(dur, Math.max(0, pos + d))); };
  const goNext = () => { if (live || s?.state === 'ended') void castEngine.next(); };
  async function stop() {
    const c = get(castSession);
    if (!c) return;
    if (await confirm({ title: tr('player.castBar.stopQuestion', { device: c.device }), danger: true, confirmLabel: tr('player.castBar.stop', { device: c.device }) })) await castEngine.stop();
  }
  /** `reconnect` runs inside the tap (AirPlay opens the system picker, which needs the gesture) */
  const reconnect = () => castEngine.reconnect();
  const playHere = () => castEngine.release();

  // ---- volume (Chromecast; AirPlay has the Apple device's own buttons) ----
  $: vol = Math.round(Math.min(1, Math.max(0, $castState.volume)) * 100);
  $: muted = $castState.muted;
  const onVolume = (e: Event) => { if (muted) castToggleMute(); castSetVolume(Number((e.currentTarget as HTMLInputElement).value) / 100); };
  $: volHint = s ? volumeLine(s.kind, typeof navigator === 'undefined' ? null : applePlatform(navigator.userAgent, navigator.maxTouchPoints), $t) : null;

  // ---- intro / recap skip ----
  $: skip = live ? s?.skip ?? null : null;
  let lastSkip = 'intro';
  $: if (skip) lastSkip = skip.type;

  // ---- next episode: the card (UpNextCard) tells; here it is announced once, with its start time, not every second ----
  $: next = s ? upNextOf(s) : null;
  let said = '', saidFor = '';
  // announced when the credits offer it (not at the start of every episode)
  $: if (s && s.next && next && next.itemId !== saidFor) { saidFor = next.itemId; said = `${tr('player.castRemote.upNext')}: ${next.label}. ${upNextLine(s, Date.now(), tr)}`; } else if (!s?.next && saidFor) { saidFor = ''; said = ''; }

  // ---- first-use hint (Chromecast: the cast outlives this tab). Dismissal is remembered per browser; the row fades and keeps its height for this visit ----
  const seenAtOpen = (() => { try { return localStorage.getItem(HINT_SEEN_KEY) === '1'; } catch { return false; } })();
  let hintOff = false;
  function dismissHint() {
    hintOff = true;
    try { localStorage.setItem(HINT_SEEN_KEY, '1'); } catch { /* private mode: it shows again next time */ }
    // the focused button fades away with its row: the focus goes on to the scrubber, the next stop
    scrubber?.focus();
  }
  /** a switch clears the tracks until the new token's info arrives: the chips stay (disabled) and keep their row */
  const fresh: Memo | null = memo && Date.now() - memo.at < MEMO_MS ? memo : null;
  let kept: { audioTracks: CastTrack[]; subtitles: CastTrack[] } | null = fresh ? { audioTracks: fresh.audioTracks, subtitles: fresh.subtitles } : null;
  $: if (s && (s.audioTracks.length || s.subtitles.length)) kept = { audioTracks: s.audioTracks, subtitles: s.subtitles };
  // the engine clears the tracks on a switch and fills only the subtitles: the old ones show (disabled) only while it connects
  $: chipSession = s && s.state === 'connecting' && !s.audioTracks.length && !s.subtitles.length && kept ? { ...s, ...kept } : s;
  $: hasChips = chipSession ? chipSession.audioTracks.length > 0 || chipSession.subtitles.length > 0 : false;
  let everChips = Boolean(kept?.audioTracks.length || kept?.subtitles.length);
  let everEpisode: boolean = Boolean(fresh?.episode);
  $: if (s) { if (s.isEpisode) everEpisode = true; else if (s.state === 'playing') everEpisode = false; }
  const remember = (k: typeof kept, ep: boolean) => { memo = { at: Date.now(), audioTracks: k?.audioTracks ?? [], subtitles: k?.subtitles ?? [], episode: ep }; };
  $: remember(kept, everEpisode);
  onDestroy(() => { if (memo) memo.at = Date.now(); });
  $: if (hasChips) everChips = true;

  // ---- AirPlay subtitles: the line under the chips (reserved once the title has subtitles, so nothing moves when it fades in) ----
  $: airSubs = air && (chipSession?.subtitles.length ?? 0) > 0;
  // reserved on every AirPlay screen: a next title with subtitles must not grow the panel
  $: subsNoServer = air && !$serverCaps.castHlsSubtitles;
  $: subsHintOn = air && !subsNoServer && (s?.subIndex ?? -1) >= 0;
  /** what the line shows (it is read only then; invisible it stays out of the accessibility tree) */
  $: subsShown = (subsNoServer && airSubs) || subsHintOn;
  $: subsText = $t(subsNoServer ? 'player.castRemote.subsNoServer' : 'player.castRemote.subsHint');
</script>

{#if s && st}
  <section class="rs castov" class:phone class:wide={layout === 'wide'} class:stacked={layout === 'stacked'} class:air
    style="--fr-scrim-safe:{SCRIM_BAR}" data-testid={air ? 'airplay-active' : 'cast-active'} bind:clientWidth={w}>
    {#if bgs[bgI]}<img class="bg" src={bgs[bgI]} alt="" aria-hidden="true" on:error={() => bgI++} />{/if}
    <div class="shade" aria-hidden="true"></div>

    <p class="sr-only" role="status" aria-live="polite">{said}</p>
    <p class="sr-only" role="status" aria-live="polite">{subsHintOn ? subsText : ''}</p>
    <div class="wrap">
      <div class="top" data-testid="cast-row">
        <button type="button" class="frost-btn round close" aria-label={$t('player.castRemote.close')} title={$t('player.castRemote.close')} on:click={() => dispatch('close')}>
          <Icon name={phone ? 'chevron-down' : 'chevron-left'} size={22} />
        </button>
        <button type="button" class="frost-btn chip" aria-label={air ? $t('player.castRemote.chipAirplay') : $t('player.castRemote.chip', { device: s.device })} title={air ? $t('player.castRemote.chipAirplay') : $t('player.castRemote.chip', { device: s.device })} on:click={(e) => dispatch('pick', e.currentTarget)}>
          <Icon name={air ? 'airplay' : 'cast'} size={18} /><span class="ell">{deviceLabel(s)}</span><Icon name="chevron-down" size={16} />
        </button>
        <button type="button" class="frost-btn stopb" aria-label={$t('player.cast.stop')} title={$t('player.cast.stop')} on:click={stop}>
          <Icon name="stop" size={18} /><span class="stoplbl">{$t(phone ? 'player.castRemote.stopShort' : 'player.cast.stop')}</span>
        </button>
      </div>

      <div class="grid">
        <section class="now frost frost-safe frost-panel" aria-labelledby="rs-title">
          {#if !phone}
            <div class="thumb">
              {#if thumbs[thI]}<img src={thumbs[thI]} alt="" on:error={() => thI++} />{:else}<span class="ph"><Icon name="film" size={32} /></span>{/if}
            </div>
          {/if}
          <div class="txt">
            <p class="eyebrow">{playingLine(s, $t)}</p>
            <h1 class="title" id="rs-title">{s.title}</h1>
            {#if line}<p class="sub">{line}</p>{/if}
            {#if !air && !seenAtOpen}
              <div class="hint" class:off={hintOff} inert={hintOff}>
                <p>{$t('player.castRemote.hint')}</p>
                <button type="button" class="hx" aria-label={$t('player.castRemote.hintDismiss')} title={$t('player.castRemote.hintDismiss')} on:click={dismissHint}><Icon name="x" size={18} /></button>
              </div>
            {/if}
          </div>
        </section>

        {#if s.isEpisode || everEpisode}
          <div class="unslot">
            {#if next}<div class="unfx" transition:fade={{ duration: motionAllowed() ? 200 : 0 }}><UpNextCard session={s} compact={phone} /></div>{/if}
          </div>
        {/if}
      </div>

      <div class="mid">
        <div class="statrow">
          <p class="stat frost frost-safe" class:on={Boolean(st.text)} class:warn={st.tone === 'warn'} class:error={st.tone === 'error'} role="status">
            {#if st.tone !== 'none'}<Icon name="alert" size={18} />{/if}{st.text}
          </p>
          {#if st.action === 'reconnect'}
            <button type="button" class="frost-btn act" on:click={reconnect}><Icon name="refresh" size={18} />{$t('player.castRemote.reconnectBtn')}</button>
          {:else if st.action === 'playHere'}
            <button type="button" class="act here" on:click={playHere}><Icon name="play" size={18} />{$t('player.castBar.playHere')}</button>
          {/if}
        </div>
        <button type="button" class="frost-btn skipb" class:on={Boolean(skip)} inert={!skip} on:click={() => castEngine.skipSegment()}>
          {$t(lastSkip === 'recap' ? 'player.skip.recap' : 'player.skip.intro')}
        </button>
      </div>

      <div class="cp frost frost-safe frost-panel" role="group" aria-label={$t('player.controls.toolbar')}>
        <CastScrubber bind:this={scrubber} session={s} label={$t('player.castRemote.position')} />

        <div class="ctrl">
          {#if everChips}<div class="cl">{#if hasChips && chipSession}<TrackChips session={chipSession} airplay={air} icons={w >= 1200} compact={phone} disabled={s.state === 'connecting'} describedby={subsShown ? 'rs-subs-hint' : undefined} />{/if}</div>{/if}
          <div class="tp">
            {#if phone && !air}
              <button type="button" class="tb mute" aria-label={$t(muted ? 'player.castRemote.unmute' : 'player.castRemote.mute')} on:click={castToggleMute}>
                <Icon name={muted ? 'volume-off' : 'volume'} size={24} />
              </button>
            {:else if phone}<span class="gap" aria-hidden="true"></span>{/if}
            <button type="button" class="tb" aria-disabled={live ? undefined : 'true'} aria-label={$t('player.controls.back10')} title={$t('player.controls.back10')} on:click={() => seekBy(-10)}><Icon name="rewind10" size={30} /></button>
            <button type="button" class="tb disc" aria-disabled={live ? undefined : 'true'} aria-busy={s.state === 'connecting' ? 'true' : undefined}
              aria-label={$t(s.paused ? 'player.controls.play' : 'player.controls.pause')} on:click={playPause}>
              {#if s.state === 'connecting'}<span class="spin" aria-hidden="true"></span>{:else}<Icon name={s.paused ? 'play' : 'pause'} size={phone ? 36 : 30} />{/if}
            </button>
            <button type="button" class="tb" aria-disabled={live ? undefined : 'true'} aria-label={$t('player.controls.forward10')} title={$t('player.controls.forward10')} on:click={() => seekBy(10)}><Icon name="forward10" size={30} /></button>
            {#if s.isEpisode}
              <button type="button" class="tb" aria-disabled={live || s.state === 'ended' ? undefined : 'true'} aria-label={$t('player.controls.next')} title={$t('player.controls.next')} on:click={goNext}><Icon name="skip-next" size={28} /></button>
            {:else if phone}<span class="gap" aria-hidden="true"></span>{/if}
          </div>

          <div class="vol">
            {#if volHint}
              <p class="volhint"><Icon name="airplay" size={16} />{volHint}</p>
            {:else}
              {#if !phone}
                <button type="button" class="tb mute" aria-label={$t(muted ? 'player.castRemote.unmute' : 'player.castRemote.mute')} on:click={castToggleMute}>
                  <Icon name={muted ? 'volume-off' : 'volume'} size={22} />
                </button>
              {/if}
              <input class="vslider" type="range" min="0" max="100" step="5" value={muted ? 0 : vol} aria-label={$t('player.castRemote.volume')} aria-valuetext={$t('player.castRemote.volumeValue', { n: muted ? 0 : vol })}
                style="--v:{muted ? 0 : vol}%" on:input={onVolume} on:keydown|stopPropagation />
              <span class="vval" aria-hidden="true">{$t('player.castRemote.volumeValue', { n: muted ? 0 : vol })}</span>
            {/if}
          </div>
        </div>
        {#if air}<p id="rs-subs-hint" class="sh" class:on={subsShown} aria-hidden={subsNoServer && airSubs ? undefined : 'true'}>{subsText}</p>{/if}
      </div>
    </div>
  </section>
{/if}

<style>
  .rs { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; color: #fff; background: #000; overflow: hidden auto;
    padding: calc(12px + var(--safe-top)) max(16px, var(--safe-right)) calc(16px + var(--safe-bottom)) max(16px, var(--safe-left)); }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: blur(16px) brightness(.5) saturate(1.1); transform: scale(1.08); }
  .shade { position: absolute; inset: 0; background: linear-gradient(rgba(0, 0, 0, .55), rgba(0, 0, 0, .25) 40%, rgba(0, 0, 0, .8)); pointer-events: none; }
  .wrap { position: relative; width: 100%; max-width: 1100px; margin: 0 auto; flex: 1 0 auto; display: flex; flex-direction: column; gap: 16px; min-height: 0; }
  .ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eyebrow { margin: 0; font-size: .78rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #ff8aa0; }

  /* top row: close, device chip (truncates), Stop */
  .top { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .chip { flex: 0 1 auto; min-width: 76px; max-width: 100%; padding: 0 14px; }
  .close { flex: none; }
  .stopb { margin-left: auto; flex: none; }
  .phone .chip { padding: 0 10px; gap: 6px; }
  .phone .chip :global(svg:last-child) { display: none; }
  .phone .stopb { padding: 0 14px; }
  :is(.close, .chip, .stopb) { font-size: .9rem; }
  @media (max-width: 359px) { .stoplbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); } .stopb { padding: 0 12px; } }

  /* the grid: now-playing left, up-next right (wide); stacked below 1100; one column on the phone */
  .grid { display: grid; gap: 16px; align-items: start; grid-template-columns: minmax(0, 1fr); justify-content: center; }
  .wide .grid { grid-template-columns: minmax(0, 1fr) 380px; }
  .stacked .grid { grid-template-columns: minmax(0, 660px); }
  .now { display: flex; gap: 20px; align-items: center; padding: 18px; min-width: 0; }
  .thumb { flex: 0 0 min(42%, 280px); aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; background: #1c2228; display: grid; place-items: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph { color: #9aa4ad; }
  .txt { min-width: 0; display: grid; gap: 6px; }
  .title { margin: 0; font-size: clamp(28px, 3.4vw, 48px); line-height: 1.08; font-weight: 800; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sub { margin: 0; color: rgba(255, 255, 255, .72); font-size: 1rem; overflow-wrap: anywhere; }
  .phone .now { padding: 14px 16px; display: block; }
  .phone .title { font-size: 34px; }

  /* the up-next slot keeps its room (episodes), the card fades in (opacity only) */
  .unslot { min-height: 204px; }
  .unfx { display: block; }
  .wide .unslot { min-height: 0; }
  /* phone: the card docks under the controls, above the home indicator */
  .phone .grid { display: contents; }
  .phone .top { order: 0; } .phone .now { order: 1; } .phone .mid { order: 3; } .phone .cp { order: 4; } .phone .unslot { order: 5; }

  /* first-use hint inside the panel: fades by opacity and keeps its room */
  .hint { display: flex; align-items: center; gap: 8px; margin-top: 4px; transition: opacity 200ms ease; }
  .hint p { margin: 0; font-size: .88rem; color: rgba(255, 255, 255, .8); }
  .hint.off { opacity: 0; pointer-events: none; }
  .hx { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; background: transparent; color: #fff; display: inline-grid; place-items: center; }
  .hx:hover:not(:disabled) { background: rgba(255, 255, 255, .16); }

  /* status + skip: one reserved row above the control panel (nothing below it moves when either shows) */
  .mid { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; margin-top: auto; }
  .statrow { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .stat { margin: 0; display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 44px; padding: 0 14px; border-radius: 999px; font-weight: 600; font-size: .95rem; color: rgba(255, 255, 255, .9); opacity: 0; transition: opacity 200ms ease; }
  .stat.on { opacity: 1; }
  .stat.warn { color: #ffc56b; }
  .stat.error { color: #ffbdbd; }
  .act { flex: none; }
  .here { background: #fff; color: #000; border-radius: 999px; padding: 0 20px; font-weight: 800; }
  .here:hover:not(:disabled) { background: rgba(255, 255, 255, .82); }
  .skipb { flex: none; min-width: 44px; opacity: 0; transform: translateY(6px); transition: opacity 200ms ease, transform 200ms ease; pointer-events: none; }
  .skipb.on { opacity: 1; transform: none; pointer-events: auto; }
  .phone .stat { font-size: .82rem; line-height: 1.2; padding: 0 12px; }

  /* control panel */
  .cp { padding: 6px 20px 16px; display: grid; gap: 4px; }
  .ctrl { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 10px; }
  .cl { grid-column: 1; justify-self: start; min-width: 0; min-height: 44px; }
  .phone .cl { min-height: 52px; }
  .tp { grid-column: 2; display: flex; align-items: center; justify-content: center; gap: 12px; }
  .vol { grid-column: 3; justify-self: end; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .tb { width: 56px; height: 56px; min-height: 44px; padding: 0; border-radius: 50%; background: transparent; color: #fff; display: inline-grid; place-items: center; transition: transform var(--t-fast), opacity var(--t-fast); }
  .tb:hover:not(:disabled) { background: rgba(255, 255, 255, .16); }
  .tb[aria-disabled='true'] { opacity: .45; cursor: default; }
  .tb[aria-busy='true'] { opacity: .85; }
  .disc { width: 64px; height: 64px; background: #fff; color: #000; }
  .disc:hover:not(:disabled) { background: rgba(255, 255, 255, .85); }
  .disc:focus-visible { outline-color: #fff; outline-offset: 4px; }
  .mute { width: 44px; height: 44px; }
  /* AirPlay subtitles line: always has its room, fades by opacity */
  .sh { margin: 4px 0 0; min-height: 2.6em; font-size: .85rem; line-height: 1.3; color: rgba(255, 255, 255, .8); opacity: 0; transition: opacity 200ms ease; }
  .sh.on { opacity: 1; }
  .volhint { margin: 0; display: flex; align-items: center; gap: 8px; font-size: .9rem; color: rgba(255, 255, 255, .78); }
  .vval { font-size: .85rem; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .vslider { -webkit-appearance: none; appearance: none; width: 130px; height: 44px; margin: 0; background: transparent; cursor: pointer; }
  .vslider::-webkit-slider-runnable-track { height: 5px; border-radius: 3px; background: linear-gradient(to right, var(--acc) var(--v), rgba(255, 255, 255, .28) var(--v)); }
  .vslider::-moz-range-track { height: 5px; border-radius: 3px; background: rgba(255, 255, 255, .28); }
  .vslider::-moz-range-progress { height: 5px; border-radius: 3px; background: var(--acc); }
  .vslider::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -5.5px; border-radius: 50%; background: var(--acc); border: 0; box-shadow: 0 0 0 2px #fff; }
  .vslider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--acc); border: 0; box-shadow: 0 0 0 2px #fff; }
  .vslider:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 8px; }

  /* stacked and phone: the transport above, the volume row below */
  .stacked .ctrl, .phone .ctrl { grid-template-columns: 1fr; justify-items: center; }
  .stacked .tp, .phone .tp { grid-column: 1; }
  .stacked .cl, .phone .cl { grid-column: 1; grid-row: 3; justify-self: stretch; }
  .phone .cl { width: 100%; }
  .stacked .vol, .phone .vol { grid-column: 1; justify-self: center; }
  .phone .cp { padding: 4px 14px 12px; }
  .phone .tp { width: 100%; display: grid; grid-template-columns: 1fr 1fr 76px 1fr 1fr; justify-items: center; gap: 0; }
  .phone .disc { width: 76px; height: 76px; }
  .phone .vol { width: 100%; justify-content: center; }
  .phone .vslider { flex: 1 1 auto; width: auto; }

  .spin { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(0, 0, 0, .25); border-top-color: #000; animation: rs-spin .9s linear infinite; }
  @keyframes rs-spin { to { transform: rotate(360deg); } }

  /* calm mode and reduced motion: nothing moves, panels are solid (the .frost rules) */
  :global(html.m-still) .rs :is(*, *::before, *::after) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .rs :is(*, *::before, *::after) { transition: none !important; animation: none !important; }
  }
</style>
