# Monitoring (Icinga / Prometheus)

Endpunkte (nur lokal auf dem Docker-Host erreichbar: Ports sind an `127.0.0.1` gebunden; NPM antwortet für `/metrics` und `/health/ready` mit 404):
| URL | Zweck |
|---|---|
| `http://127.0.0.1:3081/health` | Liveness |
| `http://127.0.0.1:3081/health/ready` | Readiness: Redis, Postgres, Jellyfin (503 bei Problem) |
| `http://127.0.0.1:3081/metrics` | Prometheus (Bearer `METRICS_TOKEN`, falls gesetzt) |
| `http://127.0.0.1:3082/metrics` | Gateway-Durchsatz |

Wichtige Metriken: `friendflix_active_streams`, `friendflix_gateway_bytes_total` (Durchsatz = `rate()`), `friendflix_gateway_active_streams`, `friendflix_gateway_requests_total{code}`, `friendflix_dependency_up{dependency}`, `friendflix_users_total`, `friendflix_pending_devices`, `friendflix_pending_polls`, `friendflix_party_rooms`.

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
