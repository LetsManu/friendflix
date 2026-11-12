// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Prefs } from '#lib/stores';

const KEY = 'ff.stillwatching';
const IDLE_MS = 90 * 60_000;
interface State { chain: number; lastInteraction: number }
let state: State | null = null;

function load(): State {
  if (state) return state;
  state = { chain: 0, lastInteraction: Date.now() };
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(KEY) : null;
    if (raw) { const s = JSON.parse(raw) as Partial<State>; if (Number.isFinite(s.chain) && Number.isFinite(s.lastInteraction)) state = { chain: s.chain!, lastInteraction: s.lastInteraction! }; }
  } catch { /* in-memory only */ }
  return state;
}
function persist() { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } }

/** A real viewer action (click, key, remote): the chain of unattended autoplays starts over. */
export function noteInteraction(now = Date.now()) {
  const s = load();
  s.chain = 0; s.lastInteraction = now; persist();
}
/** The next episode started by itself (countdown ran out). */
let autoplayed = false;
/** True once if the page was opened by the autoplay countdown (consumed on read). */
export function consumeAutoplay(): boolean { const a = autoplayed; autoplayed = false; return a; }
export function noteAutoplay() {
  autoplayed = true;
  const s = load();
  s.chain += 1; persist();
}
/** True when nobody touched anything for a long time or too many episodes autoplayed in a row. */
export function shouldAsk(now: number, p: Pick<Prefs, 'stillWatching' | 'stillWatchingEpisodes'>): boolean {
  if (!p.stillWatching) return false;
  const s = load();
  return s.chain >= (p.stillWatchingEpisodes || 3) || now - s.lastInteraction >= IDLE_MS;
}
/** how many episodes a continuous stream may carry before "Are you still watching?" would ask: 3 with the question off, else what is left of the chain (1..3) */
export function episodesBeforeAsk(p: Pick<Prefs, 'stillWatching' | 'stillWatchingEpisodes'>): number {
  if (!p.stillWatching) return 3;
  return Math.min(3, Math.max(1, 1 + (p.stillWatchingEpisodes || 3) - load().chain));
}
