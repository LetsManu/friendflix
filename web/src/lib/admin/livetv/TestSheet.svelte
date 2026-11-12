<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Testen* (spec §9.2, ruling 15): the stream test of one channel (`POST /channels/:id/test`) or of up to 20 selected ones (the bulk
   * action, one after another on the server). The sheet shows what the probe found (`factsLine`: "H.264 1920×1080
   * 25 fps · AAC 2.0 · wird umverpackt") or why it failed, in words (`channelError`; one test per admin at a time: 409 `test_running`).
   * The result area has its height reserved while the test runs. Every finished test goes to the list through `tested`, which reads
   * the stored result again. When the answer carries a `preview` (the channel could start; a test token of this admin's device, F10),
   * a small frame plays it muted for 10 s with the live tuning (`liveHlsConfig(0, false)`: a check needs no back buffer), then the
   * player is torn down and `DELETE /api/livetv/watch` lets the token go. The same happens when the sheet closes, the test is run
   * again or the page is left (keepalive), so the preview never keeps a stream or a token alive.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import type Hls from 'hls.js';
  import Icon from '#lib/Icon.svelte';
  import { t, tr, type TKey } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { bulkTest, channelError, errorCode, factsLine, testChannel, type BulkTestResult } from './channels';
  import SheetFrame from './SheetFrame.svelte';
  import { stopWatching } from '#lib/live/api';
  import { liveHlsConfig, loadHls } from '#lib/player/hls';

  /** how long the muted preview plays */
  const PREVIEW_MS = 10_000;

  /** one channel … */
  export let channel: { id: string; name: string } | null = null;
  /** … or the ids of a bulk test with their names (shown in the results) */
  export let bulk: { ids: string[]; names: Record<string, string> } | null = null;
  export let returnTo: (() => HTMLElement | null) | null = null;

  const dispatch = createEventDispatcher<{ close: void; tested: void }>();
  let running = true;
  let facts = '';
  let failure = '';
  let results: BulkTestResult[] = [];
  let gone = false;

  // ---- the 10-second preview
  let video: HTMLVideoElement | undefined;
  let hls: Hls | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** the token while a preview owns one ('' = none) */
  let token = '';
  let playing = false, ended = false;
  /** a new start makes an older one's late steps obsolete */
  let gen = 0;

  function endPreview(keepalive: boolean) {
    gen++;
    clearTimeout(timer);
    if (hls) { try { hls.destroy(); } catch { /* already gone */ } hls = null; }
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    if (token) { const tk = token; token = ''; void stopWatching(tk, keepalive).catch(() => undefined); }
    if (playing) { playing = false; if (!gone) ended = true; }
  }
  async function startPreview(p: { url: string; token: string }) {
    const g = ++gen;
    token = p.token; playing = true; ended = false;
    timer = setTimeout(() => endPreview(false), PREVIEW_MS);
    await tick();
    const v = video;
    if (!v || g !== gen) return;
    let H: typeof Hls | null = null;
    try { H = await loadHls(); } catch { H = null; }
    if (g !== gen) return;
    if (H && H.isSupported()) {
      const h = new H(liveHlsConfig(0, false));
      hls = h;
      h.on(H.Events.MANIFEST_PARSED, () => { if (g === gen) void v.play().catch(() => undefined); });
      h.loadSource(p.url);
      h.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = p.url;
      void v.play().catch(() => undefined);
    }
  }

  /** the newest run; an answer of an older one is stale */
  let runId = 0;
  async function run() {
    const mine = ++runId;
    endPreview(false); ended = false;
    running = true; facts = ''; failure = ''; results = [];
    try {
      if (bulk) results = (await bulkTest(bulk.ids)).results;
      else if (channel) {
        const a = await testChannel(channel.id);
        if (a.ok) facts = factsLine({ video: a.video ?? undefined, audio: a.audio ?? undefined, needs: a.needs }) || tr('adminLive.ch.mode.none');
        else failure = channelError(a.error ?? 'failed');
        // an answer that arrives after the sheet closed (or after a newer run) never plays: its test token is let go at once
        if (a.ok && a.preview) {
          if (gone || mine !== runId) void stopWatching(a.preview.token, true).catch(() => undefined);
          else void startPreview(a.preview);
        }
      }
      if (!gone) dispatch('tested');
    } catch (e) {
      failure = channelError(errorCode(e));
    } finally { running = false; }
  }
  const leave = () => endPreview(true);
  onMount(() => {
    void run();
    window.addEventListener('pagehide', leave);
    return () => { gone = true; window.removeEventListener('pagehide', leave); endPreview(true); };
  });

  $: title = bulk ? tr('adminLive.ch.test.bulkTitle', { n: bulk.ids.length }) : tr('adminLive.ch.test.title', { name: channel?.name ?? '' });
  const modeText = (r: BulkTestResult) => (r.ok && r.needs ? tr(`adminLive.ch.mode.${r.needs}` as TKey) : r.ok ? tr('adminLive.ch.mode.none') : channelError(r.error));
</script>

<SheetFrame {title} {returnTo} on:close={() => dispatch('close')}>
  <div class="res" aria-live="polite" aria-busy={running ? 'true' : undefined}>
    {#if running}
      <p class="run"><span class="spinner" aria-hidden="true"></span><span>{bulk ? $t('adminLive.ch.test.bulkRunning') : $t('adminLive.ch.test.running')}</span></p>
    {:else if failure}
      <p class="fail" data-failure><Icon name="alert" size={18} /><span>{failure}</span></p>
    {:else if bulk}
      <ul>
        {#each results as r (r.id)}
          <li class:bad={!r.ok}>
            <Icon name={r.ok ? 'check' : 'alert'} size={18} />
            <span class="nm">{bulk.names[r.id] ?? ''}</span>
            <span class="st">{modeText(r)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="ok" data-facts><Icon name="check" size={18} /><span>{facts}</span></p>
    {/if}
  </div>
  {#if playing}
    <div class="frame" data-preview><video bind:this={video} muted playsinline autoplay aria-label={$t('adminLive.ch.test.previewLabel')}></video></div>
  {:else if ended}
    <p class="note" data-preview-ended>{$t('adminLive.ch.test.previewEnded')}</p>
  {:else if !bulk}
    <p class="note">{$t('adminLive.ch.test.noPlayer')}</p>
  {/if}
  <div class="foot">
    <Button variant="secondary" icon="refresh" disabled={running} on:click={run}>{$t('adminLive.ch.test.again')}</Button>
  </div>
</SheetFrame>

<style>
  /* the result area keeps its height while the test runs, so the sheet does not jump when the answer comes */
  .res { min-height: 6rem; }
  p { margin: 0; }
  .run, .ok, .fail { display: flex; gap: .5rem; align-items: flex-start; overflow-wrap: anywhere; }
  .run .spinner { flex: none; width: 18px; height: 18px; margin-top: .1rem; }
  .ok { font-weight: 700; }
  .ok :global(svg), .fail :global(svg), li :global(svg) { flex: none; margin-top: .15rem; }
  .fail { color: #ffbdbd; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  li { display: flex; flex-wrap: wrap; gap: .2rem .5rem; align-items: flex-start; }
  li .nm { font-weight: 700; flex: 1 1 8rem; min-width: 0; overflow-wrap: anywhere; }
  li .st { flex: 1 1 100%; padding-left: 1.7rem; overflow-wrap: anywhere; }
  li.bad { color: #ffbdbd; }
  .frame { width: min(100%, 20rem); aspect-ratio: 16 / 9; margin: 0 0 .8rem; border-radius: 10px; overflow: hidden; background: #000; }
  .frame video { width: 100%; height: 100%; display: block; object-fit: contain; }
  .note { font-size: .9rem; color: rgba(255, 255, 255, .8); }
  .foot { display: flex; flex-wrap: wrap; gap: .6rem; }
  .foot :global(.spinner) { width: 18px; height: 18px; }
</style>
