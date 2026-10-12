<script lang="ts">
  import '../app.css';
  import { onMount, tick } from 'svelte';
  import { afterNavigate, beforeNavigate, goto, onNavigate } from '$app/navigation';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { api, setActiveProfile, setCsrf, type Me } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import { avatarBg, initial } from '#lib/avatars';
  import { loadList, loadPrefs } from '#lib/stores';
  import ItemModal from '#lib/ItemModal.svelte';
  import { startTvLink, type ToTv } from '#lib/remote';
  import { disablePush } from '#lib/push';
  import { getAllDownloads, setMeta } from '#lib/offline/db';
  import { focusEl, focusFirst, isBackKey, isEditable, startSpatial } from '#lib/spatial';
  import Intro from '#lib/Intro.svelte';
  import { loadIntroSettings, markSessionSeen, readSessionSeen, shouldPlayIntro } from '#lib/intro';

  let me: Me | null = null;
  /** TV mode: big UI, D-pad navigation. On for paired televisions; `?tv=1` previews it in any browser (`?tv=0` ends the preview). */
  let tv = false, replaced = false;
  let pending = false, checking = false;
  let notes: Array<{ id: number; title: string; link?: string; read: boolean }> = [];
  let scrolled = false, menu = false, bell = false, searchOpen = false, more = false, q = '';
  let searchEl: HTMLInputElement;
  let online = true;
  let intro = false;
  /** phone layout (same breakpoint as the tab bar): the avatar opens the "Mehr" sheet instead of the desktop dropdown */
  let mobile = false;
  let sheetEl: HTMLElement | undefined, moreTrigger: HTMLElement | null = null, dragY = 0, dragging = false, dragStart = 0;
  $: canDownload = Boolean(me?.downloads?.allowed);
  $: links = canDownload ? [...menuLinks.slice(0, 3), ['/downloads', 'Downloads', 'download'] as [string, string, string], ...menuLinks.slice(3)] : menuLinks;

  $: path = $page.url.pathname;
  $: publicPage = path.startsWith('/invite/') || path === '/tv' || path === '/offline';
  $: watchPage = path.startsWith('/watch/') || /^\/party\/[^/]+/.test(path); // immersive player pages: no navigation
  $: profilesPage = path === '/profiles';
  $: heroPage = path === '/' || path.startsWith('/item/');
  $: unread = notes.filter((n) => !n.read).length;
  $: if (path) { menu = false; bell = false; more = false; }
  $: if (typeof document !== 'undefined') document.documentElement.style.overflow = more ? 'hidden' : ''; // no page scroll behind the sheet
  const sheetGroups: Array<{ title: string; hrefs: string[] }> = [
    { title: 'Entdecken', hrefs: ['/tonight', '/collections', '/upcoming', '/match', '/party', '/vote', '/now', '/calendar'] },
    { title: 'Meine Sachen', hrefs: ['/favorites', '/lists', '/history', '/downloads', '/requests', '/stats'] },
    { title: 'Konto & Einstellungen', hrefs: ['/remote', '/settings', '/devices'] },
  ];
  /** every entry of `links` lands in exactly one group (unknown ones fall back to "Meine Sachen") */
  $: sections = (() => {
    const groups = sheetGroups.map((g) => ({ title: g.title, items: [] as Array<[string, string, string]> }));
    for (const l of links) (groups.find((g, i) => sheetGroups[i].hrefs.includes(l[0])) ?? groups[1]).items.push(l);
    for (const g of groups) { const order = sheetGroups.find((x) => x.title === g.title)!.hrefs; g.items.sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99); }
    return groups;
  })();
  const isActive = (href: string) => path === href || path.startsWith(href + '/');
  $: if (!publicPage) document.documentElement.classList.toggle('tv', tv);

  const tabs: Array<[string, string, string]> = [['/', 'Start', 'home'], ['/browse/series', 'Serien', 'film'], ['/browse/movies', 'Filme', 'film'], ['/new', 'Neu & beliebt', 'star'], ['/watchlist', 'Meine Liste', 'plus']];
  const menuLinks: Array<[string, string, string]> = [
    ['/tonight', 'Heute Abend', 'star'], ['/favorites', 'Favoriten', 'heart'], ['/lists', 'Listen', 'list'], ['/history', 'Verlauf', 'calendar'], ['/match', 'Gruppen-Matcher', 'users'], ['/collections', 'Sammlungen', 'film'], ['/upcoming', 'Demnächst', 'calendar'], ['/requests', 'Wünsche', 'gift'], ['/party', 'Watch-Party', 'users'], ['/vote', 'Filmabend', 'vote'],
    ['/now', 'Läuft gerade', 'monitor'], ['/calendar', 'Kalender', 'calendar'], ['/stats', 'Wrapped', 'bar-chart'], ['/remote', 'Fernbedienung', 'tv'], ['/settings', 'Einstellungen', 'settings'], ['/devices', 'Geräte', 'monitor'],
  ];

  async function loadNotes() { try { notes = (await api('/api/notifications')).notifications; } catch { /* ignore */ } }
  async function toggleBell() {
    bell = !bell; menu = false; more = false;
    if (bell && unread) { await api('/api/notifications/read', { method: 'POST' }); setTimeout(loadNotes, 1500); }
  }
  async function logout() {
    let hasDl = false;
    try { hasDl = (await getAllDownloads()).length > 0; } catch { /* no IndexedDB */ }
    if (hasDl && confirm('Auch die Downloads auf diesem Gerät löschen?\n\nOK: löschen (empfohlen, z. B. auf geteilten Geräten). Abbrechen: behalten.')) await (await import('#lib/offline/manager')).removeAll().catch(() => undefined);
    await Promise.race([disablePush().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]); // best effort: drop this device's push subscription before the session ends
    await api('/auth/logout', { method: 'POST' });
    location.href = me?.tv ? '/tv' : '/auth/login';
  }
  async function surprise() {
    try { goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { goto('/browse/movies'); }
  }
  function openSearch() { if (mobile) { void goto('/search'); return; } searchOpen = true; setTimeout(() => searchEl?.focus(), 30); }
  function openMore(e: Event) {
    moreTrigger = e.currentTarget as HTMLElement; menu = false; bell = false;
    if (more) { closeMore(true); return; }
    more = true; dragY = 0; dragging = false;
    void tick().then(() => sheetEl?.querySelector<HTMLElement>('a[href], button')?.focus());
  }
  function closeMore(refocus = false) { more = false; dragY = 0; dragging = false; if (refocus) moreTrigger?.focus(); }
  function trapTab(e: KeyboardEvent) {
    const els = [...(sheetEl?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])];
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1], a = document.activeElement;
    if (!sheetEl?.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }
  // swipe down on the grab zone closes the sheet (threshold 80 px)
  function dragDown(e: PointerEvent) { dragging = true; dragStart = e.clientY; dragY = 0; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }
  function dragMove(e: PointerEvent) { if (dragging) dragY = Math.max(0, e.clientY - dragStart); }
  function dragEnd() { if (!dragging) return; const far = dragY > 80; dragging = false; dragY = 0; if (far) closeMore(true); }
  function submitSearch() { if (q.trim()) goto(`/search?q=${encodeURIComponent(q.trim())}`); }
  function onKey(e: KeyboardEvent) {
    // "/" and Ctrl/Cmd+K jump to the search field (not while typing somewhere else)
    if (!watchPage && !tv && ((e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) {
      const el = e.target as HTMLElement | null;
      const typing = el && (isEditable(el) || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (!typing || e.key !== '/') { e.preventDefault(); openSearch(); return; }
    }
    if (e.key === 'Tab' && more) trapTab(e);
    const back = e.key === 'Escape' || (tv && isBackKey(e));
    if (!back) return;
    if (menu || bell || more) { const wasMore = more; menu = bell = more = false; if (wasMore) moreTrigger?.focus(); if (tv || wasMore) e.preventDefault(); return; } // dropdowns close first
    if (e.key === 'Escape' && !q) searchOpen = false;
    // TV: Back/Escape walks one step back (the detail popup closes itself on Escape; the player handles its own keys)
    if (tv && !watchPage && !(e.key === 'Escape' && $page.state.modalId) && !isEditable(e.target as Element)) {
      e.preventDefault();
      if (path !== '/' || $page.state.modalId) history.back();
    }
  }

  // ---- commands from the phone (only on a paired TV) ----
  function onTvCommand(m: ToTv) {
    if (m.t === 'cast') goto(`/watch/${m.itemId}${m.startSec ? `?t=${m.startSec}` : ''}`);
    else if (m.action === 'home' || m.action === 'stop') goto('/');
    else window.dispatchEvent(new CustomEvent('ff-remote', { detail: m })); // the player listens
  }

  // ---- TV focus memory: coming back (Back key) puts the focus on the card you left, a new page focuses its first element ----
  const memo = new Map<string, { href: string; nth: number }>();
  beforeNavigate(({ from }) => {
    const el = document.activeElement as HTMLElement | null, href = el?.getAttribute?.('href');
    if (!tv || !from || !href) return;
    // the same title can appear in several rows: remember which occurrence it was
    const nth = [...document.querySelectorAll(`main a[href="${CSS.escape(href)}"]`)].indexOf(el!);
    if (nth >= 0) memo.set(from.url.pathname + from.url.search, { href, nth });
  });
  /** waits for the page content (lazy rows, fetched lists), then focuses the remembered link, [data-autofocus] or the first element */
  async function settleFocus(want?: { href: string; nth: number }) {
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, i ? 150 : 30));
      const main = document.querySelector('main');
      if (want) {
        const el = main?.querySelectorAll<HTMLElement>(`a[href="${CSS.escape(want.href)}"]`)[want.nth];
        if (el) return focusEl(el);
      } else if (main?.querySelector('[data-autofocus]') ? focusFirst(main, false) : i >= 4 && focusFirst(main, false)) return;
    }
  }
  afterNavigate(({ to, type }) => {
    if (!tv || !to || /^\/(watch|party)\//.test(to.url.pathname)) return;
    void settleFocus(type === 'popstate' ? memo.get(to.url.pathname + to.url.search) : undefined);
  });

  // ---- page transitions: View Transitions API where available (180 ms crossfade, main content rises 8 px; see app.css) ----
  const immersive = (p: string) => /^\/(watch|party)\//.test(p);
  onNavigate((nav) => {
    const start = (document as Document & { startViewTransition?: (cb: () => Promise<void>) => { finished: Promise<unknown> } }).startViewTransition;
    if (typeof start !== 'function' || tv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = nav.from?.url.pathname ?? '', to = nav.to?.url.pathname ?? '';
    if (!nav.to || from === to || immersive(from) || immersive(to) || intro) return;
    const root = document.documentElement;
    return new Promise<void>((resolve) => {
      root.classList.add('ff-vt'); // names <main> only for the duration of the transition
      const t = start.call(document, async () => { resolve(); await nav.complete; });
      void t.finished.catch(() => undefined).finally(() => root.classList.remove('ff-vt'));
    });
  });

  /** First load in this browser session: the brand intro without sound (no user gesture yet). Honours the per-profile setting. */
  function maybeColdIntro(profileId: string | undefined) {
    if (location.pathname === '/profiles') return;
    const s = loadIntroSettings(profileId);
    const ok = shouldPlayIntro({ setting: s.show, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, route: location.pathname, sessionSeen: readSessionSeen(), tv, cold: true });
    if (ok) { markSessionSeen(); intro = true; }
  }

  function outside(e: MouseEvent) { if (!(e.target as HTMLElement).closest('.pop-anchor')) { menu = false; bell = false; } }

  let stops: Array<() => void> = [];
  onMount(() => {
    const mq = matchMedia('(max-width: 720px)');
    mobile = mq.matches;
    const onMq = () => { mobile = mq.matches; menu = bell = more = false; searchOpen = false; }; // never leave a stray dropdown across the breakpoint
    mq.addEventListener('change', onMq);
    stops.push(() => mq.removeEventListener('change', onMq));
    const onScroll = () => (scrolled = window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
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
    return () => { window.removeEventListener('scroll', onScroll); navigator.serviceWorker?.removeEventListener('message', onSwMessage); stops.forEach((f) => f()); };
  });

  /** A pending device checks every few seconds whether it was approved and then reloads into the real app. */
  async function checkApproval() {
    checking = true;
    try { const m = await api<Me>('/api/me'); if (m.deviceApproved) { location.reload(); return true; } } catch { /* retry on the next tick */ } finally { checking = false; }
    return false;
  }
  function watchApproval() { const t = setInterval(checkApproval, 4000); return () => clearInterval(t); }

  async function boot() {
    if (!publicPage) {
      try {
        me = await api<Me>('/api/me');
        setCsrf(me.csrfToken);
        setActiveProfile(me.profile?.id);
        if (me.profile?.id) void setMeta('lastProfileId', me.profile.id).catch(() => undefined); // the offline hub shows the last active profile's downloads
        pending = !me.deviceApproved;
        if (!pending && path !== '/profiles') {
          if (me.profileRequired || ((me.profileCount ?? 0) > 1 && !me.profileChosen)) {
            await goto(`/profiles?next=${encodeURIComponent(location.pathname + location.search)}`, { replaceState: true });
          }
        }
        if (pending) stops.push(watchApproval());
        tv = me.tv || sessionStorage.getItem('ff_tv') === '1';
        if (!pending) maybeColdIntro(me.profile?.id);
        if (!pending) { loadNotes(); loadList(); loadPrefs(); const notesTimer = setInterval(loadNotes, 60_000); stops.push(() => clearInterval(notesTimer)); }
        if (me.tv) localStorage.setItem('ff_tv_device', '1'); // an expired TV session goes back to the pairing screen, not to a login form
        if (tv) {
          { let t: ReturnType<typeof setTimeout>; const wake = () => { document.documentElement.classList.remove('idle-cursor'); clearTimeout(t); t = setTimeout(() => document.documentElement.classList.add('idle-cursor'), 4000); }; wake(); window.addEventListener('mousemove', wake); stops.push(() => { window.removeEventListener('mousemove', wake); clearTimeout(t); }); }
          stops.push(startSpatial(() => !watchPage || Boolean(document.activeElement?.closest('[data-nav]'))));
          if (!watchPage) void settleFocus();
        }
        if (me.tv && !pending) stops.push(startTvLink(onTvCommand, (code) => { if (code === 4401) location.href = '/tv'; else if (code === 4000) replaced = true; }));
      } catch { /* api() redirects to login on 401 */ }
    }
  }
</script>

<svelte:window on:keydown={onKey} on:click={outside} />
<a class="skip" href="#main">Zum Inhalt springen</a>
{#if intro}<Intro on:done={() => (intro = false)} />{/if}

{#if publicPage}
  <slot />
{:else if me}
  {#if !watchPage && !profilesPage}
    <header class="nav" class:solid={scrolled || !heroPage}>
      <a class="logo" href="/" aria-label="FriendFlix Startseite"><Logo wordmark size={34} /></a>
      <nav class="links" aria-label="Hauptnavigation">
        {#each tabs as [href, label]}<a {href} class:active={href === '/' ? path === '/' : path.startsWith(href)} aria-current={href === '/' ? (path === '/' ? 'page' : undefined) : path.startsWith(href) ? 'page' : undefined}>{label}</a>{/each}
      </nav>
      <span class="sp"></span>
      <form class="search" class:open={searchOpen} on:submit|preventDefault={submitSearch} role="search">
        <button type="button" class="icon-btn" aria-label="Suche öffnen" on:click={() => (searchOpen && !mobile ? submitSearch() : openSearch())}><Icon name="search" size={22} /></button>
        <input bind:this={searchEl} bind:value={q} placeholder="Titel, Person, Genre, Jahr …" aria-label="Suche" on:blur={() => { if (!q) searchOpen = false; }} />
      </form>
      <button class="icon-btn hide-s" aria-label="Überrasch mich" title="Überrasch mich" on:click={surprise}><Icon name="shuffle" size={21} /></button>
      <div class="pop-anchor">
        <button class="icon-btn" aria-label="Benachrichtigungen{unread ? `, ${unread} neu` : ''}" aria-expanded={bell} on:click={toggleBell}>
          <Icon name="bell" size={22} />{#if unread}<span class="dot">{unread}</span>{/if}
        </button>
        {#if bell}
          <div class="drop wide" role="menu">
            {#each notes as n}<a href={n.link ?? '#'} class:muted={n.read} role="menuitem">{n.title}</a>{:else}<span class="muted pad">Keine Benachrichtigungen</span>{/each}
          </div>
        {/if}
      </div>
      <div class="pop-anchor">
        <button class="avatar" aria-label="Profilmenü" aria-haspopup={mobile ? 'dialog' : 'menu'} aria-expanded={mobile ? more : menu} on:click={(e) => { if (mobile) openMore(e); else { menu = !menu; bell = false; more = false; } }}><span class="face" style={me.profile ? `background:${avatarBg(me.profile.avatar)}` : undefined}>{initial(me.profile?.name ?? me.name)}</span><i class="caret" class:up={menu}></i></button>
        {#if menu && !mobile}
          <div class="drop" role="menu">
            <div class="who"><b>{me.profile?.name ?? me.name}</b><span class="muted">{me.roleLabel}</span></div>
            <a href="/profiles" role="menuitem"><Icon name="users" size={18} />Profil wechseln</a>
            {#each links as [href, label, icon]}<a {href} role="menuitem"><Icon name={icon} size={18} />{label}</a>{/each}
            {#if me.isAdmin && me.profile?.isOwner}<a href="/admin" role="menuitem"><Icon name="shield" size={18} />Admin</a>{/if}
            <button class="plain" role="menuitem" on:click={logout}><Icon name="log-out" size={18} />Abmelden</button>
          </div>
        {/if}
      </div>
    </header>
    <nav class="tabbar" aria-label="Mobile Navigation">
      <a href="/" class:active={path === '/'}><Icon name="home" size={22} /><span>Start</span></a>
      <a href="/browse/series" class:active={path.startsWith('/browse')}><Icon name="film" size={22} /><span>Entdecken</span></a>
      <a href="/search" class:active={path.startsWith('/search')}><Icon name="search" size={22} /><span>Suche</span></a>
      <a href="/watchlist" class:active={path.startsWith('/watchlist')}><Icon name="plus" size={22} /><span>Liste</span></a>
      <button class="tab" class:active={more} aria-haspopup="dialog" aria-expanded={more} on:click|stopPropagation={openMore}><Icon name="menu" size={22} /><span>Mehr</span></button>
    </nav>
    {#if more && mobile}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="backdrop" on:click={() => closeMore(true)}></div>
      <div class="sheet" class:dragging role="dialog" aria-modal="true" aria-label="Mehr" bind:this={sheetEl} style={dragY ? `transform:translateY(${dragY}px)` : undefined}>
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="grab" on:pointerdown={dragDown} on:pointermove={dragMove} on:pointerup={dragEnd} on:pointercancel={dragEnd}>
          <span class="handle" aria-hidden="true"></span>
          <div class="prof">
            <span class="face" style={me.profile ? `background:${avatarBg(me.profile.avatar)}` : undefined}>{initial(me.profile?.name ?? me.name)}</span>
            <span class="who2"><b>{me.profile?.name ?? me.name}</b><span class="muted">{me.roleLabel}</span></span>
          </div>
        </div>
        <a class="row" href="/profiles"><Icon name="users" size={20} />Profil wechseln</a>
        {#each sections as g (g.title)}
          {@const admin = g.title === 'Konto & Einstellungen' && me.isAdmin && me.profile?.isOwner}
          {#if g.items.length || admin}
            <h2 class="sh">{g.title}</h2>
            {#each g.items as [href, label, icon] (href)}<a class="row" {href} class:active={isActive(href)} aria-current={isActive(href) ? 'page' : undefined}><Icon name={icon} size={20} />{label}</a>{/each}
            {#if admin}<a class="row" href="/admin" class:active={isActive('/admin')} aria-current={isActive('/admin') ? 'page' : undefined}><Icon name="shield" size={20} />Admin</a>{/if}
          {/if}
        {/each}
        <button class="row plain out" on:click={logout}><Icon name="log-out" size={20} />Abmelden</button>
      </div>
    {/if}
  {/if}

  {#if !online}<div class="offbar" role="status">Du bist offline. <a href="/offline" data-sveltekit-reload>Zu den Downloads</a></div>{/if}
  {#if replaced}<div class="panel" role="alert" style="position:fixed;z-index:90;top:5rem;left:50%;transform:translateX(-50%)"><b>Der Fernseher wurde auf einem anderen Gerät übernommen.</b> <button on:click={() => location.reload()}>Hier wieder verbinden</button></div>{/if}
  {#if $page.state.modalId}<ItemModal id={$page.state.modalId} />{/if}
  <main id="main" class:page={!heroPage && !watchPage && !profilesPage}>
    {#if pending}
      <div class="page"><div class="panel pendp">
        <b class="warn">Dieses Gerät wartet auf Freigabe</b>
        <p class="muted">Aus Sicherheitsgründen muss jedes neue Gerät einmal bestätigt werden. So geht’s:</p>
        <ol class="muted">
          <li>Öffne FriendFlix auf einem Gerät, auf dem du schon angemeldet bist.</li>
          <li>Tippe oben auf die Glocke (dort steht „Ein neues Gerät wartet auf deine Freigabe“) oder wähle im Profilmenü <b>Geräte</b>.</li>
          <li>Drücke bei diesem Gerät auf <b>Freigeben</b>. Diese Seite öffnet sich danach von selbst.</li>
        </ol>
        <p class="muted">Kein anderes Gerät zur Hand? Ein Admin kann es unter <b>Admin → Geräte</b> freigeben.</p>
        <div class="flex"><button class="sec" disabled={checking} on:click={checkApproval}>{checking ? 'Prüfe …' : 'Jetzt prüfen'}</button><a class="btn sec" href="/devices">Geräte ansehen</a></div>
      </div></div>
    {:else}
      <slot />
    {/if}
  </main>
{:else}
  <main id="main" class="boot"><span class="logo"><Logo wordmark size={44} /></span><div class="spin" aria-label="Lade …" role="status"></div></main>
{/if}

<style>
  .offbar { position: fixed; z-index: 80; left: 0; right: 0; bottom: calc(56px + env(safe-area-inset-bottom)); background: #2a2a2a; padding: .6rem var(--pad-x); text-align: center; font-size: .9rem; }
  .offbar a { text-decoration: underline; font-weight: 600; }
  @media (min-width: 721px) { .offbar { bottom: 0; } }
  .logo { display: inline-flex; align-items: center; }
  .nav { position: fixed; top: 0; left: 0; right: 0; height: var(--nav-h); z-index: 50; display: flex; align-items: center; gap: .5rem; padding: 0 var(--pad-x); background: linear-gradient(to bottom, rgba(0,0,0,.9), rgba(0,0,0,.55) 55%, transparent); transition: background var(--t-med); }
  .nav.solid { background: var(--bg); }
  .links { display: flex; gap: 1.5rem; margin-left: 2.2rem; }
  .links a { font-size: .95rem; font-weight: 500; color: #e5e5e5; transition: color var(--t-fast); white-space: nowrap; padding: .6rem 0; }
  .links a:hover { color: #b3b3b3; } .links a.active { color: #fff; font-weight: 700; }
  .sp { flex: 1; }
  .search { display: flex; align-items: center; border: 1px solid transparent; transition: border-color var(--t-fast), background var(--t-fast); border-radius: 4px; }
  .search.open { border-color: #fff; background: rgba(0,0,0,.75); }
  .search input { width: 0; padding: 0; border: 0; background: transparent; transition: width var(--t-med) var(--ease), padding var(--t-med); min-height: 40px; }
  .search.open input { width: clamp(120px, 24vw, 280px); padding: 0 .5rem 0 0; }
  .search input:focus-visible { outline: none; }
  .pop-anchor { position: relative; }
  .dot { position: absolute; top: 4px; right: 2px; background: var(--acc); font-size: .65rem; min-width: 1.1rem; height: 1.1rem; border-radius: 99px; display: grid; place-items: center; font-weight: 700; }
  .avatar { width: auto; min-height: 44px; height: 44px; padding: 0 .1rem; background: transparent; gap: .45rem; border-radius: 4px; }
  .avatar:hover:not(:disabled) { background: transparent; }
  .face { width: 34px; height: 34px; border-radius: 4px; display: grid; place-items: center; background: linear-gradient(135deg, #ff3b52, #7a0a17); font-weight: 800; box-shadow: 0 0 0 1px rgba(255,255,255,.12); }
  .caret { width: 0; height: 0; border: 5px solid transparent; border-top-color: #fff; border-bottom: 0; transition: transform var(--t-fast); }
  .caret.up { transform: rotate(180deg); }
  .drop { position: absolute; right: 0; top: calc(100% + 6px); background: rgba(0,0,0,.94); border: 1px solid #333; border-radius: 4px; min-width: 220px; padding: .4rem 0; display: flex; flex-direction: column; box-shadow: 0 12px 30px rgba(0,0,0,.7); }
  .drop.wide { width: min(340px, 90vw); }
  .drop a, .drop .plain { display: flex; gap: .7rem; align-items: center; padding: .55rem 1rem; font-size: .9rem; color: #e5e5e5; min-height: 44px; }
  .drop a:hover, .drop .plain:hover { text-decoration: underline; background: transparent; }
  .plain { background: transparent; border-radius: 0; justify-content: flex-start; font-weight: 400; width: 100%; }
  .who { padding: .5rem 1rem; display: flex; flex-direction: column; border-bottom: 1px solid #333; margin-bottom: .3rem; }
  .pad { padding: .8rem 1rem; }
  .tabbar { display: none; }
  .boot { min-height: 100vh; display: grid; place-content: center; gap: 1.2rem; justify-items: center; }
  .spin { width: 34px; height: 34px; border: 3px solid #333; border-top-color: var(--acc); border-radius: 50%; animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  @media (max-width: 900px) { .links { display: none; } .hide-s { display: none; } }
  @media (max-width: 720px) {
    .tabbar { display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 60; background: rgba(10,10,10,.97); border-top: 1px solid #262626; padding-bottom: env(safe-area-inset-bottom); }
    .tabbar a, .tabbar .tab { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .1rem; min-height: 56px; padding: 0 2px; font-size: .68rem; color: var(--mut); background: transparent; border-radius: 0; font-weight: 500; }
    .tabbar span { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tabbar a.active, .tabbar .tab.active { color: #fff; }
    .tabbar .tab.active { font-weight: 700; }
    .backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.6); animation: fade .2s ease-out; }
    .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 71; max-height: 80vh; max-height: 80dvh; overflow-y: auto; overscroll-behavior: contain; background: #121212; border-top: 1px solid #333; border-radius: 16px 16px 0 0; padding: 0 .5rem calc(.5rem + env(safe-area-inset-bottom)); display: flex; flex-direction: column; animation: rise .26s var(--ease, ease-out); }
    .sheet.dragging { transition: none; }
    .grab { touch-action: none; cursor: grab; position: sticky; top: 0; background: #121212; z-index: 1; padding: 0 .5rem .4rem; margin: 0 -.5rem; }
    .handle { display: block; width: 40px; height: 4px; border-radius: 99px; background: #555; margin: 10px auto 12px; }
    .prof { display: flex; align-items: center; gap: .8rem; }
    .who2 { display: flex; flex-direction: column; min-width: 0; }
    .who2 b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sh { margin: 1rem .6rem .2rem; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; color: var(--mut); font-weight: 700; }
    .row { display: flex; gap: .8rem; align-items: center; padding: .6rem .6rem; min-height: 48px; color: #e5e5e5; border-radius: 8px; font-size: .95rem; }
    .row.active { background: rgba(255,255,255,.1); color: #fff; font-weight: 700; }
    .row.out { margin-top: .8rem; border-top: 1px solid #2a2a2a; border-radius: 0 0 8px 8px; }
    .caret { display: none; }
    .search input, .search.open input { display: none; }
    .drop.wide { position: fixed; left: 0; right: 0; top: var(--nav-h); width: auto; max-height: calc(100dvh - var(--nav-h) - 72px); overflow-y: auto; border-radius: 0 0 8px 8px; border-left: 0; border-right: 0; }
    .drop.wide a, .drop.wide .pad { min-height: 48px; }
    @keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .sheet, .backdrop { animation: none; } }
    main { padding-bottom: 70px; }
    .nav { background: linear-gradient(to bottom, rgba(0,0,0,.85), transparent); }
  }
  @media (min-width: 721px) { .sheet, .backdrop { display: none; } }
</style>
