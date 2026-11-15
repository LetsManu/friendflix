// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Polls GET /api/admin/updater while an update runs (updater card and the page without an updater share it). A failed poll is the
 * backend restarting in the middle: "reconnecting", never an error; while it stays away the polls back off (3 s, 6 s, at most 10 s)
 * and an answer resets that. Each poll is aborted after POLL_TIMEOUT_MS (a backend half up must not stall the loop). Gives up after
 * WATCH_MAX_MS. stop() aborts a poll in flight and keeps it from scheduling the next one (a card destroyed mid-poll keeps nothing running).
 */
import { POLL_MS, WATCH_MAX_MS } from './updater';

export const POLL_TIMEOUT_MS = 10_000;
const AWAY_MS = [3_000, 6_000, 10_000] as const;
/** the wait before the next poll after `fails` failed polls in a row */
export const backoff = (fails: number): number => (fails <= 0 ? POLL_MS : AWAY_MS[Math.min(fails, AWAY_MS.length) - 1]!);

export interface WatchOpts {
  /** one poll: true when the backend answered; pass `signal` on to the request */
  poll: (signal: AbortSignal) => Promise<boolean>;
  /** still something to follow (read after each answered poll) */
  busy: () => boolean;
  /** after every poll: whether it answered */
  tick?: (ok: boolean) => void;
  /** it ended (answered and nothing runs any more) */
  done: () => void;
  /** no end within WATCH_MAX_MS */
  timeout: () => void;
}

export function watcher(o: WatchOpts, now: () => number = Date.now) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ctrl: AbortController | null = null;
  let gen = 0;
  let t0 = 0;
  const stop = () => { gen++; clearTimeout(timer); timer = undefined; ctrl?.abort(); ctrl = null; t0 = 0; };
  function start() {
    stop();
    const mine = gen;
    let fails = 0;
    t0 = now();
    const tick = async () => {
      const c = new AbortController();
      ctrl = c;
      const limit = setTimeout(() => c.abort(), POLL_TIMEOUT_MS);
      const ok = await o.poll(c.signal).catch(() => false).finally(() => clearTimeout(limit));
      if (mine !== gen) return; // stopped (or restarted) while the poll was in flight
      ctrl = null;
      fails = ok ? 0 : fails + 1;
      o.tick?.(ok);
      if (ok && !o.busy()) { stop(); o.done(); return; }
      if (now() - t0 > WATCH_MAX_MS) { stop(); o.timeout(); return; }
      timer = setTimeout(tick, backoff(fails));
    };
    timer = setTimeout(tick, POLL_MS);
  }
  return { start, stop, get running() { return timer !== undefined || ctrl !== null; } };
}
