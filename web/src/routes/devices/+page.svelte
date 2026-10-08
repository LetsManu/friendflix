<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';
  interface Dev { id: string; label: string; approved: boolean; current: boolean; last_seen: string }
  let devices: Dev[] = [], me: { deviceApproved: boolean } | null = null, msg = '', err = '', busy = '';
  const load = async () => { devices = (await api('/api/devices')).devices; };
  onMount(() => {
    void load();
    api('/api/me').then((m) => (me = m)).catch(() => undefined);
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000); // a newly signed-in device shows up by itself
    return () => clearInterval(t);
  });
  $: pending = devices.filter((d) => !d.approved && !d.current);
  $: others = devices.filter((d) => d.approved || d.current);
  async function approve(d: Dev) {
    busy = d.id; err = ''; msg = '';
    try { await api(`/api/devices/${d.id}/approve`, { method: 'POST' }); msg = `„${d.label}“ ist jetzt freigegeben und öffnet sich in wenigen Sekunden.`; }
    catch (e) {
      err = e instanceof ApiError && e.status === 403
        ? 'Dieses Gerät ist selbst noch nicht freigegeben. Bitte auf einem bereits freigegebenen Gerät bestätigen – oder ein Admin gibt es unter Admin → Geräte frei.'
        : 'Freigeben hat nicht geklappt. Bitte neu laden und noch einmal versuchen.';
    } finally { busy = ''; await load(); }
  }
  async function revokeOthers() { const r = await api('/api/sessions/revoke-others', { method: 'POST' }); msg = `${r.revoked} andere Sitzung(en) beendet.`; }
  async function remove(d: Dev) { if (!confirm(`„${d.label}“ wirklich entfernen? Das Gerät wird abgemeldet.`)) return; await api(`/api/devices/${d.id}`, { method: 'DELETE' }); await load(); }
</script>

<h1>Geräte</h1>

<section class="panel how" aria-label="Neues Gerät hinzufügen">
  <h2>Neues Gerät hinzufügen</h2>
  <ol>
    <li>Öffne FriendFlix auf dem neuen Gerät und melde dich an.</li>
    <li>Das Gerät erscheint hier <b>automatisch</b> unter „Wartet auf Freigabe“ (die Liste aktualisiert sich alle paar Sekunden).</li>
    <li>Prüfe, ob der Name stimmt, und tippe auf <b>Freigeben</b>. Das neue Gerät öffnet sich danach von selbst.</li>
  </ol>
  {#if me && !me.deviceApproved}<p class="warn">Achtung: Dieses Gerät ist selbst noch nicht freigegeben – freigeben kannst du nur auf einem bereits freigegebenen Gerät (oder ein Admin unter Admin → Geräte).</p>{/if}
</section>

{#if msg}<p class="ok" role="status">{msg}</p>{/if}
{#if err}<p class="err" role="alert">{err}</p>{/if}

{#if pending.length}
  <section class="panel waiting" aria-label="Wartet auf Freigabe">
    <h2>Wartet auf Freigabe ({pending.length})</h2>
    {#each pending as d (d.id)}
      <div class="flex row">
        <div><b>{d.label}</b><div class="muted">zuletzt gesehen {new Date(d.last_seen).toLocaleString('de-DE')}</div></div>
        <span class="sp"></span>
        <button disabled={busy === d.id} on:click={() => approve(d)}>{busy === d.id ? 'Gebe frei …' : 'Freigeben'}</button>
        <button class="sec" on:click={() => remove(d)}>Ablehnen</button>
      </div>
    {/each}
  </section>
{:else}
  <p class="muted">Gerade wartet kein Gerät auf Freigabe.</p>
{/if}

<h2>Freigegebene Geräte</h2>
<p><button class="sec" on:click={revokeOthers}>Auf allen anderen Geräten abmelden</button></p>
<table>
  <thead><tr><th>Gerät</th><th>Zuletzt gesehen</th><th></th></tr></thead>
  <tbody>
    {#each others as d (d.id)}
      <tr>
        <td>{d.label} {#if d.current}<span class="badge">dieses Gerät</span>{/if}</td>
        <td>{new Date(d.last_seen).toLocaleString('de-DE')}</td>
        <td>{#if !d.current}<button class="sec" on:click={() => remove(d)}>Entfernen</button>{/if}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .how ol { margin: .3rem 0 0; padding-left: 1.3rem; display: grid; gap: .3rem; color: var(--mut); } .how b { color: var(--fg); }
  .waiting { border-color: var(--warn); }
  .row { padding: .5rem 0; border-top: 1px solid var(--line); } .row:first-of-type { border-top: 0; }
  .sp { flex: 1; }
  h2 { font-size: 1.15rem; }
</style>
