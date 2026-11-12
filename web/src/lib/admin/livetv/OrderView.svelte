<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Live-TV → Kanäle → *Reihenfolge* (live TV spec §9.2; Task 25 reuses it for the groups): one group or one source, ≤ 500 rows,
   * each with a drag handle. The order itself is `#lib/ui/dragOrder` (pure, shared with the favourites on TVs, Task 38).
   *   <OrderView {rows} save={(ids) => api('/api/admin/livetv/channels/order', { method: 'PUT', body: { ids } })} />
   * The view knows no endpoint: *Speichern* calls `save(ids)` with the new order through `runAction` (busy, toast, error).
   *
   * Pointer and touch: the handle lifts the row, which follows the pointer by `transform` only; the others slide aside by FLIP
   * (their old place as a `transform`, gliding to 0). Near the edge of the scroll area the list scrolls along.
   * Keyboard: focus the handle, Space picks up, ↑/↓ move, Space drops, Escape cancels; every step is announced in a polite
   * live region (`adminLive.ch.order*`). The numbers shown are the ones *Speichern* gives (`renumber`: from the smallest
   * number of the set, ascending); groups pass `number: null` and show none.
   * Calm mode / reduced motion / TV (`html.m-still`, `fxMode() === 'still'`): no transitions, rows switch places at once.
   * The bar above the list is always there (its buttons are disabled while nothing changed), so nothing moves when it enables.
   */
  import { tick } from 'svelte';
  import { t, tr } from '#lib/i18n';
  import { fxMode } from '#lib/glass/fx';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { uid } from '#lib/ui/ids';
  import { cancel, drop, flipOffsets, idle, insertAt, move, moveTo, pick, renumber, type DragState } from '#lib/ui/dragOrder';

  interface OrderRow { id: string; name: string; number: number | null; logoHash: string | null }
  export let rows: OrderRow[];
  /** stores the new order (required); the caller picks the endpoint */
  export let save: (ids: string[]) => Promise<void>;

  const busyKey = uid('order');
  let s: DragState = idle([]);
  /** the stored order (the rows as given, then the last saved order) */
  let base: string[] = [];
  let byId = new Map<string, OrderRow>();
  let numbers = new Map<string, number | null>();
  let hasNumbers = false;
  /** how the lifted row is moved: by the keyboard or by a pointer */
  let mode: 'key' | 'pointer' | null = null;
  /** the polite announcement */
  let status = '';

  $: reset(rows);
  function reset(r: OrderRow[]) {
    endPointer();
    byId = new Map(r.map((x) => [x.id, x]));
    numbers = new Map(r.map((x) => [x.id, x.number]));
    hasNumbers = r.some((x) => x.number !== null);
    base = r.map((x) => x.id);
    s = idle(base);
    mode = null;
  }

  $: shown = renumber(s.ids, numbers);
  $: dirty = s.ids.join('\n') !== base.join('\n');
  $: busy = $busyKeys.has(busyKey);

  let list: HTMLOListElement;
  const els: Record<string, HTMLLIElement> = {};
  const handles: Record<string, HTMLButtonElement> = {};

  /** calm mode, reduced motion, TV: places switch at once */
  const still = (): boolean => {
    const c = document.documentElement.classList;
    return fxMode() === 'still' || c.contains('m-still') || c.contains('tv');
  };
  const nameOf = (id: string): string => byId.get(id)?.name ?? '';
  const posOf = (st: DragState, id: string): number => st.ids.indexOf(id) + 1;
  /** a repeated text differs by a no-break space, so the live region announces it again */
  function say(text: string) { status = status === text ? `${text} ` : text; }

  /**
   * Apply a new order. FLIP: each row's place on screen before (with any glide still running), its new layout place after
   * the update (`offsetTop`, which no transform changes), the difference as a `transform` without transition, then back to 0
   * with the row's transition. `skip`: the row the pointer holds (it follows the pointer instead).
   */
  async function reorder(next: DragState, skip: string | null): Promise<boolean> {
    if (next === s) return false;
    const animate = !still();
    const before = new Map<string, number>();
    if (animate) for (const id of s.ids) if (id !== skip && els[id]) before.set(id, els[id]!.getBoundingClientRect().top);
    s = next;
    await tick();
    if (!animate || !list) return true;
    const top = list.getBoundingClientRect().top + list.clientTop;
    const after = new Map<string, number>();
    before.forEach((_v, id) => { const el = els[id]; if (el) after.set(id, top + el.offsetTop); });
    const off = flipOffsets(before, after);
    off.forEach((d, id) => { const el = els[id]!; el.style.transition = 'none'; el.style.transform = `translateY(${d}px)`; });
    if (off.size) void list.offsetHeight; // the start places are committed before the glide begins
    off.forEach((_d, id) => { const el = els[id]!; el.style.transition = ''; el.style.transform = ''; });
    return true;
  }

  // ---- keyboard: Space picks up / drops, ↑/↓ move, Escape cancels (the handle keeps focus while its row moves)
  /** the row whose handle is being refocused after a move (its blur is not a cancel) */
  let keep: string | null = null;
  async function refocus(id: string) {
    const h = handles[id];
    if (h) { h.focus({ preventScroll: true }); els[id]?.scrollIntoView({ block: 'nearest' }); }
    keep = null;
  }
  async function onKey(e: KeyboardEvent, id: string) {
    if (busy || mode === 'pointer') return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (s.picked === null) {
        s = pick(s, id);
        mode = 'key';
        say(tr('adminLive.ch.orderPicked', { name: nameOf(id), n: posOf(s, id), m: s.ids.length }));
      } else if (s.picked === id) {
        const n = posOf(s, id);
        s = drop(s);
        mode = null;
        say(tr('adminLive.ch.orderDropped', { name: nameOf(id), n }));
      }
      return;
    }
    if (s.picked !== id) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Up' || e.key === 'Down') {
      e.preventDefault();
      const next = move(s, e.key === 'ArrowUp' || e.key === 'Up' ? -1 : 1);
      if (next === s) return;
      keep = id;
      await reorder(next, null);
      await refocus(id);
      say(tr('adminLive.ch.orderMoved', { n: posOf(s, id), m: s.ids.length }));
    } else if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation(); // a sheet or dialog around the view stays open
      await cancelMove(id);
    }
  }
  async function cancelMove(id: string) {
    keep = id;
    mode = null;
    await reorder(cancel(s), null);
    await refocus(id);
    say(tr('adminLive.ch.orderCancelled'));
  }
  /** focus left the handle of a lifted row (Tab, a click elsewhere): the move is cancelled, nothing changes unseen */
  function onBlur(id: string) {
    if (keep === null && mode === 'key' && s.picked === id) {
      mode = null;
      void reorder(cancel(s), null).then(() => say(tr('adminLive.ch.orderCancelled')));
    }
  }

  // ---- pointer and touch: the row follows the pointer by transform, the others slide by FLIP; the list scrolls at its edges
  interface Drag { id: string; grab: number; y: number; raf: number; scroller: HTMLElement | null }
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
  function onDown(e: PointerEvent, id: string) {
    if (busy || s.picked !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const row = els[id];
    if (!row) return;
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    drag = { id, grab: e.clientY - row.getBoundingClientRect().top, y: e.clientY, raf: 0, scroller: scrollerOf(list) };
    s = pick(s, id);
    mode = 'pointer';
    say(tr('adminLive.ch.orderPicked', { name: nameOf(id), n: posOf(s, id), m: s.ids.length }));
    schedule();
  }
  function onMove(e: PointerEvent) {
    if (!drag) return;
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
    for (const id of s.ids) {
      const el = els[id];
      if (!el) continue;
      lo = Math.min(lo, el.offsetTop);
      hi = Math.max(hi, el.offsetTop + el.offsetHeight);
      if (id !== d.id) mids.push(el.offsetTop + el.offsetHeight / 2);
    }
    const y = Math.min(hi - row.offsetHeight, Math.max(lo, d.y - top - d.grab));
    const to = insertAt(mids, y + row.offsetHeight / 2);
    if (to !== s.ids.indexOf(d.id) && (await reorder(moveTo(s, to), d.id)) && drag === d) {
      say(tr('adminLive.ch.orderMoved', { n: posOf(s, d.id), m: s.ids.length }));
    }
    if (drag !== d) return;
    row.style.transform = `translateY(${y - row.offsetTop}px)`;
  }
  /** pointer up: the row glides from under the pointer into its place */
  async function onUp() {
    const d = endPointer();
    if (!d) return;
    const n = posOf(s, d.id);
    s = drop(s);
    mode = null;
    await tick(); // the row's own transition is back before its transform is released
    const row = els[d.id];
    if (row) row.style.transform = '';
    say(tr('adminLive.ch.orderDropped', { name: nameOf(d.id), n }));
  }
  /** pointer cancelled (the system took it, or Escape while dragging): the row goes back where it was picked up */
  async function onCancel() {
    const d = endPointer();
    if (!d) return;
    mode = null;
    await tick();
    await reorder(cancel(s), null);
    const row = els[d.id];
    if (row) row.style.transform = '';
    say(tr('adminLive.ch.orderCancelled'));
  }
  function endPointer(): Drag | null {
    const d = drag;
    if (!d) return null;
    if (d.raf) cancelAnimationFrame(d.raf);
    drag = null;
    return d;
  }
  function onWindowKey(e: KeyboardEvent) {
    if (drag && (e.key === 'Escape' || e.key === 'Esc')) { e.preventDefault(); e.stopPropagation(); void onCancel(); }
  }

  // ---- the bar: Verwerfen goes back to the stored order, Speichern stores the shown one
  async function discard() {
    if (busy || s.picked !== null) return;
    await reorder(idle(base), null);
  }
  async function commit() {
    if (busy || s.picked !== null || !dirty) return;
    const ids = s.ids.slice();
    const res = await runAction({ key: busyKey, run: () => save(ids), success: tr('common.saved'), error: tr('adminPeople.roles.orderFailed') });
    if (res.ok) base = ids;
  }
</script>

<svelte:window on:keydown|capture={onWindowKey} />

<div class="order">
  <p class="sr-only" aria-live="polite">{status}</p>
  <div class="bar">
    <Button variant="ghost" size="sm" disabled={!dirty || busy || s.picked !== null} on:click={discard}>{$t('adminPeople.roles.discard')}</Button>
    <Button size="sm" pending={busy} disabled={!dirty || s.picked !== null} on:click={commit}>{$t('common.save')}</Button>
  </div>
  <ol class="list panel" bind:this={list} aria-busy={busy ? 'true' : undefined}>
    {#each shown as r (r.id)}
      {@const row = byId.get(r.id)}
      <li class="row" class:lifted={s.picked === r.id} class:follow={mode === 'pointer' && s.picked === r.id} data-id={r.id} bind:this={els[r.id]}>
        <button type="button" class="grip" aria-label={row?.name ?? ''} aria-pressed={s.picked === r.id ? 'true' : 'false'} title={$t('adminPeople.roles.dragHandle')}
          disabled={busy} bind:this={handles[r.id]}
          on:keydown={(e) => onKey(e, r.id)} on:blur={() => onBlur(r.id)}
          on:pointerdown={(e) => onDown(e, r.id)} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onCancel} on:lostpointercapture={onCancel}>
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1.5" /><circle cx="7.5" cy="2.5" r="1.5" /><circle cx="2.5" cy="8" r="1.5" /><circle cx="7.5" cy="8" r="1.5" /><circle cx="2.5" cy="13.5" r="1.5" /><circle cx="7.5" cy="13.5" r="1.5" /></svg>
        </button>
        {#if row?.logoHash}
          <span class="tile frost-tile" aria-hidden="true"><img src="/api/livetv/logos/{encodeURIComponent(row.logoHash)}" alt="" width="40" height="40" loading="lazy" decoding="async" /></span>
        {:else if hasNumbers}
          <span class="tile frost-tile fb" aria-hidden="true">{r.number}</span>
        {/if}
        {#if hasNumbers}<span class="num">{r.number}</span>{/if}
        <span class="name">{row?.name ?? ''}</span>
      </li>
    {/each}
  </ol>
</div>

<style>
  .order { display: flex; flex-direction: column; gap: .75rem; }
  .bar { display: flex; justify-content: flex-end; gap: .5rem; }
  /* the rows' offsetTop is measured from the list (FLIP and the pointer drag) */
  .list { position: relative; list-style: none; margin: 0; padding: 8px; }
  .row { position: relative; display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 6px 10px 6px 4px; border-radius: var(--fr-r-card);
    background: transparent; transition: transform 180ms var(--fr-out); }
  /* the lifted row: above the others on the solid fill with a white ring (shape, not colour alone); it switches at once */
  .row.lifted { z-index: 2; background: var(--fr-solid); box-shadow: 0 0 0 2px #fff, 0 10px 28px rgba(0, 0, 0, .45); }
  /* under the pointer the row follows it directly; the glide comes back for the drop */
  .row.follow { transition: none; }
  /* a 44 px target; touch drags the row instead of scrolling the page */
  .grip { flex: none; display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 12px; background: transparent;
    color: var(--mut); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .grip:hover:not(:disabled) { color: var(--fg); }
  .grip[aria-pressed='true'] { color: #fff; cursor: grabbing; }
  .grip:disabled { cursor: default; opacity: .5; }
  .tile { flex: none; display: grid; place-items: center; width: 40px; height: 40px; overflow: hidden; border-radius: 10px; }
  .tile img { width: 40px; height: 40px; object-fit: contain; }
  .tile.fb { font-weight: 800; font-size: .9rem; font-variant-numeric: tabular-nums; }
  .num { flex: none; min-width: 3ch; text-align: right; color: var(--mut); font-variant-numeric: tabular-nums; }
  .name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  :global(html.tv) .grip { width: 54px; height: 54px; }
  /* calm mode, TV and reduced motion: rows switch places at once */
  :global(html.m-still) .order :global(*), :global(html.tv) .order :global(*) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) { .order :global(*) { transition: none !important; animation: none !important; } }
</style>
