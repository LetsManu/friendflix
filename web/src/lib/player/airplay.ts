/**
 * AirPlay (Safari on iOS / iPadOS / macOS) for the player's own <video> element.
 *
 * Safari's AirPlay "video URL" mode hands the element's CURRENT media URL to the receiver (Apple TV, AirPlay 2 TVs such as LG
 * webOS 2019+), which then fetches the playlist and segments ITSELF, without the user's cookies. The player's normal stream is
 * either hls.js (MSE: no URL at all) or a cookie URL (/media/...: the gateway answers the TV with 401). Handing the TV either one
 * fails silently: the TV stays on its AirPlay placeholder, Safari never reports a wireless video target, the phone spins.
 * So: **the TV is never handed a URL it cannot load. The element already holds a cast token URL when the picker is used.**
 *
 * Flow ("token first"):
 * - Tap on OUR button (not AirPlaying): `busy` -> report the local stop and drop hls.js (`detach`), ask for a short-lived, scoped
 *   cast token (POST /api/cast/session, `via: 'airplay'`), put its URL on the element at the same position / play state (the phone
 *   plays the token stream itself meanwhile), THEN open `webkitShowPlaybackTargetPicker()`. After an await WebKit may no longer
 *   treat this as a user gesture and silently not open the picker, so the state turns `ready` and the player shows a prompt whose
 *   button (like another tap on the AirPlay button) opens the picker synchronously from a fresh gesture.
 * - Safari reports the wireless target: the element already plays the token URL -> `active`, nothing is swapped or requested.
 *   (Wireless without our token on the element, e.g. a route chosen elsewhere: fall back to requesting a token and switching.)
 * - No wireless target within ARM_MS while `ready`, or a playback error on the phone meanwhile: the token is revoked and the
 *   normal stream (hls.js) returns at the position (`restore`). A failed token request before any TV is chosen: toast + normal
 *   stream (there is no TV to show an error on).
 * - Wireless off while active: the token is revoked and the normal stream returns where the TV was.
 * - Feature detection only (no UA sniffing): the button exists when `webkitShowPlaybackTargetPicker` does and Safari reports a
 *   receiver via `webkitplaybacktargetavailabilitychanged` (on the video or on a hidden probe <video>, because hls.js sets
 *   disableRemotePlayback on the main element when it uses ManagedMediaSource).
 * - AirPlay chosen from Control Center while hls.js plays only mirrors the screen / sends audio: Safari does not report a wireless
 *   video target for an MSE stream, so nothing here runs.
 * - A failed token request (or a playback error on the TV) while the TV is the target does NOT fall back to the cookie URL
 *   (the TV cannot load it): the state turns `error` and the player offers Retry plus the hint to end AirPlay in the picker.
 * - The backend lets an AirPlay token pin a second client address (the TV) for AIRPLAY_PIN2_WINDOW_MS after creation: the phone
 *   pins the first one when it loads the token stream, the TV the second one once the user picked it.
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

/** how long a tap on the AirPlay button keeps the token stream (state `ready`) while waiting for the picker's wireless target */
export const ARM_MS = 90_000;

export interface AirPlayState {
  /** Safari knows at least one AirPlay receiver: show the button */
  available: boolean;
  /** the video plays on an AirPlay receiver (from the moment Safari reports the wireless target) */
  active: boolean;
  /** the token stream is being requested / switched to */
  busy: boolean;
  /** our button was tapped: the token stream is on the element, waiting (ARM_MS) for the picker's choice (prompt: choose the TV) */
  ready: boolean;
  /** the TV is the target but the token stream failed (request or playback): Retry, or end AirPlay in the picker */
  error: boolean;
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
  /** AirPlay ended / no TV chosen / token failed before a TV: back to the normal stream at `pos`; `play` = it was playing */
  restore(pos: number, play: boolean, ci: CastInfo | null): void | Promise<void>;
  /** the token stream failed (toast) */
  fail(e: unknown): void;
  change(s: AirPlayState): void;
}

export interface AirPlayController {
  /**
   * our button (and the `ready` prompt): not AirPlaying -> token stream on the element, then the system picker;
   * `ready` / active -> opens the picker synchronously (must run from a click); while the token loads: nothing
   */
  pick(): void;
  readonly state: AirPlayState;
  /** new token at the current position while AirPlay plays or is `ready` (audio track / quality, renewal); no-op otherwise */
  refresh(): Promise<void>;
  /** error state: request a token stream again */
  retry(): Promise<void>;
  /** the element reported a playback error: TV's stream -> error state (Retry); `ready` (phone plays the token) -> normal stream */
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
  let available = false, active = false, busy = false, ready = false, error = false, info: CastInfo | null = null, seq = 0, dead = false;
  let armT: ReturnType<typeof setTimeout> | undefined, armPos: number | null = null;
  const avail = new Map<EventTarget, boolean>();
  const state = (): AirPlayState => ({ available, active, busy, ready, error });
  const emit = () => { if (!dead) deps.change(state()); };
  const disarm = () => { if (armT !== undefined) timers.clear(armT); armT = undefined; ready = false; armPos = null; };
  const arm = () => { if (armT !== undefined) timers.clear(armT); ready = true; armT = timers.set(armTimeout, ARM_MS); };
  /** a new src starts at 0 until its metadata: the position we put it at counts until then */
  const position = () => (armPos !== null && video.currentTime < 1 ? armPos : video.currentTime);
  const norm = (u: string) => { try { return new URL(u, 'http://x/').href; } catch { return u; } };
  const picker = () => { try { video.webkitShowPlaybackTargetPicker?.(); } catch { /* not from a gesture: the `ready` prompt opens it */ } };

  /** token URL on the element at `pos` (the token is the credential: no cookies; the cast path answers with CORS *) */
  function play(ci: CastInfo, pos: number, wasPlaying: boolean) {
    video.removeAttribute('crossorigin');
    video.src = ci.contentUrl;
    if (pos > 1) video.addEventListener('loadedmetadata', () => { if (info === ci) video.currentTime = pos; }, { once: true });
    if (wasPlaying) video.play().catch(() => undefined);
  }

  const onAvailability = (e: Event) => {
    avail.set(e.currentTarget ?? video, (e as Event & { availability?: string }).availability === 'available');
    available = [...avail.values()].some(Boolean);
    emit();
  };
  const onWireless = () => {
    const wireless = Boolean(video.webkitCurrentPlaybackTargetIsWireless);
    if (wireless && !active) {
      if (busy && !ready) return; // the token-first request is in flight: tokenFirst() checks the target when it is done
      const onToken = info !== null && norm(video.src) === norm(info.contentUrl);
      if (onToken) { disarm(); active = true; error = false; emit(); return; } // the TV already got the token URL
      // a route we did not prepare (the element has no token URL): fetch one and switch (a token we hold is replaced)
      const from = armPos ?? undefined;
      disarm(); void switchTo(info, from);
    }
    else if (!wireless && active) void stop();
  };

  /** our button: token first, then the picker (the TV must never see the cookie / MSE URL) */
  async function tokenFirst() {
    const my = ++seq, pos = video.currentTime, wasPlaying = !video.paused;
    busy = true; error = false; emit();
    let ci: CastInfo;
    try {
      await deps.detach();
      if (my !== seq || dead) return;
      ci = await deps.request(pos);
    } catch (e) {
      if (my !== seq || dead) return;
      busy = false; emit();
      deps.fail(e);
      await deps.restore(pos, wasPlaying, null); // detach() dropped the normal stream: bring it back
      return;
    }
    if (my !== seq || dead) { deps.revoke(ci); return; }
    info = ci;
    deps.started(ci);
    play(ci, pos, wasPlaying);
    busy = false;
    if (video.webkitCurrentPlaybackTargetIsWireless) { active = true; emit(); return; } // a TV was picked meanwhile
    armPos = pos; arm(); emit();
    picker(); // WebKit may still honour the tap's gesture; if not, the `ready` prompt opens it
  }

  /** wireless without our token (old = held token or null), retry, or a new token for the running / ready session (audio track, quality, renewal) */
  async function switchTo(old: CastInfo | null, from?: number) {
    const my = ++seq, pos = from ?? position(), wasPlaying = !video.paused;
    if (!ready) active = true;
    busy = true; emit();
    try {
      await deps.detach();
      if (my !== seq) return;
      const ci = await deps.request(pos);
      if (my !== seq || dead) { deps.revoke(ci); return; } // AirPlay ended (or the player closed) meanwhile
      if (old) deps.revoke(old);
      info = ci; error = false;
      deps.started(ci);
      play(ci, pos, wasPlaying);
    } catch (e) {
      if (my !== seq || dead) return;
      if (!active) { busy = false; deps.fail(e); await stop(); return; } // ready, no TV yet: back to the normal stream
      // the TV is still the target: never hand it the cookie URL again; keep a still valid old token, offer Retry
      error = true; info = old;
      deps.fail(e);
    } finally {
      if (my === seq) { busy = false; emit(); }
    }
  }

  /** AirPlay off / no TV chosen: revoke the token, normal stream at the position */
  async function stop() {
    const ci = info, pos = position(), wasPlaying = !video.paused;
    seq++; disarm();
    info = null; active = false; busy = false; error = false;
    if (ci) deps.revoke(ci);
    video.setAttribute('crossorigin', 'use-credentials');
    emit();
    await deps.restore(pos, wasPlaying, ci);
  }

  function armTimeout() {
    armT = undefined;
    if (!ready || active || dead) return;
    void stop();
  }

  video.setAttribute('x-webkit-airplay', 'allow');
  for (const t of probe ? [video, probe] : [video]) t.addEventListener(AVAILABILITY_EVENT, onAvailability);
  video.addEventListener(WIRELESS_EVENT, onWireless);

  return {
    pick() {
      if (dead) return;
      if (active || ready) {
        if (ready && !active) arm(); // the user is still choosing: restart the wait
        picker();
        return;
      }
      if (busy) return; // the token is on its way (double tap)
      void tokenFirst();
    },
    get state() { return state(); },
    async refresh() { if ((active || ready) && !busy && info && !error && !dead) await switchTo(info); },
    async retry() { if (active && !busy && !dead) await switchTo(info); },
    videoError() {
      if (dead || busy || error) return;
      if (ready && !active) { deps.fail(new Error('airplay_media')); void stop(); return; } // the phone's token stream: normal stream again
      if (!active) return;
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
