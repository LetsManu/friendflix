// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The favourite star of a channel (ruling R27): a press while a save for the same channel runs is never lost.
 * Per channel id the latest intent is kept; the list shows it at once (`show`). When the running save settles and the latest
 * intent differs from what the server holds, exactly one more request goes out for it (last wins). A refused save puts the
 * list back to what the server holds (`show`); `send` reports it (toast) and answers whether it worked.
 */
export interface StarSync {
  /** the person pressed the star of `id`, which shows `current` right now; returns when nothing is left to send */
  toggle(id: string, current: boolean): Promise<void>;
}
export function starSync(o: { send: (id: string, on: boolean) => Promise<boolean>; show: (id: string, on: boolean) => void }): StarSync {
  const running = new Map<string, { want: boolean }>();
  return {
    async toggle(id, current) {
      const want = !current;
      o.show(id, want);
      const st = running.get(id);
      if (st) { st.want = want; return; } // the running save picks it up when it settles
      const mine = { want };
      running.set(id, mine);
      let held = current; // what the server holds
      try {
        while (mine.want !== held) {
          const sent = mine.want;
          if (await o.send(id, sent)) held = sent;
          else { mine.want = held; o.show(id, held); }
        }
      } finally {
        running.delete(id);
      }
    },
  };
}
