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

## Plan B für den Medien-Pfad
Wird das Gateway zum Engpass (CPU bei vielen parallelen Streams): `deploy/npm/plan-b-auth-request.conf`. NPM liefert `/media/` dann selbst per `auth_request` an das Backend. **Plan B ist dokumentiert, aber nicht gebaut:** es fehlen ein Backend-Endpunkt, der per Cookie `X-Jellyfin-Token`/`X-Jellyfin-Path` zurückgibt (nur für NPM erreichbar; `/internal/authz` ist POST+Secret und für das Gateway gedacht), und ein dediziertes Netz NPM↔Jellyfin. Nachteil: Bitrate-Clamp und Path-Allowlist müssen dann in Nginx nachgebaut werden. Erst messen (`friendflix_gateway_bytes_total`, CPU des gateway-Containers), dann umbauen.
