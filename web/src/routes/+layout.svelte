<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { api, setCsrf, type Me } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  import Logo from '$lib/Logo.svelte';
  import { loadList, loadPrefs } from '$lib/stores';
  import ItemModal from '$lib/ItemModal.svelte';
  import { startTvLink, type ToTv } from '$lib/remote';
  import { focusEl, focusFirst, isBackKey, isEditable, startSpatial } from '$lib/spatial';

  let me: Me | null = null;
  /** TV mode: big UI, D-pad navigation. On for paired televisions; `?tv=1` previews it in any browser (`?tv=0` ends the preview). */
  let tv = false;
  let pending = false, checking = false;
  let notes: Array<{ id: number; title: string; link?: string; read: boolean }> = [];
  let scrolled = false, menu = false, bell = false, searchOpen = false, more = false, q = '';
  let searchEl: HTMLInputElement;

  $: path = $page.url.pathname;
  $: publicPage = path.startsWith('/invite/') || path === '/tv';
  $: watchPage = path.startsWith('/watch/') || /^\/party\/[^/]+/.test(path); // immersive player pages: no navigation
  $: heroPage = path === '/' || path.startsWith('/item/');
  $: unread = notes.filter((n) => !n.read).length;
  $: if (path) { menu = false; bell = false; more = false; }
  $: if (!publicPage) document.documentElement.classList.toggle('tv', tv);

  const tabs: Array<[string, string, string]> = [['/', 'Start', 'home'], ['/browse/series', 'Serien', 'film'], ['/browse/movies', 'Filme', 'film'], ['/new', 'Neu & beliebt', 'star'], ['/watchlist', 'Meine Liste', 'plus']];
  const menuLinks: Array<[string, string, string]> = [
    ['/tonight', 'Heute Abend', 'star'], ['/favorites', 'Favoriten', 'heart'], ['/match', 'Gruppen-Matcher', 'users'], ['/collections', 'Sammlungen', 'film'], ['/upcoming', 'Demnächst', 'calendar'], ['/requests', 'Wünsche', 'gift'], ['/party', 'Watch-Party', 'users'], ['/vote', 'Filmabend', 'vote'],
    ['/now', 'Läuft gerade', 'monitor'], ['/calendar', 'Kalender', 'calendar'], ['/stats', 'Wrapped', 'bar-chart'], ['/remote', 'Fernbedienung', 'tv'], ['/settings', 'Einstellungen', 'settings'], ['/devices', 'Geräte', 'monitor'],
  ];

  async function loadNotes() { try { notes = (await api('/api/notifications')).notifications; } catch { /* ignore */ } }
  async function toggleBell() {
    bell = !bell; menu = false;
    if (bell && unread) { await api('/api/notifications/read', { method: 'POST' }); setTimeout(loadNotes, 1500); }
  }
  async function logout() { await api('/auth/logout', { method: 'POST' }); location.href = me?.tv ? '/tv' : '/auth/login'; }
  async function surprise() {
    try { goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { goto('/browse/movies'); }
  }
  function openSearch() { searchOpen = true; setTimeout(() => searchEl?.focus(), 30); }
  function submitSearch() { if (q.trim()) goto(`/search?q=${encodeURIComponent(q.trim())}`); }
  function onKey(e: KeyboardEvent) {
    const back = e.key === 'Escape' || (tv && isBackKey(e));
    if (!back) return;
    if (menu || bell || more) { menu = bell = more = false; if (tv) e.preventDefault(); return; } // dropdowns close first
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

  function outside(e: MouseEvent) { if (!(e.target as HTMLElement).closest('.pop-anchor')) { menu = false; bell = false; } }

  let stops: Array<() => void> = [];
  onMount(() => {
    const onScroll = () => (scrolled = window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    const flag = new URLSearchParams(location.search).get('tv');
    if (flag === '1') sessionStorage.setItem('ff_tv', '1'); else if (flag === '0') sessionStorage.removeItem('ff_tv');
    void boot();
    return () => { window.removeEventListener('scroll', onScroll); stops.forEach((f) => f()); };
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
        pending = !me.deviceApproved;
        if (pending) stops.push(watchApproval());
        tv = me.tv || sessionStorage.getItem('ff_tv') === '1';
        if (!pending) { loadNotes(); loadList(); loadPrefs(); setInterval(loadNotes, 60_000); }
        if (me.tv) localStorage.setItem('ff_tv_device', '1'); // an expired TV session goes back to the pairing screen, not to a login form
        if (tv) {
          stops.push(startSpatial(() => !watchPage || Boolean(document.activeElement?.closest('[data-nav]'))));
          if (!watchPage) void settleFocus();
        }
        if (me.tv && !pending) stops.push(startTvLink(onTvCommand, (code) => { if (code === 4401) location.href = '/tv'; }));
      } catch { /* api() redirects to login on 401 */ }
    }
  }
</script>

<svelte:window on:keydown={onKey} on:click={outside} />
<a class="skip" href="#main">Zum Inhalt springen</a>

{#if publicPage}
  <slot />
{:else if me}
  {#if !watchPage}
    <header class="nav" class:solid={scrolled || !heroPage}>
      <a class="logo" href="/" aria-label="FriendFlix Startseite"><Logo wordmark size={34} /></a>
      <nav class="links" aria-label="Hauptnavigation">
        {#each tabs as [href, label]}<a {href} class:active={href === '/' ? path === '/' : path.startsWith(href)} aria-current={href === '/' ? (path === '/' ? 'page' : undefined) : path.startsWith(href) ? 'page' : undefined}>{label}</a>{/each}
      </nav>
      <span class="sp"></span>
      <form class="search" class:open={searchOpen} on:submit|preventDefault={submitSearch} role="search">
        <button type="button" class="icon-btn" aria-label="Suche öffnen" on:click={() => (searchOpen ? submitSearch() : openSearch())}><Icon name="search" size={22} /></button>
        <input bind:this={searchEl} bind:value={q} placeholder="Titel, Genre …" aria-label="Suche" on:blur={() => { if (!q) searchOpen = false; }} />
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
        <button class="avatar" aria-label="Profilmenü" aria-expanded={menu} on:click={() => { menu = !menu; bell = false; }}><span class="face">{me.name.slice(0, 1).toUpperCase()}</span><i class="caret" class:up={menu}></i></button>
        {#if menu}
          <div class="drop" role="menu">
            <div class="who"><b>{me.name}</b><span class="muted">{me.roleLabel}</span></div>
            {#each menuLinks as [href, label, icon]}<a {href} role="menuitem"><Icon name={icon} size={18} />{label}</a>{/each}
            {#if me.isAdmin}<a href="/admin" role="menuitem"><Icon name="shield" size={18} />Admin</a>{/if}
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
      <button class="tab" aria-expanded={more} on:click|stopPropagation={() => (more = !more)}><Icon name="menu" size={22} /><span>Mehr</span></button>
    </nav>
    {#if more}
      <div class="sheet" role="menu">
        {#each menuLinks as [href, label, icon]}<a {href} role="menuitem"><Icon name={icon} size={20} />{label}</a>{/each}
        {#if me.isAdmin}<a href="/admin" role="menuitem"><Icon name="shield" size={20} />Admin</a>{/if}
        <button class="plain" on:click={logout}><Icon name="log-out" size={20} />Abmelden</button>
      </div>
    {/if}
  {/if}

  {#if $page.state.modalId}<ItemModal id={$page.state.modalId} />{/if}
  <main id="main" class:page={!heroPage && !watchPage}>
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
    .tabbar a, .tabbar .tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .1rem; min-height: 56px; font-size: .68rem; color: var(--mut); background: transparent; border-radius: 0; font-weight: 500; }
    .tabbar a.active { color: #fff; }
    .sheet { position: fixed; left: 0; right: 0; bottom: calc(56px + env(safe-area-inset-bottom)); z-index: 59; background: #0d0d0d; border-top: 1px solid #333; display: grid; grid-template-columns: 1fr 1fr; padding: .4rem; }
    .sheet a, .sheet .plain { display: flex; gap: .6rem; align-items: center; padding: .7rem; min-height: 48px; color: #e5e5e5; }
    main { padding-bottom: 70px; }
    .nav { background: linear-gradient(to bottom, rgba(0,0,0,.85), transparent); }
  }
  @media (min-width: 721px) { .sheet { display: none; } }
</style>
