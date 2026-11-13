// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RunningChannel } from './api';

/** What the live player shows (spec §12.5). Pure: LivePlayer.svelte owns the timers that move between the states. */
export type LiveUi =
  | { k: 'starting' }
  | { k: 'playing' }
  | { k: 'buffering' }
  | { k: 'lost'; attempt: number }
  | { k: 'unreachable'; attempt: number }
  | { k: 'retry' }
  | { k: 'notReceiving' }
  | { k: 'full'; running: RunningChannel[] }
  | { k: 'providerLimit'; max: number; running: RunningChannel[] }
  | { k: 'forbidden' }
  | { k: 'maxStreams'; max: number }
  | { k: 'off' }
  /** an admin stopped it (409 stopped_by_admin): no reconnects by itself, *Erneut versuchen* by hand (bughunt L3) */
  | { k: 'stopped' };

/** the two input-lost states: the card "Sender gerade nicht erreichbar" + "Verbinde neu …" with its reconnect attempts */
export type LostUi = Extract<LiveUi, { k: 'lost' } | { k: 'unreachable' }>;

/** a playlist that stalls longer than this counts as input lost */
export const STALL_LOST_MS = 8000;
/** after this long without a picture the player stops reconnecting by itself and offers *Erneut versuchen* */
export const LOST_GIVE_UP_MS = 120_000;
const LOST_STEPS = [2000, 4000, 8000, 16_000, 30_000, 60_000];

/** the wait before reconnect attempt `attempt` (0-based): 2, 4, 8, 16, 30, then 60 s */
export function lostDelay(attempt: number): number {
  const i = Number.isFinite(attempt) ? Math.max(0, Math.min(LOST_STEPS.length - 1, Math.floor(attempt))) : 0;
  return LOST_STEPS[i]!;
}

/** after a wait: the next attempt, or *Erneut versuchen* once two minutes have passed since the outage began */
export function nextLost(ui: LostUi, elapsedMs: number): LostUi | { k: 'retry' } {
  if (elapsedMs >= LOST_GIVE_UP_MS) return { k: 'retry' };
  return { k: ui.k, attempt: ui.attempt + 1 };
}

/**
 * A refused `watch` (Task 35's WatchError, F23) as the player's state: 502 channel_unreachable is the input-lost card with
 * reconnects, 404 livetv_off the off message (no retry), 409 stopped_by_admin the stopped card (a retry by hand only, so the
 * player's own reconnects never undo an admin's stop), every other 403/404 forbidden. Anything unexpected is input lost, so the
 * player keeps trying instead of stopping at an empty screen.
 *
 * `again` (bughunt M1): the watch is for the channel that was already playing (the one re-watch after a refused token, a start of
 * the lost cycle). There `livetv_off` is a livetv that is restarting (detection missed it for a moment), not an admin's decision:
 * the input-lost cycle with its backoff, which ends at *Erneut versuchen* after two minutes if it really stays off.
 */
export function fromWatchError(status: number, body: unknown, o: { again?: boolean } = {}): LiveUi {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const running = Array.isArray(b.running) ? (b.running as RunningChannel[]) : [];
  const max = typeof b.max === 'number' && Number.isFinite(b.max) ? b.max : 0;
  switch (status) {
    case 503:
      if (b.error === 'live_full') return { k: 'full', running };
      if (b.error === 'provider_limit') return { k: 'providerLimit', max, running };
      break;
    case 502:
      if (b.error === 'channel_unreachable') return { k: 'unreachable', attempt: 0 };
      break;
    case 409:
      if (b.error === 'not_receiving') return { k: 'notReceiving' };
      if (b.error === 'stopped_by_admin') return { k: 'stopped' };
      break;
    case 429:
      if (b.error === 'max_streams') return { k: 'maxStreams', max };
      break;
    case 403:
      return { k: 'forbidden' };
    case 404:
      if (b.error === 'livetv_off') return o.again ? { k: 'unreachable', attempt: 0 } : { k: 'off' };
      return { k: 'forbidden' };
    default:
      break;
  }
  return { k: 'lost', attempt: 0 };
}
