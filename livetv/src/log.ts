// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * livetv's log: one line per entry, codes, channel ids and counts only. Never a provider URL, a stream URL, an SRT stream id or
 * passphrase, ffmpeg arguments or INTERNAL_SECRET (plan Global Constraints "Secrets"); callers pass fixed texts.
 */
export type Log = (msg: string) => void;
const MAX = 500;

export function createLog(write: (line: string) => void = (l) => console.log(l), now: () => Date = () => new Date()): Log {
  return (msg) => write(`${now().toISOString()} livetv: ${msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX)}`);
}

export const log: Log = createLog();
