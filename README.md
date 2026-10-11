# FriendFlix

Privates Streaming-Portal für Freunde vor **Jellyfin** und **Seerr**. Freunde sehen nur das Portal – nie Jellyfin oder Seerr direkt.
Lizenz: All rights reserved (`LICENSE`). Code & Kommentare Englisch, UI Deutsch.

## Architektur

```
Freunde ─► Nginx Proxy Manager (TLS, einziger öffentlicher Eingang, EIN Proxy-Host)
             ├─ /            ─► web      (SvelteKit-UI, installierbare PWA)
             ├─ /api /auth /ws ─► backend  (Fastify: API + WebSocket)
             └─ /media/      ─► gateway  (Streaming-Pipe, Token serverseitig; inkl. /media/c/ Chromecast, /media/d/ Downloads) ─► Jellyfin ─► Medien
backend ─► Jellyfin (Admin-Key nur hier; Nutzer-Token pro Profil)   backend ─► Seerr (Wunschliste)
backend ─► Postgres, Redis (Netz `db`, intern)       Login: Authentik (OIDC + PKCE, MFA Pflicht)
```

| Netz | Typ | Mitglieder |
|---|---|---|
| `front` | normal (Bridge) | web, backend, gateway – nur dafür, dass Docker Ports an `127.0.0.1` veröffentlichen kann |
| `db` | internal | postgres, redis, backend, backup |
| `media` | internal | backend, gateway, jellyfin, seerr |
| `egress` | normal (nur ausgehend) | backend (OIDC/ntfy/Push-Dienste), jellyfin/seerr (Metadaten) |

Jellyfin und Seerr haben **kein Port-Mapping** und **keinen NPM-Host**; zusätzlich Host-Firewall (`docs/operations.md`).
Alle Videodaten (HLS-Playlists, Segmente, Direct-Play, Bilder, Untertitel) laufen durch das Gateway: Pipe ohne Pufferung, HTTP-Range, Jellyfin-Token nur serverseitig, Pfad-Allowlist, fester Upstream-Host (SSRF), Bitrate-Clamp pro Rolle, keine Redirects.

## Schnellstart

```bash
git clone git@github.com:LetsManu/friendflix.git && cd friendflix
./scripts/setup-hooks.sh                     # gitleaks pre-commit (gitleaks muss installiert sein)
cp .env.example .env
openssl rand -base64 32   # -> APP_ENC_KEY      openssl rand -hex 24  # -> INTERNAL_SECRET, WEBHOOK_SECRET, METRICS_TOKEN
$EDITOR .env
# NPM erreicht das Portal über 127.0.0.1:3080/3081/3082 (nur lokal gebunden) – kein gemeinsames Docker-Netz nötig
docker compose up -d --build                 # Jellyfin/Seerr laufen schon.   Gebündelt: --profile bundled
docker compose --profile backup up -d backup # optional: tägliche DB-Backups
docker compose ps                            # alle "healthy"
```
**Fertige Images statt Build auf dem Server:** GitHub Actions (`publish.yml`, aufgerufen von `ci.yml` erst nachdem Tests, Secret- und Image-Scan grün sind) veröffentlicht bei jedem Push auf `main` und jedem `v*`-Tag nach `ghcr.io/letsmanu/friendflix-{backend,gateway,web}` (Tags `latest`, Kurz-SHA, `vX.Y.Z`). Auf dem Server: `docker login ghcr.io -u <user>` (PAT mit `read:packages`, oder Paket auf *Public* stellen), dann `docker compose -f compose.prod.yaml pull && docker compose -f compose.prod.yaml up -d`. Das `up -d` legt auch die Volumes `previews` (Vorschau-Clips) und `downloads` (Offline-Downloads) an. Version festnageln: `FF_TAG=<sha>` in `.env`.
Läuft Jellyfin/Seerr bereits als eigener Stack: `docker network connect friendflix_media <container>`, vom NPM-/Host-Netz trennen, Ports aus deren Compose entfernen, `JELLYFIN_URL`/`SEERR_URL` anpassen.

Dann:
1. **Authentik** einrichten, **MFA erzwingen** → `docs/integrations.md`
2. **NPM**: ein Proxy Host `portal.<domain>` → `127.0.0.1` Port `3080` (http), Websockets an, Force SSL/HTTP2/HSTS; Advanced-Tab: `deploy/npm/portal.advanced.conf` (leitet `/api /auth /ws` an `:3081`, `/media/` an `:3082`). Die Location `/media/c/` (Chromecast) dort hat `access_log off` und `error_log /dev/null` – nicht entfernen, sonst landet das Cast-Token in Logs (`docs/cast.md`). Läuft NPM selbst in einem Bridge-Container, statt `127.0.0.1` die Docker-Host-IP eintragen und `BIND_ADDR` in `.env` darauf setzen. Optional Authentik-Forward-Auth für Admin-Pfade: `deploy/npm/admin-auth-request.conf`.
3. **Jellyfin**: Admin-API-Key anlegen (Dashboard → API-Schlüssel). Webhook-Plugin (optional; ohne Plugin fragt das Portal die Sitzungen alle 10 s ab, „Erinnere mich“ prüft dann alle 30 min) → `docs/integrations.md`: Ziel `http://backend:3000/internal/webhook/jellyfin`, Ereignisse Playback Start/Progress/Stop und **Item Added**, Header `X-Webhook-Secret: <WEBHOOK_SECRET>`. Für Item Added müssen die Template-Felder `{{ItemType}}`, `{{Provider_tmdb}}`, `{{SeriesId}}`, `{{SeasonNumber}}`, `{{EpisodeNumber}}` im JSON-Template stehen (vollständiges Template in `docs/integrations.md`).
4. **Seerr**: API-Key + Webhook → `docs/integrations.md`
5. **Web Push** (optional): `node scripts/gen-vapid.mjs` (oder `npx web-push generate-vapid-keys`) → die beiden Zeilen `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` in `.env`, dann `docker compose up -d`. Ohne beide Schlüssel bleibt Push aus. Mit Docker Secrets (`compose.secrets.yaml`) muss `secrets/vapid_private_key` existieren; eine leere Datei heißt „aus“. Das Schlüsselpaar nicht mehr ändern, sonst werden alle Geräte-Abos ungültig.
6. **Offline-Downloads** (optional): keine zusätzliche Einrichtung. Das Backend-Image bringt `ffmpeg` mit, `compose.prod.yaml` legt das Volume `downloads` an. Speicher über `DOWNLOAD_CACHE_MAX_GB` begrenzen → `docs/downloads.md`.
7. **Chromecast** (optional): braucht `PUBLIC_URL` mit öffentlich gültigem https-Zertifikat und die NPM-Location `/media/c/` (Schritt 2) → `docs/cast.md`.
8. **Updates**: *Admin → Update* zeigt neue Versionen und stößt per Portainer ein Redeploy an. Dafür `PORTAINER_*` setzen; Portainer über IP-Adresse ansprechen (z. B. `http://192.168.1.10:8181/portainer/…`), nicht über `.local`-Namen → `docs/operations.md`.
9. **Plan B** (NPM liefert `/media/` über `auth_request` statt Gateway, `deploy/npm/plan-b-auth-request.conf`): dort `CAST_ENABLED=false` und `DOWNLOADS_ENABLED=false` setzen, denn Chromecast und Offline-Downloads gehen darüber nicht → `docs/operations.md`.
10. Erster Login mit einem Mitglied der Authentik-Gruppe `friendflix-admins` → wird Portal-Admin. Danach Einladungen unter *Admin → Einladungen*.

## Konfiguration (.env)

Vorlage: `.env.example`. Jede Variable mit `_FILE`-Endung (z. B. `VAPID_PRIVATE_KEY_FILE`) kann stattdessen auf eine Datei zeigen, etwa ein Docker Secret (`compose.secrets.yaml`).

**Basis & Sicherheit**

| Variable | Standard | Bedeutung |
|---|---|---|
| `PUBLIC_URL` | – (Pflicht) | öffentliche URL (https) |
| `APP_ENC_KEY` | – (Pflicht) | 32 Byte base64 (`openssl rand -base64 32`); verschlüsselt Jellyfin-Passwörter/Tokens (AES-256-GCM). Verlust = Nutzer müssen neu angelegt werden |
| `INTERNAL_SECRET` | – (Pflicht, ≥ 16 Zeichen) | Backend ↔ Gateway |
| `WEBHOOK_SECRET` | – (Pflicht, ≥ 16 Zeichen) | Jellyfin-/Seerr-Webhooks |
| `METRICS_TOKEN` | leer | Bearer für `/metrics` |
| `ADMIN_GROUP` | `friendflix-admins` | Authentik-Gruppe, deren Mitglieder Portal-Admins werden |
| `SESSION_TTL_SECONDS` | `28800` (8 h) | absolute Sitzungsdauer |
| `SESSION_IDLE_SECONDS` | `7200` (2 h) | Sitzung läuft nach so viel Inaktivität ab |
| `ROLE_TEMPLATES` | leer | JSON-Override der Rollenvorlagen (`backend/src/roles.ts`) |
| `OIDC_ALLOW_INSECURE` | `false` | nur Entwicklung: http-Authentik erlauben |
| `PORT` | `3000` | interner Port des Backends im Container |

**Login & Dienste**

| Variable | Standard | Bedeutung |
|---|---|---|
| `OIDC_ISSUER` | – (Pflicht) | Authentik-Issuer, z. B. `https://auth.example.com/application/o/friendflix/` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | – (Pflicht) | Authentik-Provider → `docs/integrations.md` |
| `AUTHENTIK_URL` | leer | öffentliche Authentik-URL für Einladungen mit Kontoerstellung |
| `AUTHENTIK_API_TOKEN` | leer | API-Token (Intent „API“) |
| `AUTHENTIK_ENROLL_FLOW` | leer | Slug des Enrollment-Flows; Feature nur aktiv, wenn alle drei gesetzt sind |
| `JELLYFIN_URL` | – (Pflicht) | interne Jellyfin-URL, z. B. `http://jellyfin:8096` |
| `JELLYFIN_ADMIN_API_KEY` | – (Pflicht) | Admin-API-Key, nur im Backend |
| `SEERR_URL`, `SEERR_API_KEY` | – (Pflicht) | Seerr (intern) |
| `DATABASE_URL`, `REDIS_URL` | – | von `compose.prod.yaml` aus `POSTGRES_PASSWORD`/`REDIS_PASSWORD` gebaut |

**Benachrichtigungen & Wochenrückblick**

| Variable | Standard | Bedeutung |
|---|---|---|
| `NTFY_URL` | leer | gemeinsamer ntfy-Kanal („verfügbar“, Freigaben, Filmabend) |
| `NTFY_BASE_URL` | Host von `NTFY_URL` | ntfy-Server für persönliche Themen (Einstellungen → „ntfy-Thema“). Persönliche Nachrichten (Wochenrückblick, „Erinnere mich“) gehen nie an den gemeinsamen Kanal oder Discord |
| `DISCORD_WEBHOOK_URL` | leer | Discord für Freigaben/Filmabend |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | leer | Web Push; aktiv nur, wenn beide gesetzt sind. Erzeugen mit `node scripts/gen-vapid.mjs` |
| `VAPID_SUBJECT` | `PUBLIC_URL` | `mailto:` oder `https:` als Kontakt für Push-Dienste |
| `DIGEST_DAY` | `0` | Wochenrückblick-Wochentag (0 = Sonntag … 6 = Samstag); im Admin-Bereich überschreibbar |
| `DIGEST_HOUR` | `18` | Serverstunde (0-23), `-1` = aus; im Admin-Bereich überschreibbar |

**Wiedergabe & Features**

| Variable | Standard | Bedeutung |
|---|---|---|
| `CAST_ENABLED` | `true` | Chromecast-Senden; wirkt nur mit https-`PUBLIC_URL`. Plan B: `false` → `docs/cast.md` |
| `PREVIEW_DIR` | `/data/previews` | Ablage der Vorschau-Clips (Volume `previews`) |
| `PREVIEW_WARM` | `true` | Hintergrundjob, der Vorschau-Clips vorab erzeugt (ein Titel pro Minute); `false` = aus |
| `PLAYBACK_CHECK_HOUR` | `4` | Stunde des nächtlichen Wiedergabe-Checks; Admins werden bei neuen Fehlern benachrichtigt; `-1` = aus |
| `BACKGROUND_JOBS` | `true` | `false` schaltet Download-Vorbereitung, Download-Aufräumung und das Jellyfin-Session-Polling ab (übrige Timer laufen weiter) |
| `DOWNLOADS_ENABLED` | `true` | Offline-Downloads; Plan B: `false` → `docs/downloads.md` |
| `DOWNLOAD_DIR` | `/data/downloads` | Ablage der vorbereiteten Download-Dateien (Volume `downloads`) |
| `DOWNLOAD_CACHE_MAX_GB` | `50` | Obergrenze für vorbereitete Dateien in GB; die ältesten werden zuerst entfernt |
| `DOWNLOAD_PREP_CONCURRENCY` | `1` | gleichzeitige Vorbereitungen (1-4) |
| `DOWNLOAD_PAUSE_STREAMS` | `2` | Vorbereitung pausiert, solange so viele Streams laufen; `0` = nie |
| `DOWNLOAD_FILE_TTL_HOURS` | `48` | ungenutzte vorbereitete Dateien werden nach so vielen Stunden gelöscht |
| `DOWNLOAD_OFFLINE_GRACE_DAYS` | `7` | wie lange eine Kopie ohne Online-Prüfung abspielbar bleibt |
| `DOWNLOAD_CREATE_PER_HOUR` | `20` | Rate-Limit für neue Download-Lizenzen pro Stunde und Sitzung |
| `DOWNLOAD_MIN_FREE_GB` | `2` | Mindestens so viel freier Platz (GB) muss auf dem Download-Volume bleiben, sonst wartet die Vorbereitung |

**Zeit, Update & Build**

| Variable | Standard | Bedeutung |
|---|---|---|
| `TZ` | `Europe/Vienna` | Zeitzone des Backends; gilt für `DIGEST_HOUR` und `PLAYBACK_CHECK_HOUR` |
| `UPDATE_REPO` | `LetsManu/friendflix` | GitHub-Repo für die Versionsprüfung (*Admin → Update*) |
| `GITHUB_TOKEN` | leer | optional; hebt das GitHub-Limit von 60 Anfragen/h an |
| `PORTAINER_WEBHOOK_URL` | leer | Stack-Webhook für den Update-Knopf (Alternative zur API) |
| `PORTAINER_URL`, `PORTAINER_API_KEY`, `PORTAINER_STACK_ID` | leer | Portainer-API (Alternative zum Webhook); die Stack-ID steht in der Stack-URL |
| `PORTAINER_ENDPOINT_ID` | `1` | Portainer-Endpoint |
| `GIT_SHA`, `BUILD_TIME` | `dev` / leer | werden beim Image-Build gesetzt; nicht von Hand setzen |

Portainer-Secrets (Webhook-URL und API-Key) gehören in `.env` oder Docker Secrets, nicht in Logs. Details: `docs/operations.md`.

**Compose-Variablen** (`.env`, nur für `compose.prod.yaml`/`compose.yaml`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | – (Pflicht) | Datenbank- und Redis-Passwort |
| `BIND_ADDR` | `127.0.0.1` | Adresse, auf der web/backend/gateway veröffentlicht werden; nie eine öffentliche Schnittstelle |
| `WEB_PORT`, `BACKEND_PORT`, `GATEWAY_PORT` | `3080`, `3081`, `3082` | Host-Ports für NPM |
| `FF_REGISTRY`, `FF_TAG` | `ghcr.io/letsmanu`, `latest` | Images und Version (`FF_TAG=<sha>` oder `x.y.z` zum Festnageln) |
| `MEDIA_PATH` | `./media` | Medienordner für das optionale Bundle-Jellyfin (`--profile bundled`) |
| `BACKUP_PATH`, `KEEP_DAYS` | `./backups`, `14` | Ziel und Aufbewahrung des Backup-Sidecars |

## Funktionen
- **Profile** („Wer schaut gerade?“): bis 5 Profile pro Konto, optional mit 4-stelliger PIN. Jedes Profil hat eigenen Verlauf, Favoriten, Watchlist und Wiedergabe-Einstellungen. Stream-Limit, Wünsche, Bewertungen und Admin-Rechte bleiben beim Konto (Admin nur über das Owner-Profil). „PIN vergessen?“ führt zur erneuten Anmeldung, die die PIN zurücksetzt.
- **Schauen**: Bibliothek, Suche, Weiterschauen (aufgeräumt: keine fast fertigen oder kaum begonnenen Titel, eine Karte pro Serie, ausblendbar mit X), nächste Folge, Favoriten, Watchlist, Gesehen-Status, **Verlauf** (einzelne Folgen oder ganze Serien entfernen), Untertitel + Tonspur wählbar, **Untertitel-Stil** (Größe, Farbe, Hintergrund, Schrift). Direct Play als Standard, sonst HLS (hls.js). Das Portal meldet Playing/Progress/Stopped an Jellyfin.
- **Komfort & Schutz**: „Schaust du noch?“ nach mehreren automatisch gestarteten Folgen oder 90 Minuten ohne Eingabe. **Spoilerschutz** für ungesehene Folgen.
- **Erinnere mich**: auf „Demnächst“ und im Serien-Kalender; Benachrichtigung, sobald der Titel in der Bibliothek ist.
- **Geteilte Listen**: der Besitzer lädt Editoren oder Leser ein. Gezeigt werden nur Titel, die für das Profil des Betrachters sichtbar sind.
- **Wochenrückblick** (`/digest`): neue Filme und Folgen, neue Folgen gefolgter Serien, erfüllte Wünsche, Tipps von Freunden. Zeitplan über `DIGEST_DAY`/`DIGEST_HOUR` oder *Admin → Wochenrückblick*, abschaltbar in den Einstellungen. Versand an das persönliche ntfy-Thema.
- **Benachrichtigungen**: In-App, ntfy, Discord und **Web Push pro Gerät** (*Einstellungen → Benachrichtigungen*, „Test senden“).
- **Installierbare App (PWA)** mit Offline-Seite. Der Service Worker cached nur statische Dateien, nie API, Medien oder HTML.
- **Chromecast**: Senden aus Chrome/Edge/Android über den Default Media Receiver (`docs/cast.md`).
- **Offline-Downloads** (*Menü → Downloads*, `/offline`): Filme und Folgen aufs Gerät laden, Lizenz pro Gerät mit Ablauf und Online-Prüfung (`docs/downloads.md`).
- **Watch-Party**: eigener WebSocket-Sync (Host steuert, Drift-Korrektur ab 300 ms, Raum wartet auf Puffer aller), Chat, Emoji-Reaktionen.
- **Filmabend-Voting** mit Countdown und Auto-Start; Titel außerhalb der Bibliothek → Admin-Freigabe → Seerr-Request → automatisch geplant, sobald verfügbar.
- **Konten**: Einmal-Einladungslinks (gehasht gespeichert, Ablauf, atomar einlösbar) → Authentik-Konto + MFA → Jellyfin-Konto mit Zufallspasswort + Rollenvorlage (Freund/Familie/Gast: Bibliotheken, Altersfreigabe, Bitrate, max. Streams, Transcoding/Download; Gast max. 1080p). Geräte-Freigabe für neue Geräte.
- **Wünsche** (Seerr) im Namen des Nutzers, Status, Admin-Freigabe, Webhook → Benachrichtigung (in-App, ntfy, Discord). Pro Rolle gibt es ein monatliches Wunsch-Limit (Standard 2, Admin unbegrenzt), einstellbar unter *Admin → Rollen*; über Abstimmungen freigegebene Titel zählen nicht mit.
- **Entdecken & Gruppe**: Netflix-ähnliche Oberfläche (Billboard, Reihen, Hover-Karten, Top 10), Gruppen-Matcher („Was hat noch keiner von uns gesehen?“), Empfehlungen an Freunde, „Demnächst“ aus Seerr, Sammlungen/Studios, Szenen teilen, Lesezeichen, X-Ray.
- **Fernseher**: TV-Modus mit Pfeiltasten-Navigation, Kopplung per Code/QR, Handy als Fernbedienung → `docs/tv-mode.md`.
- **Vorschau-Clips**: Beim Hover über eine Karte oder das Billboard läuft ein ca. 30 Sekunden langer Clip. Jellyfin erzeugt jeden Clip einmal (960p H.264/AAC). Das Backend legt ihn im Volume `previews` ab und liefert ihn danach allen Nutzern inklusive Gästen als Datei aus. Ein Hintergrundjob füllt den Cache (`PREVIEW_WARM`); fehlgeschlagene Titel werden nach 7 Tagen erneut versucht oder sofort über die Admin-Seite. Die Nutzer-Einstellung „Ohne Trailer: Ausschnitt“ ist standardmäßig an.
- **Trailer für anfragbare Titel**: Titel, die über Seerr angefragt werden können, aber nicht in der Bibliothek sind, bekommen einen Button „Trailer“. Er spielt den TMDB-Trailer im datenschutzfreundlichen `youtube-nocookie.com`-Player; zu YouTube wird erst nach dem Klick geladen.
- **Wrapped, Achievements, Läuft gerade**, Bewertungen mit Kurzreview, Serien-Kalender mit Benachrichtigung.
- **Admin**: *Update* zeigt installierte und neueste Version samt Änderungsliste und stößt per Portainer ein Update an. Status, Nutzer/Rollen, Einladungen, Wünsche, Abstimmungen, Geräte, Audit-Log, Wochenrückblick. `/admin/previews` zeigt den Clip-Status mit „Neu erzeugen“ je Titel. `/admin/playback` zeigt den Wiedergabe-Check (läuft nachts per `PLAYBACK_CHECK_HOUR`, lässt sich dort auch manuell starten): Er transkodiert von jedem Titel einige Sekunden testweise, listet Fehler auf (Details im FFmpeg-Log in Jellyfin) und zeigt die Offline-Downloads mit Widerruf.

## Sicherheit
OIDC + PKCE, MFA über Authentik-Flow · Sessions nach `SESSION_TTL_SECONDS` absolut und nach `SESSION_IDLE_SECONDS` ohne Aktivität, httpOnly/Secure/SameSite=Lax · CSRF-Token für alle schreibenden `/api`-Aufrufe · WebSocket: Origin- + Session-Prüfung · zod-Validierung überall · Rate-Limiting (global + strenger auf `/auth`, Einladungen, Downloads) · Audit-Log · Geräte-Freigabe · Jellyfin-Passwörter AES-GCM-verschlüsselt, Tokens nie im Browser · Cast-Tokens: 256 Bit, nur HLS, an die erste Client-Adresse gebunden (`docs/cast.md`) · Gateway: Allowlist, kein Redirect-Follow, Header-Whitelist · Container: non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, Healthchecks · strikte CSP (UI), Security-Header (API) · CI: Lint, Tests, gitleaks, Trivy, Dependabot.

## Entwicklung
```bash
npm ci && npm run lint && npm run typecheck && npm test      # Backend-Tests brauchen Postgres: TEST_DATABASE_URL=postgres://postgres@localhost:5433/ff_test
npm run dev -w backend   # :3000     npm run dev -w web   # :5173 (Proxy auf backend/gateway)
```
Dev gegen http-Authentik: `OIDC_ALLOW_INSECURE=true` (nur Entwicklung).

## Bekannte Einschränkungen / zu prüfen
- Jellyfin-API-Pfade variieren je Version → `scripts/gen-jellyfin-client.sh` gegen die eigene Instanz laufen lassen; Views/Resume/Item/Favorit/Gesehen haben Alt/Neu-Fallback.
- Seerr-Endpunkt für den Jellyfin-Nutzerimport (`/user/import-from-jellyfin`) je Version prüfen. Bei Profilen den automatischen Import in Seerr ausschalten, damit Profil-Nutzer dort nicht auftauchen (`CHANGELOG.md`).
- Authentik-Einladungs-API und Enrollment-Flow sind versionsabhängig (optional; Portal funktioniert auch ohne).
- Watch-Party-Räume, Rate-Limits und Fernbedienungs-Räume liegen im Speicher → **ein** Backend-Replikat. Mehrere Replikate bräuchten Redis-Pub/Sub.
- Bildbasierte Untertitel (PGS) werden nicht angeboten (nur Text-Untertitel als WebVTT).
- Intro-Überspringen braucht Jellyfin ≥ 10.10 (Media Segments, z. B. per Intro-Skipper-Plugin befüllt); ältere Server liefern keine Segmente.
- Direct Play umgeht den Bitrate-Clamp nur nicht, weil `directUrl` nur bei Quell-Bitrate ≤ Rollenlimit angeboten wird.
- Now-Playing aktualisiert per Polling (5 s), nicht per WebSocket.
- TV-Modus auf echten Fernsehern je Modell prüfen (`docs/tv-mode.md`).
- Offline-Downloads sind **kein DRM**: Die Dateien liegen unverschlüsselt im Browser- bzw. Server-Speicher (`docs/downloads.md`).
- Chromecast auf echter Hardware je Modell prüfen (`docs/cast.md`, Abschnitt „Auf echter Hardware prüfen“).
- **Jellyfin-Einstellungen** (Dashboard → Wiedergabe → Transkodierung):
  - Mit Intel QSV/VAAPI muss „VPP Tone mapping“ aus sein, wenn der Treiber kein HDR unterstützt. Sonst schlägt jeder 4K-HDR-Film fehl (FFmpeg: `tonemap_vaapi … VAAPI driver doesn't support HDR`). „Tone mapping“ (OpenCL) bleibt an.

Weitere Doku: `docs/cast.md`, `docs/downloads.md`, `docs/integrations.md`, `docs/operations.md`, `docs/monitoring.md`, `docs/tv-mode.md`, `CHANGELOG.md` (Unreleased: Blöcke 1–5).
GitHub manuell aktivieren: Secret scanning + Push protection, Dependabot alerts; Repo auf **Private**.
