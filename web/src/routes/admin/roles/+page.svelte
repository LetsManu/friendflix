<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  type Row = { role: string; label: string; requestsPerMonth: number | null; isDefault: boolean; value: number; unlimited: boolean };
  let rows: Row[] = [];
  const load = async () => (rows = (await api('/api/admin/roles')).limits.map((r: any) => ({ ...r, value: r.requestsPerMonth ?? 2, unlimited: r.requestsPerMonth === null })));
  onMount(load);
  async function save(r: Row) {
    const v = Math.round(Number(r.value));
    if (!r.unlimited && !(v >= 0 && v <= 100)) return alert('Bitte eine Zahl von 0 bis 100 eingeben.');
    try { await api(`/api/admin/roles/${encodeURIComponent(r.role)}`, { method: 'PUT', body: { requestsPerMonth: r.unlimited ? null : v } }); } catch { alert('Speichern nicht möglich.'); }
    load();
  }
</script>
<p class="muted">Wie viele Titel pro Kalendermonat sich eine Rolle wünschen darf. Über Abstimmungen freigegebene Titel zählen nicht mit.</p>
<table>
  <thead><tr><th>Rolle</th><th>Wünsche pro Monat</th><th></th></tr></thead>
  <tbody>
    {#each rows as r (r.role)}
      <tr>
        <td>{r.label} <span class="muted">({r.role})</span></td>
        <td class="flex">
          <input type="number" min="0" max="100" aria-label="Wünsche pro Monat" bind:value={r.value} disabled={r.unlimited} style="width:6rem" />
          <label><input type="checkbox" bind:checked={r.unlimited} /> Unbegrenzt</label>
          {#if r.isDefault}<span class="muted">Standard</span>{/if}
        </td>
        <td><button on:click={() => save(r)}>Speichern</button></td>
      </tr>
    {/each}
  </tbody>
</table>
