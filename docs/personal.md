# Persönlich & Handy (Block 17 / S1)

## Themenlisten

Jede Liste kann von ihrer Besitzerin / ihrem Besitzer zur **Themenliste** gemacht werden (Liste öffnen → „Umbenennen“ → „Als Themenliste gestalten“): Titel, Beschreibung, optionales Emoji und eine Titelfarbe (feste Palette, `#rrggbb`). Gespeichert in `lists.themed / emoji / cover_color` (Migration 33). Die Seite `/lists/[id]` zeigt dann einen redaktionellen Kopf (Farbverlauf, großer Titel, Beschreibung) über dem Raster.

Admins (Hauptprofil) heften Themenlisten auf `/lists` unter „Themenlisten auf der Startseite“ an oder ab und sortieren sie (`featured_pos`). Angeheftet heißt `featured_at is not null` – das Limit `MAX_FEATURED` (5) gilt gemeinsam mit den „hervorgehobenen Listen“ aus `/admin/lists`. Hervorgehobene Listen, die auch Themenliste sind, erscheinen nur noch als Themenreihe, nicht doppelt.

| Route | Zugriff | Zweck |
| --- | --- | --- |
| `GET /api/lists/themed` | jedes Profil, **auch Kinderprofile** | angeheftete Themenlisten für die Startseite (`<ThemedListRows />`); Titel nur, soweit die Person sie sehen darf; leere Listen entfallen; Kinder bekommen keine Personennamen |
| `GET /api/lists/:id` | Mitglieder; angeheftete Listen als Gast; Kinderprofile nur angeheftete Themenlisten (ohne Mitglieder, Notizen, „hinzugefügt von“) | |
| `PATCH /api/lists/:id` | Besitzer | `themed`, `emoji`, `coverColor` zusätzlich zu Name/Beschreibung |
| `GET /api/lists/themed/manage` | Admin | alle Themenlisten mit Anheft-Status |
| `PUT /api/lists/:id/pin` `{ pinned }` | Admin | an-/abheften (Audit `list.feature` / `list.unfeature`), 409 `not_themed` / `too_many_featured` |
| `PUT /api/lists/themed/order` `{ ids }` | Admin | Reihenfolge der angehefteten Listen (Audit `list.themed_order`) |

## Ruhiger Modus

Profil-Einstellung `calm` (`PUT /api/prefs`, Einstellungen → „Ruhiger Modus“, auch für Kinderprofile). Eine gemeinsame Prüfung, `calmMode()` / `autoplayAllowed()` in `web/src/lib/preview.ts`:

- `playPreview()` startet im ruhigen Modus nichts (Billboard-Trailer, Hover-Vorschau, Vorschau der Detailansicht) – nur ein ausdrücklicher Klick (`explicit = true`, „Trailer abspielen“) spielt noch.
- `autoStartAllowed()` (`detail/autostart.ts`) kennt `calm`.
- `html.calm` (gesetzt in `web/src/lib/stores.ts`) dämpft alle CSS-Animationen und Übergänge, wie `prefers-reduced-motion`; das System-Setting wird zusätzlich über `motionAllowed()` beachtet.

Neue Dinge, die von selbst abspielen oder sich bewegen, müssen `autoplayAllowed()` bzw. `motionAllowed()` fragen.

## Handy: Verknüpfungen, Symbol-Badge, Widgets

- **App-Verknüpfungen** (`web/static/manifest.webmanifest`, `shortcuts`): Weiterschauen, Meine Liste, Suche, Downloads (+ Fernbedienung). Android zeigt die ersten vier beim langen Druck auf das App-Symbol. Das Manifest ist statisch und deutsch; pro Sprache angepasste Namen bräuchten ein vom Server je nach Sprache ausgeliefertes Manifest (offen).
- **Symbol-Badge** (Badging API, installierte PWA auf Android/Desktop; iOS erst ab installierter Web-App mit Push): Zahl der ungelesenen Benachrichtigungen (Neue Folgen gefolgter Serien kommen als Benachrichtigung). Gesetzt von der App beim Start und beim Zurückkehren in den Vordergrund (`web/src/lib/badge.ts`, `syncBadge`) und vom Service Worker bei jedem Push (`updateBadge` in `web/src/lib/sw/push.ts`: Zahl der noch angezeigten Mitteilungen). Wo die API fehlt, passiert nichts.
- **Widgets**: PWA-Widgets (Web App Manifest `widgets` + Service-Worker-Ereignisse) gibt es nur unter Windows 11 (Edge, Widgets-Board). Android/iOS-Widgets setzen eine native App voraus. Deshalb sind keine Widgets enthalten; Verknüpfungen und Badge sind der Ersatz.
