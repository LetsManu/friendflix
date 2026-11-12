# Fernseher: TV-Modus + Handy als Fernbedienung

FriendFlix läuft auf jedem Fernseher mit modernem Browser (Android TV / Google TV, Fire TV, Samsung Tizen, LG webOS, Konsolen, Mini-PC am HDMI).
Der Fernseher bekommt eine eigene Oberfläche (große Schrift, Fokusrahmen, Steuerung mit Pfeiltasten) und wird vom Handy aus gesteuert.
Es wird **kein** Cast-/AirPlay-Protokoll benutzt: Das Portal selbst ist die Fernbedienung (WebSocket zwischen Handy und Fernseher desselben Nutzers).
Das ist auch die Lösung für Fernseher ohne AirPlay und ohne Chromecast; wer AirPlay oder Chromecast hat, kann alternativ direkt aus dem Player übertragen ([cast.md](cast.md)).

## Einrichten (einmalig pro Fernseher)
1. Auf dem Fernseher im Browser `https://portal.<domain>/tv` öffnen (als Lesezeichen/Startseite speichern). Es erscheinen ein **Code** (`ABCD-EFGH`) und ein QR-Code.
2. Auf dem Handy (eingeloggt): **Menü → Fernbedienung**, Code eingeben, **Koppeln** (oder QR-Code scannen – der Code ist dann schon eingetragen; bestätigt wird trotzdem von Hand).
3. Der Fernseher meldet sich selbst an und öffnet die Startseite im TV-Modus. Er bleibt 90 Tage angemeldet und erscheint unter **Geräte** als „Fernseher (TV-Modus)“.

Abmelden am Fernseher: Seitenmenü → **Konto** → **Abmelden** (danach wieder Kopplungs-Bildschirm) oder am Handy unter *Geräte* entfernen – das beendet die Sitzung **und** trennt die Verbindung sofort.

## Bedienung am Fernseher
| Taste | Aktion |
|---|---|
| Pfeiltasten | Fokus zur nächsten Kachel/Schaltfläche in dieser Richtung (Reihen gleiten mit); ◀ am linken Rand öffnet das Seitenmenü, ▶ schließt es |
| OK / Enter | öffnen / abspielen |
| Zurück (Back, Esc, Backspace) | eine Ebene zurück; der Fokus springt wieder auf die Kachel, die du verlassen hast. Auf den Seiten des Seitenmenüs (Startseite, Serien, Filme, Meine Liste, Suche) öffnet Zurück zuerst das Seitenmenü |
| Im Player | OK = Pause/Play · jede Pfeiltaste blendet die Steuerung mit fokussierter Fortschrittsleiste ein · ←/→ auf der Leiste = Sprung-Vorschau (OK oder 1 s ohne Taste springt hin, Zurück bricht ab) · ↓ = Knopfreihe (Folgen, Nächste Folge, Audio & Untertitel, Tempo, Qualität) · Zurück schließt Menü → Vorschau → Leiste → Player |
| Medientasten | Play/Pause, ±30 s (Vor/Zurück-Spulen), nächste Folge |

### LG-App (webOS)
Die [LG-TV-App](webos.md) versteht im Player zusätzlich diese Tasten (außerhalb des Players werden sie ignoriert):

| Taste (Code) | Aktion |
|---|---|
| Play (415) · Pause (19) · Play/Pause (10252) | abspielen · pausieren · umschalten |
| Stop (413) | Player verlassen (der Fortschritt wird gespeichert, wie bei Zurück) |
| Vorspulen (417) · Zurückspulen (412) | +30 s · −30 s |
| Rot (403) | Untertitel an/aus (zuletzt benutzte Spur, sonst die erste) |
| Grün (404) | Audio & Untertitel öffnen |
| Blau (406) | X-Ray (Besetzung und Musik der Szene) |
| Zurück (461) | überall eine Ebene zurück; **auf der Startseite des TV-Modus öffnet es zuerst das Seitenmenü, ein zweites Zurück beendet die App** |

Der Zeiger der Magic Remote bewegt den Fokus: Fährst du über eine Kachel, springt der Fokusrahmen dorthin, die Pfeiltasten machen von da aus weiter. Im Seitenmenü unter **Konto** gibt es **Server wechseln**; beim Start öffnet die blaue Taste, solange das Logo zu sehen ist, das Adressformular.

### Live-TV am Fernseher
Mit eingeschaltetem [Live-TV](de/livetv.md) läuft alles mit **▲/▼, OK und Zurück**; die übrigen Tasten sind Abkürzungen, die nur wirken, wenn deine Fernbedienung sie sendet. In der Senderliste ist ▲/▼ eine Zeile weiter; im Player schaltet ▲/▼ den Sender um, solange die Steuerung ausgeblendet ist.

| Taste | Im Player | In der Senderliste |
|---|---|---|
| ▲ / ▼ | Sender hoch / runter (Steuerung ausgeblendet) | Zeile hoch / runter (gedrückt halten wiederholt) |
| OK | zeigt Steuerung und Sender-Banner, Fokus auf Play/Pause (OK, OK pausiert); OK pausiert nie bei ausgeblendeter Steuerung | schaut den Sender |
| Lang OK (ab 0,6 s) | öffnet die *Senderliste* | schaltet den Favoriten um |
| ▶ auf einer Zeile | – | Fokus auf den Stern; OK schaltet den Favoriten um, ◀ zurück zur Zeile |
| Kanal ▲/▼ (CH) | Sender hoch / runter | springt 8 Zeilen |
| Ziffern, dann OK | wechselt zu dieser Sendernummer (2 s ohne Eingabe genügen) | fokussiert die Zeile dieses Senders |
| eine einzelne 0 | letzter Sender | fokussiert den zuletzt gesehenen Sender |
| Info | Programm-Info des Senders | Programm-Info des fokussierten Senders |
| Senderliste / Guide (nur Samsung) | öffnet die *Senderliste* | – |
| Zurück | schließt zuerst Fenster, dann die Steuerung, dann den Player | zurück zur Startseite |

Die Hinweiszeile unter der Liste nennt nur Tasten, die dieser Fernseher wirklich gesendet hat: "CH ▲▼: 8 Zeilen" erscheint erst nach einer Kanal-Taste, "0: letzter Sender" erst nach einer Ziffer.

- **Samsung (Tizen):** Die App meldet beim Öffnen von Live-TV `ChannelUp`, `ChannelDown`, `PreviousChannel` (letzter Sender), `Info`, `0`–`9`, Rot und Blau an; `ChannelList` und `Guide` nur, wenn der Fernseher sie unterstützt. Siehe [tizen.md](tizen.md#live-tv-keys).
- **LG (webOS):** Die Kanal-Tasten (CH +/−) sind für Web-Apps **nicht verlässlich verfügbar (unverified)**; darauf verlässt sich nichts, ▲/▼ schaltet um. Sendet ein Fernseher sie doch als Bild-auf / Bild-ab (Code 33/34), wirken sie wie Kanal-Tasten. Ziffern kommen direkt, **Rot** = letzter Sender, **Blau** = zurück zu *Live*, **Info** (Code 457) = Programm-Info. Siehe [webos.md](webos.md#live-tv-keys).
### Fire-TV-App
Die [Fire-TV-App](firetv.md) gibt diese Tasten an den TV-Modus weiter:

| Taste | Aktion |
|---|---|
| Zurück | überall eine Ebene zurück; **auf der Startseite des TV-Modus öffnet es zuerst das Seitenmenü, ein zweites Zurück beendet die App**; in einem Textfeld verlässt es nur das Feld |
| Play/Pause | abspielen / pausieren |
| Play · Pause | abspielen · pausieren |
| Vorspulen · Zurückspulen | +30 s · −30 s |
| Weiter | nächste Folge, wo es eine gibt |

Im Seitenmenü unter **Konto** gibt es **Server wechseln**.

Startet der Browser die Wiedergabe ohne vorherigen Tastendruck (z. B. wenn das Handy etwas schickt), beginnt sie **stumm** mit Hinweis; die erste Taste schaltet den Ton ein.

## Fernbedienung am Handy
- **Menü → Fernbedienung**: Status (Titel, Position), Play/Pause, ±10 s, ±60 s, Beenden, Startseite, *Weiter schauen* und Titelsuche mit **Auf TV**.
- Auf jeder Detailseite erscheint **Auf Fernseher**, sobald ein Fernseher verbunden ist.
- Es wird immer der Fernseher **desselben Nutzers** gesteuert (nie der anderer Freunde). Pro Nutzer ist ein Fernseher aktiv; ein zweiter ersetzt den ersten.

## Hier weiterschauen (Karte auf der Startseite)
Hast du zuletzt auf einem anderen Gerät geschaut (innerhalb von 6 Stunden, Titel nicht zu Ende), zeigt die Startseite eine Karte „Zuletzt auf Wohnzimmer · vor 12 Min.“ mit **Hier weiterschauen ab 23:10** und **Ausblenden**. Am Fernseher steuerst du sie so:
- Die Karte sitzt als **feste Fläche** (ohne Unschärfe) rechts oben in der großen Kachel und ist nur da, solange der Fokus in der Kachel ist.
- Sie nimmt den Fokus nur, wenn die Antwort **innerhalb von 2 Sekunden** nach dem Öffnen kommt und **noch keine Taste** gedrückt wurde, und **nie** nach Zurück oder Vor (Seite wiederhergestellt). Dann setzt OK sofort fort.
- Sonst bleibt der Fokus, wo er ist: **↑** von den Knöpfen der Kachel erreicht die Karte, **↓** oder **Zurück** bringt dich zurück auf die Kachel (ohne die Karte auszublenden). **→** geht auf *Ausblenden*; danach liegt der Fokus wieder auf der Kachel.
- Eine **späte Antwort** nimmt nie den Fokus und schiebt keine Reihe: Die Karte liegt über der Kachel.
- Startest du von der Karte aus und drückst im Player **Zurück**, landet der Fokus auf **Abspielen** der Kachel.
- Ob die Fernbedienung ihre Zurück-Taste an die Seite weitergibt, hängt vom Fernseher ab; siehe die Prüfliste des Betreibers im Pull Request.

## Vorschau im Browser
`https://portal.<domain>/?tv=1` zeigt den TV-Modus auf jedem Rechner (nur Optik und Tastatursteuerung, keine Kopplung; `?tv=0` beendet die Vorschau).

## Sicherheit
- Der Code ist 8 Zeichen aus einem 32er-Alphabet (ohne 0/O/1/I), 10 Minuten gültig, einmal verwendbar, nur gehasht mit einem geheimen Abruf-Token des Fernsehers verknüpft; `/api/tv/code` und `/api/tv/pair` sind rate-limitiert.
- Koppeln kann nur ein **eingeloggter** Nutzer (CSRF-Token wie überall). `/api/tv/code` und `/api/tv/claim` sind anonym und deshalb vom CSRF-Check ausgenommen: Sie haben keine Berechtigung außer dem geheimen Token.
- **Phishing-Schutz:** Wer dir einen Code/QR schickt, könnte einen *fremden* Fernseher an dein Konto koppeln wollen. Die Seite warnt davor; außerdem bekommst du bei jeder Kopplung eine Benachrichtigung „Ein Fernseher wurde mit deinem Konto verbunden“ (Link zu *Geräte*) und einen Audit-Log-Eintrag (`tv.pair`, `tv.claim`).
- Die WebSocket-Verbindung (`/ws/remote`) prüft Origin und Session, akzeptiert vom Handy nur eine feste Liste von Befehlen (`cast`, `play`, `pause`, `toggle`, `seekBy`, `stop`, `home`) und vom Fernseher nur Statusmeldungen; mit Flood-Limit.
- Gerät entfernen, „Überall abmelden“ oder Nutzer sperren beendet Fernseher-Sitzung und -Verbindung sofort.

## Technik / Grenzen
- Der Fernseher spielt wie jeder andere Client über das Gateway (Direct Play oder HLS via hls.js); es läuft nichts am Gateway vorbei.
- Getestet mit Chromium (automatisiert, inkl. Autoplay-Sperre und Fokus-Navigation). Auf echten Fernsehern bitte ausprobieren: Back-Tasten sind für Tizen (10009), webOS (461), Android/Fire TV (4) vorbereitet; ältere Fernseher-Browser ohne Media Source Extensions können nicht abspielen.
- Watch-Party ist am Fernseher nicht vorgesehen (Chat braucht eine Tastatur).
- NPM braucht für `/ws/` „Websockets Support“ (siehe `deploy/npm/portal.advanced.conf`), sonst bleibt die Fernbedienung offline.

## Fehlersuche
| Symptom | Ursache |
|---|---|
| Handy zeigt „Kein Fernseher verbunden“, TV läuft | WebSocket kommt nicht durch NPM (Websockets Support, `Origin`), oder `PUBLIC_URL` stimmt nicht mit der aufgerufenen Adresse überein |
| „Code unbekannt oder abgelaufen“ | Code älter als 10 Minuten; am Fernseher erscheint automatisch ein neuer |
| Fernseher springt nach Tagen auf den Kopplungs-Bildschirm | Sitzung abgelaufen (7 Tage ungenutzt) oder Gerät unter *Geräte* entfernt |
| Bild, aber kein Ton | Autoplay-Sperre: eine Taste drücken |
