# FriendFlix für Android

[English](../android.md) · **Deutsch**

Die Android-App ist FriendFlix für die Hosentasche: dieselbe Weboberfläche wie im Browser, in einer abgeschotteten App, und vier Teile laufen nativ, wo ein Handy sie braucht:

- **Player:** ein nativer Player (Media3) mit Direktwiedergabe, wenn das Handy die Datei selbst abspielen kann, Bild-im-Bild, Steuerung auf dem Sperrbildschirm und per Bluetooth und auf Wunsch Ton im Hintergrund.
- **Downloads:** Filme und Folgen laden im Hintergrund, auch bei ausgeschaltetem Bildschirm, aufs Telefon oder auf eine SD-Karte und werden verschlüsselt gespeichert. Ist der Server nicht erreichbar, öffnet die App eine Liste deiner Downloads zum Offline-Schauen.
- **Chromecast** aus dem nativen Player.
- **Benachrichtigungen** zu neuen Folgen, Anfragen und deinem Konto, die die App etwa alle 10–20 Minuten selbst abholt (Android kann das weiter verzögern; ohne Push-Dienst von Google).

Alles andere (Stöbern, Profile, Watch-Partys, Anfragen, Einstellungen deines Kontos) ist die Weboberfläche und passt deshalb immer zur Version deines Servers.

**Voraussetzungen:** Android 8.0 oder neuer und ein FriendFlix-Server ab Version 2.0.0, erreichbar über HTTPS mit einem Zertifikat einer öffentlichen Zertifizierungsstelle (zum Beispiel Let's Encrypt). Die App-Version folgt der Server-Version; ist eine Seite zu alt, sagt die App, welche aktualisiert werden muss.

## Inhalt

- [Installieren](#installieren)
- [Erster Start](#erster-start)
- [App-Einstellungen](#app-einstellungen)
- [Player](#player)
- [Downloads und Speicher](#downloads-und-speicher)
- [Verschlüsselung der Dateien und ihre Grenzen](#verschlüsselung-der-dateien-und-ihre-grenzen)
- [Offline](#offline)
- [Benachrichtigungen](#benachrichtigungen)
- [Chromecast](#chromecast)
- [Fehlersuche](#fehlersuche)
- [Schritte für den Betreiber: Signatur und Google Play](#schritte-für-den-betreiber-signatur-und-google-play)
- [Prüfliste auf einem echten Gerät](#prüfliste-auf-einem-echten-gerät)
- [Selbst bauen](#selbst-bauen)

## Installieren

**Über Google Play (geschlossener Test).** Die App wird über einen geschlossenen Test-Track mit Haushalt und Freunden geteilt, nicht im öffentlichen Play Store.

1. Der FriendFlix-Admin trägt dein Google-Konto bei den Testern ein (siehe [Schritte für den Betreiber](#schritte-für-den-betreiber-signatur-und-google-play)) und schickt dir den Test-Link.
2. Öffne den Link auf dem Handy, angemeldet bei Google Play mit diesem Konto, tippe auf **Tester werden** und dann auf **Bei Google Play herunterladen**.
3. Updates kommen wie bei jeder anderen App über Google Play.

**Über das GitHub-Release (Notlösung).** Jedes Release (`vX.Y.Z`) hat neben den Release-Notes eine signierte `friendflix-android-X.Y.Z.apk` und eine `.sha256`-Datei zum Prüfen. Lade die APK auf dem Handy herunter, erlaube deinem Browser das Installieren unbekannter Apps, wenn Android fragt, und installiere sie. Updates kommen so nicht automatisch: Installiere die nächste APK darüber.

> Die Play-Version und die APK sind mit verschiedenen Schlüsseln signiert (Google Play signiert, was es ausliefert, neu). Android kann die eine nicht mit der anderen aktualisieren: Zum Wechseln die App erst deinstallieren. Das Deinstallieren löscht die Downloads auf dem Handy.

## Erster Start

1. Gib die Adresse deines FriendFlix-Servers ein, zum Beispiel `friend.example.com` (`https://` ergänzt die App; reines `http` wird abgelehnt).
2. Die App prüft, ob die Adresse wie ein passender FriendFlix-Server antwortet (`GET /api/version`). Wenn nicht, sagt sie warum: nicht erreichbar, Zertifikat nicht vertrauenswürdig, kein FriendFlix-Server oder welche Seite ein Update braucht.
3. Melde dich genau wie im Browser an, in der App: mit der Anmeldung in der App oder auf der Anmeldeseite deines Servers bei seinem Identitätsanbieter (zum Beispiel Authentik). Die erneute Anmeldung für die Kontosicherheit und *PIN vergessen* funktionieren genauso. Gibt dein Server neue Geräte erst frei, erscheint das Handy beim Admin als neues Gerät, wie ein Browser auch.
4. Ab Android 13 fragt die App **einmal**, ob sie Benachrichtigungen zeigen darf. Sagst du nein, fragt sie nicht noch einmal; erlauben kannst du sie später in den App-Einstellungen.

Die App öffnet nur die Adresse deines Servers und, zum Anmelden, die Anmeldeseite deines Servers (die Adresse des Identitätsanbieters, die der Server in `GET /api/version` als `authOrigin` nennt; die App liest sie bei der Einrichtung und bei jedem Start). Jeder andere Link (Trailer, IMDb, Hilfeseiten) öffnet sich in deinem normalen Browser. Die Anmeldeseite bekommt nie die nativen Funktionen der App, und die eigenen Anfragen der App (Player, Downloads, Benachrichtigungen) schicken deine Sitzung nie dorthin.

**Passkeys.** Wo das WebView des Handys es kann, reicht die App Passkey-Anfragen an Androids Anmeldedaten-Verwaltung weiter. Android bietet einen Passkey nur einer App an, die die Website des Passkeys mit sich verknüpft hat (Digital Asset Links); in der App gehen Passkeys also nach dem Betreiber-Schritt [5. Passkeys in der App](#5-passkeys-in-der-app-optional). Ohne ihn meldest du dich wie gewohnt mit Passwort (und zweitem Faktor) an.

**Vollbild.** Der Vollbild-Knopf des Web-Players füllt den Bildschirm und blendet die Systemleisten aus; Androids Zurück beendet das Vollbild.

## App-Einstellungen

Du öffnest sie in der Weboberfläche unter **Einstellungen → App auf diesem Gerät → App-Einstellungen öffnen**, aus der Offline-Liste oder über Androids App-Info (das Zahnrad).

| Einstellung | Was sie tut |
|---|---|
| Server | Zeigt die Serveradresse. **Server wechseln** fragt nach der neuen Adresse und warnt vorher: Du wirst auf diesem Gerät abgemeldet, und alle Downloads auf diesem Gerät werden entfernt. Die Lizenzen gehen an den alten Server zurück, wenn er erreichbar ist, und die Sitzung dort wird beendet. Dann durchläuft die neue Adresse dieselbe Prüfung wie beim ersten Start. |
| Downloads: Telefon / SD-Karte | Wohin neue Downloads gehen, mit dem freien Platz. Ohne Karte steht dort *nicht eingesetzt*. Gibt es fertige Downloads, bietet die App an, sie zu **verschieben**; jede Datei wird kopiert und geprüft, bevor das Original gelöscht wird. |
| Nur über WLAN herunterladen | Standardmäßig aus. Ist es an, warten Downloads auf WLAN und nutzen nie mobile Daten. |
| Ton im Hintergrund | Standardmäßig aus. Ist es an, läuft der Ton bei ausgeschaltetem Bildschirm oder in einer anderen App weiter, mit Steuerung in der Benachrichtigung und auf dem Sperrbildschirm. Ist es aus, pausiert die Wiedergabe (Bild-im-Bild geht trotzdem). |
| Benachrichtigungen | Zeigt, ob die App dich benachrichtigen darf, mit **Benachrichtigungen erlauben**, wenn nicht. Vier Kategorien lassen sich ein- und ausschalten: *Neue Folgen und Titel*, *Anfragen*, *Konto und Zugang*, *Sonstiges*. |
| Downloads auf diesem Gerät | Öffnet die Offline-Liste. |
| (Kinderprofile) | Die Offline-Liste hat keinen Einstellungen-Knopf, solange zuletzt ein Kinderprofil genutzt wurde (das erfährt die App bei jedem Start mit Netz), so wie die Weboberfläche den Eintrag ausblendet. Androids App-Info (das Zahnrad) öffnet die Einstellungen trotzdem: Das ist der Weg für den Besitzer des Geräts. |
| Auf diesem Gerät abmelden | Nach einer Rückfrage: schließt einen offenen Player, beendet deine Sitzung auf dem Server (wenn erreichbar), gibt die Lizenzen zurück, löscht alle Downloads auf diesem Gerät und die Schlüssel, mit denen sie verschlüsselt sind, leert die Cookies und gespeicherten Webdaten der App und vergisst, welche Benachrichtigungen du schon gesehen hast. Dein Konto, deine Profile und dein Verlauf bleiben, wie sie sind. |
| Version | Die App-Version (dieselbe wie das Server-Release, zu dem sie gehört). |

Alles andere, etwa Wiedergabesprachen, Untertitel, Autoplay und die Standardqualität für Downloads, stellst du wie gewohnt in der Weboberfläche ein.

## Player

Der native Player hat die Knöpfe der Steuerleiste des Web-Players, in derselben Reihenfolge. Knöpfe, die den Server brauchen, erscheinen nur, wenn der Server die Funktion anbietet.

**Obere Leiste** (von rechts: *Mehr*, *Audio und Untertitel*, *Besetzung & Infos*, der Chromecast-Knopf, der Qualitäts-Chip):

- **Mehr (⋯):**
  - *Wiedergabetempo:* 0,5× bis 2×. Es wird nicht gespeichert: Jeder Titel beginnt mit 1×. Ein Abzeichen am Knopf zeigt ein Tempo außer 1×.
  - *Lesezeichen:* *Szene teilen* teilt einen Link auf die aktuelle Position über das Teilen-Menü von Android. Du kannst ein Lesezeichen mit kurzer Notiz (bis 140 Zeichen) anlegen, eines antippen, um dorthin zu springen, oder es entfernen.
  - *Qualität:* die Qualitätsauswahl, die vorher in der oberen Leiste war.
  - *Schlaf-Timer:* aus, 15, 30, 45 oder 60 Minuten oder *Nach dieser Folge*. Läuft er ab, pausiert die Wiedergabe mit dem Hinweis *Schlaf-Timer: Wiedergabe pausiert*. Ein Punkt am Knopf zeigt einen laufenden Timer, die Restzeit steht in Mehr. *Nach dieser Folge* verhindert, dass die nächste Folge startet. Der Timer läuft auch mit Ton im Hintergrund weiter.
  - *Bedienung sperren:* blendet alle Bedienelemente aus und ignoriert Berührungen, damit nichts aus Versehen passiert. Nur ein Schloss bleibt; halte es kurz gedrückt, um zu entsperren. Ein kurzes Tippen oder Android-Zurück zeigt *Zum Entsperren gedrückt halten*.
  - *Bild-in-Bild:* dasselbe kleine Fenster wie mit Home während der Wiedergabe.
  - *Auf dem Fernseher abspielen* / *Läuft auf dem Fernseher:* die Chromecast-Wahl, sichtbar, wenn ein Cast-Gerät verfügbar oder verbunden ist.
- **Audio und Untertitel:** Tonspur und Untertitel wie bisher, dazu:
  - *Untertitel suchen …*, wenn dein Server die Untertitelsuche erlaubt und deine Rolle sie nutzen darf. Sprache wählen, dann ein Ergebnis. Der Player lädt an derselben Position neu und meldet *Untertitel hinzugefügt – im Menü auswählen*.
  - *Klare Stimmen* (Dialoge heben sich von Musik und Effekten ab) und *Nachtmodus* (laute Szenen leiser, leise lauter). Sie brauchen Android 9 oder neuer; auf Android 8 sind sie mit einem Hinweis ausgegraut. Die Einstellung wird für dein Profil gespeichert, wie im Web-Player.
- **Besetzung & Infos:** Besetzung, Gaststars, Crew, Studios und Genres des Titels, mit Bildern. Ein Tipp auf eine Person zeigt ihre anderen Titel, ein Tipp auf einen Titel schließt den Player und öffnet die Seite des Titels in der App.
- **Qualitäts-Chip:** *Original*, wenn die Datei unverändert läuft, oder *Umgewandelt · 1080p*, wenn der Server sie umwandelt. Ein Tipp sagt warum, zum Beispiel das Netz, ein Limit deiner Rolle oder ein Codec, den das Handy nicht abspielen kann.

**Untere Leiste:**

- **Folgen** (nur bei Folgen einer Serie): die Staffeln und ihre Folgen, mit Fortschritt. Ein Tipp spielt die Folge im selben Player.
- **Szenen** (wenn der Server Kapitel hat): die Kapitel, mit Bildern, wo der Server welche hat. Ein Tipp springt dorthin. Kapitelanfänge und deine Lesezeichen sind auf der Zeitleiste markiert.
- **Zeitleiste:** Beim Ziehen zeigt ein kleines Vorschaubild das Bild an dieser Stelle, wenn der Server Vorschaubilder anbietet.

**Am Ende eines Titels:** Ist Post-Play an (auf dem Server und in deinem Profil) und folgt keine nächste Folge, erscheint kurz vor dem Ende eine Karte *Fertig? Sieh dir an, was als Nächstes kommt*. Am Ende öffnet sich die Seite *Was als Nächstes?* mit Reihen von Vorschlägen: *Abspielen* startet den nächsten Teil im Player, ein Tipp auf einen Titel öffnet seine Seite. Bei einem Film ohne Post-Play zeigt *Mehr davon* drei ähnliche Titel. Im Bild-im-Bild wartet die Seite, bis du den Player wieder öffnest. Der Player schließt sich am Ende nie von selbst.

Deine *Untertitel-Darstellung* aus den Web-Einstellungen (Größe, Farbe, Hintergrund, Schrift) gilt für die Untertitel. Mit *Anime: Originalton mit Untertiteln* in deinem Profil beginnt eine Anime-Serie auf Japanisch mit Untertiteln in der Sprache der App, außer du hast für diese Serie etwas anderes gewählt.

**Offline (ein Download):** *Folgen*, *Szenen*, *Besetzung & Infos*, Lesezeichen, Untertitelsuche, Qualität, der Qualitäts-Chip, Chromecast und Post-Play brauchen den Server und sind ausgeblendet. Tempo, *Klare Stimmen* und *Nachtmodus* (mit deiner letzten Einstellung auf diesem Handy), Untertitel und ihre Darstellung, Schlaf-Timer, Sperre und Bild-im-Bild funktionieren.

**Beim Casting:** Das Handy ist die Fernbedienung für den Fernseher. *Folgen* spielt die gewählte Folge auf dem Fernseher, *Szenen* und Lesezeichen springen auf dem Fernseher, ein neues Lesezeichen nimmt die Position des Fernsehers, der Schlaf-Timer pausiert den Fernseher, und *Besetzung & Infos* zeigt den Titel, den der Fernseher spielt. Beim Casting nicht angeboten: Ton, Untertitel, Untertitelsuche, *Klare Stimmen* und *Nachtmodus*, Qualität und ihr Chip, Tempo, Sperre, Bild-im-Bild und Post-Play. Der Chromecast-Knopf bleibt ganz rechts in der oberen Leiste an erster Stelle, und Mehr zeigt *Läuft auf dem Fernseher*.

## Downloads und Speicher

Du startest einen Download in der Weboberfläche wie im Browser: Der Server legt die Lizenz mit Qualität und Ablauf an (siehe [downloads.md](../downloads.md)), die App übernimmt die Übertragung.

- Downloads laufen als Hintergrundaufgaben und gehen weiter, wenn die App geschlossen wird, das Netz abbricht oder das Handy neu startet; eine unterbrochene Datei macht dort weiter, wo sie aufgehört hat. Während eine Datei lädt, zeigt Android eine Benachrichtigung mit dem Fortschritt (ohne Titel).
- Die Dateien liegen im eigenen Ordner der App auf dem Telefon oder der SD-Karte (`Android/data/com.friendflix/files/downloads`). Die App braucht keine Speicherberechtigung. Andere Apps können die Dateien nicht nutzen, und mit der App werden sie deinstalliert.
- Text-Untertitel (SRT, VTT) und das Poster werden mit dem Titel geladen. Bild-Untertitel (PGS, VobSub) gibt es offline nicht.
- Wird die Karte mit einem Download herausgenommen, steht er auf pausiert und geht weiter, sobald die Karte zurück ist.
- Endet die Sitzung auf dem Server (anderswo abgemeldet, abgelaufen), pausieren die Downloads mit dem Hinweis *Bitte erneut anmelden* und gehen nach der nächsten Anmeldung weiter.
- Die Seite **Downloads** der Weboberfläche (auch *Zu den Downloads* bei einem Titel) zeigt die Downloads der App für das aktive Profil, mit Abspielen (nativer Player) und Löschen, auch für abgelaufene.
- Löschst du einen Download in der App (auf der Seite Downloads oder mit **Entfernen** in der Offline-Liste), geht die Lizenz an den Server zurück und zählt nicht mehr gegen dein Limit. Ein abgelaufener Download lässt sich genauso entfernen.

## Verschlüsselung der Dateien und ihre Grenzen

Jede heruntergeladene Datei (Video, Untertitel, Bilder) wird verschlüsselt geschrieben: AES-256 im Zählermodus mit einem zufälligen IV pro Datei und einem HMAC-SHA256 pro 1-MiB-Block, damit der Player springen kann und jede Änderung an der Datei auffällt. Die Schlüssel entstehen auf dem Handy: ein zufälliger Daten- und MAC-Schlüssel, verpackt mit einem Schlüssel im Android Keystore (in der Sicherheitshardware, wo das Handy eine hat) und abgelegt in einem Ordner, der nie gesichert wird.

Das bringt dir: Eine vom Handy kopierte Datei, etwa von einer SD-Karte im Computer, ist unlesbar und spielt nur in dieser App auf diesem Handy. Eine veränderte Datei wird abgelehnt statt abgespielt.

Das bringt es **nicht**:

- **Es ist kein DRM.** Während die App läuft, liegen die entpackten Schlüssel in ihrem Speicher. Wer das Handy voll kontrolliert (Root oder ein Debugger auf einem entsperrten Gerät), kommt an sie heran und kann die Dateien entschlüsseln.
- Die Dateigröße verrät ungefähr, wie lang ein Video ist.
- App-Daten löschen, die App deinstallieren oder **Auf diesem Gerät abmelden** löscht die Schlüssel; die Downloads sind damit weg und müssen neu geladen werden. Verliert Android den Keystore-Schlüssel (selten, etwa nach manchen Geräte-Resets), bemerkt die App das und entfernt die Downloads, die sie nicht mehr lesen kann.
- Lizenzen, Ablauf und Widerruf setzt der Server durch, und die App prüft sie (nächster Abschnitt). Sie schützen vor Missbrauch aus Versehen, nicht vor einem entschlossenen Besitzer eines gerooteten Handys.

## Offline

Startet die App und der Server ist nicht erreichbar (kein Netz, Flugmodus, Server aus) und das aktive Profil hat fertige Downloads, öffnet die App die **Offline-Liste**. Du kannst sie auch aus den App-Einstellungen öffnen.

- Sie zeigt die Downloads des zuletzt genutzten Profils mit Größe und den verbleibenden Tagen. *noch N Tage* ist das **Offline-Fenster**: der Ablauf der Lizenz oder das Ende der Offline-Frist, je nachdem, was früher kommt.
- Die Offline-Frist ist `DOWNLOAD_OFFLINE_GRACE_DAYS` des Servers (Standard 7 Tage) nach der letzten Online-Prüfung. Danach bittet ein Download, kurz online zu gehen; eine Prüfung verlängert ihn.
- Wurde die Uhr des Handys zurückgestellt, wird die Wiedergabe bis zur nächsten Online-Prüfung abgelehnt.
- Positionen und „gesehen" werden auf dem Handy gespeichert und beim nächsten Start oder sobald das Netz zurück ist an den Server geschickt. Ein neuerer Stand auf dem Server gewinnt.
- **Entfernen** in einer Zeile löscht diesen Download nach einer Rückfrage vom Handy (auch einen abgelaufenen).
- **Erneut verbinden** prüft den Server und kehrt zur Weboberfläche zurück. Auf dem Server widerrufene Lizenzen (Gerät entfernt, Rolle geändert, Konto deaktiviert) löschen bei dieser Prüfung die Dateien.

## Benachrichtigungen

Server-Benachrichtigungen (eine neue Folge einer Serie, der du folgst, eine erledigte Anfrage, ein freigegebenes Gerät, Einladungen und so weiter) erreichen das Handy ohne fremden Push-Dienst:

- Eine Hintergrundaufgabe fragt deinen Server etwa alle 10–20 Minuten nach neuen Benachrichtigungen (`GET /api/notifications`, mit der Sitzung der App; Android kann das weiter verzögern). Den genauen Zeitpunkt bestimmt Android, im Energiesparmodus oder Doze noch später; es ist nicht sofort.
- Nur Neues wird gezeigt. Der erste Lauf nach der Anmeldung zeigt nichts (er merkt sich nur, was da ist), und was du in der Weboberfläche schon gelesen hast, wird übersprungen. Die App markiert auf dem Server nichts als gelesen.
- Ein Tipp auf die Benachrichtigung öffnet die passende Seite in der App; ein Link zu einem Titel spielt ihn im nativen Player.
- Jede Kategorie ist ein eigener Android-Benachrichtigungskanal; Ton und Wichtigkeit lassen sich je Kategorie auch in den Android-Einstellungen ändern.
- Endet die Sitzung, fragt die App nicht mehr nach, bis du sie öffnest und dich wieder anmeldest.
- Der Text ist der Text des Servers und kann einen Titel enthalten. Um ihn auf dem Sperrbildschirm zu verbergen, nutze Androids Einstellung für Benachrichtigungen auf dem Sperrbildschirm.

Download-Benachrichtigungen (Fortschritt, *Bitte erneut anmelden*) zeigen nie Titel.

## Chromecast

Im nativen Player erscheint ein Cast-Symbol, wenn ein Chromecast oder Google TV im selben WLAN ist und dein Server Casting erlaubt.

- Casting nutzt dieselben kurzlebigen Cast-Tokens wie die Weboberfläche. Setzt der Server `CAST_RECEIVER_APP_ID`, läuft auf dem Fernseher der eigene Receiver von FriendFlix, sonst Googles Default Media Receiver ([cast.md](../cast.md)). Die App liest diese Einstellung beim Start; nach einer Änderung die App neu starten.
- Die nächste Folge wird auf dem Fernseher eingereiht, wenn Autoplay es erlaubt; das Handy behält die Steuerung, auch auf dem Sperrbildschirm.
- Beendest du das Casting, geht es auf dem Handy dort weiter, wo der Fernseher war. Schließt du den Player, endet das Casting.
- Downloads werden nie gecastet; beim Abspielen eines Downloads ist das Cast-Symbol ausgeblendet.
- Ton-, Untertitel- und Qualitätswechsel, Tempo, Untertitelsuche, *Klare Stimmen* und *Nachtmodus* gibt es während des Castings nicht; wähle sie vorher. *Folgen*, *Szenen*, Lesezeichen, der Schlaf-Timer und *Besetzung & Infos* wirken auf den Fernseher ([Player](#player)).
- Die Cast-Funktion kommt aus Googles Cast SDK, das Googles eigene Cast-Telemetrie mitbringt (sie meldet an Google wie in jeder App mit Google Cast). FriendFlix selbst sendet keine Analysedaten. Auf einem Handy ohne Google-Play-Dienste gibt es kein Cast-Symbol; alles andere funktioniert. Einzelheiten: [security.md, Android app](../security.md#android-app).

## Fehlersuche

| Was du siehst | Was du prüfst |
|---|---|
| *Diese Adresse antwortet nicht wie ein FriendFlix-Server.* | Öffnet die Adresse FriendFlix im Browser? Ein Captive Portal (Hotel-WLAN) oder eine Regel im Reverse Proxy kann stattdessen antworten. `https://friend.example.com/api/version` muss die Version von FriendFlix liefern. |
| *Die sichere Verbindung ist fehlgeschlagen.* | Das Zertifikat muss von einer öffentlichen Zertifizierungsstelle kommen. Selbstsignierte Zertifikate und selbst installierte Zertifizierungsstellen werden nicht akzeptiert, auch nicht in Debug-Builds. |
| *Bitte die App aktualisieren.* / *Bitte FriendFlix auf dem Server aktualisieren.* | App- und Server-Version liegen zu weit auseinander. Aktualisiere die genannte Seite. |
| Ein Download bleibt *pausiert* | *Nur über WLAN herunterladen* ist an und es gibt kein WLAN; die SD-Karte fehlt; in der Weboberfläche ist ein anderes Profil aktiv (es geht weiter, sobald das Profil des Downloads wieder aktiv ist); oder der Hinweis *Bitte erneut anmelden* wartet. |
| Ein Download bricht mit Fehler ab | *Nicht genug Speicher* oder ein Speicherfehler: Platz schaffen und den Download in der Weboberfläche neu starten. |
| *Bitte kurz online gehen, um den Download zu bestätigen.* | Das Offline-Fenster ist vorbei. Einmal verbinden; die Prüfung verlängert es. |
| *Die Uhrzeit des Geräts stimmt nicht.* | Die Uhr wurde zurückgestellt. Uhrzeit automatisch einstellen und einmal online gehen. |
| *Auf diesem Gerät gerade nicht verfügbar.* | Androids Keystore hat nicht geantwortet. Gleich noch einmal versuchen oder das Handy neu starten; nichts wird gelöscht. |
| Keine Benachrichtigungen | In den App-Einstellungen erlaubt? Kategorie an? Die Akku-Optimierung für FriendFlix in den Android-Einstellungen kann sie weiter verzögern. Nach einem Ereignis mindestens 20 Minuten warten. |
| Kein Cast-Symbol | Gleiches WLAN wie der Fernseher? Casting auf dem Server erlaubt? Google-Play-Dienste installiert? Läuft gerade ein Download? |
| *Maximal N gleichzeitige Streams erlaubt.* | Das Stream-Limit deines Kontos ist erreicht (andere Geräte oder ein noch laufendes Casting). Beende einen. |
| Die APK lässt sich nicht über die Play-Version installieren (oder umgekehrt) | Unterschiedliche Signaturen, siehe [Installieren](#installieren). Erst deinstallieren. |
| Etwas anderes | Dieselbe Seite im Browser öffnen: Klappt es dort auch nicht, liegt es am Server. Als letzter Schritt auf diesem Gerät abmelden und wieder anmelden (die Downloads werden gelöscht). |

## Schritte für den Betreiber: Signatur und Google Play

Diese Schritte erledigt einmal, wem das Repository und das Play-Console-Konto gehören. Nichts davon landet im Repository.

### 1. Upload-Schlüssel erstellen

Der Upload-Schlüssel signiert, was du bei Google Play hochlädst; Google signiert die App für die Auslieferung dann mit einem eigenen Schlüssel (Play App Signing). Auf einem vertrauenswürdigen Rechner mit JDK:

```sh
keytool -genkeypair -v -storetype PKCS12 -keystore friendflix-upload.jks \
  -alias upload -keyalg RSA -keysize 4096 -validity 10000
```

Nimm ein starkes Passwort (PKCS12 nutzt dasselbe Passwort für Keystore und Schlüssel). Bewahre `friendflix-upload.jks` und das Passwort im Passwortmanager oder in einer Offline-Sicherung auf. Geht er verloren, kann Google den Upload-Schlüssel zurücksetzen (Play Console → *Testen und veröffentlichen* → *App-Integrität*).

### 2. Die drei GitHub-Secrets anlegen

Im Repository: *Settings → Secrets and variables → Actions → New repository secret*, oder mit der GitHub-CLI:

```sh
base64 -w0 friendflix-upload.jks > upload.b64        # macOS: base64 -i friendflix-upload.jks > upload.b64
gh secret set ANDROID_UPLOAD_KEYSTORE < upload.b64
gh secret set ANDROID_UPLOAD_KEY_PASSWORD             # fragt nach dem Passwort, nichts landet im Shell-Verlauf
gh secret set ANDROID_UPLOAD_KEY_ALIAS --body upload
rm upload.b64
```

| Secret | Wert |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE` | die Keystore-Datei, base64 |
| `ANDROID_UPLOAD_KEY_PASSWORD` | das Passwort für Keystore und Schlüssel |
| `ANDROID_UPLOAD_KEY_ALIAS` | der Alias des Schlüssels (oben `upload`) |

Ab dann baut jeder Release-Tag (`vX.Y.Z`, erstellt vom Workflow *Release*) in der CI eine signierte AAB und APK (`.github/workflows/android-release.yml`) und hängt `friendflix-android-X.Y.Z.aab`, `friendflix-android-X.Y.Z.apk` und `friendflix-android-X.Y.Z.sha256` an das GitHub-Release. Der Keystore wird nur für diesen Build entpackt und gleich danach gelöscht. Ohne die drei Secrets hinterlässt der Job einen Hinweis und hängt nichts an; Pull Requests bauen immer unsigniert. Um die Dateien an ein Release zu hängen, das vor den Secrets erstellt wurde: *Actions → Android release → Run workflow* auf diesem Tag.

### 3. Die App in der Play Console anlegen

1. In der Play Console *App erstellen*: Name FriendFlix, App (kein Spiel), kostenlos. Die Grafiken für den Store-Eintrag (App-Symbol 512×512, Vorstellungsgrafik 1024×500, drei Handy-Screenshots 1080×1920 mit erfundenen Titeln) liegen in `android/play-listing/`; `android/play-listing/src/render.sh` erzeugt sie neu aus den README-Screenshots und dem Logo.
2. Fülle aus, was Google vor dem Testen verlangt (*Dashboard → App einrichten*): URL der Datenschutzerklärung (die der App ist [privacy.md](privacy.md); nimm ihre GitHub-Adresse `https://github.com/LetsManu/friendflix/blob/main/docs/privacy.md`), App-Zugriff (Tester brauchen ein FriendFlix-Konto auf deinem Server; gib Googles Prüfern ein Testkonto oder erkläre, dass der Zugang nur per Einladung geht), Werbung (keine), Einstufung des Inhalts, Zielgruppe, Datensicherheit. Für die Datensicherheit: Die App schickt, was du tust, nur an deinen eigenen FriendFlix-Server; sie enthält kein Analyse- oder Werbe-SDK; Googles Cast SDK sendet seine eigene Cast-Telemetrie an Google.
3. *Testen und veröffentlichen → Tests → Geschlossener Test → Track erstellen*, dann *Neuen Release erstellen*. Play App Signing ist für neue Apps standardmäßig an: *Von Google generierter Schlüssel* beibehalten.
4. Lade `friendflix-android-X.Y.Z.aab` aus dem GitHub-Release hoch. Der erste Upload legt den Paketnamen `com.friendflix` endgültig fest.
5. Veröffentliche den Release im geschlossenen Track. Google prüft ihn (meist Stunden bis einige Tage).

### 4. Tester hinzufügen

1. Im geschlossenen Track: *Tester → E-Mail-Liste erstellen* (oder eine Google-Gruppe) mit den Google-Konten von Haushalt und Freunden, und die Länder wählen.
2. Den **Link zur Teilnahme** kopieren und verschicken ([Installieren](#installieren)).
3. Für jedes spätere Release die neue AAB in denselben Track hochladen. Die Tester bekommen sie als Update.

Ein geschlossener Test reicht für Haushalt und Freunde; die App braucht keinen öffentlichen Eintrag im Play Store.

### 5. Passkeys in der App (optional)

Die App nutzt für Passkeys (WebAuthn) den App-Modus des WebViews: Androids Anmeldedaten-Verwaltung gibt einen Passkey nur dann an die App, wenn die **Relying Party** des Passkeys (seine RP-ID, die Domain, zu der die Passkeys gehören; bei Authentik in der WebAuthn-Authenticator-Stage eingestellt, meist der Host der Anmeldeseite oder die gemeinsame übergeordnete Domain) die App verknüpft hat. Lege diese Datei unter `https://<rp-id>/.well-known/assetlinks.json` ab (zum Beispiel `https://auth.example.com/.well-known/assetlinks.json`), ausgeliefert als `application/json` ohne Weiterleitung:

```json
[
  {
    "relation": ["delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.friendflix",
      "sha256_cert_fingerprints": [
        "<SHA-256 DES PLAY-APP-SIGNATURSCHLÜSSELS>",
        "<SHA-256 DEINES UPLOAD-SCHLÜSSELS>"
      ]
    }
  }
]
```

- *Play-App-Signaturschlüssel*: Play Console → *Testen und veröffentlichen* → *App-Integrität* → *Zertifikat des App-Signaturschlüssels*, SHA-256 (damit ist die App aus Google Play signiert).
- *Upload-Schlüssel*: `keytool -list -v -keystore friendflix-upload.jks -alias upload` (damit ist die APK aus dem GitHub-Release signiert). Beide Fingerabdrücke haben die Form `AA:BB:…` (32 Paare).

Fehlt die Datei oder stimmt sie nicht, bietet die App einfach keine Passkeys an; die Anmeldung mit Passwort funktioniert in jedem Fall.

## Prüfliste auf einem echten Gerät

Unit-Tests und der Emulator in der CI decken die Logik ab; diese Punkte brauchen ein echtes Handy (gesammelt aus den Entwicklungsnotizen der App). Nimm einen Testserver, eine SD-Karte, wenn das Handy einen Steckplatz hat, einen Chromecast und Bluetooth-Kopfhörer.

**Installation und Hülle**
1. Frische Installation, erster Start: Die Einrichtung nimmt `friend.example.com` an und lehnt `http://`, einen falschen Host und einen Server mit selbstsigniertem Zertifikat mit der passenden Meldung ab.
2. Anmelden (Anmeldung in der App und deine Anmeldeseite). Externe Links öffnen sich im Browser; Androids Zurück geht durch den Verlauf der Weboberfläche und verlässt die App auf der Startseite.
3. Klassische Anmeldung über den Identitätsanbieter: Auf einem Server, dessen Anmeldeseite der Identitätsanbieter ist (`LOGIN_UI=authentik` oder `/auth/login?classic=1`), öffnet sich die Anmeldeseite in der App, und nach dem Anmelden bist du zurück in der Weboberfläche; kein Browser öffnet sich. Ein Link auf der Anmeldeseite zu einer anderen Website öffnet sich im Browser.
4. Erneute Anmeldung (z. B. Kontosicherheit): Eine Aktion, die eine erneute Anmeldung verlangt, öffnet den Identitätsanbieter in der App und kehrt zur Seite zurück.
5. PIN vergessen: *PIN vergessen* auf dem PIN-Bildschirm eines Profils meldet dich beim Identitätsanbieter in der App erneut an und kehrt zum Festlegen einer neuen PIN zurück.
6. Passkeys: Mit veröffentlichter `assetlinks.json` (Betreiber-Schritt 5) auf der Anmeldeseite mit einem Passkey anmelden. Ohne sie wird kein Passkey angeboten, und die Anmeldung mit Passwort funktioniert.
7. Ein Titel im Web-Player (zum Beispiel nachdem der native Player ihn zurückgegeben hat): Der Vollbild-Knopf füllt den Bildschirm ohne Systemleisten; Androids Zurück beendet zuerst das Vollbild.
8. `adb shell am start -n com.friendflix/app.friendflix.android.shell.ShellActivity --es app.friendflix.android.OPEN_PATH /requests` öffnet die Startseite, nicht `/requests`; ein Tipp auf eine Benachrichtigung öffnet weiter ihre Seite (er nutzt den nicht exportierten Einstieg).
9. Android 13+: Die Benachrichtigungs-Berechtigung wird beim ersten Start einmal erfragt und nie wieder von selbst; *Benachrichtigungen erlauben* in den App-Einstellungen fragt erneut oder öffnet nach zwei Ablehnungen die Android-Einstellungen.

**Downloads und Speicher**
10. Einen Film über mobile Daten und über WLAN laden; mit *Nur über WLAN herunterladen* wartet er, bis WLAN zurück ist.
11. Bildschirm aus während eines Downloads: Er läuft mit der Fortschritts-Benachrichtigung weiter (ohne Titel darin). App in den letzten Apps schließen, Handy neu starten: Er macht dort weiter, wo er war.
12. Flugmodus mitten im Download: Er pausiert und geht danach von selbst weiter.
13. SD-Karte: In den Einstellungen wählen, während Downloads auf dem Telefon liegen, und *Verschieben* nehmen; sie wandern und spielen weiter. Karte herausnehmen: Die Downloads stehen auf pausiert; wieder einsetzen: Sie gehen weiter. Eine Datei von der Karte auf einen Computer kopieren: unlesbar.
14. In der Weboberfläche auf einem anderen Gerät abmelden (Sitzung endet): Downloads pausieren mit *Bitte erneut anmelden*; nach dem Anmelden gehen sie weiter.
15. Einen Download in der App löschen: Die Lizenz verschwindet auf dem Server (Konto → Downloads im Browser).
16. Die Seite Downloads der Weboberfläche in der App (auch *Zu den Downloads* bei einem Titel): Sie zeigt die Downloads der App für das aktive Profil (keine Speicheranzeige des Browsers), Abspielen öffnet den nativen Player, das X entfernt einen Download, auch einen abgelaufenen.
17. Offline-Liste: **Entfernen** in einer Zeile fragt erst nach, dann ist der Download weg (auch ein abgelaufener). Wurde zuletzt ein Kinderprofil genutzt (die App einmal online damit öffnen), zeigt die Offline-Liste keinen Einstellungen-Knopf; das Zahnrad in Androids App-Info öffnet die Einstellungen weiterhin.

**Offline**
18. Flugmodus, App mit fertigen Downloads starten: Die Offline-Liste öffnet sich (nur einmal, auch wenn die Startprüfung erneut läuft), zeigt die Tage als Offline-Fenster und spielt ab.
19. Eine Weile offline schauen, online gehen: Die Position steht im Web. Uhr einen Tag zurückstellen: Wiedergabe abgelehnt bis zur nächsten Online-Prüfung. Länger als die Offline-Frist offline bleiben: *Bitte kurz online gehen*.
20. Das Gerät auf dem Server widerrufen, wieder verbinden: Die Dateien werden gelöscht.

**Player**
21. Aus der Weboberfläche abspielen (Detailseite, Folgenliste, Hero): Der native Player öffnet sich. Doppeltippen oder ein erneuter Versuch nach 5 s öffnet keinen zweiten Player.
22. Folgen-Karten (Favoriten, Suche, eine Bibliotheksseite), die Verlaufsseite und *Hier abspielen* in der Cast-Leiste: Der native Player öffnet sich, die Weboberfläche bleibt auf ihrer Seite. Mit einem Profil, das der native Player zurückgibt, öffnet sich einmal der Web-Player (keine zweite Rückfrage).
23. Direktwiedergabe einer H.264-MP4. HEVC 10 Bit auf einem Handy mit HEVC-Hardware → direkt (Admin „Läuft gerade" sagt direkt), auf einem Handy ohne → Transcode.
24. Tonspur wechseln → neue Sitzung (ein Stopp und ein Start in der Admin-Ansicht), die Wahl wird für die Serie gemerkt. Untertitel an/aus, die Serienwahl wird gemerkt. Qualität wählen → Transcode in dieser Stufe.
25. Folge mit Intro: Der Überspringen-Knopf erscheint im Bereich; mit automatischem Überspringen springt sie einmal. Beim Abspann: die Nächste-Folge-Karte und ein 10-s-Countdown, der bei Pause wartet. „Abspann ansehen" bringt die Karte am Ende zurück. Drei Autoplays → „Noch da?".
26. Fortsetzen: bei Minute 10 stoppen, wieder öffnen → es geht dort weiter. Das Web zeigt dieselbe Position.
27. Home während der Wiedergabe → Bild-im-Bild (ab Android 12 automatisch; älter bei Home). Play/Pause im Bild-im-Bild geht. Schließen stoppt die Wiedergabe und meldet einen Stopp.
28. Ton im Hintergrund aus: Bildschirm aus oder Home ohne Bild-im-Bild → Pause; bei ausgeschaltetem Bildschirm pausieren, dann Play per Bluetooth oder in der Benachrichtigung → nichts passiert; zurück auf dem Bildschirm geht Play. Ton im Hintergrund an → der Ton läuft mit Benachrichtigung weiter; Play/Pause auf dem Sperrbildschirm und per Bluetooth gehen.
29. Ein Konto am Stream-Limit → „Maximal N gleichzeitige Streams …". Kinderprofil → die Ablehnung des Servers zeigt den allgemeinen Fehler.
30. Offline-Liste → einen Download abspielen: spielt, springt, die Position wird beim Verbinden übertragen. App beim Abspielen eines Offline-Titels beenden, aus den letzten Apps wieder öffnen → die Offline-Prüfung läuft erneut. Einen Offline-Titel länger als 5 min im Hintergrund pausieren und über die Benachrichtigung fortsetzen → die Prüfung läuft erneut (abgelehnt nach dem Offline-Fenster).
31. `https://friend.example.com/watch/<id>` über Neuladen oder einen Link öffnen → der native Player öffnet sich, die Weboberfläche bleibt auf der vorigen Seite. Ist noch kein Profil bekannt → der Web-Player lädt. Ein Watch-Link, während die Weboberfläche ein anderes Profil nutzt → der Player schließt und die Web-Wiedergabeseite spielt.
32. Drehen und Größe ändern (geteilter Bildschirm): Die Wiedergabe läuft ohne neue Sitzung weiter. Eine fertige Folge vom Ende neu starten → „Läuft gerade" beim Admin zeigt sie wieder, und beim Verlassen wird ein Stopp gemeldet.
33. Eine direkt abgespielte MKV mit eingebetteten Text-Untertiteln: Sie werden nicht angeboten (nur das WebVTT des Servers); prüfen, ob der Server sie als externe Untertitel listet.

**Bedienung im Player**
34. Die Leiste: oben von rechts *Mehr*, *Audio und Untertitel*, *Besetzung & Infos*, der Chromecast-Knopf, der Qualitäts-Chip; unten *Folgen*, *Szenen*, nächste Folge. Die Leiste sieht im Hoch- und Querformat und auf einem Tablet richtig aus.
35. Folgen: Bei einer Folge öffnet sich das Panel bei der aktuellen Staffel, mit Fortschritt und einer Markierung an der laufenden Folge; ein Film hat keinen Knopf *Folgen*. Eine andere Folge wählen: Sie spielt im selben Player, das Tempo ist wieder 1×, ein Schlaf-Timer *Nach dieser Folge* ist aufgehoben, und ihre Szenen und Lesezeichen laden.
36. Szenen und Markierungen: Ein Titel mit Kapiteln zeigt *Szenen* mit Bildern; ein Tipp springt dorthin und schließt das Panel. Kapitelanfänge und Lesezeichen sind Markierungen auf der Zeitleiste. Ein Titel ohne Kapitel hat keinen Knopf *Szenen*.
37. Vorschau beim Ziehen: die Zeitleiste ziehen; ein Bild über dem Regler folgt. Einen langen Film prüfen, dessen Vorschaubilder auf dem Server große Bögen haben: Die Vorschau kommt mit, die App wird nicht langsam und stürzt nicht ab. Ein Server ohne Vorschaubilder: kein Bild, Springen geht.
38. Besetzung & Infos: Das Panel zeigt die Titelzeile, Besetzung, Crew und Genres mit Bildern. Ein Tipp auf eine Person zeigt ihre Titel; ein Tipp auf einen Titel schließt den Player und öffnet seine Seite in der App.
39. Audio und Untertitel, *Untertitel suchen …*: Deutsch wählen, ein Ergebnis wählen: Der Player lädt an derselben Position neu und meldet *Untertitel hinzugefügt – im Menü auswählen*; der neue Untertitel steht in der Liste. Ein Gast oder ein Server ohne Untertitelsuche: keine Zeile. Kein Ergebnis und Fehler des Anbieters zeigen die Texte des Webs.
40. *Klare Stimmen* und *Nachtmodus* ab Android 9: Der Ton ändert sich hörbar; der Web-Player zeigt für das Profil dieselbe Einstellung. Auf Android 8 sind die Schalter ausgegraut mit *Auf diesem Gerät nicht verfügbar*. Beim Casting ist der Knopf *Audio und Untertitel* weg.
41. Mehr, Tempo: 1,5× zeigt ein Abzeichen an Mehr; die nächste Folge beginnt mit 1×. Mehr, Lesezeichen: *Szene teilen* öffnet das Teilen-Menü von Android mit einem Link `/watch/<id>?t=`; ein Lesezeichen mit Notiz anlegen, antippen zum Springen, entfernen. Mehr, Qualität: 720p wählen; der Chip zeigt *Umgewandelt · 720p*.
42. Schlaf-Timer: 15 Minuten zeigen einen Punkt an Mehr und die Restzeit in Mehr; läuft er ab, pausiert die Wiedergabe mit *Schlaf-Timer: Wiedergabe pausiert*. *Nach dieser Folge* auf dem Handy: kein Countdown zur nächsten Folge, die Wiedergabe pausiert am Ende. *Nach dieser Folge* beim Casting: Der Fernseher stoppt am Ende der Folge und macht nicht weiter.
43. Bedienung sperren: Berührungen bewirken nichts; Android-Zurück zeigt *Zum Entsperren gedrückt halten* und der Player bleibt; das Schloss gedrückt halten entsperrt.
44. Mehr, Bild-in-Bild: Das kleine Fenster öffnet sich; ein offenes Panel schließt sich, im Fenster erscheint kein Panel.
45. Qualitäts-Chip: *Original* bei einer direkten Datei; ein umgewandelter Stream zeigt beim Tippen den Grund.
46. Post-Play: ein Film mit Post-Play: *Fertig? Sieh dir an, was als Nächstes kommt* kurz vor dem Ende, die Seite *Was als Nächstes?* am Ende; *Abspielen* beim nächsten Teil spielt ihn im Player, ein Titel öffnet seine Seite. Ein Film ohne Post-Play: *Mehr davon* mit drei Titeln. Einen Titel im Bild-im-Bild enden lassen: Die Seite erscheint, sobald der Player wieder geöffnet ist. Der Player schließt sich am Ende nie von selbst.
47. Offline (ein Download): kein *Folgen*, *Szenen*, *Besetzung & Infos*, keine Lesezeichen, kein *Untertitel suchen …*, keine Qualität, kein Chip und kein Chromecast-Knopf; Tempo, Schlaf-Timer, Sperre, Untertitel, *Klare Stimmen* und *Nachtmodus* gehen.

**Chromecast**
48. Ein Cast-Gerät im WLAN und Casting erlaubt → das Cast-Symbol erscheint im Player. Kein Gerät → kein Symbol. Ein Download läuft → nie ein Symbol.
49. Symbol antippen, Fernseher wählen: Das Handy zeigt „Wird auf … abgespielt" und steuert den Fernseher; „Läuft gerade" beim Admin zeigt die lokale Sitzung gestoppt und die Cast-Sitzung gestartet.
50. Default Media Receiver (ohne `CAST_RECEIVER_APP_ID`): spielt ab der Position des Handys mit dem gewählten Untertitel; Pause und Springen gehen; der Fortschritt erscheint beim Admin.
51. Eigener Receiver: `CAST_RECEIVER_APP_ID` setzen, einen Titel einmal öffnen, App neu starten, casten: Der eigene Receiver startet, seine Meldungen kommen an, seine Nächste-Folge-Karte ist in der Sprache der App.
52. Folge mit Autoplay: etwa 40 min vor dem Ende wird die nächste Folge eingereiht; am Ende macht der Fernseher von selbst weiter, auch mit gesperrtem Handy, und der Titel auf dem Handy wechselt.
53. Casting im Cast-Dialog beenden → das Handy spielt an der Position des Fernsehers weiter (pausiert, wenn der Fernseher pausiert war). Fernseher aus oder sein Netz weg → das Handy übernimmt an der letzten Position. Player beim Casting schließen → der Fernseher stoppt.
54. Konto am Stream-Limit → Casting zeigt das Limit und die lokale Wiedergabe läuft weiter. Eine Rolle ohne Transcoding → „Chromecast braucht Transcoding …".
55. Länger als 50 min casten, auch mit gesperrtem Handy → der Fernseher spielt nach kurzem Nachladen weiter (Token-Erneuerung; stoppt er, prüfen, ob Doze die App angehalten hat).
56. Steuerung in Benachrichtigung und Sperrbildschirm beim Casting geht; ein Tipp bringt den Player zurück. App beim Casting beenden: Der Fernseher spielt eventuell weiter, bis das Token abläuft; erneutes Öffnen startet nichts von selbst.
57. Die Menüs des Players und der Cast-Dialog sehen im hellen und dunklen Systemmodus richtig aus.
58. Beim Casting: *Folgen* spielt die gewählte Folge auf dem Fernseher; *Szenen* und ein Lesezeichen springen auf dem Fernseher; ein neues Lesezeichen nimmt die Position des Fernsehers; *Besetzung & Infos* zeigt den Titel des Fernsehers, auch nachdem er zur nächsten Folge weitergegangen ist. *Audio und Untertitel*, der Qualitäts-Chip, der Knopf für die nächste Folge, Tempo, Qualität, Sperre und Bild-in-Bild sind weg. Der Chromecast-Knopf bleibt rechts an erster Stelle, und Mehr zeigt *Läuft auf dem Fernseher*.
59. Casting beenden: *Audio und Untertitel*, der Qualitäts-Chip und der Knopf für die nächste Folge sind wieder da.

**Benachrichtigungen**
60. Frische Installation, angemeldet: keine Flut beim ersten Abruf. Eine Benachrichtigung auf dem Server erzeugen (zum Beispiel eine Einladung) und sie nach etwa 10–20 min sehen (Android kann das weiter verzögern). Die Kanalnamen in den Android-Einstellungen auf Deutsch und Englisch prüfen.
61. Antippen: Die Hülle öffnet die richtige Seite; ein `/watch/…`-Link öffnet den nativen Player; ist die App schon offen, wechselt die Seite an Ort und Stelle.
62. Eine Kategorie in den App-Einstellungen ausschalten: Davon wird nichts mehr gezeigt. Berechtigung entziehen: kein Absturz, und die Einträge erscheinen nach erneutem Erlauben.
63. Sitzung läuft auf dem Server ab: keine Benachrichtigung und kein weiteres Abfragen; App öffnen, anmelden: Das Abfragen geht weiter.

**App-Einstellungen**
64. Den Server auf einen zweiten Testserver wechseln: Die Warnung nennt die neue Adresse; danach sind die Downloads weg, der alte Server zeigt die Lizenzen zurückgegeben und die Sitzung beendet, und die Einrichtung prüft die neue Adresse (ein Tippfehler bleibt mit ausgefüllter Adresse in der Einrichtung).
65. Auf diesem Gerät abmelden: Nach der Rückfrage zeigt die App die Anmeldeseite; Downloads und ihre Dateien sind weg (auch auf der SD-Karte), der nächste Download klappt (neue Schlüssel), und die alte Sitzung gilt auf dem Server nicht mehr.
66. Androids App-Info → das Zahnrad öffnet die App-Einstellungen; die angezeigte Version passt zum Release.

## Selbst bauen

Die App liegt in `android/` (Kotlin, Gradle, minSdk 26, targetSdk 36). Mit JDK 21 und dem Android SDK (Plattform 36):

```sh
cd android
./gradlew lint testDebugUnitTest assembleDebug    # Debug-APK in app/build/outputs/apk/debug/
```

Release-Builds (`assembleRelease`, `bundleRelease`) sind unsigniert, solange nicht alle drei Signatur-Umgebungsvariablen gesetzt sind (`android/app/build.gradle.kts` liest sie; der Release-Workflow setzt sie aus den Secrets):

| Gradle-Umgebungsvariable | Wert |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_FILE` | der **Pfad** der Keystore-Datei (`.jks`), nicht base64 |
| `ANDROID_UPLOAD_KEY_PASSWORD` | das Passwort für Keystore und Schlüssel |
| `ANDROID_UPLOAD_KEY_ALIAS` | der Alias des Schlüssels |

```sh
read -rs ANDROID_UPLOAD_KEY_PASSWORD && export ANDROID_UPLOAD_KEY_PASSWORD   # fragt nach dem Passwort, hält es aus dem Shell-Verlauf
ANDROID_UPLOAD_KEYSTORE_FILE=$HOME/keys/friendflix-upload.jks ANDROID_UPLOAD_KEY_ALIAS=upload \
  ./gradlew bundleRelease assembleRelease
```

Das GitHub-Secret `ANDROID_UPLOAD_KEYSTORE` ist etwas anderes: derselbe Keystore als base64, den der Workflow in eine temporäre Datei entpackt und als `ANDROID_UPLOAD_KEYSTORE_FILE` übergibt. Die Version kommt aus `version.json` oben im Repository. Sicherheitshinweise zur App: [security.md, Android app](../security.md#android-app).
