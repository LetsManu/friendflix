// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Polls GET /api/admin/updater while an update runs (updater card and the page without an updater share it). A failed poll is the
 * backend restarting in the middle: "reconnecting", polled a little slower, never an error. Gives up after WATCH_MAX_MS. stop()
 * also stops a poll that is still in flight from scheduling the next one (a card destroyed mid-poll keeps nothing running).
 */
import { WATCH_MAX_MS, nextPoll } from './updater';

export interface WatchOpts {
  /** one poll: true when the backend answered */
  poll: () => Promise<boolean>;
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
  let gen = 0;
  let t0 = 0;
  const stop = () => { gen++; clearTimeout(timer); timer = undefined; t0 = 0; };
  function start() {
    stop();
    const mine = gen;
    t0 = now();
    const tick = async () => {
      const ok = await o.poll();
      if (mine !== gen) return; // stopped (or restarted) while the poll was in flight
      o.tick?.(ok);
      if (ok && !o.busy()) { stop(); o.done(); return; }
      if (now() - t0 > WATCH_MAX_MS) { stop(); o.timeout(); return; }
      timer = setTimeout(tick, nextPoll(!ok));
    };
    timer = setTimeout(tick, nextPoll(false));
  }
  return { start, stop, get running() { return timer !== undefined; } };
}
