# Changelog
## [Unreleased]
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
