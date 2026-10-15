# Suche & Entdecken – API

Alle Endpunkte brauchen eine Sitzung, laufen mit dem Jellyfin-Token des aktiven Profils und zeigen deshalb nur Titel, die dieses Profil sehen darf.

## `GET /api/search?q=`

`q`: 2–100 Zeichen. Rate-Limit: 120 pro Minute.

```json
{ "q": "nolan", "titles": [ItemDto], "episodes": [ItemDto],
  "people": [{ "id": "…", "name": "…", "image": true }], "genres": ["…"], "partial": false }
```

- **Ablauf:** Titel (Filme und Serien, max. 24), Folgen (max. 8), Personen (max. 12) und die Genreliste werden parallel abgefragt.
- **Genres:** Es kommen nur Genres zurück, deren Name `q` enthält (max. 6).
- **Jahressuche:** Ist `q` eine Jahreszahl (1900–2100), sind `titles` die Titel dieses Jahres, nach Bewertung sortiert. `episodes` ist dann leer.
- **Teilausfall:** Schlägt eine Teilabfrage fehl, bleibt ihr Abschnitt leer und `partial` ist `true`. Schlagen alle fehl, antwortet der Endpunkt mit `502 {"error":"jellyfin"}`.
- **Personen:** Jellyfin `/Persons` mit `userId` ist ab 10.9 auf die Bibliotheken des Nutzers beschränkt. Eine Personenseite wird zusätzlich nur ausgeliefert, wenn mindestens ein sichtbarer Titel existiert.

## `GET /api/people/:id`

```json
{ "person": { "id": "…", "name": "…", "overview": "…", "birthYear": 1970, "image": true }, "items": [ItemDto] }
```

- `items` enthält bis zu 100 Filme und Serien aus der Bibliothek, die neuesten zuerst.
- `404 {"error":"not_found"}` kommt, wenn die ID keine Person ist oder das Profil keinen Titel mit ihr sehen kann.

## `GET /api/library/items` – neue Filter

| Parameter | Werte | Jellyfin |
|---|---|---|
| `decade` | 1900–2090, durch 10 teilbar | `years=1990,…,1999` |
| `year` | 1900–2100 (hat Vorrang vor `decade`) | `years` |
| `minRating` | 0–10 | `minCommunityRating` |
| `person` | Item-ID (32 hex) | `personIds` |

Ungültige Werte führen zu `400 {"error":"bad_request"}`.

## Sprachfilter: `GET /api/library/languages` und `audio`/`subs`

```json
{ "audio": [{ "code": "deu", "count": 412 }], "subs": [{ "code": "eng", "count": 380 }] }
```

- **Index:** `item_langs` (Filme und Serien) wird von `langIndexTick` aus den MediaStreams aller Filme und Folgen aufgebaut (Admin-Schlüssel, max. alle 12 h; nach einem Start nur, wenn die Tabelle leer ist oder der letzte Lauf (`langidx:last`) über 12 h zurückliegt, nur mit `BACKGROUND_JOBS=true`). Folgen werden je Serie zusammengefasst, `ger`/`fre`/… werden auf `deu`/`fra`/… vereinheitlicht, `und` entfällt. Verschwundene Titel werden nach einem vollständigen Lauf entfernt.
- **`/languages`:** Top 20 je Liste, nach Anzahl absteigend, 10 Minuten gecacht. Die Zahlen gelten für die ganze Bibliothek und enthalten nur Codes, keine Titel.
- **`GET /api/library/items?audio=deu&subs=eng`:** Beide Parameter `^[a-z]{3}$` (sonst 400), einzeln oder zusammen. Die Kandidaten kommen aus dem Index (max. 5000; werden mehr gefunden, enthält die Antwort `capped: true` und die Liste ist nur eine Teilmenge), die Details holt Jellyfin mit dem Token des Profils in Blöcken à 80 IDs (4 parallel, damit die Request-Zeile kurz bleibt). Pro Nutzer sind höchstens 30 solcher Abfragen pro Minute erlaubt (sonst 429 `rate_limited`). Dabei gelten alle anderen Filter (`genre`, `studio`, `decade`/`year`, `minRating`, `person`, `filter`, `types`) und die Sichtbarkeit exakt. Sortierung (`SortName`, `PremiereDate` und `DateCreated` nach Premierendatum, `CommunityRating`, `Random`), `desc`, `start`/`limit` und `total` (Länge der gemergten Liste) berechnet das Backend; die Reihenfolge wird 120 s pro Nutzer und Abfrage gecacht (jeder Seitenabruf verlängert die Frist), damit „Mehr laden“ nicht neu lädt. `DateCreated` sortiert nach dem Hinzufügedatum (Fallback Premierendatum).
- **`GET /api/items/:id`:** enthält zusätzlich `langs: { audio: string[], subs: string[] }`, sofern der Titel (bei Folgen die Serie) im Index steht.

## Watch-Status (je Profil)

`planned` = Merkliste, `dropped` = Tabelle `dropped`, `watching`/`watched` werden aus Jellyfin abgeleitet. Folgen werden auf ihre Serie abgebildet.

- `GET /api/items/:id/status` liefert `{ "status": "none"|"planned"|"watching"|"watched"|"dropped" }` (Rangfolge dropped, planned, abgeleitet). Unsichtbare Titel: 404.
- `PUT /api/items/:id/status` mit `{ "status": "planned"|"dropped"|"none" }` antwortet mit demselben Objekt. `planned` legt den Merklisten-Eintrag an und entfernt `dropped`; `dropped` entfernt die Merkliste und blendet den Titel in „Weiterschauen“ aus; `none` entfernt beides. `POST /api/items/:id/watchlist` beendet ebenfalls „abgebrochen“.
- `GET /api/dropped` liefert `{ "items": [ItemDto] }`, sichtbare Titel, zuletzt abgebrochene zuerst, max. 200.
- Abgebrochene Titel fehlen in `/api/library/resume` und `/api/library/nextup`.

## Freunde-Leiste: `GET /api/items/:id/friends`

```json
{ "friends": [{ "id": "…", "name": "Lea", "stars": 4, "watched": true, "recommended": true }] }
```

- `stars` nur bei Freunden mit `shareRatings` (Standard an), `watched: true` nur bei Freunden mit `shareHistory` (max. 12 geprüft, 5 Minuten gecacht, Fehler lassen das Feld weg), `recommended: true`, wenn der Freund den Titel dir empfohlen hat. Nur Freunde mit mindestens einem Merkmal erscheinen; sortiert nach empfohlen, Sternen, gesehen. Eigene Person und gesperrte Konten fehlen. Limit 60 pro Minute, 404 für unsichtbare Titel.

## „Diese Woche bei uns“: `GET /api/library/trending`

```json
{ "items": [{ "id": "…", "name": "…", "type": "Series", "viewers": 3 }] }
```

- Quelle sind die Wiedergaben der letzten 7 Tage (je Tag und Titel mindestens 300 Sekunden, gesperrte Konten zählen nicht; andere Konten nur mit „Verlauf teilen“ (`shareHistory`), deine eigenen Wiedergaben immer). Folgen werden der Serie zugeordnet; `viewers` ist die Zahl verschiedener Konten, nie Namen.
- Ein Titel erscheint nur mit mindestens 2 Zuschauern oder wenn du selbst dazugehörst. Unsichtbare Titel fehlen (Auflösung mit deinem Token). Sortiert nach `viewers`, dann Sekunden; höchstens 10, 10 Minuten pro Jellyfin-Konto und Betrachter gecacht.
- Items tragen außerdem `lastAdded` (ISO, `DateLastMediaAdded`) für das Badge „Neue Folgen“.

## Reaktionen: `/api/items/:id/reactions`

Nur für Filme und Folgen (Serie: 400 `unsupported_type`, unsichtbar: 404). „Gesehen“ heißt `played` oder mindestens 85 %.

```json
{ "locked": true, "count": 3 }
{ "locked": false, "count": 3, "summary": { "like": 1, "funny": 0, "wow": 1, "sad": 0, "love": 1 },
  "reactions": [{ "name": "Lea", "emoji": "love", "comment": "…", "mine": false, "createdAt": "…" }] }
```

- `GET` liefert vor dem Ansehen höchstens die Anzahl, und die erst ab 2 Reaktionen (eine einzelne verriete, wer es gesehen hat; keine Namen, Emojis oder Kommentare), danach Zusammenfassung und bis zu 100 Reaktionen, neueste zuerst; gesperrte Konten fehlen.
- `PUT { emoji: "like"|"funny"|"wow"|"sad"|"love", comment?: string (getrimmt, max. 280) }` legt die eigene Reaktion an oder ersetzt sie. Ungesehen: 403 `watch_first`. Limit 30 pro Minute. Antwort wie `GET`.
- `DELETE` entfernt die eigene Reaktion, Antwort wie `GET`.
- Kommentare sind reiner Text und dürfen nie als HTML gerendert werden.

## Kuratierte Reihen („Empfohlen von …“)

Admins können bis zu 5 Listen auf der Startseite aller Nutzer hervorheben (Migration 24, `lists.featured_at`).

- `PUT /api/admin/lists/:id/featured` `{featured: boolean}` (Admin, CSRF, Audit `list.feature`/`list.unfeature`): 404 unbekannte Liste, 409 `too_many_featured` ab 5.
- `GET /api/admin/lists` (Admin): `{lists: [{id, name, owner:{id,name}, itemCount, featured}]}`, neueste zuerst, max. 200.
- `GET /api/lists/featured` (jeder angemeldete Nutzer): `{lists: [{id, name, description, owner:{name}, items: ItemDto[]}]}`. Titel werden mit dem Token des Betrachters aufgelöst (versteckte entfallen), max. 24 je Liste, neueste zuerst; Listen ohne sichtbare Titel entfallen.
- `GET /api/lists/:id` ist für Nicht-Mitglieder einer hervorgehobenen Liste lesbar: `list.role = 'guest'`, `members` enthält nur den Besitzer. Alle Schreibzugriffe bleiben Mitgliedern vorbehalten, nicht hervorgehobene Listen liefern weiterhin 404.

## `POST /api/match` – gewichtet

Jeder Treffer trägt `planned`: die Zahl der Teilnehmer (Konten), die den Titel auf der Merkliste eines ihrer Profile haben. Sortiert wird nach `planned`, dann Bewertung, dann Name. Titel, die ein Teilnehmer abgebrochen (`dropped`, jedes Profil) oder mit Daumen runter bewertet hat, entfallen. Wer geplant hat, wird nicht verraten.

## Marken-Hubs, Extras, Simulcast, Kommentare

- **Marken-Hubs:** `GET /api/hubs` (sichtbare Hubs mit Kachelbild), `GET /api/hubs/:id` und `/api/hubs/:id/items` (Reihen Neu, Beliebt, Filme, Serien, A–Z). Quelle ist ein Jellyfin-Studio, eine Sammlung, ein Tag oder ein Genre; der Admin pflegt sie unter `/admin/hubs` (bis zu 8, Vorschläge aus der Bibliothek). Inhalte laufen immer über den Jellyfin-Zugang des Profils.
- **Extras:** `GET /api/items/:id/extras/all` – lokale Trailer und Bonusmaterial; der Tab fehlt, wenn es nichts gibt.
- **Weitere „Weil du … gesehen hast“-Reihen:** `GET /api/library/because-more` – bis zu drei Reihen zu verschiedenen zuletzt gesehenen Titeln, ohne Doppelte und ohne Weiterschauen-Titel.
- **Serien-Sprachwahl:** `GET/PUT/DELETE /api/series/:id/langpref` (je Profil; eine Folgen-ID zählt für ihre Serie). `?anime=1` liefert zusätzlich `anime` für die Einstellung „Anime: Originalton mit Untertiteln“ (`animeOriginal` in `/api/prefs`): ohne eigene Serienwahl startet ein Anime auf Japanisch mit Untertiteln in der UI-Sprache, sofern es eine japanische Tonspur gibt.
- **Simulcast:** `GET /api/simulcast[?anime=1]` – laufende Serien mit Folgen in den letzten/nächsten vier Wochen, nach Wochentag und Season.
- **Folgen-Kommentare:** `GET/POST /api/items/:id/comments`, `DELETE /api/comments/:id` (Autor oder Admin). Sichtbar für alle Konten der Instanz außer Gästen – FriendFlix kennt keine eigene Freundesliste, alle eingeladenen Konten sind „Freunde“ (wie bei `/api/friends`). Wer die Folge noch nicht gesehen hat, bekommt alle fremden Kommentare ohne Text, bis `?reveal=1` sie anfordert. Löschen darf der Autor oder ein Admin im Hauptprofil.

## Block 17: Frische-Labels, „Bald nicht mehr verfügbar“, Qualität

- **Frische-Labels** (`POST /api/discover/badges` mit bis zu 80 Ids, `GET /api/items/:id/facts`): höchstens ein Label je Karte, Priorität Neue Serie > Staffelfinale > Neue Staffel > Neue Folge; Filme „Neu“ (14 Tage). Nur Titel, die der Betrachter sehen darf, bekommen eine Antwort. Serien-Labels werden 15 min bibliotheksweit gecacht; je Anfrage werden höchstens 12 noch nicht gecachte Serien berechnet (je zwei Medienserver-Aufrufe), der Rest bekommt sein Label bei einer späteren Anfrage. Beide Routen sind auf 60 Anfragen/min je Sitzung begrenzt (`/api/library/quality` ebenso).
- **Heuristik „Staffelfinale“** (bewusst einfach, `seriesLabel` in `backend/src/fresh.ts`): die letzte vorhandene Folge der neuesten Staffel kam in den letzten 7 Tagen, die Staffel begann früher (sonst „Neue Staffel“), die Staffel hat mindestens 3 Folgen, es sind keine angekündigten (noch nicht ausgestrahlten) Folgen mehr eingetragen und die Serie ist **nicht** „Continuing“. Laufende Serien werden über `libraryContinuingSeriesIds` mit dem Admin-Schlüssel vollständig (seitenweise) ermittelt, damit eingeschränkte Profile oder große Bibliotheken kein falsches „Staffelfinale“ erzeugen. Eine Serie, deren Status der Medienserver nicht pflegt, gilt als beendet; ist der Status unbekannt (Fehler), wird nie ein Finale behauptet.
- **„Bald nicht mehr verfügbar“:** Tage werden in der Zeitzone der Instanz gezählt (`TZ` des Backends, Compose-Standard `Europe/Vienna`; ohne `TZ` UTC), nicht in der der Datenbank. Der stündliche Job (Aufräumen abgelaufener Daten, Hinweise 7 Tage und 1 Tag vorher) läuft wie die anderen Hintergrundjobs nur mit `BACKGROUND_JOBS=true`.
- **Qualitätsfilter** (`GET /api/library/quality`): Kandidaten aus `item_quality`, Details und Sichtbarkeit vom Medienserver mit der Identität des Betrachters (bis zu 4 Blöcke à 80 parallel). Die sortierte Id-Liste des Betrachters wird 3 min je Medienserver-Identität und Filter gecacht (Kinderprofile haben eine eigene Identität); weitere Seiten fragen nur noch die Titel der Seite ab.

## Block 17: Besetzung & Infos, Szenen, „Die Geschichte bisher“

- **`GET /api/items/:id/castinfo`** (Player: Taste <kbd>I</kbd> für den kurzen Blick, „Alle Infos“ für das Fenster): `{ item, cast, guests, directors, writers, creators, studios, genres, tags }`. Bei Folgen gelten die Stammbesetzung der Serie als `cast` und alle nur auf der Folge Genannten als `guests`; Regie und Drehbuch kommen von der Folge, sonst von der Serie, `creators` von der Serie. Gekürzt auf 40 Darsteller, 30 Gaststars und je 8 Crew-Einträge. Ohne `credits()` im Medienserver (siehe [architecture.md](architecture.md)) fällt die Route auf `people()` plus Tags zurück. Jeder Aufruf prüft die Sichtbarkeit mit der Identität des Betrachters (404 für unsichtbare Titel); die Daten des Medienservers werden 5 min je Identität gecacht. Ein Tipp auf eine Person öffnet ihre Titel aus der Bibliothek (`GET /api/people/:id`, siehe oben).
- **`GET /api/items/:id/chapters`** (Fenster „Szenen“, Kapitelmarken auf der Zeitleiste): `{ supported, chapters: [{ start, name, image? }] }`. `supported: false`, wenn der Medienserver keine Kapitel liefert (`capabilities.chapters`); der Player zeigt dann weder Marken noch das Fenster. Die Kapitelbilder laufen über das Gateway (`/media/Items/<id>/Images/Chapter/<n>`), fehlt eines, nimmt die Oberfläche ein Trickplay-Bild.
- **`GET /api/items/:id/story`** („Die Geschichte bisher“ auf der Serienseite): `{ story: null }` für Filme und wenn nichts zutrifft, sonst `{ reason: 'newSeason' | 'longBreak', weeks?, season?, episode, next }`. Sie erscheint, wenn die nächste ungesehene Folge die erste einer neuen Staffel ist oder die letzte Wiedergabe mindestens 6 Wochen (`STORY_BREAK_WEEKS`) zurückliegt, und besteht nur aus Metadaten: der Beschreibung der zuletzt vollständig gesehenen Staffel und der Beschreibung der zuletzt gesehenen Folge – nie Folgen, die du noch nicht gesehen hast. Ausgeblendet wird die Karte im Browser (`localStorage`).
- **Klang im Player** und **Ruhiger Modus** sind Profil-Einstellungen und stehen in [personal.md](personal.md).

## 1.1: „Was als Nächstes?“ – Bildschirm nach dem Ende (`GET /api/items/:id/postplay`)

Sitzung nötig, je Profil, mit dem Token des aktiven Profils (Kinder-Altersgrenze und Bibliotheken gelten); nicht sichtbare oder unbekannte Titel `404`, falsche IDs `400`. Rate-Limit `perSession(60)` (60 pro Minute und Sitzung). Mit `POSTPLAY_ENABLED=false` antwortet der Endpunkt `404 {"error":"disabled"}`, `/api/me` meldet `features.postplay: false` und die Web-App zeigt weder Karte noch Bildschirm.

```json
{ "state": "next" | "movie_end" | "series_finished" | "caught_up" | "gap",
  "current": ItemDto, "next": ItemDto | null, "nextAirDate": "2026-10-21" | null, "sequel": ItemDto | null,
  "canWish": true, "remind": { "episodeId": "…" } | null, "suggestions": true,
  "rows": [{ "kind": "continuation|universe|because|friends|taste", "title": "…",
             "reason": { "seed": { "id": "…", "name": "…" }, "traits": ["genre:…", "collection:…", "hub:…", "tag:…"] },
             "items": [ItemDto], "wish": { "mediaType": "tv", "tmdbId": 1396, "quota": { "limit": 5, "used": 3, "remaining": 2, "resetsAt": "…" } } }],
  "hero": ItemDto | null }
```

- **Zustände:**
  - `next`: Eine ungesehene Fortsetzung ist da – die nächste *verfügbare* Folge (`nextEpisode`, angekündigte Folgen zählen nicht) oder der nächste ungesehene Teil einer Filmsammlung (`itemCollections`). Bei Folgen bleibt im Player der bisherige Countdown; der Bildschirm erscheint dort nicht.
  - `gap`: Keine nächste Folge, aber eine frühere verfügbare Folge ist noch ungesehen (Specials ausgenommen) → „Folge N ist noch ungesehen“, `next` ist diese Folge.
  - `series_finished`: Letzte Folge einer Serie, deren Status *sicher* „beendet“ ist. Den Status liefert der optionale Medienserver-Hook `seriesStatus()` (Jellyfin: `Status` = `Ended`). Fehlt der Hook oder ist der Status unbekannt, zählt nur ein positives „läuft noch“ aus der Liste in `fresh.ts` – eine Serie wird **nie** „beendet“ genannt, wenn der Status unbekannt ist (gleiche Regel wie beim „Staffelfinale“). `sequel` ist ein späterer Teil einer Sammlung, zu der die Serie gehört.
  - `caught_up`: Letzte verfügbare Folge einer laufenden Serie (oder einer mit unbekanntem Status). `nextAirDate` und `remind` kommen von der angekündigten nächsten Folge bzw. `upcoming()`; „Erinnere mich“ nutzt die bestehenden Erinnerungen (`POST /api/reminders {episodeId}`), nicht auf Kinderprofilen.
  - `movie_end`: Film ohne ungesehenen späteren Teil.
- **Reihen** in dieser Reihenfolge, leere fallen weg, kein Titel kommt zweimal vor:
  1. `continuation`: nächster Teil, Fortsetzung oder die übersprungene Folge. Fehlt bei einer beendeten Serie eine Staffel (Wunsch-Dienst meldet „teilweise verfügbar“), trägt die Reihe `wish` mit dem Monatskontingent; gewünscht wird über den bestehenden Weg `POST /api/requests`.
  2. *(R3: `transition`, „Was andere nach X schauen“ – Erweiterungspunkt `ROW_SOURCES` in `backend/src/postplay.ts`, noch nicht aktiv)* und `universe`: die anderen Teile der Sammlung, sonst der erste passende Marken-Hub (Studio/Tag/Sammlung), sonst das erste Tag (ab 4 Titeln).
  3. `because`: Jellyfins `similar()` mit dem gerade beendeten Titel als Ausgangspunkt (bei Folgen die Serie); `reason.seed` ist dieser Titel.
  4. `friends`: das bestehende `friendsRatedFor` (Opt-in `shareRatings`, ≥ 4 Sterne, 90 Tage). Nie auf Kinderprofilen.
  5. `taste`: die profilbasierten Reihen der bestehenden Engine (`libraryBecause` + `libraryBecauseMore`, abwechselnd gemischt).
- **Filter:** Nie der Titel selbst oder seine Serie, nie Gesehenes oder komplett gesehene Serien, nie „Abgebrochen“ (`dropped`) oder Daumen runter des Profils. Höchstens jeder dritte Titel einer Reihe stammt aus der aktuellen Season (Premiere in den letzten 91 Tagen; auf jedem dritten Platz), damit nicht nur Simulcast-Hits erscheinen.
- **Hero:** Fortsetzung bzw. nächster Teil, sonst aus den ersten 8 Titeln der `because`-Reihe der, der auch zur `taste`-Reihe des Profils passt, dann mit Bild, dann eine je Profil stabile Reihenfolge – nicht jedes Profil bekommt denselben Tipp.
- **Spoilerschutz:** Ist er an, fehlt die Beschreibung ungesehener Folgen (`current`, `next`, Reihen); die Web-App blendet auch deren Vorschaubild aus.
- **Einstellung je Profil** „Vorschläge nach der letzten Folge zeigen“ (`postplay` in `GET/PUT /api/prefs`, Standard an). Aus: `suggestions: false`, nur noch die Reihe `continuation`, kein Hero.
- **Cache:** 60 s je Profil + Titel + User-Data-Version des Medienservers + Home-Generation; `bumpHome()` (Daumen, Liste, Status …) verwirft ihn sofort.

### Zähler: `POST /api/postplay/event`

Body `{"type":"shown","state":…}`, `{"type":"click"|"play","row":…}` oder `{"type":"dismiss"}` (nur die festen Werte oben, sonst `400`); Antwort `204`, Rate-Limit `perSession(120)`. Es entstehen nur Summen ohne Titel, Nutzer oder IDs: `friendflix_postplay_shown_total{state}`, `friendflix_postplay_click_total{row_kind}`, `friendflix_postplay_play_total{row_kind}`, `friendflix_postplay_dismiss_total`.

### Web

- **Karte „Fertig? Sieh dir an, was als Nächstes kommt“:** klein und nicht blockierend, ab dem Abspann – Outro-Segment des Medienservers, sonst das letzte Kapitel (wenn es in den letzten 20 % beginnt), sonst 95 % der Laufzeit. Nur ohne nächste Folge (sonst bleibt der Countdown) und nicht, während ein Fernseher spielt. Sie lädt die Antwort schon vor.
- **Bildschirm:** Endet der Titel (oder auf Klick auf die Karte), legt sich der Bildschirm über den Player (Vollbild wird verlassen). Oben links der gerade gesehene Titel und die Überschrift (`aria-live`), dann der nächste Schritt (Abspielen, Zurückspringen, Erinnere mich, Wunsch mit Kontingent), ein Hero mit *Abspielen*, *Auf die Merkliste*, *Kein Interesse* (mit *Rückgängig*, inline) und *Details*, „Bewerten“ für den gerade gesehenen Titel, dann die Reihen mit ihrem Grund. Es startet **nie** etwas von selbst. Esc bzw. Zurück (TV) schließt den Bildschirm; man bleibt beim Titel.
- **`/postplay/<id>`:** derselbe Bildschirm ohne Player (TV, Handy, Direktlink, Detailseite nach der letzten Folge).
- **Ruhemodus und reduzierte Bewegung:** keine Einblendung, keine Übergänge; Trailer, Vorschauclips oder Ton gibt es auf dem Bildschirm ohnehin nicht. **TV-Modus:** große Schrift, Fokus mit den Pfeiltasten (`data-nav`/`data-scope`), der erste sinnvolle Knopf hat den Fokus.

## Kinderprofile

Ein Kinderprofil (`kids`, Altersgrenze 0/6/12 als Jellyfin-`MaxParentalRating`, Titel ohne Freigabe ausgeblendet) erhält auf alle sozialen und kontoweiten Routen `403 kids_profile` (`requireGrownUp` in `backend/src/kids.ts`): Reaktionen, Freunde-Leiste, Bewertungen, Listen, Abstimmungen, Kommentare, Watch-Party (REST und WebSocket, Schließcode 4403), Freunde/Matcher/Empfehlungen, „Freunde haben bewertet“, „Läuft gerade“, Wünsche (Wunsch-Dienst), Statistiken, Wochenrückblick, Benachrichtigungen, Web-Push, Erinnerungen, „Diese Woche bei uns“ und Geräteliste. Inhalte (Titel, Suche, Wiedergabe, Hubs, Extras, Downloads, Simulcast, Serien-Sprachwahl) bleiben erlaubt. Ein Fernseher, der aus einem Kinderprofil gekoppelt wird, ist fest an dieses Profil gebunden (`devices.kids_profile_id`); auf solchen Geräten wird „PIN vergessen?“ abgelehnt. Ändert der Inhaber Kinder-Flag oder Altersgrenze, verwirft der Server die Caches dieses Profils (`policyChanged` in `backend/src/hooks.ts`).

## Web

- **`/search`:** Die Abschnitte heißen Personen, Genres, Filme & Serien und Folgen.
  - Der Zustand steckt in `?q=`.
  - Die letzten 8 Suchen werden lokal im Browser gespeichert und lassen sich löschen.
  - `/` oder Strg/⌘+K springt von überall in die Suche.
- **`/person/<id>`:** Filmografie mit Filter Alle/Filme/Serien. „In Filmen stöbern“ öffnet `/browse/movies?person=<id>`.
- **`/browse/movies|series`:** Filter für Genre, Jahrzehnt, Bewertung, Sortierung und Status.
  - Aktive Filter erscheinen als Chips mit ×.
  - Alle Filter stehen in der URL und lassen sich teilen.
