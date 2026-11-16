<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The desktop pop-up of `Select` (a select-only combobox, WAI-ARIA listbox pattern): the shared glass menu card (app.css `.gm*`)
   * with one 44 px row per option, the current one checked. The native <select> stays the control; this list only shows its
   * options and reports a pick (`pick`) or a dismissal (`close`); the owner unmounts it.
   * It lives on <body> (dialogs clip, cards transform), above the dialog layers, at least as wide as the select and lined up
   * with its start edge (menuPlace: inside the window, opens upward near the bottom, keeps its side while open). It takes the
   * focus and moves `aria-activedescendant`: ArrowUp / ArrowDown / Home / End / PageUp / PageDown move (no wrap, disabled options skipped), Enter or
   * Space picks, letters jump to the next matching option (500 ms typeahead buffer). Escape closes it and gives the focus back to
   * the select (it never reaches a dialog around the select); Tab closes it without picking and moves on from the select (a dialog's
   * Tab trap still applies). An outside
   * press, a scroll that moves the select and another pop-up opening (lib/ui/popups) close it.
   *   <GlassListbox anchor={sel} {options} {value} labelledby="{id}-l" on:pick={(e) => choose(e.detail)} on:close={hide} />
   */
  import { createEventDispatcher, getContext, onDestroy, onMount, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { growBoth } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import { uid } from './ids';
  import { nextEnabled, pageMove, typeahead, type ListOpt } from './listbox';
  import { menuMove } from './menuKeys';
  import { menuPlace } from './menuPlace';
  import { openPopup, POPUP_CTX, type PopupHandle } from './popups';

  export let anchor: HTMLSelectElement;
  export let options: ListOpt[] = [];
  export let value: string;
  export let labelledby: string;
  /** the listbox element's id (the select's aria-controls) */
  export let id = uid('lb');

  const dispatch = createEventDispatcher<{ pick: string; close: void }>();
  const TYPEAHEAD_MS = 500;

  let box: HTMLDivElement;
  /** the active option, by value: it stays the same option when the options change under the open list */
  let activeVal: string | null = startVal();
  /** the last move came from the keyboard: the active row shows the focus ring (the pointer only lights it) */
  let kb = false;
  let buffer = '', bufferT: ReturnType<typeof setTimeout> | undefined;

  /** the select's current option, if it can be picked */
  function startVal(opts: readonly ListOpt[] = options, v: string = value): string | null {
    const o = opts.find((x) => x.value === v);
    return o && !o.disabled ? o.value : null;
  }
  /** the active option's index: when it went away or became disabled, the current value's (or none) */
  function indexOf(av: string | null, opts: readonly ListOpt[], v: string): number {
    const i = av === null ? -1 : opts.findIndex((o) => o.value === av);
    if (i >= 0 && !opts[i]!.disabled) return i;
    const s = startVal(opts, v);
    return s === null ? -1 : opts.findIndex((o) => o.value === s);
  }
  // the value changed from elsewhere while open: the active option follows it
  let seenValue = value;
  $: if (value !== seenValue) { seenValue = value; activeVal = startVal(options, value); }
  $: active = indexOf(activeVal, options, value);

  const parentPopup = getContext<(() => PopupHandle | null) | undefined>(POPUP_CTX);
  let popup: PopupHandle | null = openPopup(() => { popup = null; dispatch('close'); }, parentPopup?.() ?? null);

  const rowId = (i: number) => `${id}-o${i}`;
  function done() { const p = popup; popup = null; p?.release(); }
  function close(refocus: boolean) {
    if (!popup) return; // already closing
    done();
    dispatch('close');
    if (refocus) anchor?.focus({ preventScroll: true });
  }
  function pick(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    done();
    dispatch('pick', o.value);
  }

  /** keeps the active row inside the list's own scroll box (never scrolls the page: that would close the list) */
  async function reveal() {
    await tick();
    const row = active >= 0 ? box?.querySelector<HTMLElement>(`#${CSS.escape(rowId(active))}`) : null;
    if (!row || !box) return;
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top - 6;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 6;
  }
  function moveTo(i: number) {
    if (i < 0) return;
    activeVal = options[i]!.value;
    void reveal();
  }

  function type(ch: string) {
    clearTimeout(bufferT);
    buffer += ch;
    bufferT = setTimeout(() => (buffer = ''), TYPEAHEAD_MS);
    // "abc" refines from the current option; "aaa" (one letter again) steps through the options starting with it
    const same = [...buffer].every((c) => c.toLocaleLowerCase() === buffer[0]!.toLocaleLowerCase());
    let i = typeahead(options, buffer, buffer.length > 1 ? active - 1 : active);
    if (i < 0 && same) i = typeahead(options, buffer[0]!, active);
    moveTo(i);
  }

  function onKey(e: KeyboardEvent) {
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (k === 'Tab') {
      // the list lives on <body>: a dialog's Tab trap (dialogKeys, on the dialog) would never see this key. Close, focus the select
      // and send the key again from there, so the trap runs as if the select had it; when the trap moved the focus itself, the
      // browser's own Tab must not move it again (otherwise it moves on from the select, as usual)
      close(true);
      const again = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: e.shiftKey, bubbles: true, cancelable: true });
      anchor.dispatchEvent(again);
      if (again.defaultPrevented) e.preventDefault();
      return;
    }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); if (active >= 0) pick(active); else close(true); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const move = menuMove(k);
    if (move) { e.preventDefault(); kb = true; moveTo(nextEnabled(options, active, move)); return; }
    if (k === 'PageDown' || k === 'PageUp') { // a page less one row; neither the list nor the page scrolls by itself
      e.preventDefault();
      kb = true;
      moveTo(pageMove(options, active, k === 'PageDown' ? 'next' : 'prev', Math.floor(box.clientHeight / 44) - 1));
      return;
    }
    if (k === 'Enter' || (k === ' ' && !buffer)) { e.preventDefault(); if (active >= 0) pick(active); return; }
    if (k.length === 1 || (k === ' ' && buffer)) { e.preventDefault(); kb = true; type(k); }
  }
  function onFocusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (popup && to && to !== anchor && !box.contains(to)) close(false);
  }
  function onDoc(e: Event) {
    const t = e.target as Node | null;
    if (popup && t && !box?.contains(t) && t !== anchor) close(false); // a press on the select toggles it there
  }
  function hover(i: number) {
    kb = false;
    if (options[i] && !options[i]!.disabled) activeVal = options[i]!.value;
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }

  onMount(() => {
    document.addEventListener('pointerdown', onDoc, true);
    box?.focus({ preventScroll: true });
    if (active >= 0) {
      const row = box.querySelector<HTMLElement>(`#${CSS.escape(rowId(active))}`);
      if (row && row.offsetTop + row.offsetHeight > box.clientHeight) box.scrollTop = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2;
    }
  });
  onDestroy(() => {
    if (typeof document !== 'undefined') document.removeEventListener('pointerdown', onDoc, true);
    clearTimeout(bufferT);
    done();
  });
</script>

<!-- the keys are on the listbox (aria-activedescendant); a press inside keeps the focus there (mousedown default prevented) -->
<div
  class="lb gm frost frost-menu frost-safe" class:kb {id} role="listbox" tabindex="-1" aria-labelledby={labelledby}
  aria-activedescendant={active >= 0 ? rowId(active) : undefined} bind:this={box}
  use:portal use:menuPlace={{ trigger: anchor, wide: true, align: 'start', onMoved: () => close(false) }}
  style={`--fr-scrim-safe:${SCRIM_MENU};`} transition:growBoth={{ trigger: anchor }}
  on:keydown={onKey} on:focusout={onFocusOut} on:mousedown={(e) => e.preventDefault()}
>
  {#each options as o, i (o.value)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus (options are never focused: the listbox moves aria-activedescendant) -->
    <div
      class="gm-row" class:active={i === active} id={rowId(i)} role="option" data-value={o.value}
      aria-selected={o.value === value ? 'true' : 'false'} aria-disabled={o.disabled ? 'true' : undefined}
      on:mousemove={() => hover(i)} on:click={() => pick(i)}
    ><span class="gm-ic">{#if o.value === value}<Icon name="check" size={18} />{/if}</span><span class="gm-lbl">{o.label}</span></div>
  {/each}
</div>

<style>
  /* above every dialog layer (ModalShell 100, the confirm and time-span dialogs 130): a select inside a dialog opens over it */
  .lb { position: fixed; z-index: 140; box-sizing: border-box; outline: none; text-align: left; }
  .gm-row { grid-template-columns: 24px minmax(0, 1fr); cursor: default; user-select: none; }
  /* the active option: the light pill; from the keyboard also the white ring inside the row (the .gm-row:focus-visible look) */
  .gm-row.active { background: var(--fr-sel); }
  .kb .gm-row.active { outline: 2px solid #fff; outline-offset: -2px; }
  .gm-row[aria-disabled='true'] { opacity: .5; }
  .gm-row[aria-disabled='true']:hover { background: transparent; }
</style>
