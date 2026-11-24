// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { auditInTx } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { randomToken } from '../crypto.js';
import { inTransaction } from '../db.js';
import { JellyfinClient, JellyfinError } from '../jellyfin/client.js';
import { addressOnly } from '../media/address.js';
import { MediaSetupError } from '../media/types.js';
import { writeRows } from '../settings/repo.js';
import { updaterView, type TickLog, type UpdaterStatus } from '../updater.js';
import { mediaOp, mediaScan, startMediaJob, type MediaError, type MoveScan } from './client.js';
import { MANAGED_URL, nfoSaversOff } from './serverApi.js';
import { readManaged, writeManaged, type IdCheck, type MediaManaged, type MoveRecord, type MovePhase } from './store.js';

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

// ---------------------------------------------------------------- the backend's phases (spec "The move" 7–10)

/**
 * One tick across instances (like the first run's `media:managed:tick`); the abort route holds it too while it reads the phase, asks the
 * updater and marks the move failed, so an abort and a phase step never interleave. Longer than a tick's worst case: the id check's
 * deadline plus an abort sent after it.
 */
export const MOVE_LOCK = 'media:move:tick';
const LOCK_TTL_S = 120;
/** the id check as a whole (every user and the item sample); a server that does not answer within it fails the check */
const VERIFY_DEADLINE_MS = 45_000;
/** the newest item references the id check samples, how many it looks up at once, and the share that must resolve (deleted titles) */
const SAMPLE = 200;
const PARALLEL = 8;
const RESOLVE_PERCENT = 98;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;

/** a phase failure with its code (and, for `ids_mismatch`, the numbers) */
class MoveFailed extends Error {
  constructor(readonly code: string, readonly meta?: IdCheck) {
    super(`media move failed: ${code}`);
  }
}
const safeCode = (c: string | null | undefined, fallback: string): string => (c && CODE.test(c) ? c : fallback);

/**
 * Runs `fn` while holding MOVE_LOCK; waits up to `waitMs` for a tick that holds it, null when it stays held (the caller answers busy).
 */
export async function withMoveLock<T>(ctx: Pick<Ctx, 'kv'>, fn: () => Promise<T>, waitMs = 5_000): Promise<T | null> {
  const token = randomToken(12);
  const until = Date.now() + waitMs;
  while (!(await ctx.kv.setnx(MOVE_LOCK, token, LOCK_TTL_S))) {
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return await fn();
  } finally {
    await ctx.kv.delIfEquals(MOVE_LOCK, token).catch(() => undefined);
  }
}

/** runs `fn` over `items`, at most `n` at once; the first failure rejects and no further item starts */
async function each<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) await fn(items[next++]!).catch((e: unknown) => { failed = true; throw e; });
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * The id check (`verify`, spec "The move" 8) against the new server with the copied key: every media server user id on `users` and
 * `profiles` must resolve; of the up to 200 newest item ids FriendFlix references (watch list, watch time, lists, bookmarks, thumbs,
 * ratings, episode reminders, Live TV recordings exported to the library; each id once, by its newest reference) at least 98 % must
 * (deleted titles may be gone). Only ids shaped like media server item ids are sampled. Any lookup that fails otherwise throws.
 */
export async function verifyIds(ctx: Pick<Ctx, 'db'>, client: Pick<JellyfinClient, 'userExists' | 'itemById'>, signal?: AbortSignal): Promise<IdCheck> {
  const users = (await ctx.db.query<{ id: string }>(
    `select jellyfin_user_id as id from users where jellyfin_user_id <> ''
     union select jellyfin_user_id from profiles where jellyfin_user_id is not null and jellyfin_user_id <> ''`)).rows.map((r) => r.id);
  // every item reference FriendFlix keeps (db.ts); a table added later that holds media server item ids belongs here too
  const items = (await ctx.db.query<{ id: string }>(
    `select item_id as id from (
       select item_id, added_at as at from watchlist
       union all select item_id, day::timestamptz from play_seconds
       union all select item_id, added_at from list_items
       union all select item_id, created_at from bookmarks
       union all select item_id, created_at from thumbs
       union all select item_id, created_at from ratings
       union all select jf_item_id, created_at from reminders where jf_item_id is not null
       union all select jellyfin_item_id, created_at from livetv_recordings where jellyfin_item_id is not null
     ) r where item_id ~ '^[0-9a-fA-F]{32}$' group by item_id order by max(at) desc, item_id limit $1`, [SAMPLE])).rows.map((r) => r.id);
  let usersMissing = 0;
  let itemsMissing = 0;
  await each(users, PARALLEL, async (id) => { if (!(await client.userExists(id, signal))) usersMissing++; });
  await each(items, PARALLEL, async (id) => { if (!(await client.itemById(id, signal))) itemsMissing++; });
  return { users: { total: users.length, missing: usersMissing }, items: { sampled: items.length, missing: itemsMissing } };
}

const idsPass = (r: IdCheck): boolean => r.users.missing === 0 && (r.items.sampled - r.items.missing) * 100 >= r.items.sampled * RESOLVE_PERCENT;

type Next = MovePhase | 'waiting';
interface Phase { ctx: Ctx; m: MediaManaged; rec: MoveRecord; status: UpdaterStatus | null }

/**
 * The updater's move during the backend's phases before the switch: `ready` goes on; an updater that is not there, runs a job or still
 * settles the move waits; a move it no longer holds as ready (aborted, its source started again, or gone) has failed.
 */
function stillReady(status: UpdaterStatus | null): 'ready' | 'waiting' {
  const ms = status?.mediaserver;
  if (!status || !ms) return 'waiting';
  if (status.busy) return 'waiting';
  if (ms.move?.phase === 'ready') return 'ready';
  if (ms.move?.phase === 'running') return 'waiting';
  throw new MoveFailed(ms.move?.phase === 'aborted' ? safeCode(ms.error, 'move_aborted') : 'interrupted');
}

const currentKey = (ctx: Ctx): string => {
  const key = ctx.cfg.JELLYFIN_ADMIN_API_KEY;
  if (!key) throw new MoveFailed('unexpected');
  return key;
};

/** `copying`: the updater's copy job (stage 2 "The move" 1–6) ends `ready` (the new server runs, the old one is stopped), or its code */
async function copying({ rec, status }: Phase): Promise<Next> {
  const ms = status?.mediaserver;
  if (!status || !ms) return 'waiting';
  const move = ms.move;
  if (move?.phase === 'ready') return 'nfo';
  if (move?.phase === 'running') return 'waiting';
  const j = status.job;
  if (j && j.id === rec.jobId) {
    if (j.state === 'running') return 'waiting';
    // the job failed and settled the move (the source runs again), or failed before it recorded one (its check)
    if (j.state !== 'succeeded' || move?.phase === 'aborted') throw new MoveFailed(safeCode(j.error ?? ms.error, 'move_aborted'));
  }
  if (status.busy) return 'waiting';
  if (move?.phase === 'aborted') throw new MoveFailed(safeCode(ms.error, 'move_aborted'));
  // the copy's job is gone and no move is recorded: the updater restarted before it stopped anything
  throw new MoveFailed('interrupted');
}

/** `nfo` (spec "The move" 7): the NFO saver off in every library (the media are read-only), with FriendFlix's current key (copied along) */
async function nfo({ ctx, status }: Phase): Promise<Next> {
  if (stillReady(status) === 'waiting') return 'waiting';
  await nfoSaversOff(ctx.fetchImpl, MANAGED_URL, currentKey(ctx));
  return 'verify';
}

/** `verify` (spec "The move" 8): linked users and the item sample resolve on the new server; `ids_mismatch` with the numbers otherwise */
async function verify({ ctx, status }: Phase): Promise<Next> {
  if (stillReady(status) === 'waiting') return 'waiting';
  const client = new JellyfinClient(MANAGED_URL, currentKey(ctx), ctx.fetchImpl);
  const r = await verifyIds(ctx, client, AbortSignal.timeout(VERIFY_DEADLINE_MS));
  if (!idsPass(r)) throw new MoveFailed('ids_mismatch', r);
  return 'switch';
}

/**
 * whether this move's switch is committed: managed Ferrofin with a move recorded. A move starts only while FriendFlix is external (kind
 * null: the route's offer) and nothing else makes it managed meanwhile (a fresh managed server is refused while ids are in use, the
 * updater refuses every other media op while the copy waits), so during `switch` only the commit sets the kind.
 */
const switched = (m: MediaManaged): boolean => m.kind === 'ferrofin' && m.migratedFrom !== null;

/**
 * `switch` (spec "The move" 9): in one transaction the current address and key become the way back, the media server address becomes
 * the managed server (the key stays: it came along with the copy), managed mode Ferrofin with its setup done, and where the move came
 * from; then the updater is told (`migrate-done`: the move ends, the old Jellyfin stays stopped and recorded). A committed switch is
 * never made again (a restart after the commit only sends `migrate-done` again). Before the commit FriendFlix is unchanged, so a switch
 * that cannot be made fails (and aborts) like the phases before it.
 */
async function switchPhase({ ctx, m, status }: Phase): Promise<Next> {
  if (!switched(m)) {
    if (stillReady(status) === 'waiting') return 'waiting';
    const source = status!.mediaserver!.move!.source;
    if (m.kind !== null) throw new MoveFailed('unexpected');
    if (ctx.settings.sources().JELLYFIN_URL === 'env') throw new MoveFailed('url_pinned');
    const key = currentKey(ctx);
    const url = addressOnly(ctx.cfg.JELLYFIN_URL ?? '').replace(/\/+$/, '');
    if (!url || url === MANAGED_URL) throw new MoveFailed('unexpected');
    const committed = await inTransaction(ctx.db, async (c) => {
      const row = (await c.query<{ phase: string | null; kind: string | null }>("select move->>'phase' as phase, kind from media_managed where id = 1 for update")).rows[0];
      // an abort, or another instance that switched meanwhile
      if (row?.phase !== 'switch' || row.kind !== null) return false;
      await writeRows(c, ctx.encKey, { JELLYFIN_URL: MANAGED_URL }, null);
      await writeManaged({ db: c, encKey: ctx.encKey }, {
        externalUrl: url, externalKey: key, kind: 'ferrofin', setup: 'done', setupError: null,
        migratedFrom: { name: source.name, version: source.version, at: new Date(Date.now()).toISOString() },
      });
      await auditInTx({ db: c }, null, 'mediaserver.moved', undefined, { name: source.name });
      return true;
    });
    // the settings changed outside save(): reload here, the other instances on the published rev
    await ctx.settings.announce();
    if (!committed) return 'waiting';
  }
  const r = await mediaOp(ctx, { op: 'migrate-done' });
  if (r?.status === 200) return 'requests';
  // no move left to end: migrate-done arrived before (its answer lost in a restart)
  const error = (r?.json as { error?: unknown } | null)?.error;
  if (r?.status === 409 && error === 'no_target') return 'requests';
  return 'waiting';
}

/** `requests` (spec "The move" 10): the request service follows with plan Task 9; until then nothing to do */
async function requests(): Promise<Next> {
  return 'done';
}

const PHASES: Partial<Record<MovePhase, (p: Phase) => Promise<Next>>> = { copying, nfo, verify, switch: switchPhase, requests };
/** the phases in which any failure aborts the move (FriendFlix is unchanged; the updater's copy waits as `ready`) */
const ABORTABLE: readonly MovePhase[] = ['nfo', 'verify'];

/** the phase changes only while it is still the one this tick ran (an abort meanwhile wins) */
async function advance(ctx: Ctx, from: MovePhase, to: MovePhase): Promise<boolean> {
  const r = await ctx.db.query(`update media_managed set move = move || jsonb_build_object('phase', $2::text, 'error', null), updated_at = now()
    where id = 1 and move->>'phase' = $1`, [from, to]);
  return r.rowCount === 1;
}

/** marks the move failed (only while it is still in `from`) with its abort pending; false when the phase changed meanwhile */
async function markFailed(ctx: Ctx, from: MovePhase, code: string, meta?: IdCheck): Promise<boolean> {
  const patch = { phase: 'failed', error: code, abortPending: true, ...(meta ? { errorMeta: meta } : {}) };
  const r = await ctx.db.query("update media_managed set move = move || $2::jsonb, updated_at = now() where id = 1 and move->>'phase' = $1", [from, JSON.stringify(patch)]);
  return r.rowCount === 1;
}

/**
 * The updater's abort of a failed move (the new container removed, the old Jellyfin started: stage 2 "Abort"), until it takes it: a job
 * started, or nothing left to abort (`no_target`: the copy's own job settled it already). Then the pending mark goes.
 */
async function sendAbort(ctx: Ctx, rec: MoveRecord): Promise<void> {
  const r = await startMediaJob(ctx, { op: 'migrate-abort' }, null, { code: rec.error }, 'mediaserver.move_abort');
  if (!r.ok && r.error !== 'no_target') return;
  await ctx.db.query("update media_managed set move = move - 'abortPending', updated_at = now() where id = 1 and move->>'phase' = 'failed'");
}

const codeOf = (e: unknown): string => {
  if (e instanceof MoveFailed) return e.code;
  if (e instanceof MediaSetupError) return safeCode(e.code, 'unexpected');
  if (e instanceof JellyfinError) return e.status === 401 || e.status === 403 ? 'unauthorized' : 'unexpected';
  // fetch's network failure and a deadline
  if (e instanceof TypeError || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))) return 'unreachable';
  return 'unexpected';
};

/** whether the tick has something to do: a phase under way, or a failed move whose abort the updater has not taken yet */
const pending = (rec: MoveRecord | null): rec is MoveRecord => rec !== null && (ACTIVE_PHASES.includes(rec.phase) || (rec.phase === 'failed' && rec.abortPending === true));

/**
 * One tick of the move after the updater's copy (spec "The move" 7–10; server.ts runs it every 10 s next to the first run's tick):
 * `idle` unless a move is under way, `locked` while another tick or the abort route holds MOVE_LOCK, `waiting` while a phase waits (the
 * copy, the updater, migrate-done), else the phase the move is on now.
 *
 * Every phase is idempotent and re-read under the lock, so a backend restart in any phase resumes it (a committed switch is not made
 * again). A ready copy always ends with exactly one of `migrate-done` (only from `switch`, after the switch committed) or `migrate-abort`
 * (any failure before the commit; sent again until the updater takes it). Phase changes are conditional on the phase this tick read: an
 * abort written meanwhile is never overwritten. Codes only: no address, key, server id or server text reaches the record or a log.
 */
export async function moveTick(ctx: Ctx, log?: TickLog): Promise<MovePhase | 'idle' | 'locked' | 'waiting'> {
  if (!pending((await readManaged(ctx.db)).move)) return 'idle';
  const token = randomToken(12);
  if (!(await ctx.kv.setnx(MOVE_LOCK, token, LOCK_TTL_S))) return 'locked';
  try {
    const m = await readManaged(ctx.db); // under the lock: the phase another tick or an abort may just have written
    const rec = m.move;
    if (!pending(rec)) return 'idle';
    const view = await updaterView(ctx);
    const status = 'status' in view ? view.status : null;
    if (rec.phase === 'failed') {
      await sendAbort(ctx, rec);
      return 'failed';
    }
    const run = PHASES[rec.phase]!;
    let next: Next;
    try {
      next = await run({ ctx, m, rec, status });
    } catch (e) {
      // the switch and the copy fail only on purpose (a DB error retries the phase); the phases before the switch on anything
      if (!(e instanceof MoveFailed) && !ABORTABLE.includes(rec.phase)) throw e;
      const code = codeOf(e);
      log?.warn({ phase: rec.phase, code }, 'media move failed; aborting it');
      if (await markFailed(ctx, rec.phase, code, e instanceof MoveFailed ? e.meta : undefined)) {
        await sendAbort(ctx, { ...rec, phase: 'failed', error: code });
        return 'failed';
      }
      return (await readManaged(ctx.db)).move?.phase ?? 'idle';
    }
    if (next === 'waiting') return 'waiting';
    if (await advance(ctx, rec.phase, next)) return next;
    return (await readManaged(ctx.db)).move?.phase ?? 'idle';
  } finally {
    await ctx.kv.delIfEquals(MOVE_LOCK, token).catch(() => undefined);
  }
}
