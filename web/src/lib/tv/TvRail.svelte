<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** TV side-bar rail: 96 px icon column, expands over the content (labels fade in, nothing reflows). Keys: see rail.ts. */
  import { onMount, tick } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { initial } from '#lib/avatars';
  import { TV_RAIL, isTabActive } from '#lib/menu';
  import { focusFirst, hasTarget } from '#lib/spatial';
  import { railKey, type RailAction, type RailInput } from './rail';

  export let path: string;
  /** the open state; the layout sets it for the Back key */
  export let open = false;
  export let who = '';
  export let faceStyle: string | undefined = undefined;

  let nav: HTMLElement;
  let saved: HTMLElement | null = null; // what had the focus when the rail opened
  let skipRestore = false;
  let wasOpen = false;
  let lastOutside: HTMLElement | null = null; // the last focused element outside the rail

  function apply(key: RailInput['key'], extra: Partial<RailInput> = {}): RailAction {
    const r = railKey({ open }, { key, atLeftEdge: false, inRail: nav?.contains(document.activeElement) ?? false, onHome: path === '/', ...extra });
    open = r.state.open;
    return r.action;
  }

  async function onOpened() {
    saved = lastOutside; // tracked continuously: pointer hover may already have moved the focus into the rail
    await tick();
    if (nav.contains(document.activeElement)) return; // focus came in by itself (focusin): keep that item
    const target = nav.querySelector<HTMLElement>('a[aria-current="page"]') ?? nav.querySelector<HTMLElement>('a[href]');
    target?.focus({ preventScroll: true });
  }
  function onClosed() {
    if (skipRestore) { skipRestore = false; return; }
    const el = saved;
    saved = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
    else if (nav?.contains(document.activeElement)) focusFirst(document.querySelector('main'), false);
  }
  $: if (open !== wasOpen) { wasOpen = open; if (nav) void (open ? onOpened() : onClosed()); }

  /** the rail opens when it gets focus */
  function onFocusin() { if (!open) open = true; }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowRight' && open) { e.preventDefault(); apply('right'); }
  }
  /** OK / click on an item: the link navigates, the new page takes the focus (same page: the old element gets it back) */
  function onClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!a || !open) return;
    if (apply('ok', { inRail: true }) === 'navigate') skipRestore = new URL(a.href, location.href).pathname !== path;
  }
  function onPointer(e: PointerEvent, key: 'pointerenter' | 'pointerleave') {
    if (e.pointerType === 'touch') return;
    apply(key);
  }

  // Left at the left edge of the content (nothing further left to focus) opens the rail
  onMount(() => {
    const track = (e: FocusEvent) => { const el = e.target; if (el instanceof HTMLElement && !nav.contains(el) && el !== document.body) lastOutside = el; };
    document.addEventListener('focusin', track);
    const onNav = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (e.defaultPrevented || (e as CustomEvent).detail?.dir !== 'left' || open || !el?.closest('main') || document.querySelector('[aria-modal="true"]')) return;
      if (!hasTarget('left')) apply('left', { atLeftEdge: true, inRail: false });
    };
    document.addEventListener('ff-nav', onNav);
    return () => { document.removeEventListener('ff-nav', onNav); document.removeEventListener('focusin', track); };
  });
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<nav class="rail" class:open data-scope={open ? '' : undefined} data-nav-skip={open ? undefined : ''} bind:this={nav} aria-label={$t('tv.rail.label')}
  on:keydown={onKeydown} on:focusin={onFocusin} on:click={onClick} on:pointerenter={(e) => onPointer(e, 'pointerenter')} on:pointerleave={(e) => onPointer(e, 'pointerleave')}>
  <ul>
    {#each TV_RAIL as [href, label, icon] (href)}
      <li><a {href} aria-current={isTabActive(href, path) ? 'page' : undefined} aria-label={open ? undefined : $t(label)}><span class="ic"><Icon name={icon} size={30} /></span><span class="lb">{$t(label)}</span></a></li>
    {/each}
  </ul>
  <a class="who" href="/profiles" aria-label={$t('tv.rail.profile', { name: who })}><span class="ic"><span class="face" style={faceStyle}>{initial(who)}</span></span><span class="lb">{who}</span></a>
</nav>

<style>
  .rail { position: fixed; top: 0; bottom: 0; left: 0; width: 96px; z-index: 60; display: flex; flex-direction: column; align-items: flex-start; padding: 5vh 0 5vh 20px; box-sizing: border-box; }
  .rail.open { width: 340px; }
  /* black gradient over the content: collapsed only a faint edge for legibility, expanded much wider (opacity only) */
  .rail::before { content: ''; position: absolute; inset: 0; width: 460px; background: linear-gradient(to right, rgba(0, 0, 0, .96) 0, rgba(0, 0, 0, .9) 55%, transparent); opacity: 0; transition: opacity var(--tv-t, 220ms) var(--tv-ease, ease); pointer-events: none; z-index: -1; }
  .rail:not(.open)::before { width: 140px; opacity: .65; }
  .rail.open::before { opacity: 1; }
  ul { list-style: none; margin: auto 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  li { display: block; }
  a { position: relative; display: flex; align-items: center; height: 56px; width: 56px; overflow: hidden; border-radius: var(--tv-radius, 4px); color: #b3b3b3; text-decoration: none; transform-origin: left center; transition: transform var(--tv-t, 220ms) var(--tv-ease, ease); }
  .rail.open a { width: 280px; }
  a:hover, a:focus-visible, a[aria-current='page'] { color: #fff; }
  a:focus-visible { transform: scale(1.08); }
  .ic { flex: none; width: 56px; height: 56px; display: grid; place-items: center; }
  .lb { white-space: nowrap; font-weight: 700; font-size: 1.4rem; opacity: 0; transform: translateX(-12px); transition: opacity var(--tv-t, 220ms) var(--tv-ease, ease), transform var(--tv-t, 220ms) var(--tv-ease, ease); }
  .rail.open .lb { opacity: 1; transform: none; }
  /* active page: coral dot */
  a[aria-current='page']::after { content: ''; position: absolute; left: 3px; top: 50%; width: 7px; height: 7px; margin-top: -3.5px; border-radius: 50%; background: var(--acc, #ff6a4d); }
  .face { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 1.2rem; color: #fff; background: #444; }
</style>
