<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * *Favoriten ordnen* (live TV spec §11.1; Task 38): a glass sheet (`sheetSlide`, the page dimmed behind; on a TV a solid panel on the
   * right) with the favourites as rows: logo, number, name and a drag handle. The order itself is `#lib/ui/dragOrder` (pure, Task 24,
   * ruling 56), the TV keys are `./favOrder` (pure). The view knows no endpoint: `save(ids)` stores the complete order.
   *   <FavOrderSheet {rows} {trigger} {tv} save={(ids) => setFavouriteOrder(ids)} on:close={() => (open = false)} />
   *
   * Pointer and touch: the handle lifts the row, which follows the pointer by `transform` only; the others slide aside by FLIP. The
   * keyed list moves a lifted row's own <li> while the order changes, and a browser drops a pointer capture held by a moved node, so
   * the capture sits on the list (it never moves) and move / up / cancel are read on the window, filtered by the pointer's id. Pointer
   * up drops; pointer cancel, Escape, a window blur and a reset of `rows` end the drag and put the row back. A mouse move with no button
   * down counts as the pointer going up (a button released where the page did not see it).
   * Keyboard (desktop): focus the handle, Space picks up, ↑/↓ move, Space drops, Escape cancels (a second Escape closes the sheet);
   * every step is announced in a polite live region (`live.fav.order*`). *Fertig* stores the order (`runAction`: busy, error toast, an
   * undo toast that puts the old order back) and closes; closing any other way keeps what is stored.
   * TV move mode (`tv`): D-pad, OK and Back alone. ▲/▼ walk the rows, OK picks one up, ▲/▼ move it, OK drops it and stores the order at
   * once (no button to reach below a long list; a drop while a store runs is stored right after it), Back cancels a move in progress,
   * a second Back closes the sheet.
   * Calm mode, reduced motion, TV, kids (`html.m-still`, `fxMode() === 'still'`): no transitions, rows switch places at once.
   */
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { dialogKeys } from '#lib/actions';
  import { fxMode, scrimFade, sheetSlide, twoWay } from '#lib/glass/fx';
  import { sheetRoom } from '#lib/glass/sheetRoom';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { isBackKey } from '#lib/spatial';
  import { busyKeys, isBusy, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { cancel, drop, flipOffsets, idle, insertAt, move, moveTo, pick, type DragState } from '#lib/ui/dragOrder';
  import { uid } from '#lib/ui/ids';
  import { orderChanged, tvOrderKey, type TvOrderKey, type TvOrderResult } from './favOrder';

  interface FavRow { id: string; name: string; number: number; logo: string | null }
  export let rows: FavRow[];
  /** stores the complete order (required); the caller picks the endpoint and updates its own list */
  export let save: (ids: string[]) => Promise<void>;
  /** the button it came from (the focus returns there on close) */
  export let trigger: HTMLElement | null = null;
  /** the TV move mode and panel */
  export let tv = false;

  const dispatch = createEventDispatcher<{ close: void }>();
  const id = uid('fo');
  const busyKey = uid('favorder');
  let s: DragState = idle([]);
  /** the stored order: the rows as given, then the last stored order */
  let base: string[] = [];
  let byId = new Map<string, FavRow>();
  /** what the rows looked like when they were last taken over, so a refresh with the same content resets nothing */
  let sig: string | null = null;
  /** the order a store in flight is writing: its arrival in `rows` is not a reset */
  let expected: string[] | null = null;
  /** an order that was dropped while a store ran; stored right after it */
  let pending: string[] | null = null;
  /** the row the TV focus is on (index) */
  let focus = 0;
  /** how the lifted row is moved: by the keyboard (also the TV) or by a pointer */
  let mode: 'key' | 'pointer' | null = null;
  /** the polite announcement */
  let status = '';

  $: reset(rows);
  function reset(r: FavRow[]) {
    byId = new Map(r.map((x) => [x.id, x]));
    const next = r.map((x) => `${x.id}\t${x.name}\t${x.number}\t${x.logo ?? ''}`).join('\n');
    if (next === sig) return;
    sig = next;
    const incoming = r.map((x) => x.id);
    if (expected && !orderChanged(expected, incoming)) { base = incoming; return; } // our own store arriving
    const lifted = s.picked !== null;
    endPointer();
    // a drag or a glide left inline transforms behind: the new rows stand in their places at once
    for (const k in els) { const el = els[k]; if (el) { el.style.transition = ''; el.style.transform = ''; } }
    base = incoming;
    s = idle(incoming);
    mode = null;
    focus = Math.min(focus, Math.max(0, incoming.length - 1));
    if (lifted) say(tr('live.fav.orderCancelled'));
  }

  $: dirty = orderChanged(s.ids, base);
  $: own = $busyKeys.has(busyKey);
  /** no change while this store runs on a desktop (a TV keeps going: every drop is stored) */
  $: locked = own && !tv;

  let list: HTMLOListElement;
  let panel: HTMLDivElement | undefined;
  const els: Record<string, HTMLLIElement> = {};
  const handles: Record<string, HTMLButtonElement> = {};

  /** calm mode, reduced motion, TV: places switch at once */
  const still = (): boolean => {
    const c = document.documentElement.classList;
    return fxMode() === 'still' || c.contains('m-still') || c.contains('tv') || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  };
  const nameOf = (k: string): string => byId.get(k)?.name ?? '';
  const posOf = (st: DragState, k: string): number => st.ids.indexOf(k) + 1;
  /** a repeated text differs by a no-break space, so the live region announces it again */
  function say(text: string) { status = status === text ? `${text} ` : text; }

  /**
   * Apply a new order. FLIP: each row's place on screen before (with any glide still running), its new layout place after the update
   * (`offsetTop`, which no transform changes), the difference as a `transform` without transition, then back to 0 with the row's
   * transition. `skip`: the row the pointer holds (it follows the pointer instead).
   */
  async function reorder(next: DragState, skip: string | null): Promise<boolean> {
    if (next === s) return false;
    const animate = !still();
    const before = new Map<string, number>();
    if (animate) for (const k of s.ids) if (k !== skip && els[k]) before.set(k, els[k]!.getBoundingClientRect().top);
    s = next;
    await tick();
    if (!animate || !list) return true;
    const top = list.getBoundingClientRect().top + list.clientTop;
    const after = new Map<string, number>();
    before.forEach((_v, k) => { const el = els[k]; if (el) after.set(k, top + el.offsetTop); });
    const off = flipOffsets(before, after);
    off.forEach((d, k) => { const el = els[k]!; el.style.transition = 'none'; el.style.transform = `translateY(${d}px)`; });
    if (off.size) void list.offsetHeight; // the start places are committed before the glide begins
    off.forEach((_d, k) => { const el = els[k]!; el.style.transition = ''; el.style.transform = ''; });
    return true;
  }

  // ---- keyboard: Space picks up / drops, ↑/↓ move, Escape cancels (the handle keeps focus while its row moves)
  /** the row whose handle is being refocused after a move (its blur is not a cancel) */
  let keep: string | null = null;
  async function refocus(k: string) {
    const h = handles[k];
    if (h) { h.focus({ preventScroll: true }); els[k]?.scrollIntoView({ block: 'nearest' }); }
    keep = null;
  }
  async function onKey(e: KeyboardEvent, k: string, i: number) {
    if (locked || mode === 'pointer') return;
    if (tv) { tvGrip(e); return; }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (e.repeat) return; // a held Space does not toggle pick and drop
      if (s.picked === null) {
        s = pick(s, k);
        mode = 'key';
        say(tr('live.fav.orderPicked', { name: nameOf(k), n: posOf(s, k), m: s.ids.length }));
      } else if (s.picked === k) {
        const n = posOf(s, k);
        s = drop(s);
        mode = null;
        say(tr('live.fav.orderDropped', { name: nameOf(k), n }));
      }
      return;
    }
    focus = i;
    if (s.picked !== k) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Up' || e.key === 'Down') {
      e.preventDefault();
      const next = move(s, e.key === 'ArrowUp' || e.key === 'Up' ? -1 : 1);
      if (next === s) return;
      keep = k;
      await reorder(next, null);
      await refocus(k);
      say(tr('live.fav.orderMoved', { n: posOf(s, k), m: s.ids.length }));
    } else if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation(); // the sheet stays open: only the move is cancelled
      await cancelMove(k);
    }
  }
  async function cancelMove(k: string) {
    keep = k;
    mode = null;
    await reorder(cancel(s), null);
    await refocus(k);
    say(tr('live.fav.orderCancelled'));
  }
  /** focus left the handle of a lifted row (Tab, a click elsewhere): the move is cancelled, nothing changes unseen */
  function onBlur(k: string) {
    if (keep === null && mode === 'key' && s.picked === k) {
      mode = null;
      void reorder(cancel(s), null).then(() => say(tr('live.fav.orderCancelled')));
    }
  }

  // ---- TV move mode: the keys are decided by `tvOrderKey`; this only moves the focus and stores a drop
  function tvGrip(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); if (!e.repeat) tvKey('ok'); } // a held OK that opened the sheet is no pick
    else if (e.key === 'ArrowUp' || e.key === 'Up') { e.preventDefault(); tvKey('up'); }
    else if (e.key === 'ArrowDown' || e.key === 'Down') { e.preventDefault(); tvKey('down'); }
  }
  function tvKey(key: TvOrderKey) {
    const r = tvOrderKey({ drag: s, focus }, key, nameOf);
    if (r.close) { close(); return; }
    void applyTv(r, key);
  }
  async function applyTv(r: TvOrderResult, key: TvOrderKey) {
    const dropped = key === 'ok' && s.picked !== null;
    const target = r.drag.ids[r.focus] ?? null;
    keep = target; // the keyed list moves the row: its blur is no cancel
    focus = r.focus;
    mode = r.drag.picked === null ? null : 'key';
    const ids = r.drag.ids.slice();
    if (r.drag !== s) await reorder(r.drag, null);
    if (target) await refocus(target); else keep = null;
    if (r.announce) say(tr(r.announce.key, r.announce.params));
    if (dropped) void persist(ids);
  }
  /** the spatial navigation of the shell asks the sheet to take every step itself: the focus never leaves the rows */
  function onNav(e: Event) {
    if (!tv) return;
    const dir = (e as CustomEvent<{ dir: string }>).detail?.dir;
    e.preventDefault();
    if (dir === 'up' || dir === 'down') tvKey(dir);
  }

  // ---- pointer and touch: the row follows the pointer by transform, the others slide by FLIP; the list scrolls at its edges
  interface Drag { id: string; pointerId: number; grab: number; y: number; raf: number; scroller: HTMLElement | null }
  let drag: Drag | null = null;
  /** the nearest scrolling ancestor (null: the page) */
  function scrollerOf(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }
  const EDGE = 56;
  /** scroll along when the pointer is near the top or bottom edge; true when it scrolled */
  function edgeScroll(d: Drag): boolean {
    const r = d.scroller ? d.scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const v = d.y < r.top + EDGE ? -Math.ceil((r.top + EDGE - d.y) / 4) : d.y > r.bottom - EDGE ? Math.ceil((d.y - (r.bottom - EDGE)) / 4) : 0;
    if (!v) return false;
    const by = Math.max(-16, Math.min(16, v));
    if (d.scroller) { const t0 = d.scroller.scrollTop; d.scroller.scrollTop = t0 + by; return d.scroller.scrollTop !== t0; }
    const y0 = window.scrollY;
    window.scrollBy(0, by);
    return window.scrollY !== y0;
  }
  function onDown(e: PointerEvent, k: string) {
    if (locked || s.picked !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const row = els[k];
    if (!row) return;
    e.preventDefault();
    try { list.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone: the window listeners still see it */ }
    drag = { id: k, pointerId: e.pointerId, grab: e.clientY - row.getBoundingClientRect().top, y: e.clientY, raf: 0, scroller: scrollerOf(list) };
    s = pick(s, k);
    mode = 'pointer';
    focus = s.ids.indexOf(k);
    say(tr('live.fav.orderPicked', { name: nameOf(k), n: posOf(s, k), m: s.ids.length }));
    schedule();
  }
  function onMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // the button went up where the page did not see it (released outside the window, a lost event): that is the end of the drag
    if (e.pointerType === 'mouse' && e.buttons === 0) { void onUp(e); return; }
    drag.y = e.clientY;
    schedule();
  }
  function schedule() { if (drag && !drag.raf) drag.raf = requestAnimationFrame(() => void frame()); }
  async function frame() {
    const d = drag;
    if (!d) return;
    d.raf = 0;
    if (edgeScroll(d)) schedule();
    const row = els[d.id];
    if (!row || !list) return;
    const top = list.getBoundingClientRect().top + list.clientTop;
    // the other rows' middles (layout places) and the room the lifted row may move in
    const mids: number[] = [];
    let lo = Infinity, hi = -Infinity;
    for (const k of s.ids) {
      const el = els[k];
      if (!el) continue;
      lo = Math.min(lo, el.offsetTop);
      hi = Math.max(hi, el.offsetTop + el.offsetHeight);
      if (k !== d.id) mids.push(el.offsetTop + el.offsetHeight / 2);
    }
    const y = Math.min(hi - row.offsetHeight, Math.max(lo, d.y - top - d.grab));
    const to = insertAt(mids, y + row.offsetHeight / 2);
    if (to !== s.ids.indexOf(d.id) && (await reorder(moveTo(s, to), d.id)) && drag === d) {
      say(tr('live.fav.orderMoved', { n: posOf(s, d.id), m: s.ids.length }));
    }
    if (drag !== d) return;
    row.style.transform = `translateY(${y - row.offsetTop}px)`;
  }
  /** pointer up: the row glides from under the pointer into its place */
  async function onUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = endPointer();
    if (!d) return;
    const n = posOf(s, d.id);
    s = drop(s);
    mode = null;
    await tick(); // the row's own transition is back before its transform is released
    const row = els[d.id];
    if (row) row.style.transform = '';
    say(tr('live.fav.orderDropped', { name: nameOf(d.id), n }));
    if (tv) void persist(s.ids.slice()); // a TV stores every drop, a pointer on it too
  }
  function onPointerCancel(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointerId) void onCancel();
  }
  /** pointer cancelled (the system took it, Escape, the window lost focus): the row goes back where it was picked up */
  async function onCancel() {
    const d = endPointer();
    if (!d) return;
    mode = null;
    await tick();
    await reorder(cancel(s), null);
    const row = els[d.id];
    if (row) row.style.transform = '';
    say(tr('live.fav.orderCancelled'));
  }
  function endPointer(): Drag | null {
    const d = drag;
    if (!d) return null;
    if (d.raf) cancelAnimationFrame(d.raf);
    drag = null;
    try { if (list && list.hasPointerCapture(d.pointerId)) list.releasePointerCapture(d.pointerId); } catch { /* already released */ }
    return d;
  }
  function onWindowKey(e: KeyboardEvent) {
    const esc = e.key === 'Escape' || e.key === 'Esc';
    if (drag && esc) { e.preventDefault(); e.stopPropagation(); void onCancel(); return; }
    // a TV's Back: cancels the move in progress, else closes (the page behind must not see it)
    if (tv && panel?.isConnected && (esc || isBackKey(e))) { e.preventDefault(); e.stopPropagation(); tvKey('back'); }
  }

  // ---- storing: Fertig (desktop) and every TV drop; one request at a time, a later order waits for the one in flight
  async function persist(ids: string[]): Promise<boolean> {
    if (!orderChanged(ids, base)) return true;
    if (isBusy(busyKey)) { pending = ids; return false; }
    const prev = base.slice();
    expected = ids;
    const res = await runAction({ key: busyKey, run: () => save(ids), success: tr('common.saved'), undo: { run: () => save(prev) } });
    expected = null;
    if (res.ok) base = ids;
    const next = pending;
    pending = null;
    if (next && orderChanged(next, base)) return persist(next);
    return res.ok;
  }
  async function done() {
    if (locked || s.picked !== null) return;
    if (!dirty || (await persist(s.ids.slice()))) close();
  }

  function close() {
    if (locked) return;
    endPointer();
    dispatch('close');
    void tick().then(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  /** a sheet on a desktop or phone goes to <body>; the TV panel stays in the page (inside <main>), where the shell's focus settling sees its focus as the page's own */
  function portal(node: HTMLElement, on: boolean) { if (on) document.body.appendChild(node); return { destroy() { if (on) node.remove(); } }; }
  const slide = (node: Element) => twoWay((dir) => sheetSlide(node, { dir, side: tv ? 'right' : 'bottom' }));
  onMount(() => {
    const first = handles[s.ids[0] ?? ''];
    if (first) first.focus({ preventScroll: true });
    focus = 0;
    panel?.addEventListener('ff-nav', onNav);
    return () => panel?.removeEventListener('ff-nav', onNav);
  });
</script>

<svelte:window on:keydown|capture={onWindowKey} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onPointerCancel} on:blur={() => { if (drag) void onCancel(); }} />

<div class="fo-wrap" class:tv use:portal={!tv}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="frost-dim" aria-hidden="true" on:click={() => { if (!dirty) close(); }} transition:scrimFade|global></div>
  <div class="fo frost frost-safe frost-sheet" class:tv bind:this={panel} role="dialog" aria-modal="true" aria-labelledby="{id}-t" tabindex="-1"
    style="--fr-scrim-safe:{SCRIM_MENU}" use:dialogKeys={{ close }} use:sheetRoom={tv ? 'right' : 'bottom'} transition:slide|global>
    <header>
      <h2 id="{id}-t">{$t('live.fav.orderTitle')}</h2>
      <button type="button" class="x" aria-label={$t('common.close')} title={$t('common.close')} disabled={locked} on:click={close}><Icon name="x" size={tv ? 28 : 20} /></button>
    </header>
    <p class="sr-only" aria-live="polite">{status}</p>
    <div class="body">
      <ol class="list" bind:this={list} aria-busy={own ? 'true' : undefined}>
        {#each s.ids as k, i (k)}
          {@const row = byId.get(k)}
          <li class="row" class:lifted={s.picked === k} class:follow={mode === 'pointer' && s.picked === k} data-id={k} bind:this={els[k]}>
            <button type="button" class="grip" aria-label={row?.name ?? ''} aria-pressed={s.picked === k ? 'true' : 'false'} title={$t('live.fav.orderMove')}
              disabled={locked} bind:this={handles[k]}
              on:keydown={(e) => onKey(e, k, i)} on:blur={() => onBlur(k)} on:focus={() => (focus = i)}
              on:pointerdown={(e) => onDown(e, k)}>
              <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1.5" /><circle cx="7.5" cy="2.5" r="1.5" /><circle cx="2.5" cy="8" r="1.5" /><circle cx="7.5" cy="8" r="1.5" /><circle cx="2.5" cy="13.5" r="1.5" /><circle cx="7.5" cy="13.5" r="1.5" /></svg>
            </button>
            <span class="tile frost-tile" aria-hidden="true">{#if row?.logo}<img src={row.logo} alt="" width="40" height="40" loading="lazy" decoding="async" />{/if}</span>
            <span class="num" aria-hidden="true">{row?.number ?? ''}</span>
            <span class="name">{row?.name ?? ''}</span>
            {#if tv && s.picked === k}<span class="tag" aria-hidden="true">{$t('live.fav.orderMove')}</span>{/if}
          </li>
        {/each}
      </ol>
    </div>
    {#if !tv}
      <footer>
        <Button size="sm" pending={own} disabled={locked || s.picked !== null} on:click={done}>{$t('live.fav.orderDone')}</Button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .fo-wrap { position: fixed; z-index: 90; left: 0; right: 0; top: 0; bottom: 0; }
  .fo { position: absolute; left: 0; right: 0; bottom: 0; box-sizing: border-box; display: flex; flex-direction: column; max-width: 520px; max-height: 82vh; margin: 0 auto; outline: none; color: #fff;
    border-bottom: 0; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding: 14px 18px calc(16px + var(--safe-bottom, 0px)); }
  header { flex: none; display: flex; align-items: center; gap: .5rem; margin-bottom: .4rem; }
  h2 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; }
  .x { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; display: grid; place-items: center; border-radius: 50%; background: transparent; color: #fff; }
  .x:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  /* the rows' offsetTop is measured from the list (FLIP and the pointer drag) */
  .list { position: relative; list-style: none; margin: 0; padding: 4px 0; }
  .row { position: relative; display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 6px 10px 6px 4px; border-radius: var(--fr-r-card);
    background: transparent; transition: transform 180ms var(--fr-out); }
  /* the lifted row: above the others on the solid fill with a white ring (shape, not colour alone); it switches at once */
  .row.lifted { z-index: 2; background: var(--fr-solid); box-shadow: 0 0 0 2px #fff, 0 10px 28px rgba(0, 0, 0, .45); }
  /* under the pointer the row follows it directly; the glide comes back for the drop */
  .row.follow { transition: none; }
  /* a 44 px target; touch drags the row instead of scrolling the page */
  .grip { flex: none; display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 12px; background: transparent;
    color: rgba(255, 255, 255, .78); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .grip:hover:not(:disabled) { color: #fff; }
  .grip[aria-pressed='true'] { color: #fff; cursor: grabbing; }
  .grip:disabled { cursor: default; opacity: .5; }
  .tile { flex: none; display: grid; place-items: center; width: 40px; height: 40px; overflow: hidden; border-radius: 10px; }
  .tile img { width: 32px; height: 32px; object-fit: contain; }
  .num { flex: none; min-width: 3ch; text-align: right; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; }
  .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .tag { flex: none; font-weight: 700; }
  footer { flex: none; display: flex; justify-content: flex-end; gap: .6rem; margin-top: .6rem; }

  /* TV: a solid panel on the right (1u = 1 px at a 1080p viewport), 96 px rows with text of 28 px; the focused row has the ring and scale 1.08 */
  .fo.tv { --u: calc(100vw / 1920); left: auto; right: 0; top: 0; bottom: 0; width: calc(var(--u) * 860); max-width: 100vw; max-height: none; margin: 0; border-radius: 0; background: var(--fr-solid);
    padding: calc(var(--u) * 32) calc(var(--u) * 40); }
  .tv h2 { font-size: calc(var(--u) * 40); }
  .tv .x, .tv .x:hover:not(:disabled) { width: calc(var(--u) * 64); height: calc(var(--u) * 64); min-height: 54px; padding: 0; transform: none; transition: none; }
  .tv .list { padding: calc(var(--u) * 16) calc(var(--u) * 24); }
  .tv .row { min-height: calc(var(--u) * 96); gap: calc(var(--u) * 20); padding: 0 calc(var(--u) * 20) 0 calc(var(--u) * 8); margin-bottom: calc(var(--u) * 8); font-size: calc(var(--u) * 28); transition: none; }
  .tv .row:focus-within { outline: 3px solid #fff; background: rgba(255, 255, 255, .14); transform: scale(1.08); z-index: 3; }
  .tv .row.lifted { background: var(--fr-solid); box-shadow: 0 0 0 2px #fff; }
  .tv .grip, .tv .grip:hover:not(:disabled), .tv .grip:active:not(:disabled) { width: calc(var(--u) * 64); height: calc(var(--u) * 64); min-height: 54px; padding: 0; transform: none; transition: none; }
  .tv .grip:focus-visible { outline: none; }
  .tv .tile { width: calc(var(--u) * 72); height: calc(var(--u) * 72); border-radius: 12px; }
  .tv .tile img { width: calc(var(--u) * 58); height: calc(var(--u) * 58); }
  .tv .num { font-size: calc(var(--u) * 32); }
  .tv .name { font-size: calc(var(--u) * 28); line-height: calc(var(--u) * 36); }
  .tv .tag { font-size: calc(var(--u) * 28); }

  /* calm mode, kids, TV and reduced motion: nothing moves, rows switch places at once */
  :global(html.m-still) .fo-wrap :global(*), :global(html.tv) .fo-wrap :global(*), :global(html.kids) .fo-wrap :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .fo-wrap :global(*) { transition: none !important; animation: none !important; } }
</style>
