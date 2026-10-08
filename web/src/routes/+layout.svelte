<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api, setCsrf, type Me } from '$lib/api';

  let me: Me | null = null;
  let pending = false;
  let notes: Array<{ id: number; title: string; link?: string; read: boolean }> = [];
  let open = false;
  $: unread = notes.filter((n) => !n.read).length;
  async function loadNotes() { try { notes = (await api('/api/notifications')).notifications; } catch { /* ignore */ } }
  async function toggleNotes() { open = !open; if (open && unread) { await api('/api/notifications/read', { method: 'POST' }); setTimeout(loadNotes, 1500); } }
  $: path = $page.url.pathname;
  $: publicPage = path.startsWith('/invite/');

  onMount(async () => {
    if (publicPage) return;
    try {
      me = await api<Me>('/api/me');
      setCsrf(me.csrfToken);
      pending = !me.deviceApproved;
      if (!pending) { loadNotes(); setInterval(loadNotes, 60_000); }
    } catch {
      /* api() redirects to login on 401 */
    }
  });

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    location.href = '/auth/login';
  }
  const links: Array<[string, string]> = [
    ['/', 'Start'], ['/search', 'Suche'], ['/favorites', 'Favoriten'], ['/watchlist', 'Watchlist'], ['/requests', 'Wünsche'],
    ['/party', 'Watch-Party'], ['/vote', 'Filmabend'], ['/now', 'Läuft gerade'], ['/calendar', 'Kalender'], ['/stats', 'Wrapped'],
  ];
</script>

{#if publicPage}
  <slot />
{:else if me}
  <nav>
    <a class="brand" href="/">FriendFlix</a>
    {#each links as [href, label]}<a {href} class:active={href === '/' ? path === '/' : path.startsWith(href)}>{label}</a>{/each}
    {#if me.isAdmin}<a href="/admin" class:active={path.startsWith('/admin')}>Admin</a>{/if}
    <span class="sp"></span>
    <span style="position:relative"><button class="sec" on:click={toggleNotes} aria-label="Benachrichtigungen">🔔{#if unread} {unread}{/if}</button>
      {#if open}<div class="panel" style="position:absolute;right:0;top:2.4rem;width:320px;z-index:9">{#each notes as n}<a href={n.link ?? '#'} style="display:block;padding:.3rem 0" class:muted={n.read}>{n.title}</a>{:else}<span class="muted">Keine Benachrichtigungen</span>{/each}</div>{/if}</span>
    <a href="/devices" class="muted">{me.name} · {me.roleLabel}</a>
    <button class="sec" on:click={logout}>Abmelden</button>
  </nav>
  <main>
    {#if pending}
      <div class="panel warn">Dieses Gerät ist noch nicht freigegeben. Bitte bestätige es auf einem bereits freigegebenen Gerät unter „Geräte“ oder frage den Admin.</div>
      <a class="btn sec" href="/devices">Geräte</a>
    {:else}
      <slot />
    {/if}
  </main>
{:else}
  <main><p class="muted">Lade …</p></main>
{/if}
