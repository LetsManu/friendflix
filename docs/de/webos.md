# FriendFlix für LG-Fernseher

[English](../webos.md) · **Deutsch**

Die LG-TV-App ist FriendFlix als App auf einem LG-Smart-TV mit webOS (webOS 22 oder neuer, das heißt Modelle ab 2022; getestet mit webOS 25): eine schlanke Hülle, die einmal nach der Adresse deines Servers fragt und dann den [TV-Modus](../tv-mode.md) deines Servers im Vollbild öffnet. Alles, was du siehst, ist die Weboberfläche, sie passt also immer zur Version deines Servers. Anders als der normale TV-Browser hat die App ein eigenes Symbol, merkt sich den Server und sagt dem Server, was der Fernseher abspielen kann. So schickt der Server die Originaldatei, wo der Fernseher sie selbst abspielen kann (Direct Play).

**Wie es funktioniert, kurz.** Der Fernseher führt die App im Entwicklermodus (Developer Mode) von LG aus, es braucht also kein LG-Zertifikat und kein Store-Konto. Jemand führt das Installationsskript auf einem PC im selben Netzwerk wie der Fernseher aus. Die App aktualisiert sich **nicht** selbst: Nach einem neuen Release das Installationsskript erneut ausführen. Der LG Content Store ist eine spätere Phase ([webos-store.md](../webos-store.md), nur auf Englisch).

**Voraussetzungen:** ein LG-Fernseher mit webOS 22 oder neuer; ein Windows-, macOS- oder Linux-PC im selben Netzwerk wie der Fernseher, mit Node.js 20 oder neuer ([nodejs.org](https://nodejs.org/)); ein kostenloses LG-Entwicklerkonto; ein per HTTPS erreichbarer FriendFlix-Server mit Zertifikat einer öffentlichen CA, auf dem Release, das die LG-TV-App mitbringt (siehe [Changelog](../../CHANGELOG.md)), oder neuer; der für den TV-Modus gekoppelte Fernseher ([tv-mode.md](../tv-mode.md)).

## Inhalt

- [Überblick über die Schritte](#überblick-über-die-schritte)
- [Fernseher: Entwicklermodus](#fernseher-entwicklermodus)
- [Auf dem Fernseher installieren](#auf-dem-fernseher-installieren)
- [Die Passphrase und wo sie gespeichert wird](#die-passphrase-und-wo-sie-gespeichert-wird)
- [Erster Start: die Serveradresse](#erster-start-die-serveradresse)
- [Die 50-Stunden-Sitzung](#die-50-stunden-sitzung)
- [Die Fernbedienung](#die-fernbedienung)
- [Was Direct Play abdeckt](#was-direct-play-abdeckt)
- [Server wechseln](#server-wechseln)
- [Die Probe und wie du ihre Zeile liest](#die-probe-und-wie-du-ihre-zeile-liest)
- [Offene Punkte / Prüfungen beim ersten Start](#offene-punkte--prüfungen-beim-ersten-start)
- [Updates](#updates)
- [Fehlersuche](#fehlersuche)

## Überblick über die Schritte

1. **Betreiber, pro Release:** Der Release-Workflow baut `FriendFlix-<version>.ipk` und `FriendFlix-probe-<version>.ipk` und hängt sie mit `SHA256SUMS-webos.txt` an das GitHub-Release. Es sind unsignierte Entwicklermodus-Pakete; Secrets sind nicht nötig.
2. **Pro Fernseher:** Entwicklermodus an, dann das Installationsskript vom PC ausführen.
3. **Erst die Probe (optional):** die Test-App installieren, ihre Zeile lesen und dem Projektbetreiber schicken ([die Probe](#die-probe-und-wie-du-ihre-zeile-liest)).
4. **Den Fernseher koppeln** für den TV-Modus ([tv-mode.md](../tv-mode.md)).

## Fernseher: Entwicklermodus

Ein LG-Fernseher installiert eigene Apps nur über die App „Developer Mode“.

1. Öffne am Fernseher den **LG Content Store** und installiere die App **Developer Mode**.
2. Öffne sie und melde dich mit einem **LG-Entwicklerkonto** an (kostenlos; auf der [webOS-TV-Entwicklerseite von LG](https://webostv.developer.lge.com/) kannst du eins anlegen).
3. Stelle **Dev Mode Status** auf **On**. Der Fernseher startet neu.
4. Öffne die App Developer Mode erneut und schalte den **Key Server** ein.
5. Notiere die **Passphrase**, die die App zeigt, und die IP-Adresse des Fernsehers (*Einstellungen → Netzwerk → deine Verbindung*), zum Beispiel `192.0.2.10`. Beides gibst du dem Installationsskript.

Die Passphrase ändert sich, sobald der Key Server aus- und wieder eingeschaltet wird: Nimm immer die, die die App gerade zeigt.

## Auf dem Fernseher installieren

Führe das Skript aus einem Klon des Repositorys aus (die Skripte liegen im Ordner `webos`), auf einem PC im Netzwerk des Fernsehers. Beide brauchen Node.js 20 oder neuer.

**Linux oder macOS:**

```sh
./webos/install.sh 192.0.2.10 --probe          # zuerst die Test-App
./webos/install.sh 192.0.2.10                  # FriendFlix
./webos/install.sh 192.0.2.10 --version v2.4.0 # ein bestimmtes Release
./webos/install.sh 192.0.2.10 --ipk ./FriendFlix-2.4.0.ipk  # eine lokale Datei
```

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10 -Probe
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10 -Version v2.4.0
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10 -Ipk .\FriendFlix-2.4.0.ipk
```

`-ExecutionPolicy Bypass` gilt nur für diesen einen Aufruf; ohne kann Windows das Skript verweigern.

Die volle Form ist `webos/install.sh <tv-ip> [passphrase] [--probe] [--ipk <datei>] [--version vX.Y.Z]` beziehungsweise `webos/install.ps1 <TvIp> [Passphrase] [-Probe] [-Ipk <datei>] [-Version vX.Y.Z]`.

| Argument | Bedeutung |
|---|---|
| `<tv-ip>` / `<TvIp>` | Die IPv4-Adresse des Fernsehers. Pflicht. |
| `[passphrase]` / `[Passphrase]` | Die Passphrase des Entwicklermodus. **Lass sie weg**: Das Skript fragt dann danach, die Eingabe bleibt verdeckt. In der Kommandozeile bliebe sie in deinem Shell-Verlauf. |
| `--probe` / `-Probe` | **FriendFlix Test** (die Test-App) statt FriendFlix installieren. |
| `--ipk <datei>` / `-Ipk <datei>` | Diese `.ipk` installieren, statt ein Release herunterzuladen. |
| `--version vX.Y.Z` / `-Version vX.Y.Z` | Ein bestimmtes Release. Ohne: das neueste. |

Was das Skript tut:

1. Prüft auf Node.js 20+.
2. Installiert die festgelegten LG-Kommandozeilenwerkzeuge (`@webos-tools/cli` 3.2.6, die „ares“-Werkzeuge) einmal in einen Cache-Ordner deines Benutzerkontos (Linux und macOS: `~/.cache/friendflix-webos` oder unter `$XDG_CACHE_HOME`; Windows: `%LOCALAPPDATA%\friendflix-webos`). Systemweit wird nichts installiert.
3. Lädt `.ipk` und `SHA256SUMS-webos.txt` vom GitHub-Release (standardmäßig vom neuesten), prüft den SHA-256 und installiert bei Abweichung nichts.
4. Registriert den Fernseher als `friendflix-tv` (Port 9922), holt mit deiner Passphrase seinen Schlüssel, installiert die App und startet sie.

Exit-Codes: `0` installiert; `1` fehlgeschlagen (das Skript gibt Hinweise aus); `2` falsche Argumente (die Nutzung wird angezeigt). Ein erneuter Lauf ersetzt die installierte App. App und Test-App sind verschiedene Apps und können nebeneinander installiert bleiben. Danach öffnest du die App in der App-Liste des Fernsehers.

## Die Passphrase und wo sie gespeichert wird

Die FriendFlix-Skripte schreiben deine Passphrase nirgends hin: Sie wird weder ausgegeben noch protokolliert noch von ihnen gespeichert. Sie geben sie nur über die Standardeingabe an das LG-Werkzeug weiter, nie in einer Kommandozeile.

Das LG-Werkzeug selbst verhält sich anders. `ares-novacom`, das den SSH-Schlüssel des Fernsehers holt, **speichert die Passphrase in seiner Geräte-Datei** `novacom-devices.json` im ares-Konfigurationsordner deines Benutzerkontos, weil es sie bei jedem späteren Aufruf (Installieren, Starten) braucht, um den Schlüssel des Fernsehers zu entsperren. Nach einer Installation liegt die Passphrase also in dieser Datei auf dem PC. Sie nützt nur, solange der Entwicklermodus an ist und der Key Server läuft, und sie ändert sich, wenn du den Key Server aus- und einschaltest. Behandle die Datei trotzdem wie ein Passwort: Gib deinen Home-Ordner nicht weiter und entferne den Eintrag, wenn du ihn nicht mehr brauchst.

Die Datei heißt `novacom-devices.json` und liegt im Ordner `.webos` deines Benutzerkontos: `~/.webos/` unter Linux und macOS, `%APPDATA%\.webos\` unter Windows (darin kann es einen Profil-Unterordner geben). Der sichere Weg zum Entfernen des Eintrags ist das LG-Werkzeug selbst; führe es aus dem Ordner `node_modules/.bin` des Caches aus:

```sh
~/.cache/friendflix-webos/node_modules/.bin/ares-setup-device --remove friendflix-tv
```

```powershell
& "$env:LOCALAPPDATA\friendflix-webos\node_modules\.bin\ares-setup-device.cmd" --remove friendflix-tv
```

(Nimm `$XDG_CACHE_HOME/friendflix-webos`, falls du das gesetzt hast.) Die nächste Installation registriert den Fernseher von selbst neu.

## Erster Start: die Serveradresse

Beim ersten Start fragt die App nach der Adresse deines Servers, zum Beispiel `friend.example.com`.

- Gib sie mit der Tastatur des Fernsehers oder der Magic Remote ein; die Pfeiltasten wechseln zwischen Feld und **Verbinden**.
- Nur `https://` funktioniert; `https://` wird für dich ergänzt. Eine reine `http://`-Adresse wird abgelehnt (der Fernseher trägt ein Anmelde-Cookie).
- Die App prüft, ob die Adresse wie ein FriendFlix-Server antwortet (`GET /api/version`). Wenn nicht, sagt sie warum.
- Die Adresse wird gemerkt. Beim nächsten Start zeigt die App 1,5 Sekunden lang ihr Logo mit *Blue key: change server* (blaue Taste: Server wechseln) und öffnet dann den TV-Modus deines Servers (siehe [Server wechseln](#server-wechseln)). Ist der Fernseher noch nicht gekoppelt, zeigt er wie üblich den Kopplungscode: Koppeln wie in [tv-mode.md](../tv-mode.md) beschrieben. **Zurück** auf dem Kopplungsbildschirm führt zum ausgefüllten Adressformular; Zurück dort beendet die App.
- Ist der Server beim Start nicht erreichbar, bietet eine Fehlerkarte **Retry** (erneut versuchen) und **Change server** (Server wechseln) an; die Startseite ist nur englisch.

## Die 50-Stunden-Sitzung

Der Entwicklermodus läuft nach **50 Stunden** ab. Öffne vorher die App **Developer Mode** und drücke **Extend**. Verpasst du das, entfernt der Fernseher die App: Führe das Installationsskript erneut aus. Auch das Ausschalten des Entwicklermodus entfernt sie.

## Die Fernbedienung

Im Player (außerhalb des Players werden die Tasten ignoriert):

| Taste | Code | Aktion |
|---|---|---|
| Play | 415 | abspielen |
| Pause | 19 | pausieren |
| Play/Pause | 10252 | abspielen oder pausieren |
| Stop | 413 | verlässt den Player (der Fortschritt wird gespeichert, wie bei Zurück) |
| Vorspulen / Zurückspulen | 417 / 412 | +30 s / −30 s |
| Rot | 403 | Untertitel an oder aus (zuletzt benutzte Spur, sonst die erste) |
| Grün | 404 | Audio-Menü öffnen |

**Zurück** (461) funktioniert überall: eine Ebene zurück. **Zurück auf der Startseite des TV-Modus beendet die App.** Auch der Zeiger der **Magic Remote** funktioniert: Darüberfahren bewegt den Fokusrahmen, ein Klick öffnet. Die Pfeiltasten machen von dort weiter, wo der Zeiger war. Die allgemeinen Tasten stehen in [tv-mode.md](../tv-mode.md#bedienung-am-fernseher).

## Was Direct Play abdeckt

Die App sagt dem Server, was der Fernseher abspielen kann, und der Server schickt dann die Originaldatei, statt sie umzuwandeln. Die App schickt **nur Formate, die der Fernseher von sich aus bestätigt** (`canPlayType` / `MediaSource`); ein nicht bestätigtes Format wird einfach nicht angeboten, und der Server wandelt es um. Kandidaten:

- Container: MKV, MP4, M4V, MOV, TS, WebM;
- Video: H.264, HEVC, AV1, VP9, MPEG-2 (bis 2160p), mit den Profilen, die der Fernseher bestätigt (zum Beispiel 10-Bit);
- Audio: AAC, AC3, E-AC3, MP3, FLAC, Opus, Vorbis;
- Untertitel: SRT, ASS, SSA, VTT (vom Player gezeichnet, wie überall).

**DTS und TrueHD werden immer umgewandelt**; der Player des Fernsehers wird dazu gar nicht gefragt. Ein Wechsel der Tonspur bei einem Direct-Play-Titel läuft über den umgewandelten Stream.

Erscheint bei Direct Play innerhalb von **10 Sekunden** kein Bild, wechselt der Player einmal an derselben Position auf den umgewandelten Stream. Ein Dekodierfehler tut dasselbe. Bestätigt der Fernseher gar nichts, schickt die App keine Liste, und der Server behandelt den Fernseher wie einen einfachen Browser. Die Qualitätsanzeige des Players zeigt bei Direct Play *Original*.

## Server wechseln

Zwei Wege führen zum Adressformular, ausgefüllt mit der aktuellen Adresse:

- **Konto-Menü → Server wechseln.** Die App geht über den Browserverlauf zurück zu ihrer Startseite und zeigt das Formular. Der Fernseher behält nur die letzten 50 Seiten im Verlauf; nach langer Nutzung kann die Startseite daher fehlen (`home=fail` der Probe bedeutet dasselbe). Ist die App nach 1,5 Sekunden noch auf deinem Server, sagt sie das: App neu starten und die blaue Taste nehmen.
- **Blaue Taste beim Start.** Jeder Start mit gespeicherter Adresse zeigt 1,5 Sekunden lang das Logo mit *Blue key: change server*, bevor die App deinen Server öffnet. Drückst du in dieser Zeit die **blaue** Taste (406), erscheint stattdessen das Formular.

## Die Probe und wie du ihre Zeile liest

Die Test-App findet heraus, was dein Fernseher wirklich kann und welchen Weg der Player nehmen soll. Bitte führe sie an dem Fernseher aus, den du benutzen willst.

1. [Installiere die Test-App](#auf-dem-fernseher-installieren) (`--probe` / `-Probe`) und öffne **FriendFlix Test** in der App-Liste. Der erste Start zeigt dasselbe Formular für die Serveradresse.
2. **Koppele den Fernseher zuerst für den TV-Modus**, falls das noch nicht geschehen ist ([tv-mode.md](../tv-mode.md)). Die Wiedergabeprüfung spielt einen Titel aus deiner Bibliothek mit der eigenen Sitzung des Fernsehers ab. Solange der Fernseher nicht gekoppelt ist, zeigen `keys` und `home` `skipped`.
3. Der Bildschirm führt seine Prüfungen aus und fordert dich dann auf, die Play/Pause-Taste und die rote Taste zu drücken.
4. Der Bildschirm zeigt **eine Zeile**. **Schicke die ganze Zeile an den Projektbetreiber** (vorlesen oder den Bildschirm fotografieren). **Zurück** schließt den Bildschirm. Die Test-App speichert nie einen Fortschritt für den Titel, den sie abspielt.

Die Zeile sieht so aus:

```
FFPROBE v1 tv=webos os=25 direct=ok:1840ms hls=ok nativehls=ok palm=yes home=ok keys=ok video=h264,hevc+10,av1,vp9 audio=aac,ac3,eac3,mp3,flac,opus containers=mkv,mp4,ts,webm
```

| Feld | Werte | Bedeutung und was es entscheidet |
|---|---|---|
| `tv` | `webos` | Die Plattform. |
| `os` | Zahl | Die webOS-Version, zum Beispiel `25`. |
| `direct` | `ok:<ms>ms` | Ein echtes Direct Play des Testtitels hat nach so vielen Millisekunden das erste Bild gezeigt. |
| | `error:nodirect` | Der Server hat für den Testtitel keinen Direct-Stream angeboten. Kein Fernseherproblem: anderen Titel versuchen oder die Bibliothek prüfen. |
| | `error:unknown` | Die Prüfung selbst ist abgestürzt, bevor sie einen Grund melden konnte. |
| | `error:<grund>` | Direct Play ist aus diesem Grund fehlgeschlagen (zum Beispiel Zeitüberschreitung oder Player-Fehler). |
| `hls` | `ok`, `error:<code>` | Ob der umgewandelte Stream über hls.js läuft. |
| `nativehls` | `ok`, `error:<code>` | Ob er über das eigene HLS des Fernsehers läuft. Zusammen mit `hls` entscheidet das den **HLS-Weg**: hls.js oder, wenn hls.js scheitert, das native HLS des Fernsehers. |
| `palm` | `yes`, `no` | Ob das `PalmSystem` des Fernsehers vorhanden ist. Entscheidet die **Beenden-Methode**: `platformBack()`, wenn vorhanden, sonst `window.close()`. |
| `home` | `ok`, `fail`, `skipped` | Ob „Zurück im Verlauf“ die lokale Startseite erreicht. Entscheidet den **Weg für „Server wechseln“**: Bei `fail` erreicht der Menüeintrag die Startseite nicht, dann ist die blaue Taste beim Start der Weg. `skipped`, solange der Fernseher nicht gekoppelt ist. |
| `keys` | `ok`, `missing:<namen>`, `skipped` | Ob Play/Pause und die rote Taste angekommen sind. `missing` nennt die fehlenden. `skipped`, solange nicht gekoppelt. |
| `video` | Codecs | Die Videocodecs, die der Fernseher bestätigt hat; ein `+10` hinter einem Codec heißt: 10-Bit bestätigt; `-` heißt: nichts bestätigt. Entscheidet die **endgültige Formatliste**. |
| `audio` | Codecs | Die Audiocodecs, die der Fernseher bestätigt hat (`-`: nichts bestätigt). Entscheidet die Formatliste. |
| `containers` | Liste | Die Container, die der Fernseher bestätigt hat (`-`: nichts bestätigt). Entscheidet die Formatliste. |

Was auch immer die Zeile sagt, schicke sie vollständig: Auch die übrigen Werte zeigen, welche Teile einen anderen Ansatz brauchen. Die Test-App bleibt bei jedem Release ein Diagnosewerkzeug.

## Offene Punkte / Prüfungen beim ersten Start

Das ließ sich nur an einem echten Fernseher prüfen und ist noch unbestätigt. Verhält sich beim ersten Start etwas seltsam, schau zuerst hier:

- **Verstecktes Testvideo.** Die Probe verlässt sich darauf, dass ein kaum sichtbares Video mit 2×2 Pixeln auf webOS dekodiert. Wenn nicht, meldet die Wiedergabeprüfung der Probe falsch.
- **Native HLS-Ereignisse.** Ob der eigene HLS-Player des Fernsehers die Ereignisse auslöst, auf die der Player wartet.
- **Server wechseln über den Verlauf.** Die Startseite erkennt „durch Zurückgehen erreicht“ am Navigationstyp `back_forward`; eine aus dem Back/Forward-Cache wiederhergestellte Seite (`pageshow` mit `persisted`) zählt genauso. Ob webOS das meldet, ist unbestätigt; das Feld `home` der Probe und die blaue Taste beim Start fangen das ab.
- **Nicht dekodierbare Originale.** Ob eine Datei, die der Fernseher nicht dekodieren kann, trotzdem `loadeddata` auslösen kann. Dann bliebe das Bild schwarz, und der 10-Sekunden-Wechsel auf den umgewandelten Stream würde nicht starten.
- **Magic-Remote-Hover nach dem Scrollen.** Nach jedem Tastendruck bewegt das Darüberfahren den Fokus erst wieder, wenn sich der Zeiger wirklich bewegt (ein Zeigerereignis mit Bewegung). So übernimmt nach einem Scrollen mit den Pfeiltasten nicht das Element den Fokus, das unter dem ruhenden Zeiger landet. Ob webOS diese Bewegung für die Magic Remote meldet, ist unbestätigt.
- **`install.ps1` unter Windows.** Es wurde nie auf einem echten Windows-PC ausgeführt; das Linux/macOS-Skript schon. Schlägt es fehl, melde bitte die Meldung.

## Updates

Die App aktualisiert sich nicht selbst (das kann eine Entwicklermodus-App nicht). Nach einem neuen Release führst du das Installationsskript erneut aus; es installiert die neue Version über die alte. Die App zeigt die Weboberfläche deines Servers, Server-Updates kommen also ohne Neuinstallation auf den Fernseher.

## Fehlersuche

- **Der Fernseher wird nicht gefunden / „could not register“ / „could not fetch the TV's key“:** Die App Developer Mode muss installiert sein, **Dev Mode Status** und **Key Server** müssen an sein, Fernseher und PC müssen im selben Netzwerk sein (kein Gastnetz oder VLAN dazwischen), und nichts darf den TCP-Port `9922` blockieren. Nimm die IP aus den Netzwerkeinstellungen des Fernsehers.
- **Die Passphrase hat sich geändert:** Sie ändert sich, sobald der Key Server aus- und eingeschaltet oder der Entwicklermodus zurückgesetzt wird. Lies die aktuelle in der App Developer Mode ab und führe das Skript erneut aus.
- **Die Sitzung ist abgelaufen (die App ist weg, oder die Installation kann sich nicht verbinden):** Der Entwicklermodus läuft nach 50 Stunden ab. Öffne die App Developer Mode, schalte ihn bei Bedarf wieder ein und führe das Skript erneut aus. Drücke rechtzeitig **Extend** ([die 50-Stunden-Sitzung](#die-50-stunden-sitzung)).
- **„Plain http:// addresses are not allowed“:** Der Server muss per HTTPS mit öffentlichem Zertifikat erreichbar sein (siehe [setup.md](setup.md)).
- **„Cannot reach that server“:** Prüfe die Adresse, das Netzwerk des Fernsehers und ob der Server läuft. „That address answered, but it is not a FriendFlix server“ heißt, dass dort ein anderer Dienst antwortet (Router-Seite, Proxy-Anmeldung).
- **„SHA-256 mismatch“:** Der Download ist beschädigt oder wurde ausgetauscht; das Skript installiert nichts. Versuche es erneut; hält es an, sieh dir die Dateien des Releases an.
- **„Node.js 20 or newer is needed“:** Installiere es von [nodejs.org](https://nodejs.org/).
- **„not an IPv4 address“:** Nimm die Adresse aus den Netzwerkeinstellungen des Fernsehers, keinen Namen.
- **Windows blockiert das Skript:** Führe es wie oben mit `-ExecutionPolicy Bypass` aus.
- **Das Release hat keine `.ipk`-Dateien:** Der Release-Job lief für diesen Tag nicht. Sieh dir den *Actions*-Lauf des Releases an.
- **Falsche Serveradresse gespeichert:** Nutze [Server wechseln](#server-wechseln).
