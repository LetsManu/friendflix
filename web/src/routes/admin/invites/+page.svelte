<script lang="ts">
  import { intlLocale } from '#lib/i18n';
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  let invites: any[] = [], role = 'friend', ttl = 48, note = '', existing = false, created: { link: string; authentik?: 'off' | 'skipped' | 'ok' | 'failed' } | null = null;
  const load = async () => (invites = (await api('/api/admin/invites')).invites);
  onMount(load);
  async function create() { created = await api('/api/admin/invites', { method: 'POST', body: { role, ttlHours: ttl, note: note || undefined, enroll: !existing } }); note = ''; load(); }
  async function revoke(id: string) { await api(`/api/admin/invites/${id}`, { method: 'DELETE' }); load(); }
</script>
<div class="panel flex">
  <select bind:value={role}><option value="friend">Freund</option><option value="family">Familie</option><option value="guest">Gast</option></select>
  <label>gültig <input type="number" min="1" max="336" bind:value={ttl} style="width:5rem" /> Std.</label>
  <input placeholder="Notiz (z. B. Name)" bind:value={note} />
  <label><input type="checkbox" bind:checked={existing} /> hat schon ein Authentik-Konto</label>
  <button on:click={create}>Einladung erstellen</button>
</div>
{#if created}<div class="panel"><b>Einmal-Link (wird nur jetzt angezeigt):</b><br /><input readonly value={created.link} style="width:100%" on:focus={(e) => e.currentTarget.select()} />
  {#if created.authentik === 'ok'}<p class="ok">Der Link führt durch die Konto-Erstellung (inkl. Zwei-Faktor) und schaltet den Zugang direkt frei.</p>
  {:else if created.authentik === 'failed'}<p class="warn">Authentik-Einladung konnte nicht erstellt werden (siehe Backend-Log). Der Link funktioniert nur mit bestehendem Authentik-Konto.</p>
  {:else if created.authentik === 'off'}<p class="muted">Authentik-Einladungen sind nicht konfiguriert: Der Link funktioniert nur mit bestehendem Authentik-Konto.</p>{/if}
</div>{/if}
<table>
  <thead><tr><th>Rolle</th><th>Notiz</th><th>Gültig bis</th><th>Status</th><th></th></tr></thead>
  <tbody>
    {#each invites as i}
      <tr><td>{i.role}</td><td>{i.note ?? ''}</td><td>{new Date(i.expires_at).toLocaleString(intlLocale())}</td>
        <td>{#if i.used_at}<span class="ok">eingelöst von {i.used_by_name ?? '?'}</span>{:else if new Date(i.expires_at) < new Date()}<span class="muted">abgelaufen</span>{:else}<span class="warn">offen</span>{/if}</td>
        <td>{#if !i.used_at}<button class="sec" on:click={() => revoke(i.id)}>Widerrufen</button>{/if}</td></tr>
    {/each}
  </tbody>
</table>
