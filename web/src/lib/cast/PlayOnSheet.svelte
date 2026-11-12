<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * "Play on" (spec §3): the one place to choose where a title plays. Phone: a glass bottom sheet (`sheetSlide`, `.frost-dim`
   * behind); desktop: a glass popover growing out of `trigger` (`growBoth`). Dialog semantics, Tab stays inside, Escape or a tap
   * outside closes, the focus returns to the trigger. The rows (playOn.ts) call, synchronously inside the click, what needs the
   * tap: the browser's cast dialog, the Player's AirPlay flow (`onAirPlay`) or the engine's stop.
   * Mounted for as long as the Player lives, so the TV a session started on is remembered whichever way it was picked.
   */
  import { afterUpdate, createEventDispatcher, onDestroy, tick } from 'svelte';
  import { perms } from '#lib/perms';
  import { castCapableBrowser, castState, onCastEvent, requestCastSession } from '#lib/cast';
  import { growBoth, scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { dialogKeys } from '#lib/actions';
  import { focusMain } from '#lib/ui/focusMain';
  import { castEngine, castSession } from './engine';
  import { formFactor, playOnRows, whatLine, type PlayOnRow } from './playOn';
  import { lastDevice, rememberDevice } from './resume';

  export let open = false;
  /** the button it grows out of and returns the focus to */
  export let trigger: HTMLElement | null = null;
  /** the position the title plays from (seconds) */
  export let at = 0;
  /** what plays: the title and, for an episode, its code */
  export let title = '';
  export let episode = '';
  /** an AirPlay target is in reach (the Player's controller, or the engine's while AirPlay casts) */
  export let airplay = false;
  /** the Player's own AirPlay controller plays on a TV (no engine session yet) */
  export let airplayActive = false;
  /** phones: a bottom sheet; otherwise a popover */
  export let sheet = false;
  /** the Player's AirPlay tap (token, then the system picker); runs inside the click */
  export let onAirPlay: () => void = () => undefined;
  /** the browser already holds a cast session: play on it without asking again */
  export let onConnected: (() => void) | null = null;

  const dispatch = createEventDispatcher<{ close: void; continued: void }>();
  const store = typeof localStorage === 'undefined' ? null : localStorage;
  let last: string | null = null;
  let panel: HTMLDivElement | undefined;
  let pos = '';

  const form = typeof navigator === 'undefined' ? 'computer' : formFactor(navigator, typeof innerWidth === 'number' ? innerWidth : 1024);
  $: casting = $castSession && $castSession.state !== 'detached' ? $castSession.kind : airplayActive ? 'airplay' as const : null;
  $: rows = playOnRows({
    chromecast: typeof navigator !== 'undefined' && $perms.cast && castCapableBrowser(), devices: $castState.available || $castState.connected,
    airplay, last, casting, form, tf: $t,
  });
  /** the row set is frozen while the sheet is open (a target going away must not move the rows under the finger); titles and ticks stay live */
  let held: PlayOnRow[] = [];
  $: shown = open && held.length ? held.map((h) => rows.find((r) => r.id === h.id) ?? h) : rows;
  $: what = whatLine({ title, episode: episode || undefined, at, tf: $t });

  // the TV picked in the browser's dialog is the usual one next time (name only)
  const off = onCastEvent((e) => { if (e === 'session-start') { const n = $castState.deviceName; if (n) { rememberDevice(store, n); last = lastDevice(store); } } });
  onDestroy(off);
  last = lastDevice(store);

  const ICON: Record<PlayOnRow['id'], 'tv' | 'plus' | 'airplay' | 'monitor'> = { last: 'tv', another: 'plus', airplay: 'airplay', here: 'monitor' };

  /** popover: below the trigger when it sits in the upper half, above it otherwise; clamped into the window */
  function place() {
    if (sheet || !trigger) { pos = ''; return; }
    const r = trigger.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, w = Math.min(360, vw - 24);
    const left = Math.round(Math.min(Math.max(12, r.left + r.width / 2 - w / 2), vw - w - 12));
    pos = r.top < vh / 2 ? `left:${left}px;top:${Math.round(r.bottom + 10)}px;` : `left:${left}px;bottom:${Math.round(vh - r.top + 10)}px;`;
    pos += `width:${w}px;`;
  }
  let was = false;
  $: if (!open) held = [];
  function opened() { place(); last = lastDevice(store); held = rows; void tick().then(() => panel?.querySelector<HTMLElement>('.row')?.focus({ preventScroll: true })); }
  $: if (open !== was) { was = open; if (open) opened(); }

  // a stale row must not take the focus with it: it stays inside the dialog
  afterUpdate(() => { if (open && panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true }); });

  function close(refocus = true) {
    if (!open) return;
    dispatch('close');
    if (refocus) void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); else focusMain(); });
  }

  /** every branch starts what it needs in the tap itself (the browser's and Safari's pickers insist on a gesture) */
  function choose(id: PlayOnRow['id']) {
    if (id === 'last' || id === 'another') {
      if (id === 'last' && onConnected && $castState.connected && !casting) onConnected();
      else void requestCastSession();
      close();
    } else if (id === 'airplay') {
      onAirPlay();
      close();
    } else if (id === 'here') {
      if (casting) { void castEngine.stop(); close(false); dispatch('continued'); } else close();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(panel?.querySelectorAll<HTMLElement>('.row') ?? [])];
    if (!items.length) return;
    e.preventDefault(); e.stopPropagation();
    const i = items.indexOf(document.activeElement as HTMLElement), n = items.length;
    items[(e.key === 'ArrowDown' ? i + 1 : i - 1 + n) % n]!.focus();
  }
  const pop = (node: Element) => (sheet ? twoWay((dir) => sheetSlide(node, { dir })) : growBoth(node, { trigger }));
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="po-wrap" role="presentation" on:pointerdown|stopPropagation on:dblclick|stopPropagation on:click|stopPropagation={() => close()} on:wheel|stopPropagation>
    {#if sheet}<div class="frost-dim" aria-hidden="true" transition:scrimFade|global></div>{/if}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div class="po frost frost-safe" class:sheet class:frost-sheet={sheet} class:pop={!sheet} class:frost-menu={!sheet} bind:this={panel} role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="po-t" aria-describedby="po-w"
      style="--fr-scrim-safe:{SCRIM_MENU};{pos}" use:dialogKeys={{ close: () => close() }} on:keydown={onKey} on:click|stopPropagation transition:pop|global>
      {#if sheet}<span class="grab" aria-hidden="true"></span>{/if}
      <header>
        <div class="hd">
          <h2 id="po-t">{$t('player.castPicker.title')}</h2>
          <p id="po-w">{what}</p>
        </div>
        <button type="button" class="frost-btn round x" aria-label={$t('common.close')} title={$t('common.close')} on:click={() => close()}><Icon name="x" size={20} /></button>
      </header>
      <ul>
        {#each shown as r (r.id)}
          {#if r.id === 'here'}<li class="div" role="presentation"></li>{/if}
          <li>
            <button type="button" class="row" class:on={r.checked} aria-current={r.checked ? 'true' : undefined} data-row={r.id} on:click={() => choose(r.id)}>
              <span class="ic" aria-hidden="true"><Icon name={ICON[r.id]} size={22} /></span>
              <span class="tx"><span class="t">{r.title}</span><span class="h">{r.hint}</span></span>
              {#if r.checked}<span class="tick" aria-hidden="true"><Icon name="check" size={20} /></span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}

<style>
  .po-wrap { position: absolute; inset: 0; z-index: 30; }
  .po { position: absolute; box-sizing: border-box; color: #fff; outline: none; overflow: auto; overscroll-behavior: contain; padding: 14px 10px 10px; }
  .pop { max-height: calc(100% - 24px); }
  .sheet { left: 0; right: 0; bottom: 0; max-width: 560px; max-height: 82%; margin: 0 auto; border-bottom: 0; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding: 8px 10px calc(12px + var(--safe-bottom, 0px)); }
  .grab { display: block; width: 40px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, .45); margin: 2px auto 8px; }
  header { display: flex; align-items: flex-start; gap: 12px; padding: 0 6px 8px 10px; }
  .hd { flex: 1; min-width: 0; }
  h2 { margin: 0; font-size: 1.08rem; font-weight: 800; }
  .hd p { margin: 2px 0 0; font-size: .86rem; color: rgba(255, 255, 255, .9); overflow-wrap: anywhere; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  li.div { height: 1px; margin: 4px 10px; background: rgba(255, 255, 255, .16); }
  .row { display: flex; align-items: center; gap: 14px; width: 100%; min-height: 64px; padding: 0 14px; border-radius: 12px; border: 0; background: transparent; color: #fff; text-align: left; font: inherit; cursor: pointer; box-shadow: none; }
  .row:hover:not(:disabled) { background: rgba(255, 255, 255, .09); box-shadow: none; }
  .row.on { background: var(--fr-sel); }
  .row:focus-visible, .x:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .ic { flex: none; display: grid; place-items: center; width: 28px; }
  .tx { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .t { font-weight: 700; font-size: .98rem; overflow-wrap: anywhere; }
  .h { font-size: .84rem; font-weight: 500; color: rgba(255, 255, 255, .9); }
  .row.on .h, .row:hover .h { color: #fff; }
  .tick { flex: none; color: var(--acc-light, #ff8aa0); display: grid; place-items: center; }
  /* calm mode and reduced motion: nothing moves */
  :global(html.m-still) .po-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .po-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
