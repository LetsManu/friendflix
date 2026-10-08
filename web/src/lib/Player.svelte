<script lang="ts">
  import Hls from 'hls.js';
  import { createEventDispatcher, onDestroy, onMount, tick as tickDom } from 'svelte';
  import { api, fmtClock, secToTicks } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  import { get } from 'svelte/store';
  import { prefs } from '$lib/stores';

  export let itemId: string;
  export let video: HTMLVideoElement | null = null;
  /** the element that goes fullscreen (so overlays/chat stay visible) */
  export let stage: HTMLDivElement | null = null;
  export let report = true;
  /** false = viewer may not play/pause/seek (watch party guest): controls are shown disabled and a hint appears */
  export let canControl = true;
  export let denyHint = 'Nur der Host steuert die Wiedergabe.';
  /** watch party: no speed control (it would fight the drift correction) */
  export let partyMode = false;
  export let hasNext = false;
  /** px reserved on the right (e.g. open chat panel) so the control bar is not covered */
  export let inset = 0;
  /** true when the viewer chose "sleep after this episode" (the page then must not autoplay the next one) */
  export let sleepAfterEpisode = false;
  const dispatch = createEventDispatcher();

  interface Info {
    playSessionId: string; mediaSourceId: string; directUrl?: string; hlsUrl: string; resumeTicks: number; maxBitrate: number;
    roleMaxBitrate?: number;
    trickplay?: { width: number; height: number; tileWidth: number; tileHeight: number; count: number; interval: number; url: string };
    audioTracks: Array<{ index: number; title: string; isDefault: boolean; language?: string }>;
    subtitles: Array<{ index: number; title: string; url: string; language?: string; isDefault: boolean }>;
  }
  let info: Info | null = null, hls: Hls | null = null, error = '', mode = '', audioIndex: number | undefined, subIndex = -1;
  let segments: Array<{ type: string; start: number; end: number }> = [];
  let progressTimer: ReturnType<typeof setInterval>, started = false, stopped = false;

  // ---- UI state ----
  let paused = true, current = 0, duration = 0, buffered = 0, volume = 1, muted = false, rate = 1, waiting = true, fullscreen = false;
  let menu: '' | 'tracks' | 'settings' = '', toast = '', toastTimer: ReturnType<typeof setTimeout>;
  let lastActive = Date.now(), tick = Date.now(), activityTimer: ReturnType<typeof setInterval>;
  let quality = 0, sleepMin = 0, sleepAt = 0, sleepLeft = '', prefsApplied = false, autoSkipped = new Set<number>(), pipOk = false;
  let scrubbing = false, scrubTime = 0, hoverX = -1, hoverTime = 0, trackEl: HTMLDivElement;
  $: showUi = paused || menu !== '' || scrubbing || tick - lastActive < 3000;
  $: skip = segments.find((x) => x.type !== 'recap' && current >= x.start && current < x.end - 1) ?? null;
  $: shown = scrubbing ? scrubTime : current;
  $: pct = duration ? Math.min(100, (shown / duration) * 100) : 0;
  $: bufPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;
  $: if (skip && skip.type === 'intro' && !partyMode && canControl && get(prefs).autoSkipIntro && !autoSkipped.has(skip.start)) { autoSkipped.add(skip.start); doSkip(); flash('Intro übersprungen', 1500); }
  const skipLabel: Record<string, string> = { intro: 'Intro überspringen', outro: 'Abspann überspringen', recap: 'Rückblick überspringen' };

  const body = () => ({
    itemId, playSessionId: info!.playSessionId, mediaSourceId: info!.mediaSourceId,
    positionTicks: secToTicks(video?.currentTime ?? 0), isPaused: video?.paused ?? false, audioIndex, playMethod: mode === 'direct' ? 'DirectPlay' : 'Transcode',
  });
  const send = (kind: 'start' | 'progress' | 'stop') => report && info && api(`/api/playback/${kind}`, { method: 'POST', body: body() }).catch(() => undefined);

  async function load(startSec?: number) {
    error = '';
    try {
      info = await api<Info>('/api/playback/info', { method: 'POST', body: { itemId, startTicks: startSec !== undefined ? secToTicks(startSec) : undefined, audioIndex, maxBitrate: quality || undefined } });
    } catch (e: any) {
      error = e?.body?.error === 'max_streams' ? `Maximal ${e.body.max} gleichzeitige Streams erlaubt.` : 'Wiedergabe nicht möglich.';
      return;
    }
    // first start only: apply the viewer's saved defaults (quality, audio language) before playback begins
    if (!prefsApplied && !partyMode) {
      prefsApplied = true;
      const pf = get(prefs);
      const wantAudio = pf.audioLang ? info.audioTracks.find((a) => a.language === pf.audioLang) : undefined;
      const needQuality = pf.quality > 0 && pf.quality < info.maxBitrate;
      if ((wantAudio && !wantAudio.isDefault) || needQuality) {
        if (wantAudio && !wantAudio.isDefault) audioIndex = wantAudio.index;
        if (needQuality) quality = pf.quality;
        return load(startSec);
      }
    }
    attach(startSec ?? info.resumeTicks / 10_000_000);
  }

  function attach(startSec: number) {
    if (!video || !info) return;
    hls?.destroy(); hls = null;
    const useDirect = info.directUrl && audioIndex === undefined && video.canPlayType('video/mp4');
    mode = useDirect ? 'direct' : 'hls';
    const seek = () => { if (startSec > 1) video!.currentTime = startSec; };
    if (useDirect) {
      video.src = info.directUrl!;
      video.addEventListener('loadedmetadata', seek, { once: true });
    } else if (Hls.isSupported()) {
      hls = new Hls({ startPosition: startSec > 1 ? startSec : -1, maxBufferLength: 30 });
      hls.loadSource(info.hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) error = 'Wiedergabefehler. Bitte Seite neu laden.'; });
    } else {
      video.src = info.hlsUrl; // Safari: native HLS
      video.addEventListener('loadedmetadata', seek, { once: true });
    }
    stopped = false; started = false;
    dispatch('ready', { info });
    const want = get(prefs).subtitleLang;
    if (want && !partyMode) tickDom().then(() => { const sub = info?.subtitles.find((x) => (x as { language?: string }).language === want); if (sub) setSubtitle(sub.index); });
  }

  async function changeAudio(i: number) {
    const pos = video?.currentTime ?? 0;
    await send('stop');
    audioIndex = i;
    await load(pos);
    video?.play().catch(() => undefined);
  }
  function setSubtitle(i: number) {
    subIndex = i;
    [...(video?.textTracks ?? [])].forEach((t) => (t.mode = t.id === `sub-${i}` ? 'showing' : 'disabled'));
  }

  // ---- gated controls (party guests are not allowed to change playback) ----
  function flash(t: string, ms = 1100) { toast = t; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast = ''), ms); }
  function allowed(): boolean { if (canControl) return true; flash(denyHint, 1800); return false; }
  function togglePlay() { if (!video || !allowed()) return; if (video.paused) video.play().catch(() => undefined); else video.pause(); }
  function seekTo(t: number) { if (!video || !allowed()) return; video.currentTime = Math.max(0, Math.min(duration || t, t)); }
  function seekBy(d: number) { if (!video || !allowed()) return; seekTo(video.currentTime + d); flash(d > 0 ? `+${d} s` : `−${-d} s`, 700); }
  function doSkip() { if (skip) seekTo(skip.end); }
  const QUALITIES: Array<[string, number]> = [['1080p', 8_000_000], ['720p', 4_000_000], ['480p', 1_500_000], ['360p', 800_000]];
  $: qualityOptions = QUALITIES.filter(([, b]) => b < (info?.roleMaxBitrate ?? Infinity));
  async function changeQuality(bps: number) {
    menu = '';
    if (bps === quality) return;
    const pos = video?.currentTime ?? 0, wasPlaying = !(video?.paused ?? true);
    await send('stop');
    quality = bps;
    await load(pos);
    if (wasPlaying) video?.play().catch(() => undefined);
    flash(bps ? `Qualität: ${QUALITIES.find(([, b]) => b === bps)?.[0] ?? Math.round(bps / 1e6) + ' Mbit/s'}` : 'Qualität: Automatisch');
  }
  function setSleep(min: number | 'end') {
    menu = '';
    sleepAfterEpisode = min === 'end';
    sleepMin = typeof min === 'number' ? min : 0;
    sleepAt = typeof min === 'number' && min > 0 ? Date.now() + min * 60_000 : 0;
    flash(min === 0 ? 'Schlaf-Timer aus' : min === 'end' ? 'Pause nach dieser Folge' : `Schlaf-Timer: ${min} Min.`);
  }
  async function pip() { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video?.requestPictureInPicture(); } catch { flash('Bild-in-Bild nicht verfügbar'); } }
  function setRate(r: number) { if (!video) return; rate = r; video.playbackRate = r; menu = ''; flash(`${r}×`); }
  function setVolume(v: number) { if (!video) return; volume = v; video.volume = v; video.muted = v === 0; muted = v === 0; try { localStorage.setItem('ff_vol', String(v)); } catch { /* ignore */ } }
  function toggleMute() { if (!video) return; video.muted = !video.muted; muted = video.muted; if (!muted && volume === 0) setVolume(0.5); }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else (stage ?? video?.parentElement)?.requestFullscreen?.().catch(() => undefined);
  }

  // ---- timeline (pointer + keyboard) ----
  function fracAt(e: PointerEvent | MouseEvent) { const r = trackEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); }
  let trackW = 600;
  function onTrackMove(e: PointerEvent) { const f = fracAt(e); hoverX = f * 100; hoverTime = f * duration; trackW = trackEl.clientWidth; if (scrubbing) scrubTime = hoverTime; }
  /** keep the preview inside the timeline at both ends */
  $: previewW = info?.trickplay ? 168 : 0;
  $: tipLeft = Math.max(previewW / 2, Math.min(trackW - previewW / 2, (hoverX / 100) * trackW));
  $: thumb = (() => {
    const t = info?.trickplay;
    if (!t || hoverX < 0 || !duration) return null;
    const time = scrubbing ? scrubTime : hoverTime;
    const idx = Math.max(0, Math.min(t.count - 1, Math.floor((time * 1000) / t.interval)));
    const per = t.tileWidth * t.tileHeight, sheet = Math.floor(idx / per), within = idx % per;
    const k = 168 / t.width;
    return { url: t.url.replace('{n}', String(sheet)), w: 168, h: Math.round(t.height * k), sw: t.width, sh: t.height, k,
      bw: t.tileWidth * t.width, bh: t.tileHeight * t.height, x: (within % t.tileWidth) * t.width, y: Math.floor(within / t.tileWidth) * t.height };
  })();
  function onTrackDown(e: PointerEvent) {
    if (!allowed()) return;
    scrubbing = true; scrubTime = fracAt(e) * duration; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onTrackUp() { if (scrubbing) { scrubbing = false; seekTo(scrubTime); } }
  function onTrackKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekBy(-5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(5); }
  }

  // ---- activity / keyboard / touch ----
  function wake() { lastActive = Date.now(); tick = lastActive; }
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (!video || e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
    const k = e.key.toLowerCase();
    wake();
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'arrowleft' || k === 'j') { e.preventDefault(); seekBy(-10); }
    else if (k === 'arrowright' || k === 'l') { e.preventDefault(); seekBy(10); }
    else if (k === 'arrowup') { e.preventDefault(); setVolume(Math.min(1, volume + 0.1)); flash(`Lautstärke ${Math.round(Math.min(1, volume + 0.1) * 100)} %`, 600); }
    else if (k === 'arrowdown') { e.preventDefault(); setVolume(Math.max(0, volume - 0.1)); }
    else if (k === 'm') { toggleMute(); flash(muted ? 'Stumm' : 'Ton an', 700); }
    else if (k === 'f') toggleFullscreen();
    else if (k === 'escape' && menu) menu = '';
  }
  let lastTap = 0;
  function onSurfaceClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.ui, .skipbtn, .ovl')) return;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const now = Date.now();
    if (menu) { menu = ''; return; }
    if (coarse) { // touch: tap = show/hide controls, double tap on left/right third = -/+10 s
      const x = e.clientX / (stage?.clientWidth ?? window.innerWidth);
      if (now - lastTap < 320 && (x < 0.33 || x > 0.66)) seekBy(x < 0.33 ? -10 : 10);
      else if (tick - lastActive < 3000 && !paused) lastActive = 0; else wake();
      lastTap = now;
    } else if (now - lastTap < 280) { toggleFullscreen(); lastTap = 0; } else { lastTap = now; setTimeout(() => { if (lastTap === now) { togglePlay(); lastTap = 0; } }, 285); }
  }

  const syncTime = () => {
    if (!video) return;
    current = video.currentTime; duration = Number.isFinite(video.duration) ? video.duration : duration;
    const b = video.buffered; buffered = b.length ? b.end(b.length - 1) : 0;
  };
  const onPlay = () => { paused = false; if (!started) { started = true; send('start'); } else send('progress'); };

  onMount(() => {
    try { const v = Number(localStorage.getItem('ff_vol')); if (video && v >= 0 && v <= 1 && localStorage.getItem('ff_vol') !== null) { volume = v; video.volume = v; } } catch { /* ignore */ }
    load();
    api(`/api/items/${itemId}/segments`).then((r) => (segments = r.segments)).catch(() => undefined);
    progressTimer = setInterval(() => { if (started && !stopped) send('progress'); }, 10_000);
    pipOk = Boolean(document.pictureInPictureEnabled);
    activityTimer = setInterval(() => {
      tick = Date.now();
      if (sleepAt) {
        if (tick >= sleepAt) { sleepAt = 0; sleepMin = 0; video?.pause(); flash('Schlaf-Timer: Wiedergabe pausiert', 3000); }
        else sleepLeft = fmtClock((sleepAt - tick) / 1000);
      }
    }, 500);
    const bye = () => { if (!stopped) { stopped = true; send('stop'); } };
    const fs = () => (fullscreen = Boolean(document.fullscreenElement));
    window.addEventListener('pagehide', bye);
    document.addEventListener('fullscreenchange', fs);
    return () => { window.removeEventListener('pagehide', bye); document.removeEventListener('fullscreenchange', fs); };
  });
  onDestroy(() => {
    clearInterval(progressTimer); clearInterval(activityTimer); clearTimeout(toastTimer);
    if (started && !stopped) { stopped = true; send('stop'); }
    hls?.destroy();
  });
</script>

<svelte:window on:keydown={onKey} />
<div class="stage" class:idle={!showUi} style="--inset:{inset}px" bind:this={stage} on:mousemove={wake} on:click={onSurfaceClick} on:keydown={() => {}} role="presentation">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} playsinline crossorigin="use-credentials"
    on:play={onPlay} on:pause={() => { paused = true; send('progress'); }} on:seeked={() => started && send('progress')}
    on:ended={() => { stopped = true; paused = true; send('stop'); }}
    on:timeupdate={syncTime} on:progress={syncTime} on:loadedmetadata={syncTime}
    on:waiting={() => (waiting = true)} on:playing={() => (waiting = false)} on:canplay={() => (waiting = false)}
    on:volumechange={() => { if (video) { muted = video.muted; } }}
    on:play on:pause on:seeked on:seeking on:waiting on:playing on:canplay on:timeupdate on:ended>
    {#if info}{#each info.subtitles as s}<track id="sub-{s.index}" kind="subtitles" src={s.url} srclang={s.language?.slice(0, 2) ?? 'xx'} label={s.title} />{/each}{/if}
  </video>

  {#if error}<div class="center err" role="alert">{error}</div>{/if}
  {#if waiting && !error}<div class="center" role="status" aria-label="Lädt"><div class="spin"></div></div>{/if}
  {#if paused && !waiting && !error}
    <button class="bigplay ui" aria-label="Abspielen" on:click|stopPropagation={togglePlay}><Icon name="play" size={44} /></button>
  {/if}
  {#if toast}<div class="toast" role="status">{toast}</div>{/if}

  <!-- overlays from the page (back button, next episode card, party chat/reactions) -->
  <div class="ovl" class:hide={!showUi}><slot name="top" /></div>
  <slot />

  {#if skip}<button class="skipbtn light" on:click|stopPropagation={doSkip}>{skipLabel[skip.type]}</button>{/if}

  <div class="ui ctl" class:hide={!showUi} on:click|stopPropagation on:keydown|stopPropagation role="toolbar" tabindex="-1" aria-label="Wiedergabesteuerung">
    <div class="timeline">
      <div class="track" bind:this={trackEl} class:locked={!canControl} role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(shown)}
        aria-valuetext="{fmtClock(shown)} von {fmtClock(duration)}"
        on:pointermove={onTrackMove} on:pointerleave={() => (hoverX = -1)} on:pointerdown={onTrackDown} on:pointerup={onTrackUp} on:pointercancel={onTrackUp} on:keydown={onTrackKey}>
        <div class="buf" style="width:{bufPct}%"></div>
        <div class="played" style="width:{pct}%"></div>
        <div class="knob" style="left:{pct}%"></div>
        {#if hoverX >= 0}
          <div class="tip" style="left:{tipLeft}px">
            {#if thumb}<div class="thumb" style="width:{thumb.w}px;height:{thumb.h}px"><div style="width:{thumb.sw}px;height:{thumb.sh}px;background-image:url({thumb.url});background-size:{thumb.bw}px {thumb.bh}px;background-position:-{thumb.x}px -{thumb.y}px;transform:scale({thumb.k});transform-origin:0 0"></div></div>{/if}
            {fmtClock(scrubbing ? scrubTime : hoverTime)}
          </div>
        {/if}
      </div>
      <span class="rem" aria-hidden="true">{duration ? fmtClock(Math.max(0, duration - shown)) : '–'}</span>
    </div>
    <div class="row">
      <div class="grp">
        <button class="ic" class:locked={!canControl} aria-label={paused ? 'Abspielen' : 'Pause'} on:click={togglePlay}><Icon name={paused ? 'play' : 'pause'} size={30} /></button>
        <button class="ic" class:locked={!canControl} aria-label="10 Sekunden zurück" on:click={() => seekBy(-10)}><Icon name="rewind10" size={30} /></button>
        <button class="ic" class:locked={!canControl} aria-label="10 Sekunden vor" on:click={() => seekBy(10)}><Icon name="forward10" size={30} /></button>
        <div class="vol">
          <button class="ic" aria-label={muted ? 'Ton an' : 'Stumm'} on:click={toggleMute}><Icon name={muted || volume === 0 ? 'volume-off' : volume < 0.5 ? 'volume-low' : 'volume'} size={28} /></button>
          <input class="vslider" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label="Lautstärke" on:input={(e) => setVolume(Number(e.currentTarget.value))} />
        </div>
        <span class="clock">{fmtClock(shown)} / {fmtClock(duration)}</span>
      </div>
      <div class="grp right">
        <slot name="extra" />
        {#if hasNext}<button class="ic" aria-label="Nächste Folge" on:click={() => dispatch('next')}><Icon name="skip-next" size={28} /></button>{/if}
        {#if info && (info.audioTracks.length > 1 || info.subtitles.length)}
          <div class="mwrap">
            <button class="ic" aria-label="Audio und Untertitel" aria-expanded={menu === 'tracks'} on:click={() => (menu = menu === 'tracks' ? '' : 'tracks')}><Icon name="subtitles" size={28} /></button>
            {#if menu === 'tracks'}
              <div class="menu tracks" role="dialog" aria-label="Audio und Untertitel">
                {#if info.audioTracks.length > 1}
                  <div><h3>Audio</h3>
                    {#each info.audioTracks as a}<button class="mi" class:on={audioIndex === a.index || (audioIndex === undefined && a.isDefault)} on:click={() => { menu = ''; changeAudio(a.index); }}>{#if audioIndex === a.index || (audioIndex === undefined && a.isDefault)}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{a.title}</button>{/each}
                  </div>
                {/if}
                <div><h3>Untertitel</h3>
                  <button class="mi" class:on={subIndex === -1} on:click={() => { setSubtitle(-1); menu = ''; }}>{#if subIndex === -1}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}Aus</button>
                  {#each info.subtitles as s}<button class="mi" class:on={subIndex === s.index} on:click={() => { setSubtitle(s.index); menu = ''; }}>{#if subIndex === s.index}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{s.title}</button>{/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        {#if pipOk}<button class="ic" aria-label="Bild-in-Bild" on:click={pip}><Icon name="pip" size={26} /></button>{/if}
        <div class="mwrap">
          <button class="ic" aria-label="Einstellungen" aria-expanded={menu === 'settings'} on:click={() => (menu = menu === 'settings' ? '' : 'settings')}><Icon name="settings" size={27} />{#if sleepAt}<span class="sleepdot" title="Schlaf-Timer {sleepLeft}"></span>{/if}</button>
          {#if menu === 'settings'}
            <div class="menu tracks" role="dialog" aria-label="Einstellungen">
              <div><h3>Qualität</h3>
                <button class="mi" class:on={quality === 0} on:click={() => changeQuality(0)}>{#if quality === 0}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}Automatisch</button>
                {#each qualityOptions as [label, bps]}<button class="mi" class:on={quality === bps} on:click={() => changeQuality(bps)}>{#if quality === bps}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{label}</button>{/each}
              </div>
              {#if !partyMode}
                <div><h3>Tempo</h3>
                  {#each [0.5, 0.75, 1, 1.25, 1.5, 2] as r}<button class="mi" class:on={rate === r} on:click={() => { setRate(r); menu = ''; }}>{#if rate === r}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{r === 1 ? 'Normal' : r + '×'}</button>{/each}
                </div>
                <div><h3>Schlaf-Timer</h3>
                  <button class="mi" class:on={!sleepAt && !sleepAfterEpisode} on:click={() => setSleep(0)}>{#if !sleepAt && !sleepAfterEpisode}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}Aus</button>
                  {#each [15, 30, 45, 60] as m}<button class="mi" class:on={sleepMin === m && sleepAt > 0} on:click={() => setSleep(m)}>{#if sleepMin === m && sleepAt > 0}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{m} Min.{#if sleepMin === m && sleepAt > 0}<span class="muted"> ({sleepLeft})</span>{/if}</button>{/each}
                  <button class="mi" class:on={sleepAfterEpisode} on:click={() => setSleep('end')}>{#if sleepAfterEpisode}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}Nach dieser Folge</button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
        <span class="badge" title="Wiedergabeart">{mode === 'direct' ? 'Direct Play' : mode ? 'HLS' : ''}</span>
        <button class="ic" aria-label={fullscreen ? 'Vollbild verlassen' : 'Vollbild'} on:click={toggleFullscreen}><Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={28} /></button>
      </div>
    </div>
  </div>
</div>

<style>
  .stage { position: relative; width: 100%; background: #000; color: #fff; overflow: hidden; user-select: none; -webkit-user-select: none; }
  .stage.idle { cursor: none; }
  .stage :global(video) { display: block; width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #000; }
  .stage :global(video::cue) { background: rgba(0,0,0,.65); font-size: 1.15em; }
  .center { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 3; }
  .spin { width: 62px; height: 62px; border: 5px solid rgba(255,255,255,.25); border-top-color: var(--acc); border-radius: 50%; animation: sp .9s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .bigplay { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 96px; height: 96px; border-radius: 50%; background: rgba(0,0,0,.55); border: 3px solid #fff; z-index: 4; }
  .bigplay:hover:not(:disabled) { background: rgba(0,0,0,.75); }
  .toast { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); background: rgba(0,0,0,.75); padding: .55rem 1.2rem; border-radius: 999px; z-index: 9; font-weight: 600; max-width: 90%; text-align: center; }
  .skipbtn { position: absolute; right: calc(var(--pad-x) + var(--inset, 0px)); bottom: 7.5rem; z-index: 8; border: 1px solid #fff; padding: .7rem 1.5rem; }
  .ovl { position: absolute; inset: 0 var(--inset, 0px) auto 0; z-index: 7; pointer-events: none; transition: opacity var(--t-med); }
  .ovl :global(*) { pointer-events: auto; }
  .ovl.hide { opacity: 0; } .ovl.hide :global(*) { pointer-events: none; }

  .ctl { position: absolute; left: 0; right: var(--inset, 0px); bottom: 0; z-index: 8; padding: 3.5rem clamp(.6rem, 2.4vw, 2.4rem) .9rem; background: linear-gradient(transparent, rgba(0,0,0,.85)); transition: opacity var(--t-med); }
  .ctl.hide { opacity: 0; pointer-events: none; }
  .timeline { display: flex; align-items: center; gap: 1rem; }
  .track { position: relative; flex: 1; height: 5px; background: rgba(255,255,255,.28); border-radius: 3px; cursor: pointer; touch-action: none; transition: height var(--t-fast); margin: 10px 0; }
  .track::before { content: ''; position: absolute; left: 0; right: 0; top: -12px; bottom: -12px; } /* bigger hit area */
  .track:hover, .track:focus-visible { height: 9px; }
  .track.locked { cursor: not-allowed; }
  .buf { position: absolute; inset: 0 auto 0 0; background: rgba(255,255,255,.35); border-radius: 3px; }
  .played { position: absolute; inset: 0 auto 0 0; background: var(--acc); border-radius: 3px; }
  .knob { position: absolute; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; background: var(--acc); border-radius: 50%; transform: scale(0); transition: transform var(--t-fast); }
  .track:hover .knob, .track:focus-visible .knob { transform: scale(1); }
  .tip { position: absolute; bottom: 22px; transform: translateX(-50%); background: rgba(20,20,20,.95); padding: .15rem .35rem .2rem; border-radius: 4px; font-size: .85rem; pointer-events: none; text-align: center; }
  .thumb { overflow: hidden; border-radius: 3px; margin: .2rem 0 .25rem; background: #111; }
  .sleepdot { position: absolute; top: 10px; right: 10px; width: 9px; height: 9px; border-radius: 50%; background: var(--acc); }
  .rem { min-width: 3.4rem; text-align: right; font-variant-numeric: tabular-nums; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .grp { display: flex; align-items: center; gap: .1rem; flex-wrap: wrap; }
  .ic { background: transparent; padding: 0; width: 48px; min-height: 48px; border-radius: 50%; color: #fff; }
  .ic:hover:not(:disabled) { background: rgba(255,255,255,.14); transform: scale(1.08); }
  .ic.locked { opacity: .4; }
  .vol { display: flex; align-items: center; }
  .vslider { width: 0; opacity: 0; transition: width var(--t-med) var(--ease), opacity var(--t-med); padding: 0; min-height: 0; accent-color: var(--acc); background: transparent; border: 0; }
  .vol:hover .vslider, .vol:focus-within .vslider { width: 92px; opacity: 1; margin-right: .6rem; }
  .clock { margin-left: .8rem; font-size: .9rem; color: #e0e0e0; font-variant-numeric: tabular-nums; }
  .badge { align-self: center; margin: 0 .4rem; background: rgba(255,255,255,.14); font-size: .72rem; }
  .mwrap { position: relative; }
  .menu { position: absolute; right: 0; bottom: 58px; background: rgba(20,20,20,.97); border: 1px solid #3a3a3a; border-radius: 6px; padding: .6rem .3rem; min-width: 190px; box-shadow: 0 12px 30px #000; z-index: 20; }
  .menu.tracks { display: flex; gap: 1rem; padding: .8rem; min-width: 360px; max-width: min(94vw, 720px); }
  .menu.tracks > div { flex: 1; min-width: 118px; }
  .mi { white-space: nowrap; }
  .menu h3 { font-size: 1rem; margin: 0 .6rem .4rem; }
  .mi { display: flex; width: 100%; justify-content: flex-start; align-items: center; gap: .5rem; background: transparent; color: #d2d2d2; font-weight: 400; padding: .35rem .6rem; min-height: 40px; text-align: left; border-radius: 4px; }
  .mi:hover:not(:disabled) { background: rgba(255,255,255,.1); color: #fff; } .mi.on { color: #fff; font-weight: 700; }
  .sp { width: 16px; flex: none; }
  @media (max-width: 720px) { .clock, .badge, .vol .vslider { display: none; } .menu.tracks { flex-direction: column; min-width: 240px; } .ic { width: 44px; } .bigplay { width: 76px; height: 76px; } }
</style>
