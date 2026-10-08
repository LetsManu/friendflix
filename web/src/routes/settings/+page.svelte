<script lang="ts">
  import { onMount } from 'svelte';
  import { prefs, savePrefs, DEFAULT_PREFS, type Prefs } from '$lib/stores';

  const LANGS: Array<[string, string]> = [['', 'Standard der Datei'], ['ger', 'Deutsch'], ['eng', 'Englisch'], ['fre', 'Französisch'], ['spa', 'Spanisch'], ['ita', 'Italienisch'], ['jpn', 'Japanisch']];
  const QUALITIES: Array<[number, string]> = [[0, 'Automatisch (beste für deine Verbindung)'], [8_000_000, '1080p (ca. 8 Mbit/s)'], [4_000_000, '720p (ca. 4 Mbit/s)'], [1_500_000, '480p (ca. 1,5 Mbit/s)'], [800_000, '360p (ca. 0,8 Mbit/s)']];
  let form: Prefs = { ...DEFAULT_PREFS }, saved = false, error = '', busy = false;
  onMount(() => { const unsub = prefs.subscribe((p) => (form = { ...p })); return unsub; });
  async function save() {
    busy = true; error = ''; saved = false;
    try { await savePrefs({ ...form, quality: Number(form.quality) }); saved = true; setTimeout(() => (saved = false), 2500); } catch { error = 'Speichern fehlgeschlagen.'; }
    busy = false;
  }
</script>

<svelte:head><title>Einstellungen – FriendFlix</title></svelte:head>
<h1>Wiedergabe-Einstellungen</h1>
<p class="muted">Gelten auf allen deinen Geräten. Sie betreffen nur dich.</p>
<form class="panel form" on:submit|preventDefault={save}>
  <label class="row"><input type="checkbox" bind:checked={form.autoplayNext} /><span><b>Nächste Folge automatisch starten</b><small class="muted">Mit 8-Sekunden-Countdown, jederzeit abbrechbar.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.autoSkipIntro} /><span><b>Intros automatisch überspringen</b><small class="muted">Funktioniert, wenn Jellyfin Intro-Marken kennt. In der Watch-Party deaktiviert.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.hoverTrailers} /><span><b>Trailer-Vorschau beim Überfahren</b><small class="muted">Kurzer, stummer Trailer, wenn die Maus auf einer Karte verweilt (nur lokale Trailer in Jellyfin).</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.shareHistory} /><span><b>Gruppen-Matcher: Meine ungesehenen Titel dürfen abgeglichen werden</b><small class="muted">Freunde sehen nur das Ergebnis („niemand von uns hat X gesehen“), nie deine Historie. Standard: aus.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.shareRatings} /><span><b>Meine guten Bewertungen dürfen Freunden vorgeschlagen werden</b><small class="muted">Erscheint als „Freunde haben bewertet“ bei anderen.</small></span></label>
  <div class="field"><label for="al">Bevorzugte Tonspur</label>
    <select id="al" bind:value={form.audioLang}>{#each LANGS as [v, l]}<option value={v}>{l}</option>{/each}</select></div>
  <div class="field"><label for="sl">Untertitel standardmäßig</label>
    <select id="sl" bind:value={form.subtitleLang}><option value="">Aus</option>{#each LANGS.slice(1) as [v, l]}<option value={v}>{l}</option>{/each}</select></div>
  <div class="field"><label for="q">Streaming-Qualität</label>
    <select id="q" bind:value={form.quality}>{#each QUALITIES as [v, l]}<option value={v}>{l}</option>{/each}</select>
    <small class="muted">Niedrigere Qualität spart Datenvolumen. Dein Konto-Limit kann nicht überschritten werden.</small></div>
  <div class="flex"><button disabled={busy}>Speichern</button>{#if saved}<span class="ok" role="status">Gespeichert</span>{/if}{#if error}<span class="err" role="alert">{error}</span>{/if}</div>
</form>
<style>
  .form { max-width: 640px; display: grid; gap: 1.2rem; }
  .row { display: flex; gap: .9rem; align-items: flex-start; color: var(--fg); font-size: 1rem; } .row span { display: grid; gap: .1rem; }
  .field { display: grid; gap: .35rem; } .field select { max-width: 360px; }
  small { font-size: .82rem; }
</style>
