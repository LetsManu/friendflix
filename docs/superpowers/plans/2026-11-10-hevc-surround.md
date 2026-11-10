# HEVC & Surround Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devices that decode HEVC get HEVC files without a conversion (direct play as today, plus HLS remux). Remote HEVC-capable viewers get an HEVC conversion when the upload needs one, limited and only when proven safe on the owner's low-power QSV server. Devices with 5.1 output get the surround track passed through or converted to Dolby Digital Plus / Dolby Digital / AAC 5.1; everyone else gets stereo, with Health advice for a clear downmix. *Diagnose* shows what each device was given and why.

**Architecture:**

- **Device side:** devices state a stricter `hls` claim and their `audioChannels` in the existing caps block.
  - Web: `web/src/lib/player/devicecaps.ts`, `web/src/lib/webos/caps.ts`.
  - Android: `DeviceProfile.kt`.
  - Cast receiver: a caps message.
- **Server side:**
  - A pure planner, `backend/src/media/streamplan.ts`, turns the claim plus source facts into the HLS URL parameters and a `delivery` block.
  - The HEVC conversion is gated by `backend/src/hevcenc.ts`: settings read, timed probe, limit from the server's own session list, failure count.
  - Settings live in the registry. Health and Diagnose show the result.

**Spec:** `docs/superpowers/specs/2026-11-10-hevc-surround-design.md`.

**Tech Stack:** Fastify + zod (backend), SvelteKit with Svelte 4 syntax, TypeScript, vitest, Playwright, Kotlin + Media3 1.11 (Android), plain JS (Cast receiver).

## Global Constraints

- The media-server token never reaches a client. Media URLs keep their token model (`ff_sid` cookie on `/media/`, cast path tokens). Nothing secret goes into logs, Diagnose, timing or error texts; reasons are fixed codes.
- **We never claim before a positive probe.** This covers device HLS claims, surround output and the server's HEVC conversion. Unknown means "no", and the H.264 stereo stream is used.
- **Byte-identical fallback:** a request without the new caps fields gets exactly today's HLS URL and cast answer. Every task that touches `toPlaybackDto` or the cast route keeps a test asserting this.
- We never change the media server's settings; they are only read.
- The Plex path keeps working. Jellyfin-only parts are guarded: `kind === 'jellyfin'`, optional `MediaAdmin.transcodeSessions` / `encoderSettings`, no `delivery` from Plex.
- No new dependencies. The migration can be re-run (`add column if not exists`), and the next number is **45**.
- Every new web string exists in all 7 locales (de is the type source). Android uses `values` + `values-de`. The words "Netflix" and "Seerr" never appear. Animations use only transform and opacity. Docs use only placeholder hosts (friend.example.com, 192.0.2.x). Tests use fictional titles: *Dunmoor* S1 E5 *Wrenfield Pier*, *Brindlemarsh*, *Saltwater Almanac* S2 E1 *Night Market*.
- Tests follow the existing style (`backend/test/client-caps.test.ts`, `health.test.ts`, `playback-timing.test.ts`, `cast.test.ts`, web vitest next to the module, `e2e/tests/*.spec.ts` with `e2e/mocks/*`).
- **Locally run only** the root `npm run typecheck` and the task's own new or changed test files. CI runs the rest.
- Every commit message ends with these two lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN
  ```

## What we found before planning

- **Today's HLS URL forces H.264, TS and 2 channels** (`backend/src/jellyfin/dto.ts` `toPlaybackDto`: `VideoCodec=h264`, `AudioCodec=aac,mp3`, `SegmentContainer=ts`, `TranscodingMaxAudioChannels=2`, `AudioChannels=2`, `AudioBitrate=192000`).
  - An HEVC MKV in a browser that decodes HEVC is therefore re-encoded to H.264.
  - Every multichannel track is downmixed by the server for HLS.
- **`devicecaps.ts` already probes** HEVC (profiles, tags, height) and AC3/EAC3 with a 6-channel `type: 'file'` decode. It does not probe MSE (hls.js) support or the number of output channels.
- **The gateway already serves fMP4** (`hls1/<id>/-1.mp4` init and `.mp4` segments) on the cookie path and the cast path. `sanitizePlaylist` checks the `#EXT-X-MAP` URI.
- **`web/src/lib/cast.ts:287` hard-codes `HlsSegmentFormat.TS`.**
- **Jellyfin, read in the upstream source:**
  - `AllowHevcEncoding` defaults to **false**, and so does `EnableIntelLowPowerHevcHwEncoder`.
  - `ShiftVideoCodecsIfNeeded` moves `hevc` behind `h264` when HEVC encoding is not allowed, and copying still accepts it.
  - The encoder video codec is the first entry of `VideoCodec`. The audio codec is the first encodable entry of `AudioCodec`, and copying accepts any listed one.
  - `GetH26xOrAv1Encoder` **falls back to the software encoder silently** when the hardware encoder is unusable, so a timed probe is required.
  - The stereo downmix uses `DownMixStereoAlgorithm` (default `None`) and `volume=DownMixAudioBoost` (default 2).
  - `DynamicHlsHelper` adds SDR variants (HEVC, H.264, Level 5.0) at the same bandwidth when it copies HDR video, so the player must lock its variant.
- **Still to confirm** (Task 1, Step 0, reading Jellyfin 10.10 `EncodingJobInfo` and `EncodingHelper.CanStreamCopyVideo` / `CanStreamCopyAudio`):
  - the codec-specific URL parameter names and their comma format (`hevc-codectag`, `hevc-profile`, `hevc-rangetype`, `h264-level`, `h264-videobitdepth`);
  - that an `hvc1` tag is written for HEVC copied into fMP4;
  - whether audio copying is refused when the source track bitrate exceeds `AudioBitrate`. The plan sends `max(budget, source track bitrate)` for a predicted copy, so it is safe either way.

---

### Task 0: This plan

- [ ] Commit `docs: spec and plan for HEVC and surround streaming` (both files).

---

### Task 1: The stream plan (server): HEVC remux, surround, delivery reasons, settings — **hard**

**Files:**
- Create: `backend/src/media/streamplan.ts`, `backend/test/stream-plan.test.ts`
- Modify:
  - `backend/src/media/clientCaps.ts`: `hls`, `audioChannels`.
  - `backend/src/media/types.ts`:
    - `PlaybackDto.delivery`;
    - `PlaybackOptions.remote` / `surround` / `hevcGate`;
    - `HevcGate`;
    - `ClipTranscode.videoCodec`.
  - `backend/src/jellyfin/dto.ts`: `sourceFacts()`; `toPlaybackDto` applies the plan.
  - `backend/src/jellyfin/service.ts`: plan between PlaybackInfo and DTO; ask the gate only when `wantsHevcEncode`; `clipTranscode` honours `videoCodec`.
  - `backend/src/routes/media.ts`:
    - info passes `remote`, `surround` and the gate (a stub returning `{ ok: false, why: 'h264_unproven' }` until Task 2);
    - body fields `fellBack?: 'hevc'|'surround'|'both'` and `prevPs?`;
    - pbinfo stores `video` / `audio`.
- Modify (settings): `backend/src/config.ts` (`HEVC_STREAMS` int 0–4 default 2; `SURROUND_AUDIO` `'true'|'false'` default `'true'`), `backend/src/settings/registry.ts` (group playback, live), `compose.yaml` + `compose.prod.yaml` (generated block, `npm run compose:env` semantics), `backend/src/routes/auth.ts` (`features.surround`)
- Modify (web settings): locales `settings.ts` ×7, `web/src/lib/admin/settings/settings.test.ts` (key list), `e2e/mocks/settings.ts`, `web/src/lib/capabilities.ts` (`Features.surround`)
- Test: `backend/test/client-caps.test.ts` (extend), `backend/test/stream-plan.test.ts` (new), `backend/test/core.test.ts` (route)

**Interfaces:**

- `clientCaps.ts`:
  - `ClientCaps.hls?: { video: Array<'h264'|'hevc'>; audio: Array<'aac'|'mp3'|'ac3'|'eac3'>; surround: Array<'eac3'|'ac3'|'aac'> }` and `ClientCaps.audioChannels?: number` (integer 1–16).
  - The parser drops `hls.video` `hevc` without a `video[]` hevc entry, drops `hls.audio` ac3/eac3 without `audio[]`, and drops `surround` entries outside `hls.audio` (except aac).
  - An empty `hls` after filtering means absent.
- `streamplan.ts` (pure, no I/O):
  ```ts
  export type VideoOut = 'copy' | 'h264' | 'hevc';
  export type AudioOut = 'copy' | 'stereo' | 'surround';
  export type PlanWhy = 'hevc_device' | 'hevc_upload' | 'h264_device' | 'h264_home' | 'h264_hdr' | 'h264_off' | 'h264_unproven' | 'h264_unhealthy' | 'h264_busy'
    | 'surround_device' | 'stereo_device' | 'stereo_bitrate' | 'stereo_off' | 'stereo_source';
  export type HevcGate = { ok: true } | { ok: false; why: 'h264_off' | 'h264_unproven' | 'h264_unhealthy' | 'h264_busy' };
  export interface SourceFacts { videoCodec: string; videoBitrate?: number; height: number; range: string; profile?: string; audio?: { codec: string; channels: number; bitrate?: number } }
  export interface PlanInput { caps: ClientCaps | null; cast: boolean; remote: boolean; maxBitrate: number; boxHeight: number; src: SourceFacts; surroundOn: boolean; hevcStreams: number }
  export interface StreamPlan {
    segment: 'ts' | 'mp4'; videoCodecs: Array<'h264' | 'hevc'>; codecParams: Record<string, string>;
    audioCodecs: string[]; audioChannels: 2 | 6; audioBitrate: number; wantsHevcEncode: boolean;
    delivery: { video: VideoOut; videoCodec: 'h264' | 'hevc'; audio: AudioOut; audioCodec: string; channels: number; why: PlanWhy[] };
  }
  export const SURROUND_MIN_BPS = 4_000_000; export const SURROUND_BUDGET = { eac3: 640_000, ac3: 640_000, aac: 384_000 } as const;
  export function planStream(i: PlanInput): StreamPlan;
  export function applyGate(p: StreamPlan, g: HevcGate): StreamPlan; // refusal: ['h264','hevc'] + reason; the predicted video becomes 'h264'
  ```
- **Rules:**
  - No `hls` block, or `cast` without cast caps → today's values exactly.
  - Copy is predicted when the device's hls list has the source codec, the source video bitrate is at most `maxBitrate − audioBudget`, the height is within the box, and the range and profile are allowed.
  - `wantsHevcEncode` = device has hevc in hls ∧ `remote` ∧ `hevcStreams > 0` ∧ no copy predicted ∧ the source exceeds the video budget ∧ `src.range === 'SDR'`.
  - fMP4 whenever HEVC is listed for a HEVC source or encode, or when surround is planned.
  - Audio rules as in spec decisions 6–7. `VideoBitrate = max(MIN_VIDEO_BITRATE, maxBitrate − audioBitrate)`.
  - fMP4 plans add `EnableAdaptiveBitrateStreaming=false`.
- `PlaybackDto.delivery?: StreamPlan['delivery']` (Jellyfin only).
- `PlaybackOptions.remote?: boolean; surround?: boolean; hevcGate?: () => Promise<HevcGate>`.
- `ClipTranscode.videoCodec?: 'h264' | 'hevc'`.

- [ ] **Step 0: Confirm** the Jellyfin parameter facts listed under "What we found" (WebFetch of the 10.10 sources). Write the result as a comment above `planStream`; on a mismatch adjust only the parameter names.
- [ ] **Step 1: Tests.**
  - `stream-plan.test.ts`:
    - *no hls block → ts, VideoCodec h264, AudioCodec aac,mp3, 2 channels, AudioBitrate 192000* (and `toPlaybackDto` with no caps produces today's `hlsUrl` string exactly).
    - *Wrenfield Pier* (HEVC SDR MKV, 5 Mbit/s), home, cap 120 Mbit/s, device hls hevc → `segment 'mp4'`, `videoCodecs ['h264','hevc']`, video `copy`, why `hevc_device`, `wantsHevcEncode false`.
    - Same title, remote, cap 4 Mbit/s → `wantsHevcEncode true`. `applyGate({ok:true})` gives `['hevc','h264']`, video `hevc`, why `hevc_upload`. `applyGate({ok:false,why:'h264_busy'})` gives `['h264','hevc']`, video `h264`, why `h264_busy`.
    - Home viewer with a source above the budget → no HEVC encode, why `h264_home`.
    - *Brindlemarsh* (HDR10 Main 10), device ranges `['sdr']` → `hevc-rangetype=SDR`, no HEVC encode, why `h264_hdr`.
    - Codec parameters come from the device: `hevc-codectag=hvc1` (plus `hev1` only if claimed), `hevc-profile=main,main10`.
    - Surround: `audioChannels 6`, surround `['eac3']`, EAC3 5.1 source, cap 8 Mbit/s → AudioCodec list starts `eac3`, `TranscodingMaxAudioChannels=6`, audio `copy`, `VideoBitrate = 8_000_000 − 640_000`.
    - TrueHD 7.1 → audio `surround`, codec `eac3`, 6 channels.
    - Cap 1.5 Mbit/s → `stereo_bitrate`. `surroundOn false` → `stereo_off`. *Night Market* AAC stereo → `stereo_source`, codec copied.
    - Cast without caps → today's cast parameters.
  - `client-caps.test.ts`:
    - accepts `hls` and `audioChannels`;
    - drops hevc in hls without a `video[]` hevc entry;
    - drops a surround codec not in `hls.audio`;
    - `audioChannels` 0 / 17 / 2.5 / string → absent;
    - an old Android block parses unchanged.
  - `core.test.ts`:
    - info with a remote caps block calls the gate exactly once when an encode is wanted and never otherwise (spy);
    - the answer carries `delivery`;
    - the Plex fake answers without `delivery`;
    - `fellBack` / `prevPs` are accepted and need nothing else yet.
  - Web: `settings.test.ts` lists `HEVC_STREAMS` and `SURROUND_AUDIO`.
- [ ] **Step 2: Implement**, including settings texts in 7 locales (spec section 11) and the compose block.
- [ ] **Step 3: Verify:** `npm run typecheck`; `npm -w backend exec vitest run test/stream-plan.test.ts test/client-caps.test.ts test/core.test.ts`; `npm -w backend exec vitest run test/compose-env.test.ts`; `npm -w web exec vitest run src/lib/admin/settings/settings.test.ts`.
- [ ] **Step 4: Commit** `feat(playback): HLS stream plan with HEVC remux and surround sound for devices that state it`.

**Number that shows it worked:** `play_daily` share of `transcodes / streams` for `pc` and `tv` devices (7 days before vs after; target −20 % relative). This only moves once Task 3 ships the web claims.

---

### Task 2: The server's HEVC conversion: probe, limit, health — **hard**

**Files:**
- Create: `backend/src/hevcenc.ts`, `backend/test/hevc-encoder.test.ts`
- Modify:
  - `backend/src/media/types.ts`: `EncoderSettings` gains `hevcEncode`, `hwEncode`, `lowPowerHevc`, `downmix`, `downmixBoost`.
  - `backend/src/jellyfin/service.ts`: `encoderSettingsOf` maps them.
  - `backend/src/health.ts`:
    - advice `hevc_server_off`, `hevc_no_hw`, `hevc_failed`, `hevc_slow`, `downmix_plain`;
    - `ServiceHealth.hevc?: { state; speed?; at? }`.
  - `backend/src/healthcheck.ts`: after the nightly run, `probeHevcEncoder`.
  - `backend/src/server.ts`: `hevcTick` on the existing 10-minute timer.
  - `backend/src/routes/admin.ts`: `POST /api/admin/hevc-check` (409 `busy` while a portal stream is live, 409 `already_running`).
  - `backend/src/routes/media.ts`:
    - the real gate;
    - a `fellBack` that includes hevc with a `prevPs` whose pbinfo says `video: 'hevc'` → `noteHevcFailure`.
- Modify (web): `web/src/lib/admin/health.ts` (advice keys, hevc line), `web/src/lib/admin/ServiceLights.svelte` (line plus *Check HEVC now* button, using the existing button styles), locales `adminContent.ts` ×7
- Docs: `docs/monitoring.md` (encoder row: HEVC states and downmix advice), `docs/operations.md` (new section "HEVC conversions and surround sound": Jellyfin switches, Intel low-power HEVC encoder and GuC/HuC for Jasper Lake chips such as the N5095, `Dave750`; placeholder hosts only)
- Test: `backend/test/hevc-encoder.test.ts`, `backend/test/health.test.ts` (extend)

**Interfaces:**
```ts
export type HevcState = 'off' | 'server_off' | 'no_hw' | 'unproven' | 'failed' | 'slow' | 'runtime_failed' | 'ready';
export interface HevcProbeRecord { ok: boolean; reason?: 'http' | 'not_hevc' | 'slow' | 'no_title'; speed?: number; fingerprint: string; at: number }
export const HEVC_MIN_SPEED = 1.5, HEVC_PROBE_TTL_S = 48 * 3600, HEVC_FAIL_WINDOW_MS = 3_600_000, HEVC_FAIL_COOLDOWN_MS = 6 * 3_600_000, HEVC_GRANT_TTL_S = 30, HEVC_SESSIONS_TIMEOUT_MS = 800;
export const HW_TYPES: ReadonlySet<string>; // qsv, vaapi, nvenc, amf, videotoolbox, rkmpp
export function fingerprint(e: EncoderSettings): string;
export function hevcStateOf(o: { streams: number; kind: string; settings: EncoderSettings | null; probe: HevcProbeRecord | null; failures: Array<{ at: number; device: string }>; now: number }): HevcState; // pure
export async function hevcStatus(ctx: Ctx): Promise<{ state: HevcState; speed?: number; at?: string }>;
export async function hevcGate(ctx: Ctx, o: { userId: string; deviceId?: string; playSessionIdHint?: string }): Promise<HevcGate>;
export async function probeHevcEncoder(ctx: Ctx, user: UserRow): Promise<HevcProbeRecord>;
export async function noteHevcFailure(ctx: Ctx, deviceId: string): Promise<void>;
export async function hevcTick(ctx: Ctx): Promise<boolean>;
```

- **Gate:**
  - State not `ready` → the matching refusal code.
  - Otherwise read `transcodeSessions()` (bounded at 800 ms; on failure or timeout `h264_busy`).
  - Count sessions with `videoCodec === 'hevc' && videoDirect === false`, minus the session of the requesting device's own live record, plus `hevcgrant:*` keys whose play session is not in that list.
  - Effective limit = `HEVC_STREAMS`, but 1 while the last probe measured < 3× real time (owner decision Q2). If the count is ≥ the effective limit, refuse with `h264_busy`. Otherwise write `hevcgrant:<ps>` (TTL 30 s) and return ok.
- **Probe:**
  - The first library title, as in `healthcheck.probe`, under `previews.whenIdle()` with previews paused.
  - `clipTranscode({ videoCodec: 'hevc', fmp4: true, videoBitrate: 6_000_000, audioBitrate: 128_000, maxWidth: 1920 })` plus `SegmentLength=3`.
  - Fetch master, variant, init (must contain the bytes `hvcC`), then segments 0–3 in order. `speed = 12 / seconds`.
  - `stopEncoding` in `finally`. Stored as KV `hevcenc:probe`.
- **`hevcTick`:** only when the state is `unproven`, `listLive` is empty, previews are idle and the last attempt is ≥ 30 min old (`hevcenc:attempt`).

- [ ] **Step 1: Tests.**
  - `encoderSettingsOf` maps the five new fields; a missing `DownMixStereoAlgorithm` maps to `unknown` (no advice).
  - `hevcStateOf`, one case per state:
    - `HEVC_STREAMS 0` → `off`; Plex → `off`;
    - `AllowHevcEncoding false` → `server_off`;
    - `hwAccel none` or `hwEncode false` → `no_hw`;
    - no probe, or a fingerprint mismatch → `unproven`;
    - probe `not_hevc` → `failed`; speed 1.2 → `slow`;
    - two failures from two devices within 60 min → `runtime_failed`, and `ready` again after 6 h;
    - two failures from the same device → still `ready`.
  - Gate:
    - ready with no sessions → ok and a grant written;
    - one HEVC non-direct session → `h264_busy`, unless it is the requester's own;
    - an unexpired grant counts;
    - `transcodeSessions` throwing or slow (fake timers) → `h264_busy`;
    - a state that is not ready → the matching code.
  - Probe, with a fake media server:
    - an init with `hvcC` and 4 segments over 6 s → ok, speed 2;
    - no `hvcC` → `not_hevc`;
    - HTTP 500 → `http`;
    - `stopEncoding` is called in every case.
  - Tick: does nothing while a live record exists; at most one attempt per 30 min.
  - Health: advice lists per state while `HEVC_STREAMS > 0`, none at 0; `downmix_plain` when the algorithm is `none`; the encoder row still never raises the banner.
  - Route: `fellBack: 'hevc'` with a `prevPs` whose pbinfo says `video:'hevc'` records a failure; without that pbinfo it records nothing.
- [ ] **Step 2: Implement** plus docs and strings (7 locales).
- [ ] **Step 3: Verify:** typecheck; `npm -w backend exec vitest run test/hevc-encoder.test.ts test/health.test.ts`.
- [ ] **Step 4: Commit** `feat(playback): HEVC conversions for remote viewers once the server's hardware encoder has proven itself, limited and with H.264 fallback`.

**Owner check (on the N5095):**
1. Health → Encoder shows the state.
2. After "Allow encoding in HEVC format" and "Intel low-power HEVC encoder" are on, *Check HEVC now* reports ready with ≥ 1.5×.
3. Two remote viewers at once: the second gets H.264, and Diagnose says *the HEVC converter is busy*.

**Number that shows it worked:** remote timing rows (`home = false`, `video_out = 'hevc'`, Task 4) show no rise in `stallsPerSession` against H.264 rows on the same rungs. `runtime_failed` never shows in Health during a week of use.

---

### Task 3: Web: probing the HLS claims and the output channels; fallback; *Surround sound* switch — **hard**

**Files:**
- Modify:
  - `web/src/lib/player/devicecaps.ts`:
    - `PROBE_VERSION = 2`;
    - `DecodeQuery.type: 'file' | 'media-source'`;
    - media-source queries for HEVC 1080p and for eac3/ac3/aac at 6 channels;
    - `hls` in `buildDeviceCaps`;
    - `outputChannels()`;
    - avoid memory;
    - stereo preference and sound mode.
  - `web/src/lib/webos/caps.ts`: `ClientCapsBody.hls?`, `audioChannels?`; `appCaps()` adds `audioChannels` for probed browsers.
  - `web/src/lib/player/infobody.ts`: `fellBack` / `prevPs` on a fallback body.
  - `web/src/lib/player/retry.ts`: `decideRecovery` gains `avoidable` / `codecError` → `{ do: 'avoid' }`.
  - `web/src/lib/Player.svelte`:
    - watchdog for HLS when `delivery` has HEVC;
    - hls.js `MANIFEST_PARSED` level lock;
    - avoid fallback;
    - *Klang* switch;
    - `delivery` into timing.
  - `web/src/lib/player/TvTracks.svelte`: switch row.
- Modify (i18n): `scenes.ts` ×7 (`audio.surround`, `audio.surroundHint`), `player.ts` ×7 (`switchingCompatible`)
- Test: `web/src/lib/player/devicecaps.test.ts`, `web/src/lib/player/retry.test.ts`, `e2e/tests/player-surround.spec.ts` (new)

**Interfaces:**

- `buildDeviceCaps(env, o, decoded)`:
  - adds `hls` only when `env.isTypeSupported` exists;
  - `hls.video` has `h264` when MSE confirms `avc1.640028`, and `hevc` when hevc is in `video[]`, MSE confirms `MIME.hevcMain` and (with the API) the media-source 1080p decode passes;
  - `hls.audio` has `aac` (MSE), plus `ac3` / `eac3` when in `audio[]` and MSE confirms them;
  - `hls.surround` lists the codecs whose media-source 6-channel query passes.
- `outputChannels(): number`:
  - `new AudioContext()` → `destination.maxChannelCount` → `close()`; a throw means 2;
  - cached per page and reset on `navigator.mediaDevices` `devicechange`.
- `deviceCaps()`:
  - `audioChannels = outputChannels() >= 6 ? n : 2` for client `web`;
  - for client `tizen`, `6` when `hls.surround` is not empty;
  - forced to `2` with `surround: []` when `localStorage['ff_audio_stereo'] === '1'` or `soundModeOn()` (reads the profile's sound-mode preference that the player already uses);
  - avoid memory removes `hevc` from `hls.video` / empties `hls.surround`.
- `noteHlsFailure(what: 'hevc' | 'surround' | 'both'): void`, `avoidedUntil(): { hevc?: number; surround?: number }`, `setStereoOnly(on: boolean): void`, `capsSummary(): { hevcFiles: boolean; hevcStreams: boolean; surround: string[]; channels: number; stereoChoice: boolean; soundMode: boolean; avoided: { hevc?: number; surround?: number } }`.
- `decideRecovery(kind, s, { isHls, canLowerQuality, avoidable, codecError })`:
  - `codecError && avoidable && !s.avoided` → `{ do: 'avoid' }` at once;
  - a generic media error goes recover-media → avoid → lower-quality.
  - `RecoveryState.avoided` is new.
- **Player:**
  - On `avoid`: `noteHlsFailure(what)`, where `what` comes from hls.js `data.mimeType` / `data.sourceBufferName` (audio → surround, video → hevc, otherwise both).
  - Flash `player.switchingCompatible`, then `load(pos)` with the body's `fellBack` and `prevPs`.
  - Level lock: when there is more than one level, pick the highest-bitrate level whose `videoCodec` starts with `hvc1` / `hev1` (planned HEVC) or `avc1`, then `hls.currentLevel = i`.
- **Switch:**
  - shown when `features.surround` is on and the device states `audioChannels >= 6` before the stereo preference applies;
  - toggling writes `ff_audio_stereo` and reloads at the current position like an audio track change;
  - announced with the existing `scenes.audio.on` / `off` templates.

- [ ] **Step 1: Tests.**
  - `devicecaps.test.ts`:
    - hls hevc needs MSE plus the media-source decode, and never appears without `video[]` hevc;
    - `'maybe'` without MSE is not enough;
    - surround needs the 6-channel media-source query per codec;
    - `audioChannels` 6 only when `outputChannels()` ≥ 6, otherwise 2;
    - Tizen gets 6 when surround is not empty;
    - the stereo preference or a sound mode gives `audioChannels 2, surround []`;
    - `noteHlsFailure('hevc')` removes hevc for 30 days, a user-agent change resets it;
    - `PROBE_VERSION 2` discards a version-1 cache;
    - before the asynchronous probe has answered, no hls hevc and no surround.
  - `retry.test.ts`: codec error → `avoid` once, then `fail` / `lower-quality`; generic media → `recover-media`, then `avoid`, then `lower-quality`.
  - e2e `player-surround.spec.ts` (mocked caps with 6 channels and a delivery with surround): the *Klang* menu shows *Raumklang*; turning it off makes a second `/api/playback/info` request with `audioChannels: 2` at the current position; a mocked `bufferAddCodecError` for audio leads to one more request carrying `fellBack: 'surround'` and no third.
- [ ] **Step 2: Implement**, strings in 7 locales.
- [ ] **Step 3: Verify:** typecheck; `npm -w web exec vitest run src/lib/player/devicecaps.test.ts src/lib/player/retry.test.ts`; `npx playwright test -c e2e/playwright.config.ts e2e/tests/player-surround.spec.ts`.
- [ ] **Step 4: Commit** `feat(player): browsers and Samsung TVs state HEVC streams and 5.1 output; one safe fallback; surround switch per device`.

**Owner check:**
1. Edge or Safari on a 5.1 output plays *Wrenfield Pier* with Dolby Digital Plus 5.1.
2. The same browser on headphones gets stereo.
3. An HEVC MKV in Chrome on a GPU with HEVC decode plays without a conversion (admin "now playing": remux).

**Number that shows it worked:** timing rows `video_out = 'copy_hevc'` appear for `pc` / `tv`. The `forcedHls` and `avoided` counts stay under 2 % of starts.

---

### Task 4: Diagnose "Picture and sound" and the timing facts — **sonnet-routine**

**Files:**
- Modify:
  - `web/src/routes/diagnose/+page.svelte`: new section; rows added to *Copy values*.
  - `web/src/lib/player/timing.ts`: `TimingReport.videoOut`, `audioOut`, `why`; `formatTiming` line `out: copy_hevc · eac3 5.1 (hevc_device, surround_device)`.
  - `web/src/lib/player/Player.svelte` → `timing.stream({ videoOut, audioOut, why })` from `delivery` (`direct` when `directUrl` was used).
- Modify (backend):
  - `backend/src/playtiming.ts`: accept allowlisted `videoOut ∈ {direct, copy_h264, copy_hevc, h264, hevc}` and `audioOut ∈ {direct, copy, stereo, surround}`; anything else is null.
  - `backend/src/db.ts`: migration 45, `alter table playback_timings add column if not exists video_out text, add column if not exists audio_out text`.
  - `backend/src/routes/media.ts`: `GET /api/playback/abilities` (signed in) → `{ hevc: 'ready'|'off'|'unproven'|'unhealthy', surround: boolean }`, mapped from `hevcStatus` (`server_off`/`no_hw`/`off` → `off`; `failed`/`slow`/`runtime_failed` → `unhealthy`).
- Modify (i18n): `diagnose.ts` ×7 (title, hint, row labels, values, `why.*`, codec names)
- Test: `backend/test/playback-timing.test.ts`, `web/src/lib/player/timing.test.ts`, `backend/test/core.test.ts` (abilities), `e2e/tests/diagnose-av.spec.ts` (new)

**Interfaces:**
- `formatDelivery(o: { videoOut: string | null; audioOut: string | null; videoCodec?: string; audioCodec?: string; channels?: number }, t): { picture: string; sound: string }`, pure and in `timing.ts`.
- The Diagnose rows use `capsSummary()` (Task 3) and the last `readLocalTimings()` entry.

- [ ] **Step 1: Tests.**
  - Timing: round trip of `video_out` / `audio_out`; an unknown value is stored as null; the migration can be re-run.
  - Web `timing.test.ts`: `formatTiming` includes the out line; reports stored without it render as before.
  - Abilities route: each state maps as specified; Plex → `off`.
  - e2e `diagnose-av.spec.ts` with mocked storage and route:
    - the section shows *Bild und Ton*, the HEVC row and *Stereo (your choice)*;
    - the last playback reads "Bild: HEVC (H.265) unverändert weitergegeben · Ton: Dolby Digital Plus 5.1 weitergegeben";
    - *Copy values* contains those lines and no `/media/` path.
- [ ] **Step 2: Implement**, strings in 7 locales.
- [ ] **Step 3: Verify:** typecheck; `npm -w backend exec vitest run test/playback-timing.test.ts test/core.test.ts`; `npm -w web exec vitest run src/lib/player/timing.test.ts`; `npx playwright test -c e2e/playwright.config.ts e2e/tests/diagnose-av.spec.ts`.
- [ ] **Step 4: Commit** `feat(diagnose): picture and sound: what this device plays, what it got last time and why`.

---

### Task 5: Android: HLS claims, output channels, fallback, switch — **hard**

**Files:**
- Modify:
  - `android/app/src/main/kotlin/app/friendflix/android/player/DeviceProfile.kt`: `ClientCaps.hls`, `audioChannels`; `fromDecoders(…, audio: AudioOut)`.
  - `PlayerApi.kt`: `infoBody(…, fellBack, prevPs)`.
  - `PlayerActivity.kt`: on a decoder or format `PlaybackException` while HLS plays with `delivery` HEVC or surround and nothing has been avoided yet → one reload without them, remembered in `SharedPreferences` for 30 days.
  - The track sheet in `player/panels/*`: switch *Surround sound*.
  - `res/values/strings.xml`, `res/values-de/strings.xml`.
- Test: `android/app/src/test/kotlin/app/friendflix/android/player/DeviceProfileTest.kt` (extend), `PlayerApiTest` (or the existing infoBody test)

**Interfaces:**
- `data class AudioOut(val maxChannels: Int, val passthrough: Set<String>)`, built from Media3 `AudioCapabilities.getCapabilities(context, AudioAttributes.DEFAULT, null)`:
  - `supportsEncoding(C.ENCODING_E_AC3)` → `eac3`, `ENCODING_AC3` → `ac3`;
  - `maxChannelCount`.
  - It is built at each `/info` request, not cached.
- `hls.video` = `h264`, plus `hevc` when a hardware HEVC decoder exists (as in today's `video` list).
- `hls.audio` = `aac` and `mp3`, plus ac3/eac3 when a decoder **or** passthrough exists (these are also added to `audio`).
- `hls.surround` = passthrough codecs ∪ decodable ac3/eac3, plus `aac` when `maxChannels >= 6`.
- `audioChannels` = `maxChannels` when ≥ 6 and surround is not empty, otherwise 2. It is 2 when the stereo preference is on or `AudioFx` is active.

- [ ] **Step 1: Tests.**
  - `DeviceProfileTest`:
    - a phone (no passthrough, 2 channels) → `audioChannels 2`, surround empty, hls hevc present only with a hardware decoder;
    - an HDMI box with E-AC3 passthrough and 8 channels → `audio` contains eac3 without a decoder, `surround [eac3, ac3, aac]`, `audioChannels 8`;
    - the stereo preference → 2 and an empty surround;
    - the JSON keys match the backend parser (`hls.video`, `hls.audio`, `hls.surround`, `audioChannels`).
  - infoBody: `fellBack` and `prevPs` are present only on a fallback.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify:** typecheck; `cd android && ./gradlew :app:testDebugUnitTest --tests 'app.friendflix.android.player.DeviceProfileTest'`.
- [ ] **Step 4: Commit** `feat(android): state HEVC streams and surround output; one fallback; surround switch`.

**Owner check:**
1. A phone with headphones gets stereo.
2. A phone or box over HDMI to the AVR shows Dolby Digital Plus on the AVR display with *Wrenfield Pier*.
3. `docs/android.md` gets these on-device steps.

---

### Task 6: TV apps (LG webOS, Fire TV; Samsung via Task 3) and probe pages — **sonnet-routine**

**Files:**
- Modify: `web/src/lib/webos/caps.ts` (`buildTvCaps` adds the strict-MSE `hls` block and `audioChannels: 6` when surround is not empty), `web/src/lib/webos/probe.ts` (FFPROBE line adds `hlsvideo=h264,hevc surround=eac3,ac3 ch=6`), `docs/webos.md`, `docs/tizen.md`, `docs/firetv.md` (the sample probe line, plus surround and HEVC-stream notes; the German docs in `docs/de/*` alike)
- Test: `web/src/lib/webos/caps.test.ts`, `web/src/lib/webos/probe.test.ts`

**Interfaces:**
- `buildTvCaps(m, o)` adds `hls` only when `m.isTypeSupported` exists. Counted only on `isTypeSupported === true`, because hls.js needs MSE, while `canPlayType` 'maybe' stays enough for the direct-play lists as today.

- [ ] **Step 1: Tests:**
  - LG and Fire TV with MSE confirming hvc1 and ec-3 → hls hevc, surround `[eac3]`, `audioChannels 6`;
  - without `isTypeSupported` → no `hls` and no `audioChannels`, and the block is otherwise identical to today's;
  - the probe line format.
- [ ] **Step 2: Implement** plus docs.
- [ ] **Step 3: Verify:** typecheck; `npm -w web exec vitest run src/lib/webos/caps.test.ts src/lib/webos/probe.test.ts`.
- [ ] **Step 4: Commit** `feat(tv): LG and Fire TV state HEVC streams and Dolby surround`.

**Owner check:**
1. On the LG 43QNED82A6B, the probe page shows `hlsvideo=h264,hevc surround=eac3,ac3 ch=6`.
2. *Wrenfield Pier* plays with sound through the TV speakers and through the soundbar (ARC).
3. If the soundbar stays silent, the *Raumklang* switch fixes it.

---

### Task 7: Chromecast with FriendFlix's receiver — **hard**

**Files:**
- Modify:
  - `web/static/cast-receiver/logic.js`: `buildCaps(probe)`, `parseMessage` accepts `{ t: 'caps?' }`.
  - `web/static/cast-receiver/receiver.js`: probes with `context.canDisplayType` and sends `{ t: 'caps', v: 1, hevc, hevc10, surround }` when a sender connects and on `caps?`.
  - `web/src/lib/cast/engine.ts`: keeps the receiver caps; sends them only when `receiverAppId` is FriendFlix's; `ff-cast-avoid` per device name, 30 days.
  - `web/src/lib/cast.ts:287`: `FMP4` plus `hlsVideoSegmentFormat = FMP4` when the answer says `'fmp4'`.
  - `backend/src/routes/cast.ts`: body `caps` (zod: `{ hevc: boolean, hevc10?: boolean, surround: Array<'eac3'|'ac3'> }`), turned into a cast `ClientCaps` with `hls`, `audioChannels: 6` when surround is not empty, ranges `['sdr']`; `remote` and the gate as in `/info`; answer `hlsSegmentFormat: 'fmp4'` and `hlsVideoSegmentFormat: 'fmp4'` for an fMP4 plan.
  - `backend/src/media/streamplan.ts`: in the cast-with-caps branch, `h264-level=41`, `h264-videobitdepth=8`, no `RequireAvc`.
- Docs: `docs/cast.md` (compatibility table: HEVC and Dolby surround with FriendFlix's receiver when the TV or AVR confirms it), `docs/cast-receiver.md`
- Test: `web/src/lib/cast/receiver.test.ts`, `web/src/lib/cast/engine.test.ts`, `backend/test/cast.test.ts`, `gateway/test/gateway.test.ts`

- [ ] **Step 1: Tests.**
  - Receiver logic: `buildCaps` from probe answers; `parseMessage({t:'caps?'})`.
  - Engine: caps are forwarded only for the own receiver; an avoid entry removes the matching feature.
  - Cast route:
    - **without caps, the `contentUrl` and answer are byte-identical to today's**;
    - with `{hevc:true, surround:['eac3']}` and a HEVC source → fMP4, `VideoCodec` contains hevc, `AudioCodec` starts with `eac3`, `hlsSegmentFormat 'fmp4'`;
    - a Default Media Receiver session ignores any caps.
  - Gateway: a cast media playlist with `#EXT-X-MAP:URI="-1.mp4"` inside the token path is kept, and one pointing outside is refused (`null`).
- [ ] **Step 2: Implement** plus docs.
- [ ] **Step 3: Verify:** typecheck; `npm -w web exec vitest run src/lib/cast/receiver.test.ts src/lib/cast/engine.test.ts`; `npm -w backend exec vitest run test/cast.test.ts`; `npm -w gateway exec vitest run test/gateway.test.ts`.
- [ ] **Step 4: Commit** `feat(cast): FriendFlix's receiver states HEVC and Dolby surround; fMP4 casts`.

**Owner check:**
1. With *Chromecast with Google TV* → AVR, *Wrenfield Pier* shows Dolby Digital Plus on the AVR.
2. With the Default Media Receiver, nothing changes.
3. A receiver error leads to one new cast without the feature.

---

### Task 8: Docs, changelog, roadmap — **sonnet-routine**

**Files:** `README.md` / `README.de.md` (feature line and settings table: `HEVC_STREAMS`, `SURROUND_AUDIO`), `CHANGELOG.md` (*Unreleased*, one line per task), `ROADMAP.md` (items 5 and 6 done), `docs/operations.md` (link to the Health encoder row; owner checklist)

- [ ] **Step 1:** Write the docs (placeholder hosts only, no brand look-alikes).
- [ ] **Step 2: Verify:** `npm run typecheck`; `node --test scripts/*.test.mjs`, if a docs test exists for the changelog format.
- [ ] **Step 3: Commit** `docs: HEVC conversions and surround sound`.

---

## Review Focus

1. **We never claim before a probe.** HEVC in streams and surround need the strict MSE (or ExoPlayer / receiver) probe plus the decode claim. The server's HEVC conversion needs a passing timed probe with `hvcC`. An unknown limit or session list means H.264.
2. **Byte-identical fallback.** Old apps, the Default Media Receiver, AirPlay, Plex, the playback check and previews get exactly today's URLs and answers; tests assert the strings.
3. **N5095 safety.**
   - At most `HEVC_STREAMS` HEVC conversions (server truth plus a 30 s grant window).
   - The probe never runs while someone watches.
   - HDR sources are never HEVC-encoded.
   - Failures on two devices pause HEVC for 6 h.
   - The warm-up overlap is the accepted exception (spec decision 10).
4. **Fallback without loops.** One automatic fallback per session, remembered per device for 30 days. The quality step-down still follows. The variant lock prevents Jellyfin's extra HDR-copy variants from being chosen.
5. **Upload.** The audio budget comes out of the granted cap, and there is no surround below 4 Mbit/s. `UPLOAD_MBPS` counts streams exactly as before.
6. **Privacy.** Only fixed codes go into timing, Diagnose and Health. No URLs, ids, titles or tokens. `audioChannels` is a number.

