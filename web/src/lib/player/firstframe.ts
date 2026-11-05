// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// First-frame watchdog: a direct-played original that shows no picture within a deadline is given up on (the caller switches to the converted stream).

export const FIRST_FRAME_MS = 10_000;

/** Fires `onTimeout` once after `ms` unless `loadeddata` or `playing` arrives first. Returns a cancel function. */
export function watchFirstFrame(video: Pick<HTMLVideoElement, 'addEventListener' | 'removeEventListener'>, ms: number, onTimeout: () => void): () => void {
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    video.removeEventListener('loadeddata', stop);
    video.removeEventListener('playing', stop);
  };
  const timer = setTimeout(() => { if (done) return; stop(); onTimeout(); }, ms);
  video.addEventListener('loadeddata', stop);
  video.addEventListener('playing', stop);
  return stop;
}
