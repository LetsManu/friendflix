// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { native } from './bridge';
import { nativeCaps } from './play';

/**
 * Tells the Android app who is signed in now: the new profile's id after a profile switch, null on sign-out. The app ends a cast that belongs
 * to another profile / to nobody (stop report, token revoke) and answers when that has left (about 3 s at most), so a sign-out awaits this.
 * Only inside the app with API 2 or newer: an older app does not know the method and is not sent it. Never throws.
 */
export async function tellAppSession(profileId: string | null): Promise<void> {
  try {
    if (!native.available || (await nativeCaps()).api < 2) return;
    await native.sessionChanged(profileId);
  } catch { /* best effort: the sign-out / switch goes on */ }
}
