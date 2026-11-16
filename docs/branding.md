<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Branding

*Admin → Branding* (under *Betrieb*, right after *Einstellungen*) gives your installation its own name, byline, logo, app symbol,
accent colour and background mood. Nothing is rebuilt and no file is edited: a save applies at once, in the browser, on phones, on
the TV and on the Chromecast. Only admins can open the page; every change is written to the audit log.

## What you can change

The page has three tabs, with a live preview beside them (Desktop, Telefon, TV, Anmeldung). The preview shows the values you have
not saved yet.

| Tab | Field | Rules |
|---|---|---|
| Identität | **Name der Plattform** | 1–24 characters, default "FriendFlix". At least one letter, digit or symbol. |
| | **Zusatz** (byline) | Up to 32 characters, empty by default. Example: "by AetherSpire". |
| | **Kurzname** | Up to 12 characters. The name under the icon on a phone's home screen. Empty: the name is used. |
| | **Website** | An `http://` or `https://` address without a user name or password, at most 200 characters. |
| | **Über-Text** | Up to 280 characters. Line breaks are allowed. |
| Logo & Symbol | **Kopfzeile** | Name as wordmark (today's look), symbol + name, or your own logo. |
| | **Logo (breit)** | Light on dark. Fitted into 2048 × 512 pixels. |
| | **App-Symbol** | Square, at least 512 pixels. Its centre is cut to 512 × 512. Without an upload, the symbol is the first letter of the name on the accent colour. |
| Farben & Stimmung | **Akzentfarbe** | Six presets (Koralle is today's default, then Violett, Blau, Türkis, Gold, Grün) or any hex colour. |
| | **Stimmung im Hintergrund** | Akzent, Akzent + Violett (today's look), Neutral, Aus. |
| | **Hintergrund der Anmeldung** | Posters from the library (today's look), your own image (fitted into 2560 × 1600), or plain colour. |

Characters are counted as people count them (an emoji is one). Control characters and text-direction marks are refused in every
field. A message under a field appears once you leave it, or when you try to save.

**Contrast stays readable.** You pick one accent; the server derives every shade from it: the accent text on the dark page and
on cards and panels, the button fill under white text, the hover shades and the light shades used on glass. Each is lightened or
darkened until it passes WCAG AA (4.5:1 for text and for white text on buttons, 3:1 for outlines). The page shows the three
ratios, the text row with its lowest value over the page, card and panel colours, and marks a shade *angepasst* when it had to
move. A very dark or very light accent is therefore never unreadable; it just looks a little different as text or on buttons
than in the swatch. Today's coral stays exactly as it was before branding.

**Saving.** Edits are staged. The save bar sends only the fields you changed, together with the version the page loaded. If another
admin saved in the meantime, the page loads their version and keeps your edits on top, and you save again. If they made the same
change, there is nothing left to save. *Auf Standard zurücksetzen* (after a confirmation) restores the defaults of a new
installation. Leaving the page with unsaved edits asks first.

## Where the brand shows

- **Browser:** the tab title (`Seite – Name`), the favicon, the header (the name, symbol + name, or your logo), the footer with the
  byline, the sign-in page (name, byline, background), the name wherever a text mentions the app, and the accent and glow
  everywhere in the app.
- **Phone:** the header, plus the home-screen icon and title. These come from the web manifest, which uses the symbol and the short
  name. A phone picks up a new icon when the app is installed again; most do not refresh an icon that is already on the home screen.
- **TV (in the apps and the browser's TV mode):** the start screen with name and byline, and the brand at the top of the side rail.
- **Chromecast:** the start screen of FriendFlix's own receiver (name, byline, symbol). Google's Default Media Receiver has no
  start screen of ours.
- **Elsewhere:** the title of a push notification that carries none of its own, and the year-in-review card.

Other open tabs and devices take a saved brand the next time they become visible (or on their next load). Each browser keeps the
last brand it saw, so a known brand shows on the first paint, also before sign-in.

## What stays

- **The native apps keep "FriendFlix" as their launcher name and icon** (Android, Fire TV, Samsung, LG, Windows). These are baked
  into the signed packages. Inside, the apps load the branded web interface.
- **The source-code link stays.** FriendFlix is licensed under the AGPL, which requires that everyone who uses it over a network
  can get its source. Branding changes the name you show; it never hides or removes the link to the source code, and there is no
  setting for that.
- **Fonts, the dark look, the glass surfaces and the layout** are not part of branding. Only their glow follows the mood you
  pick.

## Images

- **Formats:** PNG, JPEG or WebP, as a still picture. SVG is not accepted, because an SVG can carry script; an animated WebP is
  refused too.
- **The browser prepares every image before it is sent.** It reads the size from the file's header first and refuses a picture with
  a side longer than 12 000 pixels (or a file over 25 MB) without decoding it. Then it draws the picture on a canvas and encodes it
  again. That drops all metadata (EXIF, GPS position, camera data). The symbol is cut from the centre to 512 × 512 and refused if
  its shorter side is under 512. The logo and the sign-in image are only ever scaled down.
- **Size:** the upload is at most 2 MB. A large photo that is still over 2 MB as PNG is sent as WebP. If it is still too large, it is
  drawn a fifth smaller until it fits.
- **The server checks again.** It reads the type from the file's first bytes (it must match the declared type), refuses anything
  but PNG and WebP, checks each kind's dimensions, and rewrites the file. It keeps only the image data and drops every other chunk
  (EXIF, XMP, ICC profiles, text). Errors: 413 `too_large`, 415 `unsupported_type`, 400 `dimensions` or `corrupt`. The page shows
  each one as a sentence on the image's row.
- **An upload counts only once you save.** The page uploads an image as soon as you pick it, so the preview can show it. An image
  that no saved brand uses is deleted after an hour. If that happened before you saved, the page asks you to upload it again.
- **Serving:** images are served by the backend under `/api/public/brand/img/<sha256>.<png|webp>`. The name is the hash of the
  content, so the address changes whenever the image does, and browsers may cache it forever.

## A byline like "by AetherSpire"

1. Open *Admin → Branding → Identität*.
2. Keep the name (for example "FriendFlix") and type the byline into **Zusatz**: `by AetherSpire`.
3. Check the preview, then *Speichern*.

The header keeps showing only the name. The byline appears under the name on the sign-in page, in the footer, and on the TV and
Chromecast start screens. To brand the whole thing as your own instead, change the name itself and leave the byline empty.

## For operators

- **Reverse proxy:** the image upload is `PUT /api/admin/brand/image/<kind>`. Its body can be up to 2 MB, more than the 1 MB the
  shipped `/api/` location allows. [`deploy/npm/portal.advanced.conf`](../deploy/npm/portal.advanced.conf) has its own location
  for it with `client_max_body_size 3m`. That leaves room, so the backend's own 413 answer reaches the page instead of nginx's. If
  you wrote your own proxy configuration, add the same location ([operations.md](operations.md#branding-uploads-und-manifest)).
- **The web manifest and the Cast receiver page** are rendered by the `web` container. It asks the backend for the brand at
  `BACKEND_URL` (compose sets `http://backend:3000`) and remembers the answer for a minute. Without `BACKEND_URL`, or while the
  backend is unreachable, they fall back to the default brand.
- **Before sign-in:** `GET /api/public/brand` needs no session and is open during setup. It returns only the public fields listed
  above, the derived colours and the image addresses, never who changed what. See [security.md](security.md#branding).
- **API:** `GET` / `PUT /api/admin/brand` (`{ rev, brand: { …changed fields } }`; a stale `rev` answers 409 `brand_conflict`),
  `POST /api/admin/brand/reset` (`{ rev }`), and `PUT /api/admin/brand/image/<symbol|logo|signIn>` with the raw image body. All
  are for admins only and checked for CSRF.
- **Audit:** `brand.update` and `brand.reset` record the names of the changed fields, and `brand.image` records the image kind. No
  values or image bytes are recorded.
