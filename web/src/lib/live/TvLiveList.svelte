<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import { t, type TKey } from '#lib/i18n';
  import { isBackKey } from '#lib/spatial';
  import { isLgApp } from '#lib/webos/detect';
  import { nowLines, type LiveChannel, type LiveGroup } from './api';
  import { fadeIn } from './fade';
  import FavTiles from './FavTiles.svelte';
  import GroupChips from './GroupChips.svelte';
  import { hintKeys, noteKey, seenKeys, type SeenKey } from './keyhints';
  import { resolveLiveKey } from './livekeys';
  import { createLongOk } from './longok';
  import NumberCard from './NumberCard.svelte';
  import { commitNumber, NUMBER_TIMEOUT_MS, typeDigit, type NumberState } from './numberEntry';
  import type { LiveFilter } from './order';
  import { progressAt, timeLeft, timeLeftText, rowName } from './progress';
  import TvHintLine from './TvHintLine.svelte';

  /**
   * The Live-TV list on a TV (spec §11.3): the favourites row (360 px tiles), the group chips as a focusable row, then 96 px rows
   * (72 px logo, text of 28 px), a footer hint line. Everything works with the D-pad, OK and Back alone:
   *  ▲ ▼ move through the rows (held keys repeat; the focused row is kept in the middle third of the screen), ▲ from the first row
   *  goes to the chips, ▼ from the chips into the list, ◀ on a row opens the rail (the shell does that), ▶ moves to the row's star
   *  (OK toggles it, ◀ goes back), OK watches, Back goes Home (or closes the card / panel that is open).
   * Shortcuts, only where the remote sends them: a long OK (>= 600 ms) toggles the favourite, ChannelUp / ChannelDown (and PageUp /
   * PageDown) jump 8 rows, digits open the number card (OK or 2 s: focus that row), a lone 0 the last watched row, Info the info
   * panel. Every keydown goes through `noteKey`, so the hint line names a shortcut only after this device sent it.
   * A TV is calm and still: nothing here animates, panels are solid.
   */
  export let channels: LiveChannel[];
  /** every channel the person may see (number entry looks in all of them, whatever chip is chosen) */
  export let all: LiveChannel[];
  export let favs: LiveChannel[];
  export let groups: LiveGroup[];
  export let filter: LiveFilter;
  /** show *Zuletzt gesehen* */
  export let recent = false;
  /** id of the last watched channel (the list's `last`), or null */
  export let last: string | null = null;
  export let now: Date;
  export let loading = false;
  /** the person has no channel at all */
  export let none = false;

  const dispatch = createEventDispatcher<{ open: LiveChannel; star: LiveChannel; select: LiveFilter }>();

  const JUMP = 8;
  let root: HTMLElement;
  let seen: Set<SeenKey> = new Set();
  let number: NumberState | null = null;
  let noMatch = '';
  let numT: ReturnType<typeof setTimeout> | undefined;
  let msgT: ReturnType<typeof setTimeout> | undefined;
  let info: LiveChannel | null = null;
  let infoEl: HTMLElement | undefined;
  let infoFrom: HTMLElement | null = null;
  /** the row the focus last was on (▼ from the chips and the jumps start there) */
  let curId: string | null = null;
  /** a key was pressed: the entry focus must not take it away any more */
  let userMoved = false;
  let focusedInitial = false;

  let empty: TKey;
  $: empty = filter === 'fav' ? 'live.emptyFav' : filter === 'recent' ? 'live.emptyRecent' : none ? 'live.empty' : 'live.emptyGroup';
  $: lastChannel = last ? all.find((c) => c.id === last) ?? null : null;

  // ---- focus ----
  const rowEls = (): HTMLElement[] => (root ? [...root.querySelectorAll<HTMLElement>('.trow')] : []);
  const partOf = (li: HTMLElement | undefined, star: boolean): HTMLElement | null => li?.querySelector<HTMLElement>(star ? '.star' : '.main') ?? null;
  /** keeps the focused row in the middle third of the screen (jumps there at once, a TV is still) */
  function centre(el: HTMLElement) {
    const r = el.getBoundingClientRect(), vh = window.innerHeight, mid = r.top + r.height / 2;
    if (mid < vh / 3 || mid > (vh * 2) / 3) window.scrollTo({ top: window.scrollY + mid - vh / 2, behavior: 'auto' });
  }
  function put(el: HTMLElement | null) {
    if (!el) return;
    el.focus({ preventScroll: true });
    centre(el);
  }
  function focusRow(id: string | null, star = false): boolean {
    const li = rowEls().find((x) => x.dataset.id === id);
    const el = partOf(li, star);
    put(el);
    return !!el;
  }
  /** the entry focus: the last watched channel's row, else the first */
  function focusEntry() {
    if (userMoved) return;
    if (!(last && focusRow(last))) put(partOf(rowEls()[0], false));
  }
  $: if (!loading && channels.length && !focusedInitial && root) {
    focusedInitial = true;
    void tick().then(focusEntry);
  }

  /** ▼ ▲ move by rows, ◀ ▶ switch between a row and its star: custom steps the shell's spatial navigation asks for (`ff-nav`) */
  function onNav(e: Event) {
    const dir = (e as CustomEvent<{ dir: string }>).detail?.dir;
    const el = e.target as HTMLElement;
    userMoved = true;
    const li = el.closest<HTMLElement>('.trow');
    if (li) {
      const star = el.classList.contains('star');
      const rows = rowEls(), i = rows.indexOf(li);
      if (dir === 'down') { e.preventDefault(); put(partOf(rows[i + 1], star)); return; } // the last row stays
      if (dir === 'up') {
        e.preventDefault();
        if (i > 0) put(partOf(rows[i - 1], star));
        else put(root.querySelector<HTMLElement>('.chip.on') ?? root.querySelector<HTMLElement>('.chip')); // from the first row to the chips
        return;
      }
      if (dir === 'right') { e.preventDefault(); if (!star) put(partOf(li, true)); return; }
      if (dir === 'left' && star) { e.preventDefault(); put(partOf(li, false)); }
      return; // ◀ on a row: the shell opens its rail
    }
    if (dir === 'down' && el.closest('.chips')) { // from the chips into the list: the row the focus was on, else the first
      const rows = rowEls();
      if (rows.length) { e.preventDefault(); if (!focusRow(curId)) put(partOf(rows[0], false)); }
    }
  }
  function onFocusIn(e: FocusEvent) {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.trow');
    if (li) curId = li.dataset.id ?? null;
  }

  /** ChannelUp / ChannelDown: 8 rows on (stops at the ends) */
  function jump(by: number) {
    const rows = rowEls();
    if (!rows.length) return;
    const a = document.activeElement as HTMLElement | null;
    let i = rows.indexOf(a?.closest<HTMLElement>('.trow') as HTMLElement);
    if (i < 0) i = Math.max(0, rows.findIndex((x) => x.dataset.id === curId));
    put(partOf(rows[Math.min(rows.length - 1, Math.max(0, i + by))], a?.classList.contains('star') ?? false));
  }

  /** a number brought this channel: focus its row (a chip that hides it gives way to *Alle*) */
  async function goTo(c: LiveChannel) {
    if (!channels.some((x) => x.id === c.id)) { dispatch('select', 'all'); await tick(); await tick(); }
    focusRow(c.id);
  }

  // ---- favourite (the star, a long OK): the list may lose the row (the Favoriten chip), then the focus moves to a neighbour ----
  async function toggle(c: LiveChannel) {
    const i = channels.findIndex((x) => x.id === c.id), star = document.activeElement?.classList.contains('star') ?? false;
    dispatch('star', c);
    await tick();
    const a = document.activeElement;
    if (!a || a === document.body || !root.contains(a)) {
      const rows = rowEls();
      if (rows.length) put(partOf(rows[Math.min(i, rows.length - 1)], star));
      else put(root.querySelector<HTMLElement>('.chip.on'));
    }
  }

  // ---- long OK ----
  let pressed: HTMLElement | null = null;
  const longOk = createLongOk({
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    onShort: () => { const el = pressed; pressed = null; el?.click(); },
    onLong: () => {
      const el = pressed; pressed = null;
      const c = channels.find((x) => x.id === el?.dataset.ch);
      if (c) void toggle(c);
    },
  });

  // ---- number entry ----
  const clearNumberTimers = () => { clearTimeout(numT); numT = undefined; };
  function closeNumber() { clearNumberTimers(); number = null; }
  function refuse(text: string) {
    number = null;
    noMatch = text;
    clearTimeout(msgT);
    msgT = setTimeout(() => { noMatch = ''; }, NUMBER_TIMEOUT_MS);
  }
  function digit(d: number) {
    clearTimeout(msgT); noMatch = '';
    number = typeDigit(number ?? { digits: '', match: null, unique: false, zero: false }, d, all);
    clearNumberTimers();
    numT = setTimeout(commit, NUMBER_TIMEOUT_MS);
  }
  function commit() {
    if (!number) return;
    const r = commitNumber(number, all);
    closeNumber();
    if (r.kind === 'channel') void goTo(r.channel);
    else if (r.kind === 'last') { if (lastChannel) void goTo(lastChannel); else refuse($t('live.number.noLast')); }
    else refuse(r.text);
  }

  // ---- info panel ----
  async function openInfo() {
    const el = document.activeElement as HTMLElement | null;
    const c = all.find((x) => x.id === el?.closest<HTMLElement>('[data-ch]')?.dataset.ch);
    if (!c) return;
    infoFrom = el;
    info = c;
    await tick();
    infoEl?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }
  async function closeInfo() {
    info = null;
    const back = infoFrom;
    infoFrom = null;
    await tick();
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  // ---- keys ----
  function stop(e: Event) { e.preventDefault(); e.stopPropagation(); }
  function onKeyDown(e: KeyboardEvent) {
    if (!root?.isConnected) return;
    const s = noteKey(e.key);
    if (s.size !== seen.size) seen = s;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.startsWith('Arrow')) return;
    const back = e.key === 'Escape' || isBackKey(e);
    if (info) { // the panel owns Back, Info and OK on its button
      if (back || e.key === 'Info') { stop(e); void closeInfo(); }
      return;
    }
    if (back) {
      if (number || noMatch) { stop(e); closeNumber(); clearTimeout(msgT); noMatch = ''; return; }
      if (!document.activeElement?.closest('nav.rail') && !document.querySelector('[aria-modal="true"]')) { stop(e); void goto('/'); } // Back from the list goes Home
      return;
    }
    if (e.key === 'Enter') {
      if (number) { stop(e); commit(); return; }
      const a = document.activeElement as HTMLElement | null;
      if (a?.matches('.trow .main[data-ch]')) { e.preventDefault(); pressed = a; longOk.down(e); } // short OK watches, a long OK is the favourite
      return;
    }
    const act = resolveLiveKey(e, { tv: true, lg: isLgApp(), controlsVisible: false, onBody: false, overlayOpen: false, numberOpen: !!number });
    if (!act) return;
    if (act.type === 'digit') { stop(e); digit(act.d); }
    else if (act.type === 'chDown') { stop(e); jump(JUMP); }
    else if (act.type === 'chUp') { stop(e); jump(-JUMP); }
    else if (act.type === 'info') { stop(e); void openInfo(); }
    else if (act.type === 'last') { stop(e); if (lastChannel) void goTo(lastChannel); }
  }
  function onKeyUp(e: KeyboardEvent) { if (e.key === 'Enter') longOk.up(); }

  onMount(() => {
    seen = seenKeys();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', longOk.cancel);
    root.addEventListener('ff-nav', onNav);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', longOk.cancel);
      root?.removeEventListener('ff-nav', onNav);
    };
  });
  onDestroy(() => { clearTimeout(numT); clearTimeout(msgT); longOk.cancel(); });
</script>

<div class="tvlive" bind:this={root} on:focusin={onFocusIn} aria-busy={loading ? 'true' : undefined}>
  <FavTiles tv channels={favs} {now} {loading} on:open={(e) => dispatch('open', e.detail)} />
  <GroupChips tv {groups} value={filter} {recent} {loading} on:select={(e) => dispatch('select', e.detail)} />

  {#if loading}
    <ul class="rows" aria-hidden="true">{#each Array(8) as _, k (k)}<li class="sk skeleton"></li>{/each}</ul>
  {:else if !channels.length}
    <p class="muted empty" role="status">{$t(empty)}</p>
  {:else}
    <ul class="rows" aria-label={$t('live.player.channelList')}>
      {#each channels as c (c.id)}
        {@const lines = nowLines(c)}
        {@const running = c.receiving !== false && c.epg === 'ok' && !!c.now}
        <li class="trow" data-id={c.id}>
          <button type="button" class="main" data-ch={c.id} aria-label={rowName(c, now)} on:click={() => dispatch('open', c)}>
            <span class="num" aria-hidden="true">{c.number}</span>
            <span class="logo" aria-hidden="true">{#if c.logo}<img src={c.logo} alt="" width="72" height="72" loading="lazy" decoding="async" use:fadeIn />{/if}</span>
            <span class="txt" aria-hidden="true">
              <span class="name">{c.name}</span>
              <span class="ln">{#if running}<i class="lb">{$t('live.now')}</i>{/if}<span class="tx">{lines.now}</span></span>
              <span class="bar"><i style="transform:scaleX({running && c.now ? progressAt(c.now, now) : 0})"></i></span>
            </span>
          </button>
          <button type="button" class="star" class:on={c.favourite} data-ch={c.id} aria-pressed={c.favourite} aria-label={`${$t('live.favourite')}: ${c.name}`} on:click={() => void toggle(c)}>
            <Icon name="star" size={36} fill={c.favourite} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if number || noMatch}
  <NumberCard digits={number?.digits ?? ''} match={number?.match ?? null} zero={number?.zero ?? false} last={lastChannel} message={noMatch} />
{/if}

{#if info}
  {@const lines = nowLines(info)}
  {@const left = info.receiving !== false && info.epg === 'ok' ? timeLeft(info.now, now) : null}
  <div class="infoback">
    <div class="info panel" role="dialog" aria-modal="true" aria-label={info.name} bind:this={infoEl}>
      <h2>{info.number} {info.name}</h2>
      <p class="il"><b>{$t('live.now')}</b> {lines.now}{#if left} <span class="left">{timeLeftText(left)}</span>{/if}</p>
      <p class="il">{#if lines.next}<b>{$t('live.next')}</b> {lines.next}{/if}</p>
      <button type="button" class="close">{$t('common.close')}</button>
    </div>
  </div>
{/if}

<TvHintLine keys={hintKeys('list', seen)} />

<style>
  /* 1u = 1 px at a 1080p viewport: sizes follow the viewport, so a TV that reports 960 or 1280 CSS pixels lays out the same */
  .tvlive { --u: calc(100vw / 1920); padding-bottom: 45vh; }
  .rows { margin: 0; padding: 0 calc(var(--u) * 64) 0 calc(var(--u) * 28); list-style: none; }
  .sk { display: block; height: calc(var(--u) * 96); margin-bottom: calc(var(--u) * 8); }
  .empty { margin: calc(var(--u) * 28) calc(var(--u) * 28); min-height: calc(var(--u) * 44); font-size: calc(var(--u) * 28); }
  .trow { display: grid; grid-template-columns: minmax(0, 1fr) calc(var(--u) * 88); align-items: center; height: calc(var(--u) * 96); margin-bottom: calc(var(--u) * 8); list-style: none; }
  /* the global coral button look does not apply: restated, also for hover and press; the html.tv button sizes are beaten by the doubled class */
  .trow .main, .trow .main:hover:not(:disabled), .trow .main:active:not(:disabled) {
    display: grid; grid-template-columns: calc(var(--u) * 84) calc(var(--u) * 72) minmax(0, 1fr); column-gap: calc(var(--u) * 24); align-items: center; width: 100%; height: calc(var(--u) * 96); min-height: 0; box-sizing: border-box;
    padding: 0 calc(var(--u) * 16) 0 0; margin: 0; border: 0; border-radius: 12px; background: transparent; color: #fff; font: inherit; font-weight: 400; text-align: left; transform: none; transition: none; justify-content: start;
  }
  .trow .main:focus-visible, .trow .main:focus-visible:hover:not(:disabled), .trow .main:focus-visible:active:not(:disabled) { background: rgba(255, 255, 255, .14); transform: scale(1.08); position: relative; z-index: 2; }
  .num { font-size: calc(var(--u) * 32); font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; color: rgba(255, 255, 255, .86); }
  .logo { position: relative; display: grid; place-items: center; width: calc(var(--u) * 72); height: calc(var(--u) * 72); overflow: hidden; border-radius: 12px; background: #1c1a21; }
  .logo img { width: 80%; height: 80%; object-fit: contain; opacity: 0; transition: none; }
  .logo :global(img.in) { opacity: 1; }
  /* name, programme line, progress: rows of fixed height, so programme data arriving moves nothing */
  .txt { display: grid; grid-template-rows: calc(var(--u) * 36) calc(var(--u) * 34) calc(var(--u) * 4); row-gap: calc(var(--u) * 4); min-width: 0; }
  .name { font-weight: 700; font-size: calc(var(--u) * 28); line-height: calc(var(--u) * 36); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ln { display: flex; gap: calc(var(--u) * 12); min-width: 0; font-size: calc(var(--u) * 28); line-height: calc(var(--u) * 34); color: rgba(255, 255, 255, .86); }
  .lb { flex: none; font-style: normal; font-weight: 700; color: #fff; }
  .tx { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .bar { align-self: end; height: calc(var(--u) * 4); border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, .26); }
  .bar > i { display: block; height: 100%; background: #fff; transform-origin: 0 50%; }
  .trow .star, .trow .star:hover:not(:disabled), .trow .star:active:not(:disabled) { display: grid; place-items: center; width: calc(var(--u) * 72); height: calc(var(--u) * 72); min-height: 0; padding: 0; margin: 0 0 0 calc(var(--u) * 8); border: 0; border-radius: 50%; background: transparent; color: rgba(255, 255, 255, .78); transform: none; transition: none; }
  .trow .star.on { color: #fff; }
  .trow .star:focus-visible, .trow .star:focus-visible:hover:not(:disabled), .trow .star:focus-visible:active:not(:disabled) { background: rgba(255, 255, 255, .14); color: #fff; transform: scale(1.08); position: relative; z-index: 2; }

  /* the info panel: a solid panel over a dim layer, switching at once */
  /* a still page (calm mode, reduced motion, TV): the global button transition is off here too */
  :global(html.m-still) .trow button, :global(html.m-still) .info button { transition: none; }
  .infoback { position: fixed; z-index: 80; left: 0; right: 0; top: 0; bottom: 0; display: grid; place-items: center; background: rgba(0, 0, 0, .72); }
  .info { width: calc(var(--u) * 900); max-width: 92vw; box-sizing: border-box; padding: calc(var(--u) * 36) calc(var(--u) * 44); border-radius: 12px; font-size: calc(var(--u) * 28); line-height: calc(var(--u) * 40); }
  .info h2 { margin: 0 0 calc(var(--u) * 16); font-size: calc(var(--u) * 40); line-height: calc(var(--u) * 48); }
  .il { min-height: calc(var(--u) * 40); margin: 0 0 calc(var(--u) * 8); }
  .il b { margin-right: calc(var(--u) * 10); }
  .left { margin-left: calc(var(--u) * 12); color: rgba(255, 255, 255, .78); }
  .info .close, .info .close:hover:not(:disabled), .info .close:active:not(:disabled) { min-height: calc(var(--u) * 64); margin-top: calc(var(--u) * 20); padding: 0 calc(var(--u) * 36); font-size: calc(var(--u) * 28); transition: none; transform: none; }
</style>
