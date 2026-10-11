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

## Web

- **`/search`:** Die Abschnitte heißen Personen, Genres, Filme & Serien und Folgen.
  - Der Zustand steckt in `?q=`.
  - Die letzten 8 Suchen werden lokal im Browser gespeichert und lassen sich löschen.
  - `/` oder Strg/⌘+K springt von überall in die Suche.
- **`/person/<id>`:** Filmografie mit Filter Alle/Filme/Serien. „In Filmen stöbern“ öffnet `/browse/movies?person=<id>`.
- **`/browse/movies|series`:** Filter für Genre, Jahrzehnt, Bewertung, Sortierung und Status.
  - Aktive Filter erscheinen als Chips mit ×.
  - Alle Filter stehen in der URL und lassen sich teilen.
