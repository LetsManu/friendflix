# Notifications center — design

Status: owner picked variant B of the mockup on 2026-11-17 ("B looks very good … start working on it").

## Why

The bell dropdown today is hard to read and overloaded:
- it shows only titles (no icon, no time, no body);
- repeats are not grouped (six identical "Ein Fernseher wurde mit deinem Konto verbunden");
- the heading is half clipped;
- rows with and without a link have different spacing;
- the list has no end and cannot be cleared.

The owner wants it "good to view information, not overloaded, an option to clear, group even maybe", in the spirit of a reference design: a side panel, sections by time, an icon per kind, title plus one line plus time, one action, grouped child entries.

## Goals

- **One side sheet from the right** (variant B) replaces the bell dropdown on desktop and tablet. On a phone the same content is a full-height sheet.
- **Rows:** an icon per kind (colour by category), title, at most one line of body, a relative time, and at most one action link.
- **Unread:** a dot on the icon.
- **Sections:** *Heute*, *Diese Woche*, then one section per earlier month (*Oktober*, *September*, …).
- **Grouping:** entries of the same group key within the same section become one row with a count (*Fernseher verbunden 6×*). Tapping the row opens it in place and lists the single entries with date and time.
- **Filters:** chips *Alle*, *Ungelesen*, then categories that have entries (*Downloads*, *Geräte*, *Serien*, *System*, …).
- **Read:**
  - An entry or group becomes read when it is opened or its action is followed.
  - *Alle gelesen* marks everything read.
  - Opening the sheet no longer marks everything read.
- **Clear:**
  - *Alles leeren* removes all entries for this person. With a category filter active, the button reads *<Kategorie> leeren* and removes only those.
  - A single entry or group can be removed with ✕ (shown on hover or focus) on desktop, or with a swipe on touch.
  - Every removal can be undone for 5 seconds with a toast that has *Rückgängig*.
- **No "show all":** the sheet is the full list. Scrolling to the end loads older pages on its own. The space for the next page is reserved, so nothing jumps.
- The end of the list says how long notifications are kept.
- **Layout fixes:** the header (title, unread count, settings gear to the notification settings, close) stays visible. Spacing is identical for every row.
- The *Mein Bereich* page and the phone header use the same component and data.

## Non-goals

- No new notification kinds. No change to who gets which notification, or to push, mail, ntfy or Discord delivery.
- No real-time socket. The existing 60-second poll and the `ff-notes` event stay.
- The TV apps (webOS, Tizen, Android TV) keep their current views.

## Anti-goals (a failure even if it works)

- Anything that jumps: rows appearing above the reading position, a header that moves, an end-of-list text that moves when a page arrives.
- An overloaded row: more than one body line, more than one action, badges beyond the count.
- A clear that cannot be undone, or one that removes a broadcast notification for everyone.
- Breaking the Android app's poller (`android/.../NotificationPoller.kt`), which reads `GET /api/notifications`.

## Constraints (project rules)

- **UI:**
  - Animate only transform and opacity. Never scale text. Nothing may jump.
  - 44 px touch targets (36 px for mouse only).
  - Glass look (`.frost`, `--fr-r-*`, `--fr-r-sheet` for the sheet), brand tokens `--acc*`.
  - Respect `prefers-reduced-motion`.
  - Web statements coverage ≥ 94 %.
- **Locales:** 7 locales (de, en, es, fr, it, pl, tr) with identical key order. German is the source, in the "du" form. Use "…", not "...".
- **Copy:** never "Netflix" or "Seerr". Fictional names and placeholder hosts only.
- **Kids profiles** keep the existing 403 `kids_profile` on the notification routes.
- **Accessibility:**
  - The sheet is a dialog (`role="dialog"`, `aria-modal`, focus trapped, Escape closes it, focus returns to the bell).
  - Rows are links or buttons with readable names. The count and the unread state are in the accessible name.

## Approaches considered

- **A — Dropdown at the bell, tidied up:** compact, opens where it does today, with *Alle anzeigen* for the rest. Rejected by the owner in favour of B.
- **B — Side sheet from the right:** filters, in-place groups, full scrollable list. **Chosen by the owner.**
- **Grouping on the client:** simpler, but a group would split across page boundaries and the counts would change while scrolling. Rejected (builder's note, controller's call).
- **Grouping on the server (chosen, controller's call):** one query returns sections and groups for a page, so counts are stable.

## Data and API (controller's calls, to be detailed in the plan)

### Per-person state for broadcasts

Broadcasts (`user_id is null`) are shared rows. Read and cleared state for them is kept per person in a new table, `notification_state(user_id, notification_id, read_at, hidden_at)`. Personal rows keep `read_at` on the row and gain `hidden_at`. Clearing never deletes a broadcast row.

### Group key

`kind` plus a normalised title, stored at creation as `group_key text`:
- For message-based titles, the key is the message key without its params.
- For plain text, the key is the text itself.

Existing rows are backfilled in the migration.

Kinds where every entry must stay single, set in one list in code: `update_available`, `update_failed`, `syscheck_problem`, `pin_locked`, `deletion_*`, `access_ended`, `access_soon`.

### Category per kind

A fixed map in the backend, for example:
- `download_*` → `downloads`
- `tv_paired`, `device_pending` → `devices`
- `episode`, `digest`, `available*` → `series`
- `achievement` → `achievements`
- `livetv.*` → `livetv`
- `update_*`, `syscheck_*`, `disk_low`, `flow_mail_cap`, `pin_locked` → `system`
- `poll_*`, `request_*`, `approval` → `requests`
- `party_invite`, `list_invite`, `recommend` → `social`
- the rest → `other`

The web maps a category to an icon and a colour.

### Retention

Entries older than 90 days are deleted by a daily job, along with their `notification_state` rows. This is the controller's call; the owner did not answer the retention question. Today nothing is ever deleted. The end-of-list text states the number of days.

### Endpoints

- `GET /api/notifications` stays as it is (same fields, limit 30) for the Android poller and old clients. It also leaves out hidden entries.
- `GET /api/notifications/feed?cursor=&filter=all|unread|<category>` answers:
  - `{ sections: [{ key: 'today'|'week'|'YYYY-MM', groups: [{ id, kind, category, title, body, link, at, count, unread, items?: [{ id, title, body, at }] }] }], next: cursor|null, unread: n, categories: [{ key, n }] }`
  - A page holds about 30 groups, and `items` caps at 20 per group.
  - The cursor is opaque. Sections and groups never split across pages: a page ends at a group boundary.
- `POST /api/notifications/read` takes `{ ids?: number[] }`. Without ids it keeps today's behaviour (everything).
- `POST /api/notifications/hide` takes `{ ids?: number[], category?: string }` and returns `{ undo: token }`.
- `POST /api/notifications/unhide` takes `{ token }`. The token is valid for 30 seconds.

## Decisions after the builder check (all controller's calls)

1. **Badge and new entries.**
   - The 60-second poll and `ff-notes` call `GET /api/notifications/feed?limit=0`, which answers only `{ unread, categories }`. That count drives the bell badge, so it is no longer capped at 30.
   - While the sheet is open, new entries never appear above the reading position. A pill *N neu* appears in a slot reserved under the header. Tapping it scrolls to the top and reloads the first page.
   - With the sheet scrolled to the top and no group open, the first page is replaced in place. Its rows are inserted above the first row, which is the top, so nothing moves under the reader.
2. **Read across the old and new state.**
   - A broadcast counts as read if the watermark `users.notifications_read_at` covers it **or** its `notification_state.read_at` is set. A personal row counts as read if its `read_at` is set.
   - Nothing is backfilled, and old broadcasts stay read through the watermark.
   - `POST /read` without ids keeps today's effect: it sets the watermark and every personal `read_at`.
   - The legacy `GET /api/notifications` computes `read` the same way, so the Android poller sees a consistent state.
   - More entries staying unread on the web, because opening no longer marks everything read, is intended.
3. **Group-wide read, hide and undo.**
   - Every group in the feed has an opaque `id` that names its group key and its section's time range for this person.
   - `read` and `hide` take `{ ids?: number[], groups?: string[], category?: string }`, and the server expands a group to all its entries, not only the 20 `items`.
   - `hide` stores the affected entry ids in kv under a random undo token for 30 seconds. `unhide` restores exactly those entries.
4. ***Mein Bereich* and the phone.**
   - The /me page shows the newest 5 groups in the same row component, inline, with no sheet, no filters and no clear.
   - Its *Alle ({n})* button opens the sheet.
   - /me no longer marks everything read on view.
   - The phone header's bell opens the full-height sheet.
5. **Sections.**
   - The web sends the viewer's IANA time zone (`tz`, validated against `Intl.supportedValuesOf('timeZone')` on the server, falling back to the server's `TZ`).
   - *Heute* is the viewer's calendar today. *Diese Woche* is the six days before today. After that comes one section per calendar month.
   - A group belongs to the section of its newest entry. Same-key entries in an earlier section form their own group there.
6. **Clear under a filter.** The clear button always removes what the current filter shows: *Alles leeren*, *<Kategorie> leeren*, or under *Ungelesen* the label *Ungelesene leeren*. `unread` and `categories[].n` are global, so they do not follow the filter.
7. **Group rows.**
   - Title, body, link and time come from the newest entry. The count shows when it is above 1.
   - The action label comes from the category (*Ansehen* for downloads and series, *Geräte prüfen* for devices, *Aktualisieren* for `update_available`, otherwise *Öffnen*), in all 7 locales.
   - An entry without a link has no action.
8. **Retention.**
   - The daily job deletes entries older than 90 days, read or unread.
   - It runs on the existing background-job timer where `BACKGROUND_JOBS=true`.
   - A webhook retry after 90 days could re-create a deleted entry. That is accepted.

## What's left to the builder

- The exact icons per category from the existing icon set.
- The exact relative-time strings (reuse the app's existing formatter if there is one).
- The page size and the skeleton row look.
- Pagination internals.
- The sheet's open and close motion (transform-only slide plus fade).
