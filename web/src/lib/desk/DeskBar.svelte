<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Desktop top bar (spec desktop browse §1): logo left, a floating pill with the tabs, Categories and search (the magnifier at
   * its right end; the pill grows for the field) in the middle, bell / avatar on the right. No full-width band: over the
   * billboard nothing sits behind it (the glass takes the safe scrim there), once scrolled the bar's opaque shade sits behind the glass. The active tab's fill slides to a newly chosen tab (springs from lib/tv/motion).
   */
  import { flushSync, onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { pageStore } from '#lib/page';
  import { api, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import { avatarBg, initial } from '#lib/avatars';
  import { HEADER_TABS, LIVE_HEADERS, activeTab, libraryTabs, liveTabs, navLabel } from '#lib/menu';
  import { areas, features } from '#lib/capabilities';
  import { categoryHref, kindFromPath, type Kind } from '#lib/mobile';
  import { langLabel } from '#lib/langs';
  import { logout as doLogout } from '#lib/session';
  import { changeServerViaHome } from '#lib/webos/home';
  import { toast } from '#lib/ui/toast';
  import { prefs } from '#lib/stores';
  import { t } from '#lib/i18n';
  import { animateTo, follow, glide, halt, motionLevel, motionTripped, moving, placeAt } from '#lib/tv/motion';
  import { alphaOf, pillSolid, SHADE_MS } from './bar';
  import { sheen } from '#lib/glass/pointer';
  import { growBoth } from '#lib/glass/fx';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import { getActiveProfile } from '#lib/api';
  import { pushRecent } from '#lib/discovery';
  import SearchSheet from './SearchSheet.svelte';
  import { nextId } from './searchSheet';
  import { menuKeys } from '#lib/ui/menuKeys';
  import { openPopup, type PopupHandle } from '#lib/ui/popups';
  import NotificationSheet from '#lib/notifications/NotificationSheet.svelte';
  import { badgeText } from '#lib/badge';

  /** the header tabs: Live-TV and Aufnahmen after Filme while the feature is on; without the Mediathek only those (roles redesign §6) */
  $: tabs = liveTabs(libraryTabs(HEADER_TABS, $areas.library), LIVE_HEADERS, $features.livetv);
  /** the one active tab: the most specific (Aufnahmen on /live/recordings, Live-TV elsewhere under /live) */
  $: act = activeTab(tabs.map((x) => x[0]), path);
  /** Categories, the search and "Überrasch mich" are library things */
  $: library = $areas.library;
  export let path: string;
  /** where the logo goes (Live TV for a person without libraries) */
  export let home = '/';
  /** the boot hint guesses a library: the tabs wait unseen until /api/me confirms it (app.css .lib-held), then fade in */
  export let held = false;
  export let fadeIn = false;
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
  /** every unread entry (the notifications center's counts, no cap): the bell's badge */
  export let unread = 0;
  export let onHelp: () => void = () => {};

  const page = pageStore();

  // ---- solid pill once scrolled (24 px) or on pages without a billboard ----
  let scrollY = 0;
  $: solid = pillSolid(scrollY, heroPage);
  // the glass over the billboard takes the safe scrim; turning solid, it keeps it until the bar's shade has faded in behind it
  let safe = !solid, safeT: ReturnType<typeof setTimeout> | undefined;
  $: setSafe(solid);
  function setSafe(s: boolean) {
    clearTimeout(safeT);
    if (!s) safe = true;
    else if (safe) safeT = setTimeout(() => (safe = false), SHADE_MS);
  }
  /** the full motion set (the glass blur itself comes from html.m-glass; calm mode, reduced motion or a slow device: none) */
  const fullMotion = (_calm: unknown, _tripped: boolean) => motionLevel() === 'full'; // re-read when the prefs (calm mode) arrive or the frame guard trips
  $: still = !fullMotion($prefs, $motionTripped); // calm mode / reduced motion: the field's fades are off too (the springs check motionLevel themselves)

  // ---- dropdowns: categories, account (menus glass spec: one pop-up at a time, none opens half-loaded); the bell opens the
  // notifications sheet (a modal dialog, lib/notifications) ----
  let menu = false, bell = false, cats = false;
  let catBtn: HTMLButtonElement, bellBtn: HTMLButtonElement, acctBtn: HTMLButtonElement;
  /** Categories was clicked while its lists load: the button spins, the drop opens once both have settled */
  let catBusy = false, catGen = 0;
  /** closes every dropdown here (and drops a Categories open that waits for its lists) */
  function shut() { menu = bell = cats = false; catBusy = false; catGen++; }
  /** the open dropdown's place in the one-pop-up-at-a-time registry (lib/ui/popups): opening a ⋯ menu or a Select closes it */
  let popup: PopupHandle | null = null;
  function claim() {
    popup?.release();
    popup = openPopup(() => { popup = null; shut(); });
  }
  $: if (!menu && !bell && !cats && !catBusy && popup) { popup.release(); popup = null; }
  /** an opened dropdown takes the focus (its first link or button, else itself); Esc gives it back to its button */
  async function focusInto(sel: string) {
    await tick();
    const d = root?.querySelector<HTMLElement>(sel);
    (d?.querySelector<HTMLElement>('a[href], button:not([disabled])') ?? d)?.focus({ preventScroll: true });
  }
  $: if (path) shut();
  let catKind: Kind = 'movies', catGenres: string[] | null = null, catLangs: string[] | null = null;
  let catLoad: Promise<unknown> | null = null;
  /** genres and languages, loaded once: on the button's pointerenter / focus, or the click (a failure: the "none" texts) */
  function loadCats() {
    return (catLoad ??= Promise.all([
      catGenres ?? api('/api/library/genres').then((r) => (catGenres = (r.genres as string[]) ?? []), () => (catGenres = [])),
      catLangs ?? api('/api/library/languages').then((r) => (catLangs = ((r.audio ?? []) as Array<{ code: string }>).map((l) => l.code).slice(0, 12)), () => (catLangs = [])),
    ]));
  }
  async function toggleCats() {
    if (cats || catBusy) { shut(); return; }
    shut(); claim();
    if (catGenres === null || catLangs === null) {
      const gen = catGen;
      catBusy = true;
      await loadCats();
      if (gen !== catGen) return; // closed meanwhile (Esc, another pop-up, a click elsewhere, a new page)
      catBusy = false;
    }
    catKind = kindFromPath(path);
    cats = true;
    void focusInto('.catdrop');
  }
  /** opening no longer marks anything read (the sheet reads what is opened or followed) */
  function toggleBell() {
    if (bell) { shut(); return; }
    shut(); claim(); bell = true;
  }
  type Prof = { id: string; name: string; avatar: string; hasPin: boolean; active?: boolean };
  /** the other profiles (null: not loaded); profLoading: the request runs (the menu shows placeholder rows of the final height) */
  let others: Prof[] | null = null, profLoading = false, profFailedAt = -Infinity;
  /** after a failed load the avatar's hovers wait this long before the next request (the menu still opens, without the list) */
  const PROF_RETRY_MS = 5000;
  /** the profile list loads on the avatar's pointerenter / focus (and on the click if not yet), so the menu opens complete */
  async function loadProfiles() {
    if (!multi || others !== null || profLoading || Date.now() - profFailedAt < PROF_RETRY_MS) return;
    profLoading = true;
    try { others = ((await api('/api/profiles')).profiles as Prof[]).filter((p) => !p.active && p.id !== me?.profile?.id).slice(0, 4); }
    catch { profFailedAt = Date.now(); /* the placeholder rows go; a hover after PROF_RETRY_MS tries again */ }
    profLoading = false;
  }
  /** placeholder rows while the list loads: one per other profile (at most four, as the list shows) */
  $: skelRows = profLoading && others === null ? Math.min(4, Math.max(0, (me?.profileCount ?? 1) - 1)) : 0;
  function toggleMenu() {
    if (menu) { shut(); return; }
    shut(); claim(); menu = true;
    void loadProfiles();
    void focusInto('.drop.acct');
  }
  const switchHref = (id: string) => `/profiles?pick=${encodeURIComponent(id)}&next=${encodeURIComponent(here)}`;
  const logout = () => doLogout(me?.tv);
  function changeServer() {
    shut();
    changeServerViaHome(() => toast.info($t('shell.account.changeServerBlue'))); // the hint when the start page cannot be reached
  }
  async function surprise() {
    shut();
    try { void goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { void goto('/browse/movies'); }
  }
  /** the checked profile row: nothing to switch, the menu closes and the focus goes back to the avatar */
  function closeToAvatar() { shut(); acctBtn?.focus({ preventScroll: true }); }
  function openHelp() { shut(); onHelp(); }

  let root: HTMLElement;
  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !(menu || cats || catBusy)) return;
    // the focus was inside the open dropdown: back to the button that opened it
    const anchor = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.pop-anchor');
    shut();
    if (anchor && root?.contains(anchor)) anchor.querySelector<HTMLElement>(':scope > button')?.focus();
  }
  /**
   * the keyboard left a dropdown (Tab past its last link, Shift+Tab past its button): it closes, it never stays open over the
   * page. A pointer press elsewhere (no new focus target) is the window click's job.
   */
  function onAnchorOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (!to || (e.currentTarget as HTMLElement).contains(to)) return;
    shut();
  }
  function onWindowClick(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    if (!el?.closest?.('.pop-anchor') && (menu || cats || catBusy)) shut();
    // the search sheet: a click outside the pill and the sheet closes it (and the field)
    if (sheetOpen && el?.isConnected && !inSearch(el)) leaveField(false);
  }
  /** a sheen (lib/glass/pointer.ts) moved into the host's `.sclip` layer, which clips it to the host's shape: the hosts here
   * must not clip themselves (the pill's menu hangs below it and its background halves reach past it while they slide; the
   * bell's unread count sits over its edge) */
  function clipSheen(node: HTMLElement) {
    const a = sheen(node);
    const s = node.querySelector<HTMLElement>(':scope > .frost-sheen');
    if (s) node.querySelector(':scope > .sclip')?.appendChild(s);
    return a;
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
  // (and on the set of tabs: Live-TV arriving with /api/me shifts the tabs after Filme, so the fill is placed again once they are drawn)
  let placedFor = '', placedTabs = '';
  $: tabKey = tabs.map((x) => x[0]).join('|');
  $: if ((path !== placedFor || tabKey !== placedTabs) && pill && fill) { placedFor = path; placedTabs = tabKey; void tick().then(() => placeFill(true)); }

  // ---- search inside the pill (spec §1): the magnifier is the pill's last item; opening it makes the pill itself grow with a
  // spring and the field appears at its right end. On /search typing drives /search?q= (no second input on that page);
  // anywhere else the field is the combobox of the search sheet (glass spec §2) and Enter goes to /search?q=. ----
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
  function onSearchInput() {
    activeId = null;
    if (path === '/search') { clearTimeout(st); st = setTimeout(() => commitSearch(q), 220); }
  }
  /** Enter (and the magnifier with the cursor in the field): the active hit, else /search?q= */
  function submitSearch() {
    if (sheetOpen && activeId) { document.getElementById(activeId)?.click(); return; }
    if (path !== '/search') pushRecent(getActiveProfile(), q);
    commitSearch(q);
  }
  /** shrinks the pill back (on /search the field stays open, narrowed) and puts the focus on the magnifier */
  function closeSearch() {
    searchOpen = path === '/search'; focused = false;
    sync();
    magBtn?.focus();
  }
  function onSearchKey(e: KeyboardEvent) {
    // Tab off the field's last control (✕) moves into the sheet's controls (it closes when the focus leaves the sheet)
    if (e.key === 'Tab' && !e.shiftKey && sheetOpen && e.target === xBtn && sheetCmp?.focusFirst()) { e.preventDefault(); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sheetOpen && e.target === searchEl) {
      e.preventDefault();
      activeId = nextId(sheetIds, activeId, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    activeId = null;
    if (q) { q = ''; commitSearch(''); } else closeSearch();
  }
  function onClose() { if (q) { q = ''; commitSearch(''); } closeSearch(); }
  /** opens the field and puts the cursor in it (the magnifier, "/" and Ctrl/Cmd+K via the layout) */
  export function openSearch() {
    if (!library) return; // the search looks through the library
    searchOpen = true; focused = true; shut();
    sync();
    searchEl?.focus();
  }
  /** closed, narrowed or not focused: the magnifier puts the cursor in the field; with the cursor in it, it searches */
  function onMag() {
    if (!open || compact || document.activeElement !== searchEl) openSearch(); // (mousedown on it keeps the focus where it was)
    else submitSearch();
  }
  // ---- the search sheet (glass spec §2): open with the field, off /search; the field's arrows move its active hit ----
  $: sheetOpen = searchOpen && path !== '/search';
  let activeId: string | null = null, sheetIds: string[] = [];
  $: if (!sheetOpen) activeId = null;
  function onSheetItems(e: CustomEvent<{ ids: string[] }>) {
    sheetIds = e.detail.ids;
    if (activeId && !sheetIds.includes(activeId)) activeId = null;
  }
  /** a hit, poster, person, genre or All results was chosen: remember the query, close (the link navigates) */
  function onSheetPick() {
    pushRecent(getActiveProfile(), q);
    leaveField(false);
  }
  /** Esc inside the sheet: the focus goes back to the field; the dim: close */
  function onSheetClose(e: CustomEvent<{ focus: 'field' | 'after' | null }>) {
    if (e.detail.focus === 'field') { searchEl?.focus(); return; }
    // Tab off the sheet's last control: close, and the focus goes on to what follows the field (the bell)
    leaveField(false);
    if (e.detail.focus === 'after') root?.querySelector<HTMLElement>('.right button')?.focus();
  }
  /** a recent search chip: into the field */
  function onSheetFill(e: CustomEvent<{ q: string }>) {
    q = e.detail.q; activeId = null;
    searchEl?.focus();
  }
  /** the focus moved somewhere outside the pill and the sheet (e.g. Tab out of the sheet): close */
  function onWindowFocusIn(e: FocusEvent) {
    if (sheetOpen && e.target instanceof Node && e.target !== document.body && !inSearch(e.target)) leaveField(false);
  }

  // the focus inside the field (input or ✕): a narrow window may fold the tabs away for it
  let focused = false;
  const inField = (n: EventTarget | null) => !!n && (n === searchEl || n === xBtn);
  /** inside the field or the search sheet (the focus moving between them keeps both open) */
  const inSheet = (n: EventTarget | null) => n instanceof Node && !!document.getElementById('ds-sheet')?.contains(n);
  const inSearch = (n: EventTarget | null) => inField(n) || inSheet(n) || (n instanceof Node && !!pill?.contains(n));
  function onFocusIn(e: FocusEvent) { if (inField(e.target) && !focused) { focused = true; sync(); } }
  function onFocusOut(e: FocusEvent) {
    if (inField(e.relatedTarget) || inSheet(e.relatedTarget)) return;
    if (e.relatedTarget) { leaveField(e.relatedTarget === magBtn); return; }
    // no new target: a click on something unfocusable, or the window itself lost the focus (alt-tab, another browser tab).
    // The latter keeps the field and its text as they are (the focus comes back to it with the window): look once it settled.
    clearTimeout(blurT);
    blurT = setTimeout(() => { if (document.hasFocus() && !inField(document.activeElement) && !inSheet(document.activeElement)) leaveField(false); }, 0);
  }
  let blurT: ReturnType<typeof setTimeout> | undefined;
  /** the focus left the field for somewhere else on the page */
  function leaveField(toMag: boolean) {
    focused = false; activeId = null;
    // off /search that closes the field, also within the typing pause (the pending search is dropped, so a late navigation
    // cannot reopen it); on /search it stays open, unfocused
    if (path !== '/search' && !toMag) { clearTimeout(st); q = ''; searchOpen = false; }
    sync();
  }

  // ---- the pill's shape: applied state (what the markup shows) vs. what it should be; changes go through morph() ----
  let track: HTMLElement, form: HTMLElement, pbg: HTMLElement, bgL: HTMLElement, bgR: HTMLElement, grainR: HTMLElement, bwin: HTMLElement, blur: HTMLElement;
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
   * FLIP, transform only: the layout jumps to the new shape at once; every part that moved (the glass, the tab track, each
   * tab, the field) keeps its place on screen through a translate that springs back to 0 (glide from lib/tv/motion: a change
   * mid-flight carries on from where things are, with their speed). Nothing scales, so the round ends keep their shape and
   * text never stretches.
   * The glass: at rest ONE pill-sized surface (.whole), with no edge inside it. A slide needs its two ends to move apart or
   * together, so for as long as one runs the glass is drawn by two halves instead (each one the whole material with one
   * round end, the left one carrying the left end, the right one the right end). They do not meet in a cut: a cut that falls
   * between two device pixels leaves that column with both halves or neither (a 1 px line, lighter or darker depending on the
   * renderer, and moving layers are clipped to whole device pixels). Instead each fades out over the same few pixels in the
   * middle while the other fades in, and the two are added up (plus-lighter): as they are the same material there, with the
   * grain of both kept to the left end as the surface's is, the sum is the material itself, wherever the pixels fall. Both
   * look exactly like the surface at either end of the slide, so the swap shows nothing. When the last spring has
   * settled the surface comes back. The one blur under the glass follows both ends exactly (follow: its window moves with
   * the right end, the blur itself with the left end), so its ends are always the glass's ends.
   */
  function morph(change: () => void, animate: boolean) {
    const parts = [bgL, bgR, track, form, ...(track ? [...track.children].filter((c) => !c.classList.contains('fill')) as HTMLElement[] : [])].filter(Boolean);
    if (!animate || motionLevel() === 'reduced' || !pill) {
      [bwin, blur, grainR, ...parts].filter(Boolean).forEach((p) => halt(p));
      splitGen++; split = false;
      change(); flushSync();
      void placeFill(false);
      return;
    }
    const before = parts.map(layoutX);
    change(); flushSync();
    // (all measured before any glide starts: a tab's x is relative to the track, whatever the track itself does)
    const after = parts.map(layoutX);
    parts.forEach((p, i) => glide(p, 'x', () => before[i]! - after[i]!));
    if (bwin && blur) { follow(bwin, 'x', [bgR], ([r]) => r!); follow(blur, 'x', [bgL, bgR], ([l, r]) => l! - r!); }
    if (grainR) follow(grainR, 'x', [bgL, bgR], ([l, r]) => l! - r!);
    slideGlass();
    void placeFill(true);
  }

  // ---- the glass while it slides: two halves, from the first frame of a slide to the frame its last spring settles ----
  let split = false, splitGen = 0;
  /** the glass's width: the right half's grain offset (its grain starts where the surface's does) */
  function measureGlass() {
    if (pbg) pbg.style.setProperty('--pw', `${+pbg.getBoundingClientRect().width.toFixed(4)}px`);
  }
  function slideGlass() {
    const gen = ++splitGen;
    if (!bgL || !bgR || !(moving(bgL) || moving(bgR))) { split = false; return; } // nothing slides: the surface stays
    measureGlass();
    split = true; flushSync(); // (in this task: the frame that shows the new layout already shows the halves)
    // checked before each frame is drawn, after the animations' own finish (the frame where they end shows the surface)
    const wait = () => { if (gen !== splitGen) return; if (moving(bgL) || moving(bgR)) requestAnimationFrame(wait); else split = false; };
    requestAnimationFrame(wait);
  }

  let sheetCmp: SearchSheet | undefined, selA: number | null = null;
  onMount(() => {
    // the tab fill's light is the --fr-sel token: drawn opaque, the token's alpha as the group opacity (overlaps never add up)
    selA = alphaOf(getComputedStyle(pill).getPropertyValue('--fr-sel'));
    // a retarget, not a jump: a slide in flight keeps going
    sync(false);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { void placeFill(true); sync(false); if (split) measureGlass(); }) : null;
    ro?.observe(pill);
    ro?.observe(root);
    return () => ro?.disconnect();
  });
  onDestroy(() => { splitGen++; clearTimeout(st); clearTimeout(blurT); clearTimeout(safeT); });
</script>

<svelte:window bind:scrollY on:keydown={onWindowKey} on:click={onWindowClick} on:focusin={onWindowFocusIn} />

<header class="nav desk" class:solid class:still data-desk-bar bind:this={root}>
  <span class="scrim" aria-hidden="true"></span>
  <a class="logo" href={home} aria-label={$t('shell.nav.homeLink')}><Logo header size={30} /></a>
  <nav class="pill" class:on={fillOn} class:open class:compact class:collapse class:empty={!library && !tabs.length} class:lib-held={held} class:lib-in={fadeIn} aria-label={$t('shell.nav.main')} bind:this={pill} style:--fw="{fw}px" style:--fwc="{open ? fw : lastFw}px" style:--sel-a={selA ?? undefined} use:clipSheen>
    <!-- the background: at rest ONE glass surface the size of the pill (.whole, no edge inside it); while the pill changes size
         two glass halves instead, each with one of its round ends, that slide (never scale) and cross-fade into each other in
         the middle (see morph). Over the billboard (not yet scrolled) with the safe scrim. Under the glass ONE blur, painted
         first: its own rounded left end is the glass's left end, its window's rounded right end the right end (two blurs side
         by side or overlapping never match: a backdrop-filter reads everything painted before it in its box, so a second one
         blurs the first one's output again, and each one's edge reads only its own side: a step wherever they meet) -->
    <span class="pbg" class:split aria-hidden="true" bind:this={pbg}><span class="bwin" bind:this={bwin}><i class="blur" bind:this={blur}></i></span><i class="frost whole" class:frost-safe={safe}></i><span class="halves"><span class="half l"><i class="frost" class:frost-safe={safe} bind:this={bgL}></i></span><span class="half r"><i class="frost" class:frost-safe={safe} bind:this={bgR}><b class="grain" bind:this={grainR}></b></i></span></span></span>
    <span class="sclip" aria-hidden="true"></span>
    <div class="track" bind:this={track}>
      <span class="fill" aria-hidden="true" bind:this={fill}><i class="cap"></i><i class="mid" bind:this={mid}></i><i class="cap" bind:this={capR}></i></span>
      {#each tabs as [href, label] (href)}<a {href} class="tab" class:active={href === act} class:gone={collapse && href !== act} aria-current={href === act ? 'page' : undefined}>{$t(navLabel(label, $features.requests))}</a>{/each}
      {#if library}<div class="pop-anchor" class:gone={collapse} on:focusout={onAnchorOut}>
        <!-- a disclosure (links and filters in a region), not a menu: no aria-haspopup -->
        <button type="button" class="tab cbtn" aria-expanded={cats} aria-controls={cats ? 'ff-cats' : undefined} aria-busy={catBusy || undefined} bind:this={catBtn} on:click={toggleCats} on:pointerenter={loadCats} on:focus={loadCats}>{$t('shell.nav.categories')}<span class="cmark" aria-hidden="true"><i class="caret" class:up={cats} class:hide={catBusy}></i>{#if catBusy}<span class="spinner"></span>{/if}</span></button>
        {#if cats}
          <div class="drop catdrop frost frost-menu frost-safe" id="ff-cats" role="region" aria-label={$t('shell.cats.title')} tabindex="-1" style="--fr-scrim-safe:{SCRIM_MENU}" transition:growBoth={{ trigger: catBtn }}>
            <div class="cseg">
              <div class="seg" role="group" aria-label={$t('shell.cats.kind')}>
                <button type="button" class:on={catKind === 'movies'} aria-pressed={catKind === 'movies'} on:click={() => (catKind = 'movies')}>{$t('common.movies')}</button>
                <button type="button" class:on={catKind === 'series'} aria-pressed={catKind === 'series'} on:click={() => (catKind = 'series')}>{$t('common.series')}</button>
              </div>
              <a class="coll" href="/collections">{$t('shell.cats.collections')}</a>
            </div>
            <div class="ccols">
              <section aria-labelledby="cg-h"><h2 id="cg-h" class="ch">{$t('shell.cats.genres')}</h2>
                {#if !catGenres?.length}<p class="muted pad">{$t('shell.cats.none')}</p>
                {:else}<ul class="glist">{#each catGenres as g (g)}<li><a href={categoryHref(catKind, g)}>{g}</a></li>{/each}</ul>{/if}
              </section>
              <section aria-labelledby="cl-h"><h2 id="cl-h" class="ch">{$t('shell.cats.byLanguage')}</h2>
                {#if !catLangs?.length}<p class="muted pad">{$t('shell.cats.none')}</p>
                {:else}<ul class="glist">{#each catLangs as c (c)}<li><a href="/browse/{catKind}?audio={encodeURIComponent(c)}">{langLabel(c)}</a></li>{/each}</ul>{/if}
              </section>
            </div>
          </div>
        {/if}
      </div>{/if}
    </div>
    {#if library}<form class="psearch" role="search" bind:this={form} on:submit|preventDefault={submitSearch} on:focusin={onFocusIn} on:focusout={onFocusOut}>
      <button type="button" class="mag" bind:this={magBtn} aria-label={open && !compact ? $t('shell.search.submit') : $t('shell.search.open')} on:mousedown|preventDefault on:click={onMag}><Icon name="search" size={18} /></button>
      <input id="hq" type="search" bind:this={searchEl} bind:value={q} autocomplete="off" enterkeyhint="search" placeholder={$t('shell.search.placeholder')} aria-label={$t('shell.search.label')} tabindex={open && !compact ? 0 : -1}
        role="combobox" aria-expanded={sheetOpen} aria-controls={sheetIds.length ? 'ds-list' : 'ds-sheet'} aria-autocomplete="list" aria-activedescendant={sheetOpen && activeId ? activeId : undefined}
        on:input={onSearchInput} on:keydown={onSearchKey} />
      <button type="button" class="x" bind:this={xBtn} aria-label={$t('desk.bar.close')} tabindex={open && !compact ? 0 : -1} on:mousedown|preventDefault on:click={onClose} on:keydown={onSearchKey}><Icon name="x" size={16} /></button>
    </form>{/if}
  </nav>
  <div class="right">
    <div class="pop-anchor">
      <!-- the notifications: a side sheet (a modal dialog, portalled to <body>); the focus comes back here when it closes -->
      <button type="button" class="round frost" class:frost-safe={safe} aria-label={unread ? $t('shell.bell.unread', { n: unread }) : $t('shell.bell.label')} aria-haspopup="dialog" aria-expanded={bell} aria-controls={bell ? 'ff-notes' : undefined} bind:this={bellBtn} on:click={toggleBell} use:clipSheen>
        <span class="sclip" aria-hidden="true"></span><Icon name="bell" size={20} />{#if unread}<span class="dot">{badgeText(unread)}</span>{/if}
      </button>
      {#if bell}<NotificationSheet trigger={bellBtn} on:close={() => (bell = false)} />{/if}
    </div>
    <div class="pop-anchor" on:focusout={onAnchorOut}>
      <button type="button" class="avatar" aria-label={who ? $t('shell.account.labelWho', { name: who }) : $t('shell.account.label')} aria-haspopup="menu" aria-expanded={menu} disabled={!me} bind:this={acctBtn} on:click={toggleMenu} on:pointerenter={loadProfiles} on:focus={loadProfiles}><span class="face" style={faceStyle} aria-hidden="true">{initial(who)}</span></button>
      {#if menu && me}
        <div class="drop acct gm frost frost-menu frost-safe" role="menu" aria-label={$t('shell.account.label')} tabindex="-1" use:menuKeys={{ close: () => (menu = false), trigger: acctBtn }} style="--fr-scrim-safe:{SCRIM_MENU}" transition:growBoth={{ trigger: acctBtn }}>
          <!-- the person: who is watching, and whose account this is -->
          <div class="acct-who" role="none"><span class="face lg" style={faceStyle} aria-hidden="true">{initial(who)}</span><span class="who-t"><b>{who}</b><span>{me.name} · {me.roleLabel}</span></span></div>
          <hr class="gm-sep" />
          {#if multi}
            <div role="group" aria-labelledby="ff-acct-sw">
              <p class="gm-head" id="ff-acct-sw" role="none">{$t('shell.account.switchProfile')}</p>
              {#if me.profile}<button type="button" class="gm-row" role="menuitemradio" aria-checked="true" tabindex="-1" on:click={closeToAvatar}><span class="gm-ic"><span class="face xs" style={faceStyle} aria-hidden="true">{initial(me.profile.name)}</span></span><span class="gm-lbl">{me.profile.name}</span><span class="gm-val"><Icon name="check" size={20} /></span></button>{/if}
              {#each others ?? [] as p (p.id)}<a class="gm-row" href={switchHref(p.id)} role="menuitemradio" aria-checked="false" tabindex="-1" data-sveltekit-reload><span class="gm-ic"><span class="face xs" style="background:{avatarBg(p.avatar)}" aria-hidden="true">{initial(p.name)}</span></span><span class="gm-lbl">{p.name}</span><span class="gm-val">{#if p.hasPin}<Icon name="lock" size={16} label={$t('shell.account.withPin')} />{/if}</span></a>{/each}
              {#each { length: skelRows } as _, i (i)}<div class="gm-row skel" aria-hidden="true"><span class="gm-ic"><i class="sk-face"></i></span><span class="gm-lbl"><i class="sk-bar"></i></span></div>{/each}
            </div>
            <a class="gm-row" href="/profiles?manage=1" role="menuitem" tabindex="-1"><span class="gm-ic"><Icon name="users" size={20} /></span><span class="gm-lbl">{$t('shell.account.manageProfiles')}</span></a>
            <hr class="gm-sep" />
          {:else}
            <a class="gm-row" href="/profiles?manage=1" role="menuitem" tabindex="-1"><span class="gm-ic"><Icon name="users" size={20} /></span><span class="gm-lbl">{$t('shell.account.manageProfiles')}</span></a>
          {/if}
          <a class="gm-row" href="/me" role="menuitem" tabindex="-1"><span class="gm-ic"><Icon name="user" size={20} /></span><span class="gm-lbl">{$t('shell.menu.me')}</span></a>
          <a class="gm-row" href="/settings" role="menuitem" tabindex="-1"><span class="gm-ic"><Icon name="settings" size={20} /></span><span class="gm-lbl">{$t('shell.menu.accountSettings')}</span></a>
          <a class="gm-row" href="/devices" role="menuitem" tabindex="-1"><span class="gm-ic"><Icon name="monitor" size={20} /></span><span class="gm-lbl">{$t('shell.menu.devices')}</span></a>
          {#if canDownload}<a class="gm-row" href="/downloads" role="menuitem" tabindex="-1"><span class="gm-ic"><Icon name="download" size={20} /></span><span class="gm-lbl">{$t('shell.menu.downloads')}</span></a>{/if}
          {#if library}<button type="button" class="gm-row" role="menuitem" tabindex="-1" on:click={surprise}><span class="gm-ic"><Icon name="shuffle" size={20} /></span><span class="gm-lbl">{$t('shell.menu.surprise')}</span></button>{/if}
          <button type="button" class="gm-row" role="menuitem" tabindex="-1" on:click={openHelp}><span class="gm-ic"><Icon name="info" size={20} /></span><span class="gm-lbl">{$t('shell.menu.help')}</span></button>
          {#if admin}<a class="gm-row" href="/admin" role="menuitem" tabindex="-1"><span class="gm-ic"><Icon name="shield" size={20} /></span><span class="gm-lbl">{$t('shell.menu.admin')}</span></a>{/if}
          <hr class="gm-sep" />
          {#if lgApp}<button type="button" class="gm-row" role="menuitem" tabindex="-1" on:click={changeServer}><span class="gm-ic"><Icon name="refresh" size={20} /></span><span class="gm-lbl">{$t('shell.account.changeServer')}</span></button>{/if}
          <button type="button" class="gm-row" role="menuitem" tabindex="-1" on:click={logout}><span class="gm-ic"><Icon name="log-out" size={20} /></span><span class="gm-lbl">{$t('shell.account.logout')}</span></button>
        </div>
      {/if}
    </div>
  </div>
</header>

<SearchSheet bind:this={sheetCmp} {q} open={sheetOpen} anchor={pill} {activeId} on:items={onSheetItems} on:pick={onSheetPick} on:close={onSheetClose} on:fill={onSheetFill} />

<style>
  /* the bar itself never paints: no band across the page, only the pill and the round buttons carry a fill */
  .desk { --ease: var(--m-emph-out);
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
  /* the brand's name ellipsizes at 8.5 em (a 24-character name keeps the pill centred at 1280 px; "Nordlicht Kino" fits whole) */
  .logo { justify-self: start; display: inline-flex; align-items: center; min-height: 44px; filter: drop-shadow(0 1px 6px rgba(0, 0, 0, .45)); --logo-name-max: 8.5em; }

  /* ---- the pill: transparent itself; its look is the background layer (.pbg), so a size change can be played back by
     sliding that layer's two halves (transform only) while the content glides; the field lives at its right end ---- */
  .pill { position: relative; display: flex; align-items: center; gap: 0; padding: 4px; border-radius: 999px; border: 1px solid transparent; }
  /* nothing in it yet (a person without libraries before /api/me named Live TV): the pill waits unseen, then fades in */
  .pill { transition: opacity var(--m-d-s, 160ms) ease-out; }
  .pill.empty { opacity: 0; visibility: hidden; }
  .pbg { position: absolute; inset: -1px; pointer-events: none; }
  /* at rest: the glass is one surface, the pill's own shape */
  .pbg > .whole { position: absolute; inset: 0; box-sizing: border-box; border-radius: 999px; }
  /* while it slides (.split, set by morph for exactly as long as the springs run): the two halves instead. Only one of the two
     constructions is ever drawn, so nothing is painted twice */
  .halves { position: absolute; inset: 0; visibility: hidden; isolation: isolate; }
  .pbg.split > .halves { visibility: visible; }
  .pbg.split > .whole { visibility: hidden; }
  /* each half is a window from the middle outwards (far past the edge, so a larger shape mid-flight is not cut). The two
     overlap by FADE in the middle, where each fades out (mask) as the other fades in, and add up (plus-lighter, inside their
     own group): the same material at complementary strengths sums to the material, with no edge at any pixel position.
     Each window reaches 4 px past its fade, so where it is clipped it is already transparent. */
  /* (each window reaches above and below the pill, so the glass's drop shadow is not clipped away) */
  .half { --fade: 16px; position: absolute; top: -50px; bottom: -70px; overflow: hidden; mix-blend-mode: plus-lighter; }
  .half.l { left: -100vw; right: calc(50% - var(--fade) / 2 - 4px);
    -webkit-mask-image: linear-gradient(to left, transparent 4px, #000 calc(var(--fade) + 4px)); mask-image: linear-gradient(to left, transparent 4px, #000 calc(var(--fade) + 4px)); }
  .half.r { left: calc(50% - var(--fade) / 2 - 4px); right: -100vw;
    -webkit-mask-image: linear-gradient(to right, transparent 4px, #000 calc(var(--fade) + 4px)); mask-image: linear-gradient(to right, transparent 4px, #000 calc(var(--fade) + 4px)); }
  /* each half is glass (.frost: milk, grain, the light edge; solid without html.m-glass) over the one blur; both reach far past
     the middle, so they are the same material where they fade into each other */
  .half i { position: absolute; top: 50px; bottom: 70px; width: 100vw; box-sizing: border-box; }
  .half.l i { left: 100vw; border-radius: 999px 0 0 999px; border-right: 0; }
  .half.r i { right: 100vw; border-radius: 0 999px 999px 0; border-left: 0; overflow: hidden; }
  /* the grain: the left half's (its ::before) starts at the glass's left end, as the surface's does; the right half's is its
     own layer that keeps to the left end too (morph moves it by the left end's slide against the right one's; --pw: the
     glass's width), so the grain is one sheet across the middle and the same as the surface's at either end of the slide */
  .half.r > i::before { display: none; }
  .grain { position: absolute; z-index: -1; top: 0; bottom: 0; left: 0; right: -100vw; pointer-events: none;
    background-image: var(--fr-grain); background-position: calc(100vw - var(--pw, 100vw) + 1px) 0; opacity: var(--fr-grain-a); mix-blend-mode: overlay; }
  :global(html:not(.m-glass)) .grain, :global(html.tv) .grain, :global(html.kids) .grain { display: none; }
  /* the blur (glass spec §1.2, only with full motion) is one element under the glass (the surface or the halves); the glass
     never blurs (a later layer would blur the earlier one's milk). Its window reaches far to the left and ends in the pill's
     rounded right end (it moves with the right end); the blur inside starts with its own rounded end at the pill's left end
     (it moves with the left end) and reaches far to the right. Chrome rounds a backdrop-filter by its own box and one clipping
     ancestor only (a second rounded clip is cut square), so each end gets exactly one of those. */
  .bwin { position: absolute; top: 0; bottom: 0; left: -100vw; right: 0; overflow: hidden; border-radius: 0 999px 999px 0; }
  .bwin > i { position: absolute; top: 0; bottom: 0; left: 100vw; width: 100vw; border-radius: 999px 0 0 999px; }
  /* the glass never blurs itself: the one blur sits under it (the selectors outweigh the html.m-glass .frost rule) */
  :global(html) .pbg i.whole.frost, :global(html) .pbg .half > i.frost { -webkit-backdrop-filter: none; backdrop-filter: none; }
  :global(html.m-glass:not(.tv):not(.kids)) .bwin > i { -webkit-backdrop-filter: var(--fr-blur); backdrop-filter: var(--fr-blur); }
  /* the pill's sheen (lib/glass/pointer.ts), clipped to the pill's shape here (the pill itself does not clip) */
  /* (its own group: the sheen's blend mode would otherwise blend into the whole bar, and Chrome then drops the blur under
     the sheen, also while it is faded out: a darker band without blur where the pointer last was; headless, all of it) */
  .sclip { position: absolute; inset: -1px; border-radius: 999px; overflow: hidden; pointer-events: none; }
  .pill > .sclip { isolation: isolate; }
  .pill.open:not(.compact):focus-within .pbg i.frost { border-color: rgba(255, 255, 255, .6); } /* the field's focus ring (the input has no outline) */
  .track { position: relative; display: flex; align-items: center; height: 36px; }
  .fill { position: absolute; left: 0; top: 0; width: 36px; height: 36px; opacity: 0; transition: opacity 160ms ease-out; pointer-events: none; }
  /* the selection light (--fr-sel): drawn opaque and faded as a group to the token's alpha (--sel-a, read from --fr-sel on
     mount), so the overlapping parts never add up */
  .pill.on .fill { opacity: var(--sel-a, 0); }
  .fill i { position: absolute; top: 0; left: 0; height: 36px; background: #fff; }
  .fill .cap { width: 36px; border-radius: 50%; }
  .fill .mid { left: 18px; width: 100px; transform-origin: left center; transition: transform 340ms var(--ease); }
  .tab { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 16px; border-radius: 999px; font-size: .9rem; font-weight: 500; color: rgba(255, 255, 255, .78); white-space: nowrap; transition: color 160ms ease-out; }
  .tab:hover { color: #fff; }
  .tab.active { color: #fff; font-weight: 600; }
  .tab:focus-visible { outline: 2px solid #fff; outline-offset: 0; --ring-o: 0px; }
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
  .mag, .x { display: grid; place-items: center; flex: none; width: 36px; height: 36px; min-height: 36px; padding: 0; border-radius: 50%; background: transparent; color: rgba(255, 255, 255, .78); transition: none; }
  .mag:hover:not(:disabled), .x:hover:not(:disabled) { background: transparent; color: #fff; }
  .mag:active:not(:disabled), .x:active:not(:disabled) { transform: none; }
  .pill.open:not(.compact) .mag { color: #fff; }
  .mag:focus-visible, .x:focus-visible { outline: 2px solid #fff; outline-offset: 0; --ring-o: 0px; }
  .psearch input, .x { position: absolute; top: 0; opacity: 0; visibility: hidden; pointer-events: none; transform: translate3d(-8px, 0, 0);
    transition: opacity 90ms ease-in, transform 200ms var(--ease), visibility 0s linear 90ms; }
  .psearch input { left: 36px; width: calc(var(--fwc) - 36px); height: 36px; min-height: 36px; padding: 0 4px; box-sizing: border-box; border: 0; border-radius: 0; background: transparent; color: #fff; font: inherit; font-size: .9rem; }
  .psearch input::placeholder { color: rgba(255, 255, 255, .5); }
  .psearch input:focus-visible { outline: none; box-shadow: none; } /* the pill shows the open field */
  .psearch input::-webkit-search-cancel-button { display: none; }
  .x { left: var(--fwc); }
  .pill.open:not(.compact) .psearch input, .pill.open:not(.compact) .x { opacity: 1; visibility: visible; pointer-events: auto; transform: none;
    transition: opacity 180ms ease-out 60ms, transform 320ms var(--ease), visibility 0s; }
  .pill.open:not(.compact) .x { transition-delay: 140ms, 60ms, 0s; } /* the ✕ waits for the pill's end to reach it */
  .still .psearch input, .still .x, .still .track > .tab, .still .track > .pop-anchor, .still .track > .gone { transition: none; }

  /* ---- right side: bell, avatar ---- */
  .right { justify-self: end; display: flex; align-items: center; gap: 8px; }
  /* glass round buttons (.frost: the look; the blur from html.m-glass, solid without it); hover: the milk a little brighter */
  .round { position: relative; z-index: 1; display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; color: #fff; box-shadow: inset 0 1px 0 var(--fr-hi), var(--fr-shadow-card); }
  /* hover lights the edge (never more milk over the same scrim, glass spec §1.3; as .frost-btn:hover) */
  .round:hover:not(:disabled) { background: linear-gradient(180deg, rgba(var(--fr-milk-top), var(--fr-milk-a2)), rgba(var(--fr-milk), var(--fr-milk-a1))), rgba(var(--fr-scrim-rgb), var(--fr-scrim));
    border-color: rgba(255, 255, 255, .42); box-shadow: inset 0 1px 0 var(--fr-hi), inset 0 0 0 1px rgba(255, 255, 255, .14), var(--fr-shadow-card); }
  :global(html:not(.m-glass)) .round:hover:not(:disabled) { background: var(--fr-solid-hover); }
  .round .sclip { border-radius: 50%; }
  .round:focus-visible, .avatar:focus-visible { outline: 2px solid #fff; outline-offset: 2px; --ring-o: 2px; }
  :global(html:not(.tv)) .round:focus-visible { box-shadow: 0 0 0 6px var(--ring-dark); } /* the two-tone ring (app.css) over the glass button's own shadow */
  .dot { position: absolute; z-index: 2; top: -3px; right: -3px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 99px; display: grid; place-items: center; background: var(--acc-fill); color: #fff; font-size: .68rem; font-weight: 700; font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px rgba(18, 20, 24, .9); }

  .avatar { display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; background: transparent; border-radius: 10px; }
  .avatar:hover:not(:disabled) { background: transparent; }
  /* the initial is large bold text (19 px, 800): 3:1 is the bar over the lighter avatar colours (WCAG 1.4.3) */
  /* the profile avatar's default colour (lib/avatars.ts 'red'): a person's colour, not the brand accent */
  .face { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: linear-gradient(135deg, #ff6b81, #9a2440); font-size: 1.2rem; font-weight: 800; color: #fff; box-shadow: 0 0 0 1px rgba(255, 255, 255, .14); }
  .avatar[aria-expanded='true'] .face { box-shadow: 0 0 0 2px #fff; }

  /* ---- dropdowns: glass cards (glass spec §5: .frost .frost-menu, 8 px padding, 44 px rows with 12 px corners, hover = the light
     pill, 1 px separators) that grow out of their button (growBoth); the safe scrim for white rows on the light pill and .9 texts
     (SCRIM_MENU), as the billboard can sit behind them ---- */
  .pop-anchor { position: relative; }
  .drop { position: absolute; right: 0; top: calc(100% + 10px); min-width: 220px; padding: 8px; box-sizing: border-box; display: flex; flex-direction: column; outline: none;
    max-height: calc(100vh - var(--nav-total) - 16px); max-height: calc(100dvh - var(--nav-total) - 16px); overflow-y: auto; overscroll-behavior: contain; }
  .drop .muted { color: rgba(255, 255, 255, .9); }
  .catdrop a { display: flex; gap: 12px; align-items: center; padding: 8px 14px; border-radius: 12px; font-size: .9rem; font-weight: 600; color: #fff; min-height: 44px; box-sizing: border-box; }
  .catdrop a:hover { background: var(--fr-sel); color: #fff; text-decoration: none; }
  .catdrop a:focus-visible { outline: 2px solid #fff; outline-offset: -2px; box-shadow: inset 0 0 0 4px var(--ring-dark), 0 0 0 2px var(--ring-dark); }
  .pad { padding: 12px 16px; }
  /* the account menu: the shared menu anatomy (app.css .gm*: header line, 44 px rows, 24 px icon column) */
  .drop.gm { padding: 6px; }
  .acct { min-width: 280px; }
  .acct-who { display: flex; align-items: center; gap: 12px; padding: 12px 12px 10px; min-width: 0; }
  .face.lg { width: 44px; height: 44px; border-radius: 12px; font-size: 18px; flex: none; }
  .who-t { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .who-t > b { font-size: 16px; line-height: 1.2; font-weight: 700; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who-t > span { font-size: 13px; line-height: 1.2; font-weight: 500; color: rgba(255, 255, 255, .9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .face.xs { width: 24px; height: 24px; border-radius: 7px; font-size: 11px; flex: none; box-shadow: none; }
  /* placeholder rows while the profiles load: exactly a row's height; an opacity shimmer only (none in calm mode) */
  .gm-row.skel, .gm-row.skel:hover { cursor: default; background: transparent; }
  .skel i { display: block; border-radius: 7px; background: rgba(255, 255, 255, .16); animation: sk-pulse 1.2s ease-in-out infinite alternate; }
  .skel .sk-face { width: 24px; height: 24px; }
  .skel .sk-bar { width: 96px; height: 12px; border-radius: 6px; }
  @keyframes sk-pulse { from { opacity: 1; } to { opacity: .45; } }
  :global(html.m-still) .skel i { animation: none; }
  /* Categories while its lists load: a spinner in the caret's place (the button keeps its width) */
  .cmark { position: relative; display: inline-grid; place-items: center; }
  .caret.hide { visibility: hidden; }
  .cmark > .spinner { position: absolute; width: 12px; height: 12px; border-width: 2px; }
  .catdrop { left: 50%; right: auto; margin-left: calc(min(560px, 80vw) / -2); width: min(560px, 80vw); }
  .catdrop > .cseg, .catdrop > .ccols { padding: 8px 12px; }
  .cseg { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
  .seg { display: inline-flex; border: 1px solid rgba(255, 255, 255, .18); border-radius: 99px; overflow: hidden; }
  .seg button { background: transparent; border-radius: 0; min-height: 36px; padding: 0 16px; color: rgba(255, 255, 255, .9); font-weight: 600; }
  .seg button:hover:not(:disabled) { background: var(--fr-sel); color: #fff; }
  .seg button.on, .seg button.on:hover:not(:disabled) { background: #fff; color: #000; }
  .catdrop .coll { font-weight: 600; color: #fff; padding: 0 12px; min-height: 44px; display: inline-flex; align-items: center; border-radius: 999px; }
  .ccols { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
  .ch { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: rgba(255, 255, 255, .9); margin: 0 0 4px; font-weight: 600; }
  .glist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
  .ccols section:last-child .glist { grid-template-columns: 1fr; }
  .catdrop .glist a { min-height: 40px; padding: 0; font-size: .9rem; }
  .catdrop .glist a:hover { background: transparent; text-decoration: underline; }

  @media (max-width: 1100px) { .tab { padding: 0 12px; } }
  /* a narrow window: the tab links go, the pill keeps Categories and the search (magnifier + field) */
  @media (max-width: 900px) { .track > a.tab { display: none; } }
  @media (prefers-reduced-motion: reduce) {
    .fill, .fill .mid, .desk > .scrim, .psearch input, .x, .track > *, .caret { transition: none; }
  }
</style>
