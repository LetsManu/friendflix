<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Medienserver: von FriendFlix verwaltet

FriendFlix kann seinen Medienserver für dich betreiben. Du wählst eine Art, einen Basisordner und die Ordner mit deinen Medien;
der Updater legt den Container aus einer festen Vorlage an, startet ihn, wartet, bis er gesund ist, richtet seinen Administrator,
den API-Schlüssel, die Bibliotheken und die Hardware-Kodierung ein und hält ihn am Laufen. Keine Compose-Datei zu schreiben,
kein `.env`-Eintrag, kein Dashboard zum Anmelden. Nichts daran kann erweitern, was der Server auf deinem Host sieht:
[security.md, Updater](../security.md#updater) (englisch). *English: [../mediaserver.md](../mediaserver.md)*

Dein bestehender Jellyfin oder Plex bleibt per Adresse unterstützt (*Bestehender Jellyfin/Plex (Adresse)*, was FriendFlix bisher
tat). Diese Seite handelt von den beiden anderen Auswahlmöglichkeiten und danach vom Test des FriendFlix-eigenen Images neben einem
bestehenden Jellyfin ([weiter unten](#test-ferrofin-neben-deinem-jellyfin)).

## Die drei Auswahlmöglichkeiten

*Admin → Einstellungen → Medienserver* (und der Medien-Schritt des Einrichtungsassistenten) bieten:

| Auswahl | Was es ist |
|---|---|
| *Ferrofin (eigener)* | `ghcr.io/letsmanu/friendflix-mediaserver`: das festgelegte Release von [Ferrofin](https://github.com/mangoleaf/ferrofin), einer Neuimplementierung der Jellyfin-API in Rust, plus wenige nummerierte Änderungen ([mediaserver/README.md](../../mediaserver/README.md), englisch). Noch ein **Test** (Markierung *Test*): Sein HDR-Tonemapping auf Intel-GPUs ist auf echter Hardware ungetestet, bis `probe.sh` und der *HDR-Test* auf deinem Host bestehen. |
| *Jellyfin (offiziell, verwaltet)* | Das offizielle Jellyfin-Image, von FriendFlix festgelegt. Die vorgewählte Auswahl, solange Ferrofin ein Test ist. |
| *Bestehender Jellyfin/Plex (Adresse)* | Dein eigener Server, per Adresse erreicht, wie bisher. |

Ein verwalteter Server in Kürze: kein veröffentlichter Port, kein Web-Client, keine Dashboard-Zugangsdaten (FriendFlix ist sein
einziger Client); Medien **schreibgeschützt** eingebunden; ohne Root, ohne Capabilities, schreibgeschütztes Root-Dateisystem; nur im
internen Netz `media` von FriendFlix (dazu `egress` für Metadaten, wenn du sie angeschaltet lässt).

FriendFlix' Ferrofin-Image unterscheidet sich vom Original in einer kurzen, nummerierten Liste
([mediaserver/README.md](../../mediaserver/README.md#changes)). Drei der Änderungen gibt es für den verwalteten Betrieb: **0003** ein
`HEALTHCHECK` (bash `/dev/tcp` auf `GET /health`; das Basis-Image hat kein curl), damit der Updater auf `healthy` warten kann;
**0004** kein Web-Client: Die Dateien des mitgelieferten Clients sind entfernt und `FERROFIN_WEB_DIR=/nonexistent`, der Server
liefert nur die API (das spart Arbeitsspeicher und Auslieferung, keinen Plattenplatz: Die Dateien bleiben in der Basisschicht des
Images, es ist also so groß wie vorher); **0005** `/cache` existiert, und `/data` und `/cache` haben Modus 0777, damit jede
Nicht-Root-uid frische Volumes dort nutzen kann (die Vorlage setzt `FERROFIN_CACHE_DIR=/cache`).

## Was du brauchst

- **Den Updater** (standardmäßig an; [setup.md, Updater](setup.md#updater)). Ohne ihn sind die verwalteten Auswahlmöglichkeiten mit
  Begründung abgeschaltet; ein schon vorhandener verwalteter Server läuft weiter, lässt sich aber nicht ändern.
- **Docker Engine 26 oder neuer** (API 1.45): Die Medienordner werden als schreibgeschützte Volume-Unterpfade eingebunden. Bei einer
  älteren Engine sagt die Karte `engine_old`, und die Systemcheck-Zeile *Verwalteter Medienserver* sagt es auch.
- **Die Compose-Datei dieses Releases**, einmalig: [Die Compose-Dateien aktualisieren](#die-compose-dateien-aktualisieren).
- **Einen frischen Server.** Ein verwalteter Server startet leer, mit neuen Nutzer- und Titel-IDs. *Einrichten* wird deshalb nur
  angeboten, solange kein Profil mit einem Medienserver-Nutzer verknüpft ist (eine neue Installation oder eine, die nie einen
  verknüpft hat). Sonst steht auf der Karte *Umzug von deinem Jellyfin: kommt mit Stufe 2* (der Umzug eines bestehenden Jellyfin
  kommt in einer späteren Stufe). Auch der Wechsel zwischen den beiden verwalteten Arten ist ein frischer Server (sie nutzen
  verschiedene Daten-Volumes).
- **Keine festgelegte Adresse.** Sind `JELLYFIN_URL` oder `JELLYFIN_ADMIN_API_KEY` in der Umgebung gesetzt (auch `_FILE`), könnte
  FriendFlix die verwaltete Adresse nicht speichern, die Auswahl bleibt also abgeschaltet (`url_pinned`). Mit `MEDIA_SERVER=plex`
  steht dort *Wechsel von Plex: kommt mit Stufe 4*.
- **Admin und eine frische Anmeldung** (höchstens 10 Minuten alt) für die Schritte, die ändern, welche Host-Daten der Server liest,
  Daten löschen oder Zugangsdaten offenlegen: einen Basisordner anfordern, *Einrichten*/*Übernehmen*, mit Daten entfernen,
  wiederherstellen, eine Sicherung herunterladen und zwischen verwaltet und extern wechseln.

## Einrichten

Wähle *Ferrofin (eigener)* oder *Jellyfin (offiziell, verwaltet)*, dann:

1. **Basisordner und Code.** Gib den absoluten Pfad des Ordners auf dem Host ein, unter dem deine Medien liegen, zum Beispiel
   `/srv/media`, und drücke *Code anfordern*. Das ist der eine Ordner, den der Medienserver je sehen kann. Damit sicher bist du es
   und nicht jemand, der nur die Webseite erreicht hat, schreibt der Updater einen einmaligen Code in sein Log, samt dem Ordner,
   den er nennt:

   ```bash
   docker compose -f compose.prod.yaml logs updater | grep "media folder"
   # FriendFlix media folder: to allow /srv/media as the media base folder, enter the code K7QM-2D9X-HT4R in Admin (valid until 14:32 UTC).
   ```

   Mit Portainer: Containers → `updater` → *Logs*. Gib den Code ein (*Bestätigen*). Er gilt 30 Minuten, der fünfte falsche Versuch
   bricht ihn ab, eine neue Anforderung ersetzt die alte, und höchstens drei lassen sich je zehn Minuten anfordern. Der Code
   erscheint nur auf der Standardausgabe des Updaters: nicht in Admin, nicht in einem Job-Protokoll, Status oder Audit-Eintrag.
   Als Basisordner abgelehnt werden: `/`, Systemverzeichnisse (`/etc`, `/usr`, `/var/lib/docker` und ähnliche), `/home`, `/var`,
   `/opt`, `/mnt`, `/media`, `/srv` und `/volume<N>` selbst (ein Ordner *darunter* geht), das Docker-Stammverzeichnis und das
   Stack-Verzeichnis (sie enthalten Geheimnisse; das Stack-Verzeichnis nur nach Möglichkeit: Der Updater liest es aus dem
   Compose-Label `working_dir`, das ein Stack aus einem anderen Werkzeug, etwa Portainer, nicht immer trägt; dann schützt der
   einmalige Code aus den Logs des Hosts). Pfadteile dürfen Buchstaben, Ziffern, Leerzeichen und `._-+()&'` enthalten,
   keiner beginnt mit einem Punkt. Der Updater prüft, ob der Ordner existiert, und warnt, wenn der Container-Benutzer ihn nicht
   auflisten kann.
2. **Ordner.** Stöbere unterhalb des Basisordners (eine Ebene nach der anderen, höchstens drei Ebenen tief, nur Namen) und hake die
   Ordner an, die geteilt werden sollen. Jeder bekommt einen Bibliotheksnamen und einen Typ: *Filme*, *Serien*, *Musik* oder
   *Gemischt*. Bis zu 20 Ordner, keiner in einem anderen. Ein Symlink wird angezeigt, ist aber nicht wählbar. Jeder Ordner wird im
   Container unter `/media/<name>` eingebunden, schreibgeschützt. Prüfungen zu Lesen, Auflisten und Beobachten (inotify) erscheinen
   neben dem Ordner; schlägt das Beobachten fehl, erscheinen neue Dateien erst nach einem Bibliotheks-Scan.
3. **Benutzer und Gruppe.** Der Container läuft standardmäßig als uid und gid `1000:1000` (nie 0). Trage das Paar des Host-Benutzers
   ein, dem deine Medien gehören, wenn sie für 1000 nicht lesbar sind, oder füge eine Mediengruppe hinzu, wenn nur eine Gruppe den
   Basisordner auflisten kann (*Gruppe <gid> hinzufügen*). Eine spätere Änderung des Paars erstellt den Container neu; ein
   Daten-Volume, das einer anderen uid gehört, lehnt sie ab (`uid_mismatch`: sichern und neu einrichten).
4. **Grafikkarte und HDR-Test.** FriendFlix erkennt `/dev/dri` (Intel, AMD) und NVIDIA und wählt das Passende vor: *Aus*,
   *Intel/AMD (VA-API/QSV)* oder *NVIDIA*. Der *HDR-Test* führt die beiden Kernprüfungen von `probe.sh` aus (OpenCL über VA-API und
   QSV- + OpenCL-Tonemapping eines erzeugten 2-Sekunden-HDR10-Clips) in einem Wegwerf-Container des gewählten Images, mit
   durchgereichter GPU und ohne Netz, und zeigt je Prüfung PASS oder FAIL. Führe ihn bei Ferrofin aus, bevor du dich auf HDR
   verlässt; [probe.sh](#1-zuerst-die-gpu-prüfen) macht dasselbe von Hand.
5. **Metadaten aus dem Internet.** Standardmäßig an (Poster, Titel, Beschreibungen). Aus heißt nur lokale Metadaten, und der Container
   tritt dem Netz `egress` nie bei.
6. **Einrichten.** Alles Weitere läuft von selbst, und die Karte zeigt jeden Schritt; ein fehlgeschlagener Schritt hat *Nochmal* und
   macht dort weiter: Der Server startet und wird gesund, FriendFlix legt seinen Administrator an (`friendflix-admin`, ein
   zufälliges Passwort, verschlüsselt gespeichert und nie angezeigt) und den API-Schlüssel, speichert Adresse und Schlüssel als
   Einstellungen, legt je Ordner eine Bibliothek an (keine NFO-Dateien, Echtzeit-Überwachung an), stellt die Hardware-Kodierung passend
   zur GPU ein (Intel QSV, AMD VA-API, NVIDIA NVENC, Tonemapping an) und scannt. Bei Ferrofin trägt das erste Anlegen Name und
   Passwort des Administrators als Umgebungsvariablen; ist die Einrichtung fertig, wird der Container ohne das Passwort neu
   erstellt. Bei Jellyfin wird der Start-Assistent über seine API abgeschlossen. Hatte jemand anderes diesen Assistenten schon
   abgeschlossen (ein anderer Container im Netz `media` war schneller), endet die Einrichtung mit `wizard_taken`: Nimm *Neu anlegen*
   (mit Daten entfernen, dann neu einrichten).

Der Medien-Schritt des Assistenten bietet denselben Weg unter der Einrichtungssitzung; er endet, wenn der Server bereit ist und der
Assistent weitergeht.

### Nach dem ersten Lauf

- **Einen Ordner hinzufügen** bindet ihn beim nächsten *Übernehmen* ein und legt seine Bibliothek an. **Entfernen** bindet ihn aus,
  lässt aber seine Bibliothek stehen: Die Titel erscheinen als fehlend und kommen wieder, wenn du den Ordner wieder hinzufügst. Eine
  **Bibliothek löschen** ist eine eigene Bestätigung, die vorher zählt, wie viele Listen, Fortsetzen-Punkte und Aufnahmen sie
  referenzieren. Eine referenzierte Bibliothek umzubenennen oder ihren Typ zu ändern wird abgelehnt (`library_referenced`).
- **Den Basisordner ändern** wiederholt den Code-Schritt. Gewählte Ordner, die es auch unter dem neuen Basisordner gibt, bleiben; die
  übrigen entfallen und werden aufgelistet. *Zurücksetzen* (den Basisordner löschen) braucht keinen Code, geht aber nur, solange es
  keinen verwalteten Container gibt.
- **Aktionen** auf der Karte: *Starten*, *Stoppen*, *Neu starten*, *Aktualisieren*, *Sicherung*, *Wiederherstellen*, *Protokoll* (die
  letzten 300 Zeilen, Geheimnisse durch `…` ersetzt, nie gespeichert) und *Entfernen*. Ein Stopp ist deine Entscheidung: Der Updater
  startet einen Container, den du gestoppt hast, nie neu, egal ob in Admin oder außerhalb. Ein **fehlender** Container wird binnen
  einer Minute neu angelegt.
- **Entfernen** behält die Daten-, Cache- und Sicherungs-Volumes; *Daten löschen* (mit Eingabe des Namens der Art) entfernt Daten und
  Cache, nie die Sicherungen. Danach geht FriendFlix zum gespeicherten externen Server zurück, wenn es einen gibt.
- **Systemcheck:** Die Zeile *Verwalteter Medienserver* (`media.managed`) meldet einen fehlenden oder ungesunden Container, einen
  Basisordner oder Ordner, der verschwunden ist (zum Beispiel ein nicht eingehängtes NAS-Share), eine fehlende GPU, einen
  fehlgeschlagenen Auftrag (`managed_job_failed`), ein Image, das länger als 7 Tage vom festgelegten Stand abweicht, und eine
  Sicherung, die älter als 30 Tage ist. Ein Container, dessen Labels stimmen, dessen Konfiguration aber außerhalb von FriendFlix
  geändert wurde (in Portainer kam ein Port oder ein Recht hinzu), ist `managed_tampered`: Er wird nie gestartet oder übernommen;
  *Neu anlegen* ersetzt ihn aus der Vorlage.

## Updates

Der Medienserver zieht **mit FriendFlix** um, im selben Update (manuell oder automatisch); es gibt kein eigenes Zeitfenster und
keinen eigenen Klick. Jeder FriendFlix-Stand trägt das genaue Medienserver-Image, mit dem er getestet wurde, je Art per Digest, in
einem signierten Label seines Backend-Images. Das von Ferrofin ist das im selben CI-Lauf gebaute Image, wie die anderen Images mit
cosign geprüft; das von Jellyfin ist `docker.io/jellyfin/jellyfin:<Tag>@sha256:<Digest>`, bei 12.x mit dem Build-Tag
(`12.4.<JJJJMMTT-HHMMSS>`, denn 12.x hat keine `X.Y.Z`-Tags), wobei der Digest die Integritätsprüfung ist.

- **Reihenfolge:** Das Update erstellt zuerst FriendFlix' eigene Dienste neu und prüft ihre Gesundheit; erst dann, wenn der Stand des
  neuen Builds vom laufenden Image abweicht, läuft die Medienserver-Phase: Schnappschuss, neu erstellen, auf gesund warten. FriendFlix'
  Rücksprung wird dadurch nie aufgehalten oder ausgelöst.
- **Schlägt die Medienserver-Phase fehl,** kommt der alte Container zurück (der Konfigurations-Schnappschuss wird eingespielt, wenn
  sich die Upstream-Version geändert hat), FriendFlix bleibt auf dem neuen Build, und der Auftrag endet als *FriendFlix aktualisiert,
  Medienserver nicht*. Das ist kein fehlgeschlagenes Update, deshalb gibt es **keinen Push-Alarm**; die Systemcheck-Zeile warnt
  (`managed_job_failed`), und die Karte bietet *Erneut versuchen*.
- **Updates, die FriendFlix nicht selbst ausgeführt hat** (Portainer, `compose pull` von Hand): Der Updater merkt, dass sich der
  Backend-Build seit seinem letzten Blick geändert hat (`pin.changed`), und das Backend startet dieselbe Phase von selbst.
- **Nie abwärts.** Ferrofin und Jellyfin wandeln ihre Datenbanken nur in eine Richtung um. Ein festgelegter Stand mit älterer
  Upstream-Version als der laufende Server ist `downgrade_refused`: Der Server bleibt, und ein FriendFlix-Rücksprung behält den
  neueren Medienserver (die Karte sagt *neuer als dieser FriendFlix-Stand*). Das Wiederherstellen einer Sicherung aus einer neueren
  Version wird genauso abgelehnt.
- **Schnappschuss vor einer Upstream-Änderung:** Das Daten-Volume (ohne Logs, Transkodierungen und Trickplay) wird zuerst als
  automatische Sicherung gespeichert; die letzten 2 bleiben.
- Ein Build ohne Ferrofin-Image (sein CI-Job hat keines veröffentlicht) meldet `image_missing`: Ein vorhandener Container bleibt bei
  seinem Image, eine neue Einrichtung wird mit dem Hinweis abgelehnt, *Jellyfin (offiziell, verwaltet)* zu wählen.
- Updater im Watchtower-Stil müssen ihn in Ruhe lassen: Der Container trägt `com.centurylinklabs.watchtower.enable=false`.

## Sicherungen

- *Sicherung* stoppt den Server kurz, und ein Helfer schreibt `<Art>-<JJJJMMTT-HHMM>-<Upstream>.tar.gz` des Daten-Volumes (ohne Logs
  und Transkodierungen, Trickplay auf Wunsch) in das Volume `<Projekt>_mediaserver-backup`, dann startet er ihn wieder. Behalten
  werden die letzten 3 manuellen (und hochgeladenen) und die letzten 2 automatischen Sicherungen.
- *Wiederherstellen* geht innerhalb derselben Art und lehnt eine Sicherung aus einer neueren Upstream-Version ab.
- **Der verschlüsselte Download ist die Kopie, die den Host verlässt.** *Herunterladen* fragt nach einer Passphrase (mindestens 12
  Zeichen, zweimal eingegeben, nie gespeichert) und einer frischen Anmeldung. Der Updater streamt das Archiv verschlüsselt im
  offenen [age](https://age-encryption.org)-Format (scrypt-Passphrase) als `<id>.tar.gz.age`; das unverschlüsselte Archiv verlässt den
  Updater nie, und auf den Host wird nichts geschrieben. Zum Öffnen brauchst du FriendFlix nicht:

  ```bash
  age -d -o backup.tar.gz <id>.tar.gz.age      # fragt nach der Passphrase
  ```

  Die Sicherung enthält die Passwort-Hashes und API-Schlüssel des Servers: deshalb die Passphrase.
- *Aus Datei wiederherstellen* nimmt so eine Datei mit ihrer Passphrase zurück (bis 20 GiB), behält sie als Sicherung mit der Marke
  *upload* (eine falsche Passphrase oder eine beschädigte Datei behält nichts) und stellt sie wie jede andere wieder her.
- **`docker compose down -v` entfernt das Sicherungs-Volume** (der Updater bindet es über Compose ein). Lade vorher eine Sicherung
  herunter; das Volume ohne FriendFlix auf den Host zu kopieren: [operations.md, Backups](../operations.md#backups--wiederherstellung).

## Den Stack stoppen, Portainer, mehrere Instanzen

- **`docker compose down`** entfernt FriendFlix' Container, hält aber am Netz `media` mit *has active endpoints* an: Der Medienserver
  ist kein Compose-Dienst und hängt daran (der Rest von `down` ist erledigt). Ein späteres `up -d` nutzt das Netz weiter. Soll auch
  das Netz weg, stoppe zuerst den Medienserver (*Stoppen* in Admin oder `docker stop friendflix-mediaserver`; der Name ist
  `<Projekt>-mediaserver`) und führe `down` noch einmal aus. Dasselbe gilt für das Entfernen eines Stacks in Portainer. `down`
  löscht nie die Daten des Medienservers (seine Volumes sind keine Compose-Volumes); `down -v` entfernt nur das Sicherungs-Volume
  (oben).
- **Portainer:** Jeder Medienserver-Auftrag funktioniert auf einem Portainer-Stack, keiner nutzt Compose. Der Medienserver steht in
  Portainer unter *Containers*, außerhalb des Stacks. Ihn mit Portainers *Duplicate/Edit* zu ändern, fängt der Wächter ab
  (`managed_tampered`). Nach einem von Portainer ausgelösten FriendFlix-Update zieht der festgelegte Stand von selbst nach (oben).
- **Mehrere FriendFlix-Instanzen** auf einer Docker-Engine: Jeder Name, jedes Volume und jedes Label trägt das Compose-Projekt, jeder
  Updater sieht nur seine eigenen Container, und jede Instanz bestätigt ihren eigenen Basisordner. Zwei Instanzen dürfen sich einen
  Basisordner teilen (schreibgeschützt).

## Die Compose-Dateien aktualisieren

Der verwaltete Medienserver braucht die Compose-Datei dieses Releases: Der Dienst `docker-proxy` erlaubt das Lesen von
Container-Logs (`ALLOW_LOGS: 1`, für das Log des Medienservers und die Ausgabe der Helfer-Container), und der Dienst `updater` bindet
das Volume `mediaserver-backup` ein. Mit einer älteren Datei zeigt der Systemcheck *Verwalteter Medienserver* als Warnung
(`managed_proxy_outdated`), und die Karte bietet die verwalteten Auswahlmöglichkeiten nicht an (`proxy_outdated`). Lade die aktuelle
[`compose.prod.yaml`](../../compose.prod.yaml) neben deine `.env` und führe einmal `docker compose -f compose.prod.yaml up -d` aus; mit
Portainer die Stack-Datei aktualisieren und den Stack neu bereitstellen. Sonst ändert sich nichts, und der Medienserver wird nicht
angefasst.

## Test: Ferrofin neben deinem Jellyfin

Das ist der manuelle Weg, FriendFlix' eigenes Image **ohne** den verwalteten Betrieb auszuprobieren: Jellyfin bleibt dein
Medienserver, und Ferrofin läuft daneben. Ferrofin wandelt die übernommene Jellyfin-Datenbank nur in eine Richtung um (bis Ferrofin
1.6.0), deshalb läuft der Test immer auf einer **Kopie** von Jellyfins Konfigurationsordner, und Jellyfin bleibt unverändert. (Für ein
frisches verwaltetes Ferrofin nimm die Schritte oben; der Umzug eines bestehenden Jellyfin in den verwalteten Betrieb kommt in einer
späteren Stufe.)

### 1. Zuerst die GPU prüfen

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

### 2. Den Test neben Jellyfin starten

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
- Schalte den **NFO-Speicher** aus (die Medien sind schreibgeschützt eingebunden): Das Image hat keinen Web-Client (Änderung
  0004), also gibt es dafür kein Dashboard. `try.sh` zeigt die Schritte am Ende: Schicke pro Bibliothek ihre Optionen mit
  `SaveLocalMetadata` `false` und `MetadataSavers` `[]` zurück (`POST /Library/VirtualFolders/LibraryOptions`, mit dem
  API-Schlüssel eines Administrators aus der Kopie). Der Aufruf antwortet bei Erfolg mit 204; jede andere Antwort heißt, dass Schlüssel, Bibliotheks-`Id` oder Body nicht angenommen wurden: Prüfe sie und die Adresse und schicke ihn noch einmal. Ein verwalteter Server (oben) wird von Anfang an ohne NFO-Dateien
  eingerichtet.
- Der Container trägt `com.centurylinklabs.watchtower.enable=false`: kein Auto-Updater darf ihn aktualisieren (ein neueres Image
  würde die kopierte Datenbank von selbst umwandeln). Der FriendFlix-Updater fasst ihn nie an.

### 3. FriendFlix umstellen und testen

*Admin → Einstellungen → Medienserver*: Adresse `http://ferrofin:8096` (oder das veröffentlichte `http://192.0.2.10:8097`),
speichern. Dann testen: Anmelden, Stöbern, Direktwiedergabe und ein HDR-Titel, Spulen, Untertitel, ein Kinderprofil,
Fortsetzen-Punkte, Downloads, Live-TV und eine neu hinzugefügte Datei.

### 4. Zurück

Adresse wieder auf deine Jellyfin-Adresse stellen (z. B. `http://jellyfin:8096` oder `http://192.0.2.10:8096`), dann
`bash try.sh remove`. Der kopierte Ordner bleibt, bis du ihn löschst. Während des Tests gesehene Fortschritte bleiben in der Kopie.
