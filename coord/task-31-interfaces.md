# Task 31 interfaces (for Tasks 32, 33, 41, 42)

From the implementer report; fix round added: convbudget.setLiveSource (streams.ts registers liveConversions at load), join marker ltv:join:<id> (15 s), 'unknown' → 502 channel_unreachable, streamKeyFor 2 s negative cache. Merged on claude/livetv-local 5b621798.

## Interfaces for Tasks 32, 33, 41 and 42

### `backend/src/livetv/streams.ts`
```ts
export const START_LOCK_TTL_S = 20, FIRST_SEGMENT_MS = 15_000, POLL_MS = 500, STOP_AFTER_MS = 60_000, LIST_CACHE_MS = 5_000;
export function expectedMode(ch: { streamKind: StreamKind; probe: ProbeRec | null }, now: number): Mode;
export interface RunningChannel { id: string; number: number | null; name: string; logo: string | null; now?: Prog }
export type WatchError =
  | { status: 503; error: 'live_full'; running: RunningChannel[] }
  | { status: 503; error: 'provider_limit'; max: number; running: RunningChannel[] }
  | { status: 502; error: 'channel_unreachable' }
  | { status: 409; error: 'not_receiving' };
export interface Watcher { userId: string; deviceId: string; role: string }
export async function startOrJoin(ctx: Ctx, who: Watcher, ch: EffectiveChannel, profile: LivetvProfile): Promise<{ streamKey: string; mode: Mode } | WatchError>;
export async function runningList(ctx: Ctx, user: LivetvUser, profile: LivetvProfile, list?: readonly StreamView[] | null): Promise<RunningChannel[]>;
export async function streamKeyFor(ctx: Ctx, channelId: string): Promise<string | null>;
export async function viewerCounts(ctx: Ctx, o?: { exceptHash?: string }): Promise<Map<string, number>>;
export async function liveConversions(ctx: Ctx): Promise<ConvEntry[]>;
export function invalidateLiveConversions(): void;
export async function livetvTick(ctx: Ctx): Promise<void>;
```

**Deviation for Task 32:** `who` also carries `role`. The brief says `{ userId; deviceId }`, but `startOrJoin` needs the role to build `runningList` for refusals.

How it behaves:
- **`startOrJoin`**
  - It always reads `GET /v1/streams` fresh.
  - If the channel has a stream that is not `failed`, the watch joins it and never touches the budget. A joined stream that has no segment yet is waited for (up to 15 s).
  - Otherwise it takes the start lock with setnx `ltv:start:<id>` (20 s). The lock is renewed while it waits for the first segment. Other watchers poll every 500 ms (for up to 25 s) and join the stream once it appears. If the starter gave up, they take the lock and start it themselves.
  - Order of checks under the lock:
    1. Push feed: `GET /v1/ingest` must say `receiving`, else 409.
    2. The source's `max_streams`, counted over the listed streams of that source that are not failed, else 503 `provider_limit`.
    3. Expected mode `transcode`: `admitConversion({ kind: 'live', userId, hint: 'live:<id>', label })`. Refused (or `unknown`) gives 503 `live_full` and the event `start_refused_full`. Admitted gives `bindConvGrant(ctx, 'live:<id>', 'live:<id>')` at once (F8).
    4. `POST /v1/streams` with `StartBody`. Failure: `dropConvGrant`, event `start_failed` with livetv's code as `reason`, then 502.
    5. Wait up to 15 s for `lastSegmentAt`. Failure: `DELETE`, `dropConvGrant`, event `start_failed` with `reason: 'no_segment'`, then 502.
    6. The mode is read only once `lastSegmentAt` is set. If it is not `transcode`, the grant is dropped.
- **The `GET /v1/streams` cache:** one cache per ctx, shared by `liveConversions` (5 s, read for at most 800 ms because it runs under the budget lock; on timeout the last list of the past minute is used) and `streamKeyFor` (5 s; a channel missing from the cache triggers one fresh read). `invalidateLiveConversions()` drops it. A start, the tick's stop and admin *Stoppen* call it.
- **`livetvTick`:**
  - One runner at a time: lock `ltv:tick` (14 s), released at the end.
  - bootId check: `detectLivetv(ctx, 15 s)`. If KV `ltv:boot` differs, it calls `syncIngest` and stores the new id. That includes the first look after an install. This covers the controller's NEED #2.
  - Push notes: `GET /v1/ingest`; `rejected1h > 0` gives `push_rejected` with `n`, at most once per feed per 10 min (`ltv:rejected:<id>`).
  - Stream errors: new `input_lost` / `input_back` entries become events. `input_back` carries `n` = seconds. The newest reported error time is kept in `ltv:errseen:<id>`.
  - Stopping: a stream with zero viewers gets `ltv:zero:<id>` = now. 60 s later it gets `DELETE`, `dropConvGrant('live:<id>')`, and the zero key is removed. A returning viewer clears the key. Streams that are still starting (`ltv:start:` held) are skipped.
  - Task 32 must make the tick skip `ltv:stopping:` too.
- **Hooks for Task 32:**
  - `countConversions` puts the `liveConversions` entries into the key map before the grant loop.
  - `exceptLive` is not implemented (Task 32's job).

### `backend/src/livetv/encoder.ts`
```ts
export type EncoderSetting = 'auto' | 'qsv' | 'vaapi' | 'nvenc' | 'software';
export function resolveEncoder(setting: EncoderSetting, jfHwAccel: string | null, sys: { encoders: Encoder[]; gpu: { readable: boolean } }): Encoder;
export async function liveEncoder(ctx: Ctx, jfHwAccel?: string | null): Promise<Encoder>; // LIVETV_ENCODER vs livetvSystem(); media hwAccel memo 60 s, wait 800 ms
```
`h264_qsv` and `h264_vaapi` count as usable only when `gpu.readable` is true.

### `backend/src/livetv/routes.ts`
```ts
export function logoUrl(ctx: Pick<Ctx, 'encKey' | 'cfg'>, hash: string, exp: number): string
// -> `<PUBLIC_URL origin>/api/livetv/logos/<hash>?exp=<ms>&sig=<b64url HMAC>`
// key = HMAC(APP_ENC_KEY, 'friendflix livetv logo v1'), message `${hash}|${exp}`
```
- **`GET /api/livetv/logos/:hash`:** with `exp` or `sig` in the query, the signature is checked (403 if wrong or expired) and no cookie is needed. Without them the route keeps Task 19's `requireUser` behaviour.
- **`POST /api/livetv/channels/:id/watch` `{ via? }`** (30/min):
  1. 404 `livetv_off` when livetv is not installed.
  2. 400 `{ error: 'invalid', field }` for a bad body.
  3. 403 `forbidden` when the channel is not in the caller's own `channelSet` (this also covers a missing `liveTv` right and unknown ids).
  4. 404 when the row is gone.
  5. 403 `device_pending` when the session has no device.
  6. 429 `{ error: 'max_streams', max }`: `play:<uid>:*` minus this device's own replaceable live views (`deviceLiveSessions`).
  7. `startOrJoin`, then `mintLiveToken`. The session is re-read; if the profile changed, the token is revoked and the answer is 409 `profile_changed` (carry from Task 30).
  8. 200 `{ token, url, expiresAt, dvrSeconds, mode, channel: { id, number, name, logo }, now, next }`, with `cache-control: no-store`. `now` and `next` are `Prog | null`.
  - `channel.logo`: for `via: 'chromecast'` it is the signed absolute `logoUrl(…, now + LIVE_CAP_S*1000)`; for other `via` values `/api/livetv/logos/<hash>`; without a logo `null` (F11).
- **`POST /api/livetv/beat { token }`** (60/min): returns `{ ok: true, expiresAt }`, or 410 `{ error: 'gone' }`, or 400. The ip comes from `clientAddress(req)` and the session from `liveSidHash(req.sid)`.
- **`DELETE /api/livetv/watch { token }`** (60/min): always 204. Only the caller's own token is revoked (`endLiveToken`).

### `backend/src/livetv/tokens.ts` (added)
```ts
export async function endLiveToken(ctx: Ctx, token: string, userId: string): Promise<void>;
export async function deviceLiveSessions(ctx: Ctx, userId: string, deviceId: string): Promise<string[]>; // ps of the device's non-test tokens
```

### `backend/src/livetv/wire.ts` (added)
`StartBody` (pinned field-for-field to `livetv/src/streams.ts` by a test) and `BenchAnswer = { speed: number; encoder: Encoder; seconds: number }`.

### Other changes
- **Settings:** `LIVETV_DVR_MINUTES` (int 0–120, default 30) and `LIVETV_MAX_BITRATE` (int 1 000 000–40 000 000, default 10 000 000) in group `livetv`. They are read per start and per watch answer. Their texts are in all seven locales; the help text of `LIVETV_DVR_MINUTES` is the spec §20 `adminLive.dvrHint` text. No separate `adminLive.dvrHint` key was added, because nothing would consume it.
- **`/internal/authz/live`:** now uses the real `streamKeyFor`. `livetv-tokens` "stream gone" now checks 200 through the route while livetv lists the stream and 410 after it is gone; "never logged" checks 200 then 403 pinning. Both stay green.
- **`convbench`:**
  - `runBenchmark` also runs `POST /v1/benchmark { encoder: liveEncoder() }` when livetv is installed. The result goes to `conv:bench:livetv` as `{ speed, hwAccel: encoder, fingerprint: encoder, at }`. A failure keeps the old record.
  - `convBenchTick` also runs when livetv is installed and `conv:bench:livetv` is missing, under the same 30-minute attempt key (R3, controller NEED #3; tested).
  - Those benchmark tests live in `convbench.test.ts`, which already has the Jellyfin clip fakes, not in `livetv-streams.test.ts`.
- **`status.ts`:** `viewersOf` now uses `viewerCounts`, so Live-Status shows real viewer counts. Admin *Stoppen* also drops the grant and clears the stream cache.
- **`detect.ts` bug fix:** a clock that steps backwards (negative age) no longer keeps the old detection state. Without this, a fake-clock test left `detectLivetv(ctx, 0)` stuck on a cached state; an NTP step back would do the same in production.
- **`server.ts`:** `livetvTick` every 15 s, behind `op()` and `livetvInstalled`, with a busy guard.

## Concerns and follow-ups
1. **Stall watchdog (Task 28 NEED 1):** this is livetv's job (a per-run AbortController in the driver). Task 29's merge (520804e4) says it lands there. The backend tick does not restart stalled streams. The backend's 15-s first-segment stop is kept, as Task 28 asked.
2. **Remux restart backoff reset when a push feed is receiving again:** this is a livetv driver concern, not backend. Not done here.
3. **Live record bitrate (Task 30 carry 3):** not added. `touch()` in `tokens.ts` would need the stream's bitrate; this is a follow-up for the upload-aware cap.
4. **Mock cycle:** `vi.mock('../src/livetv/detect.js')` in a test file does not reach `streams.ts`, because the factory's `orig()` loads the real detect through `convbudget → streams → detect`. `livetv-tokens.test.ts` now also runs the real detection against a fake `/healthz`. Later tests that mock detect should do the same.
5. **Budget admission:** the live slot is admitted with `userId` only, not `deviceId`. A live stream is shared, so the device's own grants must not be left out of the count.
6. **`ltv:start:` lock length:** if admission plus `POST` ever took more than 20 s, a second starter could get the lock. The `POST` is idempotent in livetv, and the second starter re-reads the stream list first, so this is not expected to cause a double slot.
