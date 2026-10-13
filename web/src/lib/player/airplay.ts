/**
 * AirPlay (Safari on iOS / iPadOS / macOS) for the player's own <video> element.
 *
 * Safari's AirPlay "video URL" mode hands the element's media URL to the receiver (Apple TV, AirPlay 2 TVs such as LG webOS 2019+),
 * which then fetches the playlist and segments ITSELF, without the user's cookies. So, as with Chromecast, the player asks for a
 * short-lived, scoped cast token (POST /api/cast/session, `via: 'airplay'`) as soon as the playback target becomes wireless and
 * switches the element to that token URL at the same position; when AirPlay ends, the token is revoked and the normal stream returns.
 *
 * - Feature detection only (no UA sniffing): the button exists when `webkitShowPlaybackTargetPicker` does and Safari reports a
 *   receiver via `webkitplaybacktargetavailabilitychanged`.
 * - MSE / ManagedMediaSource streams (hls.js) cannot be AirPlayed (hls.js even sets disableRemotePlayback): on AirPlay-capable
 *   browsers with native HLS the player plays HLS natively (see `prefersNativeHls`).
 * - Subtitles: the receiver only shows tracks inside the stream; the player's side-loaded WebVTT tracks stay on the phone.
 */
import type { CastInfo } from '#lib/cast';

/** the part of HTMLVideoElement this module uses (tests pass a fake) */
export interface AirPlayVideo extends EventTarget {
  currentTime: number;
  readonly paused: boolean;
  src: string;
  disableRemotePlayback?: boolean;
  webkitShowPlaybackTargetPicker?: () => void;
  readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
  play(): Promise<void>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  canPlayType?(type: string): string;
}

/** Safari's AirPlay API is there (iOS, iPadOS, macOS Safari; also all iOS browsers, which are WebKit) */
export const airPlaySupported = (v: Partial<AirPlayVideo> | null | undefined): boolean => typeof v?.webkitShowPlaybackTargetPicker === 'function';

/** AirPlay-capable browser that plays HLS natively: use native HLS instead of hls.js (MSE streams cannot be AirPlayed) */
export const prefersNativeHls = (v: Partial<AirPlayVideo> | null | undefined): boolean =>
  airPlaySupported(v) && Boolean(v?.canPlayType?.('application/vnd.apple.mpegurl'));

export interface AirPlayState {
  /** Safari knows at least one AirPlay receiver: show the button */
  available: boolean;
  /** the video plays on an AirPlay receiver (from the moment Safari reports the wireless target) */
  active: boolean;
  /** the token stream is being requested / switched to */
  busy: boolean;
}

export interface AirPlayDeps {
  /** POST /api/cast/session for the current item at `pos` (audio track, quality are the player's) */
  request(pos: number): Promise<CastInfo>;
  /** DELETE /api/cast/session/<castId> (fire and forget) */
  revoke(ci: CastInfo): void;
  /** before the token stream: report the local stop, drop hls.js, cancel pending attaches */
  detach(): void | Promise<void>;
  /** the token stream is about to play: progress reports belong to `ci` from now on */
  started(ci: CastInfo): void;
  /** back to the player's normal stream at `pos` (AirPlay ended, or the switch failed); `play` = it was playing */
  restore(pos: number, play: boolean, ci: CastInfo | null): void | Promise<void>;
  /** the switch failed (toast) */
  fail(e: unknown): void;
  change(s: AirPlayState): void;
}

export interface AirPlayController {
  /** opens the system picker (must run from a click) */
  pick(): void;
  readonly state: AirPlayState;
  /** new token at the current position while AirPlay plays (other audio track / quality, renewal before expiry); no-op otherwise */
  refresh(): Promise<void>;
  /** the cast session while AirPlay plays the token stream */
  readonly info: CastInfo | null;
  /** removes the listeners and revokes a live token (leaving the player) */
  destroy(): void;
}

export const AVAILABILITY_EVENT = 'webkitplaybacktargetavailabilitychanged';
export const WIRELESS_EVENT = 'webkitcurrentplaybacktargetiswirelesschanged';

export function createAirPlay(video: AirPlayVideo, deps: AirPlayDeps): AirPlayController {
  let available = false, active = false, busy = false, info: CastInfo | null = null, seq = 0, dead = false;
  const state = (): AirPlayState => ({ available, active, busy });
  const emit = () => { if (!dead) deps.change(state()); };

  const onAvailability = (e: Event) => {
    available = (e as Event & { availability?: string }).availability === 'available';
    emit();
  };
  const onWireless = () => {
    const wireless = Boolean(video.webkitCurrentPlaybackTargetIsWireless);
    if (wireless && !active) void start();
    else if (!wireless && active) void stop();
  };

  /** wireless on (old = null), or a new token for the running AirPlay session (audio track, quality, renewal before expiry) */
  async function switchTo(old: CastInfo | null) {
    const my = ++seq, pos = video.currentTime, play = !video.paused;
    active = true; busy = true; emit();
    try {
      await deps.detach();
      if (my !== seq) return;
      const ci = await deps.request(pos);
      if (my !== seq || dead) { deps.revoke(ci); return; } // AirPlay ended (or the player closed) meanwhile
      if (old) deps.revoke(old);
      info = ci;
      deps.started(ci);
      // the token is the credential: no cookies needed (the cast path answers with CORS *, which credentialed requests reject)
      video.removeAttribute('crossorigin');
      video.src = ci.contentUrl;
      if (pos > 1) video.addEventListener('loadedmetadata', () => { if (info === ci) video.currentTime = pos; }, { once: true });
      if (play) video.play().catch(() => undefined);
    } catch (e) {
      if (my !== seq || dead) return;
      if (old) deps.revoke(old);
      active = false; info = null;
      deps.fail(e);
      video.setAttribute('crossorigin', 'use-credentials');
      await deps.restore(pos, play, null);
    } finally {
      if (my === seq) { busy = false; emit(); }
    }
  }
  const start = () => switchTo(null);

  async function stop() {
    seq++;
    const ci = info, pos = video.currentTime, play = !video.paused;
    info = null; active = false; busy = false;
    if (ci) deps.revoke(ci);
    video.setAttribute('crossorigin', 'use-credentials');
    emit();
    await deps.restore(pos, play, ci);
  }

  video.setAttribute('x-webkit-airplay', 'allow');
  video.addEventListener(AVAILABILITY_EVENT, onAvailability);
  video.addEventListener(WIRELESS_EVENT, onWireless);

  return {
    pick() { try { video.webkitShowPlaybackTargetPicker?.(); } catch { /* no picker (not from a gesture) */ } },
    get state() { return state(); },
    async refresh() { if (active && !busy && info && !dead) await switchTo(info); },
    get info() { return info; },
    destroy() {
      dead = true; seq++;
      video.removeEventListener(AVAILABILITY_EVENT, onAvailability);
      video.removeEventListener(WIRELESS_EVENT, onWireless);
      if (info) deps.revoke(info);
      info = null;
    },
  };
}
