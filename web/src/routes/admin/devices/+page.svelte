<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  let devices: any[] = [];
  const load = async () => (devices = (await api('/api/admin/devices')).devices);
  onMount(load);
  async function approve(d: any) { await api('/api/admin/devices/approve', { method: 'POST', body: { userId: d.user_id, deviceId: d.device_id } }); load(); }
</script>
<table>
  <thead><tr><th>Nutzer</th><th>Gerät</th><th>Zuletzt</th><th>Status</th><th></th></tr></thead>
  <tbody>{#each devices as d}<tr><td>{d.name}</td><td>{d.label}</td><td>{new Date(d.last_seen).toLocaleString('de-DE')}</td>
    <td>{#if d.approved}<span class="ok">ok</span>{:else}<span class="warn">wartet</span>{/if}</td><td>{#if !d.approved}<button on:click={() => approve(d)}>Freigeben</button>{/if}</td></tr>{/each}</tbody>
</table>
