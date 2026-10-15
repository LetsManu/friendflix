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

## Empfehlungen messen: `scripts/reco-eval.mjs` und `POST /api/reco/events`

Schritt R0 der Empfehlungs-Engine v2 (Spezifikation 4.7): erst messen, dann bauen. Der Auswertungslauf ist offline und ändert nichts.

**Aufruf**

```
node scripts/reco-eval.mjs                  # mitgelieferte Testdaten (scripts/fixtures/reco-eval.json)
node scripts/reco-eval.mjs --data x.json    # eigener Datensatz
DATABASE_URL=… node scripts/reco-eval.mjs --db [--items items.json] [--similar similar.json]
```

Weitere Schalter: `--engines popularity,v1,cooccurrence`, `--exclude-seen` (schon gesehene Titel bei allen Engines entfernen), `--json`, `--min-profiles N` (Standard 5: weniger ausgewertete Profile werden nicht ausgegeben, ein Mittelwert über eine Person wäre keiner), `--plugin datei.mjs` (Modul mit `export const engines = { name: fabrik }`, weitere Engines kommen so dazu; v2 ist seit R2 eingebaut, siehe unten). Der Test läuft mit `npm run test:scripts`.

**Verfahren (leave-last-out).** Je Profil mit mindestens 10 Interaktionen wird die letzte zurückgehalten; jede Engine sieht die früheren und liefert bis zu 50 Titel, die Kennzahlen betrachten die ersten 10. Kinderprofile bleiben ganz draußen (auch beim Training: sie speisen keine profilübergreifenden Signale). Gedruckt werden nur Aggregate, nie ein Titel, eine ID oder ein Profil.

| Kennzahl | Bedeutung |
|---|---|
| HitRate@10, NDCG@10, MRR | Treffer in den ersten 10; NDCG mit einem gesuchten Titel = 1/log2(Rang+1); MRR über die ersten 50 |
| Coverage | verschiedene empfohlene Titel / Katalog |
| Diversity (ILD) | mittlere Genre-Unähnlichkeit (1 − Jaccard) der Titel einer Liste; leer ohne Genre-Daten |
| Already seen | Anteil schon gesehener Titel in den Listen |
| Mid-pop. share of hits | Anteil der Treffer auf Titel der mittleren Beliebtheitsstufe (nach Trainingsdaten: oberste 20 % Kopf, unterste 50 % Rest, dazwischen Mitte) |
| New-title hit rate | Trefferquote, wenn der gesuchte Titel sonst niemand gesehen hat (Kaltstart) |
| Transition accuracy | der echte nächste Titel nach dem zuletzt gesehenen steht in den ersten 10 der Fläche „was kommt danach“ |

**Engines hinter einer Schnittstelle** `{ name, fit(train, daten), recommend({ surface: 'home' | 'next', history, seed, k, disliked }) }`:

- `popularity`: meistgesehene Titel (mindestens 2 Profile), ohne schon Gesehenes.
- `v1`: bildet `libraryBecause` nach: Seed ist die letzte Daumen-hoch-Bewertung, sonst der zuletzt gesehene Titel; Kandidaten sind die `similar()`-Antwort des Medienservers in deren Reihenfolge, ohne Daumen-runter, gesehene Titel bleiben drin (wie heute). Offline gibt es keinen Medienserver. Es gilt: steht der Seed im Datensatz unter `similar` (aufgezeichnete Antworten, 30 Titel), wird diese Liste genommen; sonst eine Nachbildung über die Titelmerkmale (Genre-Überlappung, dann Nähe im Erscheinungsjahr, 30 Titel). Aus der Datenbank allein gibt es weder Merkmale noch `similar()`; dafür `--items` (`[{id, genres, year}]`) und `--similar` (`{seedId: [ids]}`, einmal aus dem laufenden System aufgezeichnet) übergeben, sonst bleibt v1 leer und die Diversität `n/a`.
- `cooccurrence`: Item-Item-Kosinus über „vom selben Profil gesehen“, nur Paare aus mindestens 2 Profilen (Aggregat-Regel aus 4.8). `home`: gesamter Verlauf, neuere Titel zählen mehr; `next`: Titel, die in anderen Profilen direkt auf den Seed folgten, danach Co-Occurrence.

**Datenbank (`--db`).** Eine einzige Transaktion `READ ONLY`, nur Lesen, die Verbindung wird nie ausgegeben. Positive Interaktionen: `play_seconds` (mindestens 120 s je Titel, `--min-seconds`), Daumen hoch/geliebt, Bewertungen ab 4 Sternen; Daumen runter zählt nicht als Interaktion. Grenzen: `play_seconds` kennt nur das Konto, nicht das Profil (die Wiedergaben zählen für das Hauptprofil), und nur den Tag, nicht die Uhrzeit; Folgen sind eigene Titel. Der Katalog ist die Menge aller Titel mit Interaktionen. Der Wiedergabe-Verlauf des Medienservers wird nicht gelesen.

**Offene Punkte aus der Spezifikation.** Matrixfaktorisierung (ALS) und Replay mit Propensities kommen mit der Exploration (R3b). `shadow` gibt es seit R2 (siehe unten).

### Online-Zähler

`POST /api/reco/events` (Anmeldung und CSRF-Token nötig, 60 Aufrufe pro Minute, auch für Kinderprofile, weil nur Zahlen ankommen):

```json
{ "events": [{ "row": "because", "engine": "v1", "impressions": 1, "clicks": 2, "dismisses": 0 }] }
```

Antwort `204`. `row` ist eine feste Liste (`because`, `because_more`, `top_picks`, `popular`, `friends`, `postplay`), `engine` ist `v1` oder `v2`; alles andere wird mit `400` abgelehnt, die Labels bleiben also begrenzt. Es werden weder Titel noch IDs, Positionen oder Profile übertragen oder gespeichert. Prometheus: `friendflix_reco_impressions_total`, `friendflix_reco_clicks_total`, `friendflix_reco_dismiss_total` und `friendflix_reco_plays_total`, jeweils `{row,engine}`. Click-through-Rate: `sum(increase(friendflix_reco_clicks_total[7d])) by (engine) / sum(increase(friendflix_reco_impressions_total[7d])) by (engine)`.

Die Startseite meldet je „Weil du … geschaut hast“-Zeile (`because`, `because_more`, Engine `v1`) eine Einblendung, sobald die Hälfte der Zeile zu sehen ist, und jeden Klick auf einen Titel; die Zahlen werden gesammelt und alle 4 Sekunden oder beim Verlassen der Seite gesendet. `plays` zählt der Server selbst, sobald eine Wiedergabe einer Empfehlung zugeordnet werden kann, und `dismisses` kommen mit den Schaltflächen „nicht interessiert“: beides gehört zu R4.

## Empfehlungs-Index (`item_features`, R1)

Vorbereitung der Empfehlungs-Engine v2 (`backend/src/reco/`). Der Index liest nur Bibliotheks-Metadaten, braucht keine Wiedergabedaten und ändert für sich keine Empfehlung: „Weil du … gesehen hast“ und die Reihen laufen weiter über `similar()` des Medienservers, solange `RECO_ENGINE=v1` gilt (Standard). Die Engine v2 (R2, unten) liest den Index.

- **Inhalt je Film und Serie** (Folgen werden zur Serie gerechnet, sie haben keine eigene Zeile): `genres`, `tags`, `studios` (kleingeschrieben, ohne Dubletten), `people` (Ids der 8 wichtigsten Personen: bis zu je 2 Regie, Urheber und Drehbuch, dann Darsteller in Reihenfolge der Besetzung), `year`, `runtime_min`, `community_rating`, `critic_rating`, `original_language`, `countries`, `collection_id` (Sammlung/Box Set), `series_status` (`continuing`/`ended`), `overview_terms` und `updated_at`. `original_language` bleibt bei Jellyfin leer, weil der Server sie nicht meldet. Keine Pfade, URLs, Tokens, Titel oder Nutzerdaten.
- **Quelle:** das optionale `MediaServer.libraryFeatures?(start, limit, { ids?, savedSince? })` mit der Fähigkeit `capabilities.libraryFeatures` (siehe [architecture.md](architecture.md)). Jellyfin liefert Seiten zu 200 (`sortBy=SortName,Id`, Admin-Schlüssel) und benutzt dieselben Abbildungen wie `credits()` und `itemAbout()`; es braucht also keinen Aufruf je Titel. Die Sammlung kommt aus dem bibliotheksweiten Box-Set-Index (1 h gecacht); fällt er aus, fehlt nur `collection_id`. Ohne die Methode bleibt der Job untätig.
- **TF-IDF:** Beschreibung und Slogan werden in Wörter zerlegt (Buchstaben und Ziffern jeder Schrift, ohne Stoppwörter, ohne Wörter unter 3 Zeichen und reine Zahlen). Gewicht je Wort = `(1 + ln Anzahl) · idf`, mit `idf = ln((N + 1) / (df + 1)) + 1`; behalten werden die 40 stärksten Wörter, L2-normiert (das Skalarprodukt ist der Kosinus). Ab 20 Titeln fallen Wörter heraus, die nur ein Titel enthält, denn sie können mit keinem anderen übereinstimmen. Ohne Leerzeichen geschriebene Sprachen (Chinesisch, Japanisch) ergeben lange Wörter und taugen kaum.
- **IDF** je Wert von Genre, Tag, Studio und Person (`item_feature_idf`, `kind` = `genre|tag|studio|person|term`): ein seltener Regisseur wiegt mehr als das Genre „Drama“. Zahlen (Jahr, Laufzeit, beide Bewertungen) stehen mit Mittelwert und Standardabweichung in `item_feature_stats`, damit R2 sie standardisieren kann (`zscore` in `reco/tfidf.ts`).
- **Gewichte** der Feldgruppen: `RECO_W_GENRES` (1), `RECO_W_TAGS` (0,6), `RECO_W_STUDIOS` (0,4), `RECO_W_PEOPLE` (0,8), `RECO_W_TEXT` (1), `RECO_W_NUMERIC` (0,3), `RECO_W_COLLECTION` (1,5); 0 bis 10, `0` schaltet die Gruppe ab. Der Index speichert die Rohwerte, die Gewichte greifen erst beim Lesen (`recoWeights` in `reco/weights.ts`); eine Änderung braucht also keinen neuen Aufbau.
- **Job** (`reco/indexJob.ts`, nur mit `BACKGROUND_JOBS=true`, nach dem Muster des Hygiene-Scans): Prüfung jede Minute ab 90 s nach dem Start.
  - **Vollständiger Durchlauf** beim ersten Start, danach nachts um 3:00 (Serverzeit), sobald der letzte einen Tag alt ist, und spätestens nach 36 h. Nur ein vollständiger Durchlauf löscht Zeilen verschwundener Titel und berechnet alle Wort- und IDF-Werte neu.
  - **Inkrementell:** `itemAdded` auf dem `media.event`-Bus (bei einer Folge ihre Serie) merkt die Id vor; 30 s nach der letzten Meldung holt ein Durchlauf genau diese Titel. Neue Titel funktionieren sofort, ihre Wörter nutzen die gespeicherten Dokumenthäufigkeiten. `itemRemoved` löscht die Zeile sofort.
  - **Sperre** über `reco:idx:running` in Redis (`setnx`, 5 min, jede Minute erneuert), damit nie zwei Replikate gleichzeitig laufen. **Backoff** nach einem Fehler: 5 min, verdoppelt bis höchstens 6 h; der Fehler erscheint im Fehlerprotokoll nur als Jobname `reco-index`, nie mit Meldung oder URL.
- **Sichtbarkeit:** *Admin → Status* zeigt die Kachel „Empfehlungs-Index“ (Anzahl und Alter; „Noch nicht aufgebaut“, „Wird aufgebaut …“ oder „Vom Medienserver nicht unterstützt“), `GET /api/admin/summary` das Feld `recoIndex { supported, running, items, updatedAt }`. Metriken: `friendflix_reco_index_items`, `friendflix_reco_index_age_seconds` und `friendflix_reco_index_runs_total{mode="full|incremental",result="ok|error"}` (nur diese festen Werte als Labels, keine Titel oder Ids).
- **Datenschutz:** Der Index enthält ausschließlich Bibliotheksdaten und gilt für alle Profile gleich. Wer welche Titel sehen darf, entscheidet weiterhin der Medienserver mit der Identität des Betrachters; Kinderprofile sind davon nicht berührt.

## Empfehlungs-Engine v2: Geschmacksprofil und Bewertung (R2, Shadow-Modus)

Code in `backend/src/reco/`. Standard bleibt `RECO_ENGINE=v1`: Es ändert sich nichts, bis jemand umschaltet.

**`RECO_ENGINE`**

| Wert | Wirkung |
|---|---|
| `v1` (Standard) | „Weil du … gesehen hast“ wie bisher: `similar()` des Medienservers minus Daumen-runter. v2 läuft nicht. |
| `shadow` | Die Antwort ist **genau die von v1**. Daneben rechnet v2 mit demselben Seed (nicht abgewartet, höchstens einmal je Profil, Nutzerdaten-Version und Seed in 10 Minuten, Redis-Schlüssel `reco:shadow:…`) und hält nur Zahlen fest. Ein Fehler in v2 wird gezählt und bleibt für den Zuschauer unsichtbar. |
| `v2` | Die Zeile besteht aus den v2-Titeln (bis 24); fällt v2 aus, antwortet v1. Gedacht für Tests und den Rollout (R4), nicht vorher. |

**Shadow-Metriken** (Labels sind begrenzt: `surface` ist eine der fünf Flächen, `result` ist `ok|error`; nie ein Titel, eine Id, ein Profil oder ein Nutzer):

- `friendflix_reco_shadow_runs_total{surface,result}`: Vergleiche.
- `friendflix_reco_shadow_overlap{surface}` (Histogramm, 0 bis 1): Anteil der v1-Top-10, den v2 auch in seinen Top 10 hat.
- `friendflix_reco_shadow_score_delta{surface}` (Histogramm): mittlerer v2-Score der v2-Top-10 minus mittlerer v2-Score der v1-Top-10 (nur Titel, die v2 als Kandidat bewertet hat). Positiv: v2 hält seine eigene Liste für besser.

**Geschmacksprofil** (`profile.ts`, je Profil)

| Signal | Startgewicht | Quelle |
|---|---|---|
| Daumen 2 / 1 | +3,0 / +1,5 | `thumbs` des Profils |
| Sterne 5 / 4 / 3 / 2 / 1 | +2,5 / +1,5 / 0 / −1 / −2 | `ratings` (nur beim Hauptprofil) |
| Film fertig gesehen; Serie mit Abschlussquote r | +1,0; +2,0·r | Verlauf des Profils beim Medienserver; r = gesehene / (gesehene + ungesehene Folgen) |
| Rewatch; Favorit | +1,0; +1,0 | Rewatch: Film an mindestens 2 Tagen und insgesamt mindestens 1,6 Laufzeiten gesehen (`play_seconds`, nur Hauptprofil); Favorit aus dem Medienserver (ohne Datum: als 60 Tage alt gerechnet) |
| Merkliste | +0,5 | `watchlist` |
| Früh abgebrochen (unter 15 % und 14 Tage nicht zurück); `dropped` | −1,0; −2,0 | |
| Daumen −1 | −4,0 | zusätzlich harter Filter |

- **Zeitabfall:** `Gewicht · 0,5^(Alter in Tagen / 120)` (`RECO_HALF_LIFE_DAYS`). Die Signale eines Titels werden nach dem Abfall addiert; die Summe sortiert den Titel in den positiven oder den negativen Vektor (sein Merkmalsvektor, mit |Summe| gewichtet). Beide Vektoren werden L2-normiert; ein Titel ohne Eintrag im Index zählt als Interaktion, trägt aber nichts bei.
- **Kaltstart:** weniger als 5 Titel mit Gewicht (3-Sterne-Wertungen und doppelte Signale zählen nicht extra) = `cold`. Dann gibt es keine Nachbarn aus dem Profil, die Kandidaten stammen aus `similar()` und, ohne Seed, aus den bestbewerteten Titeln der Bibliothek (Quelle `prior`); die Inhaltsnähe ist 0.
- **Abgeleitet:** Anime-Anteil, Laufzeitband (kurz unter 40 Minuten, mittel unter 100, lang), die fünf stärksten Genres, Rewatch-Anteil (gebraucht für die Strafe „schon gesehen“). Geräteverteilung und Uhrzeiten (`context_fit`) folgen später.
- **Cache:** Redis `reco:taste:<profil>:<nutzerdaten-version>:<home-generation>:<signatur>`, 6 Stunden. Nutzerdaten-Version und Home-Generation (`bumpHome`) ändern sich bei jedem Abspielen, Daumen, Bewerten, Merken und Verwerfen; die Signatur bei geänderten Gewichten. Der Eintrag enthält nur Zahlen (die 400 stärksten Dimensionen je Vektor) und Titel-Ids, nie einen Titel. `resetTaste()` verwirft die Einträge eines Profils (für „Meine Empfehlungen zurücksetzen“).
- **Grenzen:** Sterne und Abspielzeiten gehören zum Konto, nicht zum Profil; sie fließen deshalb nur ins Hauptprofil ein. Lesen und Merken sind pro Profil. Der Verlauf hat höchstens 200 Einträge.

**Artikelvektoren** (`vectors.ts`): je Merkmalsgruppe (Genres, Tags, Studios, Personen) der IDF-gewichtete Indikator, L2-normiert und mit dem Gruppengewicht `RECO_W_*` multipliziert; dazu die TF-IDF-Wörter, die Sammlung als eine Dimension und Jahr, Laufzeit und Bewertungen als z-Werte (auf ±3 begrenzt). Der Gesamtvektor ist L2-normiert, das Skalarprodukt also der Kosinus. Der ganze Index liegt 5 Minuten im Prozessspeicher (einige zehn MB bei zehntausenden Titeln); die Nachbarsuche läuft dort.

**Kandidaten** (`candidates.ts`, jeder trägt seine Quellen)

1. `similar`: `similar()` des Medienservers für den Seed (30), mit Rang.
2. `universe`: Titel derselben Sammlung und Titel, die sich mit dem Seed eine Person aus den ersten 3 Plätzen der Personenliste teilen (Regie, Drehbuch und Urheber stehen im Index vor den Darstellern); bis zu 40.
3. `taste_nn`: die 200 nächsten Nachbarn des positiven Profilvektors im Index (Kosinus), ohne schon Gesehenes.
4. `prior`: nur Kaltstart ohne Seed: die bestbewerteten Titel.

Co-Occurrence, Übergänge, Freunde und Trending kommen mit R3. Erweiterungspunkt: ein `CandidateSource` (`name`, `social`, `run`) wird mit `registerSource()` eingetragen und kann Zahlen (`cooccurrence`, `transition`, `friends`, `trending`, je 0 bis 1) mitgeben, die die Bewertung je Fläche gewichtet. **Quellen mit `social: true` (und die Namen `cooccurrence`, `transition`, `friends`, `trending`) werden für Kinderprofile nie ausgeführt.** Titel, die die Quellen nur als Id kennen, werden mit der Identität des Betrachters nachgeladen; was sie nicht sehen dürfen, fällt weg.

**Bewertung** (`score.ts`):

```
score = a·Inhaltsnähe + b·Seed-Nähe + c·Co-Occurrence + t·Übergang + d·Freunde + e·Qualität + f·Frische + Trending − Strafen
```

- Inhaltsnähe = cos(positiv) − 0,5·cos(negativ). Seed-Nähe = Kosinus zum Seed, gemischt (70 : 30) mit dem Rang aus `similar()`.
- Qualität: bayessch geglättete Community-Bewertung (Mittel aus Bewertung und dem Bibliotheksmittel mit Vorab-Gewicht 25 Stimmen), auf 0 bis 1 abgebildet (4 bis 9). Jellyfin liefert **keine Stimmenzahl**; angenommen werden deshalb für jeden Titel 25 Stimmen. Das dämpft Ausreißer („10,0“) gleichmäßig, kann aber einen Titel mit 2 Stimmen nicht von einem mit 2000 unterscheiden. Eine Kritikerwertung (`critic_rating`) fließt mit 30 % ein.
- Frische = `0,5^(Tage seit Aufnahme in die Bibliothek / 120)`.
- Trending ist auf allen Flächen höchstens 10 % des Scores (`score.trendingCap`).
- **Strafen:** schon gesehen −0,8 (bei Profilen, die viel wiederschauen, −0,25), `dropped` −1,5, auf der Merkliste −0,4 (sie hat eine eigene Zeile). Fast-Dubletten (Kosinus ab 0,92 zu einem schon gewählten Titel) strafft der MMR-Schritt mit −0,5.
- **Harte Filter:** Daumen-runter, der Seed selbst, alles außer Filme und Serien, und bei Kinderprofilen alles ohne bekannte Freigabe oder über der Altersgrenze (`ratingAge`: FSK/DE-Zahlen, MPAA- und TV-Labels nach einer vorsichtigen eigenen Tabelle: PG = 10, PG-13 = 13, R = 17). Der Medienserver erzwingt dieselbe Grenze ohnehin, weil jede Abfrage mit der Identität des Kindes läuft; der eigene Filter ist ein Gürtel dazu.
- **Flächen** (`surface`), je eine Gewichtsgruppe: `postplay` (Seed-Nähe und später Übergänge vorn), `because` (Seed vorn), `taste` (ohne Seed), `detail_similar` (fast nur Seed), `home_rows`. Die Standardwerte stehen in `weights.ts` (`DEFAULT_RECO_COEFFICIENTS.surface`).

**Umsortierung** (`rank.ts`): MMR mit λ = 0,7 (`λ·Relevanz − (1−λ)·größte Ähnlichkeit zu den schon gewählten`, Relevanz auf 0 bis 1 skaliert), höchstens 2 Titel je Sammlung/Franchise und Zeile, höchstens `ceil(Zeilenlänge·0,5)` (mindestens 2) Titel mit demselben Hauptgenre (das erste Genre im Index). Reicht das nicht für die Zeile, wird die Genre-Grenze gelockert, die Franchise-Grenze nie.

**`recommend(ctx, user, profile, { seed?, surface, limit })`** (`recommend.ts`) verbindet die Schritte. `user` ist die Identität des Betrachters (bei einem Kinderprofil dessen eigene), jeder Aufruf an den Medienserver läuft mit ihr. Antwort: `items` (Titel, Score, Quellen, Teil-Scores), `cold`, `pool` (Scores aller Kandidaten vor der Umsortierung). Ist der Seed eine Folge, gilt ihre Serie.

**Koeffizienten.** Alle Zahlen stehen in `weights.ts` (`DEFAULT_RECO_COEFFICIENTS`) und lassen sich über `RECO_COEFFS` (JSON-Objekt aus Punkt-Namen und Zahlen, Beträge bis 1000) überschreiben, die Halbwertszeit zusätzlich über `RECO_HALF_LIFE_DAYS`. Unbekannte Namen, Nicht-Zahlen und kaputtes JSON werden ignoriert. Gruppen: `signal.*` (Signalgewichte), `profile.*` (Kaltstart-Grenze 5, Abbruch 15 % / 14 Tage, Gewicht des negativen Vektors 0,5, Cache-Dauer), `candidates.*` (200 Nachbarn, 30 `similar`, 40 `universe`), `score.*` (Glättung, Frische, Trending-Grenze), `penalty.*`, `rank.*` (`lambda`, `perFranchise`, `genreShare`, `duplicateCos`), `surface.<fläche>.<teil>` mit den Teilen `affinity`, `seed`, `cooccurrence`, `transition`, `friends`, `quality`, `fresh`, `trending`. Beispiel: `RECO_COEFFS='{"signal.thumbUp2":4,"surface.because.seed":0.6,"rank.lambda":0.8}'`. Die vollständige Liste der Namen liefert `COEFFICIENT_NAMES`. Ein Fixture-Test (`backend/test/reco-engine.test.ts`) hält die Standardreihenfolge fest: Wer einen Standardwert ändert, muss die erwartete Reihenfolge bewusst mitändern.

### v2 auswerten

```
npm run build -w backend            # einmal: der Auswertungslauf nutzt den übersetzten Backend-Code
node scripts/reco-eval.mjs          # popularity, v1, cooccurrence und v2 nebeneinander, dazu v2 gegen jede Basis und das Tor
node scripts/reco-eval.mjs --gate   # Exit-Code 1, wenn das Tor nicht bestanden ist
DATABASE_URL=… node scripts/reco-eval.mjs --db --items items.json --similar similar.json
```

`RECO_EVAL_DIST=<Verzeichnis>` zeigt auf einen anderen Build. Ohne Build wird v2 übersprungen (Hinweis auf stderr); `--engines v2` bricht dann mit einer Meldung ab. v2 läuft offline mit demselben Code wie im Betrieb (Profilmathematik, Vektoren, Bewertung, MMR; `backend/src/reco/offline.ts`), nur aus dem Datensatz gespeist: Der Index wird aus den Datensatz-Titeln gebaut, `similar()` kommt aus `--similar` (ohne Angabe nehmen die nächsten Nachbarn des Seeds seinen Platz), Signale sind „gesehen“ (+1,0), „Daumen hoch“ (+1,5) und „Daumen runter“ (−4,0) mit Zeitabfall. Zusätzliche Titelmerkmale im Datensatz (alle optional): `tags`, `studios`, `people` (Listen), `runtime` (Minuten), `rating` (0 bis 10), `collection`, `added` (ms). `--items` sollte sie enthalten, sonst kennt v2 nur Genre und Jahr.

Die Ausgabe ergänzt die Tabelle um den Vergleich von v2 mit jeder Basis (Prozentpunkte, `*` = v2 besser) und das Tor aus der Spezifikation: v2 braucht beim NDCG@10 mindestens `--gate-margin` (Standard 0,05 = 5 %) Vorsprung vor **jeder** Basis. Die mitgelieferten Testdaten sind synthetisch (sechs Genre-Cluster) und begünstigen inhaltsbasierte Verfahren; sie prüfen die Mechanik, nicht die Qualität. Aussagekräftig ist der Lauf erst mit den Daten der eigenen Instanz. Das Tor ist nur ein Teil der Freigabe: Dazu kommt die Wiedergabequote nach 2 Wochen im Shadow-/Teilbetrieb (R4). Übergangs-Genauigkeit von v2 enthält noch keine Übergangsquelle (R3).

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
