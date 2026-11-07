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

  $: cur = TV_RAIL.findIndex(([href]) => isTabActive(href, path));

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
  /**
   * the focus left the open rail by other means than its keys (a phone-remote command, a page that focuses itself): close it.
   * A null relatedTarget (focus going nowhere, e.g. a link being removed) or a move inside the rail keeps it open.
   */
  function onFocusout(e: FocusEvent) {
    const to = e.relatedTarget;
    if (!open || !(to instanceof Node) || nav.contains(to)) return;
    skipRestore = true; // the focus is already where it should be
    open = false;
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowRight' && open) { e.preventDefault(); apply('right'); }
  }
  /** OK / click on an item: the link navigates, the new page takes the focus (same page: the old element gets it back) */
  function onClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!a || !open) return;
    if (apply('ok', { inRail: true }) === 'navigate') skipRestore = new URL(a.href, location.href).pathname !== path;
  }
  /**
   * Opens on a real pointer move over the rail, not on pointerenter: Chromium also sends boundary events (no movement) when the
   * page under a resting pointer changes, e.g. a pointer parked at the screen's left edge while a page loads. Those must not open
   * the rail over the content (it would cover the page's buttons and stay open until the pointer leaves).
   */
  function onPointerMove(e: PointerEvent) {
    if (open || e.pointerType === 'touch' || (!e.movementX && !e.movementY)) return;
    apply('pointerenter');
  }
  function onPointerLeave(e: PointerEvent) {
    if (e.pointerType === 'touch') return;
    apply('pointerleave');
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
  on:keydown={onKeydown} on:focusin={onFocusin} on:focusout={onFocusout} on:click={onClick} on:pointermove={onPointerMove} on:pointerleave={onPointerLeave}>
  <ul>
    {#each TV_RAIL as [href, label, icon], i (href)}
      <li class:cur={isTabActive(href, path)} style="--i:{i};--ri:{TV_RAIL.length - 1 - i}"><a {href} aria-current={isTabActive(href, path) ? 'page' : undefined} aria-label={open ? undefined : $t(label)}><span class="ic"><Icon name={icon} size={26} /></span><span class="lb">{$t(label)}</span></a></li>
    {/each}
    <!-- the active page's coral dot: one element that springs to the current item when the page changes (transform only) -->
    <li class="dot" class:on={cur >= 0} style="transform: translate3d(0, {Math.max(0, cur) * 66}px, 0)" aria-hidden="true"></li>
  </ul>
  <a class="acct" href="/me" aria-current={path === '/me' || path.startsWith('/me/') ? 'page' : undefined} aria-label={open ? undefined : $t('tv.rail.account')}><span class="ic"><Icon name="user" size={26} /></span><span class="lb">{$t('tv.rail.account')}</span></a>
  <a class="who" href="/profiles" aria-label={$t('tv.rail.profile', { name: who })}><span class="ic"><span class="face" style={faceStyle}>{initial(who)}</span></span><span class="lb">{who}</span></a>
</nav>

<style>
  .rail { position: fixed; top: 0; bottom: 0; left: 0; width: 96px; z-index: 60; display: flex; flex-direction: column; align-items: flex-start; padding: 5vh 0 5vh 20px; box-sizing: border-box; }
  .rail.open { width: 340px; }
  /* black gradient over the content: collapsed only a faint edge for legibility, expanded much wider (opacity only); no hard stop */
  /* expand (spec 5.2): the gradient fades in over 200 ms; collapse is the reverse at ~70 % (opacity only) */
  .rail::before { content: ''; position: absolute; inset: 0; width: 460px; background: linear-gradient(to right, rgba(0, 0, 0, .96) 0, rgba(0, 0, 0, .88) 50%, rgba(0, 0, 0, .5) 75%, rgba(0, 0, 0, 0)); opacity: 0; transition: opacity calc(var(--tv-d-s, 200ms) * .7) var(--tv-emph-in, ease); pointer-events: none; z-index: -1; }
  .rail:not(.open)::before { width: 96px; opacity: .65; }
  .rail.open::before { opacity: 1; transition: opacity var(--tv-d-s, 200ms) var(--tv-emph-out, ease); }
  ul { list-style: none; margin: auto 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  li { display: block; position: relative; }
  a { position: relative; display: flex; align-items: center; height: 56px; width: 56px; overflow: hidden; border-radius: var(--tv-radius, 6px); color: rgba(255, 255, 255, .55); text-decoration: none; transform-origin: left center; transition: transform calc(var(--tv-d-spring, 420ms) * .7) var(--tv-emph-out, ease); }
  .rail.open a { width: 280px; }
  a:hover, a:focus-visible, a[aria-current='page'] { color: #fff; }
  a:focus-visible { transform: scale(1.08); transition: transform var(--tv-d-spring, 420ms) var(--tv-spring, ease); }
  .ic { flex: none; width: 56px; height: 56px; display: grid; place-items: center; }
  .ic :global(svg) { stroke-width: 1.75; }
  /* labels slide in from -12 px with a 30 ms stagger top to bottom; they leave bottom to top, faster (70 %) */
  .lb { white-space: nowrap; font-weight: 500; font-size: 1.375rem; opacity: 0; transform: translate3d(-12px, 0, 0); transition: opacity calc(var(--tv-d-s, 200ms) * .7) var(--tv-emph-in, ease) calc(var(--ri, 0) * 21ms), transform calc(var(--tv-d-s, 200ms) * .7) var(--tv-emph-in, ease) calc(var(--ri, 0) * 21ms); }
  .rail.open .lb { opacity: 1; transform: none; transition: opacity var(--tv-d-m, 320ms) var(--tv-emph-out, ease) calc(var(--i, 0) * 30ms), transform var(--tv-d-m, 320ms) var(--tv-emph-out, ease) calc(var(--i, 0) * 30ms); }
  .acct { margin-bottom: 10px; }
  .acct .lb { --i: 5; --ri: 1; }
  .who .lb { --i: 6; --ri: 0; }
  :global(html.tv-motion-reduced) .lb { transition-delay: 0s !important; transform: none; }
  /* active page: 6 px coral dot, centred 14 px left of the 26 px icon (the icon starts 15 px into its 56 px cell); on the li so the link's clipping does not cut it */
  ul { position: relative; }
  .dot { position: absolute; left: -2px; top: 25px; width: 6px; height: 6px; border-radius: 50%; background: var(--acc, #ff4f6d); pointer-events: none; opacity: 0; transition: transform var(--tv-d-spring, 420ms) var(--tv-spring, ease), opacity var(--tv-d-xs, 120ms) ease; }
  .dot.on { opacity: 1; }
  .face { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 600; font-size: 1.125rem; color: #fff; background: #444; }
</style>
