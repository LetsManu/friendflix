<script lang="ts">
  import Hls from 'hls.js';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { api, secToTicks, ticksToSec } from '$lib/api';

  export let itemId: string;
  export let video: HTMLVideoElement | null = null;
  export let controls = true;
  export let report = true;
  const dispatch = createEventDispatcher();

  interface Info {
    playSessionId: string; mediaSourceId: string; directUrl?: string; hlsUrl: string; resumeTicks: number; maxBitrate: number;
    audioTracks: Array<{ index: number; title: string; isDefault: boolean }>;
    subtitles: Array<{ index: number; title: string; url: string; language?: string; isDefault: boolean }>;
  }
  let info: Info | null = null, hls: Hls | null = null, error = '', mode = '', audioIndex: number | undefined, subIndex = -1;
  let segments: Array<{ type: string; start: number; end: number }> = [], now = 0, toast = '';
  $: skip = segments.find((x) => x.type !== 'recap' && now >= x.start && now < x.end - 1) ?? null;
  const skipLabel: Record<string, string> = { intro: 'Intro überspringen', outro: 'Abspann überspringen', recap: 'Rückblick überspringen' };
  let progressTimer: ReturnType<typeof setInterval>, started = false, stopped = false;

  const body = (extra = {}) => ({
    itemId, playSessionId: info!.playSessionId, mediaSourceId: info!.mediaSourceId,
    positionTicks: secToTicks(video?.currentTime ?? 0), isPaused: video?.paused ?? false, audioIndex, playMethod: mode === 'direct' ? 'DirectPlay' : 'Transcode', ...extra,
  });
  const send = (kind: 'start' | 'progress' | 'stop') => report && info && api(`/api/playback/${kind}`, { method: 'POST', body: body() }).catch(() => undefined);

  async function load(startSec?: number) {
    error = '';
    try {
      info = await api<Info>('/api/playback/info', { method: 'POST', body: { itemId, startTicks: startSec !== undefined ? secToTicks(startSec) : undefined, audioIndex } });
    } catch (e: any) {
      error = e?.body?.error === 'max_streams' ? `Maximal ${e.body.max} gleichzeitige Streams erlaubt.` : 'Wiedergabe nicht möglich.';
      return;
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

  function doSkip() { if (video && skip) video.currentTime = skip.end; }
  function flash(t: string) { toast = t; setTimeout(() => (toast = ''), 900); }
  /** Keyboard: Space/K play-pause, J/L or arrows +-10 s, M mute, F fullscreen. Ignored while typing. */
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (!video || e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    else if (k === 'arrowleft' || k === 'j') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); flash('−10 s'); }
    else if (k === 'arrowright' || k === 'l') { e.preventDefault(); video.currentTime += 10; flash('+10 s'); }
    else if (k === 'm') { video.muted = !video.muted; flash(video.muted ? 'Stumm' : 'Ton an'); }
    else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : video.parentElement?.requestFullscreen?.(); }
  }

  function onPlay() { if (!started) { started = true; send('start'); } else send('progress'); }
  onMount(() => {
    load();
    api(`/api/items/${itemId}/segments`).then((r) => (segments = r.segments)).catch(() => undefined);
    progressTimer = setInterval(() => { if (started && !stopped) send('progress'); }, 10_000);
    const bye = () => { if (!stopped) { stopped = true; send('stop'); } };
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  });
  onDestroy(() => {
    clearInterval(progressTimer);
    if (started && !stopped) { stopped = true; send('stop'); }
    hls?.destroy();
  });
</script>

{#if error}<p class="err">{error}</p>{/if}
<svelte:window on:keydown={onKey} />
<div class="vwrap">
<!-- svelte-ignore a11y_media_has_caption -->
<video bind:this={video} {controls} playsinline crossorigin="use-credentials"
  on:play={onPlay} on:pause={() => send('progress')} on:seeked={() => started && send('progress')} on:ended={() => { stopped = true; send('stop'); }}
  on:timeupdate={() => (now = video?.currentTime ?? 0)}
  on:play on:pause on:seeked on:seeking on:waiting on:playing on:canplay on:timeupdate on:ended>
  {#if info}{#each info.subtitles as s}<track id="sub-{s.index}" kind="subtitles" src={s.url} srclang={s.language?.slice(0, 2) ?? 'xx'} label={s.title} />{/each}{/if}
</video>
{#if skip}<button class="skipbtn light" on:click={doSkip}>{skipLabel[skip.type]}</button>{/if}
{#if toast}<div class="toast" role="status">{toast}</div>{/if}
</div>
<style>
  .vwrap { position: relative; display: contents; }
  .skipbtn { position: absolute; right: var(--pad-x); bottom: 6.5rem; z-index: 6; border: 1px solid #fff; padding: .7rem 1.4rem; }
  .toast { position: absolute; left: 50%; top: 45%; transform: translateX(-50%); background: rgba(0,0,0,.7); padding: .5rem 1.1rem; border-radius: 999px; z-index: 6; font-weight: 600; }
</style>
{#if info && controls}
  <div class="flex pbar" style="margin-top:.6rem">
    {#if info.audioTracks.length > 1}
      <label>Tonspur
        <select on:change={(e) => changeAudio(Number(e.currentTarget.value))}>
          {#each info.audioTracks as a}<option value={a.index} selected={a.isDefault && audioIndex === undefined}>{a.title}</option>{/each}
        </select>
      </label>
    {/if}
    {#if info.subtitles.length}
      <label>Untertitel
        <select on:change={(e) => setSubtitle(Number(e.currentTarget.value))}>
          <option value="-1" selected={subIndex === -1}>Aus</option>
          {#each info.subtitles as s}<option value={s.index}>{s.title}</option>{/each}
        </select>
      </label>
    {/if}
    <span class="badge">{mode === 'direct' ? 'Direct Play' : 'HLS'}</span>
  </div>
{/if}
