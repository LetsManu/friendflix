<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api, type Item } from '$lib/api';

  let polls: any[] = [], now = Date.now(), timer: ReturnType<typeof setInterval>, msg = '';
  let creating = false, title = 'Filmabend', closes = 60, after = 10, options: Array<{ key: string; label: string; body: object }> = [];
  let q = '', libResults: Item[] = [], wishResults: any[] = [];
  const statusLabel: Record<string, string> = { open: 'Läuft', scheduled: 'Steht fest', needs_approval: 'Wartet auf Admin', requested: 'Wurde angefragt', started: 'Gestartet', cancelled: 'Abgebrochen' };

  const load = async () => (polls = (await api('/api/polls')).polls);
  const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ' h ' : ''}${Math.floor((s % 3600) / 60)} min ${s % 60} s`; };
  async function vote(p: any, optionId: number) { try { await api(`/api/polls/${p.id}/vote`, { method: 'POST', body: { optionId } }); load(); } catch { msg = 'Abstimmung ist beendet.'; load(); } }
  async function search() {
    if (q.length < 2) return;
    libResults = (await api(`/api/library/items?q=${encodeURIComponent(q)}&types=Movie&limit=12`)).items;
    wishResults = (await api(`/api/seerr/search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }))).results.filter((r: any) => r.status === 'nicht_angefragt');
  }
  const add = (key: string, label: string, body: object) => { if (!options.some((o) => o.key === key)) options = [...options, { key, label, body }]; };
  async function create() {
    try {
      await api('/api/polls', { method: 'POST', body: { title, options: options.map((o) => o.body), closesInMinutes: closes, startsAfterMinutes: after } });
      creating = false; options = []; load();
    } catch (e: any) { msg = e?.body?.error === 'poll_already_open' ? 'Du hast schon eine offene Abstimmung.' : 'Abstimmung konnte nicht erstellt werden.'; }
  }
  onMount(() => { load(); timer = setInterval(() => { now = Date.now(); }, 1000); setInterval(load, 15000); });
  onDestroy(() => clearInterval(timer));
</script>

<h1>Filmabend</h1>
{#if msg}<p class="warn">{msg}</p>{/if}
<button on:click={() => (creating = !creating)}>{creating ? 'Abbrechen' : 'Neue Abstimmung'}</button>
{#if creating}
  <div class="panel" style="margin-top:1rem">
    <div class="flex"><input bind:value={title} maxlength="80" /><label>Dauer <input type="number" min="5" bind:value={closes} style="width:5rem" /> Min.</label><label>Start danach <input type="number" min="0" bind:value={after} style="width:5rem" /> Min.</label></div>
    <form class="flex" style="margin:.8rem 0" on:submit|preventDefault={search}><input placeholder="Titel suchen (Bibliothek &amp; Wunschliste)" bind:value={q} /><button>Suchen</button></form>
    <div class="flex">
      {#each libResults as i}<button class="sec" on:click={() => add(i.id, i.name, { jfItemId: i.id })}>+ {i.name}</button>{/each}
      {#each wishResults as r}<button class="sec" on:click={() => add(`t${r.tmdbId}`, `${r.title} (noch nicht da)`, { tmdbId: r.tmdbId, mediaType: r.mediaType })}>+ {r.title} 📥</button>{/each}
    </div>
    <p class="muted">Titel, die noch nicht in der Bibliothek sind (📥), werden nach einer Admin-Freigabe automatisch angefragt.</p>
    <b>Auswahl ({options.length}/10, mind. 2):</b> {#each options as o}<span class="badge">{o.label} <a href="#x" on:click|preventDefault={() => (options = options.filter((x) => x !== o))}>✕</a></span> {/each}
    <p><button disabled={options.length < 2} on:click={create}>Abstimmung starten</button></p>
  </div>
{/if}

{#each polls as p}
  <div class="panel">
    <h3>{p.title} <span class="badge">{statusLabel[p.status] ?? p.status}</span></h3>
    <p class="muted">von {p.creator}
      {#if p.status === 'open'}· endet in {fmt(new Date(p.closesAt).getTime() - now)}{/if}
      {#if p.status === 'scheduled'}· Start in {fmt(new Date(p.startsAt).getTime() - now)}{/if}</p>
    {#each p.options as o}
      {@const total = p.options.reduce((a: number, x: any) => a + x.votes, 0) || 1}
      <div class="flex" style="margin:.3rem 0">
        <button class:sec={p.myVote !== o.id} disabled={p.status !== 'open'} on:click={() => vote(p, o.id)} style="min-width:14rem;text-align:left">{o.title}{o.inLibrary ? '' : ' 📥'}{p.winnerOptionId === o.id ? ' 🏆' : ''}</button>
        <div class="bar" style="flex:1;min-width:80px"><i style="width:{(o.votes / total) * 100}%"></i></div><span>{o.votes}</span>
      </div>
    {/each}
    {#if p.roomId && (p.status === 'scheduled' || p.status === 'started')}<a class="btn" href="/party/{p.roomId}">Zum Raum</a>{/if}
  </div>
{/each}
{#if !polls.length}<p class="muted">Keine aktuellen Abstimmungen.</p>{/if}
