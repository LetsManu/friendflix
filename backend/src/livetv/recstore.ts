// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { m } from '../i18n.js';
import { notify, notifyAdmins } from '../notify.js';
import { LivetvError, livetvCall } from './client.js';
import { livetvInstalled } from './detect.js';
import { pushEvent } from './events.js';
import { completeDelete, deleteRecording, getRecording, libraryModeAvailable, recordSettings, removeFiles, type RecRow } from './recordings.js';
import { finishHooks } from './recsched.js';
import type { ExportAnswer } from './wire.js';

/**
 * Where recordings live and how long (spec §15.3, §15.5; plan Phase 3 Task 6).
 *
 * - Storage modes: `ff` keeps the HLS folder; `library` exports one file into the Jellyfin library folder after the end (livetv
 *   concatenates without re-encoding), deletes the HLS folder, asks Jellyfin to scan and links the item by its path; `both` keeps
 *   the HLS folder and exports on *Behalten → in Bibliothek* (which also sets `keep`). An export that fails keeps the FriendFlix
 *   copy and notes `rec_export_failed`. Without the media server's library seam (Plex) only `ff` is offered.
 * - Space: usage = the bytes of every recording (FriendFlix folder and library). Above 90 % of the limit the oldest unprotected
 *   finished recordings are scheduled for deletion in 24 h (their owners are told) until the forecast is ≤ 80 %; the admins hear of it
 *   once a day. Due ones are deleted, as are recordings watched more than LIVETV_RECORD_RETENTION_DAYS ago; *Behalten* protects from both.
 *
 * Nothing here logs a title or a path; admin notices carry sizes only.
 */
/**
 * N3: livetv's whole export (staging copy, remux, probe, decode checks) runs within its 25-min budget (library.ts EXPORT_BUDGET_MS) and
 * then stops; this wait is 30 min, so it never ends before livetv has answered. The export lock (35 min) and the store lock (40 min)
 * outlast it.
 */
const EXPORT_TIMEOUT_MS = 30 * 60_000;
const CALL_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
const SPACE_KEY = 'ltv:recspace';
const SPACE_EVERY_S = 3600;
const LINK_WINDOW_MS = 2 * DAY_MS;

const event = (ctx: Ctx, e: Parameters<typeof pushEvent>[1]) => pushEvent(ctx, e).catch(() => undefined);

/**
 * The bytes of every recording that has files: the FriendFlix folder and the library, a recording being deleted, and the queued files
 * of rows a profile or account deletion took away (until the space job removed them, A-I4).
 */
export async function usage(ctx: Pick<Ctx, 'db'>): Promise<number> {
  return Number((await ctx.db.query<{ n: string | null }>(
    `select coalesce((select sum(bytes) from livetv_recordings where state not in ('scheduled','starting')), 0)
          + coalesce((select sum(bytes) from livetv_recording_purges), 0) as n`)).rows[0]?.n ?? 0);
}

/** "YYYY-MM-DD HH.mm" in the server's time zone (the library file name, spec §15.3) */
export function stamp(d: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}.${v('minute')}`;
}

/** the library item of an exported recording, matched by its path as Jellyfin sees it (null while its scan has not found it) */
async function linkItem(ctx: Ctx, r: Pick<RecRow, 'id' | 'library_path'>): Promise<string | null> {
  const s = recordSettings(ctx);
  const find = ctx.jf.admin.itemByPath?.bind(ctx.jf.admin);
  if (!find || !s.libraryId || !r.library_path) return null;
  const id = await find(s.libraryId, `${s.libraryJfPath.replace(/\/+$/, '')}/${r.library_path}`).catch(() => null);
  if (id) await ctx.db.query('update livetv_recordings set jellyfin_item_id = $2 where id = $1', [r.id, id]);
  return id;
}

export type ExportResult = 'exported' | 'not_available' | 'not_found' | 'failed' | 'busy';
const exportKey = (id: string) => `ltv:recexport:${id}`;
const EXPORT_LOCK_S = 35 * 60;

/**
 * Exports a finished recording into the Jellyfin library folder (mode `library` after its end; `both` on *Behalten → in Bibliothek*,
 * `keep`). Mode `library` then deletes the HLS folder. A failure keeps the FriendFlix copy and notes `rec_export_failed` for the admins.
 */
export async function exportToLibrary(ctx: Ctx, id: string, o: { keep?: boolean } = {}): Promise<ExportResult> {
  // one export of a recording at a time, across processes (A-M7: a double click, the store job and a route)
  const token = `${Date.now()}-${Math.random()}`;
  if (!(await ctx.kv.setnx(exportKey(id), token, EXPORT_LOCK_S).catch(() => false))) return 'busy';
  try {
    return await exportLocked(ctx, id, o);
  } finally {
    await ctx.kv.delIfEquals(exportKey(id), token).catch(() => false);
  }
}

async function exportLocked(ctx: Ctx, id: string, o: { keep?: boolean }): Promise<ExportResult> {
  const r = await getRecording(ctx, id);
  if (!r || (r.state !== 'done' && r.state !== 'partial')) return 'not_found';
  const s = recordSettings(ctx);
  const fail = async (reason: string): Promise<ExportResult> => {
    await ctx.db.query("update livetv_recordings set export_state = 'failed' where id = $1 and export_state = 'pending'", [r.id]);
    await event(ctx, { level: 'error', code: 'rec_export_failed', ...(r.channel_id ? { channelId: r.channel_id } : {}), recordingId: r.id, reason });
    return reason === 'no_library' ? 'not_available' : 'failed';
  };
  if (!libraryModeAvailable(ctx) || !s.libraryId) return fail('no_library');
  if (r.library_path) {
    if (o.keep) await ctx.db.query('update livetv_recordings set keep = true, delete_after = null, delete_warned_at = null where id = $1', [id]);
    return 'exported';
  }
  if (!livetvInstalled(ctx)) return fail('livetv_off');
  // N2: livetv stages a copy of the recording beside it while it exports; that copy must fit under the recordings limit too (livetv
  // checks the volumes' free space itself, keeping room for running recordings)
  if ((await usage(ctx)) + Number(r.bytes) > s.limitBytes) return fail('storage_full');
  const rule = r.rule_id ? (await ctx.db.query<{ kind: string; title: string }>('select kind, title from livetv_recording_rules where id = $1', [r.rule_id])).rows[0] : undefined;
  const folder = rule?.kind === 'series' ? rule.title : r.title;
  let ans: ExportAnswer;
  try {
    ans = await livetvCall<ExportAnswer>(ctx, 'POST', `/v1/recordings/${r.id}/export`, { dir: r.dir, folder, file: `${r.title} – ${stamp(r.start_at)}` }, { timeoutMs: EXPORT_TIMEOUT_MS });
  } catch (e) {
    // livetv runs one export at a time (M1) and keeps a younger part file of another export (I1): this one stays pending for the next run
    if (e instanceof LivetvError && e.code === 'busy') return 'busy';
    if (e instanceof LivetvError) return fail(/^[a-z_]{1,40}$/.test(e.code) ? e.code : 'export_failed');
    throw e;
  }
  if (typeof ans?.path !== 'string' || typeof ans.bytes !== 'number') return fail('invalid_answer');
  const libraryOnly = r.storage === 'library';
  await ctx.db.query(
    `update livetv_recordings set library_path = $2, export_state = null, keep = keep or $3, bytes = case when $4 then $5::bigint else bytes + $5::bigint end,
       delete_after = case when $3 then null else delete_after end where id = $1`,
    [r.id, ans.path, o.keep === true, libraryOnly, Math.max(0, Math.round(ans.bytes))]);
  // mode library: the FriendFlix folder goes (its playback tokens now answer 410); a failed removal leaves a folder the next delete takes
  if (libraryOnly) {
    await livetvCall(ctx, 'POST', `/v1/recordings/${r.id}/delete`, { dir: r.dir }, { timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined);
  }
  await ctx.jf.admin.refreshLibrary?.(s.libraryId).catch(() => undefined);
  await linkItem(ctx, { id: r.id, library_path: ans.path });
  return 'exported';
}

const gb = (n: number) => `${Math.round(n / 1_000_000_000)} GB`;

/**
 * Space and retention (spec §15.5): pending removals are finished, due automatic deletions run, recordings watched long enough ago go,
 * and above 90 % of the limit the oldest unprotected finished ones are scheduled for deletion (24 h notice) until the forecast is ≤ 80 %.
 */
export async function spaceTick(ctx: Ctx, now: number = Date.now()): Promise<void> {
  const s = recordSettings(ctx);
  // deletes that did not finish (a revocation or livetv did not confirm): revocations again, then the recorder, the files and the row
  for (const r of (await ctx.db.query<RecRow>("select * from livetv_recordings where state = 'deleting' order by delete_after limit 100")).rows) {
    await completeDelete(ctx, r, { stop: true }).catch(() => 'pending');
  }
  // the files of rows a profile or account deletion took (the purge trigger queued them): recorder, folder, library file and rescan
  for (const q of (await ctx.db.query<{ recording_id: string; dir: string; library_path: string | null }>(
    'select recording_id, dir, library_path from livetv_recording_purges order by created_at limit 100')).rows) {
    if (await removeFiles(ctx, { id: q.recording_id, dir: q.dir, library_path: q.library_path }, { stop: true }).catch(() => false)) {
      await ctx.db.query('delete from livetv_recording_purges where recording_id = $1', [q.recording_id]);
    }
  }
  // due automatic deletions (the owner was told 24 h ago)
  for (const r of (await ctx.db.query<{ id: string }>(
    "select id from livetv_recordings where state in ('done','partial','failed') and not keep and delete_after <= $1 order by delete_after", [new Date(now)])).rows) {
    await deleteRecording(ctx, r.id, 'space');
  }
  // retention: N days after the owner profile watched it
  if (s.retentionDays > 0) {
    for (const r of (await ctx.db.query<{ id: string }>(
      "select id from livetv_recordings where state in ('done','partial') and not keep and watched_at <= $1", [new Date(now - s.retentionDays * DAY_MS)])).rows) {
      await deleteRecording(ctx, r.id, 'retention');
    }
  }
  // past cancelled airings protect nothing any more (a rule plans from now on): pruned (A-M1); files are never among them
  await ctx.db.query("delete from livetv_recordings where state = 'cancelled' and delete_after is null and mode is null and bytes = 0 and start_at < $1", [new Date(now - DAY_MS)]);
  // the limit
  const used = await usage(ctx);
  if (used > 0.9 * s.limitBytes) {
    const pending = Number((await ctx.db.query<{ n: string | null }>(
      "select sum(bytes) as n from livetv_recordings where state in ('done','partial','failed') and delete_after is not null")).rows[0]?.n ?? 0);
    let forecast = used - pending;
    const candidates = (await ctx.db.query<RecRow>(
      "select * from livetv_recordings where state in ('done','partial') and not keep and delete_after is null order by start_at, id")).rows;
    for (const c of candidates) {
      if (forecast <= 0.8 * s.limitBytes) break;
      const u = await ctx.db.query("update livetv_recordings set delete_after = $2, delete_warned_at = $3 where id = $1 and not keep and delete_after is null",
        [c.id, new Date(now + DAY_MS), new Date(now)]);
      if (!u.rowCount) continue;
      forecast -= Number(c.bytes);
      await notify(ctx, {
        userId: c.user_id, kind: 'livetv.rec.deleting', title: m('livetv.rec.deleting.title', { title: c.title }), link: '/live/recordings', dedupe: `ltvrec-deleting-${c.id}`, personal: true,
      }).catch(() => undefined);
    }
    const day = new Date(now).toISOString().slice(0, 10);
    await notifyAdmins(ctx, { kind: 'livetv.rec.storage', title: m('livetv.rec.storage.title', { used: gb(used), limit: gb(s.limitBytes) }), link: '/admin/livetv', dedupe: `ltvrec-storage-${day}` }).catch(() => 0);
  }
  // library items the scan has found since their export
  for (const r of (await ctx.db.query<Pick<RecRow, 'id' | 'library_path'>>(
    'select id, library_path from livetv_recordings where library_path is not null and jellyfin_item_id is null and end_at > $1 limit 20', [new Date(now - LINK_WINDOW_MS)])).rows) {
    await linkItem(ctx, r);
  }
}

const STORE_LOCK = 'ltv:recstore';
/** one export may take EXPORT_TIMEOUT_MS; the lock outlasts it, and no new export starts after EXPORT_BUDGET_MS (the rest: next run) */
const STORE_LOCK_S = 40 * 60;
const EXPORT_BUDGET_MS = 5 * 60_000;
const SPACE_DUE = 'ltv:recspace:due';

/**
 * The store job (A-I2; server.ts every 30 s, one runner: KV `ltv:recstore`), apart from the 15-s recording tick so a long export never
 * delays a start, a resume or a stop: the pending library exports, then the space check when a recording finished since (or once an
 * hour).
 */
export async function livetvStoreTick(ctx: Ctx): Promise<void> {
  const token = `${Date.now()}-${Math.random()}`;
  if (!(await ctx.kv.setnx(STORE_LOCK, token, STORE_LOCK_S).catch(() => false))) return;
  try {
    const t0 = Date.now();
    for (const r of (await ctx.db.query<{ id: string }>("select id from livetv_recordings where export_state = 'pending' and state in ('done','partial') order by end_at limit 20")).rows) {
      if (Date.now() - t0 > EXPORT_BUDGET_MS) break;
      await exportToLibrary(ctx, r.id).catch(() => 'failed');
    }
    const due = await ctx.kv.take(SPACE_DUE).catch(() => null);
    if (due || (await ctx.kv.setnx(SPACE_KEY, '1', SPACE_EVERY_S).catch(() => false))) await spaceTick(ctx);
  } finally {
    await ctx.kv.delIfEquals(STORE_LOCK, token).catch(() => false);
  }
}

/** kept for callers of the hourly space check; the store job does the same and more */
export const livetvSpaceTick = livetvStoreTick;

// a finished recording (recsched.ts collect): mode `library` queues its export, and the space check is due; both run in the store job
finishHooks.finished = async (ctx, row) => {
  if (row.storage === 'library' && !row.library_path) await ctx.db.query("update livetv_recordings set export_state = 'pending' where id = $1 and export_state is null", [row.id]);
  await ctx.kv.set(SPACE_DUE, '1', 3600).catch(() => undefined);
};
