<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { features, featuresKnown } from '#lib/capabilities';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Player from '#lib/Player.svelte';
  import { recordingSource, type PlaybackSource } from '#lib/player/source';
  import { getRecording, type Recording } from '#lib/live/recordings';
  import { pageStore } from '#lib/page';

  /**
   * A recording in the normal player (spec §15.7, plan Phase 3 Task 9): `Player.svelte` with a `recordingSource` (the source seam:
   * `/play` token, progress, heartbeat; no episodes, credits, scenes, quality ladder). The top bar carries Back, the title and a
   * reserved slot for the "Aufnahme läuft" chip of a growing recording: its timeline starts at the recording's start and its end follows
   * the live edge; the chip jumps back to that edge. The recording is asked again every 30 s, so the chip goes when it finishes.
   * `?t=<s>` starts at that second (the hand-off's "Weiter auf dem Fernseher"). Kids profiles may play shared kid-friendly recordings.
   */
  const POLL_MS = 30_000;
  const page = pageStore();
  let video: HTMLVideoElement | null = null;
  let rec: Recording | null = null;
  let src: PlaybackSource | null = null;
  let srcFor = '';
  $: id = $page.params.id ?? '';
  $: startAt = ((v) => (v !== null && /^\d+$/.test(v) ? Number(v) : undefined))($page.url.searchParams.get('t'));
  $: if (id && id !== srcFor) { srcFor = id; src = recordingSource(id); rec = null; void refresh(); }
  $: if ($featuresKnown && !$features.livetv) void goto('/', { replaceState: true });

  async function refresh(): Promise<void> {
    const want = id;
    try { const r = await getRecording(want); if (want === id) rec = r; } catch { /* the player shows its own error */ }
  }
  const poll = setInterval(() => { if (!document.hidden && rec?.growing) void refresh(); }, POLL_MS);
  onDestroy(() => clearInterval(poll));

  const back = () => (history.length > 1 ? history.back() : goto('/live/recordings'));
  /** the newest part of the growing playlist, a few seconds before its end */
  function toEdge(): void {
    if (!video) return;
    const s = video.seekable;
    const end = s.length ? s.end(s.length - 1) : video.duration;
    if (Number.isFinite(end)) video.currentTime = Math.max(0, end - 3);
    if (video.paused) void video.play().catch(() => undefined);
  }
  $: sub = rec ? (rec.subtitle ?? rec.episode ?? rec.channel.name) : '';
</script>

<svelte:head><title>{$t('common.pageTitle', { page: rec?.title ?? $t('live.myRecordings') })}</title></svelte:head>
<div class="wrap">
  {#key id}
    {#if src}
      <Player itemId={`rec:${id}`} source={src} isMovie title={rec?.title ?? ''} barTitle={rec?.title ?? ''} barSub={sub} {startAt} bind:video on:back={back}>
        <div slot="top" class="top">
          <button class="icon-btn" aria-label={$t('player.watch.back')} on:click={back}><Icon name="arrow-left" size={28} /></button>
          <div class="ttl"><b>{rec?.title ?? ''}</b><span>{sub}</span></div>
          <!-- reserved: the chip of a growing recording appears and goes without moving anything -->
          <span class="recslot">
            {#if rec?.growing}
              <button type="button" class="rchip" title={$t('live.recPlayer.toEdge')} on:click|stopPropagation={toEdge}><i class="rdot" aria-hidden="true"></i>{$t('live.recPlayer.growing')}</button>
            {/if}
          </span>
        </div>
      </Player>
    {/if}
  {/key}
</div>

<style>
  .wrap { position: fixed; left: 0; top: 0; right: 0; bottom: 0; background: #000; z-index: 40; }
  .wrap :global(.stage) { height: 100%; }
  .top { padding: calc(.8rem + var(--safe-top)) max(1rem, var(--safe-right)) .8rem max(1rem, var(--safe-left)); display: flex; align-items: center; gap: .6rem; background: linear-gradient(rgba(0, 0, 0, .8), transparent); }
  .ttl { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; line-height: 1.2; }
  .ttl b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ttl span { color: rgba(255, 255, 255, .78); font-size: .9rem; min-height: 1.1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .recslot { flex: none; display: flex; justify-content: flex-end; min-width: 11.5rem; min-height: 44px; }
  .rchip, .rchip:hover:not(:disabled), .rchip:active:not(:disabled) { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 14px; border: 0; border-radius: 999px; background: rgba(0, 0, 0, .55); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .3); color: #fff; font-weight: 700; transform: none; white-space: nowrap; }
  .rdot { width: 10px; height: 10px; border-radius: 50%; background: var(--err-mark); }
  @media (max-width: 520px) { .recslot { min-width: 0; } .rchip { padding: 0 10px; font-size: .85rem; } }
  /* wider screens: the player's own title block names it (like /watch); the space stays so the chip keeps its place */
  @media (min-width: 721px) { .ttl { visibility: hidden; } }
</style>
