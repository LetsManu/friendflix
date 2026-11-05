// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// First-frame watchdog: a direct-played original that shows no picture within a deadline is given up on (the caller switches to the converted stream).
// The clock starts when the caller intends to play (opts.running) and holds on `pause` / resumes on `play`: a pause, a blocked autoplay or a party hold is not a decode failure.

export const FIRST_FRAME_MS = 10_000;

/** Fires `onTimeout` once after `ms` of playing time unless `loadeddata` or `playing` arrives first. Returns a cancel function. */
export function watchFirstFrame(video: Pick<HTMLVideoElement, 'addEventListener' | 'removeEventListener'>, ms: number, onTimeout: () => void, opts: { running: boolean } = { running: true }): () => void {
  let done = false, left = ms, startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (done || timer !== undefined) return;
    startedAt = Date.now();
    timer = setTimeout(() => { timer = undefined; if (done) return; stop(); onTimeout(); }, left);
  };
  const hold = () => {
    if (done || timer === undefined) return;
    clearTimeout(timer); timer = undefined;
    left = Math.max(0, left - (Date.now() - startedAt));
  };
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer); timer = undefined;
    video.removeEventListener('loadeddata', stop);
    video.removeEventListener('playing', stop);
    video.removeEventListener('play', run);
    video.removeEventListener('pause', hold);
  };
  video.addEventListener('loadeddata', stop);
  video.addEventListener('playing', stop);
  video.addEventListener('play', run);
  video.addEventListener('pause', hold);
  if (opts.running) run(); // the player's play intent, not video.paused: a fresh element is paused until canplay, which never comes if nothing decodes
  return stop;
}
