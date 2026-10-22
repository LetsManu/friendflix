# FriendFlix für Windows

[English](../windows.md) · **Deutsch**

Die Windows-App ist FriendFlix als Programm auf deinem PC: dieselbe Weboberfläche wie im Browser, in einem abgeschotteten Fenster, und ein Teil läuft nativ: der **Player**. Ein Klick auf Abspielen öffnet einen Vollbild-Player (mpv), der fast jede Datei direkt abspielt, auch Ton in AC3, DTS und TrueHD, HEVC-Video und Bild-Untertitel, sodass der Server viel seltener umwandeln muss. Er hat FriendFlix' eigene Bedienelemente, setzt dort fort, wo du aufgehört hast, und meldet deinen Fortschritt, damit *Weiterschauen* mit Web, Android und TV übereinstimmt.

Alles andere (Stöbern, Profile, Anfragen, Einstellungen deines Kontos) ist die Weboberfläche und passt deshalb immer zur Version deines Servers. Nicht in der App: Downloads und Offline-Wiedergabe, Chromecast, Watch-Partys (`/party` bleibt im Web-Player) und die Extras des Android-Players (Besetzung und Infos, Lesezeichen, Untertitelsuche, Audioeffekte, Geschwindigkeit, Einschlaf-Timer, Anschluss-Bildschirm). Dafür nimmst du den Browser.

Die Oberflächen der App selbst (Einstellungen, Player) sind englisch; ihre Beschriftungen stehen hier in Kursivschrift im Original, wenn nötig mit deutscher Erklärung.

**Voraussetzungen:** Windows 10 (22H2) oder Windows 11, 64 Bit, mit der Microsoft-Edge-WebView2-Laufzeit (Teil von Windows 11 und aktueller Windows-10-Updates; der Installer lädt sie nach, wenn sie fehlt). Der Player braucht `vulkan-1.dll`, die der Grafiktreiber mitbringt. Dazu ein FriendFlix-Server, der per HTTPS mit einem Zertifikat einer öffentlichen CA (zum Beispiel Let's Encrypt) erreichbar ist, in der Version, die die Windows-App akzeptiert (die, die sie zuerst ausliefert, siehe [Änderungsprotokoll](../../CHANGELOG.md), oder neuer). Die App-Version folgt der Server-Version.

## Inhalt

- [Installation](#installation)
- [Erster Start](#erster-start)
- [App-Einstellungen](#app-einstellungen)
- [Player](#player)
- [Tray, Links und eine Instanz](#tray-links-und-eine-instanz)
- [Updates](#updates)
- [Fehlersuche](#fehlersuche)
- [Schritte für den Betreiber: Update-Signatur](#schritte-für-den-betreiber-update-signatur)
- [Manuelle Checkliste](#manuelle-checkliste)
- [Selbst bauen](#selbst-bauen)

## Installation

Jedes Release (`vX.Y.Z`) hat neben den Release-Notes diese Dateien:

- `FriendFlix_X.Y.Z_x64-setup.exe`: der Installer für einen Benutzer, ohne Administratorrechte. Nimm diesen.
- `FriendFlix_X.Y.Z_x64_en-US.msi`: dieselbe App als MSI, für verwaltete PCs.
- `SHA256SUMS-windows.txt`: die SHA-256-Summen der Dateien, um einen Download zu prüfen (in PowerShell `Get-FileHash .\FriendFlix_X.Y.Z_x64-setup.exe`).
- `.sig`-Dateien und `latest.json`: nur für die Updates der App, du musst sie nicht herunterladen.

**SmartScreen.** Der Installer ist nicht mit einem bezahlten Code-Signing-Zertifikat signiert, deshalb zeigt Windows *Der Computer wurde durch Windows geschützt*. Klicke auf **Weitere Informationen**, dann auf **Trotzdem ausführen**. Prüfe vorher die SHA-256-Summe, wenn du sicher sein willst, dass die Datei die aus dem Release ist.

Danach findest du FriendFlix im Startmenü. Zum Deinstallieren nimm *Einstellungen → Apps → Installierte Apps → FriendFlix*. Deine gemerkten Einstellungen (`%APPDATA%\FriendFlix`) und die Logs (`%LOCALAPPDATA%\FriendFlix`) können zurückbleiben; lösche diese Ordner selbst, wenn du ganz von vorn anfangen willst.

## Erster Start

1. Gib die Adresse deines FriendFlix-Servers ein, zum Beispiel `friend.example.com` (`https://` wird ergänzt). Reine `http://`-Adressen gehen auch, für einen Server im Heimnetz wie in der Android-App, aber `https` wird dringend empfohlen: über `http` geht das Sitzungs-Cookie unverschlüsselt durchs Netz.
2. Die App prüft, ob die Adresse wie ein passender FriendFlix-Server antwortet (`GET /api/version`). Wenn nicht, sagt sie warum.
3. Melde dich genau wie im Browser an, in der App: mit der Anmeldung in der App oder mit der Anmeldeseite deines Servers bei seinem Identity-Provider (zum Beispiel Authentik unter `auth.example.com`), mit Passkey, wo dein Provider ihn anbietet. Gibt dein Server neue Geräte frei, erscheint der PC als neues Gerät zur Freigabe durch den Admin.

Die App öffnet nur die Adresse deines Servers und, zum Anmelden, die Anmeldeseite deines Servers (das `authOrigin`, das der Server in `GET /api/version` nennt). Die Anmeldeseite bekommt nie die nativen Funktionen der App. Jeder andere Link (Trailer, IMDb, Hilfeseiten) öffnet im normalen Browser.

## App-Einstellungen

Du öffnest sie über das Tray-Symbol (**Settings**) oder über die Einstellungen der Weboberfläche. Sie liegen in `%APPDATA%\FriendFlix\settings.json`, zusammen mit Größe, Position und Maximiert-Zustand des Fensters.

| Einstellung | Was sie tut |
|---|---|
| Server | Zeigt die Serveradresse. **New server address → Check and use** ändert sie nach derselben Prüfung wie beim ersten Start. |
| Updates | *Install updates automatically on the next start* (Standard) oder *Ask me first* (vorher fragen). Siehe [Updates](#updates). |
| *Use hardware decoding* (Hardware-Dekodierung) | Standardmäßig an (`hwdec=auto-safe`). Schalte sie aus, wenn Videos Artefakte oder ein grünes Bild zeigen. Gilt beim nächsten Start des Players. |
| *Start the player in fullscreen* (Player im Vollbild starten) | Standardmäßig an. |
| *Start FriendFlix with Windows* (mit Windows starten) | Standardmäßig aus. |

Alles andere, etwa Wiedergabesprachen, Untertitel-Darstellung, Autoplay und Qualitätsgrenzen, stellst du wie gewohnt in der Weboberfläche ein; der Player verwendet diese Einstellungen.

## Player

Klicke irgendwo in der Web-App auf Abspielen. Der Player öffnet in einem eigenen Fenster, standardmäßig im Vollbild, und spielt die Originaldatei ab, wenn es geht (**Original**). Startet das Original nicht innerhalb von 10 Sekunden oder schlägt es fehl, wechselt der Player einmal an derselben Stelle auf den umgewandelten Stream des Servers, und das Etikett zeigt **Converted** mit dem Grund. Der Player setzt an deiner Position auf dem Server fort, oder an der Zeit eines `?t=`-Links.

**Bedienung** (die Leisten blenden sich nach 3 Sekunden ohne Mausbewegung aus, solange gespielt wird, und bleiben bei Pause sichtbar):

- **Obere Leiste:** Zurück, der Titel (`S1:E3 · Name` bei Folgen) und das Qualitäts-Etikett (*Original* oder *Converted · 1080p*; der Mauszeiger darauf zeigt den Grund).
- **Untere Leiste:** Abspielen/Pause, 10 Sekunden zurück und vor, die Zeitleiste mit Kapitelmarken und einem Vorschaubild beim Ziehen (wenn der Server Vorschauen hat), vergangene und verbleibende Zeit, nächste Folge, Kapitel, Ton und Untertitel, Qualität, Lautstärke, Vollbild.
- **Ton und Untertitel:** die Spuren des Servers und externe Untertitel. Deine Wahl wird pro Serie gespeichert, wie im Web-Player. Ist in deinem Profil *Anime: Originalton mit Untertiteln* an, startet eine Anime-Serie auf Japanisch mit Untertiteln in deiner Sprache, außer du hast etwas anderes gewählt.
- **Qualität** (umgewandelter Stream): Original (wenn deine Rolle es erlaubt), 1080p, 720p, 480p. Eine Änderung lädt den Stream an derselben Stelle neu.
- **Kapitel:** eine Liste, die beim Anklicken dorthin springt.
- **Skip intro / Skip recap:** eine Schaltfläche während dieser Abschnitte, wenn der Server sie kennt und der Typ aktiviert ist.
- **Nächste Folge:** ab dem Abspann (sonst 25 Sekunden vor dem Ende) zeigt eine Karte die nächste Folge mit einem 10-Sekunden-Countdown, wenn Autoplay an ist. Nach drei Folgen hintereinander ohne Eingabe erscheint *Still watching?* und Autoplay wartet auf dein *Yes*.
- **Untertitel-Darstellung** aus deinen Web-Einstellungen (Größe, Farbe, Hintergrund, Schrift) gilt für Text-Untertitel. ASS-Untertitel behalten ihren eigenen Stil.

**Tasten**

| Taste | Aktion |
|---|---|
| Leertaste oder K | Abspielen / Pause |
| ← / → | 10 Sekunden zurück / vor |
| ↑ / ↓ | Lautstärke +5 / −5 |
| M | Stumm |
| F oder Doppelklick | Vollbild |
| Esc | Menü schließen; sonst Vollbild verlassen; sonst zurück in die App |
| N | Nächste Folge |
| C | Untertitel an / aus |

Die Medientasten deiner Tastatur und die Windows-Medienanzeige (Lautstärke-Flyout, Sperrbildschirm) steuern die Wiedergabe; die Anzeige zeigt den Titel, ohne Plakat.

Der Fortschritt geht an den Server (Start, alle 10 Sekunden, Pause, Fortsetzen, Spulen, Ende), sodass Web und die anderen Apps dieselbe Position zeigen. Hängt die Wiedergabe länger als 15 Sekunden, erscheint *Reconnecting…* und der Player lädt bis zu dreimal neu. Endet die Sitzung (Anmeldung abgelaufen), schließt der Player und die App zeigt die Anmeldeseite.

## Tray, Links und eine Instanz

- **Tray-Symbol:** *Open FriendFlix*, die Serveradresse (nur lesbar), *Settings*, *Quit*. Das Fenster zu schließen beendet die App.
- **Eine Instanz:** startest du FriendFlix noch einmal, kommt nur das offene Fenster nach vorn.
- **`friendflix://watch/<id>`-Links** spielen den Titel für das zuletzt benutzte Profil oder öffnen `/watch/<id>` im Fenster, wenn noch kein Profil bekannt ist.

## Updates

Die App sucht beim Start und danach alle 24 Stunden auf GitHub Releases. Das Update wird gegen den öffentlichen Schlüssel geprüft, der in der App steckt; eine falsche Signatur wird abgelehnt und protokolliert. Es wird nie installiert, solange der Player läuft.

- **Automatisch** (Standard): das Update wird beim nächsten Start der App geladen und installiert.
- **Vorher fragen:** ein Hinweis zeigt *Install and restart*; ohne deinen Klick wird nichts installiert.

In einem Build ohne Update-Schlüssel (siehe die Schritte für den Betreiber) sind Updates **aus**: die App protokolliert das und sucht nie. Einen solchen Build kannst du trotzdem von Hand über die alte Version installieren.

## Fehlersuche

- **Logs:** `%LOCALAPPDATA%\FriendFlix\logs`, eine Datei pro Tag (`friendflix-JJJJ-MM-TT.log`), nach 14 Tagen gelöscht. Sie enthalten keine Passwörter, Cookies oder Tokens und Stream-Adressen ohne ihren Query-Teil. Es wird nichts versendet; es gibt keine Telemetrie. Hänge bei einer Fehlermeldung die neueste Datei an.
- **Der Player startet nicht oder schließt sofort:** er braucht `vulkan-1.dll` vom Grafiktreiber. In virtuellen Maschinen und mit sehr alten Treibern fehlt sie oft. Aktualisiere den Grafiktreiber oder nimm *Play in the web player*, das die App anbietet, wenn sich der Player unerwartet beendet (es öffnet `/watch/<id>` im Fenster).
- **Bild mit Artefakten oder grün:** schalte in den Einstellungen die Hardware-Dekodierung aus.
- **„Converted“ bei einem Titel, der unverändert laufen sollte:** der Mauszeiger auf dem Etikett zeigt den Grund: eine Bitraten- oder Auflösungsgrenze deiner Rolle, das Netzwerk oder ein Format, das der Server umwandelt. AVI, M2TS, PCM-Ton, VC-1-Video und Bild-Untertitel von DVD oder Blu-ray (PGS, DVD) stehen nicht in der Liste, die der Server von Apps annimmt; solche Titel werden umgewandelt.
- **Die Anmeldeseite öffnet nicht oder Links gehen in den Browser:** die App öffnet nur deinen Server und seine Anmeldeseite. Hast du die Adresse des Identity-Providers geändert, starte die App neu, damit sie `authOrigin` neu liest.
- **SmartScreen blockiert den Installer:** [Installation](#installation).
- **Es kommen keine Updates:** suche im Log nach *updates are off in this build*. Hast du einen Build ohne Update-Schlüssel gebaut oder installiert, installiere einmal ein Release von GitHub.

## Schritte für den Betreiber: Update-Signatur

Nur nötig, wenn die App sich selbst aktualisieren soll. Ohne funktioniert alles andere; jedes Release hat dann Installer ohne `latest.json`, und Nutzer installieren neue Versionen von Hand. Der Release-Job der Windows-App scheitert nie an einem fehlenden Schlüssel.

**Updates brauchen drei Dinge aus demselben Schlüsselpaar, erzeugt in einem Durchlauf:** den öffentlichen Schlüssel im Repository und den privaten Schlüssel samt Passwort als GitHub-Secrets. Ein öffentlicher Schlüssel aus einem Durchlauf mit Secrets aus einem anderen lässt jedes Update an der Signaturprüfung auf dem PC scheitern.

1. Erzeuge das Schlüsselpaar einmal auf deinem PC (es fragt nach einem Passwort; nimm ein starkes):

   ```sh
   npx @tauri-apps/cli@2.12.3 signer generate -w friendflix-updater.key
   ```

   Das schreibt `friendflix-updater.key` (privat) und `friendflix-updater.key.pub` (öffentlich). Bewahre den privaten Schlüssel und sein Passwort zusätzlich in deinem Passwortmanager auf; committe sie nicht. Wer sie hat, kann Updates an jeden PC mit der App ausliefern. Gehen sie verloren, lassen sich die PCs nicht mehr aktualisieren und müssen einen neuen Build von Hand installieren, weil der öffentliche Schlüssel in der App steckt.
2. Schreibe den Inhalt von `friendflix-updater.key.pub` (eine Zeile, `dW50cnVzdGVkIGNvbW1lbnQ6…`) in `desktop/app/updater.pub` statt `REPLACE_WITH_PUBLIC_KEY` und committe ihn.
3. Lege die beiden GitHub-Secrets an (*Settings → Secrets and variables → Actions* oder mit `gh`):

   ```sh
   gh secret set TAURI_SIGNING_PRIVATE_KEY < friendflix-updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   ```

   `TAURI_SIGNING_PRIVATE_KEY` ist der ganze Inhalt der privaten Schlüsseldatei; das Passwort-Secret ist das Passwort aus Schritt 1 (`gh` fragt nach dem Wert).
4. Setze ein Release-Tag. Der Job signiert die Installer und hängt `.sig`-Dateien und `latest.json` an. Die Zusammenfassung des Jobs sagt, ob Updates für diesen Build an sind.

Was in den anderen Fällen passiert: Steht in `updater.pub` noch der Platzhalter oder fehlt das Secret, bleibt der Build grün, baut Installer mit abgeschalteten Updates und hinterlässt einen Hinweis im Lauf. Ein öffentlicher Schlüssel, der kein gültiger Schlüssel ist, schaltet die Updates in der App ab (und protokolliert es), statt sie kaputt zu machen. Das Tauri-Kommandozeilenwerkzeug ist im Workflow auf 2.12.3 festgelegt.

### Der mpv-Pin

Der Player ist ein festgelegter Windows-Build von mpv (ein shinchiro-Build von SourceForge, mpv 0.41 git, LuaJIT), der in der CI geladen und gegen seine SHA-256 in `desktop/player/mpv.lock` geprüft wird; das Release scheitert, wenn der Pin unvollständig ist. Die GPL-Lizenztexte werden mit installiert. So wechselst du auf einen neueren Build:

1. Wähle eine aktuelle `mpv-x86_64-<Datum>-git-<sha>.7z` (den Basis-Build, nicht `-v3`) von <https://sourceforge.net/projects/mpv-player-windows/files/64bit/>.
2. Setze in `desktop/player/mpv.lock` `url` (die `downloads.sourceforge.net`-Form der Datei) und `sha256` (`sha256sum` der geladenen Datei) und aktualisiere die Kommentarzeilen darüber (mpv-Version, Lua).
3. Starte den Windows-Release-Job (*Actions → Windows app release → Run workflow* auf einem Tag oder Test-Tag) und spiele einen Titel ab. Die Bedienoberfläche muss mit Lua 5.1 / LuaJIT kompatibel bleiben; der CI-Job `desktop-core` prüft das.

## Manuelle Checkliste

Unit-Tests und CI decken die Logik ab und dass die App baut; diese Punkte brauchen einen echten Windows-PC (Windows 10 22H2 oder 11, ein normaler Grafiktreiber). Nimm einen Testserver mit Authentik-Anmeldung, ein zweites Gerät (Handy oder Browser) für die Sync-Prüfungen und ein paar Dateien: eine mit AC3- oder DTS-Ton, eine HEVC, ein MKV mit eingebetteten und externen Untertiteln, eine Anime-Serie und eine Serie mit Intros und Kapiteln.

**Installation**
1. Lade den Installer aus dem Release. SmartScreen zeigt *Der Computer wurde durch Windows geschützt*; *Weitere Informationen → Trotzdem ausführen* installiert. Die SHA-256-Summe passt zu `SHA256SUMS-windows.txt`. FriendFlix steht im Startmenü und startet.
2. Über *Installierte Apps* deinstallieren und neu installieren: es klappt, `friendflix://` öffnet weiter die App.

**Erster Start und Anmeldung**
3. Die Einrichtung akzeptiert `friend.example.com` und lehnt `http://`, einen falschen Host und einen Server mit selbstsigniertem Zertifikat mit der richtigen Meldung ab.
4. Melde dich mit der Anmeldung in der App und mit Authentik an; melde dich mit einem Passkey an. Externe Links öffnen im Standardbrowser. Die Einstellungsseite und der Server-Eintrag im Tray zeigen die Adresse.

**Abspielen und Sync**
5. Klicke auf Abspielen auf der Startseite, einer Detailseite und einer Folgenliste: der Player öffnet im Vollbild. Ein Doppelklick auf Abspielen öffnet keine zwei Player.
6. Fortsetzen über Geräte: höre am PC bei Minute 10 auf; Handy oder Browser zeigen dieselbe Position und *Weiterschauen*. Höre am Handy auf, spiele am PC: es setzt dort fort.
7. Eine AC3- oder DTS-Datei und eine HEVC-Datei spielen als *Original* (die Anzeige „Läuft gerade“ des Admins sagt direkt).
8. Der HLS-Ausweg: setze eine Bitratengrenze für die Rolle (oder wähle im Qualitätsmenü 720p): das Etikett zeigt *Converted · 720p*, die Position bleibt. Eine Datei, deren Original nicht startet, fällt nach etwa 10 Sekunden von selbst auf den umgewandelten Stream zurück.
9. Schließe den Player mit Esc (nicht im Vollbild), mit der Zurück-Schaltfläche und mit der Schließen-Schaltfläche des Fensters: jedes Mal ist die Web-App zurück, die Position ist gespeichert, ein Stopp wird gemeldet.

**Spuren, Untertitel und Anime**
10. Die Menüs für Ton und Untertitel listen die Spuren des Servers, auch externe Untertitel; die Wahl wird für die Serie gemerkt und gilt in der nächsten Folge.
11. Untertitel-Stil: ändere Größe, Farbe, Hintergrund und Schrift in den Web-Einstellungen; der nächste Titel zeigt es. Ein ASS-Untertitel behält seinen Stil. Ein Bild-Untertitel (PGS) wird angezeigt.
12. Anime: mit *Anime: Originalton mit Untertiteln* an startet eine Anime-Serie auf Japanisch mit Untertiteln; eine gespeicherte Wahl gewinnt.

**Überspringen, nächste Folge, „Still watching?“**
13. *Skip intro* und *Skip recap* erscheinen während des Abschnitts und springen an dessen Ende.
14. Nächste Folge: die Karte mit dem Countdown erscheint beim Abspann (sonst 25 Sekunden vor dem Ende), N spielt sie sofort, Autoplay startet sie im selben Fenster mit einer neuen Sitzung. Nach drei Folgen hintereinander wartet *Still watching?* auf *Yes*.

**Kapitel, Vorschau, Tasten**
15. Die Kapitelliste springt beim Anklicken; die Kapitelmarken sind auf der Zeitleiste zu sehen. Beim Ziehen der Zeitleiste erscheint das Vorschaubild; ein Server ohne Vorschauen zeigt keines und das Spulen geht.
16. Alle Tasten der Tabelle unter [Player](#player) tun, was dort steht; die Leisten blenden nach 3 Sekunden aus und bleiben bei Pause sichtbar.
17. Die Medientasten der Tastatur (Abspielen/Pause, Weiter) und die Windows-Medienanzeige steuern den Player und zeigen den Titel.

**Fehler**
18. Trenne das Netzwerk beim Abspielen 20 Sekunden: *Reconnecting…* erscheint und die Wiedergabe setzt danach an ihrer Position fort.
19. Beende die Sitzung auf dem Server (auf einem anderen Gerät abmelden): der Player schließt und die App zeigt die Anmeldeseite.
20. Beende `mpv.exe` im Task-Manager: eine Meldung erscheint und *Play in the web player* öffnet den Titel im Fenster.
21. Ein Nutzer am Stream-Limit sieht den Limit-Text des Servers; ein vom Server abgelehntes Kinderprofil zeigt den allgemeinen Fehler.

**Fenster, Tray und Links**
22. Tray: *Open FriendFlix*, die Serveradresse (grau), *Settings*, *Quit*. Das Fenster zu schließen beendet die App. Größe, Position und Maximiert-Zustand des Fensters sind nach einem Neustart wieder da.
23. Starte FriendFlix ein zweites Mal: das offene Fenster kommt nach vorn. `friendflix://watch/<id>` (über *Win+R* oder einen Link) spielt den Titel für das letzte Profil; ist kein Profil bekannt, öffnet es die Wiedergabeseite im Fenster.
24. Einstellungen: ändere die Serveradresse (ein Tippfehler bleibt auf der Seite); Hardware-Dekodierung aus, dann spielt ein Titel; Vollbild aus, dann öffnet der Player im Fenster; mit Windows starten an, dann startet die App nach der Windows-Anmeldung (und aus entfernt es).

**Updates** (braucht die Betreiber-Schritte und zwei veröffentlichte Versionen)
25. Mit *Updates automatisch installieren*: installiere Version N, veröffentliche N+1; nach dem Start der App wird das Update beim nächsten Start installiert. Mit *Vorher fragen*: der Hinweis zeigt *Install and restart*, vor dem Klick wird nichts installiert. Solange der Player läuft, wartet das Update.
26. Ein Build mit falschem oder ohne öffentlichen Schlüssel protokolliert *updates are off* und die App funktioniert.

**Logs und Datenschutz**
27. `%LOCALAPPDATA%\FriendFlix\logs` hat das Log des Tages; es enthält kein Cookie, kein Token und keine vollständige Stream-Adresse.

## Selbst bauen

Die App liegt in `desktop/`: `core/` (reines Rust, die ganze Logik, auf jedem System getestet), `app/` (die Tauri-v2-App, Windows) und `player/` (die mpv-Bedienoberfläche in Lua). Die Rust-Version steht in `desktop/rust-toolchain.toml`.

```sh
cd desktop
cargo fmt --check && cargo clippy --locked -p friendflix-core -- -D warnings
cargo test --locked -p friendflix-core            # Logik, läuft auch unter Linux und macOS
lua5.4 player/test/layout_test.lua                # die Tests der Oberfläche
```

Die App selbst baut nur unter Windows. Mit Rust, Node und PowerShell auf einem Windows-PC:

```powershell
./desktop/scripts/fetch-mpv.ps1 -Dest desktop/app/mpv      # lädt das festgelegte mpv und prüft die SHA-256 aus mpv.lock
cd desktop/app
npx --yes @tauri-apps/cli@2.12.3 build -- --locked        # Installer in desktop/target/release/bundle/
```

Ohne echten Schlüssel in `desktop/app/updater.pub` schaltet der Build die Selbst-Updates ab. Die Version kommt aus `version.json` oben im Repository. Der Release-Workflow ist `.github/workflows/desktop-release.yml`; er läuft aus `ci.yml` bei einem `vX.Y.Z`-Tag.
