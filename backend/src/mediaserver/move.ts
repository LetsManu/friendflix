// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { randomToken } from '../crypto.js';
import { mediaScan, type MediaError, type MoveScan } from './client.js';
import type { MovePhase } from './store.js';

/**
 * The backend's half of a move from an existing Jellyfin to the managed Ferrofin (docs/superpowers/specs/2026-11-24-mediaserver-stage2-
 * migration-design.md "The move", "After the move"). POST /api/admin/mediaserver/move starts the updater's copy job and records
 * `media_managed.move` in phase `copying` (routes/adminMediaserver.ts); the phases after it (`nfo`, `verify`, `switch`, `requests`) and
 * the way back live here.
 */

/** the phases in which a move is under way: no second move starts */
export const ACTIVE_PHASES: readonly MovePhase[] = ['copying', 'nfo', 'verify', 'switch', 'requests'];
/** the phases from which FriendFlix uses the new server (or is about to): an abort would take away the server in use */
export const SWITCHED_PHASES: readonly MovePhase[] = ['switch', 'requests', 'done'];

/**
 * The sized scan of the chosen Jellyfin (stage 2 "Reading the source") runs in the background: it can take longer than a reverse proxy in
 * front of FriendFlix waits for an answer (Nginx Proxy Manager: 60 s). Its record lives 10 minutes; the move needs a `done` one for its
 * source that is not older than that. `result` is the checked scan (no server id, no host path), the refusal its code and container paths.
 */
export interface MoveScanRecord {
  source: string; state: 'running' | 'done' | 'failed'; result?: MoveScan; error?: string; outside?: string[]; refused?: string[]; nested?: string[]; at: string;
}
export const SCAN_KEY = 'media:move:scan';
export const SCAN_TTL_S = 600;
/** held while a scan runs (longer than the sized scan's deadline, client.ts); released when it ends */
const SCAN_LOCK = 'media:move:scan:running';
const SCAN_LOCK_TTL_S = 200;
const SCAN_STATES = ['running', 'done', 'failed'] as const;
const CONTAINER_ID = /^[0-9a-f]{64}$/;

/** the scan record, or null (none, expired, or not one) */
export async function readScan(ctx: Pick<Ctx, 'kv'>): Promise<MoveScanRecord | null> {
  const raw = await ctx.kv.get(SCAN_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as MoveScanRecord;
    return typeof r.source === 'string' && CONTAINER_ID.test(r.source) && SCAN_STATES.includes(r.state) && typeof r.at === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** whether a scan runs now (a sized scan in the background) */
export async function scanRunning(ctx: Pick<Ctx, 'kv'>): Promise<boolean> {
  return (await ctx.kv.get(SCAN_LOCK).catch(() => null)) !== null;
}

/** a `done` scan of `source` that is at most SCAN_TTL_S old; null otherwise */
export async function freshScan(ctx: Pick<Ctx, 'kv'>, source: string): Promise<MoveScan | null> {
  const r = await readScan(ctx);
  const age = r ? Date.now() - Date.parse(r.at) : NaN;
  return r?.state === 'done' && r.source === source && r.result && age >= 0 && age <= SCAN_TTL_S * 1000 ? r.result : null;
}

/**
 * Starts the sized scan of `source` in the background and records it `running`; false when a scan runs already (one at a time). The
 * record becomes `done` with the scan, or `failed` with the code (a scan answer without a usable scan is `updater_error`).
 */
export async function startScan(ctx: Ctx, source: string, serverId: string): Promise<MoveScanRecord | null> {
  const token = randomToken(12);
  if (!(await ctx.kv.setnx(SCAN_LOCK, token, SCAN_LOCK_TTL_S))) return null;
  const put = (r: MoveScanRecord) => ctx.kv.set(SCAN_KEY, JSON.stringify(r), SCAN_TTL_S);
  const running: MoveScanRecord = { source, state: 'running', at: new Date(Date.now()).toISOString() };
  try {
    await put(running);
  } catch (e) {
    await ctx.kv.delIfEquals(SCAN_LOCK, token).catch(() => false);
    throw e;
  }
  void (async () => {
    const r = await mediaScan(ctx, source, serverId).catch(() => null);
    const at = new Date(Date.now()).toISOString();
    if (r?.ok && r.scan && r.scan.source.id === source) await put({ source, state: 'done', result: r.scan, at });
    else if (r && !r.ok) await put({ source, state: 'failed', error: r.error, outside: r.outside, refused: r.refused, nested: r.nested, at });
    else await put({ source, state: 'failed', error: 'updater_error', at });
  })().catch(() => undefined).finally(() => ctx.kv.delIfEquals(SCAN_LOCK, token).catch(() => false));
  return running;
}

export type BackError = MediaError | 'jellyfin_unreachable' | 'not_available';

/**
 * The way back to the Jellyfin a move came from (spec "After the move"): start the old container, check that it answers with the saved
 * key, restore the saved address and key, point the request service back, stop the managed Ferrofin, repair the users.
 *
 * Contract with POST /api/admin/mediaserver/back: the route calls it after re-authentication, only while a move is recorded
 * (`migrated_from`) and the managed server is in use; `ok` only once FriendFlix uses the old Jellyfin again (the route then audits
 * `mediaserver.back`); a refusal leaves FriendFlix unchanged and answers its code. The way back is built with plan Task 8; until then
 * every call is refused with `not_available` and nothing changes.
 */
export async function goBack(_ctx: Ctx, _actor: string | null): Promise<{ ok: true } | { ok: false; error: BackError }> {
  return { ok: false, error: 'not_available' };
}
