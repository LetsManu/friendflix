/**
 * AirPlay (Safari on iOS / iPadOS / macOS) for the player's own <video> element.
 *
 * Safari's AirPlay "video URL" mode hands the element's media URL to the receiver (Apple TV, AirPlay 2 TVs such as LG webOS 2019+),
 * which then fetches the playlist and segments ITSELF, without the user's cookies. So, as with Chromecast, the player asks for a
 * short-lived, scoped cast token (POST /api/cast/session, `via: 'airplay'`) as soon as the playback target becomes wireless and
 * switches the element to that token URL at the same position; when AirPlay ends, the token is revoked and the normal stream returns.
 *
 * - Feature detection only (no UA sniffing): the button exists when `webkitShowPlaybackTargetPicker` does and Safari reports a
 *   receiver via `webkitplaybacktargetavailabilitychanged` (on the video or on a hidden probe <video>, because hls.js sets
 *   disableRemotePlayback on the main element when it uses ManagedMediaSource).
 * - Normal playback keeps hls.js (bandwidth estimate, ABR, audio effects). A MSE stream cannot be AirPlayed, so a tap on OUR button
 *   first switches the element to the native HLS URL (`prepare`) and opens the picker in the same click (user gesture). When no
 *   wireless target follows within ARM_MS (picker dismissed), the player goes back to hls.js (`reattach`).
 * - AirPlay chosen from Control Center while hls.js plays only mirrors the screen / sends audio: Safari does not report a wireless
 *   video target for an MSE stream, so nothing here runs.
 * - A failed token request (or a playback error on the TV) while the TV is still the target does NOT fall back to the cookie URL
 *   (the TV cannot load it): the state turns `error` and the player offers Retry plus the hint to end AirPlay in the picker.
 * - Subtitles: the receiver only shows tracks inside the stream; the player's side-loaded WebVTT tracks stay on the phone.
 */
import type { CastInfo } from '#lib/cast';

/** the part of HTMLVideoElement this module uses (tests pass a fake) */
export interface AirPlayVideo extends EventTarget {
  currentTime: number;
  readonly paused: boolean;
  src: string;
  webkitShowPlaybackTargetPicker?: () => void;
  readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
  play(): Promise<void>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
}

/** Safari's AirPlay API is there (iOS, iPadOS, macOS Safari; also all iOS browsers, which are WebKit) */
export const airPlaySupported = (v: Partial<AirPlayVideo> | null | undefined): boolean => typeof v?.webkitShowPlaybackTargetPicker === 'function';

/** how long a tap on the AirPlay button keeps the native HLS stream while waiting for a wireless target */
export const ARM_MS = 30_000;

export interface AirPlayState {
  /** Safari knows at least one AirPlay receiver: show the button */
  available: boolean;
  /** the video plays on an AirPlay receiver (from the moment Safari reports the wireless target) */
  active: boolean;
  /** the token stream is being requested / switched to */
  busy: boolean;
  /** our button was tapped: native HLS is loaded, waiting (ARM_MS) for the picker's choice */
  armed: boolean;
  /** the TV is the target but the token stream failed (request or playback): Retry, or end AirPlay in the picker */
  error: boolean;
}

export interface AirPlayDeps {
  /** POST /api/cast/session for the current item at `pos` (audio track, quality are the player's) */
  request(pos: number): Promise<CastInfo>;
  /** DELETE /api/cast/session/<castId> (fire and forget) */
  revoke(ci: CastInfo): void;
  /**
   * SYNCHRONOUS (runs inside the click): put an AirPlay-able URL on the element (hls.js -> native HLS of the same stream, same
   * position). false = the element already has one (direct play / native HLS), nothing to undo later.
   */
  prepare(): boolean;
  /** the picker brought no wireless target within ARM_MS: back to hls.js at `pos` */
  reattach(pos: number, play: boolean): void;
  /** before the token stream: report the local stop, drop hls.js, cancel pending attaches */
  detach(): void | Promise<void>;
  /** the token stream is about to play: progress reports belong to `ci` from now on */
  started(ci: CastInfo): void;
  /** AirPlay ended: back to the player's normal stream at `pos`; `play` = it was playing */
  restore(pos: number, play: boolean, ci: CastInfo | null): void | Promise<void>;
  /** the token stream failed (toast) */
  fail(e: unknown): void;
  change(s: AirPlayState): void;
}

export interface AirPlayController {
  /** our button: prepares an AirPlay-able stream and opens the system picker (must run from a click) */
  pick(): void;
  readonly state: AirPlayState;
  /** new token at the current position while AirPlay plays (other audio track / quality, renewal before expiry); no-op otherwise */
  refresh(): Promise<void>;
  /** error state: request a token stream again */
  retry(): Promise<void>;
  /** the element reported a playback error: while AirPlay plays this is the TV's stream -> error state (Retry) */
  videoError(): void;
  /** the cast session while AirPlay plays the token stream */
  readonly info: CastInfo | null;
  /** removes the listeners and revokes a live token (leaving the player) */
  destroy(): void;
}

export const AVAILABILITY_EVENT = 'webkitplaybacktargetavailabilitychanged';
export const WIRELESS_EVENT = 'webkitcurrentplaybacktargetiswirelesschanged';

/**
 * `probe`: an extra element (hidden, never MSE) whose availability events count too.
 * `timers` is injectable for tests.
 */
export function createAirPlay(video: AirPlayVideo, deps: AirPlayDeps, probe?: EventTarget | null, timers: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) }): AirPlayController {
  let available = false, active = false, busy = false, armed = false, error = false, info: CastInfo | null = null, seq = 0, dead = false;
  let armT: ReturnType<typeof setTimeout> | undefined, armPos: number | null = null;
  const avail = new Map<EventTarget, boolean>();
  const state = (): AirPlayState => ({ available, active, busy, armed, error });
  const emit = () => { if (!dead) deps.change(state()); };
  const disarm = () => { if (armT !== undefined) timers.clear(armT); armT = undefined; armed = false; armPos = null; };

  const onAvailability = (e: Event) => {
    avail.set(e.currentTarget ?? video, (e as Event & { availability?: string }).availability === 'available');
    available = [...avail.values()].some(Boolean);
    emit();
  };
  const onWireless = () => {
    const wireless = Boolean(video.webkitCurrentPlaybackTargetIsWireless);
    if (wireless && !active) {
      // right after prepare() the new native src may not have reached the old position yet (it starts at 0 until metadata)
      const from = armPos !== null && video.currentTime < 1 ? armPos : undefined;
      disarm(); void switchTo(null, from);
    }
    else if (!wireless && active) void stop();
  };

  /** wireless on (old = null), retry, or a new token for the running AirPlay session (audio track, quality, renewal) */
  async function switchTo(old: CastInfo | null, from?: number) {
    const my = ++seq, pos = from ?? video.currentTime, play = !video.paused;
    active = true; busy = true; emit();
    try {
      await deps.detach();
      if (my !== seq) return;
      const ci = await deps.request(pos);
      if (my !== seq || dead) { deps.revoke(ci); return; } // AirPlay ended (or the player closed) meanwhile
      if (old) deps.revoke(old);
      info = ci; error = false;
      deps.started(ci);
      // the token is the credential: no cookies needed (the cast path answers with CORS *, which credentialed requests reject)
      video.removeAttribute('crossorigin');
      video.src = ci.contentUrl;
      if (pos > 1) video.addEventListener('loadedmetadata', () => { if (info === ci) video.currentTime = pos; }, { once: true });
      if (play) video.play().catch(() => undefined);
    } catch (e) {
      if (my !== seq || dead) return;
      // the TV is still the target: never hand it the cookie URL again; keep a still valid old token, offer Retry
      error = true; info = old;
      deps.fail(e);
    } finally {
      if (my === seq) { busy = false; emit(); }
    }
  }

  async function stop() {
    seq++; disarm();
    const ci = info, pos = video.currentTime, play = !video.paused;
    info = null; active = false; busy = false; error = false;
    if (ci) deps.revoke(ci);
    video.setAttribute('crossorigin', 'use-credentials');
    emit();
    await deps.restore(pos, play, ci);
  }

  function armTimeout() {
    armT = undefined;
    if (!armed || active || dead) return;
    const from = armPos !== null && video.currentTime < 1 ? armPos : video.currentTime;
    armed = false; armPos = null;
    emit();
    deps.reattach(from, !video.paused);
  }

  video.setAttribute('x-webkit-airplay', 'allow');
  for (const t of probe ? [video, probe] : [video]) t.addEventListener(AVAILABILITY_EVENT, onAvailability);
  video.addEventListener(WIRELESS_EVENT, onWireless);

  return {
    pick() {
      if (!active) {
        const at = video.currentTime;
        if (armed || deps.prepare()) {
          armPos ??= at;
          if (armT !== undefined) timers.clear(armT);
          armed = true; armT = timers.set(armTimeout, ARM_MS);
          emit();
        }
      }
      try { video.webkitShowPlaybackTargetPicker?.(); } catch { /* no picker (not from a gesture) */ }
    },
    get state() { return state(); },
    async refresh() { if (active && !busy && info && !error && !dead) await switchTo(info); },
    async retry() { if (active && !busy && !dead) await switchTo(info); },
    videoError() {
      if (!active || busy || dead || error) return;
      error = true;
      deps.fail(new Error('airplay_media'));
      emit();
    },
    get info() { return info; },
    destroy() {
      dead = true; seq++; disarm();
      for (const t of probe ? [video, probe] : [video]) t.removeEventListener(AVAILABILITY_EVENT, onAvailability);
      video.removeEventListener(WIRELESS_EVENT, onWireless);
      if (info) deps.revoke(info);
      info = null;
    },
  };
}
