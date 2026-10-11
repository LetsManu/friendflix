# FriendFlix

Privates Streaming-Portal für Freunde vor **Jellyfin** und **Seerr**. Freunde sehen nur das Portal – nie Jellyfin oder Seerr direkt.
Lizenz: All rights reserved (`LICENSE`). Code & Kommentare Englisch, UI Deutsch.

## Architektur

```
Freunde ─► Nginx Proxy Manager (TLS, einziger öffentlicher Eingang, EIN Proxy-Host)
             ├─ /            ─► web      (SvelteKit-UI)
             ├─ /api /auth /ws ─► backend  (Fastify: API + WebSocket)
             └─ /media/      ─► gateway  (Streaming-Pipe, Token serverseitig) ─► Jellyfin ─► Medien
backend ─► Jellyfin (Admin-Key nur hier; Nutzer-Token pro Freund)   backend ─► Seerr (Wunschliste)
backend ─► Postgres, Redis (Netz `db`, intern)       Login: Authentik (OIDC + PKCE, MFA Pflicht)
```

| Netz | Typ | Mitglieder |
|---|---|---|
| `front` | normal (Bridge) | web, backend, gateway – nur dafür, dass Docker Ports an `127.0.0.1` veröffentlichen kann |
| `db` | internal | postgres, redis, backend, backup |
| `media` | internal | backend, gateway, jellyfin, seerr |
| `egress` | normal (nur ausgehend) | backend (OIDC/ntfy), jellyfin/seerr (Metadaten) |

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
**Fertige Images statt Build auf dem Server:** GitHub Actions (`publish.yml`, aufgerufen von `ci.yml` erst nachdem Tests, Secret- und Image-Scan grün sind) veröffentlicht bei jedem Push auf `main` und jedem `v*`-Tag nach `ghcr.io/letsmanu/friendflix-{backend,gateway,web}` (Tags `latest`, Kurz-SHA, `vX.Y.Z`). Auf dem Server: `docker login ghcr.io -u <user>` (PAT mit `read:packages`, oder Paket auf *Public* stellen), dann `docker compose -f compose.prod.yaml pull && docker compose -f compose.prod.yaml up -d`. Das `up -d` legt auch das neue Volume `previews` an (Vorschau-Clips). Version festnageln: `FF_TAG=<sha>` in `.env`.
Läuft Jellyfin/Seerr bereits als eigener Stack: `docker network connect friendflix_media <container>`, vom NPM-/Host-Netz trennen, Ports aus deren Compose entfernen, `JELLYFIN_URL`/`SEERR_URL` anpassen.

Dann:
1. **Authentik** einrichten, **MFA erzwingen** → `docs/integrations.md`
2. **NPM**: ein Proxy Host `portal.<domain>` → `127.0.0.1` Port `3080` (http), Websockets an, Force SSL/HTTP2/HSTS; Advanced-Tab: `deploy/npm/portal.advanced.conf` (leitet `/api /auth /ws` an `:3081`, `/media/` an `:3082`). Läuft NPM selbst in einem Bridge-Container, statt `127.0.0.1` die Docker-Host-IP eintragen und `BIND_ADDR` in `.env` darauf setzen. Optional Authentik-Forward-Auth für Admin-Pfade: `deploy/npm/admin-auth-request.conf`.
3. **Jellyfin**: Admin-API-Key anlegen (Dashboard → API-Schlüssel); optional Webhook-Plugin → `docs/integrations.md`
4. **Seerr**: API-Key + Webhook → `docs/integrations.md`
5. Erster Login mit einem Mitglied der Authentik-Gruppe `friendflix-admins` → wird Portal-Admin. Danach Einladungen unter *Admin → Einladungen*.

## Konfiguration (.env)
| Variable | Bedeutung |
|---|---|
| `PUBLIC_URL` | öffentliche URL (https) |
| `APP_ENC_KEY` | 32 Byte base64; verschlüsselt Jellyfin-Passwörter/Tokens (AES-256-GCM) |
| `INTERNAL_SECRET` | Backend ↔ Gateway |
| `WEBHOOK_SECRET` | Jellyfin-/Seerr-Webhooks |
| `OIDC_*`, `ADMIN_GROUP` | Authentik |
| `JELLYFIN_URL`, `JELLYFIN_ADMIN_API_KEY` | Jellyfin (intern) |
| `SEERR_URL`, `SEERR_API_KEY` | Seerr (intern) |
| `NTFY_URL`, `DISCORD_WEBHOOK_URL` | Push bei „verfügbar“, Freigaben, Filmabend |
| `METRICS_TOKEN` | Bearer für `/metrics` |
| `PORTAINER_WEBHOOK_URL` oder `PORTAINER_URL`, `PORTAINER_API_KEY`, `PORTAINER_STACK_ID`, `PORTAINER_ENDPOINT_ID` | Update-Knopf unter *Admin → Update* (Webhook oder API, Default Endpoint `1`); Secrets, siehe `docs/operations.md` |
| `UPDATE_REPO`, `GITHUB_TOKEN` | Repo für die Versionsprüfung (Default `LetsManu/friendflix`); Token optional gegen das GitHub-Limit von 60 Anfragen/h |
| `PREVIEW_DIR` | Ablage der Vorschau-Clips (Default `/data/previews`, Volume `previews`) |
| `PREVIEW_WARM` | Hintergrundjob, der Vorschau-Clips vorab erzeugt (Default `true`; `false` schaltet ihn ab) |
| `AUTHENTIK_URL/API_TOKEN/ENROLL_FLOW` | Einladung legt auch das Authentik-Konto an (siehe `docs/integrations.md`) |
| `ROLE_TEMPLATES` | JSON-Override der Rollenvorlagen (`backend/src/roles.ts`) |
Secrets alternativ als Docker Secrets: `compose.secrets.yaml` (`VAR_FILE`).

## Funktionen
- **Schauen**: Bibliothek, Suche, Weiterschauen (geräteübergreifend über Jellyfin), nächste Folge, Favoriten, Watchlist, Gesehen-Status, Untertitel + Tonspur wählbar. Direct Play als Standard, sonst HLS (hls.js). Das Portal meldet Playing/Progress/Stopped an Jellyfin.
- **Konten**: Einmal-Einladungslinks (gehasht gespeichert, Ablauf, atomar einlösbar) → Authentik-Konto + MFA → Jellyfin-Konto mit Zufallspasswort + Rollenvorlage (Freund/Familie/Gast: Bibliotheken, Altersfreigabe, Bitrate, max. Streams, Transcoding/Download). Geräte-Freigabe für neue Geräte.
- **Wünsche** (Seerr) im Namen des Nutzers, Status, Admin-Freigabe, Webhook → Benachrichtigung (in-App, ntfy, Discord). Pro Rolle gibt es ein monatliches Wunsch-Limit (Standard 2, Admin unbegrenzt), einstellbar unter *Admin → Rollen*; über Abstimmungen freigegebene Titel zählen nicht mit.
- **Watch-Party**: eigener WebSocket-Sync (Host steuert, Drift-Korrektur ab 300 ms, Raum wartet auf Puffer aller), Chat, Emoji-Reaktionen.
- **Filmabend-Voting** mit Countdown und Auto-Start; Titel außerhalb der Bibliothek → Admin-Freigabe → Seerr-Request → automatisch geplant, sobald verfügbar.
- **Entdecken & Gruppe**: Netflix-ähnliche Oberfläche (Billboard, Reihen, Hover-Karten, Top 10), Gruppen-Matcher („Was hat noch keiner von uns gesehen?“), Empfehlungen an Freunde, „Demnächst“ aus Seerr, Sammlungen/Studios, Szenen teilen, Lesezeichen, X-Ray.
- **Fernseher**: TV-Modus mit Pfeiltasten-Navigation, Kopplung per Code/QR, Handy als Fernbedienung → `docs/tv-mode.md`.
- **Vorschau-Clips**: Beim Hover über eine Karte oder das Billboard läuft ein ca. 30 Sekunden langer Clip. Jellyfin erzeugt jeden Clip einmal (960p H.264/AAC; Start bei einem Drittel des Films, bei Serien bei einem Viertel der ersten Folge, bei vorhandenem lokalem Trailer ab dessen Anfang). Das Backend legt ihn als MP4 im Volume `previews` (`/data/previews`) ab und liefert ihn danach allen Nutzern inklusive Gästen als Datei aus, ohne neues Transkodieren pro Hover. Ein Hintergrundjob füllt den Cache mit einem Titel pro Minute; fehlgeschlagene Titel werden nach 7 Tagen erneut versucht oder sofort über die Admin-Seite. Die Nutzer-Einstellung „Ohne Trailer: Ausschnitt“ ist standardmäßig an.
- **Trailer für anfragbare Titel**: Titel, die über Seerr angefragt werden können, aber nicht in der Bibliothek sind, bekommen einen Button „Trailer“. Er spielt den TMDB-Trailer im datenschutzfreundlichen `youtube-nocookie.com`-Player; zu YouTube wird erst nach dem Klick geladen.
- **Wrapped, Achievements, Läuft gerade**, Bewertungen mit Kurzreview, Serien-Kalender mit Benachrichtigung.
- **Admin**: *Update* zeigt installierte und neueste Version samt Änderungsliste und stößt per Portainer ein Update an. Status, Nutzer/Rollen, Einladungen, Wünsche, Abstimmungen, Geräte, Audit-Log. `/admin/previews` zeigt den Clip-Status (bereit / fehlgeschlagen / fehlt / in Arbeit) mit „Neu erzeugen“ je Titel und einem Knopf für alle fehlgeschlagenen. `/admin/playback` prüft die Wiedergabe, indem es von jedem Titel einige Sekunden testweise transkodiert, und listet die Fehler auf (Details im FFmpeg-Log in Jellyfin).

## Sicherheit
OIDC + PKCE, MFA über Authentik-Flow · Sessions max. 8 h und 2 h Inaktivität (`SESSION_IDLE_SECONDS`), httpOnly/Secure/SameSite=Lax · CSRF-Token für alle schreibenden `/api`-Aufrufe · WebSocket: Origin- + Session-Prüfung · zod-Validierung überall · Rate-Limiting (global + strenger auf `/auth`, Einladungen) · Audit-Log · Geräte-Freigabe · Jellyfin-Passwörter AES-GCM-verschlüsselt, Tokens nie im Browser · Gateway: Allowlist, kein Redirect-Follow, Header-Whitelist · Container: non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, Healthchecks · strikte CSP (UI), Security-Header (API) · CI: Lint, Tests, gitleaks, Trivy, Dependabot.

## Entwicklung
```bash
npm ci && npm run lint && npm run typecheck && npm test      # Backend-Tests brauchen Postgres: TEST_DATABASE_URL=postgres://postgres@localhost:5433/ff_test
npm run dev -w backend   # :3000     npm run dev -w web   # :5173 (Proxy auf backend/gateway)
```
Dev gegen http-Authentik: `OIDC_ALLOW_INSECURE=true` (nur Entwicklung).

## Bekannte Einschränkungen / zu prüfen
- Jellyfin-API-Pfade variieren je Version → `scripts/gen-jellyfin-client.sh` gegen die eigene Instanz laufen lassen; Views/Resume/Item/Favorit/Gesehen haben Alt/Neu-Fallback.
- Seerr-Endpunkt für den Jellyfin-Nutzerimport (`/user/import-from-jellyfin`) je Version prüfen.
- Authentik-Einladungs-API und Enrollment-Flow sind versionsabhängig (optional; Portal funktioniert auch ohne).
- Watch-Party-Räume und Rate-Limits liegen im Speicher → **ein** Backend-Replikat. Mehrere Replikate bräuchten Redis-Pub/Sub.
- Bildbasierte Untertitel (PGS) werden nicht angeboten (nur Text-Untertitel als WebVTT).
- Intro-Überspringen braucht Jellyfin ≥ 10.10 (Media Segments, z. B. per Intro-Skipper-Plugin befüllt); ältere Server liefern keine Segmente.
- Direct Play umgeht den Bitrate-Clamp nur nicht, weil `directUrl` nur bei Quell-Bitrate ≤ Rollenlimit angeboten wird.
- Now-Playing aktualisiert per Polling (5 s), nicht per WebSocket.
- Fernbedienung/Kopplung: Räume und Verbindungen liegen im Speicher (ein Backend-Replikat); TV-Modus auf echten Fernsehern je Modell prüfen (`docs/tv-mode.md`).
- **Jellyfin-Einstellungen** (Dashboard → Wiedergabe → Transkodierung):
  - Mit Intel QSV/VAAPI muss „VPP Tone mapping“ aus sein, wenn der Treiber kein HDR unterstützt. Sonst schlägt jeder 4K-HDR-Film fehl (FFmpeg: `tonemap_vaapi … VAAPI driver doesn't support HDR`). „Tone mapping“ (OpenCL) bleibt an.
  - Die Gast-Rolle (`transcoding: false`) kann 4K-HEVC/AC-3/DTS-Quellen in Chrome und Firefox nicht abspielen; Jellyfin reicht dann das Original unverändert durch.

## Checkliste
- [x] 0 Repo-Grundstruktur · [x] 1 Compose/Netze/Health/NPM/OIDC/Jellyfin-Client · [x] 2 Gateway + Player · [x] 3 Einladungen/Rollen/Mapping
- [x] 4 Seerr · [x] 5 Watch-Party · [x] 6 Voting/Benachrichtigungen · [x] 7 Statistiken/Achievements/Now-Playing · [x] 8 Admin/Metrics/Backups/Härtung

Weitere Doku: `docs/integrations.md`, `docs/operations.md`, `docs/monitoring.md`, `docs/tv-mode.md`, `CHANGELOG.md`.
GitHub manuell aktivieren: Secret scanning + Push protection, Dependabot alerts; Repo auf **Private**.
