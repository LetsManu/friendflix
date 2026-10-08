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

  function onPlay() { if (!started) { started = true; send('start'); } else send('progress'); }
  onMount(() => {
    load();
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
<!-- svelte-ignore a11y_media_has_caption -->
<video bind:this={video} {controls} playsinline crossorigin="use-credentials"
  on:play={onPlay} on:pause={() => send('progress')} on:seeked={() => started && send('progress')} on:ended={() => { stopped = true; send('stop'); }}
  on:play on:pause on:seeked on:seeking on:waiting on:playing on:canplay on:timeupdate on:ended>
  {#if info}{#each info.subtitles as s}<track id="sub-{s.index}" kind="subtitles" src={s.url} srclang={s.language?.slice(0, 2) ?? 'xx'} label={s.title} />{/each}{/if}
</video>
{#if info && controls}
  <div class="flex" style="margin-top:.6rem">
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
