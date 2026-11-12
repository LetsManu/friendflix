// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resume helpers of the Chromecast sender: the non-secret hint that a cast may still run, the public handle (castId) of a token
 * derived in the browser, and the rebuilt CastInfo of a re-adopted cast. The token, the content URL and the report token are
 * never stored; the hint holds the public castId only.
 */
import type { CastInfo } from '#lib/cast';

export const CAST_HINT_KEY = 'ff-cast-hint', CAST_LAST_KEY = 'ff-cast-last', HINT_SEEN_KEY = 'ff-cast-hint-seen';

/**
 * `next`: the public handle of the queued successor on the receiver (a detached Stop revokes it too).
 * `kind: 'live'`: a live channel (live TV spec §13): `itemId` is the channel id, `castId` the first 32 hex of sha256(the live token in the
 * receiver's content URL), `live` what the bar shows before anything is known (never the token or the URL).
 */
export interface CastHint {
  castId: string; itemId: string; device: string; exp: number; at: number; next?: string;
  kind?: 'live'; live?: { number: number | null; name: string };
}
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
/** a live channel id (a provider entry's key may carry a `:2` suffix) */
const CHANNEL_ID = /^[A-Za-z0-9_:.-]{1,80}$/;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** the hint if it is well formed and not expired (`exp` and `now` in the same unit, ms); null otherwise, also when storage throws */
export function readHint(store: Store, now: number): CastHint | null {
  try {
    const raw = store?.getItem(CAST_HINT_KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as Partial<CastHint> | null;
    if (!h || typeof h !== 'object') return null;
    if (typeof h.castId !== 'string' || !CAST_ID.test(h.castId)) return null;
    const live = h.kind === 'live';
    if (typeof h.itemId !== 'string' || !(live ? CHANNEL_ID : ITEM_ID).test(h.itemId) || typeof h.device !== 'string' || !finite(h.exp) || !finite(h.at)) return null;
    if (h.exp <= now) return null;
    if (live) {
      const l = (h.live && typeof h.live === 'object' ? h.live : {}) as Partial<NonNullable<CastHint['live']>>;
      const name = typeof l.name === 'string' ? l.name.slice(0, 200) : '';
      const number = typeof l.number === 'number' && Number.isInteger(l.number) && l.number > 0 ? l.number : null;
      return { castId: h.castId, itemId: h.itemId, device: h.device, exp: h.exp, at: h.at, kind: 'live', live: { number, name } };
    }
    const next = typeof h.next === 'string' && CAST_ID.test(h.next) ? h.next : undefined;
    return { castId: h.castId, itemId: h.itemId, device: h.device, exp: h.exp, at: h.at, ...(next ? { next } : {}) };
  } catch {
    return null;
  }
}
export function writeHint(store: Store, h: CastHint): void {
  const v = { castId: h.castId, itemId: h.itemId, device: h.device, exp: h.exp, at: h.at, ...(h.next ? { next: h.next } : {}),
    ...(h.kind === 'live' ? { kind: 'live', live: h.live ?? { number: null, name: '' } } : {}) };
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

/** the live token right after `/media/l/` of a live content URL (`/media/l/<token>/index.m3u8`), else null */
export function tokenOfLiveUrl(url: string): string | null {
  const m = /\/media\/l\/([A-Za-z0-9_-]{1,128})\//.exec(url);
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

/**
 * the CastInfo of a re-adopted cast: the receiver's own content URL, no subtitle URLs (they are already on the receiver). It carries no `delivery`,
 * so a re-adopted cast has no early-ERROR fallback for HEVC / surround: a TV error right after a reload takes the plain error path.
 */
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
