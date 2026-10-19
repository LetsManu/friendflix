// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Play hand-off to the app: Play buttons ask the native player first and fall back to the web player on any "no".
import { native, type NativeCapabilities, type NativePlayRequest } from './bridge';

export const MAX_START_MS = 7 * 24 * 60 * 60 * 1000;
const TRACK = /^[A-Za-z0-9_-]{1,32}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

let capsOk: NativeCapabilities | null = null;
/** capabilities never change within a page load: ask once (a failed or timed-out answer is not remembered) */
export async function nativeCaps(): Promise<NativeCapabilities> {
  if (capsOk) return capsOk;
  const c = await native.capabilities();
  if (c.api > 0) capsOk = c;
  return c;
}
export const resetNativeCaps = () => { capsOk = null; };

/** Build the bridge's play request; null when the profile or item id is unusable. Fields the bridge would reject are left out. */
export function playRequest(item: { id: string; positionTicks?: number }, profileId: unknown, opts: { audio?: string; subtitle?: string } = {}): NativePlayRequest | null {
  if (typeof profileId !== 'string' || !ID.test(profileId) || !ID.test(item.id)) return null;
  const req: NativePlayRequest = { itemId: item.id, profileId };
  const ms = Math.floor((item.positionTicks ?? 0) / 10_000);
  if (Number.isFinite(ms) && ms > 0 && ms <= MAX_START_MS) req.startMs = ms;
  if (opts.audio && TRACK.test(opts.audio)) req.audio = opts.audio;
  if (opts.subtitle && TRACK.test(opts.subtitle)) req.subtitle = opts.subtitle;
  return req;
}

/** true = the native player started this title; false (any reason) = play it in the page */
export async function tryNativePlay(item: { id: string; positionTicks?: number }, opts?: { audio?: string; subtitle?: string }): Promise<boolean> {
  try {
    if (!native.available || !(await nativeCaps()).play) return false;
    const { getMe } = await import('#lib/offline/manager');
    const req = playRequest(item, (await getMe())?.profile?.id, opts);
    return req ? await native.play(req) : false;
  } catch {
    return false;
  }
}
