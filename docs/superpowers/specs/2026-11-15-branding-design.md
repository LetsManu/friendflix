# Admin → Branding

Status: approved by the owner on 2026-11-15 ("branding looks good, a go for all"). Mockup: board 8 "Admin → Branding" of the
"Menus & pop-ups" design canvas (`scratchpad/menumock/project/Branding.dc.html`).

## Why

FriendFlix should be usable by other people and companies under their own name, and the owner's own installation shows
"FriendFlix by AetherSpire" (AetherSpire is the owner's programmer group). An admin changes the name, byline, logo, colours and
texts on one page, without touching files or rebuilding anything.

## Goals

Admin → Einstellungen gets a **Branding** page (its own admin menu entry) with six areas and a live preview:

1. **Identity.**
   - Name: default "FriendFlix", 1–24 characters.
   - Byline: optional, up to 32 characters; this installation's default is "by AetherSpire", the shipped default is empty.
   - Short name for home screens: up to 12 characters, defaults to the name.
   - Website address and an about text (up to 280 characters).
   - The byline shows under the name on sign-in, in the footer, under "Über", on the TV and Chromecast start screen, and in the e-mail
     preview. The header shows only the name.
2. **Logo and app symbol.**
   - Header style: name as wordmark, app symbol + name, or own logo.
   - Uploads: a wide logo (light on dark) and a square app symbol of at least 512 px. PNG/WebP/JPEG only (no SVG: it can carry
     script), at most 2 MB, re-encoded server-side and stripped of metadata.
   - From the symbol come the favicon, the apple-touch icon, the PWA/manifest icons (any + maskable) and the Chromecast receiver
     logo.
   - Without an upload, the symbol is the name's first letter on the accent fill.
3. **Colours and mood.**
   - Accent: six presets (Koralle `#ff4f6d` = today's default, Violett, Blau, Türkis, Gold, Grün) or a custom hex.
   - The server derives `--acc` / `--acc-text` (≥ 4.5:1 on `--bg`), `--acc-fill` (white text ≥ 4.5:1), the hover shades and the light
     glass variants (`--acc-light` / `--acc-line`), adjusting lightness until each passes. The UI shows the ratios and "angepasst"
     when a shade was adjusted.
   - Background glow: accent, accent + violet (today), neutral, off.
   - Sign-in background: library poster collage (today), own uploaded image, plain colour.
4. **Texts.** Sign-in greeting, sign-in hint, footer text, maintenance message. Empty means the built-in text in the person's
   language. Custom texts are shown as written in every language.
5. **Legal and help.**
   - Impressum, Datenschutz and support (a URL or an e-mail).
   - Optional "Läuft mit FriendFlix" credit.
   - The source-code link under "Über" always stays: the AGPL requires it and it cannot be switched off.
6. **Sharing and e-mails.**
   - OpenGraph link previews for shared title links (poster, title, year, "auf {name} ansehen"). Without a session, a preview reveals
     nothing beyond title, year and poster, and only for titles reachable by a share link; it is off by default when the instance
     is private.
   - Sender name (stored now, used by the e-mail backlog, LetsManu/friendflix#321).
   - The e-mail preview shows the planned look.

Plus:
- **Export / import** of all branding (JSON with images inlined as base64, validated like a save).
- **Reset to defaults.**
- **Audit entries.**

## Where it applies

- **Web:** the tab title (`{page} – {name}`), apple-mobile-web-app-title, the manifest (name, short_name, icons, theme colour),
  favicons, the header, the footer, sign-in, the about page, the offline page, the maintenance page and the accent and glow tokens.
- **TV:** the start screen and the TV sidebar, inside the app.
- **Chromecast:** the receiver start screen.
- **Phone:** the header, plus the home screen through the manifest.
- **Branding before sign-in:** a public, unauthenticated endpoint returns only the public branding fields, so the sign-in page and
  the manifest are branded before anyone signs in. It is cached and its version comes from the settings revision.
- **Native app packages** (Android, Tizen, webOS, Windows) keep "FriendFlix" as their launcher name, because it is baked into the
  package. Inside, they load the branded web UI.

## Non-goals

- Fonts and per-component colours.
- Light theme.
- Per-profile branding.
- Changing package names of native apps.
- Sending e-mail (backlog: LetsManu/friendflix#321).

## Anti-goals

- Unreadable text: a chosen colour never lowers contrast below AA.
- An upload that can run script, or leaks metadata (EXIF/GPS).
- Removing the AGPL source link.
- Sign-in branding that exposes anything private before sign-in.

## Constraints

- Only admins can change branding. Every change goes through the settings revision, is audited, and reaches other open tabs live
  through the existing settings bus.
- Images are served by the backend from the DB or the data folder with immutable cache URLs (a content hash) and CSP-compatible
  same-origin.
- 7 locales with identical key order. Glass and motion follow `2026-11-15-menus-glass-design.md` (no text scaling).

## Approaches

- **A. Branding as settings plus a public brand endpoint, applied as CSS variables and a brand store at runtime (chosen).**
  No rebuild, live updates, one source of truth.
- B. A build-time theme (env vars baked at image build). Simple, but every change needs a rebuild; it does not serve other admins.
- C. A custom CSS field (like some media servers offer). Flexible, but breaks contrast and glass rules and is a footgun.

## Order of work

1. **Stage A (one PR):**
   - the backend brand settings, the validation and colour derivation, the image upload and re-encoding, the public endpoint;
   - in web, the brand store with name, byline and short name, the header style, the logo and symbol (favicons, manifest,
     apple-touch), the accent and glow tokens, the sign-in background, the TV start screen and the cast receiver;
   - the Admin → Branding page with Identity, Logo and Colours, and the live preview;
   - reset, audit, docs and CHANGELOG.
2. **Stage B (one PR):**
   - Texts, Legal and help, Sharing (OpenGraph), the sender name;
   - export and import;
   - the maintenance message.

## Left to the builder

The exact setting keys, endpoint path, image storage (DB bytea vs. data folder), favicon sizes and the colour-adjustment algorithm
(lightness steps in OKLCH or HSL, as long as the ratios hold).
