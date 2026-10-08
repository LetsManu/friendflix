<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api, ApiError } from '$lib/api';

  let q = $page.url.searchParams.get('q') ?? '', results: any[] = [], mine: any[] = [], msg = '', busy = false;
  const label: Record<string, string> = { nicht_angefragt: '', angefragt: 'Angefragt', in_arbeit: 'In Arbeit', teilweise: 'Teilweise verfügbar', verfuegbar: 'Verfügbar', abgelehnt: 'Abgelehnt', entfernt: 'Entfernt' };
  const cls: Record<string, string> = { verfuegbar: 'ok', in_arbeit: 'warn', angefragt: 'warn', abgelehnt: 'err' };

  const loadMine = async () => (mine = (await api('/api/requests/mine')).requests);
  async function search() {
    if (q.trim().length < 2) return;
    busy = true; msg = '';
    try { results = (await api(`/api/seerr/search?q=${encodeURIComponent(q.trim())}`)).results; } catch { msg = 'Suche derzeit nicht möglich.'; }
    busy = false;
  }
  async function request(r: any) {
    try {
      await api('/api/requests', { method: 'POST', body: { mediaType: r.mediaType, tmdbId: r.tmdbId } });
      r.status = 'angefragt'; results = results; msg = `„${r.title}“ wurde gewünscht. Ein Admin gibt es frei.`; loadMine();
    } catch (e) { msg = e instanceof ApiError && e.status === 409 ? 'Dafür gibt es schon einen Wunsch.' : 'Wunsch konnte nicht gestellt werden.'; }
  }
  onMount(() => { loadMine(); if (q) search(); });
</script>

<h1>Wünsche</h1>
<form class="flex" on:submit|preventDefault={search}>
  <input placeholder="Film oder Serie suchen …" bind:value={q} style="width:100%;max-width:480px" />
  <button disabled={busy}>Suchen</button>
</form>
{#if msg}<p class="warn">{msg}</p>{/if}
<div class="grid" style="margin-top:1rem">
  {#each results as r}
    <div class="card">
      {#if r.poster}<img loading="lazy" src={r.poster} alt={r.title} />{:else}<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />{/if}
      <div class="t">{r.title}<small>{r.year ?? ''} · {r.mediaType === 'tv' ? 'Serie' : 'Film'}</small>
        {#if r.status === 'nicht_angefragt' || r.status === 'abgelehnt'}<button style="margin-top:.4rem;width:100%" on:click={() => request(r)}>Wünschen</button>
        {:else}<span class={cls[r.status]}>{label[r.status]}</span>{/if}
      </div>
    </div>
  {/each}
</div>
<h2 style="margin-top:2rem">Meine Wünsche</h2>
{#if !mine.length}<p class="muted">Noch nichts gewünscht.</p>{/if}
<table><tbody>{#each mine as m}<tr><td>{m.title}</td><td>{m.mediaType === 'tv' ? 'Serie' : 'Film'}</td><td class={cls[m.status]}>{label[m.status] ?? m.status}</td><td class="muted">{new Date(m.createdAt).toLocaleDateString('de-DE')}</td></tr>{/each}</tbody></table>
