<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The cast bar: what plays on the TV while the person browses (mounted by the root layout, which decides when it shows and
   * keeps `--castbar-h` free for it before it rises in). Desktop: a floating glass bar, centred above the bottom edge; phone
   * (`phone`): docked 8 px above the tab bar (`tabbar = false`: kids profiles, at the bottom edge). It keeps its last session
   * while it rises out, so it never changes shape on the way down.
   */
  import { createEventDispatcher, onDestroy, tick as settled } from 'svelte';
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import { fade } from 'svelte/transition';
  import { api, cachedItem, type Item } from '#lib/api';
  import { barRise } from '#lib/glass/fx';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { motionAllowed } from '#lib/preview';
  import { confirm } from '#lib/ui/confirm';
  import { focusMain } from '#lib/ui/focusMain';
  import { SCRIM_BAR } from '#lib/glass/tone';
  import { barLine1, barLine2, barProgress, barThumb, nextSecondsLeft, splitLine } from './bar';
  import CastBarExpanded from './CastBarExpanded.svelte';
  import { castEngine, type CastSession } from './engine';
  import { engineSource, type CastBarSource } from './barSource';

  /** the bar shows (the layout's `barVisible`); false: it rises out */
  export let show = true;
  /** a tab bar sits below the bar (phone): false = the bar docks at the bottom edge */
  export let tabbar = true;
  /** the phone bar: no thumbnail, no Next, Stop as an icon */
  export let phone = false;

  /** where the session comes from and where the buttons go: the page's cast engine (default) or the Android app's own cast session */
  export let source: CastBarSource = engineSource();

  /** the bar has risen out: the layout may give the room back */
  const dispatch = createEventDispatcher<{ gone: void }>();

  const airState = castEngine.airState;
  let last: CastSession | null = null;
  let session = source.session;
  $: session = source.session;
  $: if ($session) last = $session;
  $: s = $session ?? last;
  $: shown = show && $session !== null;
  $: state = s?.state;
  /** play / pause only drives a TV that plays (connecting / reconnect / failed / ended have no live token) */
  $: live = state === 'playing';
  /** AirPlay waits for the TV to be chosen in the system picker (it may not have opened without a fresh tap) */
  $: choose = s?.kind === 'airplay' && state === 'reconnect' && Boolean($airState?.ready);
  $: thumb = s ? barThumb(s) : null;
  // the app's session carries no episode numbers: the item gives the code ("S1:F4"); one request per title, also when it fails
  let fetched: Item | undefined, askedFor = '';
  $: it = s ? cachedItem(s.itemId) ?? (fetched?.id === s.itemId ? fetched : undefined) : undefined;
  $: if (s && s.isEpisode && s.itemId !== askedFor && !cachedItem(s.itemId)) { askedFor = s.itemId; void loadItem(s.itemId); }
  async function loadItem(id: string) {
    try { const r = await api<{ item: Item }>(`/api/items/${id}`); if (get(session)?.itemId === id) fetched = r.item; } catch { /* the session's own subtitle */ }
  }
  /** a detached cast whose title could not be loaded: "Playing on {device}" */
  $: title = s ? (s.title ? barLine1(s, it, $t) : $t('player.castBar.playingOn', { device: s.device })) : '';
  $: progress = s ? barProgress(s) : 0;

  /** the next-episode countdown (from the credits on, or after the end) ticks once a second while it runs */
  let now = Date.now(), tick: ReturnType<typeof setInterval> | undefined;
  $: next = state === 'ended' || live ? s?.next ?? null : null;
  $: startsAt = next?.startsAt ?? null;
  $: if (startsAt !== null && tick === undefined) { now = Date.now(); tick = setInterval(() => (now = Date.now()), 1000); }
  $: if (startsAt === null && tick !== undefined) { clearInterval(tick); tick = undefined; }
  onDestroy(() => clearInterval(tick));
  $: secs = nextSecondsLeft(startsAt, now);

  $: l2 = s ? barLine2(s, now, $t, { choose }) : { text: '', tone: 'none' as const };
  $: parts = splitLine(l2);
  /** the state line crossfades when the kind of line changes, not with every minute or second that ticks in it */
  $: kind = `${state}|${next ? 'n' : ''}|${choose ? 'c' : ''}`;
  const fadeMs = () => (motionAllowed() ? 120 : 0);
  /** what a screen reader hears when the state changes (the minutes ticking down are not announced) */
  $: said = l2.tone !== 'none' || state === 'connecting' || choose ? l2.text : '';
  /** states without a remote to open (the TV is gone or cannot play it): the text is not a button */
  $: still = state === 'reconnect' || state === 'detached' || state === 'failed';

  let region: HTMLDivElement | undefined;

  // ---- expanded (desktop): grows out of "More controls", replaces the collapsed bar in place ----
  let expanded = false;
  let moreBtn: HTMLButtonElement | undefined;
  /** the More button's rectangle at the tap: the button is gone once the expanded bar mounts, the grow still starts from it */
  let origin: Element | null = null;
  /** the expanded bar serves a TV that plays, connects or has just ended; a lost or failed one has its own collapsed state */
  $: canExpand = source.canExpand && !phone && (state === 'playing' || state === 'connecting' || state === 'ended');
  $: if (expanded && (!canExpand || !shown)) expanded = false;
  function expand() {
    const r = moreBtn?.getBoundingClientRect();
    origin = r ? ({ getBoundingClientRect: () => r } as Element) : null;
    expanded = true;
  }
  /** back to the collapsed bar: the focus returns to More (after a click elsewhere only when nothing else took it) */
  async function collapse(via: 'key' | 'button' | 'outside' = 'button') {
    expanded = false;
    await settled();
    if (via === 'outside' && document.activeElement && document.activeElement !== document.body) return;
    moreBtn?.focus();
  }
  /**
   * A focused button can give way to another (Next -> spinner, reconnect -> playing): keyboard focus then moves to the
   * remote button (else "Play here" / Stop) instead of falling back to the page. Runs before the DOM update.
   */
  $: keepFocus(state, Boolean(next), choose);
  function keepFocus(..._changed: unknown[]) {
    if (!region?.contains(document.activeElement)) return;
    void settled().then(() => {
      if (!region || region.contains(document.activeElement)) return;
      region.querySelector<HTMLElement>('button.open, button.here, button.reconnect, button.stop')?.focus();
    });
  }

  /** text / thumb: opens the remote (the watch page attaches) */
  function open() {
    source.open();
  }
  /** "Play here" in `failed`: the session is dropped, the title plays here */
  function playHere() {
    const c = get(session);
    if (!c) return;
    castEngine.release();
    void goto('/watch/' + c.itemId);
  }
  /** `reconnect`: runs inside the tap (AirPlay opens the system picker, which needs the gesture) */
  function reconnect() { castEngine.reconnect(); }
  function playPause() { if (get(session)?.state === 'playing') source.playPause(); }
  async function stop() {
    const c = get(session);
    if (!c) return;
    const inBar = Boolean(region?.contains(document.activeElement));
    if (await confirm({ title: tr('player.castBar.stopQuestion', { device: c.device }), danger: true, confirmLabel: tr('player.castBar.stop', { device: c.device }) })) {
      await source.stop();
      // the bar is gone: the focus goes on to the page, not to <body>
      if (inBar || document.activeElement === document.body) focusMain();
    }
  }
</script>

<!-- announced politely when the state changes; always mounted, so a bar that appears in a state (connecting, lost) is heard too -->
<p class="sr-only" role="status" aria-live="polite">{shown ? said : ''}</p>

{#if shown && s}
  <div class="castbar" bind:this={region} class:phone class:notab={!tabbar} in:barRise out:barRise={{ dir: 'out' }} on:outroend={() => dispatch('gone')}>
    {#if expanded}
      <CastBarExpanded session={s} {now} trigger={origin} on:collapse={(e) => void collapse(e.detail.via)} />
    {:else}
    <div class="box frost frost-safe frost-panel" style="--fr-scrim-safe:{SCRIM_BAR}" role="region" aria-label={$t('player.castBar.region')} aria-busy={state === 'connecting' ? 'true' : undefined}>
      <div class="line" role="progressbar" aria-label={$t('player.castBar.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><i style="transform:scaleX({progress / 100})"></i></div>
      {#snippet info()}
        {#if (still && !choose) || state === 'connecting'}
          <span class="slot" aria-hidden="true">
            {#if state === 'connecting'}<span class="spin"></span>{:else}<span class="mark" class:err={l2.tone === 'error'}><Icon name="alert" size={24} /></span>{/if}
          </span>
        {:else if thumb && !phone}
          <img class="thumb" src={thumb.src} alt="" style="aspect-ratio:{thumb.ratio}" />
        {/if}
        <span class="txt" id="castbar-txt">
          <span class="t1" class:sr={phone && (still || state === 'connecting')}>{title}</span>
          {#key kind}<span class="t2" class:split={Boolean(parts)} class:warn={l2.tone === 'warn'} class:error={l2.tone === 'error'} in:fade={{ duration: fadeMs() }}>{#if parts}<span class="pre">{parts.pre}</span><span class="dev">{parts.dev}</span><span class="post" class:fit={parts.post.length > 24}>{parts.post}</span>{#if parts.tail}<span class="tail">{parts.tail}</span>{/if}{:else}{l2.text}{/if}</span>{/key}
        </span>
      {/snippet}
      {#if still}
        <div class="open static">{@render info()}</div>
      {:else}
        <!-- named by its action; the title and the second line are its description -->
        <button type="button" class="open" aria-label={$t('player.castBar.open')} aria-describedby="castbar-txt" on:click={open}>{@render info()}</button>
      {/if}

      {#if state === 'connecting'}
        <!-- Stop only -->
      {:else if state === 'reconnect' || state === 'detached'}
        {#if choose}
          <button type="button" class="frost-btn act reconnect" class:ic={phone} aria-label={$t('player.airplay.choose')} title={$t('player.airplay.choose')} on:click={reconnect}>
            <Icon name="airplay" size={20} />{#if !phone}{$t('player.airplay.choose')}{/if}
          </button>
        {:else}
          <button type="button" class="frost-btn act reconnect" class:ic={phone} aria-label={$t('player.castRemote.reconnectBtn')} title={$t('player.castRemote.reconnectBtn')} on:click={reconnect}>
            <Icon name="refresh" size={20} />{#if !phone}{$t('player.castRemote.reconnectBtn')}{/if}
          </button>
        {/if}
      {:else if state === 'failed'}
        <button type="button" class="act here" on:click={playHere}><Icon name="play" size={18} />{$t('player.castBar.playHere')}</button>
      {:else if next}
        {#if secs !== null}<button type="button" class="tb" aria-label={$t('common.cancel')} title={$t('common.cancel')} on:click={() => castEngine.cancelNext()}><Icon name="x" size={22} /></button>{/if}
        <button type="button" class="tb" aria-label={$t('player.castBar.next', { label: next.label })} title={$t('player.castBar.next', { label: next.label })} on:click={() => source.next()}><Icon name="skip-next" size={24} /></button>
      {:else if live}
        <button type="button" class="tb pp" aria-label={$t(s.paused ? 'player.controls.play' : 'player.controls.pause')} on:click={playPause}>
          <Icon name={s.paused ? 'play' : 'pause'} size={24} />
        </button>
        <!-- the web engine: episodes (not on the phone); the app: only while it has a next episode queued (its Next answers false otherwise) -->
        {#if source.nextNeedsQueue ? s.upcoming : s.isEpisode && !phone}<button type="button" class="tb" aria-label={$t('player.controls.next')} title={$t('player.controls.next')} on:click={() => source.next()}><Icon name="skip-next" size={24} /></button>{/if}
      {/if}

      {#if phone}
        <button type="button" class="tb stop" aria-label={$t('player.cast.stop')} title={$t('player.cast.stop')} on:click={stop}><Icon name="stop" size={22} /></button>
      {:else}
        <button type="button" class="frost-btn stop" on:click={stop}>{$t('player.cast.stop')}</button>
        {#if canExpand}
          <button type="button" class="tb more" bind:this={moreBtn} aria-expanded="false" aria-label={$t('player.castBar.more')} title={$t('player.castBar.more')} on:click={expand}><Icon name="chevron-down" size={22} /></button>
        {/if}
      {/if}
    </div>
    {/if}
  </div>
{/if}

<style>
  /* desktop: floating, centred, 16 px above the bottom edge; the layout reserves --castbar-h (92 px) for it */
  .castbar { position: fixed; z-index: 81; left: 0; right: 0; margin-inline: auto; width: min(660px, calc(100vw - 2 * var(--pad-x))); bottom: calc(16px + var(--safe-bottom)); }
  .box { height: 76px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 12px; box-sizing: border-box; }
  button { font: inherit; }
  /* progress: 3 px, inset 24 px from both ends and 6 px from the bottom, drawn by scaleX (never cut by the corner radius) */
  .line { position: absolute; left: 24px; right: 24px; bottom: 6px; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .38); overflow: hidden; pointer-events: none; }
  .line i { display: block; height: 100%; background: var(--acc); transform-origin: left; transition: transform 1s linear; }
  .open { flex: 1 1 auto; min-width: 0; height: 100%; min-height: 44px; display: flex; align-items: center; justify-content: flex-start; gap: 12px; padding: 0 0 6px 0; margin: 0; border: 0; border-radius: 16px; background: transparent; color: inherit; text-align: left; font-weight: 400; cursor: pointer; }
  .open:hover:not(:disabled) { background: transparent; }
  .open.static { cursor: default; }
  .thumb { flex: none; width: 80px; height: 45px; object-fit: cover; border-radius: 8px; background: #1c2228; }
  .slot { flex: none; width: 80px; height: 45px; display: grid; place-items: center; }
  .mark { color: #ffc56b; display: grid; }
  .mark.err { color: #ffbdbd; }
  .txt { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .t1, .t2 { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t1 { font-weight: 700; font-size: .95rem; }
  .t2 { font-size: .85rem; color: rgba(255, 255, 255, .72); }
  /* the device name gives way first, then the rest of the line; the minutes and the countdown tail stay */
  .t2.split { display: flex; min-width: 0; }
  .pre, .tail { flex: none; white-space: pre; }
  .dev { flex: 0 100 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .post { flex: none; white-space: pre; } /* the minutes never shrink; a long "Up next" label may */
  .post.fit { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .t2.warn { color: #ffc56b; }
  .t2.error { color: #ffbdbd; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  /* round 44 px buttons; glass pills for Stop and Reconnect */
  .tb { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #fff; display: inline-grid; place-items: center; cursor: pointer; }
  .tb:hover:not(:disabled) { background: rgba(255, 255, 255, .16); }
  .more :global(svg) { transform: rotate(180deg); } /* the chevron points up: it opens upwards */
  .tb.pp, .tb.pp:hover:not(:disabled) { background: var(--acc-fill); }
  .tb.pp:hover:not(:disabled) { background: var(--acc-fill-hover); }
  .frost-btn.stop, .frost-btn.act { flex: none; padding: 0 14px; font-size: .85rem; white-space: nowrap; }
  .frost-btn.ic { width: 44px; padding: 0; }
  .here { flex: none; min-height: 44px; padding: 0 16px; border-radius: 999px; background: #fff; color: #000; font-weight: 800; white-space: nowrap; }
  .here:hover:not(:disabled) { background: rgba(255, 255, 255, .82); }
  .spin { width: 24px; height: 24px; border: 3px solid rgba(255, 255, 255, .3); border-top-color: var(--acc); border-radius: 50%; animation: cb-spin .8s linear infinite; }
  @keyframes cb-spin { to { transform: rotate(360deg); } }
  button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .open:focus-visible { outline-offset: -2px; }

  /* phone: 68 px, inset 14 px (the tab bar's), 8 px above it; no thumbnail */
  .castbar.phone { left: 14px; right: 14px; margin-inline: 0; width: auto; bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 8px); }
  .castbar.phone.notab { bottom: calc(10px + var(--safe-bottom)); }
  .phone .box { height: 68px; gap: 4px; padding: 0 8px 0 16px; }
  .phone .open { padding-bottom: 4px; gap: 10px; }
  .phone .slot { width: 28px; }
  .phone .t2:not(.split) { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .phone .line { left: 20px; right: 20px; bottom: 5px; }

  /* calm mode and reduced motion: nothing moves (the panels are solid through the .frost rules) */
  :global(html.m-still) .castbar :global(*), :global(html.m-still) .castbar :global(*::before) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .castbar :global(*), .castbar :global(*::before) { transition: none !important; animation: none !important; }
  }
</style>
