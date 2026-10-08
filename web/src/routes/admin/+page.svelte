<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  let users: any[] = [], roles: Record<string, { label: string }> = {};
  const load = async () => { users = (await api('/api/admin/users')).users; roles = (await api('/api/admin/roles')).roles; };
  onMount(load);
  async function kick(id: string) { const r = await api(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST' }); alert(`${r.revoked} Sitzung(en) beendet.`); }
  async function patch(id: string, body: object) { try { await api(`/api/admin/users/${id}`, { method: 'PATCH', body }); } catch { alert('Aktion nicht möglich.'); } load(); }
</script>
<table>
  <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Jellyfin</th><th>Status</th><th></th></tr></thead>
  <tbody>
    {#each users as u}
      <tr>
        <td>{u.name}</td><td class="muted">{u.email ?? ''}</td>
        <td><select value={u.role} on:change={(e) => patch(u.id, { role: e.currentTarget.value })}>{#each Object.entries(roles) as [k, r]}<option value={k}>{r.label}</option>{/each}</select></td>
        <td class="muted">{u.jellyfin_username}</td>
        <td>{#if u.disabled}<span class="err">gesperrt</span>{:else}<span class="ok">aktiv</span>{/if}</td>
        <td class="flex"><button class="sec" on:click={() => patch(u.id, { disabled: !u.disabled })}>{u.disabled ? 'Entsperren' : 'Sperren'}</button><button class="sec" on:click={() => kick(u.id)}>Abmelden</button></td>
      </tr>
    {/each}
  </tbody>
</table>
