// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** what the attached stream met while a switch's watch is out: run only if the switch is refused and the stream stays */
export interface Held {
  run: () => void;
  /** a fatal error (not a refusal) */
  fatal: boolean;
  /** that fatal error is a MEDIA_ERROR (recoverable), not an unrecoverable network or other fatal */
  media: boolean;
}

/**
 * Which of two things the stream met stays held: the first fatal error wins over refusals, else the latest refusal. A fatal error
 * that is not a media error replaces a held fatal media error, so an unrecoverable fatal is never hidden behind a recoverable one.
 */
export function pickHeld(cur: Held | null, next: Held): Held {
  if (!cur || !cur.fatal) return next;
  if (next.fatal && cur.media && !next.media) return next;
  return cur;
}
