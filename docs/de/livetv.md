<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Live-TV

Live-TV ist optional. Es läuft als eigener Container `livetv` im Compose-Profil `livetv`: Solange du es nicht einschaltest,
wird nichts geladen oder gestartet und FriendFlix sieht aus wie vorher. Diese Seite behandelt den Container selbst
(Einschalten, GPU, Ports) und die Funktionen: [Quellen](#quellen), [Rechte](#rechte), [Ansehen](#ansehen), [Casting](#casting),
[Gesendete Streams](#gesendete-streams-srt) und [Fehlersuche](#fehlersuche). *English: [../livetv.md](../livetv.md)*

## Einschalten

- **Über den Updater (Standard-Stack):** *Admin → Live-TV* → aktivieren. Der Updater lädt das signierte Image und startet es.
- **Von Hand:** `COMPOSE_PROFILES=livetv` in die `.env` schreiben und `docker compose -f compose.prod.yaml up -d` ausführen
  (oder `docker compose -f compose.prod.yaml --profile livetv up -d`). Vorher prüfen: `docker compose -f compose.prod.yaml --profile livetv config -q`.
- **Portainer-Stack:** Der Updater ändert keinen Stack, den Portainer verwaltet, daher kann der Schalter Live-TV dort nicht
  einschalten. In Portainer den Stack öffnen, die Umgebungsvariable `COMPOSE_PROFILES` = `livetv` anlegen und *Update the stack*
  mit *Re-pull image* ausführen. Erscheint kein Container `livetv` (manche Portainer-Versionen geben `COMPOSE_PROFILES` nicht an
  Compose weiter), im Stack-Editor beim Dienst `livetv` die Zeile `profiles: [livetv]` löschen und erneut aktualisieren. Zum
  Ausschalten die Variable wieder entfernen (oder die Zeile zurücksetzen) und den Stack aktualisieren.

**Bei einer Installation von vor Live-TV** einmal in dieser Reihenfolge (die Seite nennt den Schritt, der fehlt):

1. *Admin → Update → Updater aktualisieren* (ein älterer Updater kennt Live-TV nicht: „Erst den Updater aktualisieren“).
2. `compose.prod.yaml` im Stack-Ordner durch die aus dem aktuellen Release ersetzen und einmal
   `docker compose -f compose.prod.yaml up -d` ausführen. Damit hängen Backend und Gateway im internen Netz `livetv`, und der
   Dienst `bootstrap` schreibt den Schlüssel von livetv (fehlt das: „Deine compose.prod.yaml stammt von vor Live-TV“ oder
   „Backend und Gateway hängen noch nicht im Netz livetv“). Ein Update über den Updater dazwischen ist kein Problem: Es erstellt
   Backend und Gateway im neuen Netz neu.
3. *Admin → Live-TV* → aktivieren.

Der Dienst hat keinen Docker-Socket, ein schreibgeschütztes Root-Dateisystem und keine Capabilities; Backend und Gateway
erreichen ihn im internen Netz `livetv` unter `LIVETV_URL` (Standard `http://livetv:8090`, braucht keine Einstellung). Details (englisch): [security.md](../security.md#the-livetv-container).
Der Updater behält die Overlay-Dateien, mit denen du den Stack gestartet hast; ein Overlay in `COMPOSE_FILE` bleibt bei Updates erhalten.

**Reverse Proxy:** Das Token steht in jeder Stream-Adresse (`/media/l/<token>/…`). Den Block `location /media/l/` aus
`deploy/npm/portal.advanced.conf` im Proxy Host des Portals ergänzen (er schaltet Access- und Error-Log für diese Pfade ab, wie bei
`/media/c/`), und nie eine `/media/l/…`-Adresse in ein Issue oder einen Chat kopieren.

## GPU

Ohne Overlay kodiert livetv in Software (libx264). Für Hardware-Kodierung ein Overlay hinzufügen.

**Intel / AMD (QSV, VA-API):** `compose.livetv-gpu.yaml` reicht `/dev/dri` durch und fügt die Render-Gruppe hinzu. Ihre ID herausfinden und setzen:

```bash
getent group render | cut -d: -f3        # z. B. 109 -> RENDER_GID=109 in der .env
docker compose -f compose.prod.yaml -f compose.livetv-gpu.yaml --profile livetv up -d
# oder: COMPOSE_FILE=compose.prod.yaml:compose.livetv-gpu.yaml in der .env
```

Mit dem GPU-Overlay in `COMPOSE_FILE` braucht jeder Compose-Befehl ein gesetztes `RENDER_GID`, auch bei ausgeschaltetem Profil. Ohne bricht Compose mit *set RENDER_GID* ab. **NVIDIA (NVENC):** NVIDIA Container Toolkit auf dem Host
installieren, dann `-f compose.livetv-nvidia.yaml` hinzufügen (reserviert eine GPU mit den Fähigkeiten `gpu` und `video`).

## Ports

livetv veröffentlicht **nur UDP**: den Bereich `LIVETV_SRT_PORTS` (Standard `9000-9009`, 1–100 Ports) für SRT-Feeds, die du
hineinschickst, auf der Host-Adresse `LIVETV_SRT_BIND`. Der Standard `127.0.0.1` lässt Push von außen aus. `LIVETV_SRT_BIND=0.0.0.0`
(oder die LAN-Adresse des Servers) **nur dann** in die `.env` schreiben, **wenn du Feeds hineinschickst**. Docker veröffentlicht Ports
auf den meisten Hosts an ufw und firewalld vorbei; eine Firewall-Regel allein schließt den Bereich also nicht, `LIVETV_SRT_BIND` schon.
Listen und Streams abzurufen braucht keinen eingehenden Port. Die API (Port 8090) wird nie veröffentlicht. Anderer Bereich: `LIVETV_SRT_PORTS=9100-9104` in der `.env`.

**Wo die Live-TV-Einstellungen stehen.** `LIVETV_ENCODER`, `LIVETV_SRT_HOST`, `LIVETV_DVR_MINUTES` und `LIVETV_MAX_BITRATE` stellst du unter *Admin → Live-TV → Einstellungen* ein (derselbe Einstellungsspeicher wie bisher; *Admin → Einstellungen* verweist nur noch dorthin, solange Live-TV installiert ist). Der Tab zeigt auch die SRT-Ports, nur lesbar; Ports und Freigabe (`LIVETV_SRT_PORTS`, `LIVETV_SRT_BIND`) stehen weiterhin in der Compose-Datei, in Portainer als Umgebungsvariablen des Stacks.

Weitere Einstellungen: `LIVETV_CACHE_MAX_GB` (Standard 6, der wegwerfbare Segment-Cache), `LIVETV_URL` (nur wenn du den Dienst verlegst), `RECORDINGS_PATH` (Host-Ordner für Aufnahmen, Phase 3; Standard das benannte Volume `recordings`; absoluter Pfad, beschreibbar für uid 10001).

## Quellen

*Admin → Live-TV → Quellen.* Eine Quelle ist entweder eine Anbieterliste (*Anbieterliste*: eine M3U-Adresse, optional mit einer XMLTV-Adresse für den Programmführer) oder deine eigenen Streams (*Eigene Streams*, beim ersten Gebrauch angelegt). Adressen und Passwörter des Anbieters werden verschlüsselt gespeichert und nie wieder angezeigt; beim Bearbeiten bleibt das Feld leer („unverändert lassen“).

*Quelle hinzufügen* fragt Name, M3U-Adresse (zum Beispiel `https://iptv.example.com/list.m3u`), optional XMLTV-Adresse, User-Agent (erweitert), *Heimnetz erlauben* (nur dann darf die Adresse in einem privaten Bereich wie 192.0.2.x liegen; Loopback und Link-Local gehen nie), das Aktualisierungs-Intervall, optional *Max. gleichzeitige Sender* und die **Import**-Optionen:

- **Nummern:** *Aus der Liste (tvg-chno)* (Standard) oder *Nach Reihenfolge ab* einer Nummer deiner Wahl (1 bis 99 999). Nummern, die du unter *Kanäle* selbst setzt, bleiben erhalten.
- **Senderlogos:** *Aus der Senderliste zuerst* (Standard) oder *Aus dem Programmführer zuerst*. Ein selbst hochgeladenes Logo gilt immer.
- **Programm-Zeit verschieben:** verschiebt die Programmzeiten der Quelle um −12 bis +14 Stunden in Schritten von 0,5 (Standard 0), für Programmführer, die um Stunden danebenliegen. Ein `tvg-shift` aus der Liste und ein Wert an einem einzelnen Sender (Zeilenmenü *Programm-Zeit verschieben…*) gehen vor.
- **Max. gleichzeitige Sender** ist für Anbieter, die nur eine oder zwei Verbindungen erlauben: FriendFlix lehnt einen Start dann früh ab, mit der Liste der schon laufenden Sender, statt den zusätzlichen scheitern zu lassen (siehe [Freigabe beim Umschalten](#freigabe-beim-umschalten)).

**Prüfen und die Gruppenauswahl.** *Prüfen* lädt die Liste über `livetv` und zeigt vor dem Speichern, wie viele Sender und Gruppen sie enthält, wie viele ein Programm haben, und fünf Beispielnamen. Darunter listet das Blatt die Gruppen des Anbieters („18 Gruppen gefunden – welche übernehmen?“) mit ihrer Senderzahl, beim ersten Mal alle angehakt; ab 12 Gruppen gibt es ein Suchfeld, *Alle* / *Keine* haken alles oder nichts an, und ein Zähler sagt, wie viele Sender die Auswahl behält. Abgewählte Gruppen stehen in `skip_groups` und werden nie importiert. Sender einer Gruppe, die du später abwählst, gelten als *fehlend* (sofort ausgeblendet, nach 30 Tagen gelöscht, mit ihren Einstellungen zurück, wenn du die Gruppe wieder anhakst). Die Quellenkarte zeigt „Ohne 6 Gruppen · Auswahl ändern“.

Gruppen, die erst bei einer späteren Aktualisierung beim Anbieter auftauchen, werden **importiert, aber nicht freigegeben**: Niemand sieht sie, bis du sie freigibst (siehe [Rechte](#rechte)). Die Daten des Anbieters werden mit harten Grenzen gelesen (Liste ≤ 50 MB, höchstens 20 000 Live-Einträge je Quelle, Film- und Serien-Einträge übersprungen); Einzelheiten in [security.md](../security.md#the-livetv-container).

**Zuordnung zum Programmführer.** Sender werden automatisch dem XMLTV-Programm zugeordnet, in vier exakten Schritten, erst innerhalb der eigenen Quelle, dann quellenübergreifend: `tvg-id` = XMLTV-Kanal-ID; `tvg-name` = ein Anzeigename; der Sendername = ein Anzeigename; der normalisierte Name (Groß-/Kleinschreibung, Akzente, Satzzeichen und ein angehängtes HD/FHD/UHD/4K bleiben unberücksichtigt). Ein Schritt mit genau einem Treffer gewinnt, ein Schritt ohne oder mit mehreren Treffern gibt an den nächsten weiter, und nach Ähnlichkeit wird nie von selbst zugeordnet. Der Programm-Reiter zeigt, wie viele Sender ein Programm haben.

### Programmführer

Der Programmführer eines Anbieters deckt oft nur einen Teil seiner Sender ab (zum Beispiel deutsche und österreichische). Damit auch die anderen ein Programm bekommen, fügst du einen zusätzlichen Programmführer hinzu: *Quelle hinzufügen* → *Programmführer*, mit Name, der XMLTV-Adresse des Programmführers (`http`/`https`, optional `.gz`, zum Beispiel `https://iptv.example.com/guide.xml.gz`; verschlüsselt gespeichert wie Listen-Adressen), dem Aktualisierungs-Intervall, optional einem Zeitversatz und **Gilt für**: *Alle Sender* oder *Nur diese Quellen* mit mindestens einer angehakten Anbieterliste oder *Eigene Streams*. *Prüfen* zeigt, wie viele Sender der Programmführer kennt, und einige ihrer Namen. Ein Programmführer hat keine eigenen Sender; seine Karte zeigt, wofür er gilt, seinen letzten Import und wie viele Sender er gerade versorgt.

Statt einer Adresse kann ein Programmführer auch eine **Datei** sein (*Datei*): eine XMLTV-Datei (`.xml` oder gzip-komprimiert `.xml.gz`) bis 300 MB, die du von deinem Rechner hochlädst, für Programmführer, die nicht online oder nur hinter einer Anmeldung liegen. Die Datei liegt im Datenvolume des Backends (`previews`, Ordner `livetv-guides`), wird nie angezeigt oder wieder ausgeliefert und nur von `livetv` gelesen (das Backend liest kein XML). Ein Upload wird sofort importiert; erst wenn dieser Import klappt, ersetzt die neue Datei die alte; eine kaputte Datei lässt die alte Datei, ihr Programm und ihre Senderliste stehen, und die Karte zeigt den Fehler. Ein Datei-Programmführer wird nie nach Zeitplan aktualisiert: *Jetzt aktualisieren* importiert die gespeicherte Datei erneut, ebenso der Aktualisierungs-Job einmal, nachdem du *Gilt für* geändert oder ihn wieder eingeschaltet hast. Für neueres Programm lädst du eine neue Datei hoch (das Programm einer Datei endet mit ihrem letzten Tag; der Import nimmt bis zu 8 Tage im Voraus). Läuft schon ein Upload oder Import des Programmführers, wird ein zweiter abgelehnt. Wird der Programmführer gelöscht, wird seine Datei mitgelöscht. Hinter einem eigenen Reverse Proxy braucht der Upload-Pfad `/api/admin/livetv/sources/<id>/file` ein Body-Limit von 300 MB (die mitgelieferte `deploy/npm/portal.advanced.conf` hat dafür eine eigene Location; `/api/` selbst bleibt bei 1 MB).

Zusätzliche Programmführer **füllen nur auf**: Die vier Zuordnungsschritte oben laufen zuerst über die Programmführer der Anbieterlisten, genau wie ohne zusätzliche Programmführer, und ein Programmführer wird nur für einen Sender gefragt, der danach noch kein Programm hat, und nur, wenn die Quelle des Senders unter *Gilt für* steht. Ein neuer Programmführer nimmt also nie einem Sender sein Programm weg. Kennen mehrere Programmführer so einen Sender, gewinnt der weiter oben stehende (mit den Pfeilen änderst du die Reihenfolge). Ein ausgeschalteter Programmführer wird nicht aktualisiert und liefert kein Programm. Wird eine Quelle gelöscht, verschwindet sie aus jedem *Gilt für*; ein Programmführer ohne Quelle wird ausgeschaltet („Gilt für keine Quelle mehr“).

**Pro Sender** (*Kanäle*): umbenennen, in eine andere Gruppe legen, umnummerieren, ausblenden, per Ziehen neu ordnen (*Reihenfolge*), ein Logo hochladen (PNG, JPEG oder WebP bis 512 KB) und *Testen*. Das Testblatt zeigt, was `livetv` gefunden hat (Codec, Größe, ob der Stream durchgereicht, umverpackt oder umgewandelt wird) und spielt, wenn der Sender gerade starten kann, eine stumme 10-Sekunden-Vorschau (ohne freien Umwandlungsplatz oder beim Limit des Anbieters gibt es nur die Fakten), danach beendet es das Ansehen wieder. Die Vorschau zählt als eine deiner Live-Ansichten (höchstens 4 pro Konto) und kann deine älteste echte Ansicht beenden, wenn du schon vier hast. Die Vorschau geht auch für Sender noch nicht freigegebener Gruppen, du kannst neue Sender also prüfen, bevor sie jemand sieht.

## Rechte

Wer welche Sender sieht, bestimmt sich pro Gruppe (*Admin → Live-TV → Gruppen & Rechte*), zusätzlich zum Konto-Recht *Live-TV* in der Rollenmatrix.

- Eine Person sieht einen Sender, wenn ihr Konto Live-TV nutzen darf, die Gruppe des Senders **freigegeben** und für sie erlaubt ist (über die Rolle oder eine Ausnahme im Reiter *Rechte* der Person), der Sender nicht ausgeblendet oder *fehlend* ist und seine Quelle eingeschaltet ist. Admins sehen jede freigegebene Gruppe.
- **Kinderprofile** sehen nur Gruppen mit *Kinderfreundlich*. Gibt es keine, haben sie keinen Live-TV-Reiter.
- **Neue Gruppen freigeben.** Eine Gruppe, die ein Import anlegt, startet als *Nicht freigegeben*: ganz oben gelistet, „Für niemanden sichtbar“, keiner Rolle zugewiesen und nicht kinderfreundlich. Ihre Sender sind importiert, damit du sie testen und sortieren kannst. *Freigeben…* (Zeilenmenü, oder die Sammelleiste für mehrere Gruppen) fragt, welche Rollen sie bekommen und ob sie *Kinderfreundlich* ist (nichts ist vorausgewählt). *Freigabe zurücknehmen* blendet sie wieder für alle aus und behält die Rollen. Gruppen, die du selbst anlegst, starten freigegeben. Eine Gruppe des Anbieters, die auf eine bestehende Gruppe abgebildet wird (gleicher Name oder früher zugeordnet), übernimmt deren Zustand.
- *Sicht prüfen* bei einer Person zeigt ihre Gruppen und die Senderzahl samt Grund für jede fehlende Gruppe.
- Favoriten und *Zuletzt gesehen* gelten pro Profil. Ein Sender, den ein Profil nicht mehr sehen darf, verschwindet daraus (er wird nicht gelöscht und kommt mit dem Recht zurück).

## Ansehen

Live-TV ist der Menüpunkt *Live-TV* (Handy: *Live* in der Tab-Leiste), nur sichtbar, solange Live-TV eingeschaltet ist und das Konto es nutzen darf.

- **Die Liste.** *Läuft gerade bei dir* (deine Favoriten in deiner Reihenfolge, mit *Ordnen*), Gruppen-Chips (*Alle*, *Favoriten*, *Zuletzt gesehen*, dann die Gruppen) und die Sender mit *Jetzt* und *Danach* aus dem Programmführer. Ohne Programm steht in der Zeile „Live“ und „Kein Programm verfügbar“.
- **Zuletzt gesehen** listet die letzten 10 Sender, die du geöffnet hast, den neuesten zuerst ([privacy.md](privacy.md#live-tv)).
- **Zurückspulen.** Ein laufender Sender hält seine letzten Minuten auf dem Server, damit du pausieren, zurückgehen und darin wieder vorspringen kannst; die LIVE-Anzeige führt zurück zur Live-Kante. Die Länge ist die Einstellung `LIVETV_DVR_MINUTES` (*Admin → Live-TV → Einstellungen*): **0 bis 120 Minuten, Standard 30**. Der Puffer liegt im Volume `livetv-cache`, begrenzt durch `LIVETV_CACHE_MAX_GB` (Standard 6). 120 Minuten eines Senders mit 6 Mbit/s brauchen etwa 5,4 GB, mit dem Standardwert verkürzen sich zwei Sender mit langem Puffer also schon gegenseitig: Ist der Cache voll, gehen zuerst die ältesten Segmente des Senders mit dem längsten Puffer, die Live-Kante bleibt unberührt. Der Cache ist wegwerfbar; ihn zu löschen kostet nur den Puffer. Eine Pause, die länger dauert als der Puffer, setzt am ältesten gespeicherten Punkt fort, mit einem Hinweis.
- **Von Anfang an** startet die laufende Sendung neu. Die Schaltfläche erscheint nur, solange der Beginn der Sendung im Puffer liegt (sie funktioniert also auch für jemanden, der zu einem schon laufenden Sender dazukam: der Puffer wird geteilt). Sie braucht ein Programm und einen Puffer über 0 und springt 30 Sekunden vor den Beginn.
- **Senderliste.** Ein Panel über dem Player mit denselben Filtern und Zeilen wie die Liste, geöffnet auf dem laufenden Sender. Auf dem Handy ist es eine Schaltfläche im Info-Blatt.
- **Restzeit** („noch 23 Min.“) steht neben dem Titel und auf den Kacheln von *Läuft gerade bei dir*. Bei jedem Senderwechsel zeigt ein Info-Banner Logo, Nummer, Name, *Jetzt* und *Danach*.
- **Fernbedienung.** Alles geht mit ▲/▼, OK und Zurück. ▲/▼ schalten den Sender um, solange die Bedienelemente verborgen sind; OK zeigt die Bedienelemente (Fokus auf Wiedergabe/Pause), darin *Von Anfang an*, −30 s / +30 s, LIVE, Sender ▲/▼, *Programm* und *Senderliste*; Zurück schließt ein Panel, dann blendet es die Bedienelemente aus, dann verlässt es den Player. Langes OK (etwa 0,6 s) öffnet die *Senderliste*, Ziffern tippen eine Sendernummer, eine einzelne 0 springt zum vorigen Sender. Das sind Abkürzungen, die nur wirken, wenn die Fernbedienung die Taste sendet (CH+/CH−, Info, Farbtasten); auf LG webOS verlässt sich nichts auf die CH-Tasten. Pro Plattform: [tv-mode.md](../tv-mode.md#live-tv-am-fernseher), [tizen.md](tizen.md), [webos.md](webos.md), [firetv.md](firetv.md). Am Rechner: ↑/↓ oder Bild auf/ab schalten um, Leertaste oder K pausieren, ←/→ ±10 s, J/L ±30 s, Ende = live, I = Info, Q = voriger Sender.
- **Geteilte Streams.** Alle Zuschauer eines Senders sehen denselben Stream; einem laufenden Sender beizutreten kostet nichts. Ein Sender stoppt 60 Sekunden nach dem Weggang des letzten Zuschauers, ein Zurückschalten innerhalb einer Minute ist also sofort da.
- **Grenzen.** Eine Live-Ansicht zählt wie ein Film gegen die Höchstzahl der Streams des Kontos. Ein Sender, der einen Umwandlungsplatz braucht (HEVC- oder MPEG-2-Quellen; H.264 wird durchgereicht oder umverpackt und kostet keinen Platz), kann mit „Gerade sind alle Live-Plätze belegt“ und einer Liste schon laufender Sender abgelehnt werden, die sofort starten. Das Budget steht in [operations.md](../operations.md#umwandlungen-ein-gemeinsames-limit).

### Freigabe beim Umschalten

Manche Anbieter erlauben nur eine Verbindung pro Konto. Schaltest du von Sender A auf B und der Start von B würde abgelehnt, beendet FriendFlix A **sofort** (statt nach den üblichen 60 Sekunden), wenn alles Folgende zutrifft: Du warst der einzige Zuschauer von A (Casts und Admin-Testvorschauen zählen als Zuschauer) und keine Aufnahme nutzt A; B läuft noch nicht; und B würde nur deshalb abgelehnt, weil die Quelle von B bei *Max. gleichzeitige Sender* steht und A zur selben Quelle gehört, oder weil A einen Umwandlungsplatz hält, den B braucht. Sonst läuft A noch 60 Sekunden weiter. Jede Freigabe ist ein Ereignis in *Live-Status*. Ein Senderwechsel auf einem Chromecast gibt den alten Sender nicht vorzeitig frei: Ein Cast zählt als eigene Ansicht, bei einem Anbieter mit einer Verbindung wird der Wechsel also abgelehnt und A läuft noch 60 Sekunden weiter.

## Casting

Chromecast und AirPlay spielen einen Live-Sender wie einen Film. Leiste und Fernbedienungsansicht von Chromecast zeigen eine Live-Variante: keine Zeitleiste, die LIVE-Anzeige, Sender ▲/▼ und die Jetzt/Danach-Zeile; das Logo erreicht den Fernseher über ein kurzlebiges Bild-Token, weil der Empfänger keine Cookies sendet. Ein Chromecast-Live-Cast läuft weiter, wenn der Tab schließt, und wird wieder aufgegriffen, wenn du FriendFlix öffnest. AirPlay (Safari) bekommt die Stream-Adresse direkt und endet mit dem Tab. Die Android-App castet über ihre Brücke. Jeder Cast hat sein eigenes Token (an eine Adresse gebunden, bei AirPlay an zwei) und zählt als Live-Ansicht. Hintergrund: [cast.md](../cast.md), [cast-receiver.md](cast-receiver.md).

## Gesendete Streams (SRT)

*Eigene Streams* gibt es in zwei Arten: FriendFlix **holt** eine Adresse (HLS, MPEG-TS oder `srt://` im Caller-Modus), oder dein Encoder **sendet** per SRT an FriendFlix (*Encoder sendet an FriendFlix*, zum Beispiel ein Sender Nordlicht TV aus OBS). Senden braucht einen eingehenden Port pro Feed.

Unterstützte Formate beim Holen: HLS mit MPEG-TS-, fMP4- (CMAF) oder ADTS-Segmenten (`.aac` / `.mp3`, Radio; das erste Segment entscheidet, alles andere wird als MPEG-TS gelesen) und direkte Adressen nach ihrer Dateiendung: `.ts` und alles Unbekannte als MPEG-TS, `.aac`, `.mp3`, `.mp4`/`.m4a`/`.mov`, `.mkv`/`.webm` und `.flv`. Das Format wird nie aus den Daten des Streams erraten, eine direkte Adresse mit irreführender Endung schlägt daher fehl. Gesendete Feeds sind MPEG-TS.

- **Ports.** UDP `LIVETV_SRT_PORTS`, Standard **9000–9009**: ein Port pro Feed, also höchstens zehn gesendete Feeds (1 bis 100 Ports sind erlaubt). **Nur UDP, kein TCP.** `livetv` veröffentlicht den Bereich selbst; er läuft **nicht** über den Reverse Proxy, der nur HTTP kann. Der Bereich wird auf `LIVETV_SRT_BIND` veröffentlicht, standardmäßig `127.0.0.1`: Senden von außen geht erst, nachdem du `0.0.0.0` (oder die LAN-Adresse) setzt, **und** nur, wenn du gesendete Feeds nutzt; dann den Bereich auch im Router weiterleiten (Docker umgeht ufw und firewalld, eine Host-Firewall-Regel allein schließt ihn nicht). Ist der Bereich voll, sagt *Stream hinzufügen* das: `LIVETV_SRT_PORTS` in der `.env` vergrößern und `docker compose … up -d` ausführen. Ein Feed, dessen Port nach so einer Änderung nicht mehr im Bereich liegt, wird markiert und kann einen neuen Port bekommen.
- **Host im Hinweis.** Der Einrichtungshinweis nennt `LIVETV_SRT_HOST` (*Admin → Live-TV → Einstellungen*), standardmäßig den Host von `PUBLIC_URL`. Steht dieser Name hinter einem CDN, das kein UDP durchlässt (zum Beispiel ein Cloudflare-Eintrag mit oranger Wolke), dort einen nur-DNS-Namen oder die öffentliche IP eintragen.
- **Feed anlegen.** *Stream hinzufügen* → *Encoder sendet an FriendFlix* → Name, Nummer, Gruppe → *Anlegen*. Das Ergebnisblatt zeigt **einmalig**: Server, Port, Stream-ID (`ff-` plus 16 Zeichen), Passphrase und die vollständige SRT-Adresse, je mit Kopieren-Knopf. Die Passphrase kommt nie wieder; die Karte des Feeds behält nur den Port und die ersten Zeichen der Stream-ID. Verloren? *Zugangsdaten neu erzeugen*: die alten Daten gelten sofort nicht mehr, ein laufendes Senden wird getrennt, und der Encoder braucht die neuen Daten.
- **OBS / Encoder einrichten.** OBS: *Einstellungen → Stream → Dienst Benutzerdefiniert*, *Server* = die SRT-Adresse aus dem Blatt, Streamschlüssel leer lassen. Andere Encoder: Modus **Caller**, Verschlüsselung **AES-256** (`pbkeylen=32`), Latenz 200 ms, mit Stream-ID und Passphrase aus dem Blatt. Video H.264 mit Audio AAC erspart eine Umwandlung. Die Adresse hat diese Form (Platzhalter): `srt://friend.example.com:9000?streamid=ff-EXAMPLEEXAMPLE23&passphrase=<Passphrase>&pbkeylen=32&mode=caller&latency=200000`
- **Was eine Verbindung braucht.** Die richtige Stream-ID **und** Passphrase auf dem eigenen Port des Feeds; alles andere wird im Handshake abgelehnt. Pro Feed ein Sender: Ein zweiter Anrufer mit gültigen Zugangsdaten wird abgelehnt, solange der erste sendet. Eine Adresse, die innerhalb einer Minute 20-mal scheitert, wird zehn Minuten lang ignoriert. Ablehnungen erscheinen in *Live-Status* (höchstens ein Ereignis pro Feed und 10 Minuten, nie mit Zugangsdaten oder Adressen).
- **Live nur beim Senden.** Ohne Sender bleibt der Sender in der Liste mit „Gerade keine Übertragung“. Öffnest du ihn, wartet er und startet von selbst, sobald der Encoder beginnt (Prüfung alle 10 Sekunden). Sonst verhält sich ein gesendeter Sender wie jeder andere: Rechte, Puffer, Casting. Solange niemand zuschaut, braucht er keine CPU.

## Fehlersuche

*Admin → Live-TV → Live-Status* zeigt die laufenden Sender (Modus, Zuschauer, seit, Bitrate, Eingangszustand, *Stoppen* und *Neu starten*; *Stoppen* beendet den Sender für seine Zuschauer, die den Fehlerzustand sehen, ein neues Zuschauen wird 60 Sekunden lang abgelehnt), das Budget, den Cache-Verbrauch und die letzten 200 Ereignisse; gesendete Feeds haben eine eigene Tabelle (Zustand, Bitrate, Ablehnungen in der letzten Stunde).

| Was du siehst | Ursache und Abhilfe |
|---|---|
| Quelle „Nicht erreichbar“ oder „Zeitüberschreitung“ | Der Anbieter hat nicht rechtzeitig geantwortet (Liste 60 s, Programm 10 min). Adresse vom Server aus prüfen, dann *Jetzt aktualisieren*. Nach drei Fehlern in Folge werden die Admins benachrichtigt. |
| „Zugang abgelehnt (Benutzername oder Passwort?)“ | Der Anbieter antwortete 401/403: falsche Zugangsdaten in der Adresse oder das Abo ist abgelaufen. |
| „Liste zu groß (über 50 MB)“ oder „Keine gültige Senderliste“ | Die Adresse ist keine M3U-Liste mit Live-Sendern. Die Live-Liste deines Anbieters nehmen, keine Filmliste. |
| Die Liste ist auf unter 20 % geschrumpft | Gilt als Fehler des Anbieters: nichts wird als fehlend markiert, die alten Sender bleiben. |
| Sender sind gelistet, aber niemand sieht sie | Die Gruppe ist *Nicht freigegeben* (siehe [Rechte](#rechte)), oder das Profil ist ein Kinderprofil und die Gruppe nicht *Kinderfreundlich*. |
| Ein Sender hat kein Programm, oder die Zeiten stimmen nicht | XMLTV-Adresse der Quelle prüfen (die Zuordnung ist exakt, siehe [Quellen](#quellen)); bei Stunden Abweichung *Programm-Zeit verschieben*. |
| „Sender gerade nicht erreichbar“ | Der Eingang hing, oder der erste Start dauerte länger als 15 s. Der Player versucht es mit wachsenden Pausen erneut. Bei einem Anbieter mit nur einer Verbindung *Max. gleichzeitige Sender* setzen. *Live-Status* nennt *Eingang verloren* und *Eingang wieder da*. |
| „Gerade sind alle Live-Plätze belegt“ oder „Dein Anbieter erlaubt nur n Sender gleichzeitig“ | Das Umwandlungs-Budget oder das Limit der Quelle ist erreicht; das Blatt listet Sender, die sofort starten ([operations.md](../operations.md#umwandlungen-ein-gemeinsames-limit)). |
| Der Live-TV-Reiter ist weg | `livetv` ist aus oder nicht erreichbar; der Reiter kommt bei der nächsten Navigation zurück, sobald der Container antwortet. Nach einem Neustart von `livetv` holt ein laufender Player einmal von selbst ein neues Token. |
| Ein gesendeter Feed verbindet nie | UDP-Bereich in Firewall und Router nicht offen, der Host im Hinweis zeigt auf ein CDN, falsche Stream-ID oder Passphrase (Ereignis *Verbindung abgelehnt*), oder der Encoder ist nicht im Caller-Modus mit AES-256. TCP-Ports zu öffnen hilft nicht. |
| Wiedergabe ruckelt oder die CPU ist ausgelastet | Der Sender wird umgewandelt (HEVC- oder MPEG-2-Quelle). Ein GPU-Overlay hinzufügen (siehe [GPU](#gpu)). |

Logs: `docker compose -f compose.prod.yaml logs livetv`. Sie nennen Sender nur per ID und enthalten nie Adressen des Anbieters, Stream-Schlüssel, Token oder ffmpeg-Argumente.

## Image und reproduzierbare Builds (Ausnahme)

Das Image `livetv` wird wie die anderen gebaut, geprüft, mit SBOM versehen und per cosign signiert, mit Basis-Images per Digest,
ist aber **von der Prüfung `reproducible` ausgenommen** ([reproducible-builds.md](../reproducible-builds.md)). Seine Laufzeitstufe installiert
`jellyfin-ffmpeg7` per `apt` aus dem Jellyfin-Repository; dieses hält nur aktuelle Versionen (kein Snapshot-Archiv, also keine
Pin-Version, die baubar bleibt), und der apt/dpkg-Zustand ist nicht als bytegleich belegt, ein Neubau ergibt also nicht
zugesichert denselben Digest. `scripts/reproduce-image.sh livetv` lehnt deshalb mit einem Hinweis ab, und die Matrix des CI-Jobs
enthält es nicht. Signatur und SBOM des veröffentlichten Images belegen weiterhin die Herkunft; die Paketversionen stehen im SBOM.
Um die Ausnahme aufzuheben: das Jellyfin-`.deb` im Build festschreiben oder mitliefern und dann mit `scripts/reproduce-image.sh livetv` zwei identische Builds zeigen.
