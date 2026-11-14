// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Ctx } from '../ctx.js';
import { recordError } from '../errorlog.js';
import { m } from '../i18n.js';
import { notifyAdmins } from '../notify.js';
import { isOwnFeeds } from './channels.js';
import { LivetvError, livetvCall } from './client.js';
import { livetvInstalled } from './detect.js';
import { autoMatch, LOGO_BUDGET_MS, refreshEpg } from './epg.js';
import { pushEvent } from './events.js';
import { mergeImport, type ImportResult } from './import.js';
import { importLogos } from './logos.js';
import { invalidateLivetvRights } from './rights.js';
import { dropPendingFile, fileLabel, promoteGuideFile, receiveGuideFile, removeGuideFiles, removeOtherKind, type PendingFile } from './guidefiles.js';
import { isFileGuide, isGuide, sourceSecrets, type Refresh, type SourceRow } from './sources.js';
import type { FetchM3uAnswer, M3uEntry } from './wire.js';

/**
 * Refreshing a provider source (spec §10 jobs, §19): `/v1/fetch/m3u` through livetv with the source's skip list, the import merge,
 * the logos, then the `last_*` columns, then the EPG step (epg.ts; at least every 24 h through the tick). A list failure changes no
 * channel; it is stored as a fixed code in `last_error` (never a URL or a provider text, F13), pushed as the event
 * `source_refresh_failed` (F20), and the third failure in a row tells the admins (`livetv.source.failed`, once a day per source).
 * `livetvRefreshTick` (every 5 min, server.ts) refreshes the due sources.
 */

const LOCK_TTL_S = 15 * 60;
const TICK_LOCK = 'ltv:refresh-tick';
const TICK_LOCK_TTL_S = 30 * 60;
/** consecutive failures; kept long enough for three weekly refreshes in a row */
const FAILS_TTL_S = 30 * 24 * 3600;
const NOTIFY_AFTER = 3;
/** spec §10 jobs: the EPG of a source is refreshed at least this often, also for sources with refresh 'manual' (the guide would run dry) */
export const EPG_MAX_AGE_MS = 24 * 3600_000;
/** a source whose last refresh failed is tried again after this, or after its interval when that is shorter */
const RETRY_MS = 3600_000;
/** livetv itself was not reached: counted towards the admin notice only while detection still sees livetv (see failed) */
const LIVETV_DOWN = 'livetv_unreachable';
/** livetv's own M3U timeout is 60 s; the backend waits a little longer so livetv answers the code */
const M3U_TIMEOUT_MS = 75_000;
const ADMIN_LINK = '/admin/livetv';

export const REFRESH_INTERVAL_MS: Record<Exclude<Refresh, 'manual'>, number> = {
  '6h': 6 * 3600_000,
  '12h': 12 * 3600_000,
  '24h': 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};

const lockKey = (id: string) => `ltv:refresh:${id}`;
const failsKey = (id: string) => `ltv:fails:${id}`;

const KINDS: readonly string[] = ['hls', 'ts', 'srt'];
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** one entry of livetv's answer, read defensively (its strings come from a provider); null = dropped */
function readEntry(v: unknown): M3uEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!str(o.key, 200) || !str(o.name, 500) || !int(o.pos) || o.pos < 0 || !str(o.url, 4096) || !KINDS.includes(o.kind as string)) return null;
  const e: M3uEntry = { key: o.key, name: o.name, pos: o.pos, url: o.url, kind: o.kind as M3uEntry['kind'] };
  if (str(o.tvgId, 500)) e.tvgId = o.tvgId;
  if (str(o.tvgName, 500)) e.tvgName = o.tvgName;
  if (int(o.chno) && o.chno >= 0 && o.chno <= 2_147_483_647) e.chno = o.chno;
  if (str(o.group, 500)) e.group = o.group;
  if (str(o.logo, 4096)) e.logo = o.logo;
  if (int(o.shiftMin) && o.shiftMin >= -720 && o.shiftMin <= 840) e.shiftMin = o.shiftMin;
  return e;
}

function readAnswer(a: FetchM3uAnswer | undefined): { entries: M3uEntry[]; listed: number } {
  if (!a || !Array.isArray(a.entries) || !int(a.listed) || a.listed < 0) throw new LivetvError(200, 'invalid_answer');
  return { entries: a.entries.map(readEntry).filter((e): e is M3uEntry => e !== null), listed: a.listed };
}

/** the source was edited while its list was fetched (importList): not a failure, nothing is recorded */
class SourceChanged extends Error {}

/** a failure as the fixed code stored in `last_error` and sent as the event reason */
class RefreshFailed extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RefreshFailed';
  }
}

/** the import_logo_hash of every entry: the hash found, null for an entry without a logo, unchanged where none was found this time */
async function storeLogos(ctx: Ctx, source: SourceRow, entries: readonly M3uEntry[]): Promise<void> {
  const urls = entries.flatMap((e) => (e.logo ? [e.logo] : []));
  try {
    const found = urls.length ? await importLogos(ctx, urls, source.allow_lan, Date.now() + LOGO_BUDGET_MS) : new Map<string, string>();
    const keys: string[] = [];
    const hashes: Array<string | null> = [];
    for (const e of entries) {
      if (!e.logo) { keys.push(e.key); hashes.push(null); continue; }
      const h = found.get(e.logo);
      if (h) { keys.push(e.key); hashes.push(h); }
    }
    for (let i = 0; i < keys.length; i += 2000) {
      await ctx.db.query(
        `update livetv_channels c set import_logo_hash = u.hash from unnest($2::text[], $3::text[]) as u(key, hash)
          where c.source_id = $1 and c.source_key = u.key and c.import_logo_hash is distinct from u.hash`,
        [source.id, keys.slice(i, i + 2000), hashes.slice(i, i + 2000)]);
    }
  } finally {
    invalidateLivetvRights(); // also after a partial write
  }
}

/** the list step: fetch, merge, logos. Throws RefreshFailed with the fixed code. */
async function importList(ctx: Ctx, source: SourceRow, url: string, rev: string): Promise<ImportResult> {
  let fetched: { entries: M3uEntry[]; listed: number };
  try {
    const a = await livetvCall<FetchM3uAnswer>(ctx, 'POST', '/v1/fetch/m3u', {
      url, allowLan: source.allow_lan, ...(source.user_agent ? { userAgent: source.user_agent } : {}), skipGroups: source.skip_groups,
    }, { timeoutMs: M3U_TIMEOUT_MS });
    fetched = readAnswer(a);
  } catch (e) {
    // livetv's code when it is one (client.ts), `livetv_error` for anything else it answered; not reached = livetv_unreachable
    if (e instanceof LivetvError) throw new RefreshFailed(e.status === null ? 'livetv_unreachable' : e.code);
    throw e;
  }
  const r = await mergeImport(ctx, source, fetched, new Date(), rev);
  if ('error' in r) throw r.error === 'changed' ? new SourceChanged() : new RefreshFailed(r.error);
  // the logos of the entries the merge kept (mergeImport drops skipped groups again); the merge has committed, so a failing logo step
  // does not turn the refresh into a failure: it is recorded as a job error (code only) and the next refresh fetches the logos it missed
  const skip = new Set(source.skip_groups);
  await storeLogos(ctx, source, fetched.entries.filter((e) => !e.group || !skip.has(e.group)))
    .catch(() => recordError(ctx, { source: 'job', code: 'livetv-logos' }));
  return r;
}

/**
 * records a failure: `last_error`, the event, the failure count and, from the third in a row, the admin notification. livetv not being
 * reached (`livetv_unreachable`) is always recorded and pushed, but counted only while detection still sees livetv installed: then
 * livetv is up but this source makes it hang or crash, which the admin must hear about; while livetv is off it is not the list's fault.
 */
async function failed(ctx: Ctx, source: SourceRow, code: string, now: Date, rev?: string): Promise<void> {
  // an edit made while the refresh ran keeps its "import again" mark (last_refresh_at null): the row's version must still be the one read
  await ctx.db.query(
    'update livetv_sources set last_refresh_at = case when $4::text is null or updated_at::text = $4 then $2 else last_refresh_at end, last_error = $3 where id = $1',
    [source.id, now, code, rev ?? null]);
  await pushEvent(ctx, { level: 'warn', code: 'source_refresh_failed', sourceId: source.id, reason: code });
  if (code === LIVETV_DOWN && !livetvInstalled(ctx)) return;
  const n = await ctx.kv.incr(failsKey(source.id), FAILS_TTL_S);
  if (n >= NOTIFY_AFTER) {
    // the source's name only (an admin's label), never its URL; at most once a day per source while it keeps failing
    await notifyAdmins(ctx, {
      kind: 'livetv.source.failed',
      title: m('livetv.source.failed.title'),
      body: m('livetv.source.failed.body', { source: source.name }),
      link: ADMIN_LINK,
      dedupe: `livetv-source-${source.id}-${now.toISOString().slice(0, 10)}`,
    });
  }
}

/**
 * Refreshes one provider source (`trigger` 'tick' from livetvRefreshTick, 'admin' from *Aktualisieren*). Single flight per source
 * (`ltv:refresh:<id>`, 15 min): a refresh that is already running is not started again. The own-feeds source has no list and is
 * never fetched. Provider failures are recorded (see failed) and never thrown; anything else is recorded as `internal` and rethrown.
 */
export async function refreshSource(ctx: Ctx, id: string, trigger: 'tick' | 'admin'): Promise<void> {
  void trigger; // both run the same steps; the tick has chosen only due, enabled sources (a manual one only when marked due)
  const token = randomBytes(12).toString('hex');
  if (!(await ctx.kv.setnx(lockKey(id), token, LOCK_TTL_S))) return;
  try {
    // `rev` = the row's version (updated_at as text, microseconds kept) the whole refresh is based on (an edit moves it)
    const source = (await ctx.db.query<SourceRow & { rev: string }>('select *, updated_at::text as rev from livetv_sources where id = $1', [id])).rows[0];
    // an extra guide has no list: *Aktualisieren* runs only its EPG import (the list import never runs for it)
    if (source && isGuide(source.kind)) {
      if (hasEpg(source)) await epgStep(ctx, source, token);
      return;
    }
    if (!source || isOwnFeeds(source.kind) || !source.url_enc) return;
    const rev = source.rev;
    const now = new Date();
    let r: ImportResult;
    try {
      // inside the try: a URL that cannot be decrypted (a changed key) is recorded on the source as `internal`, not rethrown unseen
      const { url } = await sourceSecrets(ctx, id);
      if (!url) return;
      r = await importList(ctx, source, url, rev);
    } catch (e) {
      if (e instanceof SourceChanged) {
        // the admin edited the source while the list was fetched: nothing was written; the source stays due so the next tick imports
        // the edited settings (also for an edit that did not set the mark itself)
        await ctx.db.query('update livetv_sources set last_refresh_at = null where id = $1', [id]);
        return;
      }
      if (e instanceof RefreshFailed) return await failed(ctx, source, e.code, now, rev);
      await failed(ctx, source, 'internal', now, rev).catch(() => undefined);
      throw e;
    }

    const counts = { channels: r.total, added: r.added, updated: r.updated, removed: r.missing, returned: r.returned, listed: r.listed, newGroups: r.newGroups };
    // only while the row is still the one this refresh read: an edit that landed after the merge keeps its mark and its `listed` reset
    const wrote = await ctx.db.query(
      'update livetv_sources set last_refresh_at = $2, last_ok_at = $2, last_error = null, last_counts = $3 where id = $1 and updated_at::text = $4',
      [id, now, JSON.stringify(counts), rev]);
    if (wrote.rowCount === 0) await ctx.db.query('update livetv_sources set last_refresh_at = null where id = $1', [id]);
    else await ctx.kv.del(failsKey(id));

    // the EPG step, after the list (its result is stored first, so the admin sees it while the EPG runs). The list step may have taken
    // minutes: renew the single-flight lock before the long step, never taking over another owner's; the EPG step renews it again.
    await ctx.kv.refreshIfEquals(lockKey(id), token, LOCK_TTL_S);
    if (hasEpg(source)) await epgStep(ctx, source, token);
    // no EPG of its own: the new channels are still matched against the other sources' EPG (no logo fetch without icons)
    else await autoMatch(ctx);
  } finally {
    await ctx.kv.delIfEquals(lockKey(id), token);
  }
}

/**
 * F16: the own-feeds source and a source without an EPG URL have no EPG step, and so never an EPG error; an uploaded guide has one once
 * a file is stored
 */
const hasEpg = (s: { kind: string; guide_provider: string | null; has_epg: boolean; has_file: boolean } | SourceRow) =>
  !isOwnFeeds(s.kind) && (isFileGuide(s) ? ('has_file' in s ? s.has_file : s.guide_file !== null) : ('has_epg' in s ? s.has_epg : s.epg_url_enc !== null));

/** the EPG step under the caller's lock (renewed while the XMLTV stream is read); its outcome is in `epg_last_*` (epg.ts) */
async function epgStep(ctx: Ctx, source: SourceRow & { rev?: string }, token: string): Promise<void> {
  await refreshEpg(ctx, source, { heartbeat: () => ctx.kv.refreshIfEquals(lockKey(source.id), token, LOCK_TTL_S) });
}

/**
 * Refreshes only the EPG of a source (the tick's 24-h due check), under the same single-flight lock as refreshSource. The own-feeds
 * source and a source without an EPG URL are skipped (F16).
 */
export async function refreshSourceEpg(ctx: Ctx, id: string): Promise<void> {
  const token = randomBytes(12).toString('hex');
  if (!(await ctx.kv.setnx(lockKey(id), token, LOCK_TTL_S))) return;
  try {
    const source = (await ctx.db.query<SourceRow & { rev: string }>('select *, updated_at::text as rev from livetv_sources where id = $1', [id])).rows[0];
    if (!source || !hasEpg(source)) return;
    await epgStep(ctx, source, token);
  } finally {
    await ctx.kv.delIfEquals(lockKey(id), token);
  }
}

/**
 * EPG due: never refreshed or older than 24 h (1 h after a failed one, like the list), whatever the source's list refresh is (also
 * 'manual'). An extra guide has no list, so its own interval applies to its EPG, but never rarer than every 24 h (and 1 h after a failure).
 */
function epgDue(s: { kind: string; refresh: Refresh; epg_last_refresh_at: Date | null; epg_last_error: string | null }, now: number): boolean {
  if (s.epg_last_refresh_at === null) return true;
  const every = isGuide(s.kind) && s.refresh !== 'manual' ? Math.min(REFRESH_INTERVAL_MS[s.refresh], EPG_MAX_AGE_MS) : EPG_MAX_AGE_MS;
  return now - s.epg_last_refresh_at.getTime() >= (s.epg_last_error === null ? every : Math.min(every, RETRY_MS));
}

/**
 * due: never refreshed (or marked due by an edit, Task 15), or the last attempt is older than the source's interval; after a failed
 * attempt (`last_error` set) older than min(interval, 1 h), so three failures in a row reach the admins within hours, not days.
 * A source with refresh *Manuell* is never refreshed on a schedule, but it is imported once when it is new or an edit marked it due
 * (a changed group selection, numbering or URL; bughunt L1): its attempt sets `last_refresh_at` again, so that happens once.
 */
function due(s: { refresh: Refresh; last_refresh_at: Date | null; last_error: string | null }, now: number): boolean {
  if (s.last_refresh_at === null) return true;
  if (s.refresh === 'manual') return false;
  const interval = REFRESH_INTERVAL_MS[s.refresh];
  return now - s.last_refresh_at.getTime() >= (s.last_error === null ? interval : Math.min(interval, RETRY_MS));
}

/**
 * An upload to an uploaded guide (`PUT /api/admin/livetv/sources/:id/file`), under the source's single-flight lock (the one refreshes
 * use: a second upload, or an upload while *Aktualisieren* runs, is `import_running`). The body is streamed to the pending file
 * (guidefiles.ts, at most GUIDE_FILE_MAX_BYTES: `too_large`), then the import starts and this answers `{ started: true }` while it runs
 * in the background (its outcome is the source's `epg_last_*`, as after *Aktualisieren*). Only a successful import makes the pending
 * file the guide's file (`guide_file`, `guide_file_name`, `guide_file_bytes`); a failed one drops it and keeps the old file, its
 * programmes and its index. A guide deleted meanwhile loses the upload's files too. An upload that stalls (nothing for a minute: `idle`) or
 * whose lock can no longer be renewed (`lost`, answered as `import_running`) is stopped and leaves no file.
 */
export async function uploadGuideFile(
  ctx: Ctx, id: string, body: Readable, o: { name?: string; max?: number; idleMs?: number; log: { warn(o: object, m: string): void } },
): Promise<{ started: true } | { error: 'import_running' | 'too_large' | 'empty' | 'broken' | 'idle' | 'not_found' }> {
  const token = randomBytes(12).toString('hex');
  if (!(await ctx.kv.setnx(lockKey(id), token, LOCK_TTL_S))) return { error: 'import_running' };
  const renew = () => ctx.kv.refreshIfEquals(lockKey(id), token, LOCK_TTL_S);
  let started = false;
  try {
    const got = await receiveGuideFile(ctx, id, body, { max: o.max, idleMs: o.idleMs, renew });
    if ('error' in got) {
      if (got.error === 'lost') return { error: 'import_running' };
      if (got.error === 'gone') return { error: 'not_found' };
      return { error: got.error };
    }
    // `rev`: the row's version this import is based on (an edit while it runs keeps its "import again" mark; epg.ts record)
    const source = (await ctx.db.query<SourceRow & { rev: string }>('select *, updated_at::text as rev from livetv_sources where id = $1', [id])).rows[0];
    if (!source || !isFileGuide(source)) { await removeGuideFiles(ctx, id); return { error: 'not_found' }; }
    started = true;
    void importUpload(ctx, source, got, fileLabel(o.name), renew)
      .catch((e: unknown) => { o.log.warn({ sourceId: id, error: e instanceof Error ? e.name : 'unknown' }, 'livetv guide file import failed'); })
      .finally(() => ctx.kv.delIfEquals(lockKey(id), token).catch(() => undefined));
    return { started: true };
  } finally {
    if (!started) await ctx.kv.delIfEquals(lockKey(id), token);
  }
}

/**
 * the import of a received upload (under the caller's lock); the pending file goes whatever happens, promoted or dropped. The promoted
 * file is named in the row first; only then does a stored file of the other kind go (a failed update never leaves `guide_file` naming a
 * removed file).
 */
async function importUpload(ctx: Ctx, source: SourceRow, file: PendingFile, label: string | null, heartbeat: () => Promise<unknown>): Promise<void> {
  let promoted = false;
  try {
    await refreshEpg(ctx, source, {
      heartbeat, file,
      onSuccess: async () => {
        const name = await promoteGuideFile(ctx, source.id, file);
        promoted = true;
        const row = await ctx.db.query(
          'update livetv_sources set guide_file = $2, guide_file_name = $3, guide_file_bytes = $4 where id = $1',
          [source.id, name, label ?? (file.gz ? 'guide.xml.gz' : 'guide.xml'), file.bytes]);
        // deleted while it was imported: the delete may have run before the rename, so its files go now
        if (!row.rowCount) await removeGuideFiles(ctx, source.id);
        else await removeOtherKind(ctx, source.id, name);
      },
    });
  } finally {
    if (!promoted) await dropPendingFile(file);
  }
}

/** whether a refresh of the source is running now (its single-flight lock is held) */
export async function refreshRunning(ctx: Pick<Ctx, 'kv'>, id: string): Promise<boolean> {
  return (await ctx.kv.get(lockKey(id))) !== null;
}

/**
 * Every 5 minutes (server.ts, behind op()): refreshes the enabled provider sources that are due, one after the other. Nothing runs
 * while livetv is not installed (detection), else every source would fail. Sources with refresh 'manual' are refreshed by the
 * admin, and once by the tick when they are new or an edit marked them due (bughunt L1). The own-feeds source is skipped first, before the due check (F16): it has no list, so it is never fetched and never fails.
 * One tick at a time across processes (`ltv:refresh-tick`, renewed after each source).
 */
export async function livetvRefreshTick(ctx: Ctx): Promise<void> {
  if (!livetvInstalled(ctx)) return;
  const token = randomBytes(12).toString('hex');
  if (!(await ctx.kv.setnx(TICK_LOCK, token, TICK_LOCK_TTL_S))) return;
  let first: unknown;
  try {
    type TickRow = Pick<SourceRow, 'id' | 'kind' | 'guide_provider' | 'refresh' | 'enabled' | 'last_refresh_at' | 'last_error' | 'epg_last_refresh_at' | 'epg_last_error'>
      & { has_url: boolean; has_epg: boolean; has_file: boolean };
    const sql = `select id, kind, guide_provider, refresh, enabled, last_refresh_at, last_error, epg_last_refresh_at, epg_last_error,
                        url_enc is not null as has_url, epg_url_enc is not null as has_epg, guide_file is not null as has_file
                   from livetv_sources order by position, created_at, id`;
    const rows = (await ctx.db.query<TickRow>(sql)).rows;
    for (const s of rows) {
      if (isOwnFeeds(s.kind) || !s.has_url) continue; // F16: no list to fetch, never an error
      if (!s.enabled || !due(s, Date.now())) continue;
      // one failing source must not stop the others; the first unexpected error is rethrown at the end (jobFailed logs it)
      try { await refreshSource(ctx, s.id, 'tick'); } catch (e) { first ??= e; }
      // one refresh can take minutes: keep the tick lock while this process still owns it
      await ctx.kv.refreshIfEquals(TICK_LOCK, token, TICK_LOCK_TTL_S);
    }

    // EPG due (spec §10 jobs): never rarer than every 24 h, also for 'manual' sources and for sources whose list just failed; read again,
    // since the list refreshes above ran their EPG step already. No EPG URL or the own-feeds source: skipped, never an error (F16).
    // Extra guides (no list, so skipped above) are refreshed here, on their own interval; a disabled one never. An uploaded guide is never
    // refreshed on a schedule (its file changes only with an upload, which imports it); only once after an edit marked it due (its scope
    // changed or it was switched on: other channels need its programmes), like a list with refresh *Manuell*.
    for (const s of (await ctx.db.query<TickRow>(sql)).rows) {
      if (!hasEpg(s) || !s.enabled) continue;
      if (isFileGuide(s) ? s.epg_last_refresh_at !== null : !epgDue(s, Date.now())) continue;
      try { await refreshSourceEpg(ctx, s.id); } catch (e) { first ??= e; }
      await ctx.kv.refreshIfEquals(TICK_LOCK, token, TICK_LOCK_TTL_S);
    }
  } finally {
    await ctx.kv.delIfEquals(TICK_LOCK, token);
  }
  if (first !== undefined) throw first;
}
