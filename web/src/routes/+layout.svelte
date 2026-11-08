<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import '../app.css';
  import { onDestroy, onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { afterNavigate, beforeNavigate, goto, onNavigate } from '$app/navigation';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, ApiError, setActiveProfile, setCsrf, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import Footer from '#lib/Footer.svelte';
  import CastBar from '#lib/cast/CastBar.svelte';
  import { barVisible } from '#lib/cast/bar';
  import { castEngine, castSession } from '#lib/cast/engine';
  import { interceptWatch } from '#lib/native/watch';
  import { bindCastMediaSession } from '#lib/cast/mediasession';
  import { avatarBg, initial } from '#lib/avatars';
  import { cachedCalm, loadList, loadPrefs, prefs } from '#lib/stores';
  import { kidsMode } from '#lib/kids';
  import type ItemModalType from '#lib/ItemModal.svelte';
  import { loadModal, prefetchModal } from '#lib/lazy';
  import { startTvLink, type ToTv } from '#lib/remote';
  import { capsFrom, features, featuresFrom, kindFrom, serverCaps, serverKind } from '#lib/capabilities';
  import { setMeta } from '#lib/offline/db';
  import { focusEl, focusFirst, isBackKey, isEditable, startSpatial } from '#lib/spatial';
  import Intro from '#lib/Intro.svelte';
  import { loadIntroSettings, markSessionSeen, readSessionSeen, shouldPlayIntro } from '#lib/intro';
  import { mobile } from '#lib/viewport';
  import { isRailTop, isTabActive, TV_RAIL } from '#lib/menu';
  import { DESK_GUARD, deskPagePlan, frameGuard, framesIdle, framesResume, isDetailPage, motionLevel, motionTripped, stagger, tvPagePlan, VT_ART, watchFrames } from '#lib/tv/motion';
  import { motionAllowed } from '#lib/preview';
  import TvRail from '#lib/tv/TvRail.svelte';
  import DeskBar from '#lib/desk/DeskBar.svelte';
  import { deskActive, deskUi } from '#lib/desk/bar';
  import { historyIndex, trackNav } from '#lib/desk/back';
  import { railKey } from '#lib/tv/rail';
  import { categoryHref, kindFromPath, showsChips, type Kind } from '#lib/mobile';
  import { dialogKeys } from '#lib/actions';
  import { canRenderEarly, clearReloadFlag, earlyProfile, gateHref, hintOf, kidsRedirect, needsProfileGate, needsWelcome, readActive, readHint, readPicked, readReloading, welcomeHref, writeActive, writeHint } from '#lib/gate';
  import MobilePreviewSheet from '#lib/MobilePreviewSheet.svelte';
  import TabBar from '#lib/phone/TabBar.svelte';
  import { dragClose } from '#lib/phone/dragClose';
  import { chipsTucked, SOLID_AFTER } from '#lib/phone/logic';
  import { closePreview, previewSheet } from '#lib/previewSheet';
  import { isLocale, locale, pageEpoch, pickLocale, ready, setLocale, setMediaServer, t, type Locale } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';
  import LanguageGate from '#lib/LanguageGate.svelte';
  import ToastHost from '#lib/ui/ToastHost.svelte';
  import { flushDeferred } from '#lib/ui/action';
  import ConfirmHost from '#lib/ui/ConfirmHost.svelte';
  import ReauthHost from '#lib/auth/ReauthHost.svelte';
  import HealthBanner from '#lib/admin/HealthBanner.svelte';
  import { startBanner } from '#lib/admin/banner';
  import { saveLanguage } from '#lib/stores';
  import ProbeOverlay from '#lib/tizen/ProbeOverlay.svelte';
  import LgProbeOverlay from '#lib/webos/ProbeOverlay.svelte';
  import { isTizenApp } from '#lib/tizen/detect';
  import { installNavLock } from '#lib/tizen/navlock';
  import { exitLgApp, isLgApp, shouldExitOnBack } from '#lib/webos/detect';
  import { recordHistoryBase } from '#lib/webos/home';
  import { rememberLgProbeHome } from '#lib/webos/probehome';
  import { PLAY_ART_NAME, playTransition, takePlayArt } from '#lib/player/transition';

  let me: Me | null = null;
  /** The page renders before /api/me returns when the last answer allows it (see lib/gate.ts): its data requests start right away. */
  const bootHint = typeof location !== 'undefined' ? readHint() : null, bootProfile = earlyProfile(bootHint, typeof location !== 'undefined' ? readActive() : null);
  const early = typeof location !== 'undefined' && canRenderEarly(bootHint, readPicked(), location.pathname, bootProfile, readReloading());
  if (early) setActiveProfile(bootProfile); // early requests carry the profile this tab ran with (a switch elsewhere answers 409 → reload without early render)
  /** TV mode: big UI, D-pad navigation. On for paired televisions; `?tv=1` previews it in any browser (`?tv=0` ends the preview). */
  let tv = false, replaced = false;
  /** inside the LG app; set on mount (the server render has no window) */
  let lgApp = false;
  let pending = false, checking = false;
  let notes: Array<{ id: number; title: string; link?: string; read: boolean }> = [];
  let railOpen = false;
  let scrolled = false, help = false;
  let sentinel: HTMLElement;
  let online = true;
  let intro = false;
  // ---- UI language: the shell waits for the remembered language once; first admin visit / first login ask for a language ----
  let booted = false;
  $: if ($ready) booted = true;
  /**
   * Early render (before /api/me): the page may only mount once the language of the last /api/me answer (boot hint) is
   * active. Without /api/me the page mounts after the server language was applied (boot() awaits setLocale before `me`).
   * Either way the page mounts once in the right language; nothing re-creates it later (see pageEpoch in lib/i18n).
   */
  if (bootHint?.noRequests) features.set(featuresFrom({ requests: false })); // until /api/me answers: no request links flash
  let earlyLang = !(early && bootHint?.lang);
  if (early && bootHint?.lang) void setLocale(bootHint.lang).finally(() => (earlyLang = true));
  let pageReady = false; // sticky: a later language load (ready = false for a moment) must not unmount the page
  $: if (!pageReady && booted && (me || (early && earlyLang && $ready))) pageReady = true;
  let langAsk: 'instance' | 'profile' | null = null, langPre: Locale = 'de';
  async function chooseInstance(l: Locale) {
    await api('/api/admin/settings/language', { method: 'PUT', body: { language: l } });
    if (me?.languageChosen === false) await saveLanguage(l); // the admin is not asked a second time for their own profile
    if (me) me = { ...me, defaultLanguage: l, defaultLanguageSet: true, languageChosen: true };
    langAsk = null;
  }
  /** "Später": keep the instance default, but store it so the question does not come back */
  const skipLanguage = () => chooseProfile(isLocale(me?.defaultLanguage) ? me!.defaultLanguage as Locale : 'de');
  async function chooseProfile(l: Locale) {
    await saveLanguage(l);
    if (me) me = { ...me, language: l, languageChosen: true };
    langAsk = null;
  }
  $: canDownload = Boolean(me?.downloads?.allowed);
  $: multi = (me?.profileCount ?? 0) > 1;
  $: who = me ? (me.profile?.name ?? me.name) : '';
  $: faceStyle = me?.profile ? `background:${avatarBg(me.profile.avatar)}` : undefined;
  $: admin = Boolean(me?.isAdmin && me?.profile?.isOwner);
  /** kids profile: kids header, no footer links / tab bar / bell; the last /api/me answer decides until the fresh one arrives */
  $: kidsUi = me ? Boolean(me.kids) : Boolean(bootHint?.kids);
  $: if (typeof document !== 'undefined') document.documentElement.classList.toggle('kids', kidsUi);
  $: castBarOn = pageReady && !publicPage && barVisible({ path, tv, session: $castSession }); // where <CastBar> renders
  /**
   * `--castbar-h` on <html> while the bar shows: the page content gets room for it at its end (main on phones, the page below
   * the footer on desktop); the offline banner and the toasts move up by it
   */
  $: if (typeof document !== 'undefined') { const st = document.documentElement.style; if (castBarOn) st.setProperty('--castbar-h', '64px'); else st.removeProperty('--castbar-h'); }
  $: kidsMode.set(kidsUi); // shared flag for components (no social UI on kids profiles)
  // ---- phone: chip bar + "Kategorien" overlay (the desktop dropdown lives in DeskBar) ----
  let catOpen = false, catGenres: string[] | null = null, catKind: Kind = 'movies', catBtn: HTMLElement | null = null;
  /** the categories sheet is sliding out (still mounted); it unmounts on its transitionend or after CAT_OUT_MS */
  let catLeaving = false, catOutT: ReturnType<typeof setTimeout> | undefined;
  const CAT_OUT_MS = 280;
  function catGone() { clearTimeout(catOutT); catOutT = undefined; catLeaving = false; }
  onDestroy(() => clearTimeout(catOutT));
  // ---- phone header: glass once scrolled past SOLID_AFTER, chips tuck while scrolling down (rAF-throttled scroll listener) ----
  let mSolid = false, mTucked = false, lastY = 0, scrollRaf = 0;
  function readScroll() {
    scrollRaf = 0;
    const y = Math.max(0, window.scrollY);
    mSolid = y > SOLID_AFTER;
    mTucked = chipsTucked({ y, lastY, tucked: mTucked });
    lastY = y;
  }
  const onScroll = () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(readScroll); };
  /** the listener runs only while the phone header shows (phones, not TV) */
  let scrollOn = false;
  function syncScroll(on: boolean) {
    if (typeof window === 'undefined' || on === scrollOn) return;
    scrollOn = on;
    if (on) { window.addEventListener('scroll', onScroll, { passive: true }); readScroll(); }
    else { window.removeEventListener('scroll', onScroll); if (scrollRaf) cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
  }
  $: syncScroll($mobile && !tv);
  onDestroy(() => syncScroll(false));
  /** `html.m-glass`: blur behind the phone bars only with the full motion level; `html.m-still`: instant changes (reduced motion / calm) */
  const motionClasses = (_p: unknown, _m: boolean, _tripped = false) => {
    if (typeof document === 'undefined') return;
    const c = document.documentElement.classList;
    c.toggle('m-glass', motionLevel() === 'full');
    c.toggle('m-still', !motionAllowed());
  };
  $: motionClasses($prefs, $mobile, $motionTripped); // (the frame guard tripping drops the blur too)
  onMount(() => {
    // a system-wide reduced-motion switch while the app is open
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onChange = () => motionClasses(null, false);
    mq?.addEventListener?.('change', onChange);
    return () => mq?.removeEventListener?.('change', onChange);
  });

  $: path = $page.url.pathname;
  // /setup: the wizard of a new install (no account yet); /setup/extras is not public (the first admin is signed in there)
  // /login, /reset, /confirm-email: the in-app sign-in, the recovery link and the e-mail change link (Block 23 phase 3); they never ask
  // /api/me (a 401 there would loop back to /auth/login → /login)
  $: publicPage = path.startsWith('/invite/') || path === '/tv' || path === '/offline' || path === '/pending' || path === '/restore' || path === '/setup' || path === '/login' || path === '/reset' || path === '/confirm-email';
  $: watchPage = path.startsWith('/watch/') || /^\/party\/[^/]+/.test(path); // immersive player pages: no navigation
  $: showRail = tv && !watchPage && !profilesPage && !kidsUi;
  // only the rail's own destinations, without a filter (a genre page from the home categories row is a drill-down: Back goes back)
  $: topLevel = !publicPage && isRailTop(path, $page.url.search); // (the prerendered /offline page has no search params)
  $: if (!showRail) railOpen = false;
  $: profilesPage = path === '/profiles' || path === '/welcome'; // full-screen pages without navigation (picker, onboarding)
  $: heroPage = path === '/' || path.startsWith('/item/');
  $: kidsPage = path === '/kids' || path.startsWith('/kids/'); // full-bleed bright kids pages (own background and spacing)
  // Block 22: warning banner for an admin on the owner profile; never in TV mode, on player/party/profile/public pages or kids profiles
  $: showBanner = admin && !tv && !watchPage && !profilesPage && !publicPage && !kidsUi && !pending;
  let stopBanner: (() => void) | null = null;
  $: if (showBanner && !stopBanner) stopBanner = startBanner();
  $: if (!showBanner && stopBanner) { stopBanner(); stopBanner = null; }
  $: unread = notes.filter((n) => !n.read).length;
  $: if (path) { catOpen = false; catGone(); closePreview(); }
  $: chips = $mobile && showsChips(path) && !kidsUi;
  // kids profiles stay on kids routes, new profiles go through /welcome once (both also checked in boot() before the page mounts)
  $: if (me && !pending && !publicPage) {
    const to = kidsRedirect(me, path) ?? (needsWelcome(me, path) ? welcomeHref(path + $page.url.search, me.kids) : null);
    if (to) void goto(to, { replaceState: true });
  }
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('m-chips', chips && !watchPage && !profilesPage);
    document.documentElement.style.overflow = catOpen ? 'hidden' : ($previewSheet ? 'hidden' : ''); // no page scroll behind the overlay / sheet
  }
  // the web app manifest (name, shortcuts) follows the UI language
  $: if (typeof document !== 'undefined') document.querySelector('link[rel="manifest"]')?.setAttribute('href', `/manifest.webmanifest?lang=${$locale}`);
  $: if (!$mobile) { catOpen = false; catGone(); closePreview(); }
  /** desktop shell (pill bar; later the desktop browse pieces): not on TV, phones or kids profiles */
  $: desk = deskUi({ tv, mobile: $mobile, kids: kidsUi });
  $: deskActive.set(desk); // openModal and the detail route follow it (desktop: titles open as the full page)
  /** the phone shell (tab bar, carousel, preview sheet): phones, not TV, not kids profiles */
  $: phoneShell = $mobile && !tv && !kidsUi;
  // desktop and the phone shell: the same frame-budget guard as the TV (spec 5.2; phones with the desktop budget, spec 2026-11-08
  // Motion); it only samples frames while something moves (page transitions, row glides, stagger, the carousel spring) and
  // drops the session to the reduced set when it cannot keep up
  let deskGuard: (() => void) | null = null;
  $: if (typeof window !== 'undefined') syncDeskGuard(desk || phoneShell);
  function syncDeskGuard(on: boolean) {
    if (on && !deskGuard) {
      deskGuard = frameGuard(DESK_GUARD); // a looser budget than the TV's: a steady 30 fps desktop keeps its motion
      // armed idle: boot work (/api/me, hydrating the rows) is no animation; only real motion (page transitions, glides,
      // stagger) opens a watch window. On a TV the TV boot's own frameGuard() call pulses as before.
      framesIdle();
    }
    // (on a TV the guard stays on: the TV boot starts its own, and stopping this one would stop that too; it is one switch)
    else if (!on && deskGuard) { if (!tv) deskGuard(); deskGuard = null; }
  }
  onDestroy(() => { if (deskGuard && !tv) deskGuard(); deskGuard = null; });
  $: if (!publicPage) document.documentElement.classList.toggle('tv', tv);

  // ---- detail popup: loaded on first use (or prefetched on hover/focus/touch of a card), not part of the layout chunk ----
  let Modal: typeof ItemModalType | null = null;
  $: modalId = $page.state.modalId;
  $: if (modalId && !Modal) {
    const id = modalId;
    loadModal().then((m) => (Modal = m.default)).catch(() => { location.href = `/item/${id}`; }); // chunk gone (new deploy/offline): open the full page
  }

  async function loadNotes() { if (me?.kids) return; try { notes = (await api('/api/notifications')).notifications; } catch { /* ignore */ } } // kids: 403 kids_profile
  $: here = publicPage ? path : path + $page.url.search; // (the prerendered /offline page has no search params)
  const HELP = [['shell.help.searchT', 'shell.help.searchD'], ['shell.help.playerT', 'shell.help.playerD'], ['shell.help.deviceT', 'shell.help.deviceD'], ['shell.help.tvT', 'shell.help.tvD'], ['shell.help.languageT', 'shell.help.languageD'], ['shell.help.moreT', 'shell.help.moreD']] as const;

  // ---- search hotkeys: the desktop bar opens its field, phones go to the search page ----
  let deskBar: DeskBar | undefined;
  function openSearch() {
    if ($mobile) { void goto('/search'); return; }
    deskBar?.openSearch();
  }
  async function openCats(e: Event) {
    catBtn = e.currentTarget as HTMLElement; catKind = kindFromPath(path); catGone(); catOpen = true;
    await tick();
    document.querySelector<HTMLElement>('.cats .close')?.focus();
    void fetchGenres();
  }
  async function fetchGenres() { if (!catGenres) { try { catGenres = ((await api('/api/library/genres')).genres as string[]) ?? []; } catch { catGenres = []; } } }
  /** closing slides the sheet out and fades the dim (ease-in); instant with reduced motion / calm mode */
  function closeCats(refocus = true) {
    if (!catOpen) return;
    catOpen = false;
    if (motionAllowed()) { catLeaving = true; clearTimeout(catOutT); catOutT = setTimeout(catGone, CAT_OUT_MS + 80); }
    if (refocus) catBtn?.focus();
  }
  function catOutEnd(e: TransitionEvent) { if (catLeaving && e.target === e.currentTarget && e.propertyName === 'transform') catGone(); }
  function pickCat(href: string) { catOpen = false; catGone(); void goto(href); }
  function onKey(e: KeyboardEvent) {
    // "/" and Ctrl/Cmd+K jump to the search field (not while typing somewhere else)
    if (!watchPage && !tv && ((e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) {
      const el = e.target as HTMLElement | null;
      const typing = el && (isEditable(el) || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (!typing || e.key !== '/') { e.preventDefault(); openSearch(); return; }
    }
    // LG app, unpaired pairing page (not yet TV mode): Back returns to the app's start page, which shows the setup form
    if (!tv && path === '/tv' && isBackKey(e) && isLgApp()) { e.preventDefault(); history.back(); return; }
    const back = e.key === 'Escape' || (tv && isBackKey(e));
    if (!back) return;
    // TV: Back/Escape walks one step back (the detail popup closes itself on Escape; the player handles its own keys)
    if (tv && !watchPage && !(e.key === 'Escape' && $page.state.modalId) && !isEditable(e.target as Element)) {
      e.preventDefault();
      // top-level pages: Back opens the side bar first; with the bar open it closes it (on home: leaves the LG app)
      if (showRail && !$page.state.modalId && (railOpen || topLevel)) {
        const r = railKey({ open: railOpen }, { key: 'back', atLeftEdge: false, inRail: railOpen, onHome: path === '/' });
        railOpen = r.state.open;
        if (r.action === 'exitPrompt' && isLgApp() && shouldExitOnBack({ path, modalId: $page.state.modalId, dropdownOpen: false, editable: false })) exitLgApp();
        return;
      }
      if (isLgApp() && shouldExitOnBack({ path, modalId: $page.state.modalId, dropdownOpen: false, editable: false })) exitLgApp(); // Back on home leaves the LG app
      else if (path !== '/' || $page.state.modalId) history.back();
    }
  }

  // ---- commands from the phone (only on a paired TV) ----
  function onTvCommand(m: ToTv) {
    if (m.t === 'cast') goto(`/watch/${m.itemId}${m.startSec ? `?t=${m.startSec}` : ''}`);
    else if (m.action === 'home' || m.action === 'stop') goto('/');
    else window.dispatchEvent(new CustomEvent('ff-remote', { detail: m })); // the player listens
  }

  // deferred actions (decline/revoke with an Undo window) commit right away when the person leaves the page (other route,
  // reload, closing the tab: willUnload sends keepalive requests); a pagehide listener in lib/ui/action.ts covers the rest
  beforeNavigate(({ from, to, willUnload }) => {
    if (willUnload || from?.url.pathname !== to?.url.pathname) flushDeferred(willUnload);
  });

  // ---- Android app: a watch page reached inside the page (episode cards, history, cast bar, goto) plays in the native player ----
  beforeNavigate((nav) => {
    const c = get(castSession);
    interceptWatch(nav, (u) => void goto(u.pathname + u.search), { castActive: Boolean(c && c.state !== 'failed') });
  });

  // ---- TV focus memory: coming back (Back key) puts the focus on the card you left, a new page focuses its first element ----
  // Desktop: the same memory for the card (or preview / billboard) a title was opened from; Back focuses that card again.
  type Spot = { href: string; nth: number; sec: string };
  const memo = new Map<string, Spot>();
  /** the kind of section a link sits in (TV: its classes; desktop: its label, the classes change with lazy rendering) */
  const secOf = (a: Element) => { const s = a.closest('section'); return !s ? '' : tv ? s.className : s.getAttribute('aria-label') ?? s.className; };
  /** the links to a href, narrowed to those in the same kind of section: rows load lazily, so a link to the same href in a row
   *  that was not there yet when the viewer left (e.g. a genre row's "See all" next to the categories row) must not shift the count */
  const sameSpot = (href: string, sec: string) => [...document.querySelectorAll<HTMLElement>(`main a[href="${CSS.escape(href)}"]`)].filter((a) => secOf(a) === sec);
  /** desktop: the element the last click / Enter landed on (a hover preview is not focusable, the focus says nothing there) */
  let lastClick: { el: Element; at: number } | null = null;
  /** desktop: what the page being left was opened from (morph source and focus memory), set when a navigation starts */
  let deskFrom: Element | null = null;
  /** desktop: the clicked element (recent click, else the focus); in the hover preview it stands for the card under it */
  function deskOrigin(): { click: Element | null; link: HTMLElement | null } {
    const recent = lastClick && performance.now() - lastClick.at < 1000 && lastClick.el.isConnected ? lastClick.el : null;
    const c = recent ?? document.activeElement;
    if (!(c instanceof Element) || c === document.body) return { click: null, link: null };
    const link = c.closest('.dpv') ? document.querySelector<HTMLElement>('main .card.dpv-src a.thumb')
      : c.closest('main .card')?.querySelector<HTMLElement>('a.thumb') ?? c.closest<HTMLElement>('main a[href]');
    return { click: c, link };
  }
  beforeNavigate(({ from }) => {
    let el = document.activeElement as HTMLElement | null;
    if (desk) { const o = deskOrigin(); deskFrom = o.click; el = o.link; framesIdle(); } // (the frame guard: a page is being built)
    else if (phoneShell) framesIdle();
    const href = el?.getAttribute?.('href');
    if (desk && from && !href) memo.delete(from.url.pathname + from.url.search); // left by the bar etc.: no card to come back to
    if (!(tv || desk) || !from || !href) return;
    // the same title can appear in several rows: remember which occurrence it was
    const sec = secOf(el!);
    const nth = sameSpot(href, sec).indexOf(el!);
    if (nth >= 0) memo.set(from.url.pathname + from.url.search, { href, nth, sec });
  });
  /** waits for the page content (lazy rows, fetched lists), then focuses the remembered link, [data-autofocus] or the first element */
  let settleSeq = 0;
  async function settleFocus(want?: Spot, put: (el: HTMLElement) => void = focusEl) {
    const start = document.activeElement, my = ++settleSeq;
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, i ? 150 : 30));
      // a newer navigation settles its own page: this one must not put a focus there (e.g. Back right after a page opened)
      if (my !== settleSeq) return;
      const main = document.querySelector('main');
      // the focus was placed in the content meanwhile (a key, the pointer, the page itself): it stays there, a late
      // [data-autofocus] (e.g. the home focus tile's Play once the hero has loaded) must not pull it away
      const now = document.activeElement;
      if (now instanceof HTMLElement && now !== start && now !== document.body && main?.contains(now)) return;
      if (want) {
        const el = sameSpot(want.href, want.sec)[want.nth];
        if (el) return put(el);
      } else if (main?.querySelector('[data-autofocus]') ? focusFirst(main, false) : i >= 4 && focusFirst(main, false)) return;
    }
  }
  afterNavigate((nav) => {
    const { to, type } = nav;
    trackNav({ type, delta: 'delta' in nav ? (nav.delta as number) : undefined, index: historyIndex(history.state) }); // the desktop detail page's "‹ Back" (in-app history or home)
    settleSeq++; // every navigation ends an older settle (also into the player, which places its own focus)
    if (!to || /^\/(watch|party)\//.test(to.url.pathname)) return;
    if (tv) void settleFocus(type === 'popstate' ? memo.get(to.url.pathname + to.url.search) : undefined);
    // desktop: only Back puts the focus somewhere (on the card the title was opened from; the row keeps its page: no scrolling)
    else if (desk && type === 'popstate') {
      const want = memo.get(to.url.pathname + to.url.search);
      if (want) void settleFocus(want, (el) => el.focus({ preventScroll: true }));
    }
  });

  // ---- page transitions: View Transitions API where available (180 ms crossfade, main content rises 8 px; see app.css) ----
  const immersive = (p: string) => /^\/(watch|party)\//.test(p);
  const isWatch = (p: string) => p.startsWith('/watch/');
  // A transition started while another runs skips the first one, whose `finished` then settles: only the latest transition may
  // clean up the shared root classes, and each one only takes the shared name off the elements it named (unless the latest named them too).
  const VT_CLASSES = ['ff-vt', 'ff-vt-play', 'ff-vt-in', 'ff-vt-plain', 'ff-vt-tv', 'ff-vt-slide', 'ff-vt-art', 'ff-vt-sub', 'ff-vt-desk', 'ff-vt-desk-back'];
  let vtSeq = 0, vtNamed = new Set<HTMLElement>();
  const vtClear = () => { const root = document.documentElement; root.classList.remove(...VT_CLASSES); root.style.removeProperty('--ff-vt-dx'); };
  /** a new transition begins: whatever an earlier one left on the root goes, and its token is the only one that may clean up */
  function vtBegin(): number {
    vtClear();
    for (const el of vtNamed) el.style.removeProperty('view-transition-name');
    vtNamed = new Set();
    return ++vtSeq;
  }
  function vtName(el: HTMLElement | null, name: string, mine: HTMLElement[]) { if (!el) return; el.style.setProperty('view-transition-name', name); mine.push(el); vtNamed.add(el); }
  function vtEnd(my: number, mine: HTMLElement[]) {
    const latest = my === vtSeq;
    for (const el of mine) if (latest || !vtNamed.has(el)) el.style.removeProperty('view-transition-name');
    if (latest) { vtClear(); vtNamed = new Set(); }
  }
  onNavigate((nav) => {
    const start = (document as Document & { startViewTransition?: (cb: () => Promise<void>) => { finished: Promise<unknown> } }).startViewTransition;
    const from = nav.from?.url.pathname ?? '', to = nav.to?.url.pathname ?? '';
    // into / out of the player: the clicked artwork grows into the player poster (shared name ff-play-art, see app.css and
    // lib/player/transition.ts). Without the API or with reduced motion the player page fades itself in; TV has no transition.
    if (nav.to && isWatch(to) !== isWatch(from) && !immersive(isWatch(to) ? from : to) && !intro) {
      const into = isWatch(to);
      // TV: the reduced set (frame guard tripped) keeps a plain crossfade without the artwork morph
      const mode = playTransition({ tv, reduced: tv ? !motionAllowed() : matchMedia('(prefers-reduced-motion: reduce)').matches, hasApi: typeof start === 'function', level: tv ? motionLevel() : 'full' });
      if (mode !== 'view' && mode !== 'crossfade') { if (into) takePlayArt(); return; }
      if (!into && desk && mode === 'view' && motionAllowed() && isDetailPage(to)) return deskFromPlayer(nav, start!);
      const root = document.documentElement, taken = into ? takePlayArt() : null, art = mode === 'view' ? taken : null;
      const my = vtBegin(), mine: HTMLElement[] = [];
      if (tv) watchFrames();
      return new Promise<void>((resolve) => {
        root.classList.add('ff-vt-play');
        if (into) root.classList.add('ff-vt-in');
        if (mode === 'crossfade') root.classList.add('ff-vt-plain'); // the player poster carries no shared name either
        vtName(art, PLAY_ART_NAME, mine); // this one element only, just for the transition
        const t = start!.call(document, async () => { resolve(); await nav.complete; });
        void t.finished.catch(() => undefined).finally(() => vtEnd(my, mine));
      });
    }
    if (tv) return tvTransition(nav, start);
    if (desk && (isDetailPage(from) || isDetailPage(to))) { const r = deskTransition(nav, start); if (r !== null) return r; }
    if (phoneShell && isDetailPage(to)) { const r = sheetTransition(nav, start); if (r !== null) return r; }
    if (typeof start !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // typing in the header search must not freeze the screen for a crossfade
    if (!nav.to || from === to || to === '/search' || immersive(from) || immersive(to) || intro) return;
    const root = document.documentElement, my = vtBegin();
    return new Promise<void>((resolve) => {
      root.classList.add('ff-vt'); // names <main> only for the duration of the transition
      const t = start.call(document, async () => { resolve(); await nav.complete; });
      void t.finished.catch(() => undefined).finally(() => vtEnd(my, []));
    });
  });

  // ---- TV page transitions (spec 5.2; plan in lib/tv/motion.ts): artwork -> detail backdrop morph, rail pages slide, else crossfade ----
  let pageFadeIn = false; // no View Transitions API (TV, desktop detail): the new page fades in (afterNavigate)
  const railAt = (p: string) => TV_RAIL.findIndex(([href]) => isTabActive(href, p));
  const onScreen = (el: Element | null | undefined): el is HTMLElement => {
    const r = el?.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  /** the artwork of a focused card or of the focus tile (the element that morphs into / out of the detail backdrop) */
  const artOf = (el: Element | null | undefined): HTMLElement | null => {
    if (!(el instanceof HTMLElement) || !el.closest('main')) return null;
    const img = el.closest('section.tile') ? document.querySelector('section.tile .layer.on img.bg') : el.closest('.card')?.querySelector('.thumb img:not(.blur)');
    return onScreen(img) ? img : null;
  };
  type Nav = Parameters<Parameters<typeof onNavigate>[0]>[0];
  type StartVT = (cb: () => Promise<void>) => { finished: Promise<unknown> };
  function tvTransition(nav: Nav, start: StartVT | undefined): Promise<void> | undefined {
    const from = nav.from?.url.pathname ?? '', to = nav.to?.url.pathname ?? '';
    if (!nav.to || intro || immersive(from) || immersive(to) || to === '/search') return;
    const plan = tvPagePlan({ from, to, back: nav.type === 'popstate', motion: motionAllowed(), level: motionLevel(), hasApi: typeof start === 'function', rail: [railAt(from), railAt(to)] });
    if (plan.kind === 'fade') pageFadeIn = true;
    if (plan.kind !== 'view' || !start) return;
    const root = document.documentElement, my = vtBegin();
    const named: HTMLElement[] = [];
    const name = (el: HTMLElement | null) => vtName(el, VT_ART, named);
    watchFrames();
    root.classList.add('ff-vt-tv');
    if (plan.slide) { root.classList.add('ff-vt-slide'); root.style.setProperty('--ff-vt-dx', `${plan.slide * 16}px`); }
    // a detail sub-screen: the content slides in from the right 24 px (Back: the other way) while the backdrop crossfades in place
    if (plan.sub) { root.classList.add('ff-vt-sub'); root.style.setProperty('--ff-vt-dx', `${plan.sub * 24}px`); }
    if (plan.morph) root.classList.add('ff-vt-art'); // names the detail backdrop ([data-vt-art]) on whichever side it is
    if (plan.morph === 'in') name(artOf(document.activeElement));
    const want = plan.morph === 'back' && nav.to ? memo.get(nav.to.url.pathname + nav.to.url.search) : undefined;
    return new Promise<void>((resolve) => {
      const t = start.call(document, async () => {
        resolve();
        // the screen holds still until the new page is there: never longer than 800 ms (a slow detail load must not freeze the TV)
        const until = performance.now() + 800;
        await Promise.race([nav.complete.catch(() => undefined), new Promise((r) => setTimeout(r, 800))]);
        // into the detail page: its title loads after the route did; wait (within the budget) until the hero is there, so the
        // backdrop exists when the new state is captured (the new state is live: the image may still finish loading during the morph)
        // (timers, not rAF: rendering is paused while the update callback runs)
        if (plan.morph === 'in') while (performance.now() < until && !document.querySelector('main .dv :is(.hero img.bg, h1)')) await new Promise((r) => setTimeout(r, 16));
        if (plan.morph === 'back' && my === vtSeq) { // (a newer transition took over meanwhile: name nothing for this one)
          await tick();
          const el = want ? sameSpot(want.href, want.sec)[want.nth] : null;
          name(artOf(el));
        }
      });
      void t.finished.catch(() => undefined).finally(() => vtEnd(my, named));
    });
  }
  // ---- desktop page transitions (spec desktop browse §3; plan in lib/tv/motion.ts): card / preview / billboard artwork <->
  // detail backdrop morph under the TV's shared name, then the detail text staggers in ----
  /** the picture that morphs: the hover preview's art, a card's / "More like this" tile's artwork, or the billboard backdrop */
  const deskArt = (el: Element | null | undefined): HTMLElement | null => {
    if (!(el instanceof HTMLElement)) return null;
    const pv = el.closest('.dpv');
    const pic = pv ? pv.querySelector<HTMLElement>('.dpv-art img.hi.on') ?? pv.querySelector<HTMLElement>('.dpv-art img:not(.blur):not(.tlogo)')
      : el.closest('main .card')?.querySelector<HTMLElement>('.thumb img:not(.blur)')
        ?? el.closest('main .mc')?.querySelector<HTMLElement>('a.im img')
        ?? el.closest('main section.billboard')?.querySelector<HTMLElement>('[data-vt-art]');
    return onScreen(pic) ? pic : null;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** desktop, Back from the player to its detail page: the poster / video frame morphs into the detail backdrop, the text rises back in */
  function deskFromPlayer(nav: Nav, start: StartVT): Promise<void> {
    const root = document.documentElement, my = vtBegin(), named: HTMLElement[] = [];
    const bd = () => document.querySelector<HTMLElement>('main .dd [data-vt-art]');
    root.classList.add('ff-vt-desk');
    vtName(document.querySelector<HTMLElement>('.stage .ff-poster') ?? document.querySelector<HTMLElement>('.stage video'), VT_ART, named);
    return new Promise<void>((resolve) => {
      const t = start.call(document, async () => {
        resolve();
        const until = performance.now() + 800;
        await Promise.race([nav.complete.catch(() => undefined), sleep(800)]);
        if (my !== vtSeq) return;
        for (const el of named) el.style.removeProperty('view-transition-name'); // the old side lets go first: a name must exist once
        while (performance.now() < until && !(bd() && document.querySelector('main .dd h1'))) await sleep(16);
        vtName(bd(), VT_ART, named);
        stagger([...document.querySelectorAll<HTMLElement>('main .dd [data-st]')], { delay: 160, gap: 40 });
      });
      void t.finished.catch(() => undefined).finally(() => vtEnd(my, named));
    });
  }
  /** `null`: not a page change this hook animates (the plain crossfade of the other pages takes it) */
  function deskTransition(nav: Nav, start: StartVT | undefined): Promise<void> | undefined | null {
    const from = nav.from?.url.pathname ?? '', to = nav.to?.url.pathname ?? '';
    if (!nav.to || intro || immersive(from) || immersive(to) || to === '/search') return;
    const plan = deskPagePlan({ from, to, back: nav.type === 'popstate', motion: motionAllowed(), level: motionLevel(), hasApi: typeof start === 'function' });
    if (plan.kind === 'none') return;
    if (plan.kind === 'fade' && !start) { pageFadeIn = true; return; }
    if (plan.kind === 'view' && !plan.morph) return null; // e.g. a deep link's "‹ Back" home: no card to morph into
    const root = document.documentElement, my = vtBegin(), named: HTMLElement[] = [];
    const name = (el: HTMLElement | null) => vtName(el, VT_ART, named);
    const bd = () => document.querySelector<HTMLElement>('main .dd [data-vt-art]');
    root.classList.add('ff-vt-desk'); // the reduced set (fade): a plain root crossfade, nothing named
    const src = plan.morph === 'in' ? deskArt(deskFrom) : null;
    name(src);
    if (plan.morph === 'back') {
      name(bd());
      // rows render in full while the page comes back: a skipped row (content-visibility) cannot take its remembered scroll
      // position, and its catch-up would need a frame, which the transition holds until the card is captured
      root.classList.add('ff-vt-desk-back');
    }
    const want = plan.morph === 'back' ? memo.get(nav.to.url.pathname + nav.to.url.search) : undefined;
    return new Promise<void>((resolve) => {
      const t = start!.call(document, async () => {
        resolve();
        // the screen holds still until the new page is there: never longer than 800 ms (same budget as the TV)
        const until = performance.now() + 800;
        await Promise.race([nav.complete.catch(() => undefined), sleep(800)]);
        if (my !== vtSeq || !plan.morph) return; // a newer transition took over meanwhile: name nothing for this one
        // the old side lets go of the name first: detail -> detail keeps the same backdrop element, a name must exist once
        for (const el of named) el.style.removeProperty('view-transition-name');
        if (plan.morph === 'in') {
          // the detail page renders once its title is there (primed from the card: at once); wait for it within the budget
          // (timers, not rAF: rendering is paused while the update callback runs)
          while (performance.now() < until && !(bd() && document.querySelector('main .dd h1'))) await sleep(16);
          if (src) name(bd());
          // the text follows the morph: eyebrow, title, meta, synopsis, actions, 40 ms apart (the new page is live under the pseudo tree)
          stagger([...document.querySelectorAll<HTMLElement>('main .dd [data-st]')], { delay: 160, gap: 40 });
          return;
        }
        // Back: the card it came from, on the row page it was on (rows restore their scroll position as they mount)
        await tick();
        // (on screen: the row has taken its page position and the page its scroll position)
        let art: HTMLElement | null = null;
        while (want && !(art = deskArt(sameSpot(want.href, want.sec)[want.nth])) && performance.now() < until) await sleep(16);
        name(art);
      });
      // the frame guard watches the transition (a desktop that cannot keep up drops to the reduced set), counting from the
      // moment it animates: the screen held for the new page on purpose before that
      void (t as { ready?: Promise<unknown> }).ready?.then(framesResume, () => undefined);
      void t.finished.catch(() => undefined).finally(() => vtEnd(my, named));
    });
  }
  // ---- phone: the preview sheet's poster -> the detail backdrop (spec 2026-11-08 §3; Details and drag up). The desktop's
  // shared name (VT_ART) and timing, set inline for this one navigation; without the API, with reduced motion / calm mode or
  // without a poster in the sheet, the plain crossfade below takes it. ----
  /** `null`: no sheet poster to morph from (the generic crossfade runs) */
  function sheetTransition(nav: Nav, start: StartVT | undefined): Promise<void> | null {
    const from = nav.from?.url.pathname ?? '';
    if (!nav.to || intro || immersive(from) || typeof start !== 'function' || !motionAllowed() || motionLevel() !== 'full') return null;
    const poster = document.querySelector<HTMLElement>('.sheet[role="dialog"]:not(.out) img.poster');
    if (!get(previewSheet) || !onScreen(poster)) return null;
    const root = document.documentElement, my = vtBegin(), named: HTMLElement[] = [];
    const bd = () => document.querySelector<HTMLElement>('main .dv [data-vt-art]');
    root.classList.add('ff-vt-desk');
    vtName(poster, VT_ART, named);
    return new Promise<void>((resolve) => {
      const t = start.call(document, async () => {
        resolve();
        // the screen holds still until the detail page is there: never longer than 800 ms (the desktop's budget)
        const until = performance.now() + 800;
        await Promise.race([nav.complete.catch(() => undefined), sleep(800)]);
        if (my !== vtSeq) return; // a newer transition took over meanwhile
        for (const el of named) el.style.removeProperty('view-transition-name'); // the sheet lets go first: a name must exist once
        while (performance.now() < until && !(bd() && document.querySelector('main .dv h1'))) await sleep(16);
        vtName(bd(), VT_ART, named);
      });
      void (t as { ready?: Promise<unknown> }).ready?.then(framesResume, () => undefined);
      void t.finished.catch(() => undefined).finally(() => vtEnd(my, named));
    });
  }
  afterNavigate(() => {
    if (!pageFadeIn) return;
    pageFadeIn = false;
    const main = document.querySelector('main');
    if (main && typeof main.animate === 'function') main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  });

  /** First load in this browser session: the brand intro without sound (no user gesture yet). Honours the per-profile setting. */
  // no copy yet (first visit on this device) and the loaded prefs say calm: stop the running intro at once
  $: if (intro && $prefs.calm) intro = false;
  function maybeColdIntro(profileId: string | undefined) {
    if (location.pathname === '/profiles') return;
    const s = loadIntroSettings(profileId);
    // calm mode: the server prefs arrive later, so the fast-start copy of this profile's flag decides (see cachedCalm)
    const ok = shouldPlayIntro({ setting: s.show, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, route: location.pathname, sessionSeen: readSessionSeen(), tv, cold: true, calm: cachedCalm(profileId) });
    if (ok) { markSessionSeen(); intro = true; }
  }

  let stops: Array<() => void> = [];
  // lock screen / Control Center / notification drive what plays on the TV
  onMount(() => bindCastMediaSession(castSession, castEngine));
  onMount(() => {
    // desktop page motion: which element a title was opened from (capture: before the router handles the click)
    const onClick = (e: MouseEvent) => { if (e.target instanceof Element) lastClick = { el: e.target, at: performance.now() }; };
    window.addEventListener('click', onClick, true);
    stops.push(() => window.removeEventListener('click', onClick, true));
    const onNotes = () => void loadNotes();
    window.addEventListener('ff-notes', onNotes);
    const onHelp = () => (help = true); // "Hilfe" on /me
    window.addEventListener('ff-help', onHelp);
    const onOnboarded = () => { if (me) me = { ...me, onboarded: true }; }; // /welcome finished
    window.addEventListener('ff-onboarded', onOnboarded);
    const onMeChanged = () => void api<Me>('/api/me').then((m) => { if (me) me = { ...me, name: m.name, profile: m.profile }; }).catch(() => undefined); // /me/account saved name or avatar
    window.addEventListener('ff-me-changed', onMeChanged);
    stops.push(() => { window.removeEventListener('ff-notes', onNotes); window.removeEventListener('ff-help', onHelp); window.removeEventListener('ff-onboarded', onOnboarded); window.removeEventListener('ff-me-changed', onMeChanged); });
    // header background: a 10 px sentinel at the top of the document instead of reading scrollY on every scroll event
    if (typeof IntersectionObserver === 'function' && sentinel) {
      const io = new IntersectionObserver(([e]) => { scrolled = !e!.isIntersecting; });
      io.observe(sentinel);
      stops.push(() => io.disconnect());
    }
    // the detail popup chunk loads as soon as the pointer/focus/finger gets near a card or an info button
    const warm = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('.card, .pc, a[href^="/item/"], [data-modal]')) return;
      prefetchModal(); unwarm();
    };
    const evs = ['pointerover', 'focusin', 'touchstart'] as const;
    const unwarm = () => evs.forEach((t) => document.removeEventListener(t, warm));
    evs.forEach((t) => document.addEventListener(t, warm, { passive: true }));
    stops.push(unwarm);
    lgApp = isLgApp();
    if (lgApp) { recordHistoryBase(); rememberLgProbeHome(); }
    if (isTizenApp() || isLgApp()) stops.push(installNavLock()); // the TV app never leaves for a foreign site (lib/tizen/navlock.ts)
    const flag = new URLSearchParams(location.search).get('tv');
    if (flag === '1') sessionStorage.setItem('ff_tv', '1'); else if (flag === '0') sessionStorage.removeItem('ff_tv');
    online = navigator.onLine;
    const setOnline = () => (online = navigator.onLine);
    window.addEventListener('online', setOnline); window.addEventListener('offline', setOnline);
    stops.push(() => { window.removeEventListener('online', setOnline); window.removeEventListener('offline', setOnline); });
    void boot();
    // Notification clicks (service worker) ask an already open window to navigate in-app.
    const onSwMessage = (e: MessageEvent) => {
      const link = e.data?.type === 'ff-nav' ? e.data.link : null;
      if (typeof link === 'string' && /^\/(?!\/)/.test(link)) void goto(link);
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => { navigator.serviceWorker?.removeEventListener('message', onSwMessage); stops.forEach((f) => f()); };
  });

  /** A pending device checks every few seconds whether it was approved and then reloads into the real app. */
  async function checkApproval() {
    checking = true;
    try { const m = await api<Me>('/api/me'); if (m.deviceApproved) { location.reload(); return true; } } catch { /* retry on the next tick */ } finally { checking = false; }
    return false;
  }
  function watchApproval() {
    const t = setInterval(checkApproval, 4000);
    // an installed app that comes back to the foreground checks at once instead of waiting for the next (throttled) tick
    const onVisible = () => { if (document.visibilityState === 'visible') void checkApproval(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }

  async function boot() {
    if (!publicPage) {
      try {
        const m = await api<Me>('/api/me');
        setCsrf(m.csrfToken);
        setActiveProfile(m.profile?.id);
        serverCaps.set(capsFrom(m.server?.capabilities));
        serverKind.set(kindFrom(m.server?.kind));
        setMediaServer(m.server?.kind); // texts that name the media server (i18n serverText)
        features.set(featuresFrom(m.features));
        writeHint(hintOf(m)); writeActive(m.profile?.id); clearReloadFlag(); // the profile-switch reload is done: a later reload may render early again
        if (m.profile?.id) void setMeta('lastProfileId', m.profile.id).catch(() => undefined); // the offline hub shows the last active profile's downloads
        pending = !m.deviceApproved;
        // "Wer ist heute dabei?": when no profile is chosen, and once per browser session for accounts with several profiles
        if (!pending && needsProfileGate(m, location.pathname, readPicked())) {
          await goto(gateHref(location.pathname + location.search), { replaceState: true });
        }
        // a kids profile never mounts a grown-up page; a new profile starts with /welcome (after the language question, which
        // is an overlay above it)
        else if (!pending && kidsRedirect(m, location.pathname)) await goto(kidsRedirect(m, location.pathname)!, { replaceState: true });
        else if (!pending && needsWelcome(m, location.pathname)) await goto(welcomeHref(location.pathname + location.search, m.kids), { replaceState: true });
        // the server language is active before the page mounts (an early-rendered page only gets the $t texts updated;
        // older servers send no language: keep the remembered one)
        if (m.language) await setLocale(m.language);
        me = m;
        if (!pending && m.isAdmin && m.profile?.isOwner && m.defaultLanguageSet === false) { langAsk = 'instance'; langPre = 'de'; }
        else if (!pending && m.profile && m.languageChosen === false) {
          langAsk = 'profile';
          langPre = pickLocale([m.suggestedLanguage, typeof navigator !== 'undefined' ? navigator.language : null]) ?? (isLocale(m.defaultLanguage) ? m.defaultLanguage : 'de');
        }
        if (early) window.dispatchEvent(new Event('ff-me')); // pages that rendered early can now read the active profile
        if (pending) stops.push(watchApproval());
        tv = m.tv || sessionStorage.getItem('ff_tv') === '1';
        if (!pending) maybeColdIntro(m.profile?.id);
        if (!pending) { loadNotes(); loadList(); loadPrefs(); const notesTimer = setInterval(loadNotes, 60_000); stops.push(() => clearInterval(notesTimer)); }
        if (m.tv) localStorage.setItem('ff_tv_device', '1'); // an expired TV session goes back to the pairing screen, not to a login form
        if (tv) {
          { let t: ReturnType<typeof setTimeout>; const wake = () => { document.documentElement.classList.remove('idle-cursor'); clearTimeout(t); t = setTimeout(() => document.documentElement.classList.add('idle-cursor'), 4000); }; wake(); window.addEventListener('mousemove', wake); stops.push(() => { window.removeEventListener('mousemove', wake); clearTimeout(t); }); }
          stops.push(startSpatial(() => !watchPage || Boolean(document.activeElement?.closest('[data-nav]'))));
          stops.push(frameGuard()); // spec 5.2: a TV that cannot keep up drops to the reduced motion set for the session
          if (!watchPage) void settleFocus();
        }
        if (m.tv && !pending) stops.push(startTvLink(onTvCommand, (code) => { if (code === 4401) location.href = '/tv'; else if (code === 4000) replaced = true; }));
      } catch (e) {
        // a new install: the backend answers 503 setup_required until the wizard is done (spec Part E1); api() redirects to login on 401
        if (e instanceof ApiError && e.status === 503 && e.body?.error === 'setup_required') await goto('/setup', { replaceState: true });
      }
    }
  }
</script>

<svelte:window on:keydown={onKey} />
<div class="top-sentinel" aria-hidden="true" bind:this={sentinel}></div>
<a class="skip" href="#main">{$t('shell.skipToContent')}</a>
{#if intro}<Intro on:done={() => (intro = false)} />{/if}

{#if publicPage}
  <slot />
{:else if pageReady}
  {#if !watchPage && !profilesPage && kidsUi}
    <header class="nav kidsnav" class:solid={scrolled || !path.startsWith('/kids')}>
      <a class="klogo" href="/kids" aria-label={$t('kids.nav.home')}><Logo wordmark={!$mobile} size={$mobile ? 30 : 32} label="" /><span class="kbadge">{$t('kids.badge')}</span></a>
      <span class="sp"></span>
      <nav class="knav" aria-label={$t('kids.nav.label')}>
        <a class="kbtn" href="/kids/search" aria-label={$t('kids.nav.search')} aria-current={path.startsWith('/kids/search') ? 'page' : undefined}><Icon name="search" size={26} /></a>
        <a class="kav" href="/profiles" aria-label={$t('kids.nav.switchProfile', { name: who })}><span class="face" style={faceStyle}>{initial(who)}</span></a>
      </nav>
    </header>
  {:else if !watchPage && !profilesPage}
    {#if tv}
      <TvRail {path} {who} {faceStyle} bind:open={railOpen} />
    {:else if $mobile}
      <header class="nav m" class:solid={mSolid || !heroPage} class:chips class:tuck={chips && mTucked}>
        <span class="mbg" aria-hidden="true"></span>
        <div class="mrow">
          <a class="mlogo" href="/" aria-label={$t('shell.mobile.home')} aria-current={path === '/' ? 'page' : undefined}><Logo size={28} label="" /><span class="wm" aria-hidden="true">FriendFlix</span></a>
          <span class="sp"></span>
          <a class="icon-btn" href="/search" aria-label={$t('shell.mobile.search')} aria-current={path.startsWith('/search') ? 'page' : undefined}><Icon name="search" size={24} /></a>
          <a class="avatar" href="/me" aria-label={unread ? $t('shell.mobile.meUnread', { n: unread }) : $t('shell.mobile.me')}><span class="face" style={faceStyle}>{initial(who)}</span>{#if unread}<span class="dot" aria-hidden="true">{unread}</span>{/if}</a>
        </div>
        {#if chips}
          <nav class="chipbar" class:tucked={mTucked} aria-label={$t('shell.cats.title')} inert={mTucked || undefined}>
            <a class="chip" href="/browse/series" class:on={path.startsWith('/browse/series')} aria-current={path.startsWith('/browse/series') ? 'page' : undefined}>{$t('shell.nav.series')}</a>
            <a class="chip" href="/browse/movies" class:on={path.startsWith('/browse/movies')} aria-current={path.startsWith('/browse/movies') ? 'page' : undefined}>{$t('shell.nav.movies')}</a>
            <button type="button" class="chip" aria-haspopup="dialog" aria-expanded={catOpen} on:click={openCats}>{$t('shell.nav.categories')}<Icon name="chevron-down" size={16} /></button>
          </nav>
        {/if}
      </header>
    {:else if desk}
      <DeskBar bind:this={deskBar} {path} {heroPage} {me} {who} {faceStyle} {multi} {admin} {canDownload} {lgApp} {here} {notes} onHelp={() => (help = true)} />
    {/if}
    <TabBar {path} {canDownload} />
    {#if (catOpen || catLeaving) && $mobile}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="catdim" class:out={catLeaving} on:click={() => closeCats()}></div>
      <div class="cats" class:out={catLeaving} inert={catLeaving || undefined} role="dialog" aria-modal="true" aria-label={$t('shell.cats.title')} use:dialogKeys={{ close: () => closeCats() }} use:dragClose={{ close: () => closeCats() }} on:transitionend={catOutEnd}>
        <div class="grab"><span class="handle" aria-hidden="true"></span></div>
        <div class="chead">
          <div class="seg" role="group" aria-label={$t('shell.cats.kind')}>
            <button type="button" class:on={catKind === 'movies'} aria-pressed={catKind === 'movies'} on:click={() => (catKind = 'movies')}>{$t('common.movies')}</button>
            <button type="button" class:on={catKind === 'series'} aria-pressed={catKind === 'series'} on:click={() => (catKind = 'series')}>{$t('common.series')}</button>
          </div>
          <button type="button" class="close" aria-label={$t('common.close')} on:click={() => closeCats()}><Icon name="x" size={24} /></button>
        </div>
        <ul class="clist">
          <li><a href="/watchlist" on:click|preventDefault={() => pickCat('/watchlist')}>{$t('shell.nav.myList')}</a></li>
          <li><a href="/collections" on:click|preventDefault={() => pickCat('/collections')}>{$t('shell.cats.collections')}</a></li>
          {#if catGenres === null}<li class="muted" role="status">{$t('shell.cats.loadingCats')}</li>
          {:else}{#each catGenres as g (g)}<li><a href={categoryHref(catKind, g)} on:click|preventDefault={() => pickCat(categoryHref(catKind, g))}>{g}</a></li>{/each}{/if}
        </ul>
      </div>
    {/if}
    {#if $mobile}<MobilePreviewSheet {canDownload} />{/if}
  {/if}

  {#if castBarOn}<CastBar tabbar={!kidsUi && !profilesPage} />{/if}
  {#if !online}<div class="offbar" class:notab={kidsUi || profilesPage} role="status">{$t('shell.offline.bar')} <a href="/offline" data-sveltekit-reload>{$t('shell.offline.toDownloads')}</a></div>{/if}
  {#if replaced}<div class="panel" role="alert" style="position:fixed;z-index:90;top:calc(5rem + var(--safe-top));left:50%;transform:translateX(-50%)"><b>{$t('shell.tvReplaced.text')}</b> <button on:click={() => location.reload()}>{$t('shell.tvReplaced.reconnect')}</button></div>{/if}
  {#if modalId && Modal}<svelte:component this={Modal} id={modalId} />{/if}
  <main id="main" class:page={!heroPage && !watchPage && !profilesPage && !kidsPage} class:tvrail={showRail}>
    {#if pending}
      <div class="page"><div class="panel pendp">
        <b class="warn">{$t('shell.pending.title')}</b>
        <p class="muted">{$t('shell.pending.intro')}</p>
        <ol class="muted">
          <li>{$t('shell.pending.step1')}</li>
          <li><Rich text={$t('shell.pending.step2')} /></li>
          <li><Rich text={$t('shell.pending.step3')} /></li>
        </ol>
        <p class="muted"><Rich text={$t('shell.pending.admin')} /></p>
        <div class="flex"><button class="sec" disabled={checking} on:click={checkApproval}>{checking ? $t('shell.pending.checking') : $t('shell.pending.check')}</button><a class="btn sec" href="/devices">{$t('shell.pending.devices')}</a></div>
      </div></div>
    {:else}
      <!-- a language switch made by the person re-renders the page once, so texts computed in scripts (tr(), fmtDate() …)
           follow it too; the language /api/me reports is applied before the page mounts and never re-renders it -->
      {#if showBanner}<HealthBanner hero={heroPage} />{/if}
      {#key $pageEpoch}<slot />{/key}
    {/if}
  </main>
  {#if !watchPage && !profilesPage && !tv && !pending && !$mobile}<Footer onHelp={() => (help = true)} kids={kidsUi} />{/if}
  {#if langAsk && path !== '/profiles'}<!-- also above /welcome: the language comes first -->
    <LanguageGate mode={langAsk} preselect={langPre} onChoose={langAsk === 'instance' ? chooseInstance : chooseProfile}
      onSkip={langAsk === 'profile' ? skipLanguage : null} />
  {/if}
  {#if help}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="hov" on:click|self={() => (help = false)}>
      <div class="hbox" role="dialog" aria-modal="true" aria-labelledby="help-h" use:dialogKeys={{ close: () => (help = false) }}>
        <div class="hhead"><h2 id="help-h">{$t('shell.help.title')}</h2><button type="button" class="icon-btn" aria-label={$t('common.close')} on:click={() => (help = false)} data-autofocus><Icon name="x" size={22} /></button></div>
        <dl>
          {#each HELP as [dt, dd] (dt)}<dt>{$t(dt)}</dt><dd><Rich text={$t(dd)} onLink={() => (help = false)} /></dd>{/each}
        </dl>
      </div>
    </div>
  {/if}
{:else}
  <main id="main" class="boot"><span class="logo"><Logo wordmark size={44} /></span><div class="spin" aria-label={$t('shell.booting')} role="status"></div></main>
{/if}
<!-- Samsung TV app: the phase-0 probe screen (only with probe=1 inside the app; a strip on the pairing page, full screen after pairing) -->
<ProbeOverlay compact={path === '/tv'} />
{#if lgApp}<LgProbeOverlay compact={path === '/tv'} />{/if}
<!-- app-wide toasts + confirm dialog (lib/ui) + the in-app re-authentication (lib/account/reauth.ts); mounted once, outside the page so they survive navigation -->
<ToastHost />
<ConfirmHost />
<ReauthHost />

<style>
  :global(html.tv) main.tvrail { padding-left: 96px; box-sizing: border-box; }
  .offbar { position: fixed; z-index: 80; left: 0; right: 0; bottom: calc(var(--tabbar-h) + var(--safe-bottom) + var(--castbar-h)); background: #242b33; padding: .6rem var(--pad-x); text-align: center; font-size: .9rem; }
  .offbar a { text-decoration: underline; font-weight: 600; }
  .offbar.notab { bottom: calc(var(--safe-bottom) + var(--castbar-h)); } /* no tab bar (kids profiles, profile picker) */
  @media (min-width: 721px) { .offbar, .offbar.notab { bottom: var(--castbar-h); } }
  .logo { display: inline-flex; align-items: center; }
  .nav { position: fixed; top: 0; left: 0; right: 0; height: var(--nav-total); z-index: 50; display: flex; align-items: center; gap: .5rem; padding: var(--safe-top) max(var(--pad-x), var(--safe-right)) 0 max(var(--pad-x), var(--safe-left)); background: linear-gradient(to bottom, rgba(0,0,0,.9), rgba(0,0,0,.55) 55%, transparent); transition: background var(--t-med); }
  .nav.solid { background: var(--bg); }
  .sp { flex: 1; }
  .dot { position: absolute; top: 4px; right: 2px; background: var(--acc-fill); font-size: .65rem; min-width: 1.1rem; height: 1.1rem; border-radius: 99px; display: grid; place-items: center; font-weight: 700; }
  .avatar { width: auto; min-height: 44px; height: 44px; padding: 0 .1rem; background: transparent; gap: .45rem; border-radius: 4px; }
  .avatar:hover:not(:disabled) { background: transparent; }
  .face { width: 34px; height: 34px; border-radius: 24%; display: grid; place-items: center; background: linear-gradient(135deg, #ff6b81, #9a2440); font-weight: 800; box-shadow: 0 0 0 1px rgba(255,255,255,.12); }
  /* ---- kids header: bright, big touch targets, logo + "Kids" badge, search, avatar (switch profile) ---- */
  .kidsnav { background: linear-gradient(100deg, #4f6bed, #7b5cff); color: #fff; } /* always solid: the white wordmark stays readable */
  .kidsnav.solid { box-shadow: 0 2px 14px rgba(32,35,58,.25); }
  .klogo { display: inline-flex; align-items: center; gap: .6rem; min-height: 48px; color: #fff; }
  .kbadge { display: inline-grid; place-items: center; min-height: 30px; padding: 0 .8rem; border-radius: 99px; background: linear-gradient(135deg, #ff5d8f, #ffb703); color: #fff; font-weight: 900; font-size: .95rem; letter-spacing: .04em; }
  .knav { display: flex; align-items: center; gap: .5rem; }
  .kbtn, .kav { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; color: #20233a; }
  .kbtn { background: #fff; box-shadow: 0 2px 8px rgba(32,35,58,.15); }
  .kbtn:focus-visible, .kav:focus-visible, .klogo:focus-visible { outline: 4px solid #ffb703; outline-offset: 2px; }
  .kav .face { width: 46px; height: 46px; border-radius: 50%; font-size: 1.1rem; color: #fff; box-shadow: 0 0 0 3px rgba(255,255,255,.85); }
  .top-sentinel { position: absolute; top: 0; left: 0; width: 1px; height: 10px; pointer-events: none; visibility: hidden; }
  .hov { position: fixed; inset: 0; z-index: 96; background: rgba(0,0,0,.7); display: grid; place-items: center; padding: max(1rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); animation: fade .2s ease-out; }
  .hbox { background: #161b21; border: 1px solid #2b333c; border-radius: 8px; width: min(560px, 100%); max-height: 90dvh; overflow-y: auto; padding: 1.2rem 1.4rem 1.4rem; box-shadow: 0 20px 60px rgba(0,0,0,.8); }
  .hhead { display: flex; align-items: center; justify-content: space-between; }
  .hhead h2 { margin: 0; font-size: 1.3rem; }
  .hbox dl { margin: .6rem 0 0; display: grid; gap: .25rem; }
  .hbox dt { font-weight: 700; margin-top: .6rem; }
  .hbox dd { margin: 0; color: #cfcfcf; font-size: .93rem; line-height: 1.5; }
  .hbox :global(a) { text-decoration: underline; }
  .hbox :global(kbd), .pendp :global(kbd) { display: inline-block; min-width: 1.4em; padding: 0 .35em; border: 1px solid #4a5560; border-bottom-width: 2px; border-radius: 4px; font: inherit; font-size: .82em; text-align: center; background: #1c2228; }
  @media (min-width: 721px) { main:not(.boot) { min-height: 100vh; } } /* the footer starts below the fold on short pages */
  .boot { min-height: 100vh; display: grid; place-content: center; gap: 1.2rem; justify-items: center; }
  .spin { width: 34px; height: 34px; border: 3px solid #2b333c; border-top-color: var(--acc); border-radius: 50%; animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  @media (max-width: 720px) {
    /* kids profiles (no tab bar) keep their spacing; elsewhere the page clears the floating tab bar (lib/phone/TabBar.svelte),
       the home indicator below it and the cast bar on it */
    main { padding-bottom: calc(70px + var(--castbar-h) + min(var(--castbar-h), var(--safe-bottom))); }
    :global(html:not(.kids)) main { padding-bottom: calc(var(--tabbar-h) + 1rem + var(--safe-bottom) + var(--castbar-h)); }
  }
  :global(html) { --castbar-h: 0px; } /* 64px while the cast bar shows (set on <html> above) */
  @media (min-width: 721px) { :global(body) { padding-bottom: var(--castbar-h); } }

  /* ---- phone header: transparent over the hero, glass once scrolled (SOLID_AFTER); chip bar below tucks while scrolling down ---- */
  /* padding-top keeps the rows below the status bar / Dynamic Island; the background layer covers that strip too. Only
     transform and opacity move: the two background layers crossfade, the layer slides up by the chip bar when it tucks. */
  .nav.m, .nav.m.solid { height: auto; flex-direction: column; align-items: stretch; gap: 0; padding: var(--safe-top) var(--safe-right) 0 var(--safe-left); background: none; transition: none; pointer-events: none; }
  .nav.m > :not(.mbg) { pointer-events: auto; }
  .mbg { position: absolute; inset: 0; z-index: -1; pointer-events: none; transition: transform 300ms var(--m-emph-out); }
  .mbg::before, .mbg::after { content: ''; position: absolute; inset: 0; transition: opacity 250ms ease-out; }
  .mbg::before { background: linear-gradient(to bottom, rgba(0,0,0,.7), transparent); }
  .mbg::after { background: rgba(10,10,12,.94); opacity: 0; }
  :global(html.m-glass) .mbg::after { background: rgba(10,10,12,.78); -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4); }
  .nav.m.solid .mbg::before { opacity: 0; }
  .nav.m.solid .mbg::after { opacity: 1; }
  .nav.m.tuck .mbg { transform: translateY(-48px); } /* the chip bar's height: the glass ends under the top row */
  .mrow { display: flex; align-items: center; gap: .1rem; height: 56px; padding: 0 calc(var(--pad-x) - 8px) 0 var(--pad-x); }
  .mlogo { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; min-width: 0; }
  .wm { font-size: 1.06rem; font-weight: 800; letter-spacing: -.02em; white-space: nowrap; text-shadow: 0 1px 8px rgba(0,0,0,.6); }
  .nav.m .icon-btn { display: inline-flex; align-items: center; justify-content: center; }
  .nav.m .avatar { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 4px; }
  .nav.m .face { width: 30px; height: 30px; font-size: .9rem; }
  .nav.m .dot { top: 2px; right: 0; }
  .chipbar { display: flex; gap: .5rem; align-items: center; height: 48px; padding: 0 var(--pad-x); overflow-x: auto; scrollbar-width: none; transition: transform 300ms var(--m-emph-out), opacity 200ms ease-out, visibility 0s; }
  .chipbar::-webkit-scrollbar { display: none; }
  .nav.m > .chipbar.tucked { pointer-events: none; }
  .chipbar.tucked { transform: translateY(-12px); opacity: 0; visibility: hidden; pointer-events: none; transition: transform 300ms var(--m-emph-out), opacity 200ms ease-out, visibility 0s 300ms; }
  :global(html.m-still) .mbg, :global(html.m-still) .mbg::before, :global(html.m-still) .mbg::after, :global(html.m-still) .chipbar { transition: none; }
  .chip::after, .seg button::after { content: ''; position: absolute; inset: -4px 0; }
  .chip { position: relative; flex: none; display: inline-flex; align-items: center; gap: .3rem; min-height: 36px; padding: 0 .95rem; border-radius: 99px; border: 1px solid rgba(255,255,255,.5); background: rgba(0,0,0,.25); color: #fff; font: inherit; font-size: .9rem; font-weight: 500; }
  .chip:hover:not(:disabled) { background: rgba(255,255,255,.12); }
  .chip.on, .chip.on:hover:not(:disabled) { background: #fff; color: #000; border-color: #fff; font-weight: 700; }
  :global(html.m-chips) { --nav-h: 104px; }
  @media (max-width: 720px) { :global(html:not(.m-chips)) { --nav-h: 56px; } }

  /* ---- categories: bottom sheet (springs up, drag down or tap the dim to close; lib/phone/dragClose.ts) ---- */
  .catdim { position: fixed; inset: 0; z-index: 94; background: rgba(0,0,0,.6); animation: fade 200ms ease-out; }
  .cats { position: fixed; left: 0; right: 0; bottom: 0; z-index: 95; max-height: min(82dvh, calc(100dvh - var(--safe-top) - 1rem)); overflow-y: auto; overscroll-behavior: contain; background: #18181c; border-radius: 22px 22px 0 0; box-shadow: 0 -10px 40px rgba(0,0,0,.5); padding: 0 max(var(--pad-x), var(--safe-right)) calc(1.5rem + var(--safe-bottom)) max(var(--pad-x), var(--safe-left)); animation: rise var(--m-d-spring) var(--m-spring); transition: transform var(--m-d-spring) var(--m-spring); }
  .cats:global(.dragging) { transition: none; }
  .cats.out { transform: translateY(100%); transition: transform 280ms var(--m-emph-in); pointer-events: none; }
  .catdim.out { opacity: 0; transition: opacity 280ms var(--m-emph-in); pointer-events: none; }
  .grab { position: sticky; top: 0; z-index: 2; touch-action: none; cursor: grab; padding: 8px 0 4px; background: #18181c; }
  .handle { display: block; width: 38px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.3); margin: 0 auto; }
  .chead { position: sticky; top: 17px; display: flex; align-items: center; justify-content: space-between; padding: .4rem 0 .7rem; background: linear-gradient(#18181c 75%, transparent); z-index: 1; }
  .seg { display: inline-flex; border: 1px solid #4a5560; border-radius: 99px; overflow: hidden; }
  .seg button { position: relative; background: transparent; border-radius: 0; min-height: 40px; padding: 0 1.1rem; color: #ddd; font-weight: 600; }
  .seg button:hover:not(:disabled) { background: rgba(255,255,255,.1); }
  .seg button.on, .seg button.on:hover:not(:disabled) { background: #fff; color: #000; }
  .cats .close { width: 48px; height: 48px; padding: 0; border-radius: 50%; background: #fff; color: #000; }
  .cats .close:hover:not(:disabled) { background: rgba(255,255,255,.8); }
  .clist { list-style: none; margin: .6rem 0 0; padding: 0; text-align: center; }
  .clist li { padding: 0; }
  .clist a { display: block; padding: .72rem 0; font-size: 1.2rem; color: #b8b8b8; }
  .clist li:first-child a, .clist li:nth-child(2) a { font-weight: 700; color: #fff; }
  .clist a:active, .clist a:hover { color: #fff; }
  .clist .muted { padding: 1rem 0; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
  @media (prefers-reduced-motion: reduce) { .cats, .catdim, .hov { animation: none; } }
  :global(html.m-still) .cats, :global(html.m-still) .catdim { animation: none; transition: none; }
</style>
