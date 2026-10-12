# Monitoring (Icinga / Prometheus)

Endpunkte (nur lokal auf dem Docker-Host erreichbar: Ports sind an `127.0.0.1` gebunden; NPM antwortet für `/metrics` und `/health/ready` mit 404):
| URL | Zweck |
|---|---|
| `http://127.0.0.1:3081/health` | Liveness |
| `http://127.0.0.1:3081/health/ready` | Readiness: Redis, Postgres, Jellyfin (503 bei Problem) |
| `http://127.0.0.1:3081/metrics` | Prometheus (Bearer `METRICS_TOKEN`, falls gesetzt) |
| `http://127.0.0.1:3082/metrics` | Gateway-Durchsatz |

Wichtige Metriken: `friendflix_active_streams`, `friendflix_gateway_bytes_total` (Durchsatz = `rate()`), `friendflix_gateway_active_streams`, `friendflix_gateway_requests_total{code}`, `friendflix_dependency_up{dependency}`, `friendflix_users_total`, `friendflix_pending_devices`, `friendflix_pending_polls`, `friendflix_party_rooms`, `friendflix_client_errors_total{kind}` (Browser-Fehler, siehe unten).

## Icinga-Beispiele
```
# Zertifikat des öffentlichen Hosts (NPM / Let's Encrypt): Warnung < 21 Tage, kritisch < 7 Tage
object Service "friendflix-cert" { host_name = "docker-host"; check_command = "http"
  vars.http_address = "portal.example.com"; vars.http_ssl = true; vars.http_certificate = "21,7" }

# Öffentliche Erreichbarkeit der UI
object Service "friendflix-ui" { host_name = "docker-host"; check_command = "http"
  vars.http_address = "portal.example.com"; vars.http_ssl = true; vars.http_uri = "/"; vars.http_expect = "200" }

# Interne Readiness (vom Docker-Host aus; Container-IP oder `docker exec`)
object Service "friendflix-ready" { host_name = "docker-host"; check_command = "http"
  vars.http_address = "127.0.0.1"; vars.http_port = 3081; vars.http_uri = "/health/ready"; vars.http_expect = "200" }

# Aktive Streams / Gateway-Durchsatz: check_prometheus_query o. ä. (Prometheus) oder check_http mit -r auf /metrics
#   friendflix_active_streams > 8  -> WARNING (je nach Upstream-Bandbreite)
#   rate(friendflix_gateway_bytes_total[5m]) * 8 > 0.8 * <Upload in bit/s> -> WARNING
```
Prometheus-Scrape:
```yaml
- job_name: friendflix
  authorization: { credentials: "<METRICS_TOKEN>" }
  static_configs: [{ targets: ["127.0.0.1:3081", "127.0.0.1:3082"] }]
```

## Browser-Fehler
Die Web-App meldet unbehandelte Fehler an das Backend, damit kaputte Releases auffallen, ohne dass jemand die Browser-Konsole der Freunde lesen muss.

**Was gemeldet wird** (`web/src/lib/telemetry.ts`, registriert in `web/src/hooks.client.ts`): `window` `error` (`kind: error`), `unhandledrejection`, fehlgeschlagene `<script>`/`<link>`-Ladevorgänge (`kind: resource`) und Fehler, die SvelteKit in `handleError` abfängt. Pro Seitenaufruf höchstens 10 Meldungen, identische Meldungen (Art + Text) werden 60 Sekunden lang unterdrückt. Ignoriert werden Fehler aus Browser-Erweiterungen (`chrome-extension://`, `moz-extension://`, `safari-web-extension://` im Stack), die harmlosen `ResizeObserver loop …`-Warnungen und das nichtssagende `Script error.` ohne Stack. Versendet wird per `navigator.sendBeacon` (überlebt auch das Schließen des Tabs), Ersatz ist `fetch` mit `keepalive`.

**Backend** (`POST /api/client-errors`): ohne Login erreichbar (Fehler passieren auch auf Login- und Offline-Seite) und von der CSRF-Prüfung ausgenommen wie `/api/tv/code`, weil `sendBeacon` keinen `x-csrf-token`-Header setzen kann. Body: JSON als `text/plain` (kein CORS-Preflight) mit `message` (≤ 500), `stack` (≤ 4000, optional), `url` (≤ 500, nur Pfad), `userAgent` (≤ 300), `kind` (`error` | `unhandledrejection` | `resource`), `release` (≤ 40, optional). Antwort `204`; `400` bei ungültigem Body; `403` bei fremdem `Origin`; `429` über dem Limit (20 pro Minute und IP, 200 pro Stunde und angemeldetem Nutzer bzw. IP).

**Datenschutz:** Es wird nichts gespeichert. Das Backend schreibt pro Meldung eine Logzeile `level=warn`, `msg="client error"` mit dem Objekt `clientError` (`kind`, `message`, `stack`, `url`, `userAgent`, `release`). Vorher werden Query-Strings und Fragmente entfernt, ebenso `token=`/`code=`/`key=`-Werte, E-Mail-Adressen, Bearer-/JWT-Werte und lange zufällige Tokens (≥ 40 Zeichen). 32-stellige Jellyfin-IDs bleiben absichtlich erhalten, damit man den betroffenen Titel findet.

**Auswerten:**
```sh
# häufigste Browser-Fehler der letzten 24 h (Backend-Logs sind JSON; jq erforderlich)
docker compose logs backend --since 24h --no-log-prefix 2>&1 | grep '"client error"' | jq -r '.clientError | "\(.kind)\t\(.url)\t\(.message)"' | sort | uniq -c | sort -rn | head
```
Prometheus: `sum(increase(friendflix_client_errors_total[1h])) by (kind)`. Als Icinga-Warnung eignet sich z. B. `sum(increase(friendflix_client_errors_total[15m])) > 20` (nach einem Deployment: neue Fehlerart oder kaputtes Bundle, `kind="resource"` deutet auf ein nicht ausgeliefertes JS-/CSS-Asset hin). Die Zähler laufen nur bei akzeptierten Meldungen; das Rate-Limit begrenzt, wie viel ein einzelner Client beitragen kann.
