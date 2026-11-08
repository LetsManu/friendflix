<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Desktop top bar (spec desktop browse §1): logo left, a floating pill with the tabs, Categories and search (the magnifier at
   * its right end; the pill grows for the field) in the middle, bell / avatar on the right. No full-width band: over the
   * billboard nothing sits behind it, once scrolled the pill and the round buttons turn opaque. The active tab's fill slides to a newly chosen tab (springs from lib/tv/motion).
   */
  import { flushSync, onDestroy, onMount, tick } from 'svelte';
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
  import { animateTo, glide, halt, motionLevel, motionTripped, placeAt } from '#lib/tv/motion';
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
  const fullMotion = (_calm: unknown, _tripped: boolean) => motionLevel() === 'full'; // re-read when the prefs (calm mode) arrive or the frame guard trips
  $: blur = fullMotion($prefs, $motionTripped);
  $: still = !blur; // calm mode / reduced motion: the field's fades are off too (the springs check motionLevel themselves)

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

  // ---- the active tab's fill (inside the tab track): sprung to the active tab, its width gliding along (instant under reduced motion) ----
  // Transform only: the fill moves as a whole (translate); inside it the right cap springs to the new width and the middle
  // part scales on X. The fill's opacity is on the group, so the overlapping white parts never add up.
  let pill: HTMLElement, fill: HTMLElement, mid: HTMLElement, capR: HTMLElement;
  let fillOn = false;
  const CAP = 36, MID = 100; // cap diameter (the tab height); the middle part's unscaled width
  async function placeFill(slide: boolean) {
    await tick();
    const a = track?.querySelector<HTMLElement>(':scope > a[aria-current="page"]');
    // (no active tab, or the tab links are hidden in a narrow window: no fill)
    if (!a || !a.offsetParent || !fill || !mid || !capR) { fillOn = false; return; }
    const instant = !slide || !fillOn || motionLevel() === 'reduced'; // first placement or back from a page without a tab: no slide
    const w = Math.max(CAP, a.offsetWidth);
    mid.style.transition = instant ? 'none' : '';
    mid.style.transform = `scaleX(${+((w - CAP) / MID).toFixed(4)})`;
    // an instant placement moves nothing, so it must not open a frame-guard watch window (the first one runs during boot)
    if (instant) { placeAt(fill, 'x', a.offsetLeft); placeAt(capR, 'x', w - CAP); }
    else { animateTo(fill, 'x', a.offsetLeft); animateTo(capR, 'x', w - CAP); }
    fillOn = true;
  }
  // (guarded on the path itself: bind:this re-binds on updates, so a statement on pill/fill would re-run without end)
  let placedFor = '';
  $: if (path !== placedFor && pill && fill) { placedFor = path; void placeFill(true); }

  // ---- search inside the pill (spec §1): the magnifier is the pill's last item; opening it makes the pill itself grow with a
  // spring and the field appears at its right end. Typing drives /search?q= (no second input on that page). ----
  let searchOpen = false, q = '', searchEl: HTMLInputElement, magBtn: HTMLButtonElement, xBtn: HTMLButtonElement, st: ReturnType<typeof setTimeout>;
  let hSeen: string | null = null, hPushed: string | null = null;
  $: urlQ = path === '/search' ? ($page.url.searchParams.get('q') ?? '').trim() : null;
  // same guard as routes/search: react to URL changes only, and never overwrite what is being typed with our own (older) URL
  $: if (urlQ !== hSeen) {
    hSeen = urlQ;
    if (urlQ === null) { hPushed = null; clearTimeout(st); q = ''; if (!focused) searchOpen = false; }
    else { searchOpen = true; if (urlQ !== hPushed) { hPushed = urlQ; clearTimeout(st); q = urlQ; } }
    void tick().then(() => sync());
  }
  function commitSearch(v: string) {
    clearTimeout(st);
    const s = v.trim();
    const href = s ? `/search?q=${encodeURIComponent(s)}` : '/search';
    if (path === '/search') { if (s === hPushed) return; hPushed = s; void goto(href, { replace: true, reset: false }); }
    else if (s) { hPushed = s; void goto(href, { reset: false }).then(() => scrollTo({ top: 0, behavior: 'instant' })); } // keep the focus in the field
  }
  function onSearchInput() { clearTimeout(st); st = setTimeout(() => commitSearch(q), 220); }
  /** shrinks the pill back (on /search the field stays open, narrowed) and puts the focus on the magnifier */
  function closeSearch() {
    searchOpen = path === '/search'; focused = false;
    sync();
    magBtn?.focus();
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (q) { q = ''; commitSearch(''); } else closeSearch();
  }
  function onClose() { if (q) { q = ''; commitSearch(''); } closeSearch(); }
  /** opens the field and puts the cursor in it (the magnifier, "/" and Ctrl/Cmd+K via the layout) */
  export function openSearch() {
    searchOpen = true; focused = true; menu = bell = cats = false;
    sync();
    searchEl?.focus();
  }
  /** closed, narrowed or not focused: the magnifier puts the cursor in the field; with the cursor in it, it searches */
  function onMag() {
    if (!open || compact || document.activeElement !== searchEl) openSearch(); // (mousedown on it keeps the focus where it was)
    else commitSearch(q);
  }
  // the focus inside the field (input or ✕): a narrow window may fold the tabs away for it
  let focused = false;
  const inField = (n: EventTarget | null) => !!n && (n === searchEl || n === xBtn);
  function onFocusIn(e: FocusEvent) { if (inField(e.target) && !focused) { focused = true; sync(); } }
  function onFocusOut(e: FocusEvent) {
    if (inField(e.relatedTarget)) return;
    if (e.relatedTarget) { leaveField(e.relatedTarget === magBtn); return; }
    // no new target: a click on something unfocusable, or the window itself lost the focus (alt-tab, another browser tab).
    // The latter keeps the field and its text as they are (the focus comes back to it with the window): look once it settled.
    clearTimeout(blurT);
    blurT = setTimeout(() => { if (document.hasFocus() && !inField(document.activeElement)) leaveField(false); }, 0);
  }
  let blurT: ReturnType<typeof setTimeout> | undefined;
  /** the focus left the field for somewhere else on the page */
  function leaveField(toMag: boolean) {
    focused = false;
    // off /search that closes the field, also within the typing pause (the pending search is dropped, so a late navigation
    // cannot reopen it); on /search it stays open, unfocused
    if (path !== '/search' && !toMag) { clearTimeout(st); q = ''; searchOpen = false; }
    sync();
  }

  // ---- the pill's shape: applied state (what the markup shows) vs. what it should be; changes go through morph() ----
  let track: HTMLElement, form: HTMLElement, bgL: HTMLElement, bgR: HTMLElement;
  /** open: the field shows; fw: its width (input + ✕); collapse: tabs folded away for the focused field; compact: magnifier only */
  let open = false, fw = 0, lastFw = 0, collapse = false, compact = false;
  const MAG = 36, FMAX = 280, FMIN = 200, FTINY = 120, COLGAP = 16, CHROME = 10; // CHROME: the pill's padding + border
  type Shape = { open: boolean; fw: number; collapse: boolean; compact: boolean };
  /** the shape for the current intent, from the room the bar has (the pill never overlaps the logo or the buttons) */
  function target(): Shape {
    const shut: Shape = { open: false, fw: 0, collapse: false, compact: false };
    if (!searchOpen || !root || !track) return shut;
    const cs = getComputedStyle(root);
    const inner = root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const logo = root.querySelector<HTMLElement>(':scope > .logo')?.offsetWidth ?? 0, right = root.querySelector<HTMLElement>(':scope > .right')?.offsetWidth ?? 0;
    const avail = Math.floor(inner - logo - right - 2 * COLGAP - CHROME - MAG);
    const items = [...track.children].filter((c) => !c.classList.contains('fill')) as HTMLElement[];
    const tabsW = items.reduce((w, c) => w + c.offsetWidth, 0);
    const activeW = track.querySelector<HTMLElement>(':scope > a[aria-current="page"]')?.offsetWidth ?? 0;
    const room = avail - tabsW;
    if (room >= FMIN) return { open: true, fw: Math.min(FMAX, room), collapse: false, compact: false };
    if (focused) return { open: true, fw: Math.max(0, Math.min(FMAX, avail - activeW)), collapse: true, compact: false };
    if (room >= FTINY) return { open: true, fw: room, collapse: false, compact: false };
    return { open: true, fw: 0, collapse: false, compact: true };
  }
  function sync(animate = true) {
    const t = target();
    if (t.open === open && t.fw === fw && t.collapse === collapse && t.compact === compact) return;
    morph(() => { open = t.open; fw = t.fw; collapse = t.collapse; compact = t.compact; if (t.fw) lastFw = t.fw; }, animate);
  }
  /** an element's x on screen without its own translation; nested ones (the tabs) relative to their track */
  const ownX = (el: HTMLElement) => { const tr = getComputedStyle(el).transform; return tr && tr !== 'none' ? new DOMMatrixReadOnly(tr).m41 : 0; };
  const layoutX = (el: HTMLElement) => el.getBoundingClientRect().left - ownX(el) - (el.parentElement === track ? track.getBoundingClientRect().left : 0);
  /**
   * FLIP, transform only: the layout jumps to the new shape at once; every part that moved (the two background halves, the
   * tab track, each tab, the field) keeps its place on screen through a translate that springs back to 0 (glide from
   * lib/tv/motion: a change mid-flight carries on from where things are, with their speed). The background is two halves,
   * each clipped at the pill's middle: they slide, nothing scales, so the round ends keep their shape and text never stretches.
   */
  function morph(change: () => void, animate: boolean) {
    const parts = [bgL, bgR, track, form, ...(track ? [...track.children].filter((c) => !c.classList.contains('fill')) as HTMLElement[] : [])].filter(Boolean);
    if (!animate || motionLevel() === 'reduced' || !pill) {
      parts.forEach((p) => halt(p));
      change(); flushSync();
      void placeFill(false);
      return;
    }
    const before = parts.map(layoutX);
    change(); flushSync();
    // (all measured before any glide starts: a tab's x is relative to the track, whatever the track itself does)
    const after = parts.map(layoutX);
    parts.forEach((p, i) => glide(p, 'x', () => before[i]! - after[i]!));
    void placeFill(true);
  }

  onMount(() => {
    // a retarget, not a jump: a slide in flight keeps going
    sync(false);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { void placeFill(true); sync(false); }) : null;
    ro?.observe(pill);
    ro?.observe(root);
    return () => ro?.disconnect();
  });
  onDestroy(() => { clearTimeout(st); clearTimeout(notesTimer); clearTimeout(blurT); });
</script>

<svelte:window bind:scrollY on:keydown={onWindowKey} on:click={onWindowClick} />

<header class="nav desk" class:solid class:blur class:still data-desk-bar bind:this={root}>
  <span class="scrim" aria-hidden="true"></span>
  <a class="logo" href="/" aria-label={$t('shell.nav.homeLink')}><Logo wordmark size={30} /></a>
  <nav class="pill" class:on={fillOn} class:open class:compact class:collapse aria-label={$t('shell.nav.main')} bind:this={pill} style:--fw="{fw}px" style:--fwc="{open ? fw : lastFw}px">
    <!-- the background: two halves, each clipped at the middle, that slide (never scale) when the pill changes size -->
    <span class="pbg" aria-hidden="true"><span class="half l"><i bind:this={bgL}></i></span><span class="half r"><i bind:this={bgR}></i></span></span>
    <div class="track" bind:this={track}>
      <span class="fill" aria-hidden="true" bind:this={fill}><i class="cap"></i><i class="mid" bind:this={mid}></i><i class="cap" bind:this={capR}></i></span>
      {#each HEADER_TABS as [href, label] (href)}<a {href} class="tab" class:active={isTabActive(href, path)} class:gone={collapse && !isTabActive(href, path)} aria-current={isTabActive(href, path) ? 'page' : undefined}>{$t(label)}</a>{/each}
      <div class="pop-anchor" class:gone={collapse}>
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
    </div>
    <form class="psearch" role="search" bind:this={form} on:submit|preventDefault={() => commitSearch(q)} on:focusin={onFocusIn} on:focusout={onFocusOut}>
      <button type="button" class="mag" bind:this={magBtn} aria-label={open && !compact ? $t('shell.search.submit') : $t('shell.search.open')} on:mousedown|preventDefault on:click={onMag}><Icon name="search" size={18} /></button>
      <input id="hq" type="search" bind:this={searchEl} bind:value={q} autocomplete="off" enterkeyhint="search" placeholder={$t('shell.search.placeholder')} aria-label={$t('shell.search.label')} tabindex={open && !compact ? 0 : -1}
        on:input={onSearchInput} on:keydown={onSearchKey} />
      <button type="button" class="x" bind:this={xBtn} aria-label={$t('desk.bar.close')} tabindex={open && !compact ? 0 : -1} on:mousedown|preventDefault on:click={onClose} on:keydown={onSearchKey}><Icon name="x" size={16} /></button>
    </form>
  </nav>
  <div class="right">
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
  .desk { --glass: rgba(18, 20, 24, .58); --glass-solid: rgba(18, 20, 24, .96); --line: rgba(255, 255, 255, .09); --ease: var(--m-emph-out);
    position: fixed; top: 0; left: 0; right: 0; z-index: 50; height: var(--nav-total); box-sizing: border-box;
    display: grid; grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr); /* centred while it fits, else it moves aside */ align-items: center; column-gap: 16px;
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

  /* ---- the pill: transparent itself; its look is the background layer (.pbg), so a size change can be played back by
     sliding that layer's two halves (transform only) while the content glides; the field lives at its right end ---- */
  .pill { position: relative; display: flex; align-items: center; gap: 0; padding: 4px; border-radius: 999px; border: 1px solid transparent; }
  .pbg { position: absolute; inset: -1px; pointer-events: none; }
  /* each half is a clip window from the pill's middle outwards (far past the edge, so a larger shape mid-flight is not cut) */
  .half { position: absolute; top: 0; bottom: 0; overflow: hidden; }
  .half.l { left: -100vw; right: 50%; }
  .half.r { left: 50%; right: -100vw; }
  .half i { position: absolute; top: 0; bottom: 0; width: 100vw; box-sizing: border-box; background: var(--glass); border: 1px solid var(--line); transition: background-color 240ms ease-out; }
  .half.l i { left: 100vw; border-radius: 999px 0 0 999px; border-right: 0; }
  .half.r i { right: 100vw; border-radius: 0 999px 999px 0; border-left: 0; }
  .solid .half i, .solid .round { background-color: var(--glass-solid); }
  .blur .half i, .blur .round { -webkit-backdrop-filter: blur(16px) saturate(140%); backdrop-filter: blur(16px) saturate(140%); }
  .solid.blur .half i, .solid.blur .round { -webkit-backdrop-filter: none; backdrop-filter: none; }
  .pill.open:not(.compact):focus-within .half i { border-color: rgba(255, 255, 255, .6); } /* the field's focus ring (the input has no outline) */
  .track { position: relative; display: flex; align-items: center; height: 36px; }
  .fill { position: absolute; left: 0; top: 0; width: 36px; height: 36px; opacity: 0; transition: opacity 160ms ease-out; pointer-events: none; }
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
  /* a narrow window with the field focused: the other tabs fold away (fade out where the track starts) and come back after */
  .track > .tab, .track > .pop-anchor { transition: color 160ms ease-out, opacity 200ms ease-out 80ms, visibility 0s; }
  .track > .gone { position: absolute; left: 0; top: 0; opacity: 0; visibility: hidden; pointer-events: none; transition: color 160ms ease-out, opacity 120ms ease-in, visibility 0s linear 120ms; }

  /* the field: the magnifier stays where it is (the pill's last item), input and ✕ fade and slide in to its right while the
     pill's right end springs out; closing, they fade first (they keep their width, --fwc, while the pill shrinks under them) */
  .psearch { position: relative; flex: none; display: flex; align-items: center; width: calc(36px + var(--fw, 0px)); height: 36px; }
  .mag, .x { display: grid; place-items: center; flex: none; width: 36px; height: 36px; min-height: 36px; padding: 0; border-radius: 50%; background: transparent; color: rgba(255, 255, 255, .78); transition: color 160ms ease-out; }
  .mag:hover:not(:disabled), .x:hover:not(:disabled) { background: transparent; color: #fff; }
  .mag:active:not(:disabled), .x:active:not(:disabled) { transform: none; }
  .pill.open:not(.compact) .mag { color: #fff; }
  .mag:focus-visible, .x:focus-visible { outline: 2px solid #fff; outline-offset: 0; }
  .psearch input, .x { position: absolute; top: 0; opacity: 0; visibility: hidden; pointer-events: none; transform: translate3d(-8px, 0, 0);
    transition: opacity 90ms ease-in, transform 200ms var(--ease), visibility 0s linear 90ms; }
  .psearch input { left: 36px; width: calc(var(--fwc) - 36px); height: 36px; min-height: 36px; padding: 0 4px; box-sizing: border-box; border: 0; border-radius: 0; background: transparent; color: #fff; font: inherit; font-size: .9rem; }
  .psearch input::placeholder { color: rgba(255, 255, 255, .5); }
  .psearch input:focus-visible { outline: none; }
  .psearch input::-webkit-search-cancel-button { display: none; }
  .x { left: var(--fwc); }
  .pill.open:not(.compact) .psearch input, .pill.open:not(.compact) .x { opacity: 1; visibility: visible; pointer-events: auto; transform: none;
    transition: opacity 180ms ease-out 60ms, transform 320ms var(--ease), visibility 0s; }
  .pill.open:not(.compact) .x { transition-delay: 140ms, 60ms, 0s; } /* the ✕ waits for the pill's end to reach it */
  .still .psearch input, .still .x, .still .track > .tab, .still .track > .pop-anchor, .still .track > .gone { transition: none; }

  /* ---- right side: bell, avatar ---- */
  .right { justify-self: end; display: flex; align-items: center; gap: 8px; }
  .round { position: relative; z-index: 1; display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; color: #fff; background: var(--glass); border: 1px solid var(--line); transition: background-color 240ms ease-out; }
  .round:hover:not(:disabled) { background-color: rgba(48, 52, 60, .9); }
  .round:focus-visible, .avatar:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .dot { position: absolute; top: -3px; right: -3px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 99px; display: grid; place-items: center; background: var(--acc-fill); color: #fff; font-size: .68rem; font-weight: 700; font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px rgba(18, 20, 24, .9); }

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
  /* a narrow window: the tab links go, the pill keeps Categories and the search (magnifier + field) */
  @media (max-width: 900px) { .track > a.tab { display: none; } }
  @media (prefers-reduced-motion: reduce) {
    .half i, .fill, .fill .mid, .desk > .scrim, .psearch input, .x, .track > *, .round, .caret { transition: none; }
    .drop { animation: none; }
  }
</style>
