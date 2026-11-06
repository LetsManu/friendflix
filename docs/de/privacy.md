# Datenschutzerklärung: FriendFlix-App für Android

*English: [../privacy.md](../privacy.md)*

Stand: 20. Oktober 2026. App: FriendFlix (`com.friendflix`), veröffentlicht von Manuel Weißböck.

## Kurz gesagt

FriendFlix verbindet sich nur mit einem FriendFlix-Server, den **du** beim ersten Start einträgst. Diesen Server betreibst meist du selbst, dein Haushalt oder ein Freund. Der Herausgeber der App betreibt keinen Server für die App und bekommt keine Daten von ihr. Die App enthält keine Analyse- und keine Werbefunktionen.

## Was die App sendet, und an wen

- **An deinen FriendFlix-Server:** alles, was du in der App tust: Anmelden, Stöbern, Abspielen, Herunterladen, Wiedergabestand, Anfragen und die Abfrage neuer Benachrichtigungen im Hintergrund (etwa alle 10 bis 20 Minuten, solange du angemeldet bist). Verantwortlich für diese Daten ist, wer den Server betreibt. Es gelten dessen Datenschutzbestimmungen, nicht diese Erklärung.
- **An die Anmeldeseite, die dein Server nennt** (sein Identity Provider), wenn du dich anmeldest.
- **An Google, nur für Chromecast:** Die App nutzt Googles Cast SDK. Wenn du den Player öffnest, sucht er im WLAN nach Cast-Geräten, und Google erhält seine üblichen Cast-Nutzungsdaten, wie in jeder App mit Cast-Knopf. Auf einem Handy ohne Google-Play-Dienste werden keine Cast-Daten gesendet.
- **Google Play** installiert und aktualisiert die App nach Googles eigener Datenschutzerklärung.

Der Herausgeber bekommt keine dieser Daten.

## Was auf dem Handy bleibt

- Die Serveradresse, das Sitzungs-Cookie, die App-Einstellungen und welche Benachrichtigungen du schon gesehen hast.
- Heruntergeladene Filme und Folgen, verschlüsselt gespeichert, mit Schlüsseln im Android Keystore.
- Offline entstandener Wiedergabestand, bis er an deinen Server gesendet ist.

Nichts davon landet in Android-Cloud-Backups oder in der Übertragung auf ein neues Gerät.

## Berechtigungen

| Berechtigung | Wofür |
|---|---|
| Internet, Netzwerkstatus | um deinen Server zu erreichen und zu merken, wann das Netz wieder da ist |
| Benachrichtigungen | Hinweise zu neuen Folgen, Anfragen und deinem Konto (abschaltbar) |
| Vordergrunddienst (Medienwiedergabe, Datensynchronisierung) | Ton im Hintergrund und Downloads bei ausgeschaltetem Bildschirm |

## Daten löschen

- **Einstellungen → Auf diesem Gerät abmelden** löscht alle Downloads, ihre Schlüssel, Cookies und gespeicherten Webdaten auf dem Handy.
- Beim Deinstallieren wird alles gelöscht, was die App auf dem Handy gespeichert hat.
- Dein Konto auf dem Server und die dort gespeicherten Daten: selbst löschen unter **Mein Bereich → Konto → Konto löschen** oder den Betreiber des Servers bitten. Ablauf und was bleibt: [account-deletion.md](account-deletion.md).

## Kinder

Die App hat kein eigenes Konto und sammelt nichts für ihren Herausgeber. Kinderprofile richtet ein, wer den Server betreibt.

## Änderungen und Kontakt

Änderungen dieser Erklärung werden unter dieser Adresse veröffentlicht, die Versionsgeschichte der Datei zeigt jede Änderung. Fragen: ein Issue unter <https://github.com/LetsManu/friendflix/issues> eröffnen.
