// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV → Live-Status (Task 26): `GET /api/admin/livetv/status`, `POST /api/admin/livetv/streams/:channelId/stop` and the
 * guide counts `GET /api/admin/livetv/epg/summary` (Task 17), as backend/src/livetv/status.ts answers them. Stopping removes the stream
 * and adds the *stopped_by_admin* event, as the backend does. Never a URL, a stream key or a stream id.
 */
type Reply = (body: unknown, status?: number) => Promise<void>;

export interface LtvStatusStream {
  channelId: string; name: string; logoHash: string | null; mode: 'passthrough' | 'remux' | 'transcode'; viewers: number; since: number;
  bitrate: number | null; input: 'ok' | 'reconnecting' | 'failed'; reconnects: number;
}
export interface LtvStatusFeed { channelId: string; name: string; port: number; state: 'idle' | 'receiving'; since: number | null; bitrate: number | null; rejected1h: number }
export interface LtvStatusEvent { at: number; level: 'info' | 'warn' | 'error'; code: string; channelId?: string; sourceId?: string; n?: number; reason?: string }
export interface LtvStatusMock {
  version: string;
  cpuPct: number;
  gpuPct: number | null;
  cache: { usedBytes: number; maxBytes: number };
  streams: LtvStatusStream[];
  ingest: LtvStatusFeed[];
  events: LtvStatusEvent[];
  /** the guide counts; `null` = the summary route fails (503) */
  summary: { matched: number; total: number; unmatched: number } | null;
  /** the next stop answers 503 livetv_unreachable */
  stopFails: boolean;
  /** the first GET /status answers 503 (a failed first load), the later ones answer */
  failFirst: boolean;
  /** channel id -> name of every channel that was ever listed (an event names a channel that is no longer running) */
  names: Record<string, string>;
  /** GET /status calls so far */
  gets: number;
  /** POST stop calls: the channel ids, in order */
  stops: string[];
}

const GB = 1024 ** 3;
const minutesAgo = (m: number) => Date.now() - m * 60_000;

export function ltvStatusMock(): LtvStatusMock {
  const s: LtvStatusMock = {
    version: '3.3.0', cpuPct: 17, gpuPct: null, cache: { usedBytes: Math.round(3.1 * GB), maxBytes: 6 * GB },
    streams: [
      { channelId: 'ch-nordlicht', name: 'Nordlicht TV', logoHash: null, mode: 'remux', viewers: 3, since: minutesAgo(95), bitrate: 4_200_000, input: 'ok', reconnects: 0 },
      { channelId: 'ch-hafenkanal', name: 'Hafenkanal', logoHash: null, mode: 'passthrough', viewers: 1, since: minutesAgo(20), bitrate: 2_500_000, input: 'reconnecting', reconnects: 3 },
    ],
    ingest: [],
    events: [
      { at: minutesAgo(2), level: 'warn', code: 'input_lost', channelId: 'ch-hafenkanal', n: 12 },
      { at: minutesAgo(30), level: 'warn', code: 'start_refused_full' },
      { at: minutesAgo(60), level: 'error', code: 'source_refresh_failed', sourceId: 'src-nordlicht', reason: 'timeout' },
    ],
    summary: { matched: 398, total: 412, unmatched: 14 },
    stopFails: false, failFirst: false, names: {}, gets: 0, stops: [],
  };
  for (const x of s.streams) s.names[x.channelId] = x.name;
  return s;
}

export function ltvStatusRoute(s: LtvStatusMock, m: string, p: string, J: Reply): Promise<void> | null {
  if (p === '/api/admin/livetv/status' && m === 'GET') {
    if (s.gets++ === 0 && s.failFirst) return J({ error: 'livetv_unreachable' }, 503);
    const named = { ...s.names, ...Object.fromEntries([...s.streams, ...s.ingest].map((x) => [x.channelId, x.name])) };
    return J({
      version: s.version,
      budget: { limit: 3, auto: 3, custom: null, priority: 'films', used: 0, running: [], bench: { jellyfin: null, livetv: null, recommended: null, stale: false, noRealtime: false }, measure: { running: false, busy: null, last: null } },
      system: { cpuPct: s.cpuPct, gpuPct: s.gpuPct, cache: s.cache },
      streams: s.streams, ingest: s.ingest, events: s.events, channels: Object.fromEntries(s.events.flatMap((e) => (e.channelId && named[e.channelId] ? [[e.channelId, named[e.channelId]!]] : []))), gpu: { advice: null },
    });
  }
  if (p === '/api/admin/livetv/epg/summary' && m === 'GET') return s.summary ? J(s.summary) : J({ error: 'livetv_unreachable' }, 503);
  const stop = p.match(/^\/api\/admin\/livetv\/streams\/([^/]+)\/stop$/);
  if (stop && m === 'POST') {
    const id = decodeURIComponent(stop[1]!);
    if (s.stopFails) { s.stopFails = false; return J({ error: 'livetv_unreachable' }, 503); }
    s.stops.push(id);
    s.streams = s.streams.filter((x) => x.channelId !== id);
    s.events = [{ at: Date.now(), level: 'info', code: 'stopped_by_admin', channelId: id }, ...s.events];
    return J({ ok: true });
  }
  return null;
}
