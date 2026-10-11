<script lang="ts">
  import { onMount } from 'svelte';
  import { SIZE_LABELS, COLOR_LABELS, BG_LABELS, FONT_LABELS, subClasses } from '#lib/substyle';
  import { prefs, savePrefs, DEFAULT_PREFS, type Prefs } from '#lib/stores';

  const LANGS: Array<[string, string]> = [['', 'Standard der Datei'], ['ger', 'Deutsch'], ['eng', 'Englisch'], ['fre', 'Französisch'], ['spa', 'Spanisch'], ['ita', 'Italienisch'], ['jpn', 'Japanisch']];
  const QUALITIES: Array<[number, string]> = [[0, 'Automatisch (beste für deine Verbindung)'], [8_000_000, '1080p (ca. 8 Mbit/s)'], [4_000_000, '720p (ca. 4 Mbit/s)'], [1_500_000, '480p (ca. 1,5 Mbit/s)'], [800_000, '360p (ca. 0,8 Mbit/s)']];
  let form: Prefs = { ...DEFAULT_PREFS }, saved = false, error = '', busy = false;
  onMount(() => { const unsub = prefs.subscribe((p) => (form = { ...p, subtitleStyle: { ...p.subtitleStyle } })); return unsub; });
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
  <label class="row"><input type="checkbox" bind:checked={form.stillWatching} /><span><b>„Schaust du noch?“ nachfragen</b><small class="muted">Nach mehreren Folgen am Stück ohne Eingabe (oder nach langer Pause) wird nicht automatisch weitergespielt, sondern kurz nachgefragt.</small></span></label>
  {#if form.stillWatching}<div class="field"><label for="swe">Nachfragen nach … Folgen ohne Eingabe</label>
    <select id="swe" bind:value={form.stillWatchingEpisodes}>{#each [2, 3, 4, 5] as n}<option value={n}>{n}</option>{/each}</select></div>{/if}
  <label class="row"><input type="checkbox" bind:checked={form.spoilerProtection} /><span><b>Spoilerschutz</b><small class="muted">Blendet Vorschaubilder und Beschreibungen ungesehener Folgen aus. Einzelne Folgen lassen sich per „anzeigen“ aufdecken.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.autoSkipIntro} /><span><b>Intros automatisch überspringen</b><small class="muted">Funktioniert, wenn Jellyfin Intro-Marken kennt. In der Watch-Party deaktiviert.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.hoverTrailers} /><span><b>Trailer-Vorschau beim Überfahren</b><small class="muted">Kurzer, stummer Trailer, wenn die Maus auf einer Karte verweilt (nur lokale Trailer in Jellyfin).</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.hoverClip} /><span><b>Ohne Trailer: Ausschnitt aus dem Film zeigen</b><small class="muted">Spielt beim Überfahren einen kurzen, vorab erzeugten Clip aus dem Film selbst (niedrige Qualität). Der Clip wird einmal pro Titel im Hintergrund erstellt und danach nur noch als Datei ausgeliefert.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.shareHistory} /><span><b>Gruppen-Matcher: Meine ungesehenen Titel dürfen abgeglichen werden</b><small class="muted">Freunde sehen nur das Ergebnis („niemand von uns hat X gesehen“), nie deine Historie. Standard: aus.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={form.shareRatings} /><span><b>Meine guten Bewertungen dürfen Freunden vorgeschlagen werden</b><small class="muted">Erscheint als „Freunde haben bewertet“ bei anderen.</small></span></label>
  <div class="field"><label for="al">Bevorzugte Tonspur</label>
    <select id="al" bind:value={form.audioLang}>{#each LANGS as [v, l]}<option value={v}>{l}</option>{/each}</select></div>
  <div class="field"><label for="sl">Untertitel standardmäßig</label>
    <select id="sl" bind:value={form.subtitleLang}><option value="">Aus</option>{#each LANGS.slice(1) as [v, l]}<option value={v}>{l}</option>{/each}</select></div>
  <div class="field"><label for="q">Streaming-Qualität</label>
    <select id="q" bind:value={form.quality}>{#each QUALITIES as [v, l]}<option value={v}>{l}</option>{/each}</select>
    <small class="muted">Niedrigere Qualität spart Datenvolumen. Dein Konto-Limit kann nicht überschritten werden.</small></div>
  <fieldset class="field sub"><legend>Untertitel-Darstellung</legend>
    <div class="grid">
      <label>Größe<select bind:value={form.subtitleStyle.size}>{#each Object.entries(SIZE_LABELS) as [v, l]}<option value={v}>{l}</option>{/each}</select></label>
      <label>Farbe<select bind:value={form.subtitleStyle.color}>{#each Object.entries(COLOR_LABELS) as [v, l]}<option value={v}>{l}</option>{/each}</select></label>
      <label>Hintergrund<select bind:value={form.subtitleStyle.background}>{#each Object.entries(BG_LABELS) as [v, l]}<option value={v}>{l}</option>{/each}</select></label>
      <label>Schrift<select bind:value={form.subtitleStyle.font}>{#each Object.entries(FONT_LABELS) as [v, l]}<option value={v}>{l}</option>{/each}</select></label>
    </div>
    <div class="preview {subClasses(form.subtitleStyle)}" aria-label="Vorschau"><span>So sehen deine Untertitel aus.</span></div>
    <small class="muted">Auf iPhone und iPad nutzt der Vollbildmodus die Untertitel-Einstellungen des Systems (Einstellungen → Bedienungshilfen → Untertitel).</small>
  </fieldset>
  <div class="flex"><button disabled={busy}>Speichern</button>{#if saved}<span class="ok" role="status">Gespeichert</span>{/if}{#if error}<span class="err" role="alert">{error}</span>{/if}</div>
</form>
<style>
  .form { max-width: 640px; display: grid; gap: 1.2rem; }
  .row { display: flex; gap: .9rem; align-items: flex-start; color: var(--fg); font-size: 1rem; } .row span { display: grid; gap: .1rem; }
  .field { display: grid; gap: .35rem; } .field select { max-width: 360px; }
  small { font-size: .82rem; }
  .sub { border: 0; padding: 0; margin: 0; } .sub legend { padding: 0; margin-bottom: .35rem; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .8rem; } .grid label { display: grid; gap: .3rem; font-size: .9rem; }
  .preview { background: linear-gradient(135deg, #3a4a5a, #1c232b); border-radius: 8px; padding: 2rem 1rem; text-align: center; color: #fff; }
  .preview span { padding: .1em .35em; }
  .preview.sub-size-s span { font-size: .9rem; } .preview.sub-size-m span { font-size: 1.15rem; } .preview.sub-size-l span { font-size: 1.5rem; } .preview.sub-size-xl span { font-size: 1.9rem; }
  .preview.sub-color-white span { color: #fff; } .preview.sub-color-yellow span { color: #ffe14d; } .preview.sub-color-cyan span { color: #4de8ff; } .preview.sub-color-green span { color: #6dff7a; }
  .preview.sub-bg-none span { background: transparent; } .preview.sub-bg-shadow span { background: transparent; text-shadow: 0 0 4px #000, 0 0 4px #000, 1px 1px 3px #000; }
  .preview.sub-bg-semi span { background: rgba(0,0,0,.65); } .preview.sub-bg-solid span { background: #000; }
  .preview.sub-font-sans span { font-family: system-ui, sans-serif; } .preview.sub-font-serif span { font-family: Georgia, 'Times New Roman', serif; } .preview.sub-font-mono span { font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>
