// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserContext, Route } from '@playwright/test';
/**
 * GET /api/admin/systemcheck (backend/src/routes/systemcheck.ts): the Systemcheck answer. The default is a healthy instance with the
 * lines the backend has today (core, sign-in, media); `refreshed` replaces it on ?refresh=1, `refreshStatus` answers a Jetzt prüfen with
 * an error (429 rate_limited), `status` every call.
 *
 * The browser checks' probes (web/src/lib/admin/syscheckBrowser.ts) answer as a healthy proxy by default: `/ws/syscheck` says hello,
 * `/media/probe/drip` sends its 2 KiB (a mock cannot pause inside a body: `dripDelayMs` holds the whole answer, which reads as a proxy that
 * buffers once the first bytes come late and with the last), and the upload probe answers `{ probe: 'ok' }` or `uploadStatus` (413 → the proxy's HTML page).
 */

export type Status = 'ok' | 'warning' | 'problem' | 'not_set_up' | 'unknown';
export interface MockLine {
  id: string; group?: string; status: Status; cause?: string; fix?: string; settingKey?: string; settingGroup?: string; locked?: true;
  href?: string; docs?: string; params?: Record<string, number | string>; ms?: number; runs?: 'server' | 'browser';
}
export interface MockResult { at: string; lines: MockLine[]; counts: Record<Status, number> }
export interface SyscheckMock {
  result: MockResult;
  /** replaces `result` on the next ?refresh=1 */
  refreshed: MockResult | null;
  /** query of every call: '' or '?refresh=1' */
  calls: string[];
  /** every call answers this status (e.g. 500) */
  status: number | null;
  /** ?refresh=1 answers this status (429 → rate_limited) */
  refreshStatus: number | null;
  /** the browser probes */
  probes: { dripDelayMs: number; drips: number; uploadStatus: number; uploads: number; sockets: number; hold: Promise<void> | null };
}

/** the server lines of Stage 1 in catalogue order */
export const SERVER_IDS = [
  'core.publicUrl', 'core.database', 'core.redis', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env',
  'signin.oidc', 'signin.authentik', 'signin.flows', 'signin.issuerHost', 'signin.passkeys', 'signin.mail',
  'media.server', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder',
];

/** a full answer from lines (group, runs and counts filled in like the backend) */
export function result(lines: MockLine[], at = new Date().toISOString()): MockResult {
  const full = lines.map((l) => ({ group: l.id.split('.')[0], runs: 'server' as const, ...l }));
  const counts: Record<Status, number> = { ok: 0, warning: 0, problem: 0, not_set_up: 0, unknown: 0 };
  for (const l of full) counts[l.status]++;
  return { at, lines: full, counts };
}

/** every Stage-1 line ok */
export function syscheckOk(at?: string): MockResult {
  return result(SERVER_IDS.map((id) => ({ id, status: 'ok' as const })), at);
}

/** with `over` replacing single lines by id */
export function syscheckWith(over: MockLine[], at?: string): MockResult {
  const by = new Map(over.map((l) => [l.id, l]));
  return result(SERVER_IDS.map((id) => by.get(id) ?? { id, status: 'ok' as const }), at);
}

/** two problems, one warning, two optional features not set up */
export function syscheckTroubled(at?: string): MockResult {
  return syscheckWith([
    { id: 'signin.authentik', status: 'problem', cause: 'ak_token_invalid', fix: 'ak_token_invalid', settingKey: 'AUTHENTIK_API_TOKEN', settingGroup: 'signin' },
    { id: 'signin.flows', status: 'warning', cause: 'flow_missing', fix: 'flow_missing', href: '/admin/status#login', params: { n: 2, flow: 'recovery' } },
    { id: 'media.server', status: 'problem', cause: 'media_down', fix: 'media_down', settingKey: 'JELLYFIN_URL', settingGroup: 'media', ms: 3000 },
    { id: 'media.requests', status: 'not_set_up', cause: 'requests_not_set', fix: 'requests_not_set', settingKey: 'REQUESTS_URL', settingGroup: 'requests' },
    { id: 'media.tmdb', status: 'not_set_up', cause: 'source_not_set', fix: 'source_not_set', settingKey: 'TMDB_API_KEY', settingGroup: 'sources' },
  ], at);
}

/** the troubled answer plus an encoder line with three advices and the HEVC check row */
export function syscheckTroubledEncoder(at?: string): MockResult {
  const r = syscheckTroubled(at);
  r.lines = r.lines.map((l) => (l.id === 'media.encoder'
    ? { ...l, status: 'warning' as const, cause: 'hevc_failed', fix: 'hevc_failed', settingKey: 'HEVC_STREAMS', settingGroup: 'playback', params: { advice: 'hevc_failed,no_tonemap,downmix_plain', hevc: 'failed' } }
    : l));
  return result(r.lines, r.at);
}

/** every line ok, the encoder with its HEVC check row (a healthy Jellyfin install) */
export function syscheckHealthy(at?: string): MockResult {
  return syscheckWith([{ id: 'media.encoder', status: 'ok', params: { hevc: 'ready', speed: 2.4 } }], at);
}

export function syscheckState(): SyscheckMock {
  return { result: syscheckOk(), refreshed: null, calls: [], status: null, refreshStatus: null, probes: { dripDelayMs: 0, drips: 0, uploadStatus: 200, uploads: 0, sockets: 0, hold: null } };
}

export const PROBE_UPLOAD_PATH = '/api/admin/livetv/sources/00000000-0000-0000-0000-000000000000/file';

/** the gateway's buffering probe (`hold`: a test holds every probe until it lets go, to see "wird geprüft…") */
export function syscheckDrip(st: SyscheckMock, p: string, route: Route): Promise<void> | null {
  if (p !== '/media/probe/drip') return null;
  return (async () => {
    st.probes.drips++;
    await st.probes.hold;
    if (st.probes.dripDelayMs) await new Promise((r) => setTimeout(r, st.probes.dripDelayMs));
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'cache-control': 'no-store' }, body: Buffer.alloc(2048) });
  })();
}

/** the backend's upload-limit probe (PUT of the nil source id) */
export function syscheckUpload(st: SyscheckMock, m: string, p: string, route: Route): Promise<void> | null {
  if (p !== PROBE_UPLOAD_PATH || m !== 'PUT') return null;
  return (async () => {
    st.probes.uploads++;
    await st.probes.hold;
    if (st.probes.uploadStatus === 413) return route.fulfill({ status: 413, contentType: 'text/html', body: '<html><body><center><h1>413 Request Entity Too Large</h1></center></body></html>' });
    return route.fulfill({ status: st.probes.uploadStatus, contentType: 'application/json', body: JSON.stringify(st.probes.uploadStatus === 200 ? { probe: 'ok', bytes: 2097152 } : { error: 'boom' }) });
  })();
}

/** the backend's websocket probe: hello, then a normal close */
export async function syscheckSocket(ctx: BrowserContext, st: SyscheckMock): Promise<void> {
  await ctx.routeWebSocket(/\/ws\/syscheck$/, async (ws) => {
    st.probes.sockets++;
    await st.probes.hold;
    ws.send('{"ok":true}');
    await ws.close({ code: 1000 });
  });
}

type Reply = (b: unknown, status?: number) => Promise<void>;
export function syscheckRoute(st: SyscheckMock, m: string, p: string, sp: URLSearchParams, J: Reply): Promise<void> | null {
  if (p !== '/api/admin/systemcheck' || m !== 'GET') return null;
  const refresh = sp.get('refresh') === '1';
  st.calls.push(refresh ? '?refresh=1' : '');
  if (st.status) return J({ error: 'boom' }, st.status);
  if (refresh && st.refreshStatus) return J({ error: st.refreshStatus === 429 ? 'rate_limited' : 'boom' }, st.refreshStatus);
  if (refresh && st.refreshed) { st.result = st.refreshed; st.refreshed = null; }
  return J(st.result);
}
