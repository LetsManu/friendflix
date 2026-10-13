# Chromecast und AirPlay

Aus dem Player kann ein Film oder eine Folge per Chromecast (und Geräte mit eingebautem Chromecast, z. B. Google TV) auf den Fernseher gesendet werden. Verwendet wird der **Default Media Receiver** von Google: keine Registrierung, keine eigene Receiver-App, kein Google-Konto nötig.

## Voraussetzungen

- `PUBLIC_URL` beginnt mit `https://` und hat ein **öffentlich gültiges Zertifikat** (Let's Encrypt über NPM genügt). Der Chromecast lädt die Streams selbst von dieser Adresse; ein selbst signiertes Zertifikat oder eine reine LAN-Adresse funktioniert nicht.
- Der Chromecast erreicht `PUBLIC_URL` aus seinem Netz (bei Split-DNS muss der Name im Heimnetz auflösen).
- NPM: die Location `/media/c/` aus `deploy/npm/portal.advanced.conf` (mit `access_log off` **und** `error_log /dev/null`, denn auch nginx-Fehlerzeilen enthalten die Anfrage-URI, also das Token) ist eingetragen.
- Absender: Chrome, Edge oder ein anderer Chromium-Browser (Desktop und Android). Safari, Firefox und iOS-Browser bieten keine Cast-Taste (Apple erlaubt dort kein Google Cast); am iPhone, iPad und Mac gibt es stattdessen AirPlay (siehe unten).
- **Plan B** (nginx `auth_request`, `deploy/npm/plan-b-auth-request.conf`) unterstützt Cast nicht: dort ist `CAST_ENABLED=false` zu setzen.

`CAST_ENABLED=false` schaltet alles ab; die Cast-Taste erscheint dann nicht und das Google-Skript wird nicht geladen.

## Ablauf

1. Beim ersten Öffnen eines Players (nicht im TV-Modus und nicht in der Watch-Party) fragt das Frontend `GET /api/cast/config`. Ist Cast aktiv, wird das Google-Sender-SDK (`https://www.gstatic.com/cv/js/sender/v1/cast_sender.js`) nachgeladen. Dafür enthält die CSP `script-src` zusätzlich die pfadbeschränkten Quellen `https://www.gstatic.com/cv/js/sender/` und `https://www.gstatic.com/cast/sdk/libs/` (nicht den ganzen Host).
2. Ein Klick auf die Cast-Taste öffnet die Geräteauswahl des Browsers. Danach stoppt die lokale Wiedergabe (inkl. Stopp-Meldung an Jellyfin), `POST /api/cast/session` liefert eine Cast-URL und der Chromecast lädt sie.
3. Während der Übertragung steuern alle Player-Elemente (Pause, Springen, Lautstärke, Untertitel, Audiospur, Qualität) den Fernseher. Fortschritt und „Weiterschauen“ laufen über dieselben `/api/playback/*`-Aufrufe wie lokal, mit `playMethod: Transcode`.
4. Beim Beenden oder Verbindungsabbruch wird das Token widerrufen und die lokale Wiedergabe setzt an der letzten Position fort. Am Filmende wird die Sitzung beendet und die „Nächste Folge“-Logik der Seite greift (der Fernseher bleibt nicht automatisch verbunden).

## Das Cast-Token

Der Receiver kann weder Cookies noch eigene Header senden. Deshalb steht ein **Cast-Token** im Pfad: `https://portal.example.com/media/c/<token>/Videos/<id>/master.m3u8?…`. Jellyfin liefert in Playlists relative URIs, daher erben alle Segmente und Untertitel den Pfad.

Eigenschaften:

- 256 Bit zufällig (43 Zeichen, base64url), nur beim Anlegen sichtbar. In Redis liegt ausschließlich `sha256(token)` (`cast:<hash>`, Index `castidx:<userId>:<castId>`); ein Redis-Dump enthält keine nutzbaren Tokens.
- **Scope**: genau ein Titel (`itemId`), eine Medienquelle, eine PlaySession, ein Profil, ein genehmigtes Gerät. Das Gateway lehnt jeden Pfad mit anderer Item-/MediaSource-ID sowie abweichende `MediaSourceId`/`PlaySessionId`-Parameter mit 403 ab.
- **Nur HLS**: erlaubt sind Playlists, Segmente, WebVTT-Untertitel und Poster/Hintergrund des Titels. `/stream` (Direktdownload), Trickplay, Logos und alles andere sind gesperrt.
- **Adress-Bindung**: Das Token gehört der ersten Client-Adresse, die es erfolgreich nutzt (das Gateway reicht `X-Real-IP` bzw. den letzten `X-Forwarded-For`-Eintrag an `/internal/authz` weiter, das Backend speichert sie atomar als `castpin:<hash>`). Jede andere Adresse bekommt 401, ein abgegriffenes Token ist also von woanders nutzlos.
- **Poster-Token**: Die `imageUrl` trägt ein eigenes, nur für Bilder gültiges Token (`kind: img`, nur Primary/Backdrop des Titels; das Gateway lehnt damit jeden Medienpfad mit 403 ab). Es teilt Bindung und Laufzeit mit dem Medien-Token und wird mit ihm widerrufen; Medien-Tokens dürfen auch Bilder laden. Auf die Obergrenze von 2 Tokens zählen nur Medien-Tokens.
- Laufzeit: gleitend 45 Minuten Leerlauf (wird bei jeder erfolgreichen Prüfung, höchstens alle 20 s, verlängert), absolute Obergrenze = Restlaufzeit des Titels + 1 h, mindestens 1 h, höchstens 6 h. Jede erfolgreiche Prüfung hält zudem den Live-Eintrag der PlaySession am Leben, damit `maxStreams` auch dann zählt, wenn kein Absender Fortschritt meldet. Der Player erneuert das Token automatisch kurz vor Ablauf (neues Token, `LOAD` an derselben Stelle).
- Höchstens **2 aktive Tokens pro Konto**; das älteste wird beim Anlegen eines dritten widerrufen. Zusätzlich gilt die Rollengrenze `maxStreams`, die Auflösungs-/Bitrate-Grenze der Rolle (Cast zusätzlich höchstens 1080p und 20 Mbit/s) und `transcoding` der Rolle (ohne Transcoding ist Cast gesperrt).
- Widerruf: `DELETE /api/cast/session/:castId`, beim Beenden des Players, beim Entfernen/Sperren eines Geräts, bei „Andere Sitzungen abmelden“ und beim Deaktivieren des Kontos (`revokeSessions`). Bei **jeder** Anfrage (Gateway-Cache 5 s) prüft das Backend erneut: Token vorhanden und nicht abgelaufen, Konto nicht deaktiviert, Rolle bekannt, Profil gehört noch zum Konto, Absender-Gerät noch genehmigt.
- Das Token gelangt nie zu Jellyfin (das Gateway entfernt den Pfadanteil und setzt den Jellyfin-Token des Profils als Header), nie in Backend-Logs, Metriklabels oder Fehlermeldungen. NPM schreibt für `/media/c/` kein Access-Log (`access_log off`); eigene Log-Pipelines davor sollten die Pfade `/media/c/*` ebenfalls auslassen. Playlists werden im Gateway bereinigt: `api_key`/`ApiKey`-Parameter werden entfernt, jede URI, die aufgelöst nicht unter `/media/c/<token>/` desselben Hosts liegt (absolut, `//host`, `/pfad`, Backslashes), führt zu 502. Playlists dürfen bis 8 MB groß sein. Abfrageparameter `LiveStreamId` und `DeviceId` werden entfernt, `MaxHeight`/`Height` (und `MaxWidth`/`Width` als 16:9-Äquivalent) auf die Auflösungsgrenze des Tokens begrenzt.
- Antworten auf `/media/c/` sind `Cache-Control: no-store`.

## Gateway-Verhalten (`/media/c/<token>/…`)

| Thema | Verhalten |
|---|---|
| Authentifizierung | `POST /internal/authz {ct, client}` (nur mit `X-Internal-Secret`); Cookies werden auf diesem Pfad ignoriert |
| CORS | nur hier: `Access-Control-Allow-Origin: *`, `Expose-Headers: Content-Length, Content-Range, Accept-Ranges`, `OPTIONS` → 204 mit `Allow-Methods: GET, HEAD, OPTIONS`, `Allow-Headers: Range, Content-Type`, `Max-Age: 600`; keine Credentials. Der Cookie-Pfad `/media/…` bleibt ohne CORS |
| Fehlversuche | mehr als 30 **verschiedene** fehlgeschlagene Tokens pro Minute und Client-Adresse (dasselbe widerrufene Token wiederholt zählt einmal) (`X-Real-IP`, sonst letzter `X-Forwarded-For`-Eintrag) → 429 für 5 Minuten |
| Backend nicht erreichbar | 503 (zählt nicht als Fehlversuch) |
| Metriken | `friendflix_gateway_cast_requests_total{code}`; das Token taucht nirgends auf |

## AirPlay (Safari auf iPhone, iPad, Mac)

Safari (auch die Home-Bildschirm-App und jeder iOS-Browser, da alle WebKit sind) kann das `<video>` des Players per AirPlay an ein Apple TV oder einen AirPlay-2-Fernseher (z. B. **LG webOS ab 2019**, Samsung, Sony, Vizio) geben. Es gelten dieselben Voraussetzungen wie oben (`CAST_ENABLED=true`, https-`PUBLIC_URL` mit gültigem Zertifikat, der Fernseher erreicht `PUBLIC_URL`, NPM-Block `/media/c/`).

- **Taste:** Die AirPlay-Taste (Bildschirm mit Dreieck) erscheint in der Steuerleiste neben „Besetzung & Infos“, wenn der Server Cast anbietet (`GET /api/cast/config`, dieselbe Bedingung wie für Chromecast) und Safari einen Empfänger meldet (`webkitplaybacktargetavailabilitychanged`, `availability: available`). Weil hls.js beim Haupt-Video `disableRemotePlayback` setzt, horcht zusätzlich ein unsichtbares Prüf-`<video>` ohne MSE auf dieses Ereignis. Erkannt wird über die Funktion selbst, nicht über den User-Agent; Chrome/Android behalten ihre Chromecast-Taste im Menü „Mehr“.
- **hls.js bleibt bis zum Tipp:** Normale Wiedergabe läuft über hls.js (Bandbreiten-Schätzung, automatische Qualität, Qualitäts-Chip, „Klare Stimmen“). Ein MSE-/ManagedMediaSource-Stream hat aber keine URL, die AirPlay weitergeben könnte, und die normale Stream-URL (`/media/...`) braucht das Sitzungs-Cookie, das der Fernseher nicht hat (Gateway: 401).
- **Erst das Token, dann die Geräteauswahl:** Safari gibt dem Fernseher die URL, die das Video **in dem Moment** hat. Bekommt er eine URL, die er nicht laden kann, bleibt er auf dem AirPlay-Platzhalter (Notensymbol), Safari meldet nie ein drahtloses Videoziel und das Handy dreht sich endlos (so beobachtet mit iPhone + LG webOS). Darum gilt: **der Fernseher bekommt nie eine URL, die er nicht laden kann.** Ein Tipp auf die AirPlay-Taste meldet die lokale Wiedergabe ab, beendet hls.js, holt mit `POST /api/cast/session` (`via: "airplay"`, gleiche Audiospur und Qualität) ein Cast-Token und setzt das Video an derselben Stelle und im selben Zustand (Pause/Wiedergabe) auf dessen URL (das Handy spielt währenddessen selbst diesen Token-Stream). Erst danach öffnet der Player die Geräteauswahl (`webkitShowPlaybackTargetPicker()`). Weil WebKit nach dem Warten auf das Token die Nutzergeste eventuell nicht mehr gelten lässt und die Auswahl dann stillschweigend nicht aufgeht, zeigt der Player zusätzlich den Hinweis „Jetzt den Fernseher in der Liste auswählen“ mit der Taste **Fernseher auswählen** (ein erneuter Tipp auf die AirPlay-Taste tut dasselbe); beide öffnen die Auswahl direkt aus dem neuen Tipp. Während das Token geladen wird, ist die Taste „beschäftigt“ (`aria-busy`), ein Doppeltipp fordert kein zweites Token an.
- **Fernseher gewählt:** Meldet Safari `webkitCurrentPlaybackTargetIsWireless`, spielt das Video schon die Token-URL: der Player zeigt „Läuft über AirPlay“, es wird nichts umgeschaltet und kein neues Token geholt. Grenzen (Rolle, `transcoding`, `maxStreams`, Fern-Bitrate außerhalb des Heimnetzes, 1080p/20 Mbit/s, höchstens 2 Tokens) und Laufzeit sind dieselben wie bei Chromecast; das Token wird 10 Minuten vor Ablauf erneuert, ebenso bei Wechsel von Audiospur oder Qualität.
- **Kein Fernseher gewählt:** Kommt binnen **90 s** kein AirPlay-Ziel (Auswahl abgebrochen), wird das Token widerrufen und der normale Stream (hls.js) läuft an der aktuellen Stelle weiter; ebenso bei einem Wiedergabefehler des Token-Streams am Handy. Scheitert schon das Anfordern des Tokens (z. B. `max_streams`), erscheint eine kurze Meldung und der normale Stream läuft weiter (es gibt noch keinen Fernseher, auf dem ein Fehler stehen könnte).
- **Ende:** Wählt man in der AirPlay-Auswahl wieder das iPhone, wird das Token widerrufen (`DELETE /api/cast/session/:castId`) und der normale Stream (hls.js) läuft an der Stelle weiter, an der der Fernseher war. Verlassen des Players widerruft das Token ebenfalls. Ein widerrufenes Token kann wegen des Gateway-Caches noch bis zu **5 s** funktionieren.
- **Fehler während AirPlay:** Schlägt eine Erneuerung des Tokens fehl oder meldet das Video einen Wiedergabefehler, während der Fernseher das Ziel ist, fällt der Player **nicht** auf die Cookie-URL zurück (die kann der Fernseher nicht laden). Stattdessen zeigt er „Übertragung per AirPlay fehlgeschlagen“, eine Taste **Erneut versuchen** (neues Token) und den Hinweis, AirPlay in der Geräteauswahl über „dieses Gerät“ zu beenden. Scheitert eine Erneuerung, läuft das alte Token weiter, solange es gilt.
- **Kontrollzentrum:** AirPlay, das im Kontrollzentrum (Bildschirmsynchronisierung) statt über die Taste im Player gestartet wird, spiegelt nur den Bildschirm bzw. sendet nur Ton: Während hls.js spielt, meldet Safari kein AirPlay-Videoziel, es gibt kein Token und keine eigene Wiedergabe auf dem Fernseher. Für Video auf dem Fernseher immer die AirPlay-Taste im Player benutzen. (Meldet Safari doch ein drahtloses Ziel, ohne dass die Token-URL am Video liegt, holt der Player wie früher ein Token und schaltet um.)
- **Anzeige:** Während AirPlay zeigt der Player „Läuft über AirPlay“ (Safari verrät den Gerätenamen nicht) und eine Taste, die die Geräteauswahl öffnet; Pause, Springen und Fortschritt laufen über das Video-Element selbst, Safari reicht sie an den Fernseher weiter. „Klare Stimmen“/„Nachtmodus“ sind währenddessen aus.
- **Adress-Bindung:** Das Handy lädt den Token-Stream zuerst selbst (es spielt ihn, solange die Auswahl offen ist), danach der Fernseher; im Heimnetz haben beide verschiedene Adressen. AirPlay-Tokens (`via: airplay`) binden sich deshalb an höchstens **zwei** Client-Adressen (`castpin:` und `castpin2:`, jeweils erster Nutzer gewinnt). Die zweite Adresse kann nur in den ersten **120 s** nach dem Anlegen des Tokens hinzukommen (`AIRPLAY_PIN2_WINDOW_MS`; die Auswahl darf 90 s offen sein); danach ist das Token an die vorhandenen Adressen gebunden, jede weitere bekommt 401. Chromecast-Tokens bleiben bei einer Adresse.
- **Untertitel:** Im Video-URL-Modus zeigt der Fernseher nur Spuren aus dem Stream selbst. Die Untertitel des Players sind seitlich geladene WebVTT-Spuren und erscheinen daher **nicht** auf dem Fernseher (eingebrannte Untertitel bietet der Cast-Ablauf nicht an); auch ein Wechsel im Untertitel-Menü wirkt nur am Handy. Die gewählte Audiospur gilt dagegen.

### Fernseher ohne AirPlay und ohne Chromecast

Ältere LG-/Samsung-Fernseher (oder solche mit abgeschaltetem AirPlay): den **TV-Modus** nutzen – im Browser des Fernsehers `https://portal.<domain>/tv` öffnen und das Handy unter **Menü → Fernbedienung** koppeln (siehe [tv-mode.md](tv-mode.md)). Der Player zeigt diesen Hinweis im Menü „Mehr“ auf Handys, wenn weder AirPlay- noch Chromecast-Empfänger gefunden werden.

## Auf echter Hardware prüfen

Die Tests decken Backend und Gateway ab; folgendes lässt sich nur mit einem Chromecast prüfen:

- Cast-Taste erscheint nur in Chromium, Geräteauswahl, Start an der gemerkten Position, Pause/Springen/Lautstärke, Untertitel an/aus und Wechsel der Audiospur.
- HLS/TS-Wiedergabe von Quellen mit HEVC, 10 Bit, H.264 Level über 4.1, 5.1-Ton und 4K (Jellyfin muss transkodieren; der Default Media Receiver verlangt H.264 bis Level 4.1 und AAC).
- Die pfadbeschränkten CSP-Ausnahmen für `www.gstatic.com` (`/cv/js/sender/`, `/cast/sdk/libs/`) reichen für das SDK; lädt es weitere Skripte von anderen Pfaden (oder braucht `connect-src`/`frame-src`), nur genau diese ergänzen.
- Der Chromecast nutzt für Playlist, Segmente und Poster dieselbe Client-Adresse (Adress-Bindung; z. B. kein Wechsel zwischen IPv4/IPv6 im laufenden Betrieb).
- Token-Erneuerung bei langen Titeln und das Zurückwechseln auf lokale Wiedergabe nach Verbindungsabbruch.
- Verhalten hinter Split-DNS/NAT-Loopback und mit dem NPM-Zertifikat.

AirPlay (iPhone/iPad/Mac mit Safari und einem Apple TV oder AirPlay-2-Fernseher; die Tests simulieren nur Safaris Ereignisse):

- Taste erscheint nur mit Empfänger im Netz; die Systemauswahl öffnet sich; nach der Wahl spielt der Fernseher an derselben Stelle weiter (Token-URL), nach Rückkehr zum iPhone läuft der lokale Stream an der Stelle des Fernsehers weiter.
- Ob Safari die Playlist selbst lädt und von welcher Adresse (Zwei-Adressen-Bindung reicht? IPv4/IPv6-Wechsel?), Verhalten im Hintergrund und bei gesperrtem Bildschirm, Token-Erneuerung bei langen Filmen, Wechsel von Audiospur/Qualität während AirPlay.
- Tipp → Token-URL am Video (Position, Wiedergabe), ob sich die Geräteauswahl nach dem Warten auf das Token noch von selbst öffnet oder erst über „Fernseher auswählen“, ob der Fernseher danach sofort spielt, Rückkehr zu hls.js nach 90 s ohne Auswahl, ob das unsichtbare Prüf-`<video>` Empfänger meldet, Fehleranzeige mit „Erneut versuchen“.
