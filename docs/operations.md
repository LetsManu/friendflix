# Betrieb: Backup, Restore, Firewall, Updates

## Backups
- Sidecar: `docker compose --profile backup up -d backup` (täglich `pg_dump -Fc`, Aufbewahrung `KEEP_DAYS`, Verzeichnis `BACKUP_PATH`, vorher `chown 70 backups`).
- Alternativ per Cron auf dem Host: `0 3 * * * cd /opt/friendflix && ./scripts/backup.sh >> backups/backup.log 2>&1`
- **Restore-Test** (monatlich per Cron, Exit-Code ≠ 0 bei Fehler → Icinga/Cron-Mail): `./scripts/restore-test.sh`
  Startet einen Wegwerf-Postgres ohne Port-Mapping, spielt den neuesten Dump ein und prüft Migrationen und Tabellen.
- Echter Restore: `docker compose stop backend && docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U friendflix -d friendflix < backups/friendflix-<ts>.dump && docker compose start backend`
- **APP_ENC_KEY sichern!** (Passwort-Manager, getrennt vom Dump). Ohne ihn sind die gespeicherten Jellyfin-Passwörter der Nutzer unlesbar.
- Nicht im Dump: Jellyfin-/Seerr-/Authentik-Daten (eigene Backups dieser Dienste).

## Host-Firewall (zusätzlich zum fehlenden Port-Mapping)
Jellyfin/Seerr haben keine `ports:` und hängen nur im internen Netz. Falls sie auf dem Host zusätzlich laufen (nicht gebündelt):
```bash
# Docker umgeht ufw: Regeln gehören in DOCKER-USER
iptables -I DOCKER-USER -p tcp -m multiport --dports 8096,8920,5055 ! -s 127.0.0.1 -j DROP
ufw deny 8096,8920,5055/tcp
```
Prüfung von außen: `nmap -p 8096,8920,5055 <öffentliche-IP>` → alle `filtered/closed`.

## Updates
`git pull && docker compose build --pull && docker compose up -d`. Migrationen laufen beim Start (Advisory-Lock, transaktional).
Nach Jellyfin-Updates: `JELLYFIN_URL=… ./scripts/gen-jellyfin-client.sh` und Diff prüfen (Pfade ändern sich zwischen Versionen; der Client probiert alte/neue Pfade für Views/Resume/Item/Favoriten/Gesehen).

## Plan B: NPM liefert /media/ direkt (auth_request)
Standard ist das Node-Gateway. Wird es bei vielen parallelen Streams zum Engpass (CPU des `gateway`-Containers, `rate(friendflix_gateway_bytes_total)`), kann NPM/nginx `/media/` selbst ausliefern. Jede Anfrage wird vorher vom Backend freigegeben (`GET /internal/authz-nginx`).

**Ablauf je Request:** Browser → nginx → `auth_request` an Backend (Cookie + Original-URI + Shared Secret) → Backend prüft Session, Gerätefreigabe, Sperre und die Pfad-Allowlist, liefert nur Header zurück (`X-Jellyfin-Uri` = bereinigte URI mit Bitrate-Limit, `X-Jellyfin-Auth` = Jellyfin-Token des Nutzers) → nginx streamt von Jellyfin. Der Browser sieht nie ein Token.

**Einrichten**
1. Jellyfin muss vom NPM-Host erreichbar sein, ohne öffentlich zu sein: Stack mit `docker compose -f compose.yaml -f compose.planb.yaml --profile bundled up -d` starten. Das veröffentlicht Jellyfin **nur auf `127.0.0.1:8096`**. Port 8096 bleibt in der Host-Firewall gesperrt. (Läuft Jellyfin außerhalb des Stacks, muss es auf `127.0.0.1:8096` für NPM erreichbar und von außen gesperrt sein.)
2. In NPM → Proxy Host → Advanced: den `location /media/`-Block aus `portal.advanced.conf` **ersetzen** durch den Inhalt von `deploy/npm/plan-b-auth-request.conf`; `__INTERNAL_SECRET__` durch den Wert aus `.env` ersetzen.
3. Gateway-Container kann gestoppt werden (`docker compose stop gateway`).
4. Testen: `curl -I https://portal.example.com/media/Videos/<id>/master.m3u8` ohne Cookie → **401**; im Browser abspielen → läuft.

**Sicherheitsmerkmale (automatisiert geprüft mit `scripts/test-plan-b.sh` gegen echtes nginx):** 401 ohne/mit falscher Session, 403 außerhalb der Allowlist und bei Traversal, nur GET/HEAD, `/internal/` öffentlich 404, Client-`Authorization`/`X-Emby-*` erreichen Jellyfin nie, `api_key` wird entfernt, Bitrate wird auf das Rollenlimit gekappt, Token nur serverseitig, kein `Set-Cookie`/Token in Antworten, Range → 206.
Backend-Tests prüfen dieselben Pfad-Vektoren wie das Gateway (`test-vectors/media-paths.json`), damit beide Allowlists nicht auseinanderlaufen. Entscheidungen werden als `friendflix_authz_nginx_total{result}` gezählt.

**Grenzen:** Das Secret steht in der NPM-Konfiguration (es autorisiert nur den Auth-Endpunkt, der zusätzlich eine echte Session verlangt). Sperren/Abmelden wirken nach spätestens ~5 s (Memo im Backend). Durchsatz/Streams erscheinen nicht in den Gateway-Metriken, sondern in den NPM-/nginx-Logs. Bild-Caching setzt die Konfiguration selbst (`private, max-age=86400`).
