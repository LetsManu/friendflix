<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, getContext, onDestroy, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { addToList, createList, pickerLists, removeFromList, type PickerList } from '#lib/lists';
  import { menuPlace } from '#lib/ui/menuPlace';
  import { openPopup, POPUP_CTX, type PopupHandle } from '#lib/ui/popups';
  import { t, tr } from '#lib/i18n';
  import { growBoth } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';

  /** Jellyfin id of the movie / series to add (episodes are normalised server-side). */
  export let itemId: string;
  /** compact round button (Card / modal) or the larger detail-page icon button */
  export let variant: 'round' | 'ring' | 'row' = 'ring';
  /** prefer opening the picker above the button (bottom sheet, modal); it still flips when there is no room (`.up`: the side it took) */
  export let up = false;
  /** diameter of the round variant in px */
  export let size = 34;
  /** emitted after a list was changed on the server (checkbox toggled, new list created with the item) */
  const dispatch = createEventDispatcher<{ changed: { listId: string; contains: boolean } }>();

  let open = false, lists: PickerList[] = [], err = '', creating = false, newName = '', busy = false, busyIds = new Set<string>();
  let root: HTMLElement, btn: HTMLButtonElement, pop: HTMLDivElement | undefined;
  /** one pop-up at a time; inside a ⋯ menu's slot the picker is that menu's child (the menu stays open) */
  const parentPopup = getContext<(() => PopupHandle | null) | undefined>(POPUP_CTX);
  let popup: PopupHandle | null = null;
  /**
   * the picker never opens half-loaded (menus glass spec): the lists load on the button's pointerenter / focus (lib/lists
   * pickerLists keeps them a short while); clicked before they are in, the button spins (same width, aria-busy) and the picker
   * opens once they have settled; Esc, a press elsewhere or another pop-up cancel that. A failed load opens with its error row.
   */
  let pending = false, gen = 0;
  /** a list changed while open: the kept lists are loaded anew when the picker closes */
  let dirty = false;
  /** the side the picker took (menuPlace) */
  let placedUp = up;

  const copy = (ls: PickerList[]) => ls.map((l) => ({ ...l })); // the checkboxes change their own rows, not the kept ones
  function prefetch() { pickerLists.get(itemId).catch(() => {}); }
  async function load() {
    err = '';
    try { lists = copy(await pickerLists.get(itemId, true)); } catch { err = tr('detail.lists.loadFailed'); }
  }
  async function toggleOpen() {
    if (open || pending) { close(); return; }
    popup = openPopup(() => close(), parentPopup?.() ?? null);
    creating = false; newName = '';
    const g = ++gen;
    let got = pickerLists.now(itemId);
    if (!got) {
      pending = true;
      try { got = { lists: await pickerLists.get(itemId) }; } catch { got = { failed: true }; }
      if (g !== gen) return; // closed meanwhile (Esc, a press elsewhere, another pop-up, unmounted)
      pending = false;
    }
    if ('lists' in got) { lists = copy(got.lists); err = ''; } else { lists = []; err = tr('detail.lists.loadFailed'); }
    open = true;
    await tick(); pop?.focus({ preventScroll: true });
  }
  async function toggle(l: PickerList) {
    if (busyIds.has(l.id)) return;
    dirty = true;
    const was = l.contains;
    l.contains = !was; lists = lists;
    busyIds.add(l.id); busyIds = busyIds; err = '';
    try {
      await (was ? removeFromList(l.id, itemId) : addToList(l.id, itemId));
      dispatch('changed', { listId: l.id, contains: !was });
    } catch (e: any) {
      if (!was && e?.status === 409 && e.body?.error === 'exists') { dispatch('changed', { listId: l.id, contains: true }); } // already in there
      else {
        l.contains = was; lists = lists;
        err = e?.body?.error === 'list_full' ? tr('detail.lists.full') : tr('detail.lists.failed');
      }
    }
    busyIds.delete(l.id); busyIds = busyIds;
  }
  async function create() {
    const name = newName.trim();
    if (!name || busy) return;
    busy = true; err = ''; dirty = true;
    try {
      const { id } = await createList(name);
      await addToList(id, itemId);
      newName = ''; creating = false;
      dispatch('changed', { listId: id, contains: true });
      await load();
    } catch (e: any) { err = e?.body?.error === 'too_many_lists' ? tr('detail.lists.tooMany') : tr('detail.lists.failed'); }
    busy = false;
  }
  export function close(refocus = false) {
    if (!open && !pending) return;
    open = false; pending = false; gen++;
    const p = popup; popup = null; p?.release();
    if (dirty) { dirty = false; pickerLists.get(itemId, true).catch(() => {}); }
    if (refocus) btn?.focus();
  }
  const inside = (n: EventTarget | null) => !!n && (root?.contains(n as Node) || !!pop?.contains(n as Node));
  function onKey(e: KeyboardEvent) { if ((open || pending) && e.key === 'Escape') { e.stopPropagation(); close(true); } }
  function onDoc(e: Event) { if ((open || pending) && !inside(e.target)) close(); }
  /** the picker closes when keyboard focus moves somewhere else (null = unknown, e.g. Safari clicks: the outside-pointer handler covers that) */
  function onFocusOut(e: FocusEvent) { if ((open || pending) && e.relatedTarget && !inside(e.relatedTarget)) close(); }
  /** the popover lives on <body> (cards scale and the modal clips), so it needs its own Tab trap */
  function popKey(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !pop) return;
    const f = [...pop.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])')];
    const a = document.activeElement;
    if (!f.length) { e.preventDefault(); return; }
    if (a === pop) { e.preventDefault(); (e.shiftKey ? f[f.length - 1]! : f[0]!).focus(); }
    else if (e.shiftKey && a === f[0]) { e.preventDefault(); f[f.length - 1]!.focus(); }
    else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0]!.focus(); }
  }
  /** hover cards: the picker follows the card, i.e. closes once the pointer leaves card and popover */
  function popLeave(e: MouseEvent) {
    const card = root?.closest('.card');
    if (card && !card.contains(e.relatedTarget as Node | null)) close();
  }
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
  if (typeof document !== 'undefined') { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey, true); }
  onDestroy(() => { if (typeof document !== 'undefined') { document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); } gen++; popup?.release(); popup = null; });
</script>

<span class="lm" class:blk={variant === 'row'} bind:this={root} on:focusout={onFocusOut}>
  <button bind:this={btn} class={variant === 'ring' ? 'icon-btn ring' : variant === 'row' ? 'rowbtn' : 'round'} class:on={open || pending} aria-haspopup="dialog" aria-expanded={open} aria-busy={pending || undefined} style={variant === 'round' ? `width:${size}px;height:${size}px;min-height:${size}px` : undefined} aria-label={$t('detail.lists.add')} title={$t('detail.lists.add')} on:click|stopPropagation={toggleOpen} on:pointerenter={prefetch} on:focus={prefetch}>
    <span class="lmk" class:busy={pending}><Icon name="list" size={variant === 'ring' ? 21 : 18} />{#if pending}<span class="spinner"></span>{/if}</span>{#if variant === 'row'}<span>{$t('detail.lists.addMore')}</span>{/if}
  </button>
</span>
{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="pop lm-pop gm frost frost-menu frost-safe" class:up={placedUp} bind:this={pop} use:portal use:menuPlace={{ trigger: btn, up, wide: variant === 'row', onMoved: () => close(), onSide: (u) => (placedUp = u) }} style={`--fr-scrim-safe:${SCRIM_MENU};`} transition:growBoth={{ trigger: btn }} tabindex="-1" role="dialog" aria-label={$t('detail.lists.add')} on:keydown={popKey} on:focusout={onFocusOut} on:mouseleave={popLeave}>
    {#if !lists.length && !err}<p class="muted">{$t('detail.lists.none')}</p>{/if}
    <ul>
      {#each lists as l (l.id)}
        <li><label><input type="checkbox" checked={l.contains} disabled={busyIds.has(l.id)} on:change={() => toggle(l)} /><span>{l.name}</span></label></li>
      {/each}
    </ul>
    {#if creating}
      <form on:submit|preventDefault={create}>
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" maxlength="60" placeholder={$t('detail.lists.newName')} aria-label={$t('detail.lists.newName')} bind:value={newName} autofocus />
        <button class="sec" type="submit" disabled={busy || !newName.trim()}>{$t('detail.lists.create')}</button>
      </form>
    {:else}<button class="new" type="button" on:click={() => (creating = true)}><Icon name="plus" size={16} />{$t('detail.lists.newList')}</button>{/if}
    {#if err}<p class="err" role="alert">{err}</p>{/if}
  </div>
{/if}

<style>
  .lm { position: relative; display: inline-block; }
  .blk { display: block; }
  .rowbtn { display: flex; gap: .8rem; align-items: center; justify-content: flex-start; width: 100%; min-height: 44px; padding: 0 14px; border: 0; border-radius: 12px; background: transparent; color: inherit; font: inherit; text-align: left; }
  .rowbtn:hover:not(:disabled), .rowbtn.on { background: rgba(255,255,255,.08); }
  .round { width: 34px; min-height: 34px; height: 34px; padding: 0; border-radius: 50%; background: rgba(42,42,42,.6); border: 2px solid rgba(255,255,255,.5); color: #fff; display: grid; place-items: center; }
  .round:hover:not(:disabled) { border-color: #fff; background: rgba(42,42,42,.9); }
  /* while the lists load after a click: a spinner in the icon's place (the button keeps its width) */
  .lmk { position: relative; display: inline-grid; place-items: center; flex: none; }
  .lmk.busy > :global(svg) { visibility: hidden; }
  .lmk > .spinner { position: absolute; width: 16px; height: 16px; }
  /* position: fixed on <body> (placed by menuPlace): not clipped by overflow:hidden / transformed ancestors, always inside the
     viewport. The shared glass menu card (app.css .gm: 6 px padding, 220–320 px wide; as wide as a row trigger), 44 px rows with
     12 px corners, hover = the light pill */
  .pop { position: fixed; z-index: 90; box-sizing: border-box; outline: none; text-align: left; font-size: .9rem; font-weight: 400; }
  ul { list-style: none; margin: 0 0 6px; padding: 0 0 6px; max-height: 220px; overflow: auto; border-bottom: 1px solid rgba(255,255,255,.1); }
  ul:empty { display: none; }
  label { display: flex; gap: .55rem; align-items: center; min-height: 44px; padding: 0 12px; border-radius: 12px; cursor: pointer; }
  label:hover, label:has(:focus-visible) { background: var(--fr-sel); }
  label:has(:disabled) { opacity: .6; cursor: progress; }
  .new { display: flex; gap: .4rem; align-items: center; width: 100%; background: none; border: 0; border-radius: 12px; color: inherit; padding: 0 12px; min-height: 44px; cursor: pointer; }
  .new:hover:not(:disabled) { background: var(--fr-sel); }
  form { display: flex; gap: .4rem; padding: 4px; }
  form input { flex: 1; min-width: 0; }
  /* on glass (scrim SCRIM_MENU): notes are .9 white, rows white (also on the light pill); an error is white with a red dot */
  .muted { color: rgba(255,255,255,.9); margin: 6px 12px; }
  .err { display: flex; align-items: center; gap: 8px; color: #fff; margin: 6px 12px 0; }
  .err::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--err-mark); }
  @media (pointer: coarse) {
    label input { width: 22px; height: 22px; flex: none; }
    form input, form button { min-height: 44px; }
  }
</style>
