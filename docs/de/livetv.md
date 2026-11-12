<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Live-TV

Live-TV ist optional. Es läuft als eigener Container `livetv` im Compose-Profil `livetv`: Solange du es nicht einschaltest,
wird nichts geladen oder gestartet und FriendFlix sieht aus wie vorher. Diese Seite behandelt den Container selbst
(Einschalten, GPU, Ports); die Funktionen folgen in weiteren Abschnitten.

## Einschalten

- **Über den Updater (Standard-Stack):** *Admin → Live-TV* → aktivieren. Der Updater lädt das signierte Image und startet es.
- **Von Hand:** `COMPOSE_PROFILES=livetv` in die `.env` schreiben und `docker compose -f compose.prod.yaml up -d` ausführen
  (oder `docker compose -f compose.prod.yaml --profile livetv up -d`). Vorher prüfen: `docker compose -f compose.prod.yaml --profile livetv config -q`.

**Bei einer Installation von vor Live-TV** einmal in dieser Reihenfolge (die Seite nennt den Schritt, der fehlt):

1. *Admin → Update → Updater aktualisieren* (ein älterer Updater kennt Live-TV nicht: „Erst den Updater aktualisieren“).
2. `compose.prod.yaml` im Stack-Ordner durch die aus dem aktuellen Release ersetzen und einmal
   `docker compose -f compose.prod.yaml up -d` ausführen. Damit hängen Backend und Gateway im internen Netz `livetv`, und der
   Dienst `bootstrap` schreibt den Schlüssel von livetv (fehlt das: „Deine compose.prod.yaml stammt von vor Live-TV“ oder
   „Backend und Gateway hängen noch nicht im Netz livetv“). Ein Update über den Updater dazwischen ist kein Problem: Es erstellt
   Backend und Gateway im neuen Netz neu.
3. *Admin → Live-TV* → aktivieren.

Der Dienst hat keinen Docker-Socket, ein schreibgeschütztes Root-Dateisystem und keine Capabilities; Backend und Gateway
erreichen ihn im internen Netz `livetv` unter `LIVETV_URL` (Standard `http://livetv:8090`, braucht keine Einstellung).
Der Updater behält die Overlay-Dateien, mit denen du den Stack gestartet hast; ein Overlay in `COMPOSE_FILE` bleibt bei Updates erhalten.

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

Weitere Einstellungen: `LIVETV_CACHE_MAX_GB` (Standard 6, der wegwerfbare Segment-Cache), `LIVETV_URL` (nur wenn du den Dienst verlegst), `RECORDINGS_PATH` (Host-Ordner für Aufnahmen, Phase 3; Standard das benannte Volume `recordings`; absoluter Pfad, beschreibbar für uid 10001).

## Image und reproduzierbare Builds (Ausnahme)

Das Image `livetv` wird wie die anderen gebaut, geprüft, mit SBOM versehen und per cosign signiert, mit Basis-Images per Digest,
ist aber **von der Prüfung `reproducible` ausgenommen** ([reproducible-builds.md](../reproducible-builds.md)). Seine Laufzeitstufe installiert
`jellyfin-ffmpeg7` per `apt` aus dem Jellyfin-Repository; dieses hält nur aktuelle Versionen (kein Snapshot-Archiv, also keine
Pin-Version, die baubar bleibt), und der apt/dpkg-Zustand ist nicht als bytegleich belegt, ein Neubau ergibt also nicht
zugesichert denselben Digest. `scripts/reproduce-image.sh livetv` lehnt deshalb mit einem Hinweis ab, und die Matrix des CI-Jobs
enthält es nicht. Signatur und SBOM des veröffentlichten Images belegen weiterhin die Herkunft; die Paketversionen stehen im SBOM.
Um die Ausnahme aufzuheben: das Jellyfin-`.deb` im Build festschreiben oder mitliefern und dann mit `scripts/reproduce-image.sh livetv` zwei identische Builds zeigen.
