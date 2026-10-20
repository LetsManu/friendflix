# FriendFlix-Konto löschen

*English: [../account-deletion.md](../account-deletion.md)*

App: FriendFlix für Android (`app.friendflix.android`), veröffentlicht von Manuel Weißböck.

Jeden FriendFlix-Server betreibt jemand selbst (du, dein Haushalt oder ein Freund). Dein Konto und seine Daten liegen **nur auf diesem Server**. Der Herausgeber der App hat kein Konto von dir und keine Daten über dich, gelöscht wird deshalb auf deinem Server.

## Selbst löschen (in der App oder im Browser)

1. FriendFlix öffnen, in der App oder im Browser unter der Adresse deines Servers, mit deinem **Hauptprofil**.
2. **Mein Bereich → Konto** öffnen.
3. Optional: **Deine Daten → Meine Daten herunterladen** speichert eine Kopie deiner Daten als JSON-Datei.
4. **Konto löschen**, dann zur Bestätigung erneut anmelden.

Sofort danach ist dein Konto gesperrt, du bist auf allen Geräten abgemeldet und deine Downloads spielen nicht mehr. **7 Tage** lang kannst du das rückgängig machen, indem du dich wieder anmeldest und das Konto wiederherstellst. Danach ist die Löschung endgültig.

## Den Betreiber bitten

Kannst du dich nicht mehr anmelden, bitte die Person, die deinen FriendFlix-Server betreibt (wer dich eingeladen hat), dein Konto zu löschen. Das geht unter *Admin → Nutzer*.

## Was gelöscht wird, was bleibt

- **Gelöscht:** dein Konto und deine Profile, Listen, Merkliste, Bewertungen und Rezensionen, Wiedergabeverlauf, Anfragen, Geräte, Benachrichtigungs-Einstellungen sowie deine Nutzer auf dem Medienserver und beim Wunschdienst des Servers.
- **Bleibt, ohne deinen Namen:** Das Audit-Log des Servers behält seine Einträge mit einem Pseudonym (`deleted-…`) statt Name, E-Mail und IP-Adresse, dazu ein Vermerk, dass gelöscht wurde. Das Anmeldekonto wird deaktiviert; ob es auch gelöscht wird, entscheidet der Betreiber.
- **Backups und Logs** des Servers folgen den Aufbewahrungsfristen des Betreibers.

## Daten auf dem Handy

**Einstellungen → Auf diesem Gerät abmelden** in der App oder das Deinstallieren löscht alles, was die App auf dem Handy gespeichert hat: Downloads und ihre Schlüssel, Cookies und Einstellungen. Siehe [Datenschutzerklärung](privacy.md).

Fragen: <https://github.com/LetsManu/friendflix/issues>.
