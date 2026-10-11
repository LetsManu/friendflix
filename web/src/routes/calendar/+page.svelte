<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { episodeKey, loadReminders, remindKeys, toggleReminder } from '#lib/reminders';
  let items: any[] = [];
  let msg = '';
  onMount(async () => { void loadReminders(); items = (await api('/api/calendar')).items; });
  async function follow(e: any) { await api(`/api/series/${e.seriesId}/follow`, { method: e.followed ? 'DELETE' : 'POST' }); items = items.map((i) => (i.seriesId === e.seriesId ? { ...i, followed: !e.followed } : i)); }
  const future = (e: any) => !e.premiereDate || new Date(e.premiereDate).getTime() > Date.now();
  async function remind(e: any) {
    const r = await toggleReminder(episodeKey(e.id), { episodeId: e.id });
    msg = r === 'available' ? 'Schon verfügbar' : r === 'error' ? 'Erinnerung konnte nicht gespeichert werden.' : '';
  }
</script>
<h1>Serien-Kalender</h1>
<p class="muted">Folge Serien, um bei neuen Folgen benachrichtigt zu werden.</p>
{#if msg}<p class="warn" role="status">{msg}</p>{/if}
{#if !items.length}<p class="muted">Keine kommenden Folgen.</p>{/if}
<table><tbody>{#each items as e}<tr>
  <td>{e.premiereDate ? new Date(e.premiereDate).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '?'}</td>
  <td><a href="/item/{e.seriesId}">{e.seriesName}</a> S{e.parentIndexNumber}E{e.indexNumber} – {e.name}</td>
  <td><button class:sec={!e.followed} on:click={() => follow(e)}>{e.followed ? 'Folge ich' : 'Folgen'}</button>
    {#if future(e)}
      {#if e.followed}<span class="muted">via Folgen</span>
      {:else}<button class="sec" aria-pressed={$remindKeys[episodeKey(e.id)] !== undefined} aria-label="Erinnere mich an diese Folge" on:click={() => remind(e)}><Icon name="bell" size={16} /> {$remindKeys[episodeKey(e.id)] !== undefined ? 'Erinnerung aktiv' : 'Erinnere mich'}</button>{/if}
    {/if}</td></tr>{/each}</tbody></table>
