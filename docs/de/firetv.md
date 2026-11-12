# FriendFlix für Fire TV

[English](../firetv.md) · **Deutsch**

Die Fire-TV-App öffnet den TV-Modus deines Servers im Vollbild auf einem Amazon Fire TV Stick, Cube oder Fernseher: Seitenmenü, große Kacheln, Detailseiten und der TV-Player, gesteuert mit der Fire-TV-Fernbedienung oder mit deinem Handy als Fernbedienung. Sie sagt dem Server, was das Fire TV abspielen kann, damit Dateien, die es selbst kann, nicht umgewandelt werden.

Es ist dieselbe Weboberfläche, die dein Server im [TV-Modus](../tv-mode.md) ausliefert, in einer kleinen abgeschotteten App. Sie hat keine Downloads, kein Chromecast, keine Benachrichtigungen und keinen nativen Player; sie nutzt keine Google-Dienste.

## Inhalt

- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Erster Start](#erster-start)
- [Die Fernbedienung](#die-fernbedienung)
- [Was direkt abgespielt wird](#was-direkt-abgespielt-wird)
- [Die Testzeile beim ersten Start](#die-testzeile-beim-ersten-start)
- [Server wechseln](#server-wechseln)
- [Updates](#updates)
- [Schritte für den Betreiber: Amazon Appstore](#schritte-für-den-betreiber-amazon-appstore)
- [Checkliste für das Gerät](#checkliste-für-das-gerät)
- [Probleme lösen](#probleme-lösen)
- [Selbst bauen](#selbst-bauen)

## Voraussetzungen

- **Ein Fire TV mit Fire OS 7 oder neuer** (Android 9 und höher): Fire TV Stick 3. Generation, Lite, 4K und 4K Max, Fire TV Cube 2. und 3. Generation sowie Fire-TV-Fernseher mit Fire OS 7 oder 8. Geräte mit Vega OS sind kein Android und können die App nicht ausführen. Fire-Tablets werden nicht unterstützt. *(Welches Modell welche Fire-OS-Version hat, ließ sich offline nicht prüfen; schau auf deinem Gerät unter Einstellungen → Mein Fire TV → Info nach.)*
- **Ein FriendFlix-Server, der per HTTPS erreichbar ist**, mit einem Zertifikat einer öffentlichen CA (zum Beispiel Let's Encrypt). Einfache `http://`-Adressen werden abgelehnt.
- **Server und App in derselben Version.** Ist eines von beiden zu alt, sagt die App, welches du aktualisieren musst.

## Installation

**Aus dem Amazon Appstore.** Sobald der Betreiber die App veröffentlicht hat ([Schritte für den Betreiber](#schritte-für-den-betreiber-amazon-appstore)), suchst du auf dem Fire TV nach **FriendFlix** und wählst **Herunterladen**. Updates kommen über den Appstore.

**Aus dem GitHub-Release.** Jedes Release (`vX.Y.Z`) hat neben den Notizen eine signierte `friendflix-firetv-<Version>.apk` mit einer Datei `friendflix-firetv-<Version>.sha256` zum Prüfen. Beide Wege unten brauchen die Einstellung, die dein Fire TV Apps von außerhalb des Appstores installieren lässt.

*Unbekannte Quellen erlauben.* Öffne am Fire TV **Einstellungen → Mein Fire TV → Entwickleroptionen**. Siehst du keine Entwickleroptionen, öffne **Info**, wähle siebenmal schnell hintereinander den Gerätenamen und geh zurück. Schalte **Apps unbekannter Herkunft** ein (neuere Fire-OS-Versionen fragen stattdessen pro App: erlaube es für die App, die du im nächsten Schritt benutzt). *(Die Menünamen ändern sich zwischen Fire-OS-Versionen; das ließ sich offline nicht prüfen.)*

*Weg A: Downloader-App (ohne Computer).*

1. Installiere die kostenlose App **Downloader** aus dem Appstore.
2. Erlaube Downloader, unbekannte Apps zu installieren, wenn Fire OS fragt (**Einstellungen → Mein Fire TV → Unbekannte Apps installieren**, oder die Frage bei der ersten Installation).
3. Gib in Downloader die Adresse der APK auf der GitHub-Release-Seite dieses Projekts ein, oder einen eigenen Kurzlink dorthin, und lade sie herunter.
4. Wähle **Installieren**, dann **Öffnen**.

*Weg B: ADB vom Computer.* Computer und Fire TV müssen im selben Netzwerk sein, und **ADB-Debugging** muss in den Entwickleroptionen eingeschaltet sein.

1. Die Adresse des Fire TV findest du unter **Einstellungen → Mein Fire TV → Info → Netzwerk** (zum Beispiel `192.0.2.20`).
2. Lade die APK auf den Computer. Zum Prüfen vergleichst du ihre SHA-256 mit der `.sha256`-Datei (`sha256sum -c friendflix-firetv-<Version>.sha256` unter Linux und macOS, `Get-FileHash` in PowerShell).
3. In einem Terminal:

```sh
adb connect 192.0.2.20
adb install friendflix-firetv-<Version>.apk
```

Das Fire TV fragt einmal, ob die Verbindung von diesem Computer erlaubt ist; bestätige mit der Fernbedienung. Um zuvor eine alte Installation zu entfernen, nutze `adb uninstall com.friendflix.firetv`.

Danach findest du FriendFlix in deiner App-Liste. Schalte ADB-Debugging wieder aus, wenn du es nicht brauchst.

## Erster Start

1. Öffne **FriendFlix**. Beim ersten Mal erscheint ein Feld **Serveradresse**.
2. Drücke auf dem Feld die mittlere Taste (Auswählen), um mit der Fernbedienung zu tippen, zum Beispiel `friend.example.com`, und bestätige mit dem Haken der Tastatur. Hoch und Runter wechseln zwischen Feld und **Verbinden**.
3. Wähle **Verbinden**. Die App zeigt *friend.example.com wird geöffnet*, während sie den Server prüft. Eine gelungene Prüfung wird gespeichert; beim nächsten Mal geht die App direkt hinein.
4. Ein neuer Fernseher zeigt einen **Kopplungscode** und einen **QR-Code**. Öffne auf dem Handy (angemeldet) **Menü → Fernbedienung**, gib den Code ein und tippe auf **Koppeln**, oder scanne den QR-Code, wie in [tv-mode.md](../tv-mode.md) beschrieben. Nach dem Koppeln öffnet der Fernseher deine Startseite.

Scheitert die Prüfung, nennt die Karte den Grund und bietet **Erneut versuchen** und **Server wechseln** an:

| Meldung | Was sie bedeutet und was du tust |
|---|---|
| Gib die Adresse deines FriendFlix-Servers ein. | Das Feld ist leer. |
| Unverschlüsselte http://-Adressen sind nicht erlaubt. | Nimm eine `https://`-Adresse. |
| Das sieht nicht nach einer Serveradresse aus. | Versuch etwas wie `friend.example.com`. |
| Der Server ist nicht erreichbar. | Prüfe Adresse, Netzwerk und ob der Server läuft. |
| Diese Adresse antwortet, ist aber kein FriendFlix-Server. | Falsche Adresse, oder ein Proxy vor etwas anderem. |
| Die sichere Verbindung ist fehlgeschlagen. Dem Zertifikat des Servers wird nicht vertraut. | Der Server braucht ein Zertifikat einer öffentlichen CA. |
| Diese App ist zu alt für den Server. | Aktualisiere FriendFlix auf dem Fire TV. |
| Der Server ist zu alt für diese App. | Aktualisiere FriendFlix auf dem Server. |

Zurück auf dem Adressbildschirm beendet die App.

## Die Fernbedienung

Pfeiltasten und Auswählen bewegen und öffnen wie in jedem Browser. Diese Tasten behandelt die App selbst:

| Taste der Fire-TV-Fernbedienung | Was sie tut |
|---|---|
| Zurück | Eine Ebene zurück. Auf den TV-Seiten (Startseite, Serien, Filme, Meine Liste, Suche) öffnet Zurück zuerst das Seitenmenü. Auf der Startseite mit offenem Menü beendet Zurück die App. In einem Textfeld verlässt Zurück nur das Feld. |
| Play/Pause | Pausieren oder fortsetzen. |
| Play · Pause | Abspielen · pausieren (Fernbedienungen mit getrennten Tasten). |
| Vorspulen | 30 Sekunden vor. |
| Zurückspulen | 30 Sekunden zurück. |
| Weiter (wo die Fernbedienung sie hat) | Nächste Folge, wo es eine gibt. |

Im Player von [Live-TV](livetv.md) gibt die App außerdem diese Tasten weiter, sofern die Fernbedienung sie hat:

| Taste der Fire-TV-Fernbedienung | Was sie im Live-Player tut |
|---|---|
| CH+ · CH− | Nächster · vorheriger Sender. |
| 0–9 | Sendernummer eingeben. Eine einzelne 0 springt zum letzten Sender zurück. |
| Letzter Sender | Zurück zum letzten Sender. |
| Info | Infos zur Sendung. |
| Guide | Öffnet die *Senderliste*. |

**Die meisten Fire-TV-Fernbedienungen haben keine Kanal-, Ziffern-, Info- oder Guide-Tasten, und sie werden auch nicht gebraucht:** ▲/▼ schalten um, solange die Bedienleiste ausgeblendet ist, OK blendet sie ein, mit gedrückt gehaltenem OK öffnet sich die *Senderliste*, und Zurück schließt erst das offene Panel, dann die Bedienleiste, dann den Player. Alles andere erreichst du mit den Pfeiltasten und OK.

Wer Vorspulen gedrückt hält, springt nur einmal, nicht minutenweit. Wer CH+ oder CH− gedrückt hält, schaltet einen Sender weiter, nicht durch die ganze Liste. Links am Rand öffnet das Seitenmenü, Rechts schließt es. Alle Bedienungen des TV-Modus (Playerleiste, Szenenvorschau, Panels) stehen in [tv-mode.md](../tv-mode.md). Dein **Handy als Fernbedienung** funktioniert wie an jedem Fernseher: Menü → Fernbedienung am Handy.

*(Ob jedes Fire-TV-Fernbedienungsmodell die Medientasten an die App schickt, ließ sich offline nicht prüfen; die Checkliste unten deckt es ab.)*

## Was direkt abgespielt wird

Die App fragt die Web-Engine des Fire TV, welche Video- und Audioformate und Container sie abspielen kann, und teilt das dem Server mit. Der Server schickt dann, was der Fernseher selbst kann, unverändert und wandelt den Rest um (HLS). 4K wird nur angeboten, wenn der angeschlossene Bildschirm ein 4K-Bildschirm ist; sonst gilt 1080p. Ton, den der Fernseher nicht dekodieren kann (manche Surround-Formate), wird in ein Format umgewandelt, das er kann. Solange ein Titel läuft, bleibt der Bildschirmschoner aus.

## Die Testzeile beim ersten Start

Wenn die App einen Server zum ersten Mal öffnet (und noch einmal nach einem Wechsel auf einen anderen Server oder erneut auf denselben), läuft auf dem Fernseher eine kurze Prüfung. Sie bestätigt die Formate, spielt einen Titel aus deiner Bibliothek auf drei Wegen ab (direkt, umgewandelt und über das eigene HLS des Fernsehers; stumm, jeweils höchstens 15 Sekunden) und zeigt dann **eine Zeile**. Ist der Fernseher noch nicht gekoppelt, erscheint ein kleiner Streifen auf der Kopplungsseite, und die volle Prüfung läuft nach dem Koppeln.

**Bitte schick die ganze Zeile an den Projektbetreiber** (vorlesen oder fotografieren). **Zurück** schließt den Bildschirm. Die Prüfung speichert nie einen Fortschritt für den Titel, den sie abspielt.

```
FFPROBE v1 tv=firetv os=<android>/<model> direct=ok:1840ms hls=ok nativehls=ok palm=no home=skipped keys=skipped video=h264,hevc+10,av1 audio=aac,ac3,eac3,mp3,opus containers=mp4,ts,webm hlsvideo=h264,hevc surround=eac3,ac3 ch=6 screen=1920x1080
```

| Feld | Bedeutung |
|---|---|
| `tv=firetv`, `os=` | Die Plattform, die Android-Version und das Gerätemodell. |
| `direct` | `ok:<ms>ms`, wenn eine Direktwiedergabe nach so vielen Millisekunden das erste Bild zeigte. `error:nodirect` heißt, der Server bot für den Testtitel keinen Direktstream an (versuch einen anderen Titel). Andere `error:`-Werte nennen den Grund. |
| `hls`, `nativehls` | Ob der umgewandelte Stream über das Player-Skript der App oder über das eigene HLS des Fernsehers läuft. |
| `palm`, `home`, `keys` | Auf dem Fire TV immer `no`, `skipped`, `skipped` (sie gehören zum LG-Test). |
| `video`, `audio`, `containers` | Die Formate, die das Fire TV bestätigt. |
| `hlsvideo` | `h264,hevc`, `-` | Die Videocodecs, die der Fernseher **in einem umgewandelten Stream** (HLS) bekommen darf. Strenger als `video`: gezählt nur, wenn die Streaming-Engine des Fernsehers (MSE `isTypeSupported`) sie bestätigt, `hevc` nur mit dem Tag `hvc1`. `-`: keine Antwort der Streaming-Engine, Streams bleiben also H.264. (`hls` weiter oben ist die Wiedergabeprüfung, nicht diese Liste.) |
| `surround` | `eac3,ac3`, `-` | Die Dolby-Surround-Codecs, die die Streaming-Engine bestätigt. Nur sie lassen den Server 5.1-Ton schicken; `-` heißt Stereo. |
| `ch` | `6`, `2` | Die Kanäle, die die App mit eingeschaltetem Raumklang und ohne Klangmodus meldet: `6`, wenn `surround` nicht leer ist, sonst `2`. |
| `screen` | Die Größe, die die Seite sieht. Sie sollte **`1920x1080`** lauten; etwas anderes heißt, dass das Layout nicht wie vorgesehen skaliert wird, und genau dann ist die Zeile wichtig. |

## HEVC-Streams und Raumklang

Umgewandelte Streams können HEVC und Dolby-Raumklang (E-AC-3 / AC-3) enthalten, wenn die Streaming-Engine des Fernsehers sie bestätigt (`hlsvideo`, `surround` in der Zeile). Die App behauptet beides erst nach bestandener Prüfung; eine unbekannte Antwort heißt der gewohnte H.264-Stereo-Stream. Startet ein Stream mit HEVC oder Raumklang nicht, wechselt der Player einmal zu einem Stream, den dieses Gerät abspielt, und merkt sich das 30 Tage. Läuft ein Titel, aber die **Soundbar bleibt stumm** (der Fernseher nimmt 5.1 an, der ARC-Weg gibt nichts aus), schalte im Bereich **Klang** des Players den Schalter **Raumklang** aus; der Fernseher bekommt dann Stereo. Auch Klangmodi erzwingen Stereo.

## Server wechseln

Öffne im TV-Modus das Seitenmenü, wähle **Konto** und dann **Server wechseln**. Die App zeigt das Adressformular mit dem aktuellen Server. Gib die neue Adresse ein und wähle **Verbinden**. Der Fernseher koppelt sich mit dem neuen Server neu. Ist ein Server gar nicht erreichbar, hat auch die Fehlerkarte eine Schaltfläche **Server wechseln**.

## Updates

- **Installation aus dem Appstore:** Das Fire TV aktualisiert sie selbst (oder über *Meine Apps* im Appstore).
- **Installation per APK:** Lade die nächste `friendflix-firetv-<Version>.apk` herunter und installiere sie über die alte (gleiche Schritte wie oben). Die App aktualisiert sich nicht selbst.
- **Nicht mischen.** Amazon signiert Apps, die es ausliefert, neu; deshalb tragen die Appstore-Version und die GitHub-APK verschiedene Signaturen und können sich nicht gegenseitig aktualisieren. Zum Wechseln deinstallierst du die App zuerst (**Einstellungen → Anwendungen → Installierte Anwendungen verwalten → FriendFlix → Deinstallieren**); der Fernseher wird danach neu gekoppelt.

## Schritte für den Betreiber: Amazon Appstore

Das ist eine einmalige Einrichtung, danach eine kurze Routine pro Release. Die App wird nie automatisch hochgeladen. *Die Seiten und Begriffe der Konsole ändern sich; Schritte, die davon abhängen, sind mit „(in der Konsole prüfen)“ markiert, weil sie sich offline nicht überprüfen ließen.*

1. **Entwicklerkonto anlegen.** Registriere dich (kostenlos) in der Amazon Developer Console mit einem Amazon-Konto und fülle das Entwicklerprofil aus. *(In der Konsole prüfen: Amazon verlangt womöglich auch bei kostenlosen Apps Telefonnummer, Steuer- oder Zahlungsangaben.)*
2. **Neue App anlegen.** Wähle in der Konsole **Apps & Services → My Apps → Add New App → Android**. Trag den Titel **FriendFlix** ein, wähl die passendste Kategorie (zum Beispiel Unterhaltung) und gib an, dass die App kostenlos ist und weder Amazons In-App-Käufe noch Amazon-spezifische APIs nutzt. *(In der Konsole prüfen.)*
3. **APK hochladen.** Lade `friendflix-firetv-<Version>.apk` vom GitHub-Release herunter und lade sie unter **Upload your app file** hoch. Amazon signiert die App mit einem eigenen Schlüssel neu; das ist erwartet (siehe [Updates](#updates)). Der Versionscode kommt aus `version.json` und wächst immer, was Amazon bei jedem neuen Upload verlangt.
4. **Geräte wählen.** Lass nur **Fire TV** aktiv; schalte Fire-Tablets und Handys aus. FriendFlix unterstützt sie nicht.
5. **Inhaltseinstufung.** Fülle den Fragebogen zur Inhaltseinstufung aus. FriendFlix hat keine eigenen Inhalte: Es zeigt, was der private Server des Betreibers enthält. Antworte also für eine App, die Videos des Nutzers abspielt, ohne In-App-Käufe, Werbung oder Nachrichten zwischen Nutzern. *(In der Konsole prüfen: Fragen und Einstufung sind Amazons.)*
6. **Store-Texte.** Trag Titel sowie Kurz- und Langbeschreibung auf Englisch und Deutsch ein. Beschreibe, was die App tut (öffnet deinen eigenen FriendFlix-Server im TV-Modus, Kopplung per Code, Handy als Fernbedienung), und nenne keinen anderen Dienst. Beispiel für den Kurztext: *„Dein eigener FriendFlix-Server auf dem großen Bildschirm.“*
7. **Bilder.** Lade aus `android/firetv/store-listing/` hoch:
   - `icon-512.png` (großes Symbol) und `icon-114.png` (kleines Symbol),
   - `banner-1280x720.png` (das TV-Banner),
   - `tv-1.png`, `tv-2.png`, `tv-3.png` (TV-Screenshots, 1920×1080).
8. **Datenschutzerklärung.** Verlinke [privacy.md](privacy.md) so, wie sie auf GitHub veröffentlicht ist (die URL der Datei auf der GitHub-Seite des Projekts).
9. **Testanweisungen für Amazons Prüfer.** FriendFlix braucht einen Server, also gib den Prüfern einen: *eine Testserver-Adresse (zum Beispiel `https://friend.example.com`), ein Testkonto und wie man den Fernseher koppelt*: App starten, Adresse eingeben, dann am Computer oder Handy den Server im Browser öffnen, mit dem Testkonto anmelden, `/remote` (Menü → Fernbedienung) öffnen und den Code eingeben, den der Fernseher zeigt. Nimm einen Demo-Server mit frei lizenzierten Filmen und ein Wegwerf-Konto, **nie deinen echten privaten Server oder dein eigenes Konto**. Schreib deutlich, dass die App ein Client für einen privaten Server ist und ohne Server nichts zu zeigen hat.
10. **Veröffentlichen.** Für ein Release nur für Freunde wähle **Live App Testing** (Amazons Testkanal: Du lädst Leute per E-Mail ein, und sie bekommen die App vor einem öffentlichen Eintrag aus dem Appstore). Für die Öffentlichkeit reichst du die App zur Prüfung ein und gibst sie frei. Die Prüfung kann Tage dauern. *(In der Konsole prüfen: die Namen dieser Optionen.)*
11. **Bei jedem Release:** Öffne die App in der Konsole, wähle **Add new version** (oder das Gegenstück), lade die neue APK hoch, aktualisiere die Release-Notizen und reiche sie ein. Der Appstore aktualisiert dann die installierten Fernseher.

## Checkliste für das Gerät

Geh das auf einem Fire TV Stick 4K oder Lite und auf einem Fire TV Cube durch, bevor du Freunden Bescheid sagst:

1. APK installieren (später auch den Appstore-Build). Die App erscheint mit ihrem Banner in der App-Liste.
2. Erster Start: Adresse eingeben, *… wird geöffnet* sehen, auf dem Kopplungsbildschirm landen.
3. Mit dem QR-Code und mit dem getippten Code koppeln.
4. Fernbedienungstasten: Pfeile, Auswählen, Zurück (zuerst das Seitenmenü, ein zweites Zurück auf der Startseite beendet die App), Play/Pause, Vorspulen und Zurückspulen im Player.
   Mit Live-TV: ▲/▼ schalten um, OK blendet die Bedienleiste ein, gedrückt gehaltenes OK öffnet die *Senderliste*; auf einer Fernbedienung, die sie hat, auch CH+/CH−, Ziffern, Info und Guide.
5. Einen Titel abspielen, der direkt läuft, und einen, der umgewandelt wird. Springen, Ton und Untertitel wechseln.
6. Die Testzeile lesen; `screen=` sollte `1920x1080` sein.
7. **Konto → Server wechseln**, zurück auf denselben Server.
8. Einen Titel lange laufen und lange pausiert lassen: Der Bildschirmschoner darf während der Wiedergabe nicht starten.
9. Home drücken, während ein Titel läuft: Der Ton hört auf.

## Probleme lösen

- **„Der Server ist nicht erreichbar“.** Prüfe die Adresse und ob das Fire TV Internet hat. Öffne dieselbe Adresse in einem Browser auf deinem Handy.
- **Zertifikatsmeldung.** Der Server braucht ein Zertifikat einer öffentlichen CA. Ein selbst signiertes Zertifikat funktioniert in der App nicht.
- **„Zu alt“-Meldungen.** Aktualisiere das, was die Meldung nennt.
- **Schwarzer Bildschirm nach der Startseite.** Starte die Prüfung noch einmal, damit die Testzeile erscheint (Server wechseln auf dieselbe Adresse startet sie neu), und schick die Zeile an den Projektbetreiber. Oft läuft der umgewandelte Stream, auch wenn die Direktwiedergabe nicht klappt.
- **Der Bildschirmschoner startet während eines Titels.** Aktualisiere die App; sie hält den Bildschirm wach, solange ein Titel läuft. Passiert es trotzdem, schick die Testzeile und deine Fire-OS-Version.
- **Zurück tut nichts.** Aktualisiere die App; ältere Versionen haben die Zurück-Behandlung womöglich nicht.
- **Der Appstore bietet die App nicht an / die APK lässt sich nicht darüber installieren.** Siehe [Updates](#updates): Deinstalliere das eine, bevor du das andere installierst.

## Selbst bauen

Das Fire-TV-Modul liegt neben der Handy-App in `android/` und baut mit denselben Befehlen (JDK 21, Android SDK; siehe [android.md](android.md#selbst-bauen)):

```sh
cd android
./gradlew :firetv:lint :firetv:testDebugUnitTest :firetv:assembleDebug   # Debug-APK in firetv/build/outputs/apk/debug/
./gradlew :firetv:assembleRelease                                       # firetv/build/outputs/apk/release/firetv-release-unsigned.apk
bash firetv/check-apk.sh firetv/build/outputs/apk/release/firetv-release-unsigned.apk
```

Der Release-Build wird nur signiert, wenn die drei Signatur-Umgebungsvariablen der Handy-App gesetzt sind (`ANDROID_UPLOAD_KEYSTORE_FILE`, `ANDROID_UPLOAD_KEY_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`); die Datei heißt dann `firetv-release.apk`. `check-apk.sh` prüft Paketname, Leanback-Launcher, Banner, dass INTERNET die einzige Berechtigung ist und dass keine Google-Play-Dienste enthalten sind; ist alles in Ordnung, gibt es nichts aus. Die Store-Bilder werden aus den Vorlagen in `android/firetv/store-listing/src/` gerendert (`render.sh`). Die Version kommt aus `version.json` oben im Repository. minSdk ist 28 (Fire OS 7).
