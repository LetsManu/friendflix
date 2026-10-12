<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  interface AdminList { id: string; name: string; owner: { id: string; name: string }; itemCount: number; featured: boolean }
  let lists: AdminList[] | null = null, msg = '', failed = false, busy = '';
  const MAX = 5;
  $: count = lists ? lists.filter((l) => l.featured).length : 0;

  async function load() {
    try { lists = (await api('/api/admin/lists')).lists; failed = false; } catch { lists = []; failed = true; }
  }
  async function toggle(l: AdminList) {
    if (busy) return;
    busy = l.id; msg = '';
    const next = !l.featured;
    try {
      await api(`/api/admin/lists/${l.id}/featured`, { method: 'PUT', body: { featured: next } });
      l.featured = next; lists = lists;
      msg = next ? `„${l.name}“ wird jetzt auf der Startseite gezeigt.` : `„${l.name}“ wird nicht mehr auf der Startseite gezeigt.`;
    } catch (e) {
      msg = e instanceof ApiError && e.status === 409 ? `Es können höchstens ${MAX} Listen auf der Startseite gezeigt werden.` : e instanceof ApiError && e.status === 404 ? 'Die Liste gibt es nicht mehr.' : 'Das hat nicht geklappt.';
      if (e instanceof ApiError && e.status === 404) await load();
    }
    busy = '';
  }
  onMount(load);
</script>

<p class="muted">Ausgewählte Listen erscheinen für alle als Reihe „Empfohlen von …“ auf der Startseite (höchstens {MAX}, aktuell {count}). Sie sind dann für alle lesbar; bearbeiten dürfen weiterhin nur Mitglieder.</p>
<p role="status" aria-live="polite" class="msg">{msg}</p>
{#if lists === null}<p class="muted">Lädt …</p>
{:else if failed}<p class="err" role="alert">Listen konnten nicht geladen werden. <button type="button" class="sec" on:click={load}>Erneut versuchen</button></p>
{:else if !lists.length}<p class="muted">Noch keine Listen.</p>
{:else}
  <ul class="ls">
    {#each lists as l (l.id)}
      <li class="panel">
        <div class="info"><a href="/lists/{l.id}"><b>{l.name}</b></a><span class="muted"> von {l.owner.name} · {l.itemCount} Titel</span></div>
        <button type="button" class:sec={!l.featured} aria-pressed={l.featured} disabled={busy === l.id} on:click={() => toggle(l)}>Auf der Startseite zeigen<span class="sr-only">: {l.name}</span></button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .ls { list-style: none; padding: 0; margin: 0; display: grid; gap: .6rem; }
  .ls li { display: flex; gap: .8rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .info { min-width: 0; overflow-wrap: anywhere; }
  .ls button { min-height: 44px; }
  .ls button[aria-pressed='true']::before { content: '✓ '; }
  .msg { min-height: 1.4em; }
</style>
