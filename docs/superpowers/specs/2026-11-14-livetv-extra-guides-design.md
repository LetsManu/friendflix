# Live TV: extra programme guides (design)

Status: draft for the owner's approval · 2026-11-14 · builds on the Live TV Phase 1 spec
(`docs/superpowers/specs/2026-11-11-live-tv-design.md`, §6.1, §9.1, §9.4).

## Intent

The owner's provider list carries German, Austrian and international channels, but its only XMLTV guide covers
Germany/Austria. International channels therefore show no programme. The owner wants to add **more guides** (XMLTV links
and uploaded XMLTV files) so those channels get now/next and, later, the Phase 2 grid — and wants to be able to **tie a
guide to a specific list or to specific channels**. Guides from other services through an API are not built now, but the
design must leave room for them.

## Goals

- Add any number of extra guides in *Admin → Live-TV → Quellen*, each from an **XMLTV link** (http/https, optionally `.gz`)
  or an **uploaded XMLTV file** (`.xml` / `.xml.gz`).
- Extra guides are imported, refreshed, pruned and matched with the existing Phase 1 machinery (staging + swap, 8-day
  window, NUL strip, offsets, logos, now/next).
- A guide can be **limited** to the channels of chosen sources (provider lists and/or the own-feeds source), or serve all.
- An admin can **pin one channel to one guide entry by hand** (overriding automatic matching), and set it back to automatic
  or to "no guide".
- Own feeds can get a programme (through a guide's scope or a manual pin).
- Order among guides decides which wins when several match a channel equally.

## Non-goals (this round)

- Guide services with their own API/login (Schedules Direct, EPG providers with keys). Only the data model leaves room.
- Similarity ("fuzzy") suggestions and the full Phase 2 *Ohne Programm* workflow (bigram suggestions, rules). The manual pin
  here is the minimal piece of it: search a guide's channels by name and pick one.
- The Phase 2 EPG grid itself.

## Anti-goals

- A guide upload or link must never be able to make the backend parse untrusted XML: parsing stays inside the `livetv`
  container, exactly like today's XMLTV links.
- No change to how a provider list's own guide behaves for an owner who adds no extra guide.
- No secrets in answers or logs: guide links are stored encrypted and shown masked (`epgHint`), like list links.

## Approaches considered

- **A. Guides as their own sources (chosen by the owner).** A new source kind `guide` in `livetv_sources`; it reuses the
  per-source EPG import, the `livetv_epg_channels` index and `livetv_programmes`, which are already keyed by `source_id`,
  and the matching passes already look at all sources' indexes. Room for API services = another `provider` value.
- B. Several guide links per provider list — smallest admin change, but own feeds stay without guide, uploads are awkward,
  an API service does not fit later. Rejected.
- C. A separate guide model with its own tables — cleanest on paper, duplicates working import/matching code and needs a
  bigger migration for the same result. Rejected.

## Design (decided)

### Data

- `livetv_sources.kind` gains `'guide'`. A guide row uses: `name`, `epg_url_enc`/`epg_hint` (link guides), `user_agent`,
  `allow_lan`, `refresh` (same choices as lists; default `24h`), `epg_shift_min`, `enabled`, `position`, the `epg_*` status
  columns. It has no `url_enc` (the existing check `(kind = 'm3u') = (url_enc is not null)` stays true).
- New columns (one new migration, next free index at merge time, rerunnable):
  - `guide_provider text` — `'xmltv_url' | 'xmltv_file'` for kind `guide`, null otherwise. Future API services add values
    here (e.g. `'api:<service>'`) with their own settings column; nothing else in the model changes.
  - `guide_scope uuid[]` — the source ids whose channels this guide may serve; **null = all channels**. Only meaningful for
    kind `guide`. Entries may be provider lists or the own-feeds source. A deleted source is removed from every scope.
  - `guide_file text` — for `xmltv_file`: the stored file's name (see Upload); null otherwise.
- Channels: `epg_match` already has `'manual'`; a manual pin sets `epg_match='manual'`, `epg_source_id`, `epg_channel_id`.
  `'none'` = no guide. Automatic matching never touches `manual`/`none` channels (as today).

### Matching (extends §9.4)

For each `epg_match='auto'` channel, the four exact passes stay as they are. Within each pass the candidate guides are
looked at in this order:

1. the channel's own provider list's guide (if it has one) — as today;
2. every enabled `guide` source whose scope is null or contains the channel's source id, in `position` order;
3. the other provider lists' guides — as today ("then the other sources' EPG").

In each pass, the first candidate guide that has any hit decides: exactly one hit there matches; several hits there are
ambiguous and the pass moves on (as today). Owner-visible effect: adding guides never removes a match a channel has today
from its own list's guide; it can fill channels that had none.

### Import and refresh

- Link guides: exactly the existing `refreshEpg` path (`POST /v1/fetch/xmltv` on livetv, NDJSON, staging + swap).
- File guides: the admin uploads the file to the backend (`PUT /api/admin/livetv/sources/:id/file`, body = raw bytes,
  `.xml` or gzip, ≤ `XMLTV_MAX_BYTES` 300 MB, admin + CSRF, streamed to disk). The backend stores it in its data volume
  (`livetv-guides/<sourceId>.xml[.gz]`, written to a temp name then renamed). The import sends the file's bytes to a new
  signed livetv route `POST /v1/parse/xmltv` (body = the file, same NDJSON answer and limits as `/v1/fetch/xmltv`; the
  route's body cap = `XMLTV_MAX_BYTES`). livetv parses; the backend never parses XML. A file guide refreshes only when a new
  file is uploaded or on *Jetzt aktualisieren* (its `refresh` is fixed to `manual`).
- Deleting a guide deletes its file, its programmes and its index rows, and resets channels matched to it to `auto` (they
  re-match on the next pass).

### Admin UI (Quellen tab)

- *Quelle hinzufügen* gets a third kind: **Programmführer** (next to *Anbieterliste* and *Eigene Streams*). The sheet asks:
  name; *Link* or *Datei* (file picker, `.xml`/`.xml.gz`); refresh interval (link only); time offset; **Gilt für**: *Alle
  Sender* or a checklist of the sources (lists and *Eigene Streams*). *Prüfen* on a link shows the guide's channel count and
  a few channel names (like the list test); a file is checked after upload.
- A guide card shows: name, link hint or file name + size, *Gilt für* summary, last import ("Programm: 6.812 Sendungen,
  412 Sender"), how many channels it currently serves, refresh/edit/delete actions, and drag/keyboard order among guides.
- *Kanäle*: the EPG column/menu gets **Programm zuordnen…**: a sheet with a guide picker and a name search over that guide's
  XMLTV channels (`GET /api/admin/livetv/epg/channels?source=<id>&q=`), plus *Automatisch* and *Kein Programm*. This uses the
  Phase 2 route `PUT /api/admin/livetv/channels/:id/epg` `{ sourceId, xmlId } | { none: true } | null` brought forward.
- All copy in 7 locales, identical key order; owner UI rules (44 px targets, transform/opacity only, no jumps).

### Room for API services (not built)

`guide_provider` is the switch. An API service later adds: a provider value, an encrypted settings column (key/account),
a backend or livetv adapter that turns the service's answer into the same NDJSON lines (`channel`, `programme`, `end`).
Everything after that (staging, swap, matching, now/next) is shared.

## Constraints

- Same security boundaries as Phase 1: links pass livetv's address guard; uploads are admin-only, size-capped, stored
  outside the web root, never served back; parsing only in livetv.
- Performance: matching stays within the Phase 1 budget for 20 000 channels × up to 10 guides × 100 000 XMLTV channels.
- Migrations rerunnable; renumbered at merge time if another lands first.

## Left to the builder

- Exact SQL of the scope filter in `indexRows`/`matchIds`, and the index needed for it.
- Whether the upload streams straight to livetv or reads the stored file per refresh (both fine; the stored file is the
  source of truth).
- Card layout details within the existing *Quellen* card style; the order control may reuse `OrderView`.
- Test shapes (backend: matching order, scope, manual pin, delete cleanup, upload limits; livetv: `/v1/parse/xmltv`;
  web: sheet, card, assign sheet; e2e desktop + phone).
