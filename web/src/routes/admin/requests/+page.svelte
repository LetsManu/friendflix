<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  let list: any[] = [], filter = 'pending';
  const load = async () => (list = (await api(`/api/admin/requests?filter=${filter}`)).requests);
  onMount(load);
  async function act(id: number, action: 'approve' | 'decline') { await api(`/api/admin/requests/${id}/${action}`, { method: 'POST' }); load(); }
</script>
<div class="flex"><select bind:value={filter} on:change={load}><option value="pending">Offen</option><option value="approved">Freigegeben</option><option value="processing">In Arbeit</option><option value="available">Verfügbar</option><option value="all">Alle</option></select></div>
<table style="margin-top:1rem">
  <thead><tr><th>Titel</th><th>Von</th><th>Typ</th><th>Status</th><th></th></tr></thead>
  <tbody>{#each list as r}<tr><td>{r.title}</td><td>{r.requestedBy}</td><td>{r.mediaType === 'tv' ? 'Serie' : 'Film'}</td><td>{r.status}</td>
    <td class="flex">{#if r.status === 'angefragt'}<button on:click={() => act(r.id, 'approve')}>Freigeben</button><button class="sec" on:click={() => act(r.id, 'decline')}>Ablehnen</button>{/if}</td></tr>{/each}</tbody>
</table>
