<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  let polls: any[] = [];
  const load = async () => (polls = (await api('/api/admin/polls')).polls);
  onMount(load);
  async function act(id: string, a: 'approve' | 'reject') { await api(`/api/admin/polls/${id}/${a}`, { method: 'POST' }); load(); }
</script>
<p class="muted">Gewinner, die noch nicht in der Bibliothek sind. Freigabe erzeugt einen Seerr-Wunsch und plant den Filmabend, sobald der Titel da ist.</p>
{#each polls as p}
  {@const w = p.options.find((o: any) => o.id === p.winnerOptionId)}
  <div class="panel flex"><b>{p.title}</b> → „{w?.title}“ <span class="muted">({p.creator})</span><button on:click={() => act(p.id, 'approve')}>Freigeben</button><button class="sec" on:click={() => act(p.id, 'reject')}>Ablehnen</button></div>
{:else}<p class="muted">Nichts offen.</p>{/each}
