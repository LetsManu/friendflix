# Der eigene Cast-Empfänger von FriendFlix

Standardmäßig sendet FriendFlix mit Googles **Default Media Receiver** ([cast.md](../cast.md)): keine Registrierung, aber der
Fernseher zeigt nur Bild und Fortschrittsbalken. Mit dem eigenen Web-Empfänger (CAF v3), den die Web-App unter `/cast-receiver/`
ausliefert, bekommt der Fernseher die Funktionen der Streaming-Apps:

- **Nächste Folge** als Karte mit Countdown im Abspann (Abspann-Marker / Outro, sonst die letzten 25 s), *Nächste Folge* und
  *Abspann ansehen* am Fernseher; *Weiter* und Abbrechen in der Cast-Leiste am Handy funktionieren weiter.
- **Noch da?** nach so vielen automatisch gestarteten Folgen wie im Web-Player (*Konto → Wiedergabe*), am Fernseher. Die
  eingereihte Folge wartet pausiert, bis jemand antwortet: OK am Fernseher, die Play-Taste der Fernbedienung oder Play am Handy.
- **Fortschritt und „gesehen“, während das Handy schläft:** der Fernseher meldet Start, Fortschritt und Stopp selbst.
- **Dein Untertitel-Stil** (Größe, Farbe, Hintergrund, Schrift aus *Konto → Wiedergabe → Untertitel*) auf dem Fernseher.
- **Intro überspringen / Rückblick überspringen** am Fernseher wie am Handy.
- Das FriendFlix-Aussehen (Koralle, dunkel), aus 3 m lesbar, reduzierte Bewegung wird beachtet (keine Karten-Animation).

Für AirPlay ändert sich nichts, und für Chromecast nichts, solange `CAST_RECEIVER_APP_ID` leer ist.

## Einrichten

Nötig sind ein Google-Konto und eine **einmalige Registrierung als Google-Cast-Entwickler** (eine kleine Gebühr an Google, von dir
bezahlt; FriendFlix hat damit nichts zu tun).

1. Zuerst muss Cast mit dem Default Media Receiver laufen ([cast.md](../cast.md): `https://`-`PUBLIC_URL` mit gültigem Zertifikat,
   die Location `/media/c/`, der Fernseher erreicht die Adresse).
2. `https://friend.example.com/cast-receiver/` (deine eigene Adresse) im Browser öffnen: das FriendFlix-Logo auf Schwarz erscheint.
3. In der [Google Cast SDK Developer Console](https://cast.google.com/publish) als Entwickler registrieren, dann **Add new
   application → Custom Receiver**:
   - Name: z. B. `FriendFlix`
   - Receiver Application URL: `https://friend.example.com/cast-receiver/` (mit Schrägstrich am Ende)
   - Speichern. Die Konsole zeigt eine **Application ID** mit 8 Zeichen (z. B. `A1B2C3D4`).
4. Solange die App *unveröffentlicht* ist, startet Google sie nur auf **registrierten Testgeräten**: unter *Cast Receiver Devices →
   Add new device* die Seriennummer jedes Chromecast / Google TV eintragen (am Gerät unter *Einstellungen → System → Info*, auf der
   Rückseite oder der Verpackung), danach das Gerät neu starten (eine Minute vom Strom trennen). Bis das Gerät die App annimmt, kann
   es bis zu 15 Minuten dauern. Mit *Publish* in der Konsole läuft die App auf jedem Gerät (Google prüft einen veröffentlichten
   eigenen Empfänger nicht, er gilt dann aber als öffentlich).
5. In FriendFlix: *Admin → Einstellungen → Wiedergabe → Cast-Empfänger-App-ID* eintragen und speichern (oder
   `CAST_RECEIVER_APP_ID=A1B2C3D4` in der `.env`, das sperrt das Feld). Es gilt sofort; offene Seiten übernehmen es beim nächsten
   Neuladen.

Zurück geht es mit einem leeren Feld: die nächste Übertragung nutzt wieder den Default Media Receiver.

## Was sich am Fernseher ändert

| | Default Media Receiver | Eigener Empfänger |
|---|---|---|
| Bild, Ton, Untertitel, Audiospur, Qualität | ja | ja |
| Countdown zur nächsten Folge im Abspann | nur am Handy | am Fernseher und am Handy |
| Nächste Folge bei gesperrtem Handy | die eingereihte Folge startet am Ende | ebenso, aber nach dem Countdown am Fernseher (oder am Ende) |
| Noch da? | die nächste Folge wird nur nicht eingereiht | Frage am Fernseher; die Folge wartet pausiert |
| Fortschritt / gesehen bei schlafendem Handy | fehlt, bis das Handy aufwacht | meldet der Fernseher |
| Untertitel-Stil | Standard des Fernsehers | dein Stil |
| Intro / Rückblick überspringen | nur am Handy | Fernseher und Handy |

Grenzen: der Fernseher spielt nur, was das Handy eingereiht hat. Schläft das Handy, geht der Fernseher **eine** Folge weiter (die,
die eingereiht wurde, als das Handy wach war); die übernächste wird eingereiht, sobald das Handy wieder aufwacht. Wird *Noch da?*
erst mehr als etwa 45 Minuten nach dem Ende beantwortet, kann das Token der eingereihten Folge abgelaufen sein; dann die Folge vom
Handy aus starten.

## Wie es funktioniert

- `GET /api/cast/config` nennt `receiverAppId` nur, wenn Cast an und die ID gesetzt ist; der Sender startet dann diese App und
  fragt `POST /api/cast/session` mit `receiver: true`. Die Antwort enthält neben der üblichen Token-URL ein **Melde-Token**
  (`report`).
- Der Sender schickt das Melde-Token und die Daten für den Fernseher über einen privaten Kanal (`urn:x-cast:com.friendflix.cast`):
  `tok` (castId + Melde-Token), `item` (Segmente, die eingereihte Folge, ob sie von selbst starten darf, ob *Noch da?* gefragt
  wird), `ui` (Texte in der Sprache des Zuschauers, Untertitel-Stil, Countdown-Länge). In den Medien-Metadaten steht nur der
  öffentliche Bezeichner des Tokens (`castId`).
- Der Empfänger meldet `start` / `progress` (alle 15 s und bei Pause) / `stop` an `POST /api/cast/report` mit dem Melde-Token. Das
  Backend verarbeitet das mit derselben Logik wie `/api/playback/*`, für Konto, Profil und Gerät des Tokens.
- Sicherheit: siehe [security.md, „Cast receiver“](../security.md#cast-receiver) (englisch).

## Auf echter Hardware prüfen

CI testet den Sender gegen ein nachgebautes Cast-SDK und die Empfängerseite gegen ein nachgebautes Empfänger-Framework. Nur ein
echtes Gerät zeigt:

- Der Empfänger startet (registriertes Testgerät, App-ID), die CSP der Seite erlaubt alles, was Googles Framework lädt (die
  Player-Bibliotheken unter `https://www.gstatic.com/cast/sdk/libs/`; lädt ein Gerät eine von einem anderen Google-Pfad, nur genau
  diesen in `web/src/lib/cast/receiverPage.ts` ergänzen).
- HLS/TS-Wiedergabe über das Framework mit dem eigenen `<video>`-Element der Seite; Untertitel erscheinen im gewählten Stil.
- *Nächste Folge* am Ende des Countdowns schaltet die Warteschlange weiter (`QUEUE_UPDATE`-Sprung); sonst spielt der Ersatzweg bis
  zum Ende.
- Eine eingereihte Folge mit `autoplay: false` wartet pausiert; *Noch da?* lässt sich mit OK, der Play-Taste der Fernbedienung und
  am Handy beantworten.
- Welche Tasten die Fernbedienung an die Seite liefert (OK / Zurück / Pfeile bei Chromecast mit Google TV; Touch bei einem Nest Hub).
- Meldungen kommen von derselben Client-Adresse wie die Medien (das Melde-Token ist an die Adresse gebunden, die das Token streamt;
  verschiedene Adressen für Medien und API, z. B. IPv4/IPv6, würden die Meldungen ablehnen; die Meldungen des Handys gelten weiter).
