# Systemcheck and settings tidy-up (design)

Status: approved shape (approach A) · 2026-11-14 · builds on Block 22 (health snapshot), Block 23 phase 3 (sign-in check),
Block 25 (settings registry and probes).

## Intent

The owner, in his words: "a live check and what and how to fix would be very nice to have", and "tidy up the admin section
for settings". Today the pieces exist but are scattered: Admin → Status shows traffic lights (`ServiceLights`, from the
health snapshot), a separate sign-in card (`LoginCard`, from `flowCheck.ts`), the settings page has a "Test" button per
group (`settings/probes.ts`), and Admin → Update and Live-TV each have their own state. Nothing says, in one place, what
is broken, why, and where to fix it. Admin → Settings is one long page of 14 cards with ~65 settings.

## Goals

- **One live checklist** ("Systemcheck") at the top of Admin → Status. Every line has: a status, one plain sentence that
  says the cause, one sentence that says how to fix it, and — when a setting fixes it — a **Zur Einstellung** button that
  opens exactly that setting and highlights it.
- Five statuses: `ok`, `warning`, `problem`, `not_set_up` ("nicht eingerichtet"), `unknown` ("nicht geprüft", only
  for a check that could not run or has not run yet). An optional feature that is not configured is `not_set_up`,
  **never red**.
- Six groups, fixed order: Grundlagen (core), Anmeldung (sign-in), Medien (media), Live-TV, Updates, Reverse Proxy.
- One backend endpoint, cached, never hanging on a slow dependency; **Jetzt prüfen** forces a fresh run.
- Checks that only the browser can measure (websocket upgrade, response buffering, upload limit, response headers) run
  in the browser on the Status page.
- The admin overview shows a small summary ("2 Probleme") linking to the Systemcheck.
- **Settings tidy-up:** tabs instead of one long page, a search box over all settings, and deep links
  `?setting=<KEY>` that open the right tab, scroll to the setting and highlight it.
- Never show a secret: a secret appears only as *gültig / ungültig / fehlt*.

## Non-goals

- No automatic repair. The Systemcheck says what and where; fixing stays where it is today (settings, the Authentik
  repair on the sign-in card, Live-TV pages, the proxy config).
- No new history/alerting: the banner and health snapshot stay as they are (Block 22); the Systemcheck does not post
  notifications.
- No SMTP delivery test (that would send a mail). Mail is checked as "Authentik's recovery flow has an e-mail stage".
- No checks for notification channels (ntfy, Discord, push keys) in this round.
- No new settings, no change to how settings are saved, tested or validated.

## Approaches considered

- **A. Extend Admin → Status into the Systemcheck, one engine over the existing probes (chosen by the owner).**
  The health snapshot, the sign-in check and the settings probes become the inputs of check lines; a thin engine adds
  status mapping, cause/fix codes, setting links, caching and time limits. One endpoint, one UI list.
- B. A separate wizard-like "Diagnose" page that runs everything on demand. Duplicates the Status page, nothing cached,
  slow to open. Rejected.
- C. Put cause/fix texts into each existing card (ServiceLights, LoginCard, UpdaterCard …). No single list, no summary,
  four places to keep consistent. Rejected.

## Design (decided)

### The check result contract

```ts
type CheckStatus = 'ok' | 'warning' | 'problem' | 'not_set_up' | 'unknown';
type CheckGroup  = 'core' | 'signin' | 'media' | 'livetv' | 'updates' | 'proxy';
interface CheckLine {
  id: CheckId;               // e.g. 'core.database' (fixed catalogue below)
  group: CheckGroup;
  status: CheckStatus;
  cause?: CauseCode;         // i18n syscheck.cause.<code>; absent for a plain ok
  fix?: FixCode;             // i18n syscheck.fix.<code>
  settingKey?: string;       // a registry key; the web builds the link
  settingGroup?: SettingGroup; // registry group of settingKey ('livetv' → Live-TV settings tab)
  locked?: true;             // settingKey is set in the environment: the fix adds "steht in der .env"
  href?: string;             // an app-internal page when the fix is not a setting ('/admin/status#login', '/admin/livetv')
  docs?: string;             // 'setup.md#6-nginx-proxy-manager-portal-proxy-host' (validated ^[a-z-]+\.md(#[a-z0-9-]+)?$)
  params?: Record<string, number | string>; // numbers, fixed codes or setting names only
  ms?: number;
  runs: 'server' | 'browser';
}
interface SystemcheckResult { at: string; lines: CheckLine[]; counts: Record<CheckStatus, number> }
```

- **Texts are codes.** No sentence, URL, host, path, exception text or upstream body ever leaves the backend. `params`
  values must match `^-?\d+(\.\d+)?$` (numbers), `^[a-z_]{1,40}$` (codes) or `^[A-Z][A-Z0-9_]{1,40}(,[A-Z][A-Z0-9_]{1,40})*$`
  (setting names); anything else is dropped by the engine (`safeParams`). A secret's state is a status, never a value.
- Docs links point to `https://github.com/LetsManu/friendflix/blob/main/docs/<docs>` (built in the web).
- The web keeps a mirror of the catalogue (ids in order) so the list renders its skeleton at final height before the
  answer arrives, and browser lines show `unknown` ("wird geprüft…") until they ran.

### Status rules

- `problem`: something every user depends on does not work (database, Redis, gateway, media server, OIDC discovery, an
  invalid Authentik token while sign-in runs in the app, an update path that cannot work), or a feature the admin
  turned on is down for everyone (Live TV wanted but its container does not answer).
- `warning`: degraded, partial, slow, or advice (an optional service configured but failing, a slow answer, missing
  HSTS, buffering, flows missing on Authentik). Where the health snapshot already has a level, the line uses **the same
  level** (no two truths between banner and Systemcheck): `err`→`problem`, `warn`→`warning`, `ok`→`ok`,
  `off`+`not_set`→`not_set_up`, `off`+`unavailable`→`unknown`.
- `not_set_up`: an optional feature without configuration (request service, TMDB/OMDb, Authentik API, passkeys off,
  Live TV not enabled, updater not deployed, Portainer not used). Shown neutral (muted pill, no red, not counted as a
  problem).
- `unknown`: the check could not run (time limit hit, a dependency it needs is down — e.g. Live-TV encoder while the
  container is down) or a browser check has not run.

### Engine, endpoint, caching, limits

- `backend/src/syscheck/` holds the contract (`types.ts`), the engine (`engine.ts`) and one file per group
  (`checks/*.ts`). A check is `(env: CheckEnv) => Promise<CheckLine[]>`; `CheckEnv` gives `ctx`, the health snapshot
  (read once per run), a lazily shared `LoginCheck`, the per-check time limit and `fresh`.
- Each group check runs in parallel under its own limit: **4 s** default, **8 s** for sign-in (Authentik reads are
  sequential). A check that misses its limit yields its lines as `unknown` with cause `check_timeout`; the underlying
  work (e.g. `checkLoginFlows`) keeps running and fills its own cache, so the next load has it. A thrown check yields
  `unknown` + `check_failed` (the error is not logged with its message; only `{check, code}`).
- `GET /api/admin/systemcheck` (admin only, `cache-control: no-store`): kv `syscheck:result` (TTL 300 s). Fresh (≤ 60 s) →
  served; older → served at once and rebuilt in the background (single flight per process, like `health.ts`); missing →
  built and awaited (bounded by the 8 s limit). `?refresh=1` → rebuilt with fresh inputs (`getSnapshot({refresh:true})`,
  `checkLoginFlows({fresh:true})`, probes) and awaited; **6 per minute per session**, else 429 `rate_limited` (the page keeps
  the last answer and says so). Redis down: the result is built in-process without the cache (single flight still applies).
- Request-scoped lines (the proxy lines the backend sees on this very request) are computed per request and merged in;
  they are never cached.
- `counts` always cover the server lines only; the web adds its browser lines on the Status page. The overview summary
  uses the server counts (it never runs browser probes).

### Check catalogue

Reuse is the rule: a line reads an existing probe; new code is only where nothing measures it today.

| id | source (reuse) | statuses → cause / fix / target |
|---|---|---|
| core.publicUrl | `runProbe('publicUrl')` | invalid → problem `public_url_invalid`; `insecure` → warning `public_url_http`; `echo_mismatch`/unreachable → warning `public_url_echo` (often NAT loopback) · PUBLIC_URL |
| core.database | snapshot `postgres` | down → problem `db_down`; slow → warning `db_slow` · docs operations.md |
| core.redis | snapshot `redis` | down → problem `redis_down`; slow → warning |
| core.gateway | snapshot `gateway` | down → problem `gateway_down` (videos do not play) |
| core.disk.* (downloads, previews, database) | snapshot `disks` | full/low_free/cap/large with `pct`/`n` · DOWNLOAD_CACHE_MAX_GB, HEALTH_DISK_WARN_PCT, HEALTH_DB_WARN_GB; unreadable → unknown |
| core.env | `removedEnvCount` | n > 0 → warning `removed_env` (`n`) · docs operations.md |
| signin.oidc | snapshot `oidc` | down → problem `oidc_down`; issuer_mismatch → problem · OIDC_ISSUER |
| signin.authentik | `LoginCheck.serviceToken`, `unreachable`, `mode` | no API → not_set_up · AUTHENTIK_URL; token invalid → problem (app mode) / warning `ak_token_invalid` · AUTHENTIK_API_TOKEN; unreachable → problem/warning `ak_unreachable`; missing permissions → warning `ak_permission` (`perms` codes) · href `/admin/status#login` |
| signin.flows | `LoginCheck.warnings` flow_missing / flow_unsupported / consent / auth_code_grant | warning, first code as cause, `n` more · href `/admin/status#login` (the card with the repair) |
| signin.issuerHost | `LoginCheck.issuerMatches` | false → warning `issuer_not_on_authentik` · OIDC_ISSUER |
| signin.passkeys | `passkeysReason`, `passkeySignIn`, `passkeyUv` | disabled → not_set_up · PASSKEYS_IN_APP; not_https → warning · PUBLIC_URL; **forwarded_host_ignored** → warning, fix `proxy_forward_host`, docs authentik.md#23-reverse-proxy-nginx-proxy-manager; probe_not_found → warning · OIDC_ISSUER; no_stage / rp_mismatch / uv_not_required → warning · href `/admin/status#login` |
| signin.mail | recovery flow row of `LoginCheck.flows` | stage `authentik_stages_email.emailstage` present → ok (cause `mail_unverified`: delivery is not tested); flow without it → warning `mail_no_stage`; no API → not_set_up |
| media.server | snapshot `media` | down → problem · JELLYFIN_URL / PLEX_URL (by MEDIA_SERVER); slow → warning |
| media.requests | snapshot `requests` + `runProbe('requests')` when down | not_set → not_set_up · REQUESTS_URL; unauthorized → warning `requests_key_invalid` · REQUESTS_API_KEY; down → warning |
| media.tmdb, media.omdb | snapshot `tmdb`, `omdb` | not_set → not_set_up; invalid_key → warning · TMDB_API_KEY / OMDB_API_KEY; paused, budget (`pct`) → warning |
| media.playback | snapshot `playbackCheck` | never ran → unknown `playback_never` · href /admin/playback; failed_titles → warning (`n`); empty_media → problem |
| media.encoder | snapshot `encoder` (`advice`, `hevc`) | advice → warning, cause = first advice, `advice` codes in params (the UI lists them); hevc_* · HEVC_STREAMS; the HEVC "Jetzt prüfen" action moves here from ServiceLights |
| livetv.container | `detectLivetv`, `LIVETV_WANTED`, `LIVETV_URL` | not wanted & not installed → not_set_up · href /admin/livetv; wanted & not reachable → problem `livetv_down` |
| livetv.encoder | `livetvSystem` + `readHwAccel` + `gpuAdvice` | gpu advice warn → warning `gpu_<key>` · LIVETV_ENCODER (settingGroup livetv); container down → unknown |
| livetv.sources | `livetv_sources` (enabled lists) | none → not_set_up · href /admin/livetv; any `last_error` → warning (`n`); last ok older than 2 × refresh interval (min 26 h) → warning `sources_stale` |
| livetv.guides | `livetv_sources` epg columns (lists with a guide, guides) | none → not_set_up; `epg_last_error` → warning (`n`); older than 2 × `EPG_MAX_AGE_MS` → warning `guides_stale` |
| updates.updater | `updaterView` | UPDATER_URL unset → not_set_up (compose.no-updater); not answering → warning `updater_down`; `unauthorized` → problem `updater_secret` · docs setup.md#updater |
| updates.path | `UpdaterStatus.stack` + Portainer setup | own → ok `path_compose`; foreign & Portainer complete → ok `path_portainer`; foreign & nothing set → problem `portainer_not_set` · PORTAINER_URL; **partly set → problem `portainer_missing` (`keys`) · first missing key**; stack unknown (old updater) → warning `stack_unknown` |
| updates.portainer | `runProbe('portainer')` when the API way is configured | unauthorized → problem `portainer_key_invalid` · PORTAINER_API_KEY; not_found → problem `portainer_stack_missing` · PORTAINER_STACK_ID; not used → not_set_up |
| proxy.forwardedProto (server, per request) | `req.protocol` vs PUBLIC_URL | PUBLIC_URL https but request arrived as http → warning `proxy_no_proto` · docs setup.md#6-… |
| proxy.peer (server, per request) | `isTrustedPeer(req.socket.remoteAddress)` + `x-forwarded-for` present | untrusted proxy peer → warning `proxy_untrusted_peer` · docs setup.md#6-… |
| proxy.websocket (browser) | new `GET /ws/syscheck` (admin, sends `{"ok":true}`, closes 1000) | message within 5 s → ok; else problem `ws_blocked` (Watch party, TV remote, hand-off) · docs setup.md#6-… ("Websockets Support") |
| proxy.buffering (browser) | new gateway `GET /media/probe/drip` (1 KiB, 1.5 s pause, 1 KiB) | first bytes < 1.2 s → ok; only at the end → warning `proxy_buffers_media`; 404 → unknown `probe_missing` |
| proxy.upload (browser, Live TV installed only) | `PUT /api/admin/livetv/sources/<nil uuid>/file` with 2 MiB | backend drains (≤ 4 MiB) and answers `{probe:'ok'}` → ok; 413 from the proxy → warning `upload_limit_low` (guide files > 1 MB fail) · docs setup.md#6-…; network error → unknown; Live TV not installed → not_set_up |
| proxy.headers (browser) | `fetch('/', {cache:'no-store'})` response headers | `x-content-type-options`/`referrer-policy` missing → warning `headers_stripped`; https without `strict-transport-security` → warning `hsts_missing` |

The upload probe tests 2 MiB on purpose: it proves the dedicated guide-file location exists (the general `/api/`
location allows 1 MB); uploading 300 MB to prove the full limit is not safe from a status page. The line says so.

**Updates and PR #303.** PR LetsManu/friendflix#303 adds `portainerSetup(ctx): { configured, mode, missing }` in
`updates.ts` and recognises Portainer stacks from container labels (`stack: 'foreign'` where today it is `null`). The
Updates check consumes exactly that shape. Until #303 is merged, `checks/updates.ts` carries a private function with the
same name, signature and rule (`PORTAINER_URL`, `PORTAINER_API_KEY`, `PORTAINER_STACK_ID`; `missing` only when some but
not all are set and no webhook); whichever lands second replaces it by the import. Before #303 a Portainer stack often
reads `stack: null`, which yields the `stack_unknown` warning ("Update-Weg unklar; bei Portainer: …") instead of a wrong
red line.

### Web: Systemcheck on Admin → Status

- A section `#systemcheck` replaces the `ServiceLights` section at the top of the Status page: header with the time of
  the check, the counts as pills (icon + text), **Jetzt prüfen**. Below, the six groups in fixed order, lines in the
  catalogue order (stable: nothing reorders or jumps when results arrive; the skeleton has the final row count).
- A line: status pill (icon + word), label, and — unless `ok` — the cause sentence, the fix sentence and actions:
  **Zur Einstellung** (`/admin/settings?setting=KEY`, or `/admin/livetv?tab=settings&setting=KEY` for the livetv
  group), **Details** (`href`), **Anleitung** (docs, opens in a new tab). An `ok` line is one compact row. Targets 44 px.
- `LoginCard` stays below (it has the Authentik repair and the flow table) with `id="login"` as the sign-in lines'
  details target. DiskCard, streams, errors and numbers stay as they are.
- The overview health strip gets a first item **Systemcheck** with "2 Probleme" / "1 Warnung" / "Alles in Ordnung"
  (problems before warnings, plural forms) linking to `/admin/status#systemcheck`.
- Polling: the server list reloads with the page's existing 30 s poll (cached, cheap); browser checks run on mount and
  on Jetzt prüfen only.

### Settings tidy-up

- **Tabs** (`?tab=`, default *Allgemein* without parameter), mapping registry groups:

  | tab | groups |
  |---|---|
  | Allgemein (`general`) | general, health, sessions, + the read-only server values |
  | Anmeldung (`signin`) | signin |
  | Medien (`media`) | media, requests, sources, recommendations |
  | Wiedergabe (`playback`) | playback, downloads |
  | Updates (`updates`) | updates |
  | Benachrichtigungen (`notifications`) | notifications, push |

  The `livetv` group stays in Admin → Live-TV → Einstellungen; the link to it moves next to the tab bar. Drafts are
  page-level, so switching tabs keeps unsaved edits; a tab with unsaved edits shows a dot (+ text for screen readers).
  On a phone the tabs are a scrolling chip row (as in Live-TV).
- **Deep link** `?setting=<KEY>`: picks the tab of the key's group, scrolls the row to the centre, focuses its first
  control (`preventScroll`) and plays a highlight (an overlay fading in and out: opacity only; reduced motion → a static
  outline until the next interaction). An unknown key opens the default tab and does nothing else. The old
  `#settings-<group>` hashes keep working (tab of the group, scroll to the card). Live-TV's SettingsTab honours
  `?setting=` the same way.
- **Search** above the tabs: matches label, key, help and option labels in the current locale, case- and
  diacritic-insensitive, also across the Live-TV settings when installed. While a query is typed, the tab panel is
  replaced by a result list (label, key, tab name); choosing a result clears the query and opens `?setting=KEY`.
  Esc clears. Nothing is edited in the result list (saving stays per card).

### i18n

- New area `syscheck` (`web/src/lib/i18n/locales/<lang>/syscheck.ts`, all 7 locales, identical key order):
  `title`, `intro`, `checkedAt`, `checkNow`, `status.<status>`, `group.<group>`, `line.<id>` (labels, dots replaced by
  `_`), `cause.<code>`, `fix.<code>`, `fix.envLocked`, `action.{toSetting,details,docs,hevc}`, `summary.{problems,warnings,
  allOk}` (plurals), `browser.running`, `rateLimited`.
- Settings tabs and search keys go into the existing `settings` area (`settings.tabs.<tab>`, `settings.search.*`).
- No "Netflix"/"Seerr" in any text (the request service is "Wunsch-Dienst", as in the existing texts); examples use friend.example.com,
  auth.example.com, 192.0.2.x.

## Left to the builder

- Exact wording of every cause/fix sentence (one plain sentence each, German first, then the six translations).
- Icons per group and the exact skeleton shapes; the compact-row layout.
- Whether a group with only `ok` lines shows a one-line "Alles in Ordnung" summary above its rows (it must not collapse
  rows away — heights stay stable).
- Internal helper names inside `checks/*.ts` beyond the interfaces in the plan.
