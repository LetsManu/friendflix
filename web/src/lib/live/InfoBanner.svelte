<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { t } from '#lib/i18n';
  import { nowLines, type LiveChannel } from './api';
  import { fadeIn } from './fade';
  import { channelHead, progressAt, timeLeft, timeLeftText } from './progress';

  /**
   * The info banner (spec §12.2): a glass banner over the lower third of the stage with logo, number + name, *Jetzt* + thin progress
   * line + time left, *Danach*; the honest lines of nowLines() without programme data or while a push feed sends nothing. Both
   * programme lines and the time-left slot are always reserved, so nothing in it moves. It fades by opacity only; in calm mode and
   * with reduced motion every transition in it is off (the CastBar pattern, !important so app.css's reduced-motion rule cannot leave
   * a .001 ms one), on TV and for kids it switches without fading. It is aria-hidden: the player's polite announcement carries the
   * same words.
   */
  export let channel: LiveChannel;
  export let visible = false;
  export let starting = false;
  /** the watch answered not_receiving: the feed is silent whatever the list said */
  export let notReceiving = false;
  export let now: Date;
  /** calm mode / reduced motion / TV / kids: a solid panel */
  export let still = false;

  $: c = notReceiving ? { ...channel, receiving: false } : channel;
  $: lines = nowLines(c);
  $: hasProg = c.receiving !== false && c.epg === 'ok' && Boolean(c.now);
  $: p = hasProg && c.now ? progressAt(c.now, now) : 0;
  $: left = hasProg && c.now ? timeLeftText(timeLeft(c.now, now)) : '';
</script>

<div class="lbanner" class:frost={!still} class:frost-safe={!still} class:solid={still} class:on={visible} aria-hidden="true">
  <div class="bh">
    <span class="lg">{#if c.logo}<img src={c.logo} alt="" width="44" height="44" decoding="async" use:fadeIn />{/if}</span>
    <b class="nm">{channelHead(c)}</b>
    <span class="st">{starting ? $t('live.player.starting') : ''}</span>
  </div>
  <div class="ln"><span class="k">{$t('live.now')}</span><span class="v">{lines.now}</span><span class="left">{left}</span></div>
  <div class="pg" class:off={!hasProg}><i style="transform:scaleX({p})"></i></div>
  <div class="ln"><span class="k">{$t('live.next')}</span><span class="v">{lines.next ?? ''}</span><span class="left"></span></div>
</div>

<style>
  .lbanner { position: absolute; z-index: 5; left: 50%; bottom: calc(104px + var(--safe-bottom, 0px)); width: min(680px, calc(100% - 32px)); box-sizing: border-box;
    padding: 14px 18px; border-radius: var(--fr-r-panel); color: #fff; transform: translateX(-50%); opacity: 0; pointer-events: none;
    transition: opacity 220ms var(--fr-out); }
  .lbanner.on { opacity: 1; }
  .lbanner.solid { background: var(--fr-solid); }
  .bh { display: flex; align-items: center; gap: 12px; min-height: 44px; }
  .lg { flex: none; width: 44px; height: 44px; border-radius: 10px; overflow: hidden; background: rgba(255, 255, 255, .08); }
  .lg img { display: block; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 200ms var(--fr-out); }
  .lg :global(img.in) { opacity: 1; }
  .nm { flex: 1 1 auto; min-width: 0; font-size: 1.15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st { flex: none; width: 12em; text-align: right; color: rgba(255, 255, 255, .78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ln { display: flex; align-items: baseline; gap: 10px; min-height: 1.5em; margin-top: 6px; }
  .k { flex: none; width: 4.5em; color: rgba(255, 255, 255, .72); font-size: .85rem; }
  .v { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .left { flex: none; width: 10.5em; text-align: right; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, .78); white-space: nowrap; }
  .pg { height: 3px; margin: 6px 0 0 calc(4.5em + 10px); border-radius: 2px; background: rgba(255, 255, 255, .2); overflow: hidden; }
  .pg.off { opacity: 0; }
  .pg i { display: block; height: 100%; background: #fff; transform-origin: left center; }
  /* calm mode and reduced motion (both triggers, the CastBar pattern): nothing in the banner moves; TV and kids: no fade */
  :global(html.m-still) .lbanner, :global(html.m-still) .lbanner :global(*), :global(html.m-still) .lbanner :global(*::before) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .lbanner, .lbanner :global(*), .lbanner :global(*::before) { transition: none !important; animation: none !important; }
  }
  :global(html.tv) .lbanner, :global(html.kids) .lbanner, :global(html.tv) .lg img, :global(html.kids) .lg img { transition: none; }
  :global(html.tv) .lbanner { bottom: calc(var(--u, 1px) * 200); width: calc(100vw / 1920 * 980); padding: calc(100vw / 1920 * 22) calc(100vw / 1920 * 28); font-size: calc(100vw / 1920 * 28); }
  :global(html.tv) .nm { font-size: calc(100vw / 1920 * 34); }
  @media (max-width: 720px) {
    .lbanner { bottom: calc(92px + var(--safe-bottom, 0px)); padding: 10px 14px; }
    .st { width: 8em; }
    .left { width: 8.5em; }
  }
</style>
