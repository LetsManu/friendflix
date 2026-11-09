// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The fresh <video> that brings the plain sound path back after the sound modes were switched off (lib/player/audiofx.ts:
 * a MediaElementSource cannot be released, so the film moves to a new element). Seamless while paused: the new element shows a
 * snapshot of the current frame as its poster, the stream is attached again at the same position, and the poster goes once
 * the new element has its own frame there. The position, the pause state, speed, volume and subtitles stay as they were.
 */

/** while paused, nothing else going on: the only moment a new element cannot be noticed */
export interface SwapState {
  paused: boolean;
  /** a watch party: its drift correction and listeners are bound to the current element */
  party: boolean;
  /** Chromecast / AirPlay / a stream handed to the cast engine: the local element is not the one playing */
  remote: boolean;
  /** Safari's AirPlay controller watches the current element */
  airplay: boolean;
  /** an error, a reconnect, a quality switch or an earlier swap is in progress */
  busy: boolean;
  /** the small credits picture (moving transforms): wait for the full picture */
  creditsCorner: boolean;
}
export const swapAllowed = (s: SwapState): boolean => s.paused && !s.party && !s.remote && !s.airplay && !s.busy && !s.creditsCorner;

type FrameSource = Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight' | 'readyState'> & CanvasImageSource;
type CanvasLike = { width: number; height: number; getContext(id: '2d'): { drawImage(v: CanvasImageSource, x: number, y: number, w: number, h: number): void } | null; toDataURL(type: string, q: number): string };

/** the current frame as a JPEG data URL, or null (no frame yet, no canvas, or a tainted picture) */
export function snapshotFrame(v: FrameSource, makeCanvas: () => CanvasLike = () => document.createElement('canvas') as unknown as CanvasLike): string | null {
  try {
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    const c = makeCanvas();
    c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.92);
    return url.startsWith('data:image/') ? url : null;
  } catch { return null; } // SecurityError: cross-origin picture without CORS
}

type FrameTarget = Pick<HTMLMediaElement, 'seeking' | 'readyState' | 'currentTime' | 'addEventListener' | 'removeEventListener'>;
const FRAME_EVENTS = ['loadeddata', 'canplay', 'seeked', 'timeupdate'] as const;

/**
 * Resolves true once `v` shows a frame at `pos` (±1 s: the stream starts at a segment / keyframe), false after `timeoutMs` (the poster
 * goes then anyway: a black frame is better than a frozen one when the stream is slow).
 */
export function frameShown(v: FrameTarget, pos: number, timeoutMs = 5000): Promise<boolean> {
  const ok = () => !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - pos) < 1;
  return new Promise((resolve) => {
    if (ok()) { resolve(true); return; }
    const done = (r: boolean) => {
      clearTimeout(timer);
      for (const e of FRAME_EVENTS) v.removeEventListener(e, check);
      resolve(r);
    };
    const check = () => { if (ok()) done(true); };
    const timer = setTimeout(() => done(false), timeoutMs);
    for (const e of FRAME_EVENTS) v.addEventListener(e, check);
  });
}
