// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Systemcheck lines only the browser can measure (Admin → Status; spec "Check catalogue", proxy group): does a websocket upgrade
 * reach the backend, does the proxy buffer /media/, does a guide-file upload pass its size limit, and does it keep the security headers.
 * Each check has its own time limit and they run at once; the result is one line each, with codes only (texts: i18n area `syscheck`).
 * The probes are the backend's `/ws/syscheck` and `PUT …/sources/<nil id>/file` and the gateway's `/media/probe/drip`.
 */
import { api, ApiError } from '#lib/api';
import type { CheckLine, CheckStatus } from './syscheck';

export interface BrowserDeps { fetch: typeof fetch; WebSocket: typeof WebSocket; now(): number }
type BrowserId = 'proxy.websocket' | 'proxy.buffering' | 'proxy.upload' | 'proxy.headers';

const DOCS = 'setup.md#6-nginx-proxy-manager-portal-proxy-host';
/** each check's own limit */
export const BROWSER_LIMIT_MS = 6_000;
/** the websocket must say hello within this */
const WS_WAIT_MS = 5_000;
/**
 * The drip sends 1 KiB, pauses 1.5 s, sends 1 KiB. First bytes before the pause could have ended → streamed; or, on a slow link (latency,
 * the parallel upload on the same connection), first bytes still well ahead of the last → streamed. First bytes with the last → buffered.
 */
const DRIP_FIRST_MS = 1_200;
const DRIP_GAP_MS = 700;
const DRIP_BYTES = 2048;
/** the upload probe: the nil source id (backend guidefiles.ts PROBE_SOURCE_ID) and its size (more than the general 1 MB /api/ limit) */
export const PROBE_UPLOAD_PATH = '/api/admin/livetv/sources/00000000-0000-0000-0000-000000000000/file';
const UPLOAD_BYTES = 2 * 1024 * 1024;

const bl = (id: BrowserId, status: CheckStatus, o: Partial<Pick<CheckLine, 'cause' | 'fix' | 'docs' | 'ms'>> = {}): CheckLine =>
  ({ id, group: 'proxy', status, ...o, runs: 'browser' });
/** a line that is not ok: its fix sentence is the cause's own; the proxy guide is the place to fix it */
const badl = (id: BrowserId, status: CheckStatus, cause: string, docs = true): CheckLine => bl(id, status, { cause, fix: cause, ...(docs ? { docs: DOCS } : {}) });

/** a probe that answered 429: its limit (another tab, a reload too many), not the proxy: "later", never a finding */
const busy = (id: BrowserId): CheckLine => badl(id, 'unknown', 'probe_busy', false);

/**
 * the drip: status 200 and the first bytes early, or well ahead of the last → ok; first bytes only with the last → the proxy buffers;
 * 404 → no probe there; 429 → busy; anything else → not checked
 */
export function classifyDrip(firstChunkMs: number, totalMs: number, status: number): CheckLine {
  if (status === 429) return busy('proxy.buffering');
  if (status === 404) return badl('proxy.buffering', 'unknown', 'probe_missing', false);
  if (status !== 200) return badl('proxy.buffering', 'unknown', 'probe_failed', false);
  const ms = Math.round(Math.max(0, firstChunkMs));
  const streamed = firstChunkMs >= 0 && firstChunkMs <= totalMs && (firstChunkMs < DRIP_FIRST_MS || totalMs - firstChunkMs >= DRIP_GAP_MS);
  if (streamed) return bl('proxy.buffering', 'ok', { ms });
  return { ...badl('proxy.buffering', 'warning', 'proxy_buffers_media'), ms };
}

/**
 * the upload probe: the backend's own answer → ok (its label says that 2 MB were tested, not the full limit); 413 (the proxy's limit, or
 * the backend's) → the limit is too low; 429 → busy; else not checked
 */
export function classifyUpload(status: number, json: unknown, networkError: boolean): CheckLine {
  if (networkError) return badl('proxy.upload', 'unknown', 'probe_failed', false);
  if (status === 413) return badl('proxy.upload', 'warning', 'upload_limit_low');
  if (status === 429) return busy('proxy.upload');
  if (status === 200 && (json as { probe?: unknown } | null)?.probe === 'ok') return bl('proxy.upload', 'ok');
  // an older backend: the nil id is no source (404) or no probe answer
  if (status === 404 || status === 200) return badl('proxy.upload', 'unknown', 'probe_missing', false);
  return badl('proxy.upload', 'unknown', 'probe_failed', false);
}

/** the page's own headers as the browser gets them: the proxy must pass the app's security headers, and add HSTS on https */
export function classifyHeaders(h: Headers, https: boolean): CheckLine {
  if (!h.get('x-content-type-options') || !h.get('referrer-policy')) return badl('proxy.headers', 'warning', 'headers_stripped');
  if (https && !h.get('strict-transport-security')) return badl('proxy.headers', 'warning', 'hsts_missing');
  return bl('proxy.headers', 'ok');
}

/** the upload line while Live TV is not set up (the guide-file upload is a Live-TV feature): nothing is sent */
export const uploadNotSetUp = (): CheckLine => bl('proxy.upload', 'not_set_up', { cause: 'upload_livetv_off' });

/** runs `fn` under the check's own limit: a miss is unknown/check_timeout, a throw unknown/probe_failed */
async function limited(id: BrowserId, fn: () => Promise<CheckLine>): Promise<CheckLine> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<CheckLine>((res) => { timer = setTimeout(() => res(bl(id, 'unknown', { cause: 'check_timeout', fix: 'check_timeout' })), BROWSER_LIMIT_MS); });
  try {
    return await Promise.race([fn().catch(() => badl(id, 'unknown', 'probe_failed', false)), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * an upgrade that reaches the backend: its hello, or any close code of the backend's own (4xxx: it answered, only refused). A browser
 * sees a refused upgrade only as close 1006, whoever refused it: a plain GET of the same path then tells the probe's own rate limit (429,
 * "later") from a proxy that does not pass websockets.
 */
function websocket(origin: string, d: BrowserDeps): Promise<CheckLine> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let settled = false;
    const done = (l: CheckLine) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      resolve(l);
    };
    const blocked = () => done(badl('proxy.websocket', 'problem', 'ws_blocked'));
    const refused = () => {
      if (settled) return;
      d.fetch(`${origin}/ws/syscheck`, { cache: 'no-store', credentials: 'same-origin' })
        .then((r) => { void r.body?.cancel().catch(() => undefined); return r.status; }, () => 0)
        .then((status) => (status === 429 ? done(busy('proxy.websocket')) : blocked()));
    };
    const timer = setTimeout(blocked, WS_WAIT_MS);
    try {
      ws = new d.WebSocket(`${origin.replace(/^http/, 'ws')}/ws/syscheck`);
    } catch {
      blocked();
      return;
    }
    ws.onmessage = (e) => {
      let ok = false;
      try { ok = (JSON.parse(String(e.data)) as { ok?: unknown }).ok === true; } catch { /* not the hello */ }
      if (ok) done(bl('proxy.websocket', 'ok'));
    };
    ws.onclose = (e) => (e.code >= 4000 && e.code < 5000 ? done(bl('proxy.websocket', 'ok')) : refused());
    ws.onerror = () => undefined; // a close follows
  });
}

async function drip(origin: string, d: BrowserDeps): Promise<CheckLine> {
  const t0 = d.now();
  const r = await d.fetch(`${origin}/media/probe/drip`, { cache: 'no-store', credentials: 'omit' });
  const reader = r.body?.getReader();
  let first = -1, bytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first < 0) first = d.now() - t0;
      bytes += value.length;
    }
  }
  // something else answered the path (a page, an image): no probe there
  return classifyDrip(first, d.now() - t0, bytes === DRIP_BYTES ? r.status : r.status === 200 ? 404 : r.status);
}

async function upload(): Promise<CheckLine> {
  try {
    const json = await api<unknown>(PROBE_UPLOAD_PATH, { method: 'PUT', raw: new Blob([new Uint8Array(UPLOAD_BYTES)], { type: 'application/octet-stream' }) });
    return classifyUpload(200, json, false);
  } catch (e) {
    return e instanceof ApiError ? classifyUpload(e.status, e.body, false) : classifyUpload(0, null, true);
  }
}

async function headers(origin: string, d: BrowserDeps): Promise<CheckLine> {
  const r = await d.fetch(`${origin}/`, { cache: 'no-store', credentials: 'same-origin' });
  void r.body?.cancel().catch(() => undefined);
  return classifyHeaders(r.headers, origin.startsWith('https:'));
}

/**
 * The upload line alone, for a Live-TV state: installed → the 2 MiB probe (under its own limit); not installed → not set up, nothing is
 * sent; not known → no line (it stays "nicht geprüft"). The Status page reruns it when the server's answer changes the Live-TV state.
 */
export function runUploadCheck(livetvInstalled: boolean | null): Promise<CheckLine | null> {
  if (livetvInstalled === null) return Promise.resolve(null);
  return livetvInstalled ? limited('proxy.upload', upload) : Promise.resolve(uploadNotSetUp());
}

const defaultDeps = (): BrowserDeps => ({ fetch: (...a) => fetch(...a), WebSocket, now: () => performance.now() });

/**
 * The four browser lines, in catalogue order, each under its own limit, all at once. `livetvInstalled` (from the server's
 * livetv.container line): false → the upload line is not set up and nothing is sent; null (not known yet) → no upload line.
 */
export async function runBrowserChecks(o: { livetvInstalled: boolean | null; origin?: string; deps?: BrowserDeps }): Promise<CheckLine[]> {
  const d = o.deps ?? defaultDeps();
  const origin = o.origin ?? location.origin;
  const lines = await Promise.all([
    limited('proxy.websocket', () => websocket(origin, d)),
    limited('proxy.buffering', () => drip(origin, d)),
    runUploadCheck(o.livetvInstalled),
    limited('proxy.headers', () => headers(origin, d)),
  ]);
  return lines.filter((l): l is CheckLine => l !== null);
}
