<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api, type Item } from '$lib/api';
  import Card from '$lib/Card.svelte';

  let rooms: any[] = [], pick: Item | null = null, results: Item[] = [], q = '', delay = 0, busy = false;
  const preItem = $page.url.searchParams.get('item');
  async function load() { rooms = (await api('/api/party')).rooms; }
  async function search() {
    if (q.length < 2) return;
    results = (await api(`/api/library/items?q=${encodeURIComponent(q)}&types=Movie,Episode&limit=24`)).items;
  }
  async function create() {
    if (!pick) return;
    busy = true;
    const r = await api('/api/party', { method: 'POST', body: { itemId: pick.id, startInMinutes: delay || undefined } });
    location.href = `/party/${r.id}`;
  }
  onMount(async () => {
    load();
    if (preItem) pick = (await api(`/api/items/${preItem}`)).item;
  });
</script>

<h1>Watch-Party</h1>
<div class="panel">
  <h3>Neue Party</h3>
  {#if pick}
    <p>Gewählt: <b>{pick.name}</b> <button class="sec" on:click={() => (pick = null)}>ändern</button></p>
    <label>Start in <select bind:value={delay}><option value={0}>sofort (Host startet)</option><option value={5}>5 Min.</option><option value={15}>15 Min.</option><option value={60}>1 Std.</option></select></label>
    <button on:click={create} disabled={busy}>Party erstellen</button>
  {:else}
    <form class="flex" on:submit|preventDefault={search}><input placeholder="Film suchen …" bind:value={q} /><button>Suchen</button></form>
    <div class="grid" style="margin-top:1rem">{#each results as i}<a href="#pick" on:click|preventDefault={() => (pick = i)}><Card item={{ ...i, type: 'Movie' }} /></a>{/each}</div>
  {/if}
</div>
<h3>Offene Räume</h3>
{#if !rooms.length}<p class="muted">Gerade läuft keine Party.</p>{/if}
<table><tbody>{#each rooms as r}<tr><td>{r.title}</td><td class="muted">{r.hostName ?? ''} · {r.members} dabei</td><td>{#if r.startAt}<span class="badge">Start {new Date(r.startAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>{/if}</td><td><a class="btn" href="/party/{r.id}">Beitreten</a></td></tr>{/each}</tbody></table>
