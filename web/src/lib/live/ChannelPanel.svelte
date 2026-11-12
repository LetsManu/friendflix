<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import { growBoth, scrimFade, sheetSlide, twoWay, type FxMode } from '#lib/glass/fx';
  import { t, type TKey } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import type { LiveChannel, LiveGroup } from './api';
  import GroupChips from './GroupChips.svelte';
  import type { LiveFilter } from './order';
  import type { PanelState } from './panel';
  import PanelRow from './PanelRow.svelte';

  /**
   * The *Senderliste* panel over the player (spec §12.2, ruling 51 and 59): the list's filter chips (on the current filter) and
   * compact rows (PanelRow), the focus and the scroll on the playing channel. A side panel on TV and desktop (it grows out of its
   * button, `growBoth`), a sheet on phones (`sheetSlide`); calm mode, reduced motion, TV and kids: at once, on a solid panel.
   *
   * The player owns the keys (it runs `panelKey` on its state and passes the new state in): ▲/▼ move, ◀/▶ change the chip, OK
   * switches, Back / Escape close. This component draws `state` and puts the real focus on its focused row (one focus, roving
   * tabindex). Pointer and keyboard on desktop: a modal dialog with a focus trap (Tab wraps over its tab stops: the close button, the chips, the focused row), a click outside closes,
   * a row click switches, a chip click filters. `aria-modal` scopes the shell's spatial navigation to it.
   *
   * Phase 2 turns it into the mini-guide (spec §17.7): PanelRow's `showNext` and the `foot` slot (*Programmführer*), empty now.
   */
  export let state: PanelState;
  export let groups: LiveGroup[] = [];
  export let playingId: string | null = null;
  export let now: Date;
  export let phone = false;
  export let still = false;
  /** the TV layout: big chips and rows */
  export let tv = false;
  /** the button it grows out of (desktop) */
  export let trigger: HTMLElement | null = null;

  const dispatch = createEventDispatcher<{ pick: LiveChannel; filter: LiveFilter; focusrow: number; close: void }>();
  let box: HTMLElement | undefined, rowsEl: HTMLElement | undefined;

  $: mode = (still ? 'still' : undefined) as FxMode | undefined;
  $: recent = state.filters.includes('recent');
  let empty: TKey;
  $: empty = state.filter === 'fav' ? 'live.emptyFav' : state.filter === 'recent' ? 'live.emptyRecent' : 'live.emptyGroup';
  $: void place(state, rowsEl);

  /** the real focus follows the state's row, kept in view (at once: nothing glides) */
  async function place(s: PanelState, host: HTMLElement | undefined): Promise<void> {
    await tick();
    if (!host || s !== state) return;
    // the chosen chip in view (◀/▶ on a TV walk the chips without focusing them)
    const bar = box?.querySelector<HTMLElement>('.chips'), on = bar?.querySelector<HTMLElement>('.chip.on');
    if (bar && on) {
      const b = bar.getBoundingClientRect(), c = on.getBoundingClientRect();
      if (c.left < b.left) bar.scrollLeft += c.left - b.left - 16;
      else if (c.right > b.right) bar.scrollLeft += c.right - b.right + 16;
    }
    const el = host.querySelectorAll<HTMLElement>('.prow')[s.focus];
    if (!el) { box?.focus({ preventScroll: true }); return; }
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
    if (r.top < h.top || r.bottom > h.bottom) host.scrollTop += r.top < h.top ? r.top - h.top - 8 : r.bottom - h.bottom + 8;
  }
  function onFocusIn(e: FocusEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.prow');
    if (!el || !rowsEl) return;
    const i = [...rowsEl.querySelectorAll<HTMLElement>('.prow')].indexOf(el);
    if (i >= 0 && i !== state.focus) dispatch('focusrow', i);
  }
  /** a side panel grows out of its button; a phone sheet slides up (both ways); still: at once */
  function fx(node: Element, p: { phone: boolean; trigger: HTMLElement | null; mode: FxMode | undefined }) {
    return p.phone ? twoWay((dir) => sheetSlide(node, { dir, mode: p.mode, side: 'bottom' })) : growBoth(node, { trigger: p.trigger, mode: p.mode });
  }
  const close = () => dispatch('close');
  /** the focus trap: Tab and Shift+Tab wrap over the tab stops (the rows that are not focused are tabindex -1) */
  function onTrap(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !box) return;
    const stops = [...box.querySelectorAll<HTMLElement>('button:not([disabled])')].filter((x) => x.tabIndex >= 0);
    if (!stops.length) { e.preventDefault(); return; }
    const first = stops[0], last = stops[stops.length - 1], a = document.activeElement;
    if (!box.contains(a) || (e.shiftKey ? a === first || a === box : a === last)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  }
</script>

<div class="cpdim" role="presentation" on:click={close} transition:scrimFade|global={{ mode }}></div>
<div bind:this={box} class="cpanel" class:frost={!still} class:frost-safe={!still} class:solid={still} class:phone role="dialog" aria-modal="true" aria-labelledby="lcp-title"
  tabindex="-1" transition:fx|global={{ phone, trigger, mode }} on:keydown={onTrap} on:focusin={onFocusIn}>
  <header>
    <h2 id="lcp-title">{$t('live.player.channelList')}</h2>
    <button type="button" class="x" aria-label={$t('common.close')} on:click={close}><Icon name="x" size={22} /></button>
  </header>
  <GroupChips {tv} {groups} value={state.filter} {recent} on:select={(e) => dispatch('filter', e.detail)} />
  <div class="rows" bind:this={rowsEl}>
    {#if state.rows.length}
      <ul aria-label={$t('live.player.channelList')}>
        {#each state.rows as c, i (c.id)}
          <PanelRow channel={c} focused={i === state.focus} playing={c.id === playingId} {now} on:pick={(e) => dispatch('pick', e.detail)} />
        {/each}
      </ul>
    {:else}
      <p class="empty" role="status">{$t(empty)}</p>
    {/if}
  </div>
  {#if $$slots.foot}<div class="foot"><slot name="foot" /></div>{/if}
</div>

<style>
  .cpdim { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 10; background: rgba(8, 7, 11, .45); }
  .cpanel { position: absolute; z-index: 11; top: 16px; right: 16px; bottom: 16px; width: min(440px, calc(100% - 32px)); box-sizing: border-box; display: flex; flex-direction: column;
    padding: 16px 12px 12px; border-radius: var(--fr-r-panel); color: #fff; outline: none; }
  .cpanel.solid { background: var(--fr-solid); }
  .cpanel.phone { top: auto; left: 0; right: 0; bottom: 0; width: auto; height: 82%; border-radius: var(--fr-r-sheet) var(--fr-r-sheet) 0 0; padding-bottom: calc(12px + var(--safe-bottom, 0px)); }
  header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 8px 8px; }
  h2 { margin: 0; font-size: 1.25rem; }
  .x { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; background: transparent; color: #fff; }
  .rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 8px; }
  ul { margin: 0; padding: 0; }
  .empty { margin: 12px 8px; min-height: 1.4em; color: rgba(255, 255, 255, .78); }
  .foot { flex: none; padding: 8px 8px 0; }
  /* calm mode and reduced motion (both triggers, the CastBar pattern): the panel, its dim and its buttons do not move */
  :global(html.m-still) .cpdim, :global(html.m-still) .cpanel, :global(html.m-still) .cpanel :global(*), :global(html.m-still) .cpanel :global(*::before) { transition: none !important; animation: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .cpdim, .cpanel, .cpanel :global(*), .cpanel :global(*::before) { transition: none !important; animation: none !important; }
  }
  /* TV: a solid side panel of 760 u with 28 u text; the rows have room for the 1.08 scale and the ring */
  :global(html.tv) .cpanel { --u: calc(100vw / 1920); top: calc(var(--u) * 40); right: calc(var(--u) * 40); bottom: calc(var(--u) * 40); width: calc(var(--u) * 760);
    padding: calc(var(--u) * 28) calc(var(--u) * 20) calc(var(--u) * 20); font-size: calc(var(--u) * 28); }
  :global(html.tv) .cpanel h2 { font-size: calc(var(--u) * 36); }
  :global(html.tv) .cpanel .rows { padding: calc(var(--u) * 12) calc(var(--u) * 40); }
  :global(html.tv) .cpanel .empty { font-size: calc(var(--u) * 28); }
</style>
