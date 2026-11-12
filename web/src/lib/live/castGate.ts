// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** How long a local start waits for a live cast on the TV to be re-adopted (about the SDK's join plus the receiver's first status). */
export const CAST_ADOPT_WAIT_MS = 3000;

/**
 * Whether the player may start the channel on this device now. A live hint (this browser left a live cast running) means the channel may
 * already play on the TV: a local watch would then start a second stream next to it, so the engine gets a bounded chance to re-adopt the
 * cast first. true = start locally (no hint, the app's shell, or nothing came back within `waitMs`); false = a live cast is ours again
 * (the player follows it as its remote). `hasLive`: the engine already shows a live cast.
 */
export async function startsLocally(o: {
  hint: boolean; inShell: boolean; resume: () => Promise<boolean>; hasLive: () => boolean; waitMs?: number;
}): Promise<boolean> {
  if (!o.hint || o.inShell) return !o.hasLive();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const adopted = await Promise.race([
    o.resume().catch(() => false),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), o.waitMs ?? CAST_ADOPT_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  return !(adopted || o.hasLive());
}
