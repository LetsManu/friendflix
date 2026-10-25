# FriendFlix für Samsung-Fernseher

[English](../tizen.md) · **Deutsch**

Die Samsung-TV-App ist FriendFlix als App auf einem Samsung-Smart-TV (Tizen 6.5 oder neuer, etwa Modelle ab 2021): eine schlanke Hülle, die einmal nach der Adresse deines Servers fragt und dann den [TV-Modus](../tv-mode.md) deines Servers im Vollbild öffnet. Alles, was du siehst, ist die Weboberfläche, sie passt also immer zur Version deines Servers.

**Stand dieser Version.** Dieser erste Release ist der **Probe-Build** plus die App-Hülle. Die Probe ist eine kleine Test-App, die herausfindet, ob der eigene Videoplayer des Fernsehers (AVPlay) FriendFlix-Streams abspielen kann. Der Player selbst, mit den Fernbedienungstasten und der Fähigkeitenliste für AVPlay, kommt in einem folgenden Release, wenn das Probe-Ergebnis vorliegt. Bis dahin kannst du die Probe ausprobieren. Der Samsung-App-Store ist nicht vorgesehen: Die App wird von deinem PC aus auf Fernseher installiert, die du auswählst.

**So funktioniert es, kurz.** Samsung lässt auf einem Fernseher nur Apps laufen, die mit einem Zertifikat signiert sind, das die Kennung dieses Fernsehers (seine DUID) enthält. Der Betreiber erstellt deshalb einmal ein Samsung-Zertifikat, legt es in vier GitHub-Secrets, und jeder Release bekommt signierte `.wgt`-Dateien. Danach führt jemand das Installationsskript auf einem PC im selben Netzwerk wie der Fernseher aus. Die App aktualisiert sich **nicht** selbst: Nach einem neuen Release führst du das Installationsskript erneut aus.

**Voraussetzungen:** ein Samsung-Fernseher ab Modelljahr 2021 (Tizen 6.5+); ein Windows-, macOS- oder Linux-PC im selben Netzwerk wie der Fernseher; ein FriendFlix-Server, der per HTTPS mit einem Zertifikat einer öffentlichen CA erreichbar ist, in der Version, die die Samsung-TV-App ausliefert (siehe [Änderungsprotokoll](../../CHANGELOG.md)) oder neuer; der Fernseher für den TV-Modus gekoppelt ([tv-mode.md](../tv-mode.md)).

Die Oberflächen des Fernsehers und von Tizen Studio stehen hier mit ihren üblichen deutschen oder englischen Beschriftungen; die App selbst und die Probe sind englisch.

## Inhalt

- [Überblick über die Schritte](#überblick-über-die-schritte)
- [Fernseher: Entwicklermodus](#fernseher-entwicklermodus)
- [PC: Tizen Studio und das Samsung-Zertifikat](#pc-tizen-studio-und-das-samsung-zertifikat)
- [Betreiber-Schritte: die vier GitHub-Secrets](#betreiber-schritte-die-vier-github-secrets)
- [Fernseher von Freunden](#fernseher-von-freunden)
- [Auf dem Fernseher installieren](#auf-dem-fernseher-installieren)
- [Erster Start: die Serveradresse](#erster-start-die-serveradresse)
- [Die Probe und wie du ihre Zeile liest](#die-probe-und-wie-du-ihre-zeile-liest)
- [Updates](#updates)
- [Fehlersuche](#fehlersuche)

## Überblick über die Schritte

1. **Betreiber, einmalig:** Tizen Studio mit der Samsung Certificate Extension installieren, das Samsung-Autoren- und das Distributor-Zertifikat mit der DUID des Fernsehers erstellen, beide als Base64 exportieren und die vier GitHub-Secrets anlegen.
2. **Betreiber, pro Release:** Der Release-Workflow signiert `FriendFlix-<Version>.wgt` und `FriendFlix-probe-<Version>.wgt` und hängt sie mit `SHA256SUMS-tizen.txt` an das GitHub-Release. Ohne die Secrets hinterlässt er nur einen Hinweis und hängt nichts an.
3. **Pro Fernseher:** Entwicklermodus einschalten, dann das Installationsskript von einem PC aus ausführen.
4. **Zuerst die Probe:** die Probe installieren, ihre Zeile lesen und an den Betreiber dieses Projekts schicken (siehe [die Probe](#die-probe-und-wie-du-ihre-zeile-liest)).

## Fernseher: Entwicklermodus

Ein Samsung-Fernseher installiert eigene Apps nur im Entwicklermodus.

1. Drücke auf der Fernbedienung **Home** und öffne **Apps**.
2. Gib mit dem Ziffernblock der Fernbedienung (oder dem Ziffernblock auf dem Bildschirm) **1 2 3 4 5** ein. Der Dialog *Entwicklermodus* (*Developer mode*) öffnet sich.
3. Stelle **Entwicklermodus** auf **Ein** (*On*).
4. Trage bei **Host-PC-IP** (*Host PC IP*) die IP-Adresse des PCs ein, von dem aus du installierst (Windows: `ipconfig`; macOS und Linux: `ip addr` oder die Netzwerk-Einstellungen), zum Beispiel `192.0.2.20`.
5. Bestätige mit OK und **starte den Fernseher neu** (Ein/Aus-Taste halten, bis er neu startet, oder kurz den Stecker ziehen). Der Entwicklermodus gilt erst nach dem Neustart.

Notiere auch die eigene IP-Adresse des Fernsehers (*Einstellungen → Allgemein → Netzwerk → Netzwerkstatus → IP-Einstellungen*), zum Beispiel `192.0.2.50`. Sie gibst du dem Installationsskript.

Manche Modelle schalten den Entwicklermodus nach einem Neustart wieder aus. Meldet die Installation, dass sie sich nicht verbinden kann, wiederhole die Schritte 2 bis 5.

## PC: Tizen Studio und das Samsung-Zertifikat

Nur der PC, der das Zertifikat erstellt, braucht das volle Tizen Studio; ein PC, der nur installiert, braucht lediglich die Kommandozeilen-Werkzeuge `sdb` und `tizen`.

1. Installiere **Tizen Studio** von [developer.tizen.org](https://developer.tizen.org/development/tizen-studio/download) (den Installer mit IDE oder den reinen CLI-Installer). Das Installationsskript sucht `sdb` und `tizen` im `PATH`, in `$TIZEN_STUDIO` und in `~/tizen-studio` (unter Windows auch `C:\tizen-studio`).
2. Öffne den **Package Manager** von Tizen Studio und installiere unter *Extension SDK* die **Samsung Certificate Extension**. Starte Tizen Studio neu.
3. Melde dich mit einem **Samsung-Konto** an, wenn der Zertifikatsdialog danach fragt.

### Die DUID des Fernsehers lesen

Die DUID kennzeichnet den Fernseher. Zwei Wege:

- **Device Manager** (Tizen Studio: *Tools → Device Manager*): Verbinde den Fernseher (Rechtsklick, *Connect*; nötig sind der Entwicklermodus und die Host-PC-IP von oben). Die *DUID* steht in den Eigenschaften des Geräts.
- **Kommandozeile:** `sdb connect 192.0.2.50:26101`, dann `sdb shell 0 getduid`.

### Zertifikate erstellen

Öffne in Tizen Studio **Tools → Certificate Manager** und lege ein Zertifikatsprofil an:

1. **+** → *Samsung*-Zertifikat, Gerätetyp *TV*.
2. Erstelle ein neues **Autorenzertifikat** (*Author certificate*: Name, Passwort, deine Angaben). Melde dich mit deinem Samsung-Konto an, wenn danach gefragt wird.
3. Wähle für das **Distributor-Zertifikat** die Berechtigungsstufe *Public* und füge die **DUID** jedes Fernsehers hinzu, auf dem die App laufen soll (die DUID von oben; weitere können folgen, siehe [Fernseher von Freunden](#fernseher-von-freunden)).
4. Schließe ab. Tizen Studio schreibt die beiden Dateien `author.p12` und `distributor.p12` in seinen Datenordner (typisch `~/SamsungCertificate/<Profilname>/` oder `C:\Users\<du>\SamsungCertificate\<Profilname>\`).

**Passwort-Grenzen.** Der Release signiert über das Tizen-Kommandozeilenwerkzeug, das nicht jedes Zeichen verträgt. Beide Zertifikatspasswörter müssen aus druckbarem ASCII bestehen (Buchstaben, Ziffern und die üblichen Sonderzeichen), **ohne** `'` (einfaches Anführungszeichen), `*`, `?`, `[` und ohne Leerzeichen am Anfang, am Ende oder zwei hintereinander. Der Release-Job bricht mit einer klaren Meldung ab, wenn ein Passwort nicht passt. Nimm zur Sicherheit ein neues, langes, zufälliges Passwort aus Buchstaben und Ziffern und ändere das Passwort des Zertifikats bei Bedarf im Certificate Manager.

**OpenSSL 3.** Exportierst oder konvertierst du eine p12-Datei selbst mit OpenSSL 3, hänge `-legacy` an (`openssl pkcs12 -legacy ...`); sonst kann das Tizen-Werkzeug (mit älterem Java) die Datei nicht lesen.

## Betreiber-Schritte: die vier GitHub-Secrets

Lege diese vier Secrets im Repository an (*Settings → Secrets and variables → Actions → New repository secret*, oder mit `gh`):

| Secret | Inhalt |
|---|---|
| `TIZEN_AUTHOR_P12` | `author.p12`, Base64 |
| `TIZEN_AUTHOR_PASSWORD` | sein Passwort |
| `TIZEN_DISTRIBUTOR_P12` | `distributor.p12` (enthält die DUIDs der Fernseher), Base64 |
| `TIZEN_DISTRIBUTOR_PASSWORD` | sein Passwort |

Kodiere die Dateien als Base64 ohne Zeilenumbrüche.

**Linux oder macOS (bash):**

```sh
base64 < author.p12 | tr -d '\n' | gh secret set TIZEN_AUTHOR_P12
base64 < distributor.p12 | tr -d '\n' | gh secret set TIZEN_DISTRIBUTOR_P12
gh secret set TIZEN_AUTHOR_PASSWORD
gh secret set TIZEN_DISTRIBUTOR_PASSWORD
```

**Windows (PowerShell):**

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("author.p12")) | gh secret set TIZEN_AUTHOR_P12
[Convert]::ToBase64String([IO.File]::ReadAllBytes("distributor.p12")) | gh secret set TIZEN_DISTRIBUTOR_P12
gh secret set TIZEN_AUTHOR_PASSWORD
gh secret set TIZEN_DISTRIBUTOR_PASSWORD
```

`gh secret set NAME` ohne Eingabe fragt nach dem Wert. Ohne `gh` kopierst du den Base64-Text ins Webformular.

**Bewahre die p12-Dateien und Passwörter** zusätzlich in deinem Passwortmanager auf und committe sie nie. Wer beides hat, kann Apps für die im Distributor-Zertifikat eingetragenen Fernseher signieren.

**Alle vier sind nötig.** Der Release-Workflow `tizen-release` läuft bei jedem `vX.Y.Z`-Tag; fehlt eines der vier Secrets, schreibt er nur einen Hinweis (*Samsung TV app release skipped*) und hängt nichts an; der übrige Release bleibt unberührt. Um einen bestehenden Release nachträglich zu signieren (zum Beispiel nach dem Anlegen der Secrets), starte den Workflow *Samsung TV app release* von Hand (*Actions → Run workflow*) und wähle den Tag.

Die Dateien am Release sind `FriendFlix-<Version>.wgt`, `FriendFlix-probe-<Version>.wgt` und `SHA256SUMS-tizen.txt`. Zum Signieren dient eine festgelegte Version der Tizen-Kommandozeilenwerkzeuge (`tizen/tizen-cli.lock`, das Archiv wird vor der Nutzung per SHA-256 geprüft).

## Fernseher von Freunden

Ein Fernseher führt die App nur aus, wenn seine DUID in dem Distributor-Zertifikat steht, das die `.wgt` signiert hat. So fügst du den Fernseher eines Freundes hinzu:

1. Versetze den Fernseher in den Entwicklermodus mit der IP deines PCs als Host-PC-IP und lies seine DUID (siehe oben), oder bitte den Freund, sie mit dem Device Manager zu lesen.
2. Öffne im **Certificate Manager** von Tizen Studio dein Zertifikatsprofil, füge die DUID dem Distributor-Zertifikat hinzu und schließe ab (es entsteht eine neue `distributor.p12`).
3. Aktualisiere das GitHub-Secret `TIZEN_DISTRIBUTOR_P12` (und das Passwort, falls du es geändert hast).
4. Erstelle den nächsten Release oder starte *Samsung TV app release* erneut auf dem neuesten Tag. Installiere dann aus diesem Release.

Bereits installierte Fernseher laufen mit der alten Datei weiter; nur ein Fernseher, der noch nicht im Zertifikat steht, braucht die neue.

## Auf dem Fernseher installieren

Die Skripte laden die `.wgt` und `SHA256SUMS-tizen.txt` vom GitHub-Release (standardmäßig vom neuesten), prüfen den SHA-256 und installieren bei Abweichung nichts, dann führen sie `sdb connect <ip>:26101` und `tizen install` für diesen Fernseher aus.

**Linux oder macOS:**

```sh
./tizen/install.sh 192.0.2.50 --probe          # zuerst die Probe
./tizen/install.sh 192.0.2.50                  # FriendFlix
./tizen/install.sh 192.0.2.50 --version v2.4.0 # ein bestimmter Release
```

**Windows (PowerShell):**

```powershell
.\tizen\install.ps1 192.0.2.50 -Probe
.\tizen\install.ps1 192.0.2.50
.\tizen\install.ps1 192.0.2.50 -Version v2.4.0
```

| Argument | Bedeutung |
|---|---|
| `<tv-ip>` | IPv4-Adresse des Fernsehers. Pflicht. |
| `--probe` / `-Probe` | **FriendFlix Probe** (die Test-App) statt FriendFlix installieren. |
| `--version vX.Y.Z` / `-Version vX.Y.Z` | Ein bestimmter Release. Ohne Angabe der neueste. |

Exit-Codes: `0` installiert; `1` fehlgeschlagen (keine Verbindung, kein Download, Hash-Abweichung, Installation fehlgeschlagen; das Skript gibt Hinweise aus); `2` falsche Argumente (die Verwendung wird angezeigt). Die beiden Apps sind verschiedene Apps und können nebeneinander installiert bleiben. Öffne die App danach unter **Apps** am Fernseher.

Schlägt die Installation fehl, erinnert das Skript an Entwicklermodus und Host-PC-IP, dasselbe Netzwerk und Port 26101 sowie die DUID im Zertifikat; siehe [Fehlersuche](#fehlersuche).

## Erster Start: die Serveradresse

Beim ersten Start fragt die App nach der Adresse deines Servers, zum Beispiel `friend.example.com`.

- Gib sie mit der Tastatur des Fernsehers ein: OK auf dem Feld öffnet sie, **Return** schließt die Tastatur, die Pfeiltasten wechseln zwischen Feld und **Connect**.
- Es geht nur `https://`; `https://` wird für dich ergänzt. Eine einfache `http://`-Adresse wird abgelehnt (der Fernseher trägt ein Anmelde-Cookie).
- Die App prüft, ob die Adresse wie ein FriendFlix-Server antwortet (`GET /api/version`, das der Server für alle beantwortet, mit CORS `*`, weil dort nur öffentliche Angaben stehen). Wenn nicht, sagt sie warum.
- Die Adresse wird gemerkt. Beim nächsten Start zeigt die App kurz *Opening <Adresse>* und öffnet den TV-Modus deines Servers. Ist der Fernseher noch nicht gekoppelt, zeigt er wie gewohnt den Kopplungscode: koppele ihn wie in [tv-mode.md](../tv-mode.md) beschrieben.
- **Adresse ändern:** Halte die **rote Taste** eine Sekunde lang, während die App startet (oder während sie *Opening* zeigt). Sie vergisst den gespeicherten Server und zeigt wieder das Formular.
- **Return** auf der Fernbedienung beendet die App (bei offener Tastatur schließt es zuerst die Tastatur).

## Die Probe und wie du ihre Zeile liest

Die Probe entscheidet, wie der Player gebaut wird; führe sie bitte auf dem Fernseher aus, den du nutzen willst.

1. [Installiere die Probe](#auf-dem-fernseher-installieren) (`--probe` / `-Probe`) und öffne **FriendFlix Probe** unter Apps am Fernseher.
2. **Koppele den Fernseher zuerst für den TV-Modus**, falls noch nicht geschehen (die Probe startet die Kopplungsseite; [tv-mode.md](../tv-mode.md)). Der Abspieltest braucht einen gekoppelten Fernseher, weil er einen Titel aus deiner Bibliothek mit der Sitzung des Fernsehers abspielt. Auf der Kopplungsseite erscheint die Probe als kleiner Streifen unten; nach dem Koppeln startet sie erneut im Vollbild.
3. Der Bildschirm zeigt **Testing playback…** (der Fernseher versucht bis zu 15 Sekunden lang, den ersten Titel aus *Weiterschauen* abzuspielen, sonst deinen neuesten Film oder deine neueste Folge), dann **Press ⏯ now**. Drücke innerhalb von 20 Sekunden die Wiedergabe/Pause-Taste der Fernbedienung.
4. Der Bildschirm zeigt **eine Zeile**. **Schicke die ganze Zeile an den Betreiber des Projekts** (vorlesen oder den Bildschirm fotografieren). **Zurück** schließt den Bildschirm.

Die Zeile sieht so aus:

```
FFPROBE v1 avplay=ok play=ok:2310ms keys=ok app=ok tizen=6.5 model=QE55Q80B
```

| Feld | Werte | Bedeutung |
|---|---|---|
| `avplay` | `ok`, `missing` | `ok`: Der AVPlay-Player des Fernsehers ist auf der Server-Seite vorhanden. `missing`: ist er nicht, der Abspieltest entfällt. |
| `play` | `ok:<ms>ms` | AVPlay hat einen FriendFlix-Stream gestartet und nach so vielen Millisekunden die Wiedergabe erreicht. |
| | `error:unpaired` | Der Fernseher ist nicht für den TV-Modus gekoppelt, es gab also nichts abzuspielen. Koppeln und erneut ausführen. |
| | `error:info` | Die Stream-Abfrage ist fehlgeschlagen (kein Titel, Fehlerantwort des Servers, offline). |
| | `error:open` | AVPlay hat die Stream-Adresse abgelehnt. |
| | `error:timeout` | Keine Wiedergabe innerhalb von 15 Sekunden. |
| | `error:<code>` | Der eigene Fehlername von AVPlay (zum Beispiel `PLAYER_ERROR_INVALID_OPERATION`); `unknown`, wenn keiner kam. |
| | `skipped` | Nicht versucht, weil `avplay=missing`. |
| `keys` | `ok`, `error`, `timeout` | `ok`: Die ⏯-Taste wurde registriert und ein Druck kam an. `error`: Die Taste ließ sich nicht registrieren. `timeout`: kein Druck innerhalb von 20 Sekunden (erneut versuchen und früher drücken). |
| `app` | `ok`, `missing` | Ob die Tizen-Application-API verfügbar ist. |
| `tizen` | Version oder `?` | Die Plattformversion des Fernsehers, zum Beispiel `6.5`. |
| `model` | Name oder `?` | Das Modell des Fernsehers, zum Beispiel `QE55Q80B`. |

Entscheidend ist vor allem `avplay=ok play=ok:...`. Egal was die Zeile sagt, schicke sie vollständig: Auch die anderen Werte zeigen, welche Teile einen anderen Weg brauchen.

Die Probe bleibt als Diagnose-Werkzeug im Repository und an jedem Release.

## Updates

Die App aktualisiert sich nicht selbst (eine Entwicklermodus-App kann das nicht). Führe nach einem neuen Release das Installationsskript erneut aus; es installiert die neue Version über die alte. Die Version am Release ist die Version des Servers. Der Samsung-App-Store ist nicht vorgesehen.

## Fehlersuche

- **`sdb connect` schlägt fehl oder der Fernseher fehlt in der Liste:** Der Entwicklermodus muss an sein, mit der Host-PC-IP des PCs, von dem du installierst, und der Fernseher danach neu gestartet sein. Fernseher und PC müssen im selben Netzwerk sein, und nichts darf den TCP-Port `26101` blockieren (eine Firewall, ein Gastnetz oder VLAN). Manche Fernseher schalten den Entwicklermodus nach einem Neustart aus: schalte ihn wieder ein.
- **"install failed ... author certificate" oder "Check certificate error":** Die DUID des Fernsehers steht nicht im Distributor-Zertifikat. Füge sie hinzu und signiere neu ([Fernseher von Freunden](#fernseher-von-freunden)), dann installiere den neuen Release.
- **Der Release hat keine `.wgt`-Dateien:** Beim Bauen des Tags waren nicht alle vier Secrets gesetzt (*Actions → Samsung TV app release* zeigt den Hinweis). Lege sie an und starte den Workflow auf dem Tag von Hand. Bricht der Job mit "password has characters the Tizen CLI cannot take" ab, siehe die [Passwort-Grenzen](#pc-tizen-studio-und-das-samsung-zertifikat).
- **Der Job kann die p12 nicht lesen:** Hast du die Datei mit OpenSSL 3 konvertiert, exportiere sie erneut mit `-legacy`.
- **"SHA-256 mismatch":** Der Download ist beschädigt oder wurde ersetzt; das Skript installiert nichts. Versuche es erneut; bleibt es so, sieh dir die Dateien des Releases an.
- **Falsches Skript unter Windows:** Führe `install.ps1` in PowerShell aus. Sind Skripte gesperrt: `powershell -ExecutionPolicy Bypass -File .\tizen\install.ps1 192.0.2.50`.
- **"not an IPv4 address":** Nimm die Adresse des Fernsehers aus seinen Netzwerk-Einstellungen, keinen Namen.
- **"Cannot reach that server" am Fernseher:** Prüfe die Adresse, das Netzwerk des Fernsehers und ob der Server läuft. "That address answered, but it is not a FriendFlix server" heißt, dass dort ein anderer Dienst antwortet (Router-Seite, Proxy-Anmeldung).
- **"Plain http:// addresses are not allowed":** Stelle den Server hinter HTTPS (siehe [setup.md](setup.md)).
- **Die Probe zeigt `error:unpaired`:** Koppele den Fernseher ([tv-mode.md](../tv-mode.md)) und starte die Probe erneut.
- **Falsche Serveradresse gespeichert:** Halte die rote Taste, während die App startet.
