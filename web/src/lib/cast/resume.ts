// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resume helpers of the Chromecast sender: the non-secret hint that a cast may still run, the public handle (castId) of a token
 * derived in the browser, and the rebuilt CastInfo of a re-adopted cast. The token, the content URL and the report token are
 * never stored; the hint holds the public castId only.
 */
import type { CastInfo } from '#lib/cast';

export const CAST_HINT_KEY = 'ff-cast-hint', CAST_LAST_KEY = 'ff-cast-last', HINT_SEEN_KEY = 'ff-cast-hint-seen';

/** `next`: the public handle of the queued successor on the receiver (a detached Stop revokes it too) */
export interface CastHint { castId: string; itemId: string; device: string; exp: number; at: number; next?: string }
export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

/** answer of GET /api/cast/session/:castId (token-free; see backend `CastLookup`) */
export interface CastLookup {
  castId: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  expiresAt: number;
  runtimeTicks?: number;
  via: 'chromecast' | 'airplay';
  next: boolean;
  reported: boolean;
  title: string;
  seriesName?: string;
  subtitles: Array<{ index: number; language?: string; title: string }>;
  pins: 0 | 1 | 2;
  /** the family of the TV's pinned address (never the address); null while unpinned */
  pinFamily: 'v4' | 'v6' | null;
  refused: { count: number; families: Array<'v4' | 'v6'> };
}

const CAST_ID = /^[0-9a-f]{32}$/;
/** an item id that is safe in a path segment (`/api/items/<id>`, `/watch/<id>`) */
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** the hint if it is well formed and not expired (`exp` and `now` in the same unit, ms); null otherwise, also when storage throws */
export function readHint(store: Store, now: number): CastHint | null {
  try {
    const raw = store?.getItem(CAST_HINT_KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as Partial<CastHint> | null;
    if (!h || typeof h !== 'object') return null;
    if (typeof h.castId !== 'string' || !CAST_ID.test(h.castId)) return null;
    if (typeof h.itemId !== 'string' || !ITEM_ID.test(h.itemId) || typeof h.device !== 'string' || !finite(h.exp) || !finite(h.at)) return null;
    if (h.exp <= now) return null;
    const next = typeof h.next === 'string' && CAST_ID.test(h.next) ? h.next : undefined;
    return { castId: h.castId, itemId: h.itemId, device: h.device, exp: h.exp, at: h.at, ...(next ? { next } : {}) };
  } catch {
    return null;
  }
}
export function writeHint(store: Store, h: CastHint): void {
  const v = { castId: h.castId, itemId: h.itemId, device: h.device, exp: h.exp, at: h.at, ...(h.next ? { next: h.next } : {}) };
  try { store?.setItem(CAST_HINT_KEY, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}
export function clearHint(store: Store): void {
  try { store?.removeItem(CAST_HINT_KEY); } catch { /* storage blocked */ }
}

/** the TV the user cast to last time (Play on sheet) */
export function lastDevice(store: Store): string | null {
  try {
    const v = store?.getItem(CAST_LAST_KEY);
    return v ? v : null;
  } catch {
    return null;
  }
}
export function rememberDevice(store: Store, name: string): void {
  const v = name.trim().slice(0, 80);
  if (!v) return;
  try { store?.setItem(CAST_LAST_KEY, v); } catch { /* storage full or blocked */ }
}

/** the 43-char base64url token right after `/media/c/` of a cast content URL, else null */
export function tokenOfContentUrl(url: string): string | null {
  const m = /\/media\/c\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(url);
  return m ? m[1]! : null;
}

export const sha256Hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
};

/** the token's public handle: the first 32 hex characters of sha256(token) (as the backend's `castIdOf(hashToken(token))`) */
export async function castIdOfContentUrl(url: string, digest: (s: string) => Promise<string>): Promise<string | null> {
  const token = tokenOfContentUrl(url);
  if (!token) return null;
  try {
    const id = (await digest(token)).slice(0, 32);
    return CAST_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** the CastInfo of a re-adopted cast: the receiver's own content URL, no subtitle URLs (they are already on the receiver) */
export function lookupToCastInfo(l: CastLookup, contentUrl: string): CastInfo {
  return {
    castId: l.castId,
    expiresAt: l.expiresAt,
    playSessionId: l.playSessionId,
    mediaSourceId: l.mediaSourceId,
    ...(l.runtimeTicks ? { runtimeTicks: l.runtimeTicks } : {}),
    startTime: 0,
    contentUrl,
    contentType: 'application/x-mpegURL',
    hlsSegmentFormat: 'ts',
    title: l.title,
    ...(l.seriesName ? { seriesName: l.seriesName } : {}),
    subtitles: l.subtitles.map((s) => ({ index: s.index, ...(s.language ? { language: s.language } : {}), title: s.title, url: '' })),
  };
}
