// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Route } from '@playwright/test';
import { HLS_INIT, HLS_SEGMENTS } from './hls.js';
import { png } from './png.js';

/**
 * The user side of Live TV (backend: livetv/routes.ts, Tasks 31 and 33, not built yet; the shapes are web/src/lib/live/api.ts):
 * the channel list with its ETag, watch / beat / stop, favourites, the last channel, preview and logo images, and a sliding live
 * playlist without ENDLIST built from HLS_SEGMENTS (the player specs of Task 39 use it).
 *
 * Fixed fictional data around Thursday 2026-11-12 20:37 local time (the specs install a fake clock there): programmes are built from
 * local clock times, so they fit in any time zone. Every channel carries `groupPos` (the position of its group).
 */
export interface MockProg { title: string; start: string; end: string; subtitle?: string }
export interface MockChannel {
  id: string; number: number; name: string; logo: string | null; groupId: string | null; running: boolean; receiving?: boolean;
  epg: 'ok' | 'gap' | 'none'; preview?: string; now?: MockProg; next?: MockProg; favourite: boolean; groupPos?: number;
}
export interface LivetvMock {
  /** GET /api/livetv/channels answers this (`favourite` of a channel follows `favourites`) */
  groups: Array<{ id: string; name: string }>;
  channels: MockChannel[];
  favourites: string[];
  recent: string[];
  dvrSeconds: number;
  /** the list's version: every change bumps it, it is the ETag; a request with the current one answers 304 */
  version: number;
  /** GET /api/livetv/channels requests: the If-None-Match they sent */
  gets: Array<string | null>;
  /** calls that change something, "METHOD /path body" */
  calls: string[];
  /** the list answers this status instead (401 = the session is gone) */
  status: number;
  /** POST .../watch answers this error instead of a watch answer */
  watchError: { status: number; body: Record<string, unknown> } | null;
  /** when the sliding playlist's first segment started (ms since epoch), set on the first request */
  liveStart: number | null;
}

const at = (h: number, m: number): string => new Date(2026, 10, 12, h, m, 0, 0).toISOString();
const prog = (title: string, from: [number, number], to: [number, number]): MockProg => ({ title, start: at(...from), end: at(...to) });

const GROUPS = [{ id: 'g-allg', name: 'Allgemein' }, { id: 'g-sport', name: 'Sport' }, { id: 'g-kinder', name: 'Kinder' }];
const gpos = (id: string): number => GROUPS.findIndex((g) => g.id === id);
const logo = (id: string) => `/api/livetv/logos/${id}.png`;
const preview = (id: string) => `/api/livetv/channels/${id}/preview.jpg`;

export function livetvState(): LivetvMock {
  const ch = (c: Omit<MockChannel, 'favourite' | 'groupPos' | 'logo'> & { groupId: string }): MockChannel => ({ ...c, logo: logo(c.id), favourite: false, groupPos: gpos(c.groupId) });
  return {
    groups: GROUPS,
    channels: [
      ch({ id: 'ch-nord', number: 1, name: 'Nordlicht TV', groupId: 'g-allg', running: true, epg: 'ok', preview: preview('ch-nord'), now: prog('Die Leuchtturmwärter', [20, 15], [21, 0]), next: prog('Wetter am Hafen', [21, 0], [21, 15]) }),
      ch({ id: 'ch-hafen', number: 4, name: 'Hafenkanal', groupId: 'g-allg', running: true, epg: 'ok', preview: preview('ch-hafen'), now: prog('Wetter am Hafen', [20, 30], [21, 30]), next: prog('Abenteuer Wattenmeer', [21, 30], [22, 30]) }),
      // a push feed that is not sending
      ch({ id: 'ch-berg', number: 7, name: 'Bergblick Sport', groupId: 'g-sport', running: false, receiving: false, epg: 'ok' }),
      ch({ id: 'ch-kinder', number: 12, name: 'Kinderinsel', groupId: 'g-kinder', running: false, epg: 'ok', now: prog('Abenteuer Wattenmeer', [20, 0], [21, 30]), next: prog('Sternstunde Physik', [21, 30], [22, 0]) }),
      // no EPG mapping
      ch({ id: 'ch-stern', number: 21, name: 'Sternwarte 24', groupId: 'g-allg', running: false, epg: 'none' }),
      // mapped to an EPG, but the provider's data ran out
      ch({ id: 'ch-wolke', number: 30, name: 'Kanal Wolkenlos', groupId: 'g-allg', running: false, epg: 'gap' }),
    ],
    favourites: ['ch-nord', 'ch-hafen', 'ch-kinder'],
    recent: ['ch-kinder', 'ch-hafen'],
    dvrSeconds: 1800,
    version: 1,
    gets: [],
    calls: [],
    status: 200,
    watchError: null,
    liveStart: null,
  };
}

/** change one channel the way new programme data would (the list's ETag moves) */
export function patchChannel(st: LivetvMock, id: string, patch: Partial<MockChannel>): void {
  st.channels = st.channels.map((c) => (c.id === id ? { ...c, ...patch } : c));
  st.version++;
}
export const progAt = prog;

const list = (st: LivetvMock) => ({
  groups: st.groups,
  channels: st.channels.map((c) => ({ ...c, favourite: st.favourites.includes(c.id) })),
  favourites: st.favourites,
  recent: st.recent,
  last: st.recent.length ? { id: st.recent[0]!, previous: st.recent[1] ?? null } : null,
  dvrSeconds: st.dvrSeconds,
});

/** 2 s per segment, six segments in the window; the sequence number rises with time and the payload cycles through HLS_SEGMENTS */
const SEG_S = 2, WINDOW = 6;
export function livePlaylist(st: LivetvMock, nowMs: number): string {
  st.liveStart ??= nowMs;
  const seq = Math.floor((nowMs - st.liveStart) / (SEG_S * 1000));
  const first = new Date(st.liveStart + seq * SEG_S * 1000).toISOString();
  return ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${SEG_S}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`, '#EXT-X-MAP:URI="init.mp4"', `#EXT-X-PROGRAM-DATE-TIME:${first}`,
    ...Array.from({ length: WINDOW }, (_, i) => [`#EXTINF:${SEG_S}.000000,`, `s${seq + i}.m4s`]).flat(), ''].join('\n');
}

type Reply = (b: unknown, status?: number) => Promise<void>;

/** `/api/livetv/**`; null = not a live TV path */
export function livetvRoute(st: LivetvMock, m: string, p: string, body: any, headers: Record<string, string>, J: Reply, route: Route): Promise<void> | null {
  let mm: RegExpMatchArray | null;
  const bump = () => { st.version++; };
  if (p === '/api/livetv/channels' && m === 'GET') {
    st.gets.push(headers['if-none-match'] ?? null);
    if (st.status !== 200) return J({ error: st.status === 401 ? 'unauthorized' : 'error' }, st.status);
    const tag = `"v${st.version}"`;
    if (headers['if-none-match'] === tag) return route.fulfill({ status: 304, headers: { etag: tag } });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: tag }, body: JSON.stringify(list(st)) });
  }
  if ((mm = p.match(/^\/api\/livetv\/channels\/([^/]+)\/watch$/)) && m === 'POST') {
    const c = st.channels.find((x) => x.id === mm![1]);
    if (!c) return J({ error: 'not_found' }, 404);
    if (st.watchError) return J(st.watchError.body, st.watchError.status);
    st.calls.push(`POST ${p}`);
    return J({
      token: `tok-${c.id}`, url: `/media/l/tok-${c.id}/index.m3u8`, expiresAt: Date.now() + 60_000, dvrSeconds: st.dvrSeconds, mode: 'remux',
      channel: { id: c.id, number: c.number, name: c.name, logo: c.logo }, now: c.now, next: c.next,
    });
  }
  if (p === '/api/livetv/beat' && m === 'POST') return J({ ok: true, expiresAt: Date.now() + 60_000 });
  if (p === '/api/livetv/watch' && m === 'DELETE') { st.calls.push(`DELETE ${p}`); return J({ ok: true }); }
  if (p === '/api/livetv/last' && m === 'PUT') {
    st.recent = [body.id, ...st.recent.filter((x) => x !== body.id)].slice(0, 10);
    bump();
    return J({ ok: true });
  }
  if (p === '/api/livetv/favourites' && m === 'PUT') {
    st.calls.push(`PUT ${p} ${JSON.stringify(body)}`);
    st.favourites = [...body.ids];
    bump();
    return J({ ok: true });
  }
  if ((mm = p.match(/^\/api\/livetv\/favourites\/([^/]+)$/)) && (m === 'POST' || m === 'DELETE')) {
    const id = decodeURIComponent(mm[1]!);
    st.calls.push(`${m} ${p}`);
    st.favourites = m === 'POST' ? [...st.favourites.filter((x) => x !== id), id] : st.favourites.filter((x) => x !== id);
    bump();
    return J({ ok: true });
  }
  if (/^\/api\/livetv\/channels\/[^/]+\/preview\.jpg$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: png(16, 9, [40, 90, 130]) });
  if (/^\/api\/livetv\/logos\/[^/]+$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: png(8, 8, [220, 220, 230]) });
  return null;
}

/** `/media/l/<token>/…`: the sliding live playlist, its init segment and segments; null = not a live path */
export function livetvMedia(st: LivetvMock, p: string, route: Route): Promise<void> | null {
  const mm = p.match(/\/media\/l\/[^/]+\/([^/]+)$/);
  if (!mm) return null;
  const f = mm[1]!;
  if (f === 'index.m3u8') return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: { 'cache-control': 'no-store' }, body: livePlaylist(st, Date.now()) });
  if (f === 'init.mp4') return route.fulfill({ status: 200, contentType: 'video/mp4', body: HLS_INIT });
  const seg = f.match(/^s(\d+)\.m4s$/);
  if (seg) return route.fulfill({ status: 200, contentType: 'video/iso.segment', body: HLS_SEGMENTS[Number(seg[1]) % HLS_SEGMENTS.length]! });
  return route.fulfill({ status: 404, body: '' });
}
