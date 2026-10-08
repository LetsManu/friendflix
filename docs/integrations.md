# Integrations (Jellyfin, Seerr, Authentik, ntfy/Discord)

All webhook URLs use the **internal Docker network** (`http://backend:3000`), never the public host. NPM answers `/internal/*` with 404.
`WEBHOOK_SECRET` is the shared secret (`.env`).

## Jellyfin webhook plugin (optional, polling `/Sessions` every 10 s is the fallback)
Plugin "Webhook" → Add Generic Destination:
- Webhook URL: `http://backend:3000/internal/webhook/jellyfin`
- Notification Type: Playback Start, Playback Progress, Playback Stop
- Header: `X-Webhook-Secret: <WEBHOOK_SECRET>`
- Template:
```json
{"type":"{{NotificationType}}","user":"{{NotificationUsername}}","itemId":"{{ItemId}}","name":"{{Name}}","seriesName":"{{SeriesName}}","positionTicks":"{{PlaybackPositionTicks}}","runtimeTicks":"{{RunTimeTicks}}","isPaused":"{{IsPaused}}","deviceName":"{{DeviceName}}"}
```
Pause is derived from `isPaused` in progress events. Sessions started in the portal are tracked directly and need no webhook.

## Seerr
- Users imported from Jellyfin get default permissions. Leave "auto-approve" **off** if the admin should approve every wish.
- Settings → Notifications → Webhook:
  - Webhook URL `http://backend:3000/internal/webhook/seerr`
  - Authorization Header: `<WEBHOOK_SECRET>` (the portal accepts `Authorization` or `X-Webhook-Secret`)
  - Notification types: Request Pending Approval, Approved, Declined, Available
  - JSON payload: default template (`notification_type`, `subject`, `media.media_type`, `media.tmdbId`, `request.request_id`).
- API key: Settings → General → `SEERR_API_KEY`.
- Paths used (`/api/v1`): `/search`, `/movie/{id}`, `/tv/{id}`, `/request`, `/request/{id}/approve|decline`, `/user`, `/user/import-from-jellyfin`.
  Verify against your instance's `/api-docs`: the user import path differs between Jellyseerr/Seerr versions.

## Authentik
1. Provider: OAuth2/OpenID, confidential, redirect URI `https://portal.example.com/auth/callback`, scopes `openid profile email` + a `groups` property mapping (claim `groups`).
2. Application slug `friendflix` → `OIDC_ISSUER=https://auth.example.com/application/o/friendflix/`.
3. Group `friendflix-admins` (= `ADMIN_GROUP`): members become portal admins on first login (no invite needed).
4. **MFA mandatory:** Authenticator Validation Stage in the authentication flow: *Not configured action = Force the user to configure an authenticator*, device classes TOTP + WebAuthn. Same in the enrollment flow.
5. Optional invitations: enrollment flow with an *Invitation stage*; API token → `AUTHENTIK_API_TOKEN`, `AUTHENTIK_URL`, `AUTHENTIK_ENROLL_FLOW=<slug>`. The portal creates a single-use Authentik invitation per portal invite and shows its link on the invite page.

## ntfy / Discord
`NTFY_URL=https://ntfy.example.com/friendflix` and/or `DISCORD_WEBHOOK_URL=...` for "now available", pending wishes, voting events.
