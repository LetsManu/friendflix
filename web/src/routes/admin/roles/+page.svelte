<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  type Row = { role: string; label: string; requestsPerMonth: number | null; isDefault: boolean; value: number; unlimited: boolean; transcoding: boolean; maxHeight: number | null };
  const HEIGHTS = [720, 1080, 1440, 2160];
  let rows: Row[] = [];
  const load = async () => (rows = (await api('/api/admin/roles')).limits.map((r: any) => ({ ...r, value: r.requestsPerMonth ?? 2, unlimited: r.requestsPerMonth === null })));
  onMount(load);
  async function save(r: Row) {
    const v = Math.round(Number(r.value));
    if (!r.unlimited && !(v >= 0 && v <= 100)) return alert('Bitte eine Zahl von 0 bis 100 eingeben.');
    try { await api(`/api/admin/roles/${encodeURIComponent(r.role)}`, { method: 'PUT', body: { requestsPerMonth: r.unlimited ? null : v, transcoding: r.transcoding, maxHeight: r.maxHeight } }); } catch { alert('Speichern nicht möglich.'); }
    load();
  }
</script>
<p class="muted">Wie viele Titel pro Kalendermonat sich eine Rolle wünschen darf. Über Abstimmungen freigegebene Titel zählen nicht mit. „Umwandeln“ erlaubt dem Server, Filme für den Browser umzuwandeln; „Max. Auflösung“ begrenzt die Wiedergabe (4K-Originale werden dann heruntergerechnet).</p>
<table>
  <thead><tr><th>Rolle</th><th>Wünsche pro Monat</th><th>Wiedergabe</th><th></th></tr></thead>
  <tbody>
    {#each rows as r (r.role)}
      <tr>
        <td>{r.label} <span class="muted">({r.role})</span></td>
        <td class="flex">
          <input type="number" min="0" max="100" aria-label="Wünsche pro Monat" bind:value={r.value} disabled={r.unlimited} style="width:6rem" />
          <label><input type="checkbox" bind:checked={r.unlimited} /> Unbegrenzt</label>
          {#if r.isDefault}<span class="muted">Standard</span>{/if}
        </td>
        <td class="flex">
          <label><input type="checkbox" bind:checked={r.transcoding} /> Umwandeln erlaubt</label>
          <label>Max. Auflösung
            <select bind:value={r.maxHeight} aria-label="Max. Auflösung">
              {#each HEIGHTS as h}<option value={h}>{h}p</option>{/each}
              <option value={null}>unbegrenzt</option>
            </select>
          </label>
        </td>
        <td><button on:click={() => save(r)}>Speichern</button></td>
      </tr>
    {/each}
  </tbody>
</table>
