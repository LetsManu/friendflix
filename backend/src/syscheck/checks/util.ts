// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HealthSnapshot, Level, Reason, ServiceHealth, ServiceId } from '../../health.js';
import { bad, line, type LineOpts } from '../line.js';
import type { CheckId, CheckLine, CheckStatus } from '../types.js';

/** Helpers the group checks share: reading the health snapshot into line statuses. */

/** the snapshot level as a line status (spec "Status rules"); `off` is not set up only when the reason says so */
export function levelToStatus(level: Level, reason?: Reason): CheckStatus {
  switch (level) {
    case 'err': return 'problem';
    case 'warn': return 'warning';
    case 'ok': return 'ok';
    default: return reason === 'not_set' ? 'not_set_up' : 'unknown';
  }
}

export const service = (s: HealthSnapshot | null, id: ServiceId): ServiceHealth | undefined => s?.services.find((x) => x.id === id);
export const msOf = (h: { ms?: number }) => (h.ms !== undefined ? { ms: h.ms } : {});

/** a timed service row: down → problem `<prefix>_down`, slow → warning `<prefix>_slow` (both with `o`), no row or off → unknown */
export function timedLine(id: CheckId, h: ServiceHealth | undefined, prefix: string, o: LineOpts = {}): CheckLine {
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok', msOf(h));
  if (status === 'problem') return bad(id, status, `${prefix}_down`, { ...msOf(h), ...o });
  if (status === 'warning') return bad(id, status, `${prefix}_slow`, { ...msOf(h), ...o });
  return bad(id, 'unknown', 'check_unavailable');
}
