<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  let s: any = null;
  onMount(async () => (s = await api('/api/admin/status')));
</script>
{#if s}
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
    {#each [['Nutzer', s.users], ['Aktive Streams', s.activeStreams], ['Party-Räume', s.partyRooms], ['Offene Einladungen', s.openInvites], ['Geräte warten', s.pendingDevices], ['Abstimmungen warten', s.pendingPolls]] as [l, v]}
      <div class="panel"><h2>{v}</h2><span class="muted">{l}</span></div>{/each}
    <div class="panel"><h2 class={s.jellyfin ? 'ok' : 'err'}>{s.jellyfin ? 'OK' : 'Fehler'}</h2><span class="muted">Jellyfin</span></div>
  </div>
{/if}
