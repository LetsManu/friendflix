<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Desktop top bar (spec desktop browse §1): logo left, a floating pill with the tabs and Categories in the middle, search /
   * bell / avatar on the right. No full-width band: over the billboard nothing sits behind it, once scrolled the pill and the
   * round buttons turn opaque. The active tab's fill slides to a newly chosen tab (springs from lib/tv/motion).
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import { api, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import { avatarBg, initial } from '#lib/avatars';
  import { HEADER_TABS, isTabActive } from '#lib/menu';
  import { categoryHref, kindFromPath, type Kind } from '#lib/mobile';
  import { langLabel } from '#lib/langs';
  import { logout as doLogout } from '#lib/session';
  import { changeServerViaHome } from '#lib/webos/home';
  import { toast } from '#lib/ui/toast';
  import { prefs } from '#lib/stores';
  import { t } from '#lib/i18n';
  import { animateTo, motionLevel } from '#lib/tv/motion';
  import { pillSolid } from './bar';

  export let path: string;
  /** a page that starts with a billboard: the pill stays see-through at the very top */
  export let heroPage = false;
  export let me: Me | null = null;
  export let who = '';
  export let faceStyle: string | undefined = undefined;
  export let multi = false;
  export let admin = false;
  export let canDownload = false;
  export let lgApp = false;
  /** the current page with its query (where a profile switch comes back to) */
  export let here = '/';
  export let notes: Array<{ id: number; title: string; link?: string; read: boolean }> = [];
  export let onHelp: () => void = () => {};

  const page = pageStore();
  $: unread = notes.filter((n) => !n.read).length;

  // ---- solid pill once scrolled (24 px) or on pages without a billboard ----
  let scrollY = 0;
  $: solid = pillSolid(scrollY, heroPage);
  /** backdrop blur only with the full motion set (calm mode, reduced motion or a slow device: none) */
  const fullMotion = (_calm: unknown) => motionLevel() === 'full'; // re-read when the prefs (calm mode) arrive
  $: blur = fullMotion($prefs);

  // ---- dropdowns: categories, notifications, account ----
  let menu = false, bell = false, cats = false;
  $: if (path) { menu = false; bell = false; cats = false; }
  let catKind: Kind = 'movies', catGenres: string[] | null = null, catLangs: string[] | null = null;
  async function toggleCats() {
    cats = !cats; menu = false; bell = false;
    if (!cats) return;
    catKind = kindFromPath(path);
    if (!catGenres) { try { catGenres = ((await api('/api/library/genres')).genres as string[]) ?? []; } catch { catGenres = []; } }
    if (!catLangs) { try { catLangs = (((await api('/api/library/languages')).audio ?? []) as Array<{ code: string }>).map((l) => l.code).slice(0, 12); } catch { catLangs = []; } }
  }
  let notesTimer: ReturnType<typeof setTimeout> | undefined;
  async function toggleBell() {
    bell = !bell; menu = false; cats = false;
    if (bell && unread) {
      await api('/api/notifications/read', { method: 'POST' });
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => window.dispatchEvent(new Event('ff-notes')), 1500); // the layout reloads the list (shared with the phone header)
    }
  }
  let others: Array<{ id: string; name: string; avatar: string; hasPin: boolean }> | null = null;
  async function toggleMenu() {
    menu = !menu; bell = false; cats = false;
    if (menu && multi && others === null) {
      try { others = ((await api('/api/profiles')).profiles as Array<{ id: string; name: string; avatar: string; hasPin: boolean; active: boolean }>).filter((p) => !p.active && p.id !== me?.profile?.id).slice(0, 4); }
      catch { others = []; }
    }
  }
  const switchHref = (id: string) => `/profiles?pick=${encodeURIComponent(id)}&next=${encodeURIComponent(here)}`;
  const logout = () => doLogout(me?.tv);
  function changeServer() {
    menu = false;
    changeServerViaHome(() => toast.info($t('shell.account.changeServerBlue'))); // the hint when the start page cannot be reached
  }
  async function surprise() {
    menu = false;
    try { void goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { void goto('/browse/movies'); }
  }
  function openHelp() { menu = false; onHelp(); }

  let root: HTMLElement;
  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !(menu || bell || cats)) return;
    // the focus was inside the open dropdown: back to the button that opened it
    const anchor = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.pop-anchor');
    menu = bell = cats = false;
    if (anchor && root?.contains(anchor)) anchor.querySelector<HTMLElement>(':scope > button')?.focus();
  }
  function onWindowClick(e: MouseEvent) {
    if (!(e.target as HTMLElement | null)?.closest?.('.pop-anchor')) { menu = false; bell = false; cats = false; }
  }

  // ---- the active tab's fill: sprung to the active tab, its width gliding along (instant under reduced motion) ----
  // Transform only: the fill moves as a whole (translate); inside it the right cap springs to the new width and the middle
  // part scales on X. The fill's opacity is on the group, so the overlapping white parts never add up.
  let pill: HTMLElement, fill: HTMLElement, mid: HTMLElement, capR: HTMLElement;
  let fillOn = false;
  const CAP = 36, MID = 100; // cap diameter (the tab height); the middle part's unscaled width
  async function placeFill(slide: boolean) {
    await tick();
    const a = pill?.querySelector<HTMLElement>(':scope > a[aria-current="page"]');
    if (!a || !fill || !mid || !capR) { fillOn = false; return; }
    const instant = !slide || !fillOn || motionLevel() === 'reduced'; // first placement or back from a page without a tab: no slide
    const w = Math.max(CAP, a.offsetWidth);
    mid.style.transition = instant ? 'none' : '';
    mid.style.transform = `scaleX(${+((w - CAP) / MID).toFixed(4)})`;
    animateTo(fill, 'x', a.offsetLeft);
    animateTo(capR, 'x', w - CAP);
    if (instant) fill.getAnimations?.({ subtree: true }).forEach((an) => an.finish());
    fillOn = true;
  }
  // (guarded on the path itself: bind:this re-binds on updates, so a statement on pill/fill would re-run without end)
  let placedFor = '';
  $: if (path !== placedFor && pill && fill) { placedFor = path; void placeFill(true); }

  // ---- search: the round icon stretches leftwards into the field; typing drives /search?q= (no second input on that page) ----
  let searchOpen = false, q = '', searchEl: HTMLInputElement, searchBtn: HTMLButtonElement, st: ReturnType<typeof setTimeout>;
  let hSeen: string | null = null, hPushed: string | null = null;
  $: urlQ = path === '/search' ? ($page.url.searchParams.get('q') ?? '').trim() : null;
  // same guard as routes/search: react to URL changes only, and never overwrite what is being typed with our own (older) URL
  $: if (urlQ !== hSeen) {
    hSeen = urlQ;
    if (urlQ === null) { hPushed = null; clearTimeout(st); q = ''; if (document.activeElement !== searchEl) searchOpen = false; }
    else { searchOpen = true; if (urlQ !== hPushed) { hPushed = urlQ; clearTimeout(st); q = urlQ; } }
  }
  function commitSearch(v: string) {
    clearTimeout(st);
    const s = v.trim();
    const href = s ? `/search?q=${encodeURIComponent(s)}` : '/search';
    if (path === '/search') { if (s === hPushed) return; hPushed = s; void goto(href, { replace: true, reset: false }); }
    else if (s) { hPushed = s; void goto(href, { reset: false }).then(() => scrollTo({ top: 0, behavior: 'instant' })); } // keep the focus in the field
  }
  function onSearchInput() { clearTimeout(st); st = setTimeout(() => commitSearch(q), 220); }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (q) { q = ''; commitSearch(''); } else { searchOpen = false; searchBtn?.focus(); }
  }
  /** opens the field and puts the cursor in it (the icon, "/" and Ctrl/Cmd+K via the layout) */
  export function openSearch() {
    searchOpen = true; menu = bell = cats = false;
    void tick().then(() => searchEl?.focus());
  }
  function onSearchBlur() { if (!q && path !== '/search') searchOpen = false; }

  // ---- narrow windows: the pill steps aside for the open field. Without room for that, the focused field covers the pill
  // (it fades out); an open field without the focus (e.g. on /search) narrows to the space left instead, so the tabs stay usable ----
  let form: HTMLElement, shift = 0, covered = false, fieldW = 280, fieldFull = 280, focused = false;
  const GAP = 12;
  function measureShift() {
    const full = (fieldFull = Math.min(280, innerWidth * 0.34)); // the field's width in CSS: min(280px, 34vw)
    if (!searchOpen || !pill || !form) { shift = 0; covered = false; fieldW = full; return; }
    const p = pill.getBoundingClientRect(), f = form.getBoundingClientRect();
    const right = p.right - shift, left = p.left - shift; // (p is measured with the current shift applied)
    const over = right - (f.right - full - GAP);
    const logo = root.querySelector('.logo')?.getBoundingClientRect().right ?? 0;
    const room = Math.max(0, left - logo - GAP);
    if (over <= room) { covered = false; shift = over > 0 ? -over : 0; fieldW = full; }
    else if (focused) { covered = true; shift = 0; fieldW = full; }
    else { covered = false; shift = -room; fieldW = Math.max(44, f.right - (right - room) - GAP); }
  }
  let shiftFor = '';
  $: if (`${searchOpen}${focused}` !== shiftFor) { shiftFor = `${searchOpen}${focused}`; void tick().then(measureShift); }
  /** a narrowed field too small to type in shows only the icon */
  $: compact = searchOpen && fieldW < 120;
  /** closed or not focused (e.g. narrowed on /search): the icon puts the cursor in the field (which then grows); else it searches */
  function onSearchIcon() {
    if (!searchOpen || document.activeElement !== searchEl) openSearch(); // (mousedown on the icon keeps the focus where it was)
    else commitSearch(q);
  }

  onMount(() => {
    // a retarget, not a jump: a slide in flight keeps going
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { void placeFill(true); measureShift(); }) : null;
    ro?.observe(pill);
    ro?.observe(root);
    return () => ro?.disconnect();
  });
  onDestroy(() => { clearTimeout(st); clearTimeout(notesTimer); });
</script>

<svelte:window bind:scrollY on:keydown={onWindowKey} on:click={onWindowClick} />

<header class="nav desk" class:solid class:blur data-desk-bar bind:this={root}>
  <span class="scrim" aria-hidden="true"></span>
  <a class="logo" href="/" aria-label={$t('shell.nav.homeLink')}><Logo wordmark size={30} /></a>
  <nav class="pill" class:on={fillOn} class:covered aria-label={$t('shell.nav.main')} bind:this={pill} style:--shift="{shift}px">
    <span class="fill" aria-hidden="true" bind:this={fill}><i class="cap"></i><i class="mid" bind:this={mid}></i><i class="cap" bind:this={capR}></i></span>
    {#each HEADER_TABS as [href, label] (href)}<a {href} class="tab" class:active={isTabActive(href, path)} aria-current={isTabActive(href, path) ? 'page' : undefined}>{$t(label)}</a>{/each}
    <div class="pop-anchor">
      <button type="button" class="tab cbtn" aria-haspopup="true" aria-expanded={cats} on:click={toggleCats}>{$t('shell.nav.categories')}<i class="caret" class:up={cats}></i></button>
      {#if cats}
        <div class="drop catdrop" role="region" aria-label={$t('shell.cats.title')}>
          <div class="cseg">
            <div class="seg" role="group" aria-label={$t('shell.cats.kind')}>
              <button type="button" class:on={catKind === 'movies'} aria-pressed={catKind === 'movies'} on:click={() => (catKind = 'movies')}>{$t('common.movies')}</button>
              <button type="button" class:on={catKind === 'series'} aria-pressed={catKind === 'series'} on:click={() => (catKind = 'series')}>{$t('common.series')}</button>
            </div>
            <a class="coll" href="/collections">{$t('shell.cats.collections')}</a>
          </div>
          <div class="ccols">
            <section aria-labelledby="cg-h"><h2 id="cg-h" class="ch">{$t('shell.cats.genres')}</h2>
              {#if catGenres === null}<p class="muted pad" role="status">{$t('common.loading')}</p>
              {:else}<ul class="glist">{#each catGenres as g (g)}<li><a href={categoryHref(catKind, g)}>{g}</a></li>{/each}</ul>{/if}
            </section>
            <section aria-labelledby="cl-h"><h2 id="cl-h" class="ch">{$t('shell.cats.byLanguage')}</h2>
              {#if catLangs === null}<p class="muted pad" role="status">{$t('common.loading')}</p>
              {:else if !catLangs.length}<p class="muted pad">{$t('shell.cats.none')}</p>
              {:else}<ul class="glist">{#each catLangs as c (c)}<li><a href="/browse/{catKind}?audio={encodeURIComponent(c)}">{langLabel(c)}</a></li>{/each}</ul>{/if}
            </section>
          </div>
        </div>
      {/if}
    </div>
  </nav>
  <div class="right">
    <form class="search" class:open={searchOpen} class:compact on:submit|preventDefault={() => commitSearch(q)} role="search" bind:this={form}
      style:--fs={+(fieldW / fieldFull).toFixed(4)} style:--fw="{fieldW}px" on:focusin={() => (focused = true)} on:focusout={() => (focused = false)}>
      <span class="sbg" aria-hidden="true"></span>
      <input id="hq" type="search" bind:this={searchEl} bind:value={q} autocomplete="off" enterkeyhint="search" placeholder={$t('shell.search.placeholder')} aria-label={$t('shell.search.label')} tabindex={searchOpen ? 0 : -1}
        on:input={onSearchInput} on:keydown={onSearchKey} on:blur={onSearchBlur} />
      <button type="button" class="round" bind:this={searchBtn} aria-label={searchOpen ? $t('shell.search.submit') : $t('shell.search.open')} on:mousedown|preventDefault on:click={onSearchIcon}><Icon name="search" size={20} /></button>
    </form>
    <div class="pop-anchor">
      <button type="button" class="round" aria-label={unread ? $t('shell.bell.unread', { n: unread }) : $t('shell.bell.label')} aria-expanded={bell} on:click={toggleBell}>
        <Icon name="bell" size={20} />{#if unread}<span class="dot">{unread}</span>{/if}
      </button>
      {#if bell}
        <div class="drop wide" role="menu">
          {#each notes as n}{#if n.link}<a href={n.link} class:muted={n.read} role="menuitem">{n.title}</a>{:else}<span class="note" class:muted={n.read} role="none">{n.title}</span>{/if}{:else}<span class="muted pad">{$t('shell.bell.empty')}</span>{/each}
        </div>
      {/if}
    </div>
    <div class="pop-anchor">
      <button type="button" class="avatar" aria-label={who ? $t('shell.account.labelWho', { name: who }) : $t('shell.account.label')} aria-haspopup="menu" aria-expanded={menu} disabled={!me} on:click={toggleMenu}><span class="face" style={faceStyle}>{initial(who)}</span></button>
      {#if menu && me}
        <div class="drop acct" role="menu" aria-label={$t('shell.account.label')}>
          {#if multi}
            {#if others === null}<span class="muted pad" role="status">{$t('shell.account.loadingProfiles')}</span>{/if}
            {#each others ?? [] as p (p.id)}<a class="prof" href={switchHref(p.id)} role="menuitem" data-sveltekit-reload><span class="face xs" style="background:{avatarBg(p.avatar)}" aria-hidden="true">{initial(p.name)}</span>{p.name}{#if p.hasPin}<Icon name="lock" size={14} label={$t('shell.account.withPin')} />{/if}</a>{/each}
          {/if}
          <a href="/profiles?manage=1" role="menuitem"><Icon name="users" size={18} />{$t('shell.account.manageProfiles')}</a>
          <hr />
          <a href="/me" role="menuitem"><Icon name="user" size={18} />{$t('shell.menu.me')}</a>
          <a href="/settings" role="menuitem"><Icon name="settings" size={18} />{$t('shell.menu.accountSettings')}</a>
          <a href="/devices" role="menuitem"><Icon name="monitor" size={18} />{$t('shell.menu.devices')}</a>
          {#if canDownload}<a href="/downloads" role="menuitem"><Icon name="download" size={18} />{$t('shell.menu.downloads')}</a>{/if}
          <button class="plain" role="menuitem" on:click={surprise}><Icon name="shuffle" size={18} />{$t('shell.menu.surprise')}</button>
          <button class="plain" role="menuitem" on:click={openHelp}><Icon name="info" size={18} />{$t('shell.menu.help')}</button>
          {#if admin}<a href="/admin" role="menuitem"><Icon name="shield" size={18} />{$t('shell.menu.admin')}</a>{/if}
          <hr />
          {#if lgApp}<button class="plain" role="menuitem" on:click={changeServer}>{$t('shell.account.changeServer')}</button>{/if}
          <button class="plain out" role="menuitem" on:click={logout}>{$t('shell.account.logout')}</button>
        </div>
      {/if}
    </div>
  </div>
</header>

<style>
  /* the bar itself never paints: no band across the page, only the pill and the round buttons carry a fill */
  .desk { --glass: rgba(18, 20, 24, .58); --glass-solid: rgba(18, 20, 24, .96); --line: rgba(255, 255, 255, .09); --ease: cubic-bezier(.05, .7, .1, 1);
    position: fixed; top: 0; left: 0; right: 0; z-index: 50; height: var(--nav-total); box-sizing: border-box;
    display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; column-gap: 16px;
    padding: var(--safe-top) max(var(--pad-x), var(--safe-right)) 0 max(var(--pad-x), var(--safe-left));
    background: transparent; pointer-events: none; }
  .desk > * { pointer-events: auto; }
  /* once scrolled: a soft shade behind logo and buttons (fades out downwards, no edge); never over the billboard at the top */
  .desk > .scrim { position: absolute; z-index: -1; top: 0; left: 0; right: 0; height: calc(128px + var(--safe-top)); pointer-events: none; opacity: 0; transition: opacity 240ms ease-out;
    /* the page colour (--bg #101418) fully opaque under the bar's 64 px (a big title or white button scrolling under the logo
       must not show through), then an eased fade to nothing by 128 px (no edge) */
    background: linear-gradient(to bottom, rgb(16, 20, 24) 0, rgb(16, 20, 24) calc(64px + var(--safe-top)), rgba(16, 20, 24, .74) calc(80px + var(--safe-top)),
      rgba(16, 20, 24, .38) calc(98px + var(--safe-top)), rgba(16, 20, 24, .12) calc(114px + var(--safe-top)), rgba(16, 20, 24, 0) 100%); }
  .solid > .scrim { opacity: 1; }
  .logo { justify-self: start; display: inline-flex; align-items: center; min-height: 44px; filter: drop-shadow(0 1px 6px rgba(0, 0, 0, .45)); }

  /* ---- the pill ---- */
  .pill { position: relative; display: flex; align-items: center; gap: 0; padding: 4px; border-radius: 999px; background: var(--glass); border: 1px solid var(--line);
    transform: translateX(var(--shift, 0px)); transition: background-color 240ms ease-out, transform 320ms var(--ease), opacity 160ms ease-out; }
  .pill.covered { opacity: 0; visibility: hidden; transition: opacity 160ms ease-out, visibility 0s linear 160ms; } /* hidden: no focus on tabs under the field */
  .solid .pill, .solid .round { background-color: var(--glass-solid); }
  .blur .pill, .blur .round { -webkit-backdrop-filter: blur(16px) saturate(140%); backdrop-filter: blur(16px) saturate(140%); }
  .solid.blur .pill, .solid.blur .round { -webkit-backdrop-filter: none; backdrop-filter: none; }
  .fill { position: absolute; left: 0; top: 4px; width: 36px; height: 36px; opacity: 0; transition: opacity 160ms ease-out; pointer-events: none; }
  .pill.on .fill { opacity: .14; }
  .fill i { position: absolute; top: 0; left: 0; height: 36px; background: #fff; }
  .fill .cap { width: 36px; border-radius: 50%; }
  .fill .mid { left: 18px; width: 100px; transform-origin: left center; transition: transform 340ms var(--ease); }
  .tab { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 16px; border-radius: 999px; font-size: .9rem; font-weight: 500; color: rgba(255, 255, 255, .78); white-space: nowrap; transition: color 160ms ease-out; }
  .tab:hover { color: #fff; }
  .tab.active { color: #fff; font-weight: 600; }
  .tab:focus-visible { outline: 2px solid #fff; outline-offset: 0; }
  .cbtn, .cbtn:hover:not(:disabled) { background: transparent; border: 0; font: inherit; font-size: .9rem; font-weight: 500; }
  .cbtn[aria-expanded='true'] { color: #fff; }
  .caret { width: 0; height: 0; border: 4px solid transparent; border-top-color: currentColor; border-bottom: 0; transition: transform 160ms ease-out; }
  .caret.up { transform: rotate(180deg); }

  /* ---- right side: search, bell, avatar ---- */
  .right { justify-self: end; display: flex; align-items: center; gap: 8px; }
  .round { position: relative; z-index: 1; display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; color: #fff; background: var(--glass); border: 1px solid var(--line); transition: background-color 240ms ease-out; }
  .round:hover:not(:disabled) { background-color: rgba(48, 52, 60, .9); }
  .round:focus-visible, .avatar:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .dot { position: absolute; top: -3px; right: -3px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 99px; display: grid; place-items: center; background: var(--acc-fill); color: #fff; font-size: .68rem; font-weight: 700; font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px rgba(18, 20, 24, .9); }

  /* the field grows out of the icon to the left: a backing layer scales on X, the input fades and slides in over it */
  .search { position: relative; width: 44px; height: 44px; }
  .sbg { position: absolute; right: 0; top: 0; width: min(280px, 34vw); height: 44px; box-sizing: border-box; border-radius: 22px; background: var(--glass-solid); border: 1px solid rgba(255, 255, 255, .22);
    transform-origin: right center; transform: scaleX(.16); opacity: 0; pointer-events: none; transition: transform 280ms var(--ease), opacity 120ms ease-out 80ms; }
  .search input { position: absolute; right: 44px; top: 0; width: calc(min(280px, 34vw) - 56px); height: 44px; min-height: 44px; padding: 0 0 0 16px; box-sizing: border-box; border: 0; background: transparent; color: #fff; font: inherit; font-size: .92rem;
    opacity: 0; transform: translateX(16px); pointer-events: none; transition: opacity 120ms ease-out, transform 280ms var(--ease); }
  .search input:focus-visible { outline: none; }
  .search.open .sbg { transform: scaleX(var(--fs, 1)); opacity: 1; transition: transform 280ms var(--ease), opacity 80ms ease-out; }
  .search.open input { width: calc(var(--fw) - 56px); opacity: 1; transform: none; pointer-events: auto; transition: opacity 160ms ease-out 80ms, transform 280ms var(--ease); }
  .search.open .round { background: transparent; border-color: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; }
  .search.open.compact input { opacity: 0; pointer-events: none; }
  .search.open:focus-within .sbg { border-color: rgba(255, 255, 255, .55); }

  .avatar { display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; background: transparent; border-radius: 10px; }
  .avatar:hover:not(:disabled) { background: transparent; }
  .face { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: linear-gradient(135deg, #ff6b81, #9a2440); font-weight: 800; color: #fff; box-shadow: 0 0 0 1px rgba(255, 255, 255, .14); }
  .avatar[aria-expanded='true'] .face { box-shadow: 0 0 0 2px #fff; }

  /* ---- dropdowns (today's menus, restyled to match the pill) ---- */
  .pop-anchor { position: relative; }
  .drop { position: absolute; right: 0; top: calc(100% + 10px); background: rgba(18, 20, 24, .97); border: 1px solid rgba(255, 255, 255, .1); border-radius: 16px; min-width: 220px; padding: 8px 0; display: flex; flex-direction: column;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .55); max-height: calc(100vh - var(--nav-total) - 16px); max-height: calc(100dvh - var(--nav-total) - 16px); overflow-y: auto; overscroll-behavior: contain; animation: drop-in 180ms var(--ease); }
  @keyframes drop-in { from { opacity: 0; transform: translateY(-4px); } }
  .drop hr { border: 0; border-top: 1px solid rgba(255, 255, 255, .08); margin: 4px 0; width: 100%; }
  .drop.wide { width: min(340px, 90vw); }
  .drop .note { display: block; padding: 8px 16px; font-size: .9rem; color: #e5e5e5; }
  .drop .note.muted { color: var(--mut); }
  .drop a, .drop .plain { display: flex; gap: 12px; align-items: center; padding: 8px 16px; font-size: .9rem; color: #e5e5e5; min-height: 44px; box-sizing: border-box; }
  .drop a:hover, .drop .plain:hover { background: rgba(255, 255, 255, .06); text-decoration: none; }
  .drop a:focus-visible, .drop .plain:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
  .plain { background: transparent; border-radius: 0; justify-content: flex-start; font-weight: 400; width: 100%; }
  .pad { padding: 12px 16px; }
  .acct { min-width: 248px; }
  .acct .prof { font-weight: 500; }
  .face.xs { width: 28px; height: 28px; border-radius: 8px; font-size: .8rem; flex: none; }
  .acct .out { justify-content: center; }
  .catdrop { left: 50%; right: auto; margin-left: calc(min(560px, 80vw) / -2); width: min(560px, 80vw); padding: 16px 20px; box-sizing: border-box; }
  .cseg { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
  .seg { display: inline-flex; border: 1px solid rgba(255, 255, 255, .18); border-radius: 99px; overflow: hidden; }
  .seg button { background: transparent; border-radius: 0; min-height: 36px; padding: 0 16px; color: #ddd; font-weight: 600; }
  .seg button:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .seg button.on, .seg button.on:hover:not(:disabled) { background: #fff; color: #000; }
  .catdrop .coll { font-weight: 600; color: #fff; padding: 0 12px; min-height: 44px; display: inline-flex; align-items: center; border-radius: 999px; }
  .ccols { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
  .ch { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); margin: 0 0 4px; font-weight: 600; }
  .glist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
  .ccols section:last-child .glist { grid-template-columns: 1fr; }
  .catdrop .glist a { min-height: 40px; padding: 0; font-size: .9rem; }
  .catdrop .glist a:hover { background: transparent; text-decoration: underline; }

  @media (max-width: 1100px) { .tab { padding: 0 12px; } }
  @media (max-width: 900px) { .pill { display: none; } }
  @media (prefers-reduced-motion: reduce) {
    .pill, .fill, .fill .mid, .desk > .scrim, .sbg, .search input, .search.open .sbg, .search.open input, .round, .caret { transition: none; }
    .drop { animation: none; }
  }
</style>
