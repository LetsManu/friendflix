<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  let devices: any[] = [];
  const load = async () => (devices = (await api('/api/devices')).devices);
  onMount(load);
  async function approve(id: string) { await api(`/api/devices/${id}/approve`, { method: 'POST' }).catch(() => alert('Bitte auf einem freigegebenen Gerät bestätigen.')); load(); }
  async function remove(id: string) { await api(`/api/devices/${id}`, { method: 'DELETE' }); load(); }
</script>
<h1>Geräte</h1>
<p class="muted">Neue Geräte müssen einmalig von einem bereits freigegebenen Gerät bestätigt werden.</p>
<table>
  <thead><tr><th>Gerät</th><th>Zuletzt gesehen</th><th>Status</th><th></th></tr></thead>
  <tbody>
    {#each devices as d}
      <tr>
        <td>{d.label} {#if d.current}<span class="badge">dieses Gerät</span>{/if}</td>
        <td>{new Date(d.last_seen).toLocaleString('de-DE')}</td>
        <td>{#if d.approved}<span class="ok">freigegeben</span>{:else}<span class="warn">wartet</span>{/if}</td>
        <td class="flex">
          {#if !d.approved && !d.current}<button on:click={() => approve(d.id)}>Freigeben</button>{/if}
          {#if !d.current}<button class="sec" on:click={() => remove(d.id)}>Entfernen</button>{/if}
        </td>
      </tr>
    {/each}
  </tbody>
</table>
