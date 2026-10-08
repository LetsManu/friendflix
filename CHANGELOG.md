# Changelog
## [Unreleased]
### Step 15 – TV mode, phone remote, local ports
- **TV mode** for smart TVs / sticks / consoles: pairing screen `/tv` (code + QR), TV gets its own 30-day session (7 days idle), listed under *Geräte*; 10-foot UI (big type, strong focus rings), geometric D-pad navigation (`lib/spatial.ts`), Back key support for Tizen/webOS/Android TV, focus memory when going back, control bar reachable with up/down in the player, media keys. `?tv=1` previews it in any browser.
- **Phone as remote** (`/remote`, menu "Fernbedienung"): play/pause, ±10/±60 s, stop, home, "continue watching" and search with *Auf TV*, "Auf Fernseher" button on detail pages. WebSocket hub `/ws/remote` (same user only, command whitelist, flood limit, revoked sessions are disconnected immediately).
- Security: pairing needs a logged-in user, one-time 10-minute code with secret poll token, phishing warning, notification + audit entry on every pairing; anonymous `/api/tv/code|claim` are exempt from CSRF (no ambient authority).
- Player: **starts automatically** now (falls back to muted start with a hint if the browser refuses sound; the first key unmutes), publishes its state for the remote.
- **Fix:** the watch page re-requested `/api/items/:id` in an endless loop (Svelte 5 dependency tracking of an inline async block), so the title never showed and the API was hammered; the loader is a function now.
- Ops: no shared Docker network with NPM needed any more – web/backend/gateway are published on `127.0.0.1:3080/3081/3082` only (`BIND_ADDR`, `*_PORT`); NPM configs and `scripts/test-plan-b.sh` updated; Plan B uses `compose.planb.yaml` (Jellyfin on `127.0.0.1:8096`); `mediaedge` network removed.
### Step 14 – Social & discovery
- Group matcher ("Was hat noch keiner von uns gesehen?"): opt-in per participant, intersection of unwatched lists with each user's own token, filters (length/genre), one click to a film-night poll.
- Scenes: share links with timestamp (`/watch/<id>?t=`), bookmarks with notes and timeline markers.
- X-Ray cast panel on pause; find subtitles via Jellyfin remote providers; picture of title mood (dynamic tint on the detail page).
- Recommend to friends, "Von Freunden empfohlen" and "Freunde haben bewertet" rows (rating sharing opt-out), thumbs up/down feeding "Weil du ... gesehen hast".
- "Demnächst" from Seerr with one-click wish; extras/bonus material, collections and studio hubs.
- Muted hover trailer previews (local trailers only), shareable Wrapped card (PNG, rendered in the browser).
### Step 13 – Streaming features
- Timeline preview thumbnails (Jellyfin trickplay) through the gateway/auth_request allowlist.
- Quality selector (Auto/1080p/720p/480p/360p, never above the role limit); "Einstellungen" menu with quality, speed and sleep timer ("nach 15/30/45/60 Min." or "nach dieser Folge").
- Picture-in-picture button.
- Viewing preferences (autoplay next, auto-skip intro, preferred audio/subtitle language, default quality) stored server-side, settings page.
- "Weil du ... gesehen hast" row and Jellyfin-based "Ähnliche Titel".
- Fix: CSS class collision made the player menus invisible (`.bar` clipped them).
### Step 12 – Own player + watch party in the player, Plan B
- Custom Netflix-style player: scrubbing timeline with buffer + hover time, ±10 s, volume, remaining time, audio/subtitle menu, speed, fullscreen of the whole stage (overlays stay visible), auto-hiding controls, touch gestures (double-tap ±10 s), spinner, toasts, keyboard shortcuts.
- Watch party inside the player (Amazon-Watch-Party style): avatar stack with host crown and buffering state, chat side panel with unread badge + fading message bubbles, reaction picker with floating emoji, "waiting for X" banner, copy invite link, host switch "Nur Host / Alle dürfen steuern", guests see locked controls with hint.
- Plan B implemented: `GET /internal/authz-nginx` + hardened nginx `auth_request` config, shared allowlist test vectors, query length/param limits (also in the gateway), `friendflix_authz_nginx_total`, `mediaedge` network, end-to-end test script against real nginx.
### Step 11 – Polish
- Gateway: images are browser-cacheable (`private, max-age=86400, stale-while-revalidate`, ETag/304 pass-through); upstream `public` is downgraded to `private`.
- Title logos (transparent PNG) in billboard and detail popup, text fallback.
- Detail popup over the current page (shallow routing, focus trap, Esc/back closes); "Mehr Infos" opens it.
- "Top 10 nach Bewertung" row with large rank numbers; posters without backdrop shown contained on a blurred copy.
- Player: "Intro/Abspann überspringen" from Jellyfin media segments (10.10+), keyboard shortcuts (Space/K, J/L/arrows, M, F).
- Emoji removed from the UI (achievements use icons); notification texts without emoji.
### Step 10 – Cinematic UI
- New design system (OLED dark, Inter self-hosted, tokens, focus rings, reduced-motion, skeleton loading, 44 px touch targets) generated with the ui-ux-pro-max skill.
- Home: full-bleed billboard, carousels with arrows + scroll-snap, hover preview cards (play, list, favorite, details), lazy-loaded genre rows.
- Transparent-to-solid top navigation, expanding search, profile menu, mobile tab bar; Browse (Filme/Serien with genre/sort/filter), "Neu & beliebt", search with wish fallback.
- Detail page with episode list + progress; immersive player page with auto-hiding chrome and "next episode" countdown; restyled invite page.
- Backend: `GET /api/watchlist/ids` for the "Meine Liste" state on cards.
### Step 9 – Improvements
- Feature: "Überrasch mich" – random unwatched movie/series, optional genre filter (`/api/library/random`, `/api/library/genres`).
- Security: sliding idle timeout (default 2 h) plus absolute lifetime (8 h) for sessions; "log out other devices" for users; admins can end all sessions of a user (audited).
- Fix: gateway session cache shortened (15 s -> 5 s) so logout/revoke takes effect on streams almost immediately.
- Fix (CI): runtime images no longer ship the base image's npm/yarn (Trivy findings).
### Step 8 – Admin, metrics, backups, hardening
- Admin status page, extended Prometheus metrics, backup script + sidecar + restore test, Docker-secrets override, strict CSP + security headers, error handler.
- Fixes: `_FILE` secret loading restricted to known settings, OIDC dev flag (`OIDC_ALLOW_INSECURE`), generic error handler (zod -> 400).
### Step 7 – Stats, achievements, now playing
- Watch-time statistics from playback events, personal Wrapped + group leaderboard, 11 achievements (state and event driven), now-playing board.
### Step 6 – Voting, wishes, notifications
- Film-night polls (one vote per user, countdown, auto-start party room), non-library winners need admin approval -> Seerr request -> auto-scheduled when available, ratings with short reviews, series calendar with follow + notifications (in-app, ntfy, Discord).
### Step 5 – Watch party
- Own WebSocket sync (no SyncPlay): host-controlled play/pause/seek with server timestamps, ~300 ms drift correction, room holds until all participants have buffered, chat + whitelisted emoji reactions, scheduled auto-start, Origin + session checks.
### Step 4 – Seerr
- Search, wishes in the user's name (mapped Seerr user), status mapping, admin approve/decline, Seerr webhook (available/pending/approved/declined), in-app notifications + ntfy/Discord push, TMDB poster proxy.
### Step 3 – Invites, roles, mapping
- Single-use hashed invite links with expiry (optional Authentik invitation), role templates applied to Jellyfin policy, admin user management (role, disable), device approval for new devices, audit log, public invite landing page.
### Step 2 – Gateway + Player
- Gateway: streaming proxy (no buffering, HTTP Range, server-side Jellyfin token, path allowlist, SSRF guard, bitrate clamp, Prometheus metrics).
- Backend: Postgres migrations, encrypted per-user Jellyfin credentials, library/search/resume/next-up/favorites/played/watchlist API, PlaybackInfo, Playing/Progress/Stopped reporting, stream limits, Jellyfin webhook + /Sessions polling fallback, /internal/authz, /metrics.
- Web: SvelteKit UI (German) with home, library, search, item detail, hls.js player (direct play default, audio/subtitle selection).
### Step 1 – Foundation
- compose.yaml with isolated networks, Fastify backend (/health, /health/ready), Authentik OIDC login (PKCE), CSRF-protected logout, Jellyfin client, OpenAPI generation script, NPM configs, gateway health stub.
### Step 0 – Bootstrap
- Repo structure, license notice (all rights reserved), .gitignore, .env.example, CI, Dependabot, gitleaks hook.
