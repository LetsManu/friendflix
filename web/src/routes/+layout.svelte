<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { api, setCsrf, type Me } from '$lib/api';
  import Icon from '$lib/Icon.svelte';
  import { loadList } from '$lib/stores';
  import ItemModal from '$lib/ItemModal.svelte';

  let me: Me | null = null;
  let pending = false;
  let notes: Array<{ id: number; title: string; link?: string; read: boolean }> = [];
  let scrolled = false, menu = false, bell = false, searchOpen = false, more = false, q = '';
  let searchEl: HTMLInputElement;

  $: path = $page.url.pathname;
  $: publicPage = path.startsWith('/invite/');
  $: watchPage = path.startsWith('/watch/') || /^\/party\/[^/]+/.test(path); // immersive player pages: no navigation
  $: heroPage = path === '/' || path.startsWith('/item/');
  $: unread = notes.filter((n) => !n.read).length;
  $: if (path) { menu = false; bell = false; more = false; }

  const tabs: Array<[string, string, string]> = [['/', 'Start', 'home'], ['/browse/series', 'Serien', 'film'], ['/browse/movies', 'Filme', 'film'], ['/new', 'Neu & beliebt', 'star'], ['/watchlist', 'Meine Liste', 'plus']];
  const menuLinks: Array<[string, string, string]> = [
    ['/favorites', 'Favoriten', 'heart'], ['/requests', 'Wünsche', 'gift'], ['/party', 'Watch-Party', 'users'], ['/vote', 'Filmabend', 'vote'],
    ['/now', 'Läuft gerade', 'monitor'], ['/calendar', 'Kalender', 'calendar'], ['/stats', 'Wrapped', 'bar-chart'], ['/devices', 'Geräte', 'monitor'],
  ];

  async function loadNotes() { try { notes = (await api('/api/notifications')).notifications; } catch { /* ignore */ } }
  async function toggleBell() {
    bell = !bell; menu = false;
    if (bell && unread) { await api('/api/notifications/read', { method: 'POST' }); setTimeout(loadNotes, 1500); }
  }
  async function logout() { await api('/auth/logout', { method: 'POST' }); location.href = '/auth/login'; }
  async function surprise() {
    try { goto(`/item/${(await api('/api/library/random?type=Movie')).item.id}`); } catch { goto('/browse/movies'); }
  }
  function openSearch() { searchOpen = true; setTimeout(() => searchEl?.focus(), 30); }
  function submitSearch() { if (q.trim()) goto(`/search?q=${encodeURIComponent(q.trim())}`); }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { menu = bell = more = false; if (!q) searchOpen = false; } }
  function outside(e: MouseEvent) { if (!(e.target as HTMLElement).closest('.pop-anchor')) { menu = false; bell = false; } }

  onMount(() => {
    const onScroll = () => (scrolled = window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    void boot();
    return () => window.removeEventListener('scroll', onScroll);
  });

  async function boot() {
    if (!publicPage) {
      try {
        me = await api<Me>('/api/me');
        setCsrf(me.csrfToken);
        pending = !me.deviceApproved;
        if (!pending) { loadNotes(); loadList(); setInterval(loadNotes, 60_000); }
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
      <a class="logo" href="/" aria-label="FriendFlix Startseite">FRIENDFLIX</a>
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
        <button class="avatar" aria-label="Profilmenü" aria-expanded={menu} on:click={() => { menu = !menu; bell = false; }}>{me.name.slice(0, 1).toUpperCase()}</button>
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
      <div class="page"><div class="panel"><b class="warn">Dieses Gerät ist noch nicht freigegeben.</b><p class="muted">Bestätige es auf einem bereits freigegebenen Gerät unter „Geräte“ oder frage den Admin.</p><a class="btn sec" href="/devices">Geräte ansehen</a></div></div>
    {:else}
      <slot />
    {/if}
  </main>
{:else}
  <main id="main" class="boot"><span class="logo">FRIENDFLIX</span><div class="spin" aria-label="Lade …" role="status"></div></main>
{/if}

<style>
  .logo { font-weight: 900; letter-spacing: .06em; font-size: clamp(1.15rem, 2.4vw, 1.7rem); color: var(--acc); text-shadow: 0 1px 0 rgba(0,0,0,.4); }
  .nav { position: fixed; top: 0; left: 0; right: 0; height: var(--nav-h); z-index: 50; display: flex; align-items: center; gap: .5rem; padding: 0 var(--pad-x); background: linear-gradient(to bottom, rgba(0,0,0,.8), transparent); transition: background var(--t-med); }
  .nav.solid { background: var(--bg); }
  .links { display: flex; gap: 1.2rem; margin-left: 1.6rem; }
  .links a { font-size: .9rem; color: #e5e5e5; transition: color var(--t-fast); white-space: nowrap; padding: .6rem 0; }
  .links a:hover { color: #b3b3b3; } .links a.active { color: #fff; font-weight: 700; }
  .sp { flex: 1; }
  .search { display: flex; align-items: center; border: 1px solid transparent; transition: border-color var(--t-fast), background var(--t-fast); border-radius: 4px; }
  .search.open { border-color: #fff; background: rgba(0,0,0,.75); }
  .search input { width: 0; padding: 0; border: 0; background: transparent; transition: width var(--t-med) var(--ease), padding var(--t-med); min-height: 40px; }
  .search.open input { width: clamp(120px, 24vw, 280px); padding: 0 .5rem 0 0; }
  .search input:focus-visible { outline: none; }
  .pop-anchor { position: relative; }
  .dot { position: absolute; top: 4px; right: 2px; background: var(--acc); font-size: .65rem; min-width: 1.1rem; height: 1.1rem; border-radius: 99px; display: grid; place-items: center; font-weight: 700; }
  .avatar { width: 36px; min-height: 36px; height: 36px; border-radius: 4px; padding: 0; background: linear-gradient(135deg, #e50f2a, #7a0a17); font-weight: 800; }
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
