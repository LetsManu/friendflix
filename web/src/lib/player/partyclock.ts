// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Watch party clock (routes/party/[id]): the offset between this device's clock and the server's, so `expected()` can say where
 * the room is right now. The good estimate comes from the ping answers (server time + half the round trip, best round trip wins).
 * The server time stamp on `welcome` / `state` messages has no round-trip correction (it is late by the one-way delay), so it is
 * only used until the first ping answer arrived: overwriting the corrected offset with it made the expected position jump on every
 * state message, which caused extra rate flips and seeks.
 */
export interface PartyClock {
  /** server time minus local time, ms */
  offset: number;
  /** best round trip seen so far (Infinity = no ping answer yet) */
  bestRtt: number;
}

export const freshClock = (): PartyClock => ({ offset: 0, bestRtt: Infinity });

/** `welcome` / `state`: the raw server time stamp, adopted only while no round-trip corrected estimate exists */
export function onServerStamp(c: PartyClock, serverNow: number, localNow: number): PartyClock {
  if (!Number.isFinite(serverNow) || c.bestRtt !== Infinity) return c;
  return { ...c, offset: serverNow - localNow };
}

/**
 * `pong` (`sentAt` = our ping's local time, `serverAt` = the server's time when it answered): a faster round trip wins; now and then
 * (`sample` < 0.1) a slower one is taken too, and the best round trip is allowed to grow by 20 %, so a changed network is followed.
 */
export function onPong(c: PartyClock, sentAt: number, serverAt: number, localNow: number, sample: number): PartyClock {
  const rtt = localNow - sentAt;
  if (!Number.isFinite(rtt) || !Number.isFinite(serverAt) || rtt < 0) return c;
  if (rtt >= c.bestRtt && sample >= 0.1) return c;
  return { bestRtt: Math.min(rtt, c.bestRtt * 1.2), offset: serverAt + rtt / 2 - localNow };
}
