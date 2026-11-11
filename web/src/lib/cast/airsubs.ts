// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "This TV refused the subtitle stream" memory (AirPlay subtitles travel inside the stream; some TVs reject it). One timestamp in
 * `localStorage`, 30 days. While it is fresh, AirPlay tokens are requested without subtitles and the Subtitles chip says
 * "Off (TV refused)"; picking subtitles again on the remote forgets it.
 */
export const SUBS_REFUSED_KEY = 'ff-air-subs-refused';
export const SUBS_REFUSED_MS = 30 * 24 * 3600_000;

/** the part of `Storage` used here (null / throwing storage = nothing remembered) */
export interface SubsStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** the refusal is younger than 30 days (a missing, malformed or future-dated value is not a refusal) */
export function subsRefusedRecently(store: SubsStore | null | undefined, now: number): boolean {
  try {
    const raw = store?.getItem(SUBS_REFUSED_KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) && at <= now && now - at < SUBS_REFUSED_MS;
  } catch { return false; }
}
export function rememberSubsRefused(store: SubsStore | null | undefined, now: number): void {
  try { store?.setItem(SUBS_REFUSED_KEY, String(now)); } catch { /* blocked storage: only this visit knows */ }
}
export function forgetSubsRefused(store: SubsStore | null | undefined): void {
  try { store?.removeItem(SUBS_REFUSED_KEY); } catch { /* nothing to forget */ }
}

/**
 * The `subtitleIndex` part of an AirPlay token request (the Player's first token and the engine's later ones): the chosen text track,
 * left out when subtitles are off, in the retry after a TV refused them (`noSubs`), without the server's capability, or while a
 * refusal is fresh.
 */
export function airSubBody(sub: number, noSubs: boolean, store: SubsStore | null | undefined, now: number, capsOk: boolean): { subtitleIndex?: number } {
  return !noSubs && sub >= 0 && capsOk && !subsRefusedRecently(store, now) ? { subtitleIndex: sub } : {};
}
