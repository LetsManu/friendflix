// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Start-time measurement of one playback session (Player.svelte): ms since the start of loading until the playback info,
 * the (variant) playlist, the first media fragment and the first frame, plus seeks (seeking -> playing) and stalls (waiting
 * after the first frame). Sent once per session on stop / pagehide / end (POST /api/playback/timing, keepalive fetch with
 * the csrf header) and kept on this device (last TIMING_LOCAL_MAX, shown on /diagnose). Never throws, never blocks playback.
 *
 * Sync facts of the same session (for A/V-sync reports): how the stream was delivered (direct file, remux = video copied with the
 * audio converted, transcode), the sound mode and whether the sound ran through Web Audio, dropped / total video frames
 * (getVideoPlaybackQuality) and the A/V-affecting events (seeks, a track / quality switch that started the session, reconnects).
 * Like the timings: no user, profile, title or address.
 */
export type Device = 'phone' | 'pc' | 'tv';
export type Mode = 'direct' | 'hls';
export type Delivery = 'direct' | 'remux' | 'transcode';
export type SoundMode = 'off' | 'voices' | 'night' | 'both';

export interface TimingReport {
  device: Device;
  mode: Mode | null;
  /** this session only exists because of a quality switch: not a start */
  qualitySwitch: boolean;
  bitrate: number | null;
  targetDuration: number | null;
  infoMs: number | null;
  manifestMs: number | null;
  firstFragMs: number | null;
  firstFragBytes: number | null;
  firstFragDlMs: number | null;
  firstFrameMs: number | null;
  seeks: number;
  seekMedianMs: number | null;
  seekMaxMs: number | null;
  stalls: number;
  stallMs: number;
  effectiveType: string | null;
  /** direct play, remux (video copied, audio converted) or transcode; null = not known */
  delivery: Delivery | null;
  /** the server copied the video stream (its transcode info); null = not known */
  videoCopy: boolean | null;
  /** sound mode at the end of the session */
  soundMode: SoundMode;
  /** the sound ran through Web Audio during this session (sound modes: extra audio latency) */
  audioRouted: boolean;
  droppedFrames: number | null;
  totalFrames: number | null;
  /** this session only exists because of an audio track switch */
  trackSwitch: boolean;
  /** stream errors this session recovered from (retry, media recovery, switch to the converted stream) */
  reconnects: number;
  /** seeks + reconnects + the track / quality switch that started this session */
  avEvents: number;
  /** this start used the next episode's playback info prepared during the autoplay countdown (prefetch.ts prepareNext) */
  fromNext: boolean;
}
export interface StoredTiming extends TimingReport { at: number }

export const TIMING_ENDPOINT = '/api/playback/timing';
export const TIMING_LOCAL_KEY = 'ff.playTimings';
export const TIMING_LOCAL_MAX = 5;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const ms = (x: number) => Math.max(0, Math.round(x));

/** transcode reasons that make the server convert the picture itself (a bitrate / height cap below the source, a codec the device lacks) */
const VIDEO_REASONS = new Set(['videoCodec', 'height', 'network', 'remoteCap', 'uploadCap', 'roleCap', 'manual']);
/** reasons where the picture is usually copied and only the audio or the container changes */
const REMUX_REASONS = new Set(['audioCodec', 'audioTrack', 'container']);
/**
 * How the stream reaches the player: the server's own answer (`videoCopy`, from its transcode info) wins; without it the transcode
 * reason gives a best guess; null when neither says it.
 */
export function deliveryOf(mode: Mode | null, reason: string | null | undefined, videoCopy: boolean | null): Delivery | null {
  if (mode === 'direct') return 'direct';
  if (mode !== 'hls') return null;
  if (videoCopy !== null) return videoCopy ? 'remux' : 'transcode';
  if (reason && VIDEO_REASONS.has(reason)) return 'transcode';
  if (reason && REMUX_REASONS.has(reason)) return 'remux';
  return null;
}

/**
 * Dropped / total frames over a session: the element's counters restart at every load (a new src, an MSE attach, a fresh element),
 * so a reading below the previous one means a restart and the previous reading is kept as a base.
 */
function frameCounter() {
  let baseD = 0, baseT = 0, lastD = 0, lastT = 0, seen = false;
  return {
    reset() { baseD = baseT = lastD = lastT = 0; seen = false; },
    sample(dropped: number, total: number) {
      if (!Number.isFinite(dropped) || !Number.isFinite(total) || dropped < 0 || total < 0) return;
      if (total < lastT || dropped < lastD) { baseD += lastD; baseT += lastT; }
      lastD = dropped; lastT = total; seen = true;
    },
    get value(): { dropped: number | null; total: number | null } {
      return seen ? { dropped: Math.round(baseD + lastD), total: Math.round(baseT + lastT) } : { dropped: null, total: null };
    },
  };
}

export function createTiming(now: () => number = () => performance.now()) {
  let t0 = 0, on = false, qualitySwitch = false, mode: Mode | null = null, bitrate: number | null = null, targetDuration: number | null = null;
  let infoAt: number | null = null, manifestAt: number | null = null, fragAt: number | null = null, frameAt: number | null = null;
  let fragBytes: number | null = null, fragDl: number | null = null;
  let seekAt: number | null = null, seeks: number[] = [], seekCount = 0, stallAt: number | null = null, stalls = 0, stallMs = 0;
  let fromNext = false, trackSwitch = false, delivery: Delivery | null = null, videoCopy: boolean | null = null, soundMode: SoundMode = 'off', audioRouted = false, reconnects = 0;
  const frames = frameCounter();
  const rel = () => ms(now() - t0);
  const closeStall = () => { if (stallAt !== null) { stallMs += ms(now() - stallAt); stallAt = null; } };
  const frame = () => { if (on && frameAt === null) frameAt = rel(); };

  return {
    /**
     * start of loading: a new session (`qualitySwitch` = a re-start for a quality change, never counted as a start; `isTrack` = a
     * re-start for an audio track change)
     */
    begin(isSwitch = false, isTrack = false) {
      t0 = now(); on = true; qualitySwitch = isSwitch; mode = null; bitrate = null; targetDuration = null;
      infoAt = manifestAt = fragAt = frameAt = fragBytes = fragDl = seekAt = stallAt = null; seeks = []; seekCount = 0; stalls = 0; stallMs = 0;
      fromNext = false; trackSwitch = isTrack && !isSwitch; delivery = null; videoCopy = null; soundMode = 'off'; audioRouted = false; reconnects = 0; frames.reset();
    },
    get active() { return on; },
    /** playback info received with the requested bitrate (first answer of the session only: a retry keeps the clock) */
    info(bps?: number) { if (on && infoAt === null) { infoAt = rel(); bitrate = bps && bps > 0 ? Math.round(bps) : null; } },
    mode(m: Mode) { if (on && mode === null) mode = m; },
    /** the start used the prepared next-episode info */
    next() { if (on) fromNext = true; },
    /** how the stream is delivered: the transcode reason's guess first, the server's transcode info (videoCopy) when it answers */
    stream(o: { reason?: string | null; videoCopy?: boolean | null }) {
      if (!on) return;
      if (typeof o.videoCopy === 'boolean') videoCopy = o.videoCopy;
      delivery = deliveryOf(mode, o.reason, videoCopy) ?? delivery;
    },
    /** the current sound mode; `routed` = the element's sound runs through Web Audio (sticky for the session) */
    sound(m: SoundMode, routed: boolean) { if (on) { soundMode = m; audioRouted ||= routed; } },
    /** getVideoPlaybackQuality(): dropped and total frames of the element right now */
    frames(dropped: number, total: number) { if (on) frames.sample(dropped, total); },
    /** the stream failed and is being recovered (retry, media recovery, the converted stream) */
    reconnect() { if (on) reconnects++; },
    /** playlist loaded (hls.js LEVEL_LOADED, native: loadedmetadata); `target` = EXT-X-TARGETDURATION */
    manifest(target?: number) {
      if (!on || manifestAt !== null) return;
      manifestAt = rel();
      if (target && Number.isFinite(target) && target > 0) targetDuration = target;
    },
    /** first media fragment: its bytes and download ms */
    frag(bytes: number, dlMs: number) {
      if (!on || fragAt !== null) return;
      fragAt = rel(); fragBytes = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : null; fragDl = Number.isFinite(dlMs) ? ms(dlMs) : null;
    },
    /** loadeddata / playing */
    frame,
    /** before the first frame every waiting is part of the start; during a seek it belongs to the seek */
    waiting(seeking: boolean) {
      if (!on || frameAt === null || seeking || seekAt !== null || stallAt !== null) return;
      stallAt = now(); stalls++;
    },
    seeking() {
      if (!on || frameAt === null) return;
      closeStall(); // the viewer jumped out of a stall: it ends here
      if (seekAt === null) { seekAt = now(); seekCount++; }
    },
    /** a seek while paused ends at seeked (no playing follows) */
    seeked(paused: boolean) { if (on && paused && seekAt !== null) { seeks.push(ms(now() - seekAt)); seekAt = null; } },
    playing() {
      if (!on) return;
      frame();
      closeStall();
      if (seekAt !== null) { seeks.push(ms(now() - seekAt)); seekAt = null; }
    },
    /** ends the session: the report once (null when none runs or it was dropped) */
    finish(env: { device: Device; effectiveType?: string | null }): TimingReport | null {
      if (!on) return null;
      closeStall();
      on = false;
      const med = median(seeks);
      return {
        device: env.device, mode, qualitySwitch, bitrate, targetDuration, infoMs: infoAt, manifestMs: manifestAt, firstFragMs: fragAt,
        firstFragBytes: fragBytes, firstFragDlMs: fragDl, firstFrameMs: frameAt, seeks: seekCount, seekMedianMs: med === null ? null : ms(med),
        seekMaxMs: seeks.length ? Math.max(...seeks) : null, stalls, stallMs, effectiveType: env.effectiveType ?? null,
        delivery: delivery ?? deliveryOf(mode, null, videoCopy), videoCopy, soundMode, audioRouted, droppedFrames: frames.value.dropped, totalFrames: frames.value.total,
        trackSwitch, reconnects, avEvents: seekCount + reconnects + (qualitySwitch || trackSwitch ? 1 : 0), fromNext,
      };
    },
    /** party / cast / AirPlay: this session is not reported */
    drop() { on = false; },
  };
}
export type Timing = ReturnType<typeof createTiming>;

/** the app's device classes: TV mode wins, a coarse pointer is a phone (or tablet), the rest a pc */
export const deviceClass = (o: { coarse: boolean; tv: boolean }): Device => (o.tv ? 'tv' : o.coarse ? 'phone' : 'pc');

/** Network Information API (Chromium only; iOS Safari has none) */
export function effectiveType(nav: unknown): string | null {
  try {
    const t = (nav as { connection?: { effectiveType?: unknown } } | undefined)?.connection?.effectiveType;
    return typeof t === 'string' && t ? t.slice(0, 10) : null;
  } catch { return null; }
}

export interface TimingEnv {
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  csrf: string;
  profile?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
}

/** this device's last reports, newest first (empty when storage is blocked or broken) */
export function readLocalTimings(storage?: Pick<Storage, 'getItem'> | null): StoredTiming[] {
  try {
    const raw = (storage === undefined ? globalThis.localStorage : storage)?.getItem(TIMING_LOCAL_KEY);
    const a: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? (a.filter((x) => x && typeof x === 'object' && typeof x.at === 'number') as StoredTiming[]).slice(0, TIMING_LOCAL_MAX) : [];
  } catch { return []; }
}

/** keepalive fetch (survives the page unload; a beacon cannot carry the csrf header) + local copy; every error is swallowed */
export function sendTiming(r: TimingReport, env: TimingEnv): void {
  try {
    const storage = env.storage === undefined ? globalThis.localStorage : env.storage;
    storage?.setItem(TIMING_LOCAL_KEY, JSON.stringify([{ ...r, at: (env.now ?? Date.now)() }, ...readLocalTimings(storage)].slice(0, TIMING_LOCAL_MAX)));
  } catch { /* storage blocked / full */ }
  try {
    const f = env.fetch ?? globalThis.fetch;
    void f?.(TIMING_ENDPOINT, {
      method: 'POST', keepalive: true, credentials: 'same-origin', body: JSON.stringify(r),
      headers: { 'content-type': 'application/json', 'x-csrf-token': env.csrf, ...(env.profile ? { 'x-ff-profile': env.profile } : {}) },
    })?.catch?.(() => undefined);
  } catch { /* no fetch / refused */ }
}

/** one line per stored report for /diagnose (copyable text) */
export function formatTiming(s: StoredTiming): string {
  const v = (x: number | null, unit = 'ms') => (x === null ? '–' : `${x} ${unit}`);
  const kb = s.firstFragBytes === null ? '–' : `${Math.round(s.firstFragBytes / 1024)} KB`;
  return [
    `${new Date(s.at).toISOString().slice(0, 19).replace('T', ' ')} ${s.device} ${s.mode ?? '?'}${s.qualitySwitch ? ' (switch)' : ''}${s.bitrate ? ` ${Math.round(s.bitrate / 100_000) / 10} Mbit/s` : ''}${s.effectiveType ? ` ${s.effectiveType}` : ''}`,
    `  info ${v(s.infoMs)} · playlist ${v(s.manifestMs)} · 1st frag ${v(s.firstFragMs)} (${kb} in ${v(s.firstFragDlMs)}) · 1st frame ${v(s.firstFrameMs)}${s.targetDuration ? ` · segment ${s.targetDuration} s` : ''}`,
    `  seeks ${s.seeks} (median ${v(s.seekMedianMs)}, max ${v(s.seekMaxMs)}) · stalls ${s.stalls} (${v(s.stallMs)})`,
    ...(s.avEvents === undefined ? [] : [syncLine(s)]), // reports stored before the sync facts existed have none
  ].join('\n');
}

/** "sync: remux (video copied) · sound night, Web Audio · dropped 12/14400 frames · A/V events 3 (1 reconnect, track switch)" */
function syncLine(s: StoredTiming): string {
  const how = s.delivery ? `${s.delivery}${s.videoCopy === null ? '' : s.videoCopy ? ' (video copied)' : ' (video converted)'}` : '?';
  const frames = s.totalFrames === null ? '–' : `${s.droppedFrames ?? 0}/${s.totalFrames}`;
  const why = [s.reconnects ? `${s.reconnects} reconnect${s.reconnects === 1 ? '' : 's'}` : '', s.trackSwitch ? 'track switch' : ''].filter(Boolean).join(', ');
  return `  sync: ${how} · sound ${s.soundMode}${s.audioRouted ? ', Web Audio' : ''} · dropped ${frames} frames · A/V events ${s.avEvents}${why ? ` (${why})` : ''}`;
}
