// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { native } from './bridge';
import { nativeCaps } from './play';

/** the longest a sign-out / switch waits for the app (capabilities question and call together; the app promises its answer within about 3 s) */
export const SESSION_WAIT_MS = 4000;

/**
 * Tells the Android app who is signed in now: the new profile's id after a profile switch, null on sign-out. The app ends a cast that belongs
 * to another profile / to nobody (stop report, token revoke) and answers when that has left (about 3 s at most), so a sign-out awaits this,
 * but never longer than SESSION_WAIT_MS. The capabilities are the cached ones when the page already asked. Only inside the app with API 2
 * or newer: an older app does not know the method and is not sent it. Never throws.
 */
export async function tellAppSession(profileId: string | null): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!native.available) return;
    await Promise.race([
      (async () => { if ((await nativeCaps()).api >= 2) await native.sessionChanged(profileId); })(),
      new Promise<void>((r) => { timer = setTimeout(r, SESSION_WAIT_MS); }),
    ]);
  } catch { /* best effort: the sign-out / switch goes on */ } finally { clearTimeout(timer); }
}
