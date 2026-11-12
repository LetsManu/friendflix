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

Ohne `RENDER_GID` bricht Compose mit *set RENDER_GID* ab. **NVIDIA (NVENC):** NVIDIA Container Toolkit auf dem Host
installieren, dann `-f compose.livetv-nvidia.yaml` hinzufügen (reserviert eine GPU mit den Fähigkeiten `gpu` und `video`).

## Ports

livetv veröffentlicht **nur UDP**: den Bereich `LIVETV_SRT_PORTS` (Standard `9000-9009`, 1–100 Ports) für SRT-Feeds, die du
hineinschickst, auf der Host-Adresse `LIVETV_SRT_BIND` (Standard `0.0.0.0`; `127.0.0.1` schaltet Push von außen ab, ohne den Dienst
zu entfernen). Den Bereich nur in der Firewall öffnen, **wenn du Feeds hineinschickst**; Listen und Streams abzurufen braucht keinen
eingehenden Port. Die API (Port 8090) wird nie veröffentlicht. Anderer Bereich: `LIVETV_SRT_PORTS=9100-9104` in der `.env`.

Weitere Einstellungen: `LIVETV_CACHE_MAX_GB` (Standard 6, der wegwerfbare Segment-Cache), `LIVETV_URL` (nur wenn du den Dienst verlegst).

## Image und reproduzierbare Builds (Ausnahme)

Das Image `livetv` wird wie die anderen gebaut, geprüft, mit SBOM versehen und per cosign signiert, mit Basis-Images per Digest,
ist aber **von der Prüfung `reproducible` ausgenommen** ([reproducible-builds.md](../reproducible-builds.md)). Seine Laufzeitstufe installiert
`jellyfin-ffmpeg7` per `apt` aus dem Jellyfin-Repository; dieses hält nur aktuelle Versionen (kein Snapshot-Archiv, also keine
Pin-Version, die baubar bleibt), und der apt/dpkg-Zustand ist nicht als bytegleich belegt, ein Neubau ergibt also nicht
zugesichert denselben Digest. `scripts/reproduce-image.sh livetv` lehnt deshalb mit einem Hinweis ab, und die Matrix des CI-Jobs
enthält es nicht. Signatur und SBOM des veröffentlichten Images belegen weiterhin die Herkunft; die Paketversionen stehen im SBOM.
