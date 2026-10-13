<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="FriendFlix" width="360">
  </picture>
</p>

<p align="center"><b>Dein eigener Streamingdienst für Freunde und Familie – auf Basis der Jellyfin-Bibliothek, die du schon hast.</b></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a>
  <br><br>
  <a href="https://github.com/LetsManu/friendflix/actions/workflows/ci.yml"><img src="https://github.com/LetsManu/friendflix/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/self--hosted-Docker-2496ED" alt="Selbst gehostet mit Docker">
  <img src="https://img.shields.io/badge/Sprachen-7-ff4f6d" alt="7 Sprachen">
  <a href="https://www.bestpractices.dev/projects/15445"><img src="https://www.bestpractices.dev/projects/15445/badge" alt="OpenSSF Best Practices"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Lizenz-AGPL--3.0-blue" alt="Lizenz: AGPL-3.0"></a>
</p>

<p align="center"><img src="docs/images/de/hero.jpg" alt="FriendFlix-Startseite mit großem Billboard und Titelreihen" width="900"></p>

FriendFlix ist ein privates Streaming-Portal vor **Jellyfin** (deine Medien) und einem optionalen Wunsch-Dienst. Deine Freunde bekommen ein schickes, vertrautes Streaming-Erlebnis auf Laptop, Handy und Fernseher – mit Profilen, Downloads, Watch-Partys und Empfehlungen untereinander. Jellyfin und den Wunsch-Dienst sehen sie nie direkt, und du bestimmst, wer hineinkommt.

> Alle Titel und Bilder in diesen Screenshots sind erfunden und für die Demo generiert.

## Inhalt

- [Das bekommst du](#das-bekommst-du)
- [Datenschutz und Sicherheit](#datenschutz-und-sicherheit)
- [Für Admins: Einrichtung und Betrieb](#für-admins-einrichtung-und-betrieb)

## Das bekommst du

Schauen · Entdecken · Gemeinsam · Familie und Kinder · Handy und TV · Admin

### Schauen

#### Eine Startseite wie bei einem echten Streamingdienst

Ein großes Billboard mit Titel-Logo, darunter Reihen wie *Weiterschauen*, *Nächste Folge*, *Von Freunden empfohlen*, *Freunde haben bewertet*, *Diese Woche bei uns*, *Weil du … gesehen hast*, *Top 10* und *Merkliste*. Fährst du mit der Maus über eine Karte, klappt sie mit den wichtigsten Aktionen auf: abspielen, auf die Liste, bewerten, mehr Infos.

Kleine **Labels** auf den Karten zeigen, was neu ist – *Neu*, *Neue Folge*, *Neue Staffel*, *Staffelfinale*, *Neue Serie*. Weiß der Admin, dass ein Titel bald die Bibliothek verlässt, steht auf seiner Karte „Nur noch 6 Tage“, und eine Reihe **Bald nicht mehr verfügbar** sammelt diese Titel; wer einen davon auf der Liste oder in *Weiterschauen* hat, bekommt eine Woche und einen Tag vorher eine Erinnerung. Gelöscht wird nichts – das Datum ist nur eine Ankündigung.

<p align="center"><img src="docs/images/de/home.jpg" alt="Startseite mit Themenlisten, Neu- und Bald-weg-Labels und der Reihe „Bald nicht mehr verfügbar“" width="900"></p>

<p align="center"><img src="docs/images/de/popout.jpg" alt="Aufgeklappte Karte mit Abspielen, Liste und Bewertung sowie Bild- und Ton-Chips" width="900"></p>

#### Alles zu einem Titel an einem Ort

Die Detailansicht zeigt Beschreibung, Ton- und Untertitelsprachen, Besetzung, welche Freunde den Titel empfohlen oder gesehen haben und – bei Serien – alle Staffeln und Folgen mit Fortschrittsbalken. Weiterschauen genau dort, wo du aufgehört hast. Kleine Chips verraten vor dem Start **Bild und Ton** (4K, HDR, Dolby Vision, Dolby Atmos, 5.1 Surround). Steht eine neue Staffel an oder warst du ein paar Wochen weg, fasst **Die Geschichte bisher** kurz zusammen, was passiert ist und wo du stehengeblieben bist – die Karte lässt sich ausblenden. Ein Tab **Extras** sammelt Trailer und Bonusmaterial aus Jellyfin, und jede Folge hat ihre eigenen **Kommentare** von Freunden: Kommentare zu einer Folge, die du noch nicht gesehen hast, bleiben verschwommen, bis du „Spoiler – trotzdem zeigen“ wählst.

<table>
  <tr>
    <td><img src="docs/images/de/detail.jpg" alt="Detailansicht einer Serie mit Neue-Staffel-Label, Qualitäts-Chips und „Die Geschichte bisher“" width="440"></td>
    <td><img src="docs/images/de/detail-episodes.jpg" alt="Karte „Die Geschichte bisher“ und Folgenliste mit Fortschritt und Beschreibungen" width="440"></td>
  </tr>
</table>

#### Ein Player für Serienabende

Intro überspringen, nächste Folge mit Countdown, Tonspur und Untertitel (mit eigenem Untertitel-Stil), Wiedergabegeschwindigkeit, Lesezeichen, Tastenkürzel und „Noch da?“ nach mehreren automatisch gestarteten Folgen. Direct Play, wenn möglich, sonst adaptives Streaming (HLS). **Vorschau überspringen** springt über „Nächstes Mal bei …“-Abschnitte. Wechselst du einmal Tonspur oder Untertitel, merkt sich FriendFlix das **für die ganze Serie**; mit „Anime: Originalton mit Untertiteln“ starten Anime auf Japanisch mit Untertiteln in deiner Sprache, solange du für die Serie nichts anderes gewählt hast.

- **Besetzung & Infos** (<kbd>I</kbd> für einen kurzen Blick, dann „Alle Infos“): wer wen spielt, die Gaststars dieser Folge, Regie, Drehbuch, Studio und Schlagwörter – ein Tipp auf eine Person zeigt ihre weiteren Titel in deiner Bibliothek.
- **Szenen**: Kapitelmarken auf der Zeitleiste und ein Fenster mit einem Vorschaubild je Szene – direkt zur besten Stelle springen.
- **Klare Stimmen** und **Nachtmodus** im Klang-Menü: Dialoge hervorheben oder dafür sorgen, dass laute Szenen nicht das ganze Haus wecken.
- **Ruckelfreies Streaming**: Die Qualität „Automatisch“ passt sich deiner Verbindung an und sinkt, wenn das Bild hängt (ein Chip erklärt den Grund). Unterwegs, also außerhalb des Heimnetzes, gilt je Rolle ein Bitraten-Limit; der Player startet mit einem Poster des Titels statt mit einem schwarzen Bild.

<p align="center"><img src="docs/images/de/player.jpg" alt="Player mit geöffnetem Fenster „Besetzung & Infos“ neben dem Bild" width="900"></p>

<p align="center"><img src="docs/images/de/player-scenes.jpg" alt="Player mit dem Szenen-Fenster und einem Vorschaubild je Kapitel" width="900"></p>

### Entdecken

- **Marken-Hubs** – breite Kacheln, die der Admin aus deinen eigenen Jellyfin-Studios, -Sammlungen, -Tags oder -Genres baut (etwa „Anime“ oder „Dokus“) – führen auf eine eigene Seite mit *Neu*, *Beliebt*, *Filme*, *Serien* und A–Z.
- **Themenlisten** – jede Liste kann zur redaktionellen Seite mit Titel, Farbe und Emoji werden; der Admin heftet einige als Reihen auf die Startseite aller an („Filmabend am Freitag“, „Gemütlicher Herbst“).
- **Eine ausführlichere Detailseite** – Bewertungen in einer Zeile (Community, Kritik, Freunde; mit optionalem OMDb-Schlüssel auch IMDb, Rotten Tomatoes und Metacritic), eine Sammlungsreihe mit „Teil 2 von 3“ und Gesehen-Häkchen sowie ein Tab *Details* mit Fakten und Links zu TMDB, IMDb, TVDB und Trakt. Auf dem Handy bleiben die Tabs beim Scrollen in Reichweite.
- **Weil du … gesehen hast** – mehrere Reihen, jede zu einem anderen zuletzt gesehenen Titel, verteilt zwischen den übrigen Reihen.
- **Suche und Stöbern** finden Personen, Genres, Titel und Folgen; filtern geht nach Jahrzehnt, Bewertung, Sprache und **Bildqualität** (4K, HDR, Dolby Vision, Atmos). „Heute Abend“ schlägt drei Titel nach Stimmung und Zeit vor.
- **Simulcast** (verlinkt im Kalender) zeigt die gerade laufenden Serien nach Wochentag und Season, mit Filter „Nur Anime“.

### Gemeinsam

- **Watch-Partys** mit synchroner Wiedergabe, Chat und Live-Emoji-Reaktionen, die für alle in der Party über das Bild schweben. **Filmabend-Abstimmung** mit Countdown und automatischem Start. „Was hat noch keiner von uns gesehen?“ – der Gruppen-Matcher findet Titel für alle.
- **Empfehlungen**: Titel an Freunde empfehlen, sehen, was Freunde bewertet und diese Woche geschaut haben, geteilte Listen mit Editoren und Lesern, kuratierte Reihen vom Admin.
- **Wünsche**: Fehlt etwas? Direkt aus der Suche wünschen und benachrichtigt werden, sobald es da ist – mit einem monatlichen Limit pro Rolle. „Erinnere mich“ für kommende Titel.
- **Immer auf dem Laufenden**: Benachrichtigungen in der App, als Web-Push auf jedem Gerät, über ntfy oder Discord und ein optionaler Wochenrückblick.
- **Die Extras**: Reaktionen und Kurzkritiken (erst sichtbar, wenn du den Titel gesehen hast), Bewertungen, Statistik, Achievements und eine teilbare „Jahresrückblick“-Karte mit deinen Zahlen.

### Familie und Kinder

Bis zu fünf Profile pro Konto, jedes mit eigenem Verlauf, eigener Liste, Favoriten, Sprache und Wiedergabe-Einstellungen. Profile lassen sich mit einer 4-stelligen PIN sperren. Jedes neue Profil beginnt mit einem kurzen **Willkommen**: Name und Farbe bestätigen, dann drei Titel wählen, die dir gefallen – so wissen die Empfehlungen, wo sie anfangen sollen.

**Kinderprofile** bekommen eine eigene, bunte Startseite mit großen Kacheln, eine einfache Suche und eine Altersgrenze (0, 6 oder 12), die der Server bei jeder Liste, Suche und jedem Titel durchsetzt. Soziales gibt es dort nicht – keine Freunde, Reaktionen, Bewertungen, Kommentare, Watch-Partys, geteilten Listen, Wünsche oder Statistiken –, und die Einstellungen bieten nur Sprache und Wiedergabesprachen. Ein Kinderprofil verlässt man nur mit der PIN des Zielprofils oder, wenn dieses keine hat, mit der PIN des Hauptprofils; ein Fernseher, der aus einem Kinderprofil gekoppelt wurde, bleibt auf diesem Kinderprofil. Angeheftete Themenlisten („Gemütlicher Herbst“ für die Kleinen) erscheinen dort ebenfalls.

Der **Ruhige Modus** (pro Profil, auch für Kinder) hält alles still: kein Trailer im Billboard, keine Vorschau beim Darüberfahren, kein Ton und weniger Bewegung in der ganzen App.

<table>
  <tr>
    <td><img src="docs/images/de/profiles.jpg" alt="Profilauswahl mit vier Profilen, eines mit PIN gesperrt" width="440"></td>
    <td><img src="docs/images/de/kids.jpg" alt="Kinder-Startseite mit großen Kacheln und freundlicher Begrüßung" width="440"></td>
  </tr>
</table>

### Handy und TV

App-artige Oberfläche mit Tab-Leiste unten, einer Vorschau beim Antippen eines Posters und allen Details nur einen Wisch entfernt. FriendFlix lässt sich auf dem Home-Bildschirm installieren (PWA) – mit **Verknüpfungen** per langem Druck (Weiterschauen, Merkliste, Suche, Downloads), einem **Badge** mit deinen ungelesenen Benachrichtigungen auf dem Symbol und Name und Beschreibung der App in deiner Sprache.

<table>
  <tr>
    <td><img src="docs/images/de/phone-home.jpg" alt="Startseite auf dem Handy" width="260"></td>
    <td><img src="docs/images/de/phone-preview.jpg" alt="Vorschau auf dem Handy" width="260"></td>
    <td><img src="docs/images/de/phone-detail.jpg" alt="Detailseite auf dem Handy mit Qualitäts-Chips" width="260"></td>
  </tr>
</table>

**Auf dem großen Bildschirm:** TV-Modus für Smart-TV-Browser, Sticks und Konsolen – große Schrift, Steuerung mit Pfeiltasten, Kopplung per Code oder QR-Code und das **Handy als Fernbedienung**. Chromecast aus Chrome, Edge und Android; **AirPlay** aus Safari auf iPhone, iPad und Mac zu Apple TV und AirPlay-2-Fernsehern (z. B. LG webOS ab 2019).

**Downloads für Zug und Flugzeug:** Filme und Folgen herunterladen (bei Serien auch gleich die nächsten Folgen) und offline im Browser ansehen. Der Fortschritt wird beim nächsten Online-Sein abgeglichen. Lizenzen pro Gerät mit Ablaufdatum; funktioniert in Chrome, Edge, Firefox, Safari 17+ und als Home-Bildschirm-App auf iOS 17+.

<p align="center"><img src="docs/images/de/downloads.jpg" alt="Downloads-Seite mit fertigen, pausierten und vorbereiteten Downloads" width="700"></p>

**Sieben Sprachen:** Die Oberfläche spricht **Deutsch, Englisch, Französisch, Spanisch, Italienisch, Türkisch und Polnisch**. Jedes Profil wählt seine eigene Sprache; beim ersten Login fragt FriendFlix einmal nach und schlägt die Browsersprache vor. Der Admin legt die Standardsprache der ganzen Instanz fest.

<p align="center"><img src="docs/images/de/language.jpg" alt="Sprachauswahl beim ersten Login" width="700"></p>

### Admin

Ein aufgeräumter Admin-Bereich mit Seitenleiste (Personen, Inhalte, Betrieb) und einer **Übersicht**, die Systemzustand, offene Entscheidungen – einen Wunsch oder ein neues Gerät gleich dort freigeben oder ablehnen –, die letzte Aktivität in ganzen Sätzen, Zahlen und Speicher zeigt. Alles meldet sich zurück: keine Pop-up-Fenster, riskante Aktionen fragen vorher, kleine bieten **Rückgängig**. Auf dem Handy ist derselbe Bereich eine einfache Liste mit großen Tippflächen.

Außerdem im Admin-Bereich: Einladungen und Rollen, **Marken-Hubs**, hervorgehobene und Themenlisten, **Bald-weg-Termine**, Vorschau-Clips, der nächtliche Wiedergabe-Check, der Wochenrückblick, ein Audit-Log und Updates per Knopfdruck.

<table>
  <tr>
    <td><img src="docs/images/de/admin.jpg" alt="Admin-Übersicht mit Systemzustand, offenen Wünschen und Geräten und der letzten Aktivität" width="600"></td>
    <td><img src="docs/images/de/phone-admin.jpg" alt="Admin-Bereich auf dem Handy als gegliederte Liste" width="260"></td>
  </tr>
</table>

## Datenschutz und Sicherheit

- **Selbst gehostet.** Alles läuft auf deinem eigenen Server. FriendFlix hat keine Werbung und keine Analyse-Dienste von Dritten.
- **Nur mit Einladung.** Neue Leute kommen über Einmal-Einladungslinks dazu. Die Anmeldung läuft über dein Authentik mit **verpflichtender Zwei-Faktor-Authentifizierung**, neue Geräte können eine Freigabe brauchen.
- **Jellyfin und der Wunsch-Dienst bleiben unsichtbar.** Freunde sprechen nur mit dem Portal. Medien-Tokens bleiben auf dem Server; Videos und Bilder laufen über ein Gateway, das jede Anfrage prüft.
- **Du bestimmst, was Freunde sehen.** „Verlauf teilen“ (standardmäßig aus) und „Bewertungen teilen“ stellt jede Person in den Einstellungen ein; „Diese Woche bei uns“ zeigt nur Zahlen, nie wer geschaut hat. Reaktionen zu einem Titel erscheinen erst, wenn du ihn gesehen hast, und der optionale Spoilerschutz blendet Bilder und Beschreibungen ungesehener Folgen aus.
- **Trailer ohne Tracking.** Trailer für Titel, die noch nicht in der Bibliothek sind, laufen im datenschutzfreundlichen `youtube-nocookie.com`-Player und laden erst nach einem Klick.
- **Fehlerberichte bleiben bei dir.** Stürzt die App im Browser von jemandem ab, landet eine bereinigte Fehlermeldung (ohne Query-Strings, Tokens oder E-Mail-Adressen) im Log *deines* Servers – und nirgendwo sonst.
- **Ehrlich zu Downloads.** Downloads sind für vertrauenswürdige Freunde und Familie gedacht: Es gibt keinen Kopierschutz (kein DRM); Ablauf und Widerruf setzt die App durch.
- **Geprüft, bevor es ausgeliefert wird.** Jedes Image wird gescannt, signiert und mit einer Software-Stückliste veröffentlicht; die Pipeline macht außerdem einen Web-Sicherheitsscan, und die Lieferkette wird öffentlich bewertet (siehe unten).

---

## Für Admins: Einrichtung und Betrieb

Ab hier wird es technisch. Die ausführliche Betriebsdoku steht unter [Dokumentation](#dokumentation).

**Installationsanleitung:** Schritt für Schritt vom leeren Server bis zum ersten eingeladenen Freund – [docs/de/setup.md](docs/de/setup.md); Authentik (Installation, Provider, Flows, Einladungen) – [docs/de/authentik.md](docs/de/authentik.md).

### Voraussetzungen

- Ein Linux-Server mit **Docker** und **Docker Compose**.
- **Jellyfin** (deine Bibliothek) und optional einem Wunsch-Dienst (Wünsche) – schon vorhanden oder über das Profil `bundled` mitgestartet.
- **Authentik** als Login (OIDC mit PKCE; MFA dort erzwingen).
- Ein Reverse Proxy mit TLS, z. B. **Nginx Proxy Manager**, mit einem Proxy-Host für das Portal.
- Optional: ntfy, ein Discord-Webhook, Portainer (Updates per Knopfdruck).

### Schnellstart

Der Produktions-Stack zieht fertige Images von `ghcr.io/letsmanu/friendflix-{backend,gateway,web}`; auf dem Server wird nichts gebaut.

```bash
git clone https://github.com/LetsManu/friendflix.git && cd friendflix
cp .env.example .env
openssl rand -base64 32    # -> APP_ENC_KEY
openssl rand -hex 24       # -> INTERNAL_SECRET, WEBHOOK_SECRET, METRICS_TOKEN (je ein Wert)
$EDITOR .env               # PUBLIC_URL, Passwörter, OIDC_*, JELLYFIN_*, SEERR_*
docker login ghcr.io -u <user>                                 # nur bei privaten Paketen (PAT mit read:packages)
docker compose -f compose.prod.yaml up -d                      # mit --profile bundled auch Jellyfin + den Wunsch-Dienst
docker compose -f compose.prod.yaml --profile backup up -d backup   # optional: nächtliche Datenbank-Backups
docker compose -f compose.prod.yaml ps                         # alles "healthy"
```

Danach:

1. **Authentik:** OIDC-Provider anlegen (Redirect-URI `${PUBLIC_URL}/auth/callback`) und MFA erzwingen – [docs/de/authentik.md](docs/de/authentik.md).
2. **Nginx Proxy Manager:** ein Proxy-Host `portal.<domain>` → `127.0.0.1:3080`, Websockets an, Force SSL/HTTP2/HSTS; [deploy/npm/portal.advanced.conf](deploy/npm/portal.advanced.conf) in den Reiter *Advanced* einfügen (leitet `/api`, `/auth`, `/ws` an `:3081` und `/media/` an `:3082`). Den Block `/media/c/` nicht entfernen: Er verhindert, dass Cast-Tokens in Logs landen.
3. **Jellyfin:** Admin-API-Key anlegen. Optional das Webhook-Plugin für sofortige „läuft gerade“- und „neu in der Bibliothek“-Ereignisse – [docs/integrations.md](docs/integrations.md).
4. **Wünsche (optional):** API-Key und Webhook – [docs/integrations.md](docs/integrations.md).
5. **Web-Push (optional):** `node scripts/gen-vapid.mjs`, beide Schlüssel in `.env`, neu starten.
6. **Erster Login** mit einem Mitglied der Authentik-Gruppe `friendflix-admins`: Du wirst Portal-Admin, wählst die Sprache der Instanz und lädst deine Freunde unter *Admin → Einladungen* ein.

Laufen Jellyfin/Wunsch-Dienst schon in einem eigenen Stack: `docker network connect friendflix_media <container>`, deren öffentliche Ports entfernen und `JELLYFIN_URL`/`SEERR_URL` setzen.

### Konfiguration

Vorlage: [.env.example](.env.example). Jede Variable kann mit der Endung `_FILE` auch aus einer Datei gelesen werden (Docker Secrets, siehe [compose.secrets.yaml](compose.secrets.yaml)). Die Standardwerte stammen aus [compose.prod.yaml](compose.prod.yaml).

| Variable | Standard | Bedeutung |
|---|---|---|
| `PUBLIC_URL` | – (Pflicht) | Öffentliche https-URL des Portals |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | – (Pflicht) | Passwörter für Datenbank und Redis |
| `APP_ENC_KEY` | – (Pflicht) | 32 Byte base64; verschlüsselt gespeicherte Jellyfin-Zugangsdaten. **Getrennt sichern.** |
| `INTERNAL_SECRET`, `WEBHOOK_SECRET` | – (Pflicht, ≥ 16 Zeichen) | Backend ↔ Gateway; Jellyfin-/Wunsch-Dienst-Webhooks |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | – (Pflicht) | Authentik-OIDC-Provider |
| `TMDB_API_KEY`, `OMDB_API_KEY` (oder `…_FILE`) | leer | Optionale Zusatzdaten für die Detailseite (Links, Bewertungen); oder unter *Admin → Datenquellen* setzen. Siehe [docs/integrations.md](docs/integrations.md#tmdb--omdb-optional) |
| `MEDIA_SERVER` | `jellyfin` | Art des Medienservers; in diesem Repository gibt es nur Jellyfin (ein Fork kann weitere ergänzen, siehe [docs/architecture.md](docs/architecture.md)) |
| `JELLYFIN_URL`, `JELLYFIN_ADMIN_API_KEY` | – (Pflicht bei `jellyfin`) | Interne Jellyfin-URL, z. B. `http://jellyfin:8096`, und Admin-API-Key |
| `SEERR_URL`, `SEERR_API_KEY` | – (Pflicht) | Interne URL und API-Key des Wunsch-Dienstes |
| `ADMIN_GROUP` | `friendflix-admins` | Authentik-Gruppe, deren Mitglieder Portal-Admins werden |
| `BIND_ADDR` | `127.0.0.1` | Host-Adresse für die drei Ports – nie eine öffentliche Schnittstelle |
| `WEB_PORT`, `BACKEND_PORT`, `GATEWAY_PORT` | `3080`, `3081`, `3082` | Host-Ports für den Reverse Proxy |
| `FF_REGISTRY`, `FF_TAG` | `ghcr.io/letsmanu`, `latest` | Herkunft und Version der Images (festnageln mit Commit-SHA oder `x.y.z`) |
| `SESSION_TTL_SECONDS`, `SESSION_IDLE_SECONDS` | `28800`, `7200` | Maximale Sitzungsdauer (8 h) und Ablauf bei Inaktivität (2 h) |
| `TZ` | `Europe/Vienna` | Zeitzone für geplante Jobs (Rückblick, Wiedergabe-Check, Backups) |
| `AUTHENTIK_URL`, `AUTHENTIK_API_TOKEN`, `AUTHENTIK_ENROLL_FLOW` | leer | Einladungen, die auch das Authentik-Konto anlegen (alle drei nötig) |
| `NTFY_URL`, `NTFY_BASE_URL`, `DISCORD_WEBHOOK_URL` | leer | Gemeinsamer ntfy-/Discord-Kanal; ntfy-Server für persönliche Themen |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | leer, leer, `PUBLIC_URL` | Web-Push; nur aktiv, wenn beide Schlüssel gesetzt sind |
| `DIGEST_DAY`, `DIGEST_HOUR` | `0` (Sonntag), `18` | Zeitplan des Wochenrückblicks; `-1` = aus; im Admin-Bereich änderbar |
| `CAST_ENABLED` | `true` | Chromecast und AirPlay (braucht eine https-`PUBLIC_URL`); bei Plan B `false` |
| `DOWNLOADS_ENABLED` | `true` | Offline-Downloads; bei Plan B `false` |
| `DOWNLOADS_PATH`, `PREVIEWS_PATH` | Volumes `downloads`, `previews` | Host-Ordner (absoluter Pfad, beschreibbar für uid 1000) für vorbereitete Downloads und Vorschau-Clips |
| `DOWNLOAD_CACHE_MAX_GB`, `DOWNLOAD_MIN_FREE_GB` | `50`, `2` | Obergrenze für vorbereitete Downloads; Mindest-Freiplatz |
| `DOWNLOAD_PREP_CONCURRENCY`, `DOWNLOAD_PAUSE_STREAMS` | `1`, `2` | Parallele Vorbereitungen; Pause, solange so viele Streams laufen (`0` = nie) |
| `DOWNLOAD_FILE_TTL_HOURS`, `DOWNLOAD_OFFLINE_GRACE_DAYS`, `DOWNLOAD_CREATE_PER_HOUR` | `48`, `7`, `20` | Aufräumen ungenutzter Dateien, Offline-Kulanz, Rate-Limit für Lizenzen |
| `DIRECT_PLAY_REQUIRES_DOWNLOAD` | `false` | `true`: Rollen ohne Download-Recht verlieren auch Direct Play |
| `PREVIEW_WARM` | `true` | Hintergrundjob, der Vorschau-Clips für Karten und Billboard vorab erzeugt |
| `PLAYBACK_CHECK_HOUR` | `4` | Nächtlicher Wiedergabe-Check mit Admin-Hinweis; `-1` = aus |
| `BACKGROUND_JOBS` | `true` | Download-Vorbereitung/-Aufräumen, Sprach- und Bildqualitäts-Index, Bald-weg-Erinnerungen, Jellyfin-Session-Polling (auf dem einzigen Backend `true` lassen) |
| `API_COMPRESSION` | `true` | gzip/brotli für JSON-Antworten ab 1 KB; `false`, wenn der Proxy `/api` schon komprimiert |
| `METRICS_TOKEN` | leer | Bearer-Token für `/metrics` |
| `PORTAINER_WEBHOOK_URL` oder `PORTAINER_URL` + `PORTAINER_API_KEY` + `PORTAINER_STACK_ID` | leer | Updates per Knopfdruck unter *Admin → Update* (`PORTAINER_ENDPOINT_ID` Standard `1`) |
| `UPDATE_REPO`, `GITHUB_TOKEN` | `LetsManu/friendflix`, leer | Versionsprüfung; das Token hebt nur das GitHub-Limit an |
| `GRAFANA_ADMIN_PASSWORD`, `GRAFANA_PORT`, `PROMETHEUS_RETENTION` | – (Pflicht für den Monitoring-Stack), `3083`, `30d` | Optionales Prometheus + Grafana (`compose.monitoring.yaml`); kein Standardpasswort |
| `BACKUP_PATH`, `BACKUP_HOUR`, `BACKUP_KEEP_DAYS`, `BACKUP_RUN_ON_START` | `./backups`, `3`, `14`, `false` | Backup-Sidecar (Profil `backup`) |
| `MEDIA_PATH` | `./media` | Medienordner für das mitgelieferte Jellyfin (Profil `bundled`) |

Die vollständige Liste mit Erklärungen steht in [.env.example](.env.example).

### Architektur

```mermaid
---
config:
  flowchart:
    curve: basis
    nodeSpacing: 50
    rankSpacing: 65
    padding: 14
  themeVariables:
    edgeLabelBackground: 'rgba(150,150,150,0.12)'
  themeCSS: '.labelBkg { background-color: rgba(127,127,127,0.12) !important; }'
---
flowchart TB
  accTitle: So greift FriendFlix ineinander
  accDescr: Zuschauer erreichen über HTTPS einen Reverse-Proxy. Dieser leitet an Web, Backend und Gateway von FriendFlix weiter. Backend und Gateway sprechen mit Jellyfin; das Backend nutzt außerdem Authentik, den Wunsch-Dienst und Benachrichtigungen.
  V("📺 <b>Zuschauer</b><br/><small>Browser · Handy · TV</small>"):::ext
  P("🛡️ <b>Reverse-Proxy</b><br/><small>Nginx Proxy Manager · TLS</small>"):::edge
  subgraph FF["FriendFlix"]
    W("🖥️ <b>web</b><br/><small>die App im Browser</small>"):::app
    B("⚙️ <b>backend</b><br/><small>Login · API · Regeln</small>"):::app
    G("📡 <b>gateway</b><br/><small>Video- und Bild-Pipe</small>"):::app
  end
  S("🎬 <b>Jellyfin</b><br/><small>Medienserver</small>"):::media
  RQ("🔔 <b>Wünsche</b><br/><small>Wunsch-Dienst · ntfy · Discord</small>"):::svc
  AK("🔑 <b>Authentik</b><br/><small>Login · Einladungen</small>"):::svc
  V -->|HTTPS| P
  P -->|"/"| W
  P -->|"/media/*"| G
  P -->|"/api /auth /ws"| B
  G -->|"darf schauen?"| B
  G ==>|"Video"| S
  B -->|"Bibliotheks-API"| S
  B -->|REST| RQ
  B -.->|OIDC| AK
  P -.->|"auth.example.com"| AK
  classDef ext fill:#30363d,stroke:#8b949e,stroke-width:1px,color:#f0f6fc
  classDef edge fill:#2d2a4a,stroke:#9d8cf0,stroke-width:1px,color:#f0f6fc
  classDef app fill:#4a1a24,stroke:#ff4f6d,stroke-width:1px,color:#fff5f7
  classDef store fill:#4a3a14,stroke:#d4a72c,stroke-width:1px,color:#fff8e6
  classDef media fill:#173f30,stroke:#3fb68b,stroke-width:1px,color:#eafff6
  classDef svc fill:#163e4c,stroke:#56b6d6,stroke-width:1px,color:#eaf9ff
  classDef fork fill:#4a1d3c,stroke:#e070b0,stroke-width:1px,stroke-dasharray:4 3,color:#fff0f8
  linkStyle default stroke:#8b949e,stroke-width:1.4px
  style FF fill:none,stroke:#ff4f6d,stroke-width:1px,stroke-dasharray:4 4
```

> 🟥 FriendFlix · 🟩 Medienserver · 🟦 weitere Dienste · 🟪 Reverse-Proxy · 🟨 Datenspeicher · ⬛ Zuschauer / extern · gestrichelter Rahmen = Netz bzw. Grenze · dicke Linie = Videostream · gepunktet = optional / über öffentliche URL

- Öffentlich ist nur der Proxy. `web`, `backend` und `gateway` sind nur auf `127.0.0.1` veröffentlicht; Jellyfin und der Wunsch-Dienst haben gar keine Ports und hängen im internen Netz `media`, Postgres und Redis im internen Netz `db`.
- Alle Videodaten (Playlists, Segmente, Direct Play, Bilder, Untertitel, Downloads, Chromecast) laufen durch das Gateway: ohne Pufferung, mit HTTP-Range, Jellyfin-Tokens nur serverseitig, Pfad-Allowlist, fester Upstream, Bitrate-Grenze pro Rolle.
- Container laufen ohne Root, mit schreibgeschütztem Dateisystem, `cap_drop: ALL` und `no-new-privileges`. Strikte CSP, CSRF-Tokens, Rate-Limits, Audit-Log.
- Der Medienserver hängt hinter einer neutralen Schnittstelle (`MediaServer` im Backend, ein `Upstream`-Adapter im Gateway, gewählt über `MEDIA_SERVER`). Jellyfin ist hier die einzige Implementierung; ein weiterer Server kommt überwiegend über neue Dateien dazu – Container, Netze, der Ablauf von „Play drücken“ und die Schnittstelle stehen in [docs/architecture.md](docs/architecture.md).
- Alternative „Plan B“: nginx liefert `/media/` selbst über `auth_request` aus – [docs/operations.md](docs/operations.md).

### Betrieb

- **Backups:** Der optionale Sidecar `backup` macht täglich um `BACKUP_HOUR` einen `pg_dump`, prüft jeden Dump mit `pg_restore --list`, behält `BACKUP_KEEP_DAYS` Tage und wird `unhealthy`, wenn ein Lauf fehlschlägt. Wiederherstellung und monatlicher Restore-Test (`scripts/restore-test.sh`): [docs/operations.md](docs/operations.md). `APP_ENC_KEY` getrennt von den Dumps im Passwort-Manager aufbewahren.
- **Updates:** *Admin → Update* zeigt die installierte Version und das neueste Release samt Notizen (dazu die Commits auf main) und stößt über Portainer (Webhook oder API) ein Redeploy an. Von Hand: `docker compose -f compose.prod.yaml pull && docker compose -f compose.prod.yaml up -d`. Datenbank-Migrationen laufen beim Start.
- **Monitoring:** `/health` (Liveness) und `/health/ready` (Redis, Postgres, Jellyfin) auf `127.0.0.1:3081`; Prometheus-Metriken unter `:3081/metrics` und `:3082/metrics` (Bearer `METRICS_TOKEN`). Beispiele für Icinga und Prometheus sowie ein optionaler Prometheus-+-Grafana-Stack mit fertigem Dashboard (`compose.monitoring.yaml`, internes Netz, kein Standardpasswort): [docs/monitoring.md](docs/monitoring.md).
- **Lieferkette:** Images werden gescannt (Trivy), keyless mit cosign signiert und mit SBOM- und Provenienz-Attestations veröffentlicht; vor dem Deployen lassen sie sich prüfen – [docs/operations.md](docs/operations.md). Die Builds sind reproduzierbar: jedes Release lässt sich aus dem Quellcode nachbauen und ergibt denselben Image-Digest – [docs/reproducible-builds.md](docs/reproducible-builds.md) (englisch).
- **Ladezeiten:** Jede API-Antwort trägt einen `Server-Timing`-Header (`jf` = Jellyfin, `db` = Postgres, `kv` = Redis, `app` = gesamt), das Gateway ergänzt `authz` und `upstream`; sichtbar in den Browser-DevTools unter *Network → Timing*. Anfragen ab 500 ms erscheinen als `slow request` im Log. Browser-Fehler landen im Backend-Log und in `friendflix_client_errors_total`.

### Versionen und Releases

FriendFlix nutzt [SemVer](https://semver.org) (`version.json`, angezeigt in der Fußzeile am Desktop und unter *Admin → Update*). Jede Hauptversion bekommt einen Codenamen: den nächsten Kino-Snack von A bis Z (1 = Arancini, 2 = Brezel, …; Liste in `codenames.json`). Releases entstehen über den manuellen Workflow **Release** (patch / minor / major): er erhöht die Version (`none` veröffentlicht beim allerersten Release 1.0.0 unverändert), verschiebt den *Unreleased*-Teil des [CHANGELOG.md](CHANGELOG.md) unter die neue Version, setzt den Tag `vX.Y.Z` und legt das GitHub-Release an. Gepusht wird mit dem optionalen Secret `RELEASE_TOKEN` (ein fine-grained Token, einziger Bypass-Akteur der Rulesets für main und Tags; ohne ihn muss main direkte Pushes von GitHub Actions zulassen). Die Images erscheinen danach als `X.Y.Z`, `X.Y`, `X` und, nur für die höchste Version, `latest`; mit `FF_TAG=1` bleibt die Installation auf Hauptversion 1 und bekommt trotzdem deren Minor- und Patch-Releases. Details: [docs/operations.md](docs/operations.md#release-erstellen).

### Entwicklung

Node.js ≥ 22, npm-Workspaces `backend`, `gateway`, `web`.

```bash
npm ci
npm run lint && npm run typecheck && npm test   # Backend-Tests brauchen Postgres: TEST_DATABASE_URL=postgres://postgres@localhost:5433/ff_test
npm run dev -w backend                          # API auf :3000
npm run dev -w web                              # UI auf :5173 (Proxy auf backend/gateway)
npm run e2e                                     # Playwright: baut die Web-App und testet sie gegen eine vollständig gemockte API
```

- `E2E_SKIP_BUILD=1` nutzt einen vorhandenen Build; `PW_CHROMIUM=/pfad/zu/chrome` nimmt ein lokal installiertes Chromium.
- `./scripts/setup-hooks.sh` installiert den gitleaks-Pre-Commit-Hook.
- Entwicklung gegen ein http-Authentik: `OIDC_ALLOW_INSECURE=true` (nie in Produktion).
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)): Lint, Typecheck, Tests, `npm audit`, E2E, OWASP-ZAP-Baseline-Scan (DAST, Regeln in `.zap/rules.tsv`), gitleaks und Trivy (Ergebnisse auch im Code-Scanning); Images veröffentlicht [publish.yml](.github/workflows/publish.yml) erst, wenn alles grün ist, mit SBOM- und Provenienz-Attestations und keyless cosign-Signatur – Prüfung und empfohlener Branch-Schutz: [docs/operations.md](docs/operations.md).
- Lieferketten-Prüfung: OpenSSF Scorecard ([scorecard.yml](.github/workflows/scorecard.yml)), wöchentlich und bei jedem Push auf `main`. [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/LetsManu/friendflix/badge)](https://scorecard.dev/viewer/?uri=github.com/LetsManu/friendflix)
- Übersetzungen: Deutsch ist die Quelle, alle anderen Sprachen liegen daneben – wie man eine Sprache korrigiert oder hinzufügt: [docs/i18n.md](docs/i18n.md).

### Dokumentation

| Thema | Datei |
|---|---|
| Installation Schritt für Schritt | [docs/de/setup.md](docs/de/setup.md) |
| Architektur: Container und Netze, Play drücken, Medienserver-Schnittstelle | [docs/architecture.md](docs/architecture.md) |
| Authentik: Installation, Provider, Flows, Einladungen | [docs/de/authentik.md](docs/de/authentik.md) |
| Jellyfin, Wunsch-Dienst, ntfy/Discord, Web-Push | [docs/integrations.md](docs/integrations.md) |
| Backups, Wiederherstellung, Firewall, Updates, Image-Prüfung, Branch-Schutz, Plan B | [docs/operations.md](docs/operations.md) |
| Monitoring, Metriken, Grafana-Dashboard, Server-Timing, Browser-Fehler | [docs/monitoring.md](docs/monitoring.md) |
| Offline-Downloads (Plattformen, Speicher, Grenzen) | [docs/downloads.md](docs/downloads.md) |
| TV-Modus und Handy als Fernbedienung | [docs/tv-mode.md](docs/tv-mode.md) |
| Chromecast und AirPlay | [docs/cast.md](docs/cast.md) |
| Such- und Entdecken-API, Labels, Bald weg, Qualität, Regeln für Kinderprofile | [docs/discovery.md](docs/discovery.md) |
| Themenlisten, Ruhiger Modus, Klang im Player, Handy-Verknüpfungen und Badge | [docs/personal.md](docs/personal.md) |
| UI-Kit und Admin-Rahmen | [docs/ui-kit.md](docs/ui-kit.md) |
| Sprachen und Übersetzungen | [docs/i18n.md](docs/i18n.md) |
| Änderungen | [CHANGELOG.md](CHANGELOG.md) |

### Bekannte Einschränkungen

- Ein Backend-Replikat: Watch-Party-Räume, Rate-Limits und Fernbedienungs-Räume liegen im Speicher.
- Bildbasierte Untertitel (PGS) werden nicht angeboten; Text-Untertitel kommen als WebVTT.
- Intro überspringen braucht Jellyfin ≥ 10.10 mit Media Segments (z. B. vom Intro-Skipper-Plugin).
- Die APIs von Jellyfin, Wunsch-Dienst und Authentik unterscheiden sich je Version – nach Upgrades siehe [docs/operations.md](docs/operations.md) und [docs/integrations.md](docs/integrations.md).
- Optional: ein Seerr-kompatibler Wunsch-Dienst für Wünsche – siehe [docs/integrations.md](docs/integrations.md). Mit Jellyfin sind Profile versteckte Jellyfin-Nutzer: den automatischen Jellyfin-Nutzerimport im Wunsch-Dienst ausschalten, damit sie nicht auftauchen. Ein Medienserver ohne Jellyfin-Konten bekommt stattdessen je FriendFlix-Konto einen lokalen Nutzer im Wunsch-Dienst.
- In diesem Repository ist nur Jellyfin umgesetzt. Besetzung & Infos, Szenen und die Bild-/Ton-Chips brauchen vom Medienserver Besetzungslisten, Kapitel und Stream-Details; kann er sie nicht liefern, blendet die Oberfläche die Funktion aus (`capabilities` in `/api/me`).
- „Bald nicht mehr verfügbar“ ist eine Ankündigung eines Admins; FriendFlix löscht nie Medien. Das Label „Staffelfinale“ ist eine Heuristik (letzte Folge der neuesten Staffel ist neu, die Serie läuft nicht mehr weiter). Der Bildqualitäts-Filter liest einen Hintergrund-Index (`BACKGROUND_JOBS=true`), der sich nach dem ersten Start erst nach und nach füllt.
- Klare Stimmen und Nachtmodus nutzen die Audioverarbeitung des Browsers: nicht auf jedem Gerät verfügbar und nicht beim Streamen auf ein anderes Gerät. PWA-Widgets für den Home-Bildschirm gibt es nur unter Windows 11; Verknüpfungen und das Symbol-Badge (nicht auf jeder iOS-Version) sind der Ersatz auf dem Handy.
- Mit Intel QSV/VAAPI in Jellyfin „VPP Tone mapping“ ausschalten, wenn der Treiber kein HDR kann; sonst scheitern 4K-HDR-Titel.
- Kinderprofile sind ein Jugendschutz, kein Schloss gegen jemanden, der den Konto-Login kennt. Die PIN des Hauptprofils setzt „PIN vergessen?“ (`/auth/login?resetPin=1`) zurück: Das verlangt eine frische Anmeldung bei Authentik (geprüft über `auth_time` im Token) und wird auf jedem Gerät abgelehnt, das an ein Kinderprofil gebunden ist – der Inhaber setzt sie auf seinem eigenen Gerät zurück. Den Authentik-Login (samt zweitem Faktor) also nicht den Kindern überlassen. Ist gar keine PIN gesetzt, lässt sich ein Kinderprofil frei verlassen; der Inhaber bekommt dann einen Hinweis, eine PIN zu setzen.

### Mitmachen


Wie Entscheidungen getroffen werden, steht in [GOVERNANCE.md](GOVERNANCE.md). Beiträge sind willkommen – die Anforderungen (Code-Standard, Tests, alle 7 Sprachen) stehen in [CONTRIBUTING.md](CONTRIBUTING.md), Sicherheitslücken bitte wie in [SECURITY.md](SECURITY.md) beschrieben melden.


### Lizenz

Copyright © 2026 Manuel Weißböck.

FriendFlix ist freie Software: Du darfst sie unter den Bedingungen der **GNU Affero General Public License v3.0 oder später** (AGPL-3.0-or-later) weitergeben und verändern – siehe [LICENSE](LICENSE). Wer eine veränderte Version als Dienst für andere betreibt, muss ihnen deren Quellcode anbieten. FriendFlix kommt ohne jede Gewährleistung.

### Markenhinweis

Netflix, Disney+, Prime Video, Crunchyroll, Plex, Jellyfin, TMDB, OMDb, IMDb, Rotten Tomatoes, Metacritic, TVDB, Trakt und weitere genannte Namen sind Marken ihrer jeweiligen Inhaber. FriendFlix ist ein unabhängiges Open-Source-Projekt und steht in keiner Verbindung zu diesen Anbietern; es wird von ihnen weder gesponsert noch empfohlen. This product uses the TMDB API but is not endorsed or certified by TMDB.
