<script lang="ts">
  import { onMount } from 'svelte';
  import { SIZE_LABELS, COLOR_LABELS, BG_LABELS, FONT_LABELS, subClasses } from '#lib/substyle';
  import { api, getActiveProfile } from '#lib/api';
  import Intro from '#lib/Intro.svelte';
  import { loadIntroSettings, saveIntroSettings, shouldPlayIntroSound } from '#lib/intro';
  import { prefs, savePrefs, DEFAULT_PREFS, type Prefs } from '#lib/stores';
  import { pushState, enablePush, disablePush, updateBroadcast, testPush, syncPush, type PushState } from '#lib/push';

  const LANGS: Array<[string, string]> = [['', 'Standard der Datei'], ['ger', 'Deutsch'], ['eng', 'Englisch'], ['fre', 'Französisch'], ['spa', 'Spanisch'], ['ita', 'Italienisch'], ['jpn', 'Japanisch']];
  const QUALITIES: Array<[number, string]> = [[0, 'Automatisch (beste für deine Verbindung)'], [8_000_000, '1080p (ca. 8 Mbit/s)'], [4_000_000, '720p (ca. 4 Mbit/s)'], [1_500_000, '480p (ca. 1,5 Mbit/s)'], [800_000, '360p (ca. 0,8 Mbit/s)']];
  let form: Prefs = { ...DEFAULT_PREFS }, saved = false, error = '', busy = false;
  let owner = false;
  onMount(() => {
    api('/api/me').then((m) => (owner = Boolean(m.profile?.isOwner))).catch(() => undefined);
    const unsub = prefs.subscribe((p) => (form = { ...p, subtitleStyle: { ...p.subtitleStyle } })); return unsub;
  });
  // ---- brand intro (stored per profile in localStorage, not on the server) ----
  let introShow = true, introSound = true, previewing = false, previewSound = false;
  onMount(() => { const s = loadIntroSettings(getActiveProfile()); introShow = s.show; introSound = s.sound; });
  const saveIntro = () => saveIntroSettings(getActiveProfile(), { show: introShow, sound: introSound });
  function previewIntro() {
    // pressing the button is an explicit request, so the sound plays even with reduced motion if "Intro-Ton" is on
    previewSound = shouldPlayIntroSound({ sound: introSound, soundExplicit: true, reducedMotion: false });
    previewing = true;
  }
  let ps: PushState = 'off', pushOn = false, pushBroadcast = false, pushBusy = false, pushMsg = '';
  async function refreshPush() { ps = await pushState().catch(() => 'unsupported' as PushState); pushOn = ps === 'on'; }
  onMount(() => { void refreshPush().then(async () => { if (ps === 'on') { const b = await syncPush(); if (b !== null) pushBroadcast = b; } }); });
  async function togglePush() {
    pushBusy = true; pushMsg = '';
    try {
      if (pushOn) ps = await enablePush(pushBroadcast); else { await disablePush(); ps = 'off'; }
    } catch { pushMsg = 'Das hat nicht geklappt.'; ps = await pushState().catch(() => 'off' as PushState); }
    pushOn = ps === 'on'; pushBusy = false;
  }
  async function toggleBroadcast() { try { await updateBroadcast(pushBroadcast); } catch { pushMsg = 'Speichern fehlgeschlagen.'; } }
  async function sendTest() {
    pushBusy = true; pushMsg = '';
    try { const r = await testPush(); pushMsg = r.sent ? 'Test gesendet.' : 'Der Push-Dienst hat den Test nicht angenommen.'; } catch { pushMsg = 'Test fehlgeschlagen.'; }
    pushBusy = false;
  }
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
  {#if owner}
    <label class="row"><input type="checkbox" bind:checked={form.weeklyDigest} /><span><b>Wöchentlicher Rückblick</b><small class="muted">Einmal pro Woche eine Zusammenfassung: neue Filme, neue Folgen deiner Serien, erfüllte Wünsche und Empfehlungen. Gilt für das ganze Konto.</small></span></label>
    <div class="field"><label for="nt">ntfy-Thema für persönliche Push-Nachrichten</label>
      <input id="nt" bind:value={form.ntfyTopic} maxlength="64" pattern="[A-Za-z0-9_\-]*" autocomplete="off" spellcheck="false" placeholder="z. B. mein-geheimes-thema" />
      <small class="muted">Leer = keine Push-Nachrichten. Erlaubt sind Buchstaben, Ziffern, „-“ und „_“. Wähle einen schwer zu erratenden Namen, denn jeder, der ihn kennt, kann mitlesen. Wirkt für Rückblick und persönliche Hinweise, nie für den gemeinsamen Kanal.</small></div>
  {/if}
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
<section class="panel form push" aria-labelledby="introh">
  <h2 id="introh">Intro</h2>
  <label class="row"><input type="checkbox" bind:checked={introShow} on:change={saveIntro} /><span><b>Intro beim Start zeigen</b><small class="muted">Kurze Markenanimation nach der Profilwahl und beim ersten Start in dieser Browser-Sitzung. Bei „Bewegung reduzieren“ nur ein sanftes Einblenden.</small></span></label>
  <label class="row"><input type="checkbox" bind:checked={introSound} on:change={saveIntro} /><span><b>Intro-Ton</b><small class="muted">Spielt nach der Profilwahl einen kurzen Klang. Beim automatischen Start ohne Klick bleibt es stumm.</small></span></label>
  <div class="flex"><button type="button" class="sec" on:click={previewIntro}>Vorschau abspielen</button></div>
</section>
{#if previewing}<Intro sound={previewSound} on:done={() => (previewing = false)} />{/if}
<section class="panel form push" aria-labelledby="pushh">
  <h2 id="pushh">Benachrichtigungen</h2>
  {#if ps === 'unsupported'}<p class="muted">Dieser Browser unterstützt keine Push-Benachrichtigungen.</p>
  {:else if ps === 'ios-install'}<p class="muted">Unter iOS (ab 16.4) zuerst über Teilen → „Zum Home-Bildschirm“ installieren und die App von dort öffnen, dann lassen sich Push-Benachrichtigungen aktivieren.</p>
  {:else if ps === 'server-off'}<p class="muted">Push-Benachrichtigungen sind auf diesem Server nicht eingerichtet.</p>
  {:else}
    {#if ps === 'denied'}<p class="muted" role="alert">Benachrichtigungen sind für diese Seite blockiert. Bitte im Browser erlauben (Schloss-Symbol in der Adressleiste) und die Seite neu laden.</p>{/if}
    <label class="row"><input type="checkbox" bind:checked={pushOn} disabled={pushBusy || ps === 'denied'} on:change={togglePush} /><span><b>Push-Benachrichtigungen auf diesem Gerät</b><small class="muted">Persönliche Hinweise erscheinen auch, wenn FriendFlix geschlossen ist. Gilt nur für dieses Gerät.</small></span></label>
    {#if pushOn}
      <label class="row"><input type="checkbox" bind:checked={pushBroadcast} disabled={pushBusy} on:change={toggleBroadcast} /><span><b>Auch allgemeine Ankündigungen (Filmabend, Neu verfügbar)</b></span></label>
      <div class="flex"><button type="button" disabled={pushBusy} on:click={sendTest}>Test senden</button></div>
    {/if}
    {#if pushMsg}<span role="status" class="muted">{pushMsg}</span>{/if}
  {/if}
</section>
<style>
  .push { margin-top: 1.5rem; } .push h2 { margin: 0; font-size: 1.15rem; }
  .form { max-width: 640px; display: grid; gap: 1.2rem; }
  .row { display: flex; gap: .9rem; align-items: flex-start; color: var(--fg); font-size: 1rem; } .row span { display: grid; gap: .1rem; }
  .field { display: grid; gap: .35rem; } .field select, .field input { max-width: 360px; }
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
