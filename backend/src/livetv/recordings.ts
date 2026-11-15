// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { effectiveRights } from '../rights.js';
import { CHANNEL_SELECT, toEffective, type EffectiveRow } from './channels.js';
import { LivetvError, livetvCall } from './client.js';
import { livetvInstalled } from './detect.js';
import { recordError } from '../errorlog.js';
import { channelSet, type LivetvProfile, type LivetvUser } from './rights.js';

/**
 * Recordings (spec §6.3, §15; plan Phase 3 Task 1): the rows, the view a client gets, who may see a recording (§15.6), *Behalten* and
 * sharing, and the one delete path every deleter takes (owner, admin, retention, space). The backend never touches `/recordings`
 * itself: the recorder is stopped and the files are removed through signed livetv calls by recording id and folder (a uuid), never by
 * a client-supplied path. Nothing here logs a title, a path or a token.
 */
export type RecState = 'scheduled' | 'starting' | 'recording' | 'done' | 'partial' | 'failed' | 'cancelled' | 'deleting';
export const REC_STATES: readonly RecState[] = ['scheduled', 'starting', 'recording', 'done', 'partial', 'failed', 'cancelled', 'deleting'];
export type Visibility = 'private' | 'account' | 'everyone';
export const VISIBILITIES: readonly Visibility[] = ['private', 'account', 'everyone'];
export type RecMode = 'passthrough' | 'remux' | 'transcode';
/** an outage inside a recording (or its late start): epoch ms */
export interface Gap { from: number; to: number }

export interface RecRow {
  id: string;
  profile_id: string | null;
  user_id: string;
  rule_id: string | null;
  channel_id: string | null;
  channel_name: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  episode: string | null;
  series_key: string | null;
  start_at: Date;
  end_at: Date;
  pad_before_s: number;
  pad_after_s: number;
  state: RecState;
  claim_token: string | null;
  claim_until: Date | null;
  mode: RecMode | null;
  segments: 'ts' | 'fmp4' | null;
  follow_epg: boolean;
  prog_key: string | null;
  storage: 'ff' | 'library';
  dir: string;
  library_path: string | null;
  jellyfin_item_id: string | null;
  /** bigint: pg answers a string */
  bytes: string;
  duration_s: number | null;
  gaps: Gap[];
  error: string | null;
  keep: boolean;
  visibility: Visibility;
  shared_by: string | null;
  watched_at: Date | null;
  delete_warned_at: Date | null;
  delete_after: Date | null;
  files_purged: boolean;
  created_at: Date;
}

export interface RecordingView {
  id: string;
  title: string;
  subtitle: string | null;
  episode: string | null;
  channel: { id: string | null; name: string; logo: string | null };
  start: string;
  end: string;
  /** minutes */
  padBefore: number;
  padAfter: number;
  state: RecState;
  error: string | null;
  gaps: number;
  durationS: number | null;
  bytes: number;
  keep: boolean;
  visibility: Visibility;
  mine: boolean;
  seriesKey: string | null;
  ruleId: string | null;
  positionS: number;
  watched: boolean;
  deleteAfter: string | null;
  storage: 'ff' | 'library';
  growing: boolean;
}

/** states a recording of somebody else is shown in (a shared plan or a failure is the owner's business) */
const SHARED_STATES: readonly RecState[] = ['recording', 'done', 'partial'];
const LIST_MAX = 500;

/** the normalised title: case, width and runs of white space do not matter (series keys without an EPG id, `prog_key`) */
export const normTitle = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/** what identifies one airing of a programme across re-imports and time shifts (plan Task 1): normalised title + episode or sub-title */
export const progKey = (p: { title: string; episode?: string | null; subtitle?: string | null }): string =>
  `${normTitle(p.title)}\n${normTitle(p.episode ?? p.subtitle ?? '')}`;
/** a programme's series key (spec §15.1): the EPG's series id, else the normalised title */
export const seriesKeyOf = (p: { title: string; series_key?: string | null }): string => p.series_key || normTitle(p.title);

export interface RecordSettings {
  storage: 'ff' | 'library' | 'both';
  libraryId: string | null;
  libraryJfPath: string;
  limitBytes: number;
  retentionDays: number;
  padBeforeS: number;
  padAfterS: number;
  maxParallel: number;
}
const GB = 1_000_000_000;
/** the recording settings in force (spec §6.4), read per call (they apply live) */
export function recordSettings(ctx: Pick<Ctx, 'cfg'>): RecordSettings {
  const c = ctx.cfg;
  return {
    storage: c.LIVETV_RECORD_STORAGE,
    libraryId: c.LIVETV_RECORD_LIBRARY_ID ?? null,
    libraryJfPath: c.LIVETV_RECORD_LIBRARY_JF_PATH,
    limitBytes: Math.round(c.LIVETV_RECORD_LIMIT_GB * GB),
    retentionDays: c.LIVETV_RECORD_RETENTION_DAYS,
    padBeforeS: c.LIVETV_RECORD_PAD_BEFORE_MIN * 60,
    padAfterS: c.LIVETV_RECORD_PAD_AFTER_MIN * 60,
    maxParallel: c.LIVETV_RECORD_MAX_PARALLEL,
  };
}

/** the library modes need the media server's library seam (Jellyfin); Plex has none, so only the FriendFlix folder is offered there */
export function libraryModeAvailable(ctx: Pick<Ctx, 'jf'>): boolean {
  const a = ctx.jf.admin;
  return typeof a.refreshLibrary === 'function' && typeof a.libraryFolders === 'function';
}
/** the storage mode in force: the setting, or `ff` when the media server offers no library seam */
export function effectiveStorage(ctx: Pick<Ctx, 'cfg' | 'jf'>): RecordSettings['storage'] {
  const s = recordSettings(ctx).storage;
  return s !== 'ff' && !libraryModeAvailable(ctx) ? 'ff' : s;
}

type RightsCtx = Pick<Ctx, 'db' | 'roles'>;
const overlay = (profile: LivetvProfile) => (profile.kids ? { kids: true, kids_max_rating: 0 as const } : null);
/** the account (with the profile's kids overlay) may use Live TV */
export async function mayUseLiveTv(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile): Promise<boolean> {
  return (await effectiveRights(ctx, user, overlay(profile)))?.perms.liveTv === true;
}
/** the account (with the profile's kids overlay: never for kids) may record: `liveRecord` and `liveTv` (plan: today's rights API only) */
export async function mayRecord(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile): Promise<boolean> {
  if (profile.kids) return false;
  const p = (await effectiveRights(ctx, user, overlay(profile)))?.perms;
  return p?.liveTv === true && p.liveRecord === true;
}

/** whether the channel's effective group is released and kid-friendly (a recording without its channel any more: no) */
async function kidFriendly(ctx: RightsCtx, channelId: string | null): Promise<boolean> {
  if (!channelId) return false;
  const r = await ctx.db.query<{ ok: boolean }>(
    `select g.kid_friendly and g.released as ok from (${CHANNEL_SELECT} where c.id = $1) e join livetv_groups g on g.id = e.group_id`, [channelId]);
  return r.rows[0]?.ok === true;
}

/**
 * Who sees a recording (spec §15.6), for a profile whose account may use Live TV: the owner profile its own; `account` every profile of
 * the owner's account; `everyone` every profile whose channel set has the channel. Kids profiles only `account` / `everyone` shares of a
 * kid-friendly group. An admin gets no playback of an unshared recording (Admin → Aufnahmen lists metadata only). Somebody else's
 * recording is seen only while it records or once it is finished.
 */
async function sees(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile, r: Pick<RecRow, 'profile_id' | 'user_id' | 'visibility' | 'channel_id' | 'state'>, set?: () => Promise<ReadonlySet<string>>): Promise<boolean> {
  if (r.state === 'cancelled' || r.state === 'deleting') return false;
  if (r.profile_id === profile.id && !profile.kids) return true;
  if (!SHARED_STATES.includes(r.state) || r.visibility === 'private') return false;
  if (r.visibility === 'account') {
    if (r.user_id !== user.id) return false;
    return profile.kids ? kidFriendly(ctx, r.channel_id) : true;
  }
  // everyone: the profile may see the channel (a kids profile's set holds kid-friendly groups only)
  if (!r.channel_id) return false;
  return (set ? await set() : await channelSet(ctx, user, profile)).has(r.channel_id);
}

export async function getRecording(ctx: Pick<Ctx, 'db'>, id: string): Promise<RecRow | null> {
  if (!UUID_RE.test(id)) return null;
  return (await ctx.db.query<RecRow>('select * from livetv_recordings where id = $1', [id])).rows[0] ?? null;
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** the recording when this profile may see it (see `sees`), else null; the account must have `liveTv` */
export async function visibleRecording(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile, id: string): Promise<RecRow | null> {
  const r = await getRecording(ctx, id);
  if (!r || !(await mayUseLiveTv(ctx, user, profile))) return null;
  return (await sees(ctx, user, profile, r)) ? r : null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const logoPath = (hash: string | null) => (hash ? `/api/livetv/logos/${hash}` : null);

export function toView(r: RecRow, o: { profileId: string; logoHash: string | null; positionS: number }): RecordingView {
  const mine = r.profile_id === o.profileId;
  const watched = mine ? r.watched_at !== null : r.duration_s !== null && r.duration_s > 0 && o.positionS >= 0.9 * r.duration_s;
  return {
    id: r.id, title: r.title, subtitle: r.subtitle, episode: r.episode,
    channel: { id: r.channel_id, name: r.channel_name, logo: logoPath(o.logoHash) },
    start: r.start_at.toISOString(), end: r.end_at.toISOString(),
    padBefore: Math.round(r.pad_before_s / 60), padAfter: Math.round(r.pad_after_s / 60),
    state: r.state === 'starting' ? 'scheduled' : r.state, error: r.error, gaps: Array.isArray(r.gaps) ? r.gaps.length : 0, durationS: r.duration_s, bytes: Number(r.bytes),
    keep: r.keep, visibility: r.visibility, mine, seriesKey: r.series_key, ruleId: r.rule_id, positionS: o.positionS, watched,
    deleteAfter: iso(r.delete_after), storage: r.storage, growing: r.state === 'recording',
  };
}

/** the effective logo hashes of channels, by id */
export async function logoHashes(ctx: Pick<Ctx, 'db'>, ids: Array<string | null>): Promise<Map<string, string | null>> {
  const list = [...new Set(ids.filter((x): x is string => x !== null))];
  if (!list.length) return new Map();
  const rows = (await ctx.db.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = any($1::uuid[])`, [list])).rows.map(toEffective);
  return new Map(rows.map((c) => [c.id, c.logoHash] as const));
}

/** one recording as this profile sees it (with its own progress); null when it may not see it */
export async function recordingView(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile, id: string): Promise<RecordingView | null> {
  const r = await visibleRecording(ctx, user, profile, id);
  if (!r) return null;
  const pos = (await ctx.db.query<{ position_s: number }>('select position_s from livetv_recording_progress where profile_id = $1 and recording_id = $2', [profile.id, r.id])).rows[0];
  return toView(r, { profileId: profile.id, logoHash: (await logoHashes(ctx, [r.channel_id])).get(r.channel_id ?? '') ?? null, positionS: pos?.position_s ?? 0 });
}

const STATE_FILTER: Record<'done' | 'scheduled' | 'all', readonly RecState[]> = {
  done: ['done', 'partial', 'failed'],
  scheduled: ['scheduled', 'starting', 'recording'],
  all: ['scheduled', 'starting', 'recording', 'done', 'partial', 'failed'],
};

/** the recordings this profile sees (its own and those shared with it), newest first (spec §15.7); none without `liveTv` */
export async function listRecordings(ctx: RightsCtx, user: LivetvUser, profile: LivetvProfile, o: { state?: 'done' | 'scheduled' | 'all' } = {}): Promise<RecordingView[]> {
  if (!(await mayUseLiveTv(ctx, user, profile))) return [];
  const states = STATE_FILTER[o.state ?? 'all'];
  const rows = (await ctx.db.query<RecRow & { position_s: number | null }>(
    `select r.*, p.position_s from livetv_recordings r
       left join livetv_recording_progress p on p.recording_id = r.id and p.profile_id = $1
      where r.state = any($4::text[])
        and (r.profile_id = $1 or (r.visibility = 'account' and r.user_id = $2) or r.visibility = 'everyone')
      order by r.start_at desc, r.id limit $3`,
    [profile.id, user.id, LIST_MAX, states])).rows;
  let memo: Promise<ReadonlySet<string>> | null = null;
  const set = () => (memo ??= channelSet(ctx, user, profile));
  const seen: typeof rows = [];
  for (const r of rows) if (await sees(ctx, user, profile, r, set)) seen.push(r);
  const logos = await logoHashes(ctx, seen.map((r) => r.channel_id));
  return seen.map((r) => toView(r, { profileId: profile.id, logoHash: logos.get(r.channel_id ?? '') ?? null, positionS: r.position_s ?? 0 }));
}

/** who changes a recording: the owner profile, or an admin (role admin, grown-up profile) */
export interface Actor { userId: string; profileId: string; admin: boolean }
const mayChange = (r: RecRow, a: Actor) => r.profile_id === a.profileId || a.admin;

/**
 * What else goes when a recording's audience shrinks or it is deleted: its playback tokens (tokens.ts, loaded on use: tokens.ts reads
 * recordings through this module, so it is not imported at load) and, from Phase 3c, its download licences (`onRecordingDeleted`,
 * registered by that module; empty = none).
 */
export interface RecHooks {
  /** revoke the recording's playback tokens; `keepProfile`: tokens of that profile stay (the owner after a visibility change) */
  revokeTokens: (ctx: Ctx, recordingId: string, o?: { keepProfile?: string }) => Promise<void>;
  onRecordingDeleted?: (ctx: Ctx, recordingId: string) => Promise<void>;
}
export const recHooks: RecHooks = {
  revokeTokens: async (ctx, id, o) => { await (await import('./tokens.js')).revokeRecordingTokens(ctx, id, o); },
};

/** *Behalten* (spec §15.5): owner or admin; null = not found or not allowed */
export async function setKeep(ctx: Ctx, a: Actor, id: string, keep: boolean): Promise<RecRow | null> {
  const r = await getRecording(ctx, id);
  if (!r || r.state === 'cancelled' || r.state === 'deleting' || !mayChange(r, a)) return null;
  // kept: a pending automatic deletion is called off
  return (await ctx.db.query<RecRow>(
    `update livetv_recordings set keep = $2, delete_after = case when $2 then null else delete_after end,
       delete_warned_at = case when $2 then null else delete_warned_at end where id = $1 and state <> 'cancelled' returning *`, [id, keep])).rows[0] ?? null;
}

/** sharing (spec §15.6): owner or admin; a narrower audience revokes the playback tokens of profiles that lose it */
export async function setVisibility(ctx: Ctx, a: Actor, id: string, visibility: Visibility): Promise<RecRow | null> {
  const r = await getRecording(ctx, id);
  if (!r || r.state === 'cancelled' || r.state === 'deleting' || !mayChange(r, a)) return null;
  const next = (await ctx.db.query<RecRow>(
    "update livetv_recordings set visibility = $2, shared_by = case when $2 = 'private' then null else $3::uuid end where id = $1 and state <> 'cancelled' returning *",
    [id, visibility, a.userId])).rows[0] ?? null;
  if (next && next.visibility !== r.visibility && r.visibility !== 'private') {
    await recHooks.revokeTokens(ctx, id, r.profile_id ? { keepProfile: r.profile_id } : {}).catch(() => undefined);
  }
  return next;
}

const STOP_TIMEOUT_MS = 10_000;
const DELETE_TIMEOUT_MS = 30_000;
const gone = (e: unknown) => e instanceof LivetvError && e.status === 404;

/**
 * Removes a recording's files through livetv: the recorder first (`stop`), the folder, the library file and then a rescan of its
 * library (§15.5). false = livetv did not confirm (not installed, unreachable): the caller keeps what it has and the space job tries again.
 */
export async function removeFiles(ctx: Ctx, r: { id: string; dir: string; library_path: string | null }, o: { stop?: boolean; nothing?: boolean } = {}): Promise<boolean> {
  if (!livetvInstalled(ctx)) return o.nothing === true;
  try {
    if (o.stop) await livetvCall(ctx, 'DELETE', `/v1/recordings/${r.id}`, undefined, { timeoutMs: STOP_TIMEOUT_MS }).catch((e: unknown) => { if (!gone(e)) throw e; });
    await livetvCall(ctx, 'POST', `/v1/recordings/${r.id}/delete`, { dir: r.dir }, { timeoutMs: DELETE_TIMEOUT_MS }).catch((e: unknown) => { if (!gone(e)) throw e; });
    if (r.library_path) {
      await livetvCall(ctx, 'POST', `/v1/recordings/${r.id}/library-delete`, { path: r.library_path }, { timeoutMs: DELETE_TIMEOUT_MS }).catch((e: unknown) => { if (!gone(e)) throw e; });
      // the library item goes with its file: Jellyfin is asked to scan that library now (A-I9)
      const lib = recordSettings(ctx).libraryId;
      if (lib) await ctx.jf.admin.refreshLibrary?.(lib).catch(() => undefined);
    }
  } catch (e) {
    if (e instanceof LivetvError) return false;
    throw e;
  }
  return true;
}

/** removes the files, then the row (the purge trigger queues nothing: files_purged); false = livetv did not confirm */
export async function purgeRecording(ctx: Ctx, r: Pick<RecRow, 'id' | 'dir' | 'library_path' | 'bytes' | 'mode'>, o: { stop?: boolean } = {}): Promise<boolean> {
  const nothing = Number(r.bytes) === 0 && r.mode === null && r.library_path === null;
  if (!(await removeFiles(ctx, r, { ...o, nothing }))) return false;
  await ctx.db.query('update livetv_recordings set files_purged = true where id = $1', [r.id]);
  await ctx.db.query('delete from livetv_recordings where id = $1', [r.id]);
  return true;
}

export type DeleteResult = 'cancelled' | 'deleted' | 'pending' | 'not_found';

/**
 * The revocations a delete needs before anything is removed (A-I8): the playback tokens and, from Phase 3c, the download licences.
 * false = one failed (a fixed code in the error log): the row stays `deleting` and the space job tries again.
 */
async function revokeAll(ctx: Ctx, id: string): Promise<boolean> {
  try {
    await recHooks.revokeTokens(ctx, id);
    await recHooks.onRecordingDeleted?.(ctx, id);
    return true;
  } catch {
    void recordError(ctx, { source: 'job', code: 'livetv-rec-revoke' }).catch(() => undefined);
    return false;
  }
}

/** finishes a delete: revocations, then the files and the row; 'pending' = something did not hold yet (the space job retries) */
export async function completeDelete(ctx: Ctx, r: RecRow, o: { stop?: boolean } = {}): Promise<'deleted' | 'pending'> {
  if (!(await revokeAll(ctx, r.id))) return 'pending';
  return (await purgeRecording(ctx, r, { stop: o.stop ?? true })) ? 'deleted' : 'pending';
}

/**
 * The one delete path (owner, admin, retention, space). A scheduled recording becomes `cancelled` (the row stays: a rule never plans
 * that airing again). Anything else becomes `deleting` at once (lists drop it, its tokens answer 410, the tick no longer collects or
 * resumes it); then its tokens and licences are revoked, and only when that held is the recorder stopped and are the files removed
 * through livetv. `pending` = a revocation or livetv did not confirm yet: the space job finishes it.
 */
export async function deleteRecording(ctx: Ctx, id: string, by: 'owner' | 'admin' | 'retention' | 'space'): Promise<DeleteResult> {
  void by; // the callers audit; the row keeps no trace of who deleted it
  const r = await getRecording(ctx, id);
  if (!r) return 'not_found';
  if (r.state === 'scheduled') {
    const c = await ctx.db.query("update livetv_recordings set state = 'cancelled' where id = $1 and state = 'scheduled'", [id]);
    if (c.rowCount) return 'cancelled';
    return deleteRecording(ctx, id, by); // it started meanwhile
  }
  if (r.state === 'cancelled' && r.mode === null && Number(r.bytes) === 0 && r.delete_after === null) return 'cancelled';
  const marked = (await ctx.db.query<RecRow>(
    "update livetv_recordings set state = 'deleting', delete_after = coalesce(delete_after, now()) where id = $1 returning *", [id])).rows[0];
  if (!marked) return 'not_found';
  return completeDelete(ctx, marked, { stop: true });
}

/** Admin → Aufnahmen (spec §9.6): metadata only (owner profile, channel, time, mode, state, error), never a title or a playback way */
export interface AdminRecording {
  id: string; profile: string | null; channel: string; start: string; end: string; mode: RecMode | null; state: RecState; error: string | null; bytes: number; keep: boolean;
}
export async function adminListRecordings(ctx: Pick<Ctx, 'db'>, o: { state?: RecState | 'active'; limit?: number; offset?: number } = {}): Promise<{ items: AdminRecording[]; total: number }> {
  const states = o.state === 'active' ? ['scheduled', 'starting', 'recording'] : o.state ? [o.state] : REC_STATES.filter((s) => s !== 'cancelled' && s !== 'deleting');
  const limit = Math.min(Math.max(1, o.limit ?? 50), 200);
  const offset = Math.max(0, o.offset ?? 0);
  const rows = (await ctx.db.query<{ id: string; profile: string | null; channel_name: string; start_at: Date; end_at: Date; mode: RecMode | null; state: RecState; error: string | null; bytes: string; keep: boolean; total: string }>(
    `select r.id, p.name as profile, r.channel_name, r.start_at, r.end_at, r.mode, r.state, r.error, r.bytes, r.keep, count(*) over () as total
       from livetv_recordings r left join profiles p on p.id = r.profile_id
      where r.state = any($1::text[]) order by r.start_at desc, r.id limit $2 offset $3`, [states, limit, offset])).rows;
  return {
    items: rows.map((r) => ({ id: r.id, profile: r.profile, channel: r.channel_name, start: r.start_at.toISOString(), end: r.end_at.toISOString(), mode: r.mode, state: r.state, error: r.error, bytes: Number(r.bytes), keep: r.keep })),
    total: Number(rows[0]?.total ?? 0),
  };
}
