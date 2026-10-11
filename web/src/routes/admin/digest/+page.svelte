<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  const DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  let s: { enabled: boolean; day: number; hour: number; source: 'config' | 'admin'; lastRun: { week: string; sentAt: string; count: number } | null } | null = null;
  let busy = false, msg = '', err = '';
  const apply = (r: NonNullable<typeof s>) => (s = r);
  onMount(() => { api('/api/admin/digest').then(apply).catch(() => (err = 'Laden fehlgeschlagen.')); });
  async function save() {
    if (!s) return;
    busy = true; msg = ''; err = '';
    try { apply(await api('/api/admin/digest', { method: 'PUT', body: { enabled: s.enabled, day: Number(s.day), hour: Number(s.hour) } })); msg = 'Gespeichert.'; } catch { err = 'Speichern fehlgeschlagen.'; }
    busy = false;
  }
  async function test() {
    busy = true; msg = ''; err = '';
    try {
      const r = await api('/api/admin/digest/test', { method: 'POST' });
      msg = r.sent ? 'Test gesendet. Siehe Benachrichtigungen und /digest.' : r.data ? 'Nicht gesendet (doppelt).' : 'Nichts zu berichten: In den letzten 7 Tagen ist nichts Neues passiert.';
    } catch { err = 'Senden fehlgeschlagen.'; }
    busy = false;
  }
</script>
<svelte:head><title>Wochenrückblick – Admin</title></svelte:head>
<p class="muted">Einmal pro Woche bekommt jedes Konto eine Zusammenfassung (Glocke und, wenn eingestellt, persönliches ntfy-Thema). Uhrzeit nach Serverzeit.</p>
{#if s}
  <form class="panel form" on:submit|preventDefault={save}>
    <label class="row"><input type="checkbox" bind:checked={s.enabled} /><span><b>Wochenrückblick aktiv</b></span></label>
    <div class="grid">
      <label>Wochentag<select bind:value={s.day}>{#each DAYS as d, i}<option value={i}>{d}</option>{/each}</select></label>
      <label>Uhrzeit<select bind:value={s.hour}>{#each Array(24) as _, h}<option value={h}>{String(h).padStart(2, '0')}:00</option>{/each}</select></label>
    </div>
    <small class="muted">Quelle: {s.source === 'admin' ? 'hier gespeichert' : 'Voreinstellung aus der Konfiguration (DIGEST_DAY / DIGEST_HOUR)'}.
      {#if s.lastRun}Letzter Versand: Woche {s.lastRun.week}, {s.lastRun.count} Konten ({new Date(s.lastRun.sentAt).toLocaleString('de-DE')}).{:else}Noch nichts versendet.{/if}</small>
    <div class="flex">
      <button disabled={busy}>Speichern</button>
      <button type="button" class="sec" disabled={busy} on:click={test}>Test an mich senden</button>
      {#if msg}<span class="ok" role="status">{msg}</span>{/if}{#if err}<span class="err" role="alert">{err}</span>{/if}
    </div>
  </form>
{:else if err}<p class="err" role="alert">{err}</p>{/if}
<style>
  .form { max-width: 560px; display: grid; gap: 1.1rem; }
  .row { display: flex; gap: .8rem; align-items: center; color: var(--fg); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .8rem; } .grid label { display: grid; gap: .3rem; font-size: .9rem; }
  small { font-size: .85rem; }
</style>
