// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One line of the media server's log as the admin may see it (spec "Backend routes": the log is redacted by the updater, before it
 * leaves for the backend): terminal colours removed, the value after a key that carries a secret replaced with `…`, cut at 500
 * characters. The redaction runs before the cut, so a secret never survives as a half value.
 */
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)|[@-Z\\\\-_])`, 'g');
const KEYS = '(?:(?<![A-Za-z0-9])pw|api[_-]?key|token|x-emby-token|x-mediabrowser-token|authorization|password)';
/** key, an optional closing quote, `=` or `:`, an optional opening quote, then the value up to a space, `&`, `"` or `,` (a scheme word such as Bearer belongs to the value) */
const SECRET_RE = new RegExp(`(${KEYS}["']?\\s*[=:]\\s*["']?)(?:(?:bearer|basic|digest)\\s+)?[^\\s&",]*`, 'gi');
const MAX_LINE = 500;

export function redactLine(line: string): string {
  return line.replace(ANSI_RE, '').replace(SECRET_RE, '$1…').slice(0, MAX_LINE);
}
