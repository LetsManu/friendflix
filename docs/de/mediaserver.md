<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Eigenes Medienserver-Image (auf Ferrofin-Basis, Test)

FriendFlix hat ein eigenes Medienserver-Image, `ghcr.io/letsmanu/friendflix-mediaserver`: das festgelegte Release von
[Ferrofin](https://github.com/mangoleaf/ferrofin), einer Neuimplementierung der Jellyfin-API in Rust, plus wenige nummerierte
Änderungen (die erste bringt Intels OpenCL-Laufzeit mit, damit HDR → SDR-Tonemapping auf Intel-GPUs funktionieren kann; **auf
echter Hardware ungetestet, bis `probe.sh` auf deinem Host besteht**). FriendFlix spricht mit ihm wie mit Jellyfin. Wie das
Image entsteht und aktuell bleibt: [mediaserver/README.md](../../mediaserver/README.md) (englisch). *English:
[../mediaserver.md](../mediaserver.md)*

**Es ist ein Test.** Jellyfin bleibt dein Medienserver. Ferrofin wandelt die übernommene Jellyfin-Datenbank nur in eine
Richtung um (bis Ferrofin 1.6.0), deshalb läuft der Test immer auf einer **Kopie** von Jellyfins Konfigurationsordner, und
Jellyfin bleibt unverändert.

## 1. Zuerst die GPU prüfen

[`mediaserver/probe.sh`](../../mediaserver/probe.sh) prüft, ob das Image auf der GPU dieses Hosts HDR mit OpenCL tonemappen kann.
Es startet nur Wegwerf-Container mit durchgereichter GPU; Jellyfin und FriendFlix bleiben unberührt.

```bash
bash probe.sh                          # als root oder als Benutzer in der Gruppe docker
DOCKER=/pfad/zu/docker bash probe.sh   # wenn docker nicht im PATH liegt (manche NAS-Systeme)
```

Es meldet `PASS` oder `FAIL` für: OpenCL über VA-API, Jellyfins QSV- + OpenCL-Tonemapping-Kette an einem erzeugten
10-Bit-HDR10-Clip und, zur Information, die VA-API- + OpenCL-Kette und ob der VA-Treiber der GPU selbst tonemappen kann (VPP;
wenn nicht, in Ferrofins Einstellungen OpenCL-Tonemapping nehmen, [Änderung 0002](../../mediaserver/patches/0002-vaapi-hdr-tonemap-chain.md)).
Die einzeilige Prüfung, mit der es beginnt, von Hand:

```bash
docker run --rm --device /dev/dri --group-add "$(stat -c %g /dev/dri/renderD128)" --entrypoint /usr/local/bin/ffmpeg \
  ghcr.io/letsmanu/friendflix-mediaserver:nightly \
  -init_hw_device vaapi=va:/dev/dri/renderD128 -init_hw_device opencl=ocl@va -f lavfi -i nullsrc -frames 1 -f null -
```

## 2. Den Test neben Jellyfin starten

[`mediaserver/try.sh`](../../mediaserver/try.sh) liest Jellyfins Ordner, Geräte und Netze aus Docker, prüft, ob der Benutzer des
Images deine Medien auflisten, lesen und beobachten kann, und prüft das Kopierziel und die Mount-Pfade. Erst dann fragt es,
stoppt Jellyfin für die Kopie (Sekunden bis Minuten, je nach Größe der Metadaten), startet es wieder und startet dann den
Test-Container (`ferrofin`) mit der Kopie (darin unter `/ferrofin-data`) und deinen Medien schreibgeschützt. Es nimmt
`ghcr.io/letsmanu/friendflix-mediaserver:nightly`, außer du setzt `IMAGE=`, und legt den Container auf den Digest dieses Images fest.

```bash
bash try.sh --attach-network friendflix_media      # FriendFlix' Mediennetz: dann erreicht es http://ferrofin:8096
bash try.sh --publish 192.0.2.10:8097              # oder: FriendFlix erreicht Medienserver über Host-IP:Port
bash try.sh status                                 # bash try.sh remove entfernt nur einen Container, den es selbst angelegt hat
```

Gut zu wissen:

- Jellyfin kann ein eigener Stack sein (Container `jellyfin` mit Bind-Mounts wie `/config`, `/cache`, `/media`, `/media2`);
  der Test nutzt dieselben Medienpfade, damit die Bibliothekspfade passen.
- `--publish <Port>` ohne Adresse veröffentlicht nur auf `127.0.0.1`: der Test enthält Kopien aller Jellyfin-Konten und
  -Schlüssel. Gib die LAN-Adresse des Hosts nur an, wenn FriendFlix sie braucht.
- `--with-trickplay` kopiert auch Jellyfins Trickplay-Bilder (das Skript zeigt ihre Größe).
- Schlägt die inotify-Prüfung fehl, erscheinen neue Dateien erst nach einem Bibliotheks-Scan.
- Schalte in Ferrofins Dashboard den **NFO-Speicher** aus (*Dashboard → Bibliotheken → jede Bibliothek → Metadatenspeicher →
  Nfo*): die Medien sind schreibgeschützt eingebunden.
- Der Container trägt `com.centurylinklabs.watchtower.enable=false`: kein Auto-Updater darf ihn aktualisieren (ein neueres Image
  würde die kopierte Datenbank von selbst umwandeln). Der FriendFlix-Updater fasst ihn nie an.

## 3. FriendFlix umstellen und testen

*Admin → Einstellungen → Medienserver*: Adresse `http://ferrofin:8096` (oder das veröffentlichte `http://192.0.2.10:8097`),
speichern. Dann testen: Anmelden, Stöbern, Direktwiedergabe und ein HDR-Titel, Spulen, Untertitel, ein Kinderprofil,
Fortsetzen-Punkte, Downloads, Live-TV und eine neu hinzugefügte Datei.

## 4. Zurück

Adresse wieder auf deine Jellyfin-Adresse stellen (z. B. `http://jellyfin:8096` oder `http://192.0.2.10:8096`), dann
`bash try.sh remove`. Der kopierte Ordner bleibt, bis du ihn löschst. Während des Tests gesehene Fortschritte bleiben in der Kopie.
