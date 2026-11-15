# Architecture notes

## Containers and networks

Who talks to whom, and on which Docker network, as `compose.prod.yaml` and its optional overlays set it up. Only the reverse proxy is public; every published port is bound to `127.0.0.1` (`BIND_ADDR`), except the optional SRT range of `livetv`, which you open only when you push feeds. Two pictures: the path of a viewer's request, then secrets, updates and outbound traffic.

```mermaid
---
config:
  flowchart:
    curve: basis
    nodeSpacing: 50
    rankSpacing: 65
    padding: 14
  themeVariables:
    edgeLabelBackground: 'rgba(150,150,150,0.12)'
  themeCSS: '.labelBkg { background-color: rgba(127,127,127,0.12) !important; }'
---
flowchart TB
  accTitle: FriendFlix containers and networks
  accDescr: Viewers reach Nginx Proxy Manager, the only public entry, which routes to web, backend and gateway on the front network. The gateway asks the backend before every media request and streams from the media server, Jellyfin or Plex, on the internal media network. The backend alone reaches Postgres and Redis on the internal db network and the request service on the media network, and signs in through Authentik. With the optional Live TV profile, backend and gateway reach the livetv service on its own internal network; only livetv reaches the providers, and encoders can push SRT feeds into its UDP range.
  V("📺 <b>Viewers</b><br/><small>browser · PWA · Android<br/>Fire TV · Samsung · LG · Windows</small>"):::ext
  NPM("🛡️ <b>Nginx Proxy Manager</b><br/><small>:443 · TLS · the only public entry</small>"):::edge
  AK("🔑 <b>Authentik</b><br/><small>:9000 · own stack</small>"):::svc
  subgraph HOST["Docker host · published ports on 127.0.0.1 only"]
    subgraph FRONT["front network"]
      WEB("🖥️ <b>web</b><br/><small>:3080</small>"):::app
      GW("📡 <b>gateway</b><br/><small>:3082 · front + media + livetv</small>"):::app
      BE("⚙️ <b>backend</b><br/><small>:3081 · front + db + media + livetv<br/>+ updater + egress</small>"):::app
    end
    subgraph MEDIA["media network · internal"]
      S("🎬 <b>Jellyfin or Plex</b><br/><small>bundled Jellyfin :8096 · Plex at PLEX_URL</small>"):::media
      SE("🔔 <b>requests</b><br/><small>:5055 · optional</small>"):::svc
    end
    subgraph DB["db network · internal"]
      PG[("🗄️ <b>postgres</b>")]:::store
      RD[("⚡ <b>redis</b>")]:::store
      BK("💾 <b>backup</b><br/><small>optional · pg_dump</small>"):::store
    end
    subgraph LTV["livetv network · internal · optional profile livetv"]
      LT("📺 <b>livetv</b><br/><small>:8090 · ffmpeg · HLS · rewind cache · SRT</small>"):::app
    end
  end
  PV("📡 <b>Providers · own feeds</b><br/><small>M3U · XMLTV · HLS · TS · SRT</small>"):::ext
  ENC("🎥 <b>Encoders</b><br/><small>OBS · SRT push</small>"):::ext

  V -->|HTTPS| NPM
  NPM -->|"/ · pages"| WEB
  NPM -->|"/media/* · /media/c · /media/l"| GW
  NPM -->|"/api /auth /ws"| BE
  NPM -->|"auth.example.com"| AK
  GW -->|"/internal/authz"| BE
  GW ==>|"video · media token"| S
  BE -->|"media API · tokens stay here"| S
  BE -->|"REST · API key"| SE
  BE -->|SQL| PG
  BE -->|"RESP · password"| RD
  BK -->|pg_dump| PG
  BE -.->|"OIDC · flows API · AUTHENTIK_URL"| AK
  BE -.->|"signed HTTP · what to run"| LT
  GW ==>|"/media/l → live HLS"| LT
  LT -.->|"livetv-egress · fetch"| PV
  ENC -.->|"SRT push · UDP 9000-9009 · not via proxy"| LT
  classDef ext fill:#30363d,stroke:#8b949e,stroke-width:1px,color:#f0f6fc
  classDef edge fill:#2d2a4a,stroke:#9d8cf0,stroke-width:1px,color:#f0f6fc
  classDef app fill:#4a1a24,stroke:#ff4f6d,stroke-width:1px,color:#fff5f7
  classDef store fill:#4a3a14,stroke:#d4a72c,stroke-width:1px,color:#fff8e6
  classDef media fill:#173f30,stroke:#3fb68b,stroke-width:1px,color:#eafff6
  classDef svc fill:#163e4c,stroke:#56b6d6,stroke-width:1px,color:#eaf9ff
  classDef fork fill:#4a1d3c,stroke:#e070b0,stroke-width:1px,stroke-dasharray:4 3,color:#fff0f8
  linkStyle default stroke:#8b949e,stroke-width:1.4px
  linkStyle 6,14 stroke:#3fb68b,stroke-width:3px
  style HOST fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
  style FRONT fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
  style DB fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
  style MEDIA fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
  style LTV fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
```

> 🟥 FriendFlix · 🟩 media server · 🟦 other service · 🟪 reverse proxy · 🟨 data store · ⬛ viewers / outside · dashed frame = network or boundary · thick green line = video stream · dotted = optional / via public URL

```mermaid
---
config:
  flowchart:
    curve: basis
    nodeSpacing: 50
    rankSpacing: 65
    padding: 14
  themeVariables:
    edgeLabelBackground: 'rgba(150,150,150,0.12)'
  themeCSS: '.labelBkg { background-color: rgba(127,127,127,0.12) !important; }'
---
flowchart TB
  accTitle: Secrets, updates and outbound traffic
  accDescr: The bootstrap init container has no network; it writes the generated secrets into three volumes that backend, gateway, updater and livetv mount read-only. The backend signs requests to the updater on the internal updater network. The updater reaches the Docker socket only through the docker-proxy on the internal updater-docker network, and pulls and verifies images over its own egress network. A Portainer stack is redeployed by the backend through the Portainer API or webhook instead. The backend's egress network reaches notification services, data sources and GitHub. The optional monitoring stack scrapes backend and gateway on an internal network.
  subgraph HOST["Docker host"]
    BS("🔐 <b>bootstrap</b><br/><small>one-shot · network none</small>"):::app
    VOL[("🗝️ <b>secrets volumes</b><br/><small>bootstrap · bootstrap-gateway · bootstrap-livetv</small>")]:::store
    BE("⚙️ <b>backend</b>"):::app
    GW("📡 <b>gateway</b>"):::app
    subgraph UPD["updater · updater-docker · internal"]
      UP("🔄 <b>updater</b><br/><small>:7070 · pull · cosign verify · recreate</small>"):::app
      DP("🧱 <b>docker-proxy</b><br/><small>the only container with the socket · ro</small>"):::edge
    end
    SOCK("🐳 <b>Docker socket</b>"):::ext
    subgraph MON["monitoring network · internal · optional"]
      PR("📈 <b>prometheus</b>"):::svc
      GF("📊 <b>grafana</b><br/><small>:3083</small>"):::svc
    end
  end
  REG("📦 <b>GHCR · Sigstore</b><br/><small>images · signatures</small>"):::ext
  PT("🚢 <b>Portainer</b><br/><small>optional</small>"):::svc
  NET("🌐 <b>Internet</b><br/><small>ntfy · Discord · web push<br/>TMDB · OMDb · GitHub releases</small>"):::ext

  BS -->|writes| VOL
  VOL -.->|"read-only · backend, gateway, updater, livetv"| BE
  BE -->|"signed HTTP"| UP
  UP -->|"Docker API"| DP
  DP -->|"read-only mount"| SOCK
  UP -.->|"updater-egress"| REG
  BE -.->|"API or webhook"| PT
  BE -.->|egress| NET
  PR -->|"/metrics"| BE
  PR -->|"/metrics"| GW
  GF --> PR
  classDef ext fill:#30363d,stroke:#8b949e,stroke-width:1px,color:#f0f6fc
  classDef edge fill:#2d2a4a,stroke:#9d8cf0,stroke-width:1px,color:#f0f6fc
  classDef app fill:#4a1a24,stroke:#ff4f6d,stroke-width:1px,color:#fff5f7
  classDef store fill:#4a3a14,stroke:#d4a72c,stroke-width:1px,color:#fff8e6
  classDef media fill:#173f30,stroke:#3fb68b,stroke-width:1px,color:#eafff6
  classDef svc fill:#163e4c,stroke:#56b6d6,stroke-width:1px,color:#eaf9ff
  classDef fork fill:#4a1d3c,stroke:#e070b0,stroke-width:1px,stroke-dasharray:4 3,color:#fff0f8
  linkStyle default stroke:#8b949e,stroke-width:1.4px
  style HOST fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
  style UPD fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
  style MON fill:none,stroke:#8b949e,stroke-width:1px,stroke-dasharray:4 4
```

> 🟥 FriendFlix · 🟦 other service · 🟪 Docker socket proxy · 🟨 data store · ⬛ outside · dashed frame = network or boundary · dotted = optional or outbound

| Service | Networks | Host port (127.0.0.1) | Holds |
|---|---|---|---|
| web | front | 3080 | nothing secret |
| bootstrap (one-shot) | none | none | writes the generated secrets into the `bootstrap` volume, `INTERNAL_SECRET` into `bootstrap-gateway` and the optional livetv service's derived key (never the secret) into `bootstrap-livetv`, then exits; every other service waits for it |
| backend | front, db, media, egress, updater, livetv | 3081 | `APP_ENC_KEY`, `INTERNAL_SECRET` and the database and Redis passwords (`bootstrap` volume, read-only); the settings with the media server key and OIDC client secret (encrypted in Postgres); sessions (cookie `ff_sid`) in Redis; per-user Jellyfin credentials encrypted in Postgres. `egress` is for OIDC discovery, ntfy / Discord / web push, TMDB / OMDb, the GitHub version check and Portainer |
| gateway | front, media, livetv | 3082 | `INTERNAL_SECRET` (`bootstrap-gateway` volume, read-only); pulls the media server URL from the backend; gets the user's media token per request from the backend (cached 5 s), never stores it |
| postgres, redis | db (internal) | none | accounts, profiles, settings, sessions; their passwords come from the `bootstrap` volume |
| backup (optional, profile `backup`) | db (internal) | none | daily `pg_dump` into `BACKUP_PATH`; reads the database password from the `bootstrap` volume |
| updater (on by default; off with `compose.no-updater.yaml`) | updater (internal, with the backend), updater-docker (internal, with docker-proxy), updater-egress | none | `INTERNAL_SECRET` (`bootstrap-gateway` volume, read-only, for the signed requests); the stack directory, read-only; channel and last job in `updater-state`. Pulls from GHCR and verifies with cosign before it recreates anything ([security.md](security.md#updater)) |
| docker-proxy (with the updater) | updater-docker (internal) | none | the Docker socket, read-only, the only container that mounts it; refuses exec, build and everything else the updater does not need |
| livetv (optional, profile `livetv`) | livetv (internal, with backend and gateway), livetv-egress (livetv only) | UDP `LIVETV_SRT_PORTS` (default 9000-9009) on `LIVETV_SRT_BIND` (default `127.0.0.1`); the API on 8090 is never published | its own derived key (`bootstrap-livetv` volume, read-only), never `INTERNAL_SECRET`; provider URLs in memory while a job runs; the disposable `livetv-cache` volume (rewind buffer) |
| jellyfin, requests (request service, profile `bundled`) | media (+egress) | none | media, request data. An existing Jellyfin joins the `friendflix_media` network instead; Plex is not a container here: backend and gateway reach it at `PLEX_URL` ([plex.md](plex.md)) |
| prometheus, grafana (optional, `compose.monitoring.yaml`) | monitoring (internal, joined by backend and gateway); grafana also monitoring-ui | grafana 3083 | metrics (`METRICS_TOKEN` as a compose secret), the provisioned dashboard ([monitoring.md](monitoring.md)) |
| Authentik (`compose.authentik.yaml`) | its own stack: front, ak-db, egress | 9000 | identities |

The browser only ever sees a session cookie and `/media/...` URLs, never a media server token. A Portainer stack is updated through the Portainer API or webhook from the backend instead of the updater (the updater does not change a stack Portainer manages).

### Live TV (optional)

The `livetv` service exists only with the compose profile `livetv` ([livetv.md](livetv.md)). Three components share the work:

- **backend** owns all Live TV state (sources, channels, groups, guide, rights, push feeds), decides who may watch what, admits conversions against the shared budget, mints the watch tokens and tells `livetv` what to run with HMAC-signed requests. It never talks to provider hosts itself.
- **livetv** (Node and jellyfin-ffmpeg) is the only component that fetches provider or own-feed addresses: lists, guides, logos, stream inputs, probes, benchmarks. It passes a stream through, repackages it (sound that a browser cannot play, such as MP2 or AC-3, becomes AAC) or converts it with ffmpeg, keeps the rewind buffer, and listens for pushed SRT feeds. It holds no database and no credentials at rest: the backend sends each decrypted address in the signed start request and `livetv` keeps it in memory only.
- **gateway** serves the live HLS from `livetv` under `/media/l/<token>/…` (the existing `/media` location of the proxy, plus a `location /media/l/` block that keeps the tokens out of the proxy's logs), after the backend has authorised the token (`/internal/authz/live`).

The updater has fixed actions to pull, start, stop and remove the `livetv` service ([security.md](security.md#updater)). Streams are shared: one per channel for all viewers, started on the first viewer and stopped 60 seconds after the last. Hardening and the token model: [security.md](security.md#the-livetv-container).

Media tokens never leave the server: the browser holds a session cookie and plays `/media/...` URLs that only the gateway can resolve. Alternative setups (Plan B, bundled Jellyfin, Authentik in its own stack): [operations.md](operations.md), [setup.md](setup.md).

## Settings

Configuration has four classes (`backend/src/settings/registry.ts`; every key of `config.ts` is in exactly one):

- **bootstrap** – needed before the database can be read: `DATABASE_URL`, `REDIS_URL`, `APP_ENC_KEY`, `INTERNAL_SECRET`. Environment (incl. `_FILE`) first, else the files the `bootstrap` service writes into `/run/friendflix` (`settings/bootstrapFiles.ts`; the URLs are built from `postgres_password` / `redis_password`). A missing file stops the backend with the file name and the fix.
- **setting** – stored in the `settings` table (secrets AES-256-GCM encrypted with `APP_ENC_KEY`, API keys of data sources with their last four characters), edited in *Admin → Settings*. Environment > database > default. Most apply live (`API_COMPRESSION` too: it is read per response); `DOWNLOAD_CREATE_PER_HOUR` needs a restart (`pendingRestart()`). The recommendation engine (`RECO_ENGINE` v1 | v2 | shadow, `RECO_EXPLORE`, `RECO_HALF_LIFE_DAYS`, `POSTPLAY_ENABLED`; group *Recommendations*) applies live: every reader takes `ctx.cfg` per request, and the cache keys of the home page, the "because" rows and the post-play screen carry the engine (docs/discovery.md, German).
- **env-only** – per container or shared with a container that reads env only (`MEDIA_SERVER`, `BACKGROUND_JOBS`, `METRICS_TOKEN`, `GATEWAY_URL`, the database pool limits `DB_*_TIMEOUT_MS`, paths, …), plus the expert tuning of the recommendation engine (`RECO_COEFFS`, `RECO_W_*`); shown read-only.
- **build** – baked into the image (`GIT_SHA`, `APP_VERSION`, …).

`resolveConfig()` (`settings/resolve.ts`) is pure: environment (an empty value counts as unset, `_FILE` and the older names included), then the decrypted rows, then defaults. A row that cannot be decrypted or fails its schema is ignored, listed as invalid and logged by key name. An environment `PUBLIC_URL` with a path or query is reduced to its origin with one warning; a saved one must be an origin.

The store (`settings/store.ts`) keeps one immutable `Config` snapshot; `ctx.cfg` is a getter for it, so code reads the live value on every use. A save validates all values, writes them and bumps `settings_meta.rev` in one transaction, swaps the snapshot and publishes the revision on the Redis channel `ff:settings:rev` (`settings/bus.ts`). Other instances reload from the database when they hear it, or on their 30 s poll of the revision. `onChange(keys, fn)` rebuilds what was built from the config at start: the OIDC client (lazily, on the next sign-in), the media server client, the request service client (`null` while `REQUESTS_URL` or `REQUESTS_API_KEY` is unset), the Web Push keys.

The admin API is `backend/src/routes/adminSettings.ts` (`GET`/`PUT /api/admin/settings`, `POST …/test`, `…/import-env`, `…/generate`). A save runs the probes of the touched groups (`settings/probes.ts`) against the candidate config; refused credentials block, an unreachable service blocks unless `force`. Security rules: [security.md](security.md#settings-and-generated-secrets).

**Gateway pull.** The gateway has no database and no Redis. `gateway/src/remoteConfig.ts` fetches `GET /internal/gateway-config` (`INTERNAL_SECRET`) → `{ rev, upstreamUrl }` at start (every 5 s until it answers), then every 30 s, and at once when an `/internal/authz*` answer carries a newer `x-ff-config-rev`. A failed refresh keeps the last URL. Without a URL (`503 setup_required` from the backend) `/media/*` answers 503 and `/health` stays 200, so the container is not restarted. An environment `JELLYFIN_URL` (the adapter's URL variable) wins and nothing is fetched. `INTERNAL_SECRET` comes from the environment or `_FILE`, else from `/run/friendflix-gateway/internal_secret` (`gateway/src/env.ts`).

## Press play

What happens between the play button and the first picture. Every playlist and every segment passes the gateway, which asks the backend what this session may do (`/internal/authz`: token and limits, cached for 5 seconds) before it clamps height and bitrate and fetches from the media server with the user's token.

```mermaid
---
config:
  sequence:
    mirrorActors: false
    messageMargin: 34
    boxMargin: 10
    noteMargin: 12
---
sequenceDiagram
  accTitle: Press play
  accDescr: Browser asks the backend for playback info, then streams HLS through the gateway, which authorises every request with the backend before talking to the media server, Jellyfin or Plex.
  autonumber
  box rgba(139,148,158,0.10) Viewer
    actor browser as 📺 Browser
    participant web as 🖥️ web
  end
  box rgba(255,79,109,0.07) FriendFlix
    participant backend as ⚙️ backend
    participant gateway as 📡 gateway
  end
  box rgba(63,182,139,0.09) Media server
    participant media as 🎬 Jellyfin or Plex
  end
  browser->>web: GET /watch/:id
  web-->>browser: app shell
  browser->>+backend: POST /api/playback/info · ff_sid
  Note over backend: session · profile · role limits · conversion slot
  backend->>+media: playback info · media token
  media-->>-backend: streams
  backend-->>-browser: HLS URL /media/… (no token)
  loop playlist + every segment
    browser->>+gateway: GET /media/….m3u8 · ff_sid
    gateway->>+backend: POST /internal/authz · INTERNAL_SECRET
    backend-->>-gateway: token + limits (cached 5 s)
    Note over gateway: allowlist · clamp height / bitrate
    gateway->>media: GET HLS · media token
    media-->>gateway: playlist / segment
    gateway-->>-browser: stream
  end
  browser->>backend: POST /api/playback/start · progress · stop
  backend->>media: report position
```

## Media server seam

FriendFlix talks to its media server through one neutral interface. There are two implementations, **Jellyfin** (`backend/src/jellyfin`, `gateway/src/upstream/jellyfin.ts`, the default) and **Plex** (`backend/src/plex`, `gateway/src/upstream/plex.ts`, [plex.md](plex.md)); the same images carry both and `MEDIA_SERVER` picks one at start. Nothing outside an adapter folder imports it except the seam index (`backend/src/media/index.ts`, `backend/src/media/setup.ts`, `gateway/src/upstream/index.ts`); `backend/test/media-seam.test.ts` and `gateway/test/upstream.test.ts` enforce that. A further server is added mostly by **adding** files instead of editing shared ones.

How the pieces line up: backend routes and jobs only know the `MediaServer` interface, the gateway core only the `Upstream` adapter; each media server kind provides one of each, and `MEDIA_SERVER` picks them.

```mermaid
---
config:
  flowchart:
    curve: basis
    nodeSpacing: 50
    rankSpacing: 65
    padding: 14
  themeVariables:
    edgeLabelBackground: 'rgba(150,150,150,0.12)'
  themeCSS: '.labelBkg { background-color: rgba(127,127,127,0.12) !important; }'
---
flowchart TB
  accTitle: The media server seam
  accDescr: Backend routes call the MediaServer interface and the gateway core calls the Upstream adapter interface. Jellyfin and Plex each provide one implementation of each, selected by MEDIA_SERVER; a further server would add its own pair.
  subgraph BEL["backend"]
    RT("🧭 <b>routes + jobs</b><br/><small>ctx.jf</small>"):::app
    IF("📐 <b>MediaServer</b><br/><small>media/types.ts · createMediaServer()</small>"):::app
    JFI("🧩 <b>JellyfinService</b><br/><small>backend/src/jellyfin/*<br/>admin key + user tokens</small>"):::app
    PXI("🧩 <b>PlexMediaServer</b><br/><small>backend/src/plex/*<br/>one server token</small>"):::app
    NI("➕ <b>another server</b><br/><small>backend/src/&lt;kind&gt;/*</small>"):::fork
  end
  subgraph GWL["gateway"]
    CORE("📡 <b>gateway core</b><br/><small>authz · clamp · sanitise</small>"):::app
    UP("📐 <b>Upstream</b><br/><small>upstream/types.ts · selectUpstream()</small>"):::app
    JFU("🔌 <b>jellyfinUpstream</b><br/><small>upstream/jellyfin.ts<br/>user token</small>"):::app
    PXU("🔌 <b>plexUpstream</b><br/><small>upstream/plex.ts<br/>server token · authorize()</small>"):::app
    NU("➕ <b>another adapter</b><br/><small>upstream/&lt;kind&gt;.ts</small>"):::fork
  end
  RT -->|calls| IF
  CORE -->|uses| UP
  IF -.->|"implements"| JFI
  IF -.->|"implements"| PXI
  IF -.->|"implements"| NI
  UP -.->|"implements"| JFU
  UP -.->|"implements"| PXU
  UP -.->|"implements"| NU
  JFI -->|API| JF
  JFU ==>|"video"| JF
  PXI -->|API| PX
  PXU ==>|"video"| PX
  JF("🎬 <b>Jellyfin</b><br/><small>MEDIA_SERVER=jellyfin</small>"):::media
  PX("🎬 <b>Plex</b><br/><small>MEDIA_SERVER=plex</small>"):::media
  classDef ext fill:#30363d,stroke:#8b949e,stroke-width:1px,color:#f0f6fc
  classDef edge fill:#2d2a4a,stroke:#9d8cf0,stroke-width:1px,color:#f0f6fc
  classDef app fill:#4a1a24,stroke:#ff4f6d,stroke-width:1px,color:#fff5f7
  classDef store fill:#4a3a14,stroke:#d4a72c,stroke-width:1px,color:#fff8e6
  classDef media fill:#173f30,stroke:#3fb68b,stroke-width:1px,color:#eafff6
  classDef svc fill:#163e4c,stroke:#56b6d6,stroke-width:1px,color:#eaf9ff
  classDef fork fill:#4a1d3c,stroke:#e070b0,stroke-width:1px,stroke-dasharray:4 3,color:#fff0f8
  linkStyle default stroke:#8b949e,stroke-width:1.4px
  linkStyle 9,11 stroke:#3fb68b,stroke-width:3px
  style BEL fill:none,stroke:#ff4f6d,stroke-width:1px,stroke-dasharray:4 4
  style GWL fill:none,stroke:#ff4f6d,stroke-width:1px,stroke-dasharray:4 4
```

> 🟥 FriendFlix · 🟩 media server · 🟦 other service · 🟪 reverse proxy · 🟨 data store · ⬛ viewers / outside · 🟫 dashed pink = room for another media server · dashed frame = network or boundary · thick line = video stream · dotted = optional / via public URL

### Backend

| File | Role |
|---|---|
| `backend/src/media/types.ts` | The `MediaServer` interface, its `admin` sub-interface (`MediaAdmin`), the normalized DTOs (`ItemDto`, `PlaybackDto`, `TrickplayDto`, `DownloadSourceDto`, …), `MediaCapabilities` and the `MediaError` base class. Nothing in here knows Jellyfin. |
| `backend/src/media/index.ts` | `MEDIA_SERVERS` (the accepted `MEDIA_SERVER` values) and the one factory `createMediaServer()`. The only shared file that imports an implementation. |
| `backend/src/media/setup.ts` | `MediaSetupProvider` and `MEDIA_SETUP` (Block 25): per kind the registry keys of the wizard's media step, the gateway's URL key, the `media` settings probe and, optionally, `auto` (create the server's API key from an administrator's sign-in). |
| `backend/src/jellyfin/*` | `JellyfinService implements MediaServer` (`service.ts`), the HTTP client (`client.ts`), Jellyfin JSON → DTO mapping (`dto.ts`), the setup provider `jellyfinSetup` (`setup.ts`). `JellyfinError extends MediaError`. |
| `backend/src/plex/*` | `PlexMediaServer implements MediaServer` (`service.ts`), its HTTP client (`client.ts`), its own tables and version table (`migrations.ts`), its setup provider (`setup.ts`). Details: [plex.md](plex.md). |

Routes and jobs use `ctx.jf` (the name is kept from the Jellyfin-only days; its type is `MediaServer`). They never build server paths themselves. A test (`backend/test/media-seam.test.ts`, "seam boundary") fails when a file outside `jellyfin/`, `media/index.ts` and `media/setup.ts` imports from `jellyfin/`.

What the interface covers, grouped:

- **Credentials and raw media:** `mediaAuth(user)` (token + device id for the gateway, Chromecast and Plan B), `planBAuthHeader`, `mediaFetch(user, path)` (playlists and segments from a `PlaybackDto` / `DownloadSourceDto` / `clipTranscode`; only server-relative paths, absolute and protocol-relative URLs are refused), `clipTranscode(user, info, limits)` (async; preview clips and the playback health check), `stopEncoding`, `subtitleStream(user, item, mediaSource, index, 'vtt')`.
- **Browse:** `views`, `items(ItemQuery)`, `item`, `resume`, `history`, `nextUp`, `nextEpisode`, `seasons`, `episodes`, `firstEpisode`, `upcoming`, `similar`, `lastWatched`, `unplayedIds`, `collections`, `genres`, `studios`, `facets`, `extras`, `trailers`, `trailer`, `people`, `searchPeople`, `person`, `tracks`, `segments`, `addedItems`, `itemTraits`, `continuingSeries`, `premieringEpisodes`, `availableEpisodes`, `seasonEpisodeIds`; optional (Block 17): `chapters?` (chapter marks, `ChapterDto` `{start, name, image?}`) and `credits?` (`ItemCreditsDto`: people with `type` 'Actor' / 'GuestStar' / 'Director' / 'Writer' / 'Creator' … and the character in `role`, plus studios and tags); optional (Block 21): `itemAbout?` (`ItemAboutDto`: tagline, original title, countries, studios, tags, `providerIds` `{imdb, tmdb, tvdb}` as raw strings, community + critic rating; `MediaError(404)` when not visible) and `itemCollections?` (`MediaCollection[]` `{id, name, parts: [{item, tmdbId?}]}`; name and parts come from the viewer's own identity in release order, parts the viewer cannot see are omitted, never reported as missing; `[]` = none). Jellyfin builds a library-wide box set membership index with the admin key (kv `jf:boxsets:v1`, 1 h, single-flight, 8 box sets at a time; a box set whose call fails is skipped) and then asks per matching box set with the viewer token. Optional (1.1, post-play screen): `seriesStatus?(user, seriesId)` (`'continuing' | 'ended' | null`, as the viewer sees the series; `null` = the server does not know, `MediaError(404)` when not visible). Absent or `null`, the post-play screen only trusts a positive "continuing" from `libraryContinuingSeriesIds` and never calls a series finished (Jellyfin: `Status` `Continuing` / `Ended`).
- **Capabilities:** `libraryFeatures` (R1) is optional like `chapters`. `chapters` is optional on `MediaCapabilities` (an implementation written before Block 17 compiles unchanged and counts as `false`); the web treats a missing flag as supported, like every other flag.
- **User data:** `setFavorite`, `setPlayed`, `setUserData`, `touchUserData`, `forgetItems`, `userDataVersion`.
- **Playback:** `playbackInfo`, `playMeta` (resume position + trickplay), optional `preparePlayback`, `downloadSource`, `report({ event, itemId, mediaSourceId, playSessionId, positionTicks, paused, … })`.
- **Admin-key lookups:** `searchSubtitles`, `downloadSubtitle`, `findByTmdb`, `seriesHasEpisode`, `libraryStreams` (language index); optional (Block 17): `libraryMediaTraits?(type, start, limit)` (quality index; Jellyfin pages with `sortBy=SortName,Id` so a library that changes during the scan neither skips nor repeats titles) and `libraryContinuingSeriesIds?(start, limit)` (ids of ALL continuing series, library-wide, for the fresh label "Staffelfinale"; without it the backend falls back to the viewer's `continuingSeries()` and caches that per viewer). `mediaTraits?(user, id)` (quality chips) is the viewer-level counterpart. Optional (Block 22, admin care): `libraryHygiene?(type, { start, limit, savedSince? })` (`HygieneFacts[]`: overview / poster / backdrop / year flags, provider ids, runtime, virtual flag and per version container, bitrate, size and video / audio / subtitle stream facts; never a path, URL or protocol; Jellyfin pages with `sortBy=SortName,Id` and maps `savedSince` to `minDateLastSaved`; absent = the hygiene page shows "not supported") and `refreshMetadata?(id)` (full metadata + image refresh without replacing existing data, `MediaError(404)` for an unknown id; absent = no refresh button). Optional (R1, recommendation index): `libraryFeatures?(start, limit, { ids?, savedSince? })` (`ItemFeatures[]` of films and series only: genres, tags, studios, top-8 people ids, year, runtime, ratings, countries, collection id, series status, overview, tagline; episodes roll up into their series, never a path, URL, token or user data; Jellyfin pages with `sortBy=SortName,Id`, reuses the `credits()` / `itemAbout()` mappers and the box set index; absent or `capabilities.libraryFeatures` false = the index job stays idle). Optional (1.1, cross-user aggregates): `libraryRoots?(ids)` (admin key, library-wide: the film or series behind each id, an episode -> its series; unknown ids are absent; the co-occurrence and transition tables use it instead of a viewer's token; absent = only the hygiene scan's episode rows map). See [discovery.md](discovery.md#empfehlungs-index-item_features-r1).
- **`admin`:** `createIdentity`, `deleteIdentity`, `applyPolicy(id, { template, disabled, hidden, parental })`, `setDisabled`, `libraries`, `ping`, `externalSessions` ("now playing" from other apps); optional (Block 22): `transcodeSessions?()` (`ServerSession[]`: every playing session, FriendFlix devices `ff-<id>` included, with play method, mapped `TranscodeReason`s, video / audio codec, hardware flag, bitrate, progress; never a token, URL or path; absent = the admin's active streams show only what FriendFlix knows).

Conventions: item ids are 32 lower-case hex characters (an implementation with other ids encodes them), item types and sort keys use the existing vocabulary (`Movie`, `Series`, `Episode`, `BoxSet`; `SortName`, `DateCreated`, `PremiereDate`, …), positions are in 100 ns ticks. Upstream failures throw a `MediaError` subclass with an HTTP-like `status`; `routes/_shared.ts` `wrap()` and the routes map it (listed statuses → 404, otherwise 502 `{error:'jellyfin'}` – the error name stays for API compatibility).

**Capabilities.** `ctx.jf.capabilities` says what the server can do: supported skip-segment types, trickplay, upcoming episodes, remote subtitle search, webhooks, a change feed, Plan B and chapters. The backend sends them once in `/api/me` (`server: { kind, capabilities }`, also `GET /api/server`); the web keeps them in `web/src/lib/capabilities.ts` (default: everything supported) and hides the skip buttons / timeline marks of unsupported segment types, the subtitle search and the calendar link. Jellyfin reports everything, so nothing changes visibly. `capabilities.requestUsers` (backend only, not in `/api/me`) picks how accounts become request service users for wishes: `'jellyfin-import'` (Jellyfin) or `'local'` (default when absent: a local request service user per account, see [integrations.md](integrations.md#request-service)).

**Configuration.** `MEDIA_SERVER` (default `jellyfin`; `jellyfin` or `plex`, the values of `MEDIA_SERVERS`) selects the implementation in the backend and in the gateway. Each kind declares its config fields (`MEDIA_FIELDS`) and its settings (`mediaSettings()`: `JELLYFIN_URL`, `JELLYFIN_ADMIN_API_KEY` for Jellyfin, required once setup is complete) in `media/index.ts`; `mediaConfigProblems()` in `media/index.ts` can refuse settings a kind cannot work with at startup.

**Setup provider (Block 25).** `MEDIA_SETUP[kind]` (`backend/src/media/setup.ts`) is what the setup wizard and the `media` settings probe know about a kind:

```ts
interface MediaSetupProvider {
  kind: MediaServerKind;
  keys: readonly string[];   // registry keys, in field order
  urlKey: string;            // the gateway upstream (mediaUrlKey)
  probe(values, { fetchImpl }): Promise<ProbeResult>;
  auto?: {
    fields: readonly ('url' | 'username' | 'password')[];
    run(input, { fetchImpl, appVersion }): Promise<Record<string, string>>;
    revoke?(values, { fetchImpl }): Promise<void>;   // best effort, when the save refused the values
  };
}
```

- `GET /api/setup/state` sends `media: { keys, auto }` (`auto` = the provider's `auto.fields` or `null`); the web renders the media step from it, with labels from `settings.keys.<KEY>`. A kind without an entry gets manual fields from `mediaSettings()` (the settings its kind requires), `auto: null`, and its `media` probe answers a non-blocking warning (`not_tested`); `mediaUrlKey()` then falls back to the first `url` setting. A fork (Plex) adds `MEDIA_SETUP.plex` (URL + token, manual, probe) and its i18n strings, no web code.
- The `media` probe calls `provider.probe` with the candidate values and the probe runner's fetch (no redirects, 5 s deadline). Jellyfin: `GET /Auth/Keys` with the key (2xx only for an administrator's key, 401/403 → `not_admin`).
- `POST /api/setup/media/auto { url, username, password }` (setup session + `x-ff-setup-csrf`, 10 per minute) checks the URL (http/https, no user info) before any request, runs `auto.run` and saves its values with the same probes and audit as `PUT /api/setup/settings`, limited to the provider's keys. One run at a time (kv lock `setup:media:auto`, else `409 busy`). A URL key from the environment must match (`invalid/env_locked`) and env keys are not saved. When the save refuses the values (`invalid_settings` / `probe_failed`), `auto.revoke` deletes the new credential (Jellyfin: `DELETE /Auth/Keys/<key>` with the key itself, verified on 12.2.0); never when the save throws, since it may throw after the commit. Answers `{ ok: true }`, or `{ ok: false, code, detail? }` with `code` one of `wizard_pending`, `unauthorized`, `not_admin`, `unreachable`, `unexpected`.
- Jellyfin's `auto` (`jellyfin/setup.ts`): `GET /System/Info/Public` (`StartupWizardCompleted` must be true, else `wizard_pending`, before any sign-in), `POST /Users/AuthenticateByName` with `MediaBrowser Client="FriendFlix", Device="Setup", DeviceId="ff-setup-<16 hex>", Version="<APP_VERSION or dev>"` (401 → `unauthorized`; `User.Policy.IsAdministrator` must be true, else `not_admin`), `GET /Auth/Keys`, `POST /Auth/Keys?app=FriendFlix`, `GET /Auth/Keys` again: the newest `FriendFlix` key by `DateCreated` that was not in the first list (compared with Jellyfin's list, not this backend's clock). `POST /Sessions/Logout` with the session token runs in a `finally` block, whatever happened. Every call has a 5 s deadline and never follows a redirect; network errors and timeouts are `unreachable`.
- The password is used only in memory for the sign-in: it is never stored, logged or put into an error (`MediaSetupError` carries a code only), and `/api/setup/*` bodies are kept out of error logs.
- Only types flow back from `media/setup.ts` and `jellyfin/setup.ts` to `media/index.ts` (which imports them), so there is no import cycle; the shared probe helpers live in the leaf module `settings/probeKit.ts`.
- A media server's own change feed (`start()`) waits until the app is operational: `createLiveCtx({ operational })` defers it during setup mode, and `server.ts` calls `live.syncMedia()` every 5 s, which starts it once.

**Player depth (Block 17).** `GET /api/items/:id/castinfo` ("Besetzung & Infos": cast with characters, an episode's guest stars = everyone credited on the episode who is not a series regular, directors / writers / creators, studios, genres, tags, year, rating) uses `credits()`; without it the route falls back to `people()` + `itemTraits()` tags. `GET /api/items/:id/chapters` answers `{supported, chapters}`; `supported:false` when `capabilities.chapters` is off or `chapters()` is absent (the player then shows no marks and no "Szenen" panel). Both check visibility with the viewer's identity on every call (`item()`), cache the server data 5 min per server identity, and answer 404 for invisible items. Jellyfin: `/Items?ids=…&fields=People,Studios,Tags` and `fields=Chapters`; chapter stills are `/media/Items/<id>/Images/Chapter/<index>?tag=…` (the web falls back to a trickplay frame when a still does not load). A Plex fork maps its chapters (`Chapter` elements of the media part) and roles (`Role` with `role` = character) onto the same DTOs.

**Detail page and data sources (Block 21).** `GET /api/items/:id/about` returns the detail page's extras in one call: `{ ratings, tagline, releaseDate, countries, links, collection, … }`. It first checks visibility as the viewer (404 for hidden items, before any external call), then merges what the media server offers through the optional `itemAbout()` (provider ids, tagline, studio, country, original title, community and critic rating) and `itemCollections()` (the collection of a film with its parts) with TMDB and OMDb data. Servers without these hooks still answer with the friends' rating only. External calls live in `backend/src/sources/` (`fetch.ts`: 3 s limit, kv cache 7 d / failures 1 h, OMDb budget 900 per day, 401 pause for 1 h; keys are read through `getSourceKey`, where an env or `_FILE` key wins over the encrypted one in the `settings` table). Admin endpoints: `GET /api/admin/sources` and `GET /api/admin/sources/:name` (status: set, origin, last four characters, OMDb use), `PUT /api/admin/sources/:name` (save, 409 when the key comes from a file), `DELETE /api/admin/sources/:name`, `POST /api/admin/sources/:name/test` (10 per minute; tests the typed key, else the active one). `name` is `tmdb` or `omdb`; no response ever contains a key.

**Admin care (Block 22).** All admin-only (admin role on the owner profile). `GET /api/admin/health` returns the health snapshot `{ at, services, disks, errors, issues, worst }` built every 60 s by a background job and kept in kv (`?refresh=1` rebuilds and waits, 6 per minute per session); `GET /api/admin/health/banner` returns the issues not dismissed by this admin (`{ issues, worst }`) and `POST /api/admin/health/dismiss` `{ id, fp }` hides one until its fingerprint (id, level, reason) changes (`health_dismissals`, pruned after 30 days). `GET /api/admin/streams` lists running streams (portal and other apps; play method, reasons, codecs via the optional `transcodeSessions`) plus failed playbacks of 24 h; `GET /api/admin/errors?source=&hours=` the aggregated error log (server 5xx and job failures in Redis for 7 days, client and playback reports in process memory for 24 h only). `GET /api/admin/hygiene/summary`, `GET /api/admin/hygiene?category&issue&type&seriesId&q&sort&dir&limit&offset`, `POST`/`DELETE /api/admin/hygiene/ignore` `{ itemId, code }`, `POST /api/admin/hygiene/:itemId/refresh` (optional `refreshMetadata`; 501 without it) and `POST /api/admin/hygiene/scan` read and steer the library hygiene table `hygiene_items`, filled by a background scan through the optional `libraryHygiene`. `GET /api/admin/usage?days=7|30|90&sort&dir` and `GET /api/admin/usage/:userId?days=` return per-account aggregates (`play_seconds`, `play_daily`; no titles, no raw device ids). None of these responses carries a media server URL, path or token.

**Aggregated home (Block 20).** `GET /api/home` serves the first screen of the home page in one request: `{ parts: { hero, resume, nextup, leaving, recs, because, hubs, themed }, failed: string[] }` (`backend/src/routes/home.ts`). `recs` carries the friends' recommendations plus `friends` (ratings of friends), `because` the main row plus `more` (the extra rows). Every part runs the same internal function as its own endpoint (`/api/library/resume`, `nextup`, `leaving`, `/api/recommendations`, `friends-rated`, `because`, `because-more`, `/api/hubs`, `/api/lists/themed`; random pick of `/api/library/items` for the billboard) as the viewer's media-server user, so role libraries, age caps and kids profiles apply exactly as there; kids profiles get empty social parts (`recs`). A failing part is answered empty and named in `failed` (never a 500, and such a response is not cached); the web then loads just that part through the old endpoint, which all stay. Cached in the kv per profile and `userDataVersion` for 60 s (`home:<profileId>:<version>`), so a played / favorite / progress write shows at once. The web (`+page.svelte`, `swrLoad(homeCache, …)`) starts the idle and scroll rows after the first screen; the first visible row's images get `fetchpriority="high"`.

### Hooks for servers that work differently

All optional or no-ops for Jellyfin, so nothing changes there:

| Hook | Where it runs | Purpose (e.g. Plex) |
|---|---|---|
| `preparePlayback?(user, info, opts)` | `POST /api/playback/info` and the cast start, right after `playbackInfo()`, before the client loads the master playlist | transcode decision plus per-account audio/subtitle selection under a lock; returns the `PlaybackDto` with session-bound URLs. Doing it inside `playbackInfo()` is equally fine. `clipTranscode()` is async for the same reason. |
| `PlaybackDto.transcodeReason?` | `POST /api/playback/info` (body `reasonHint: 'network' \| 'manual'` says why the viewer lowered `maxBitrate`) | why the session is transcoded, undefined for direct play: `container`, `videoCodec`, `audioCodec`, `audioTrack`, `subtitles`, `height` from the server, `remoteCap` / `roleCap` / `manual` / `network` from the bitrate cap. Server reasons outrank caps; our caps outrank the server's bitrate reasons. Jellyfin: read from `TranscodeReasons=` in the TranscodingUrl, unknown values are `other`. The transcode URL also carries explicit `VideoBitrate` / `AudioBitrate=192000` / `MaxHeight` for the cap's rung, so a high-bitrate source audio track cannot starve the video. `roleMaxBitrate` is the effective ceiling (lowered to the remote cap outside the home networks). |
| `capabilities.playbackPrefetch?` | `GET /api/me` → web `prefetchPlayback()` (Block 20) | `false` when `POST /api/playback/info` starts the server's transcode (Plex: `preparePlayback()` runs decision + start): the web then never asks for playback info on hover / focus of a play button, it only warms the player code and hls.js, because every prefetch would start a stream and take a stream slot. Absent = `true`. Jellyfin: `true` (PlaybackInfo starts nothing). |
| `subtitleStream()` + `capabilities.subtitleExtract` | `GET /api/items/:id/subtitle/:ms/:index/stream.vtt` (visibility-checked); on Chromecast `GET /api/cast/subtitle/<account>/<castId>/<exp>/<sig>/<id>/<ms>/<index>/stream.vtt` | servers that cannot deliver WebVTT: the implementation extracts/converts and puts this URL into `PlaybackDto.subtitles[].url`. The cast session turns it into a signed URL (HMAC from `APP_ENC_KEY`, no media token in it) that lives and dies with the cast token and its item/media source, re-checks account, role, profile, device and visibility, and is served with open CORS for the receiver (`cast.ts` `castSubtitlePath` / `resolveCastSubtitle`). Jellyfin: `false`, subtitles keep their gateway path (also on Chromecast). |
| `MediaDeps.db` | `createMediaServer({ cfg, kv, db, encKey })` in `server.ts` | the backend's shared Postgres pool for implementations that keep state (id maps, sync cursors) instead of opening their own. Jellyfin ignores it. |
| `capabilities.planB` | `GET /internal/authz-nginx` | `false`: the endpoint answers 501 `{error:'plan_b_unsupported', kind}` (logged once, `friendflix_authz_nginx_total{result="unsupported"}`) before touching the session or `planBAuthHeader()`; nginx then fails the request. Plan B has no backend setting (it is the NPM `plan-b-auth-request.conf` block plus `compose.planb.yaml`), so this is where it is refused. Jellyfin: `true`. |
| `webhookEvents?(body)` | `POST /internal/webhook/<kind>` (Jellyfin: `/internal/webhook/jellyfin`, path unchanged) | translates the server's webhook into neutral `MediaEvent`s (`itemAdded`, `itemRemoved`, `playback`). |
| `start?(runtime)` / `stop?()` | `server.ts` after listen / on SIGTERM | change feeds (websocket, sync jobs) that call `runtime.dispatch(event)`. |

Every event, whatever its source, goes through `media/events.ts` `dispatchMediaEvent()`: reminders ("Erinnere mich"), "now playing" entries and user-data caches, then `bus` event `media.event` for other features. `report()` takes a neutral body; the Jellyfin field mapping (`/Sessions/Playing…`) lives in the Jellyfin implementation.

### Gateway

`gateway/src/upstream/types.ts` defines the `Upstream` adapter: the path allowlists (cookie and Chromecast), the direct-stream and image patterns, the query parameters that carry credentials or caps, and `authHeaders(credentials)`. `gateway/src/upstream/jellyfin.ts` is the Jellyfin adapter, `gateway/src/upstream/plex.ts` the Plex adapter (it uses the hooks below), `gateway/src/upstream/index.ts` holds the registry and `selectUpstream(MEDIA_SERVER)`, which refuses unknown values. `createGateway({ upstream, upstreamUrl, … })` takes the adapter (`upstreamUrl` may be a getter: the live URL from `remoteConfig`); everything else (authorization against the backend, clamping, cast scope checks, playlist sanitising with the adapter's credential parameters, downloads) stays generic. Optional adapter hooks (all absent for Jellyfin):

- `authorize(ctx)` – per-request access check after the allowlist / session / direct-stream checks, for servers the gateway reaches with one server-wide token. `ctx.checkItem(itemId, kind)` asks the backend `POST /internal/authz/item {sid, itemId, kind}` (internal secret; answers `{allow}` from the active profile's visibility via `ctx.jf.item`, 401 without a usable session; memoised 5 s on both sides, dropped on a profile switch). On the Chromecast route it compares with the token's item scope. `false` → 403, a throw → 503.
- `rewrite(path, query)` – maps the public `/media/…` shape (what the web and the DTOs use) to the upstream request; the result must stay server-relative (else 502). The shared `test-vectors/media-paths.json` results are unchanged for the Jellyfin adapter.
- `validateConfig(env)` – startup check of the gateway environment (`server.ts` → `checkUpstreamConfig()`); a non-empty list stops the gateway with `MEDIA_SERVER=<kind>: invalid gateway configuration: …`, like the backend's config validation.
- `gatewayKeys`, `bind(runtime)`, `wrapFetch(fetch)` – for servers the gateway reaches with one server-wide credential (Plex: `PLEX_TOKEN`). `gatewayKeys` names settings besides the URL: one the gateway env does not pin comes from the backend's `/internal/gateway-config` (`upstreamAuth`, behind the internal secret, never logged; `/media` answers 503 until it is there; backend side: `MediaSetupProvider.gatewayKeys`). `bind()` hands the adapter the resolved internal secret and those values; `wrapFetch()` lets it make upstream error answers opaque. The backend's `PlaybackOptions.after` (the server-resolved predecessor of a queued cast episode) lets a server that counts streams itself allow exactly that one overlap.
- `playlist(body, ctx)` – rewrites HLS playlist bodies (`*.m3u8`, status 200) on the cookie path and the cast path (`ctx`: `path`, `query`, `requestPath`, `cast`), e.g. to drop a credential the server writes into segment URIs. On the cast path the gateway's own sanitising runs afterwards. With the hook those playlists are buffered (no Range / conditional requests, no upstream `etag`); a throw answers 502. Without it (Jellyfin) cookie playlists stream through untouched.

### Adding an implementation

New files only:

1. `backend/src/<kind>/…` with a class implementing `MediaServer` (and its errors extending `MediaError`), reporting honest `capabilities`, plus whichever hooks it needs.
2. `gateway/src/upstream/<kind>.ts` with an `Upstream` adapter (and `urlEnv` for its base URL).
3. Tests (the seam tests list the registered kinds and check the folder boundary) and a compose override (e.g. `compose.<kind>.yaml`, like `compose.plex.yaml`) that sets `MEDIA_SERVER=<kind>`.

Shared lines to touch:

- `backend/src/media/index.ts`: add the kind to `MEDIA_SERVERS` and one line to `factories` (plus its import; the factory gets `cfg`, `kv`, the shared `db` pool and `encKey`); refuse unsupported settings in `mediaConfigProblems()` if needed.
- `backend/src/media/index.ts` again: the kind's fields in `MEDIA_FIELDS` (`config.ts` spreads them into its schema) and its entries in `mediaSettings()` (`runRequired` for its kind).
- `gateway/src/upstream/index.ts`: one entry in `UPSTREAMS` (plus its import).
- Database tables of the implementation: own prefix and, like Plex (`backend/src/plex/migrations.ts`, `plex_schema_migrations`), its own version table run by the implementation itself, so other kinds never run them.
- Texts that name the server: `web/src/lib/i18n/locales/<lang>/serverText.ts` (`serverText.<kind>.<key>` wins over `<key>` while `/api/me` reports that kind).

Everything else (routes, jobs, the web, the gateway core) works through the interface.

## Web UI kit and admin shell

Shared components live in `web/src/lib/ui` (toasts, confirm dialog, data table, buttons, form fields, pills, progress, copy field, `runAction`); the admin frame (sidebar, phone list, badges, overview data) lives in `web/src/lib/admin`. Usage and rules: [ui-kit.md](ui-kit.md).
