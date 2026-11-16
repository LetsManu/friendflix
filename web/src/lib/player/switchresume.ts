// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether playback resumes after a source switch (audio track, quality, surround, a downloaded subtitle). The switch used to call
 * video.play() right after load(): that raced the attach of the new stream (an hls.js attach, or a fresh element for the plain sound
 * path, resets the element and rejects a pending play), the error was swallowed and the film stayed paused. The answer goes to the
 * start path instead (wantAutoplay, then the new stream's `canplay` calls playSafe, which also starts muted or leaves the play button
 * when the browser refuses), so it is decided here once:
 * - it was playing, or a start was still pending (a switch before the first frame): resume
 * - it was paused: stay paused
 * - the server refused the switch (busy): its error shows, nothing starts
 */
export const resumeAfterSwitch = (s: { wasPlaying: boolean; pending: boolean; result: 'busy' | undefined }): boolean =>
  s.result !== 'busy' && (s.wasPlaying || s.pending);
