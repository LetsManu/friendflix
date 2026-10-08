<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  let items: any[] = [];
  onMount(async () => (items = (await api('/api/calendar')).items));
  async function follow(e: any) { await api(`/api/series/${e.seriesId}/follow`, { method: e.followed ? 'DELETE' : 'POST' }); items = items.map((i) => (i.seriesId === e.seriesId ? { ...i, followed: !e.followed } : i)); }
</script>
<h1>Serien-Kalender</h1>
<p class="muted">Folge Serien, um bei neuen Folgen benachrichtigt zu werden.</p>
{#if !items.length}<p class="muted">Keine kommenden Folgen.</p>{/if}
<table><tbody>{#each items as e}<tr>
  <td>{e.premiereDate ? new Date(e.premiereDate).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '?'}</td>
  <td><a href="/item/{e.seriesId}">{e.seriesName}</a> S{e.parentIndexNumber}E{e.indexNumber} – {e.name}</td>
  <td><button class:sec={!e.followed} on:click={() => follow(e)}>{e.followed ? '🔔 Folge ich' : 'Folgen'}</button></td></tr>{/each}</tbody></table>
