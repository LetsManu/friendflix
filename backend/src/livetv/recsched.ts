// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { conversionLimit, dropReservation, holdback, reserveConversion } from '../convbudget.js';
import type { Ctx } from '../ctx.js';
import { m } from '../i18n.js';
import type { MsgKey } from '../messages.js';
import { notify, notifyAdmins } from '../notify.js';
import { CHANNEL_SELECT, EFFECTIVE_SHIFT_SQL, toEffective, type EffectiveChannel, type EffectiveRow } from './channels.js';
import { LivetvError, livetvCall } from './client.js';
import { livetvInstalled, readLivetvSystem } from './detect.js';
import { setAfterEpgImport } from './epg.js';
import { pushEvent, type LiveEvent } from './events.js';
import { deleteRecording, mayRecord, progKey, purgeRecording, recordSettings, seriesKeyOf, type Gap, type RecRow, type RecState } from './recordings.js';
import { channelAllowed, channelSet, type LivetvProfile, type LivetvUser } from './rights.js';
import { RECORD_LEAD_MS, expectedMode, invalidateRecordingUses, runningChannelIds, startForRecording, type RecordStartError } from './streams.js';
import type { RecorderView, RecordingStartAnswer } from './wire.js';

/**
 * The recording scheduler (spec §15, plan Phase 3 Task 3). The backend owns every decision; livetv only records what it is told.
 *
 * - `expandRules` plans the airings of series rules (the next 8 days of the guide, the channel's effective EPG offset applied; *Nur neue
 *   Folgen* per §15.1) and the weekly occurrences of time rules (in the rule's time zone, DST included), and trims a rule to *Höchstens
 *   … behalten*.
 * - `followEpg` moves a scheduled EPG recording to its programme (same channel, same normalised title and episode / sub-title, the nearest
 *   within ±3 h) after a re-import, an offset change or a DST shift; a started one only grows (programme end later, ≤ +3 h).
 * - `livetvRecordTick` (every 15 s, one runner: KV `ltv:rectick`): reservations, due starts (stream first with admission kind `record`,
 *   then `POST /v1/recordings`; a refused start retries every 60 s until its end), the reconcile with `GET /v1/recordings` (a recorder
 *   livetv lost is resumed into the same folder; finished ones are collected), and the due stops.
 *
 * Logs, events and admin notices carry ids and fixed codes only; a title appears only in the owner's own notification (§16).
 */
export const PLAN_DAYS = 8;
export const FOLLOW_WINDOW_MS = 3 * 3_600_000;
export const RETRY_MS = 60_000;
export const FREE_MIN_BYTES = 2 * 1024 ** 3;
/** a start later than this after the programme's start is a late start: its delay is stored as a gap (the recording ends `partial`) */
export const LATE_START_MS = 60_000;
const TICK_KEY = 'ltv:rectick';
const TICK_TTL_S = 40;
const EXPAND_KEY = 'ltv:recexpand';
const EXPAND_EVERY_S = 1800;
const FOLLOW_KEY = 'ltv:recfollow';
const FOLLOW_EVERY_S = 300;
const retryKey = (id: string) => `ltv:recretry:${id}`;
const whyKey = (id: string) => `ltv:recwhy:${id}`;
const noSlotKey = (id: string) => `ltv:recnoslot:${id}`;
const HOUR_S = 3600;
const LIST_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const event = (ctx: Ctx, e: Omit<LiveEvent, 'at'>) => pushEvent(ctx, e).catch(() => undefined);

// ---- the guide ----

export interface Prog {
  sourceId: string; xml: string; start: number; end: number; title: string; subtitle: string | null; description: string | null; episode: string | null;
  seriesKey: string | null; isNew: boolean | null; prevShown: boolean | null;
}
interface EpgMap { channelId: string; sourceId: string; xml: string; shift: number }

/** the guide mapping and effective offset (minutes) of channels; a channel mapped to a disabled extra guide has none */
async function epgMaps(ctx: Pick<Ctx, 'db'>, ids: readonly string[]): Promise<EpgMap[]> {
  if (!ids.length) return [];
  return (await ctx.db.query<{ id: string; epg_source_id: string; epg_channel_id: string; shift: number }>(
    `select c.id, c.epg_source_id, c.epg_channel_id, ${EFFECTIVE_SHIFT_SQL} as shift
       from livetv_channels c join livetv_sources s on s.id = c.source_id
            join livetv_sources es on es.id = c.epg_source_id and (es.kind <> 'guide' or es.enabled)
      where c.id = any($1::uuid[]) and c.epg_channel_id is not null`, [ids])).rows
    .map((r) => ({ channelId: r.id, sourceId: r.epg_source_id, xml: r.epg_channel_id, shift: r.shift }));
}

/**
 * The programmes of the mapped channels whose effective start lies in [from, to), per channel id (times with the channel's offset).
 * The stored times are read with a margin of the largest possible offset (±14 h) and shifted here.
 */
async function programmes(ctx: Pick<Ctx, 'db'>, maps: readonly EpgMap[], from: number, to: number): Promise<Map<string, Prog[]>> {
  const out = new Map<string, Prog[]>();
  if (!maps.length) return out;
  const pairs = [...new Map(maps.map((x) => [`${x.sourceId}|${x.xml}`, x] as const)).values()];
  type Row = { source_id: string; xml_channel: string; start_at: Date; end_at: Date; title: string; subtitle: string | null; description: string | null; episode: string | null; series_key: string | null; is_new: boolean | null; previously_shown: boolean | null };
  const rows = (await ctx.db.query<Row>(
    `select p.source_id, p.xml_channel, p.start_at, p.end_at, p.title, p.subtitle, p.description, p.episode, p.series_key, p.is_new, p.previously_shown
       from livetv_programmes p join unnest($1::uuid[], $2::text[]) as k(s, x) on p.source_id = k.s and p.xml_channel = k.x
      where p.start_at >= $3::timestamptz - interval '15 hours' and p.start_at < $4::timestamptz + interval '15 hours'
      order by p.start_at`,
    [pairs.map((x) => x.sourceId), pairs.map((x) => x.xml), new Date(from), new Date(to)])).rows;
  const byPair = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.source_id}|${r.xml_channel}`;
    const l = byPair.get(k) ?? [];
    l.push(r);
    byPair.set(k, l);
  }
  for (const mp of maps) {
    const list: Prog[] = [];
    for (const r of byPair.get(`${mp.sourceId}|${mp.xml}`) ?? []) {
      const start = r.start_at.getTime() + mp.shift * 60_000;
      if (start < from || start >= to) continue;
      list.push({
        sourceId: r.source_id, xml: r.xml_channel, start, end: r.end_at.getTime() + mp.shift * 60_000, title: r.title, subtitle: r.subtitle, description: r.description,
        episode: r.episode, seriesKey: r.series_key, isNew: r.is_new, prevShown: r.previously_shown,
      });
    }
    out.set(mp.channelId, list);
  }
  return out;
}

/** a programme of the channel starting exactly at `start` (effective time, offset applied); null when the guide has none */
export async function programmeAt(ctx: Pick<Ctx, 'db'>, channelId: string, start: number): Promise<(Prog & { categories: string[] | null }) | null> {
  const mp = (await epgMaps(ctx, [channelId]))[0];
  if (!mp) return null;
  const p = ((await programmes(ctx, [mp], start, start + 1)).get(channelId) ?? [])[0];
  if (!p) return null;
  const cats = (await ctx.db.query<{ categories: string[] | null }>(
    'select categories from livetv_programmes where source_id = $1 and xml_channel = $2 and start_at = $3 limit 1', [mp.sourceId, mp.xml, new Date(start - mp.shift * 60_000)])).rows[0];
  return { ...p, categories: cats?.categories ?? null };
}

const episodeKey = (p: { episode?: string | null; subtitle?: string | null }): string | null => {
  const k = (p.episode ?? p.subtitle ?? '').trim().toLowerCase();
  return k ? k : null;
};

// ---- planning ----

interface PlanRow {
  profileId: string; userId: string; ruleId: string | null; channelId: string; channelName: string; title: string; subtitle?: string | null; description?: string | null;
  episode?: string | null; seriesKey?: string | null; start: number; end: number; padBeforeS: number; padAfterS: number; followEpg: boolean; progKey?: string | null;
}

/** a scheduled row (`on conflict do nothing`: the profile's slot or the rule's airing exists already); answers its id when it was new */
export async function insertScheduled(ctx: Ctx, p: PlanRow): Promise<string | null> {
  const storage = recordSettings(ctx).storage === 'library' ? 'library' : 'ff';
  const r = await ctx.db.query<{ id: string }>(
    `insert into livetv_recordings(id, profile_id, user_id, rule_id, channel_id, channel_name, title, subtitle, description, episode, series_key, start_at, end_at,
       pad_before_s, pad_after_s, state, follow_epg, prog_key, storage, dir)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'scheduled', $16, $17, $18, $19)
     on conflict do nothing returning id`,
    [randomUUID(), p.profileId, p.userId, p.ruleId, p.channelId, p.channelName.slice(0, 200), p.title.slice(0, 500), p.subtitle ?? null, p.description ?? null,
      p.episode ?? null, p.seriesKey ?? null, new Date(p.start), new Date(p.end), p.padBeforeS, p.padAfterS, p.followEpg, p.progKey ?? null, storage, randomUUID()]);
  if (r.rowCount) invalidateRecordingUses();
  return r.rows[0]?.id ?? null;
}

export interface RuleRow {
  id: string; profile_id: string; user_id: string; kind: 'series' | 'time'; channel_id: string | null; series_key: string | null; title: string;
  weekdays: number[] | null; start_time: string | null; duration_min: number | null; tz: string | null; only_new: boolean; keep_max: number | null;
  pad_before_s: number | null; pad_after_s: number | null; enabled: boolean; created_at: Date;
}
interface Owner { user: LivetvUser; profile: LivetvProfile; disabled: boolean }

async function owners(ctx: Pick<Ctx, 'db'>, profileIds: readonly string[]): Promise<Map<string, Owner>> {
  if (!profileIds.length) return new Map();
  const rows = (await ctx.db.query<{ pid: string; kids: boolean; uid: string; role: string; disabled: boolean }>(
    'select p.id as pid, p.kids, u.id as uid, u.role, u.disabled from profiles p join users u on u.id = p.user_id where p.id = any($1::uuid[])', [[...new Set(profileIds)]])).rows;
  return new Map(rows.map((r) => [r.pid, { user: { id: r.uid, role: r.role }, profile: { id: r.pid, kids: r.kids }, disabled: r.disabled }] as const));
}

async function channelNames(ctx: Pick<Ctx, 'db'>, ids: readonly string[]): Promise<Map<string, EffectiveChannel>> {
  if (!ids.length) return new Map();
  const rows = (await ctx.db.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = any($1::uuid[])`, [[...new Set(ids)]])).rows.map(toEffective);
  return new Map(rows.map((c) => [c.id, c] as const));
}

/** the offset of `tz` at `utcMs` in ms (local − UTC) */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return local - Math.floor(utcMs / 1000) * 1000;
}
/** a wall-clock time in `tz` as epoch ms (a time inside a DST gap moves forward by the gap) */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMs(guess, tz);
  const t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  return off2 === off ? t : guess - off2;
}
/** the local calendar date of `utcMs` in `tz` with its ISO weekday (1 = Monday … 7 = Sunday) */
function localDay(utcMs: number, tz: string): { y: number; m: number; d: number } {
  const l = new Date(utcMs + tzOffsetMs(utcMs, tz));
  return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, d: l.getUTCDate() };
}
export const isoWeekday = (y: number, m: number, d: number): number => ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
export function validTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** the weekly occurrences of a time rule that start after `now` within the next PLAN_DAYS days: [start, end] epoch ms */
export function timeOccurrences(r: Pick<RuleRow, 'weekdays' | 'start_time' | 'duration_min' | 'tz'>, now: number): Array<[number, number]> {
  if (!r.weekdays?.length || !r.start_time || !r.duration_min || !r.tz || !validTz(r.tz)) return [];
  const [hh, mm] = r.start_time.split(':').map(Number) as [number, number];
  const out: Array<[number, number]> = [];
  const today = localDay(now, r.tz);
  for (let i = 0; i <= PLAN_DAYS; i++) {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const [y, m, d] = [base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()];
    if (!r.weekdays.includes(isoWeekday(y, m, d))) continue;
    const start = zonedToUtc(y, m, d, hh, mm, r.tz);
    if (start <= now || start > now + PLAN_DAYS * 86_400_000) continue;
    out.push([start, start + r.duration_min * 60_000]);
  }
  return out;
}

/**
 * Plans the airings of every enabled rule (series: the guide's next 8 days; time: the weekly occurrences) and trims each rule to its
 * `keep_max`. A rule whose owner may not record any more plans nothing.
 */
export async function expandRules(ctx: Ctx, now: number = Date.now(), o: { ruleId?: string } = {}): Promise<number> {
  const rules = (await ctx.db.query<RuleRow>(`select * from livetv_recording_rules where enabled ${o.ruleId ? 'and id = $1' : ''} order by created_at`, o.ruleId ? [o.ruleId] : [])).rows;
  if (!rules.length) return 0;
  const who = await owners(ctx, rules.map((r) => r.profile_id));
  const s = recordSettings(ctx);
  const allowed = new Map<string, boolean>();
  for (const [pid, w] of who) allowed.set(pid, !w.disabled && (await mayRecord(ctx, w.user, w.profile)));
  // the channels per series rule (its own, or every channel of the owner profile's set), then their guide in one read
  const chans = new Map<string, string[]>();
  for (const r of rules) {
    if (r.kind !== 'series' || !allowed.get(r.profile_id)) continue;
    const w = who.get(r.profile_id)!;
    const set = await channelSet(ctx, w.user, w.profile);
    chans.set(r.id, r.channel_id ? (set.has(r.channel_id) ? [r.channel_id] : []) : [...set]);
  }
  const allIds = [...new Set([...chans.values()].flat())];
  const maps = await epgMaps(ctx, allIds);
  const progs = await programmes(ctx, maps, now, now + PLAN_DAYS * 86_400_000);
  const sourcesWithNew = new Set(maps.length
    ? (await ctx.db.query<{ source_id: string }>('select distinct source_id from livetv_programmes where is_new and source_id = any($1::uuid[])', [[...new Set(maps.map((x) => x.sourceId))]])).rows.map((r) => r.source_id)
    : []);
  const names = await channelNames(ctx, [...allIds, ...rules.flatMap((r) => (r.channel_id ? [r.channel_id] : []))]);
  let planned = 0;
  for (const r of rules) {
    if (!allowed.get(r.profile_id)) continue;
    const pad = { padBeforeS: r.pad_before_s ?? s.padBeforeS, padAfterS: r.pad_after_s ?? s.padAfterS };
    const base = { profileId: r.profile_id, userId: r.user_id, ruleId: r.id };
    if (r.kind === 'time') {
      const ch = r.channel_id ? names.get(r.channel_id) : undefined;
      const w = who.get(r.profile_id)!;
      if (!ch || !(await channelAllowed(ctx, w.user, w.profile, ch.id))) continue;
      for (const [start, end] of timeOccurrences(r, now)) {
        if (await insertScheduled(ctx, { ...base, ...pad, channelId: ch.id, channelName: ch.name, title: r.title, start, end, followEpg: false })) planned++;
      }
    } else {
      const mine = (await ctx.db.query<{ episode: string | null; subtitle: string | null; state: RecState; channel_id: string | null; prog_key: string | null; start_at: Date }>(
        "select episode, subtitle, state, channel_id, prog_key, start_at from livetv_recordings where rule_id = $1 and state in ('scheduled','recording','done','partial')", [r.id])).rows;
      const done = new Set(mine.flatMap((x) => { const k = episodeKey(x); return k ? [k] : []; }));
      // an airing this rule planned already (it may have moved and not followed yet): never a second row for it
      const already = (cid: string, p: Prog) => mine.some((x) => (x.state === 'scheduled' || x.state === 'recording') && x.channel_id === cid && x.prog_key === progKey(p)
        && Math.abs(x.start_at.getTime() - p.start) <= FOLLOW_WINDOW_MS);
      const candidates = (chans.get(r.id) ?? []).flatMap((cid) => (progs.get(cid) ?? []).map((p) => ({ cid, p })))
        .filter(({ p }) => seriesKeyOf({ title: p.title, series_key: p.seriesKey }) === r.series_key)
        .sort((a, b) => a.p.start - b.p.start);
      for (const { cid, p } of candidates) {
        const k = episodeKey(p);
        if (already(cid, p)) continue;
        if (r.only_new) {
          if (p.prevShown === true) continue;
          if (sourcesWithNew.has(p.sourceId) && p.isNew !== true) continue;
          if (k && done.has(k)) continue;
        }
        const id = await insertScheduled(ctx, {
          ...base, ...pad, channelId: cid, channelName: names.get(cid)?.name ?? '', title: p.title, subtitle: p.subtitle, description: p.description, episode: p.episode,
          seriesKey: r.series_key, start: p.start, end: p.end, followEpg: true, progKey: progKey(p),
        });
        if (id) planned++;
        if (k) done.add(k);
      }
    }
    if (r.keep_max) {
      const over = (await ctx.db.query<{ id: string }>(
        "select id from livetv_recordings where rule_id = $1 and state in ('done','partial') and not keep order by start_at desc, id offset $2", [r.id, r.keep_max])).rows;
      for (const x of over) await deleteRecording(ctx, x.id, 'retention');
    }
  }
  return planned;
}

/**
 * A scheduled EPG recording follows its programme (the same channel, the same `prog_key`, the nearest start within ±3 h): a re-import, an
 * offset change of the channel or source, DST. Without a match it keeps its time. Answers how many moved.
 */
export async function followEpg(ctx: Ctx, now: number = Date.now()): Promise<number> {
  const rows = (await ctx.db.query<Pick<RecRow, 'id' | 'channel_id' | 'start_at' | 'end_at' | 'prog_key' | 'pad_before_s'>>(
    `select id, channel_id, start_at, end_at, prog_key, pad_before_s from livetv_recordings
      where state = 'scheduled' and follow_epg and prog_key is not null and channel_id is not null and start_at - make_interval(secs => pad_before_s) > $1
      order by start_at`, [new Date(now)])).rows;
  if (!rows.length) return 0;
  const maps = new Map((await epgMaps(ctx, [...new Set(rows.map((r) => r.channel_id!))])).map((x) => [x.channelId, x] as const));
  let moved = 0;
  for (const r of rows) {
    const mp = maps.get(r.channel_id!);
    if (!mp) continue;
    const at = r.start_at.getTime();
    const list = (await programmes(ctx, [mp], at - FOLLOW_WINDOW_MS, at + FOLLOW_WINDOW_MS + 1)).get(mp.channelId) ?? [];
    const best = list.filter((p) => progKey(p) === r.prog_key).sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0];
    if (!best || (best.start === at && best.end === r.end_at.getTime())) continue;
    const u = await ctx.db.query("update livetv_recordings set start_at = $2, end_at = $3 where id = $1 and state = 'scheduled'", [r.id, new Date(best.start), new Date(best.end)])
      .catch(() => ({ rowCount: 0 })); // the profile has another recording of this channel at the new time: it stays
    if (u.rowCount) {
      moved++;
      await event(ctx, { level: 'info', code: 'rec_moved', channelId: r.channel_id!, recordingId: r.id });
    }
  }
  if (moved) invalidateRecordingUses();
  return moved;
}

/** after a guide import (epg.ts hook): scheduled recordings follow their programmes first, then the rules plan what is new */
export async function afterEpgImport(ctx: Ctx, _sourceId: string): Promise<void> {
  await followEpg(ctx);
  await expandRules(ctx);
}
setAfterEpgImport(afterEpgImport);

/** a running EPG recording grows when its programme's end moved later (≤ +3 h); it never shrinks. Answers the new end or null. */
async function grow(ctx: Ctx, r: RecRow): Promise<number | null> {
  if (!r.follow_epg || !r.prog_key || !r.channel_id) return null;
  const mp = (await epgMaps(ctx, [r.channel_id]))[0];
  if (!mp) return null;
  const at = r.start_at.getTime();
  const list = (await programmes(ctx, [mp], at - FOLLOW_WINDOW_MS, at + FOLLOW_WINDOW_MS + 1)).get(mp.channelId) ?? [];
  const best = list.filter((p) => progKey(p) === r.prog_key).sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0];
  const end = r.end_at.getTime();
  if (!best || best.end <= end || best.end > end + FOLLOW_WINDOW_MS) return null;
  const u = await ctx.db.query("update livetv_recordings set end_at = $2 where id = $1 and state = 'recording' and end_at < $2", [r.id, new Date(best.end)]);
  return u.rowCount ? best.end : null;
}

// ---- the tick ----

const padStart = (r: Pick<RecRow, 'start_at' | 'pad_before_s'>) => r.start_at.getTime() - r.pad_before_s * 1000;
const padEnd = (r: Pick<RecRow, 'end_at' | 'pad_after_s'>) => r.end_at.getTime() + r.pad_after_s * 1000;
const gapKey = (g: Gap) => `${g.from}|${g.to}`;
const mergeGaps = (a: readonly Gap[], b: readonly Gap[]): Gap[] => {
  const out = new Map<string, Gap>();
  for (const g of [...a, ...b]) if (Number.isFinite(g.from) && Number.isFinite(g.to)) out.set(gapKey(g), { from: g.from, to: g.to });
  return [...out.values()].sort((x, y) => x.from - y.from);
};

const reasonKey = (code: string): MsgKey => {
  const known = ['storage_full', 'no_slot', 'livetv_off', 'stream_gone', 'write_failed', 'missed'];
  return `livetv.rec.reason.${known.includes(code) ? code : 'stream_gone'}` as MsgKey;
};

/** the owner's notice of a recording that failed or stayed incomplete (§16; once per recording) */
async function noticeFailed(ctx: Ctx, r: RecRow, state: RecState, error: string | null, gaps: number): Promise<void> {
  const title = error || state === 'failed'
    ? m('livetv.rec.failed.title', { title: r.title, reason: m(reasonKey(error ?? 'stream_gone')) })
    : m('livetv.rec.partial.title', { title: r.title, n: gaps });
  await notify(ctx, { userId: r.user_id, kind: 'livetv.rec.failed', title, link: '/live/recordings', dedupe: `ltvrec-failed-${r.id}`, personal: true }).catch(() => undefined);
}
/** owner and admins once per recording when the recordings storage is full */
async function noticeStorageFull(ctx: Ctx, r: RecRow): Promise<void> {
  await notifyAdmins(ctx, { kind: 'livetv.rec.storage', title: m('livetv.rec.storageFull.title'), link: '/admin/livetv', dedupe: `ltvrec-full-${r.id}` }).catch(() => 0);
  await event(ctx, { level: 'error', code: 'rec_storage_full', ...(r.channel_id ? { channelId: r.channel_id } : {}), recordingId: r.id });
}

/** ends a recording that never ran (or whose recorder is lost) */
async function failRow(ctx: Ctx, r: RecRow, error: string, o: { from?: RecState[] } = {}): Promise<void> {
  const state: RecState = Number(r.bytes) > 0 ? 'partial' : 'failed';
  const u = await ctx.db.query<RecRow>(
    'update livetv_recordings set state = $2, error = $3 where id = $1 and state = any($4::text[]) returning *', [r.id, state, error, o.from ?? ['scheduled']]);
  const row = u.rows[0];
  if (!row) return;
  invalidateRecordingUses();
  await event(ctx, { level: 'error', code: state === 'partial' ? 'rec_partial' : 'rec_failed', ...(r.channel_id ? { channelId: r.channel_id } : {}), recordingId: r.id, reason: error });
  await noticeFailed(ctx, row, state, error, row.gaps.length);
  if (error === 'storage_full') await noticeStorageFull(ctx, row);
  await ctx.kv.del(whyKey(r.id)).catch(() => undefined);
}

async function cancelRow(ctx: Ctx, r: RecRow, error: string): Promise<void> {
  const u = await ctx.db.query("update livetv_recordings set state = 'cancelled', error = $2 where id = $1 and state = 'scheduled'", [r.id, error]);
  if (u.rowCount) invalidateRecordingUses();
}

/** the recordings' bytes (FriendFlix folder and library) and whether an unprotected finished one could make room */
async function storageState(ctx: Ctx): Promise<{ used: number; deletable: boolean }> {
  const r = (await ctx.db.query<{ used: string | null; deletable: boolean }>(
    "select sum(bytes) as used, bool_or(not keep and state in ('done','partial')) as deletable from livetv_recordings where state <> 'scheduled'")).rows[0];
  return { used: Number(r?.used ?? 0), deletable: r?.deletable === true };
}

/** `GET /v1/recordings`, read defensively; null = livetv did not answer */
async function recorderList(ctx: Ctx): Promise<RecorderView[] | null> {
  let raw: unknown;
  try { raw = await livetvCall<unknown>(ctx, 'GET', '/v1/recordings', undefined, { timeoutMs: LIST_TIMEOUT_MS }); } catch (e) {
    if (e instanceof LivetvError && e.status === 404) return [];
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return raw.slice(0, 2000).flatMap((x: unknown) => {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    if (!o || typeof o.id !== 'string' || !UUID_RE.test(o.id) || !['recording', 'done', 'failed'].includes(o.state as string)) return [];
    const gaps = Array.isArray(o.gaps) ? o.gaps.flatMap((g: unknown) => {
      const r = g && typeof g === 'object' ? (g as Record<string, unknown>) : null;
      return r && typeof r.from === 'number' && typeof r.to === 'number' ? [{ from: r.from, to: r.to }] : [];
    }).slice(0, 1000) : [];
    const error = ['storage_full', 'write_failed', 'stream_gone'].includes(o.error as string) ? (o.error as RecorderView['error']) : null;
    return [{
      id: o.id, channelId: String(o.channelId ?? ''), state: o.state as RecorderView['state'], segments: o.segments === 'fmp4' || o.segments === 'ts' ? o.segments : null,
      bytes: Math.max(0, Math.round(num(o.bytes))), durationS: Math.max(0, Math.round(num(o.durationS))), gaps, error, since: num(o.since),
    }];
  });
}

/** what a finished recording does next (Task 6 registers the library export and the space check) */
export interface FinishHooks { finished?: (ctx: Ctx, row: RecRow) => Promise<void> }
export const finishHooks: FinishHooks = {};

/** a finished recorder entry becomes the row's final state; notices and events once */
async function collect(ctx: Ctx, r: RecRow, e: RecorderView): Promise<void> {
  const gaps = mergeGaps(r.gaps, e.gaps);
  const state: RecState = e.state === 'done' ? (gaps.length ? 'partial' : 'done') : (e.bytes > 0 ? 'partial' : 'failed');
  const error = e.state === 'failed' ? (e.error ?? 'stream_gone') : null;
  const row = (await ctx.db.query<RecRow>(
    `update livetv_recordings set state = $2, error = $3, bytes = $4, duration_s = $5, gaps = $6::jsonb, segments = coalesce($7, segments)
      where id = $1 and state = 'recording' returning *`,
    [r.id, state, error, e.bytes, e.durationS, JSON.stringify(gaps), e.segments])).rows[0];
  if (!row) return;
  invalidateRecordingUses();
  const ch = r.channel_id ? { channelId: r.channel_id } : {};
  await event(ctx, { level: state === 'done' ? 'info' : state === 'partial' ? 'warn' : 'error', code: state === 'done' ? 'rec_done' : state === 'partial' ? 'rec_partial' : 'rec_failed', ...ch, recordingId: r.id, ...(error ? { reason: error } : {}), ...(gaps.length ? { n: gaps.length } : {}) });
  if (state !== 'done') await noticeFailed(ctx, row, state, error, gaps.length);
  if (error === 'storage_full') await noticeStorageFull(ctx, row);
  if (state !== 'failed' && row.rule_id) {
    const rule = (await ctx.db.query<{ kind: string; title: string }>('select kind, title from livetv_recording_rules where id = $1', [row.rule_id])).rows[0];
    if (rule?.kind === 'series') {
      await notify(ctx, {
        userId: row.user_id, kind: 'livetv.rec.episode', title: m('livetv.rec.episode.title', { series: rule.title, episode: row.subtitle || row.episode || row.title }),
        link: '/live/recordings', dedupe: `ltvrec-episode-${row.id}`, personal: true,
      }).catch(() => undefined);
    }
  }
  await finishHooks.finished?.(ctx, row).catch(() => undefined);
}

/** posts the recorder for a row whose stream runs; 'retry' = try again on a later tick */
async function postRecorder(ctx: Ctx, r: RecRow): Promise<RecordingStartAnswer | 'retry' | { fail: string }> {
  try {
    return await livetvCall<RecordingStartAnswer>(ctx, 'POST', '/v1/recordings', { id: r.id, channelId: r.channel_id, dir: r.dir, endAt: padEnd(r) }, { timeoutMs: CALL_TIMEOUT_MS });
  } catch (e) {
    if (!(e instanceof LivetvError)) throw e;
    if (e.status === 507) return { fail: 'storage_full' };
    if (e.status === 409 && e.code === 'invalid_dir') return { fail: 'write_failed' };
    return 'retry';
  }
}

const refusalWhy = (e: RecordStartError) => (e === 'no_slot' || e === 'provider_limit' ? 'no_slot' : 'stream_gone');

/** starts (or resumes) a row's stream and recorder; answers whether it records now */
async function launch(ctx: Ctx, r: RecRow, owner: Owner, now: number, resume: boolean): Promise<boolean> {
  if (await ctx.kv.get(retryKey(r.id)).catch(() => null)) return false;
  const ch = (await channelNames(ctx, [r.channel_id!])).get(r.channel_id!);
  if (!ch) { await failRow(ctx, r, 'stream_gone', { from: [r.state] }); return false; }
  const res = await startForRecording(ctx, ch, { userId: owner.user.id });
  if ('error' in res) {
    await ctx.kv.set(retryKey(r.id), '1', RETRY_MS / 1000).catch(() => undefined);
    await ctx.kv.set(whyKey(r.id), refusalWhy(res.error), Math.max(60, Math.ceil((padEnd(r) - now) / 1000) + HOUR_S)).catch(() => undefined);
    if ((res.error === 'no_slot' || res.error === 'provider_limit') && (await ctx.kv.setnx(noSlotKey(r.id), '1', Math.max(60, Math.ceil((padEnd(r) - now) / 1000) + HOUR_S)).catch(() => false))) {
      await event(ctx, { level: 'warn', code: 'rec_no_slot', channelId: ch.id, recordingId: r.id, reason: res.error });
    }
    return false;
  }
  const posted = await postRecorder(ctx, r);
  if (posted === 'retry') return false;
  if ('fail' in posted) { await failRow(ctx, r, posted.fail, { from: [r.state] }); return false; }
  if (resume) return true;
  // a late start (a refused slot, the backend was down) that misses part of the programme is a gap from its start to now
  const late = now - r.start_at.getTime() > LATE_START_MS ? [{ from: r.start_at.getTime(), to: now }] : [];
  const u = await ctx.db.query(
    "update livetv_recordings set state = 'recording', mode = $2, segments = $3, gaps = $4::jsonb where id = $1 and state = 'scheduled'",
    [r.id, res.mode, posted.segments ?? res.segments, JSON.stringify(mergeGaps(r.gaps, late))]);
  invalidateRecordingUses();
  if (!u.rowCount) {
    // deleted or cancelled meanwhile: never an orphan recorder
    await purgeRecording(ctx, { ...r, mode: res.mode, bytes: '1' }, { stop: true }).catch(() => false);
    return false;
  }
  await event(ctx, { level: 'info', code: 'rec_started', channelId: ch.id, recordingId: r.id });
  return true;
}

/**
 * Every 15 s, one runner (KV `ltv:rectick`), in order: (1) reservations for transcoding recordings starting within padding + 5 min,
 * (2) due starts, (3) the reconcile with livetv's recorders, (4) due stops. Runs also while livetv is not installed: due recordings then
 * fail `livetv_off` (the owner is told once per recording).
 */
export async function livetvRecordTick(ctx: Ctx, now: number = Date.now()): Promise<void> {
  const token = randomUUID();
  if (!(await ctx.kv.setnx(TICK_KEY, token, TICK_TTL_S))) return;
  const renew = () => ctx.kv.refreshIfEquals(TICK_KEY, token, TICK_TTL_S).catch(() => false);
  try {
    const installed = livetvInstalled(ctx);
    if (installed) {
      if (await ctx.kv.setnx(EXPAND_KEY, '1', EXPAND_EVERY_S).catch(() => false)) await expandRules(ctx, now);
      if (await ctx.kv.setnx(FOLLOW_KEY, '1', FOLLOW_EVERY_S).catch(() => false)) await followEpg(ctx, now);
    }
    const active = (await ctx.db.query<RecRow>(
      `select * from livetv_recordings where state = 'recording'
          or (state = 'scheduled' and start_at - make_interval(secs => pad_before_s) <= $1::timestamptz + make_interval(secs => $2::int))
        order by start_at, id`, [new Date(now), RECORD_LEAD_MS / 1000])).rows;
    const who = await owners(ctx, active.flatMap((r) => (r.profile_id ? [r.profile_id] : [])));

    // (1) reservations: a recording that will transcode holds its channel's slot from start − padding − 5 min to its end
    if (installed) {
      const chans = await channelNames(ctx, active.flatMap((r) => (r.channel_id ? [r.channel_id] : [])));
      for (const r of active) {
        const ch = r.channel_id ? chans.get(r.channel_id) : undefined;
        if (!ch || now >= padEnd(r)) continue;
        if ((r.state === 'recording' ? r.mode : expectedMode(ch, now)) === 'transcode') await reserveConversion(ctx, ch.id, { label: ch.name, userId: r.user_id }).catch(() => undefined);
      }
    }

    // (2) due starts
    for (const r of active) {
      if (r.state !== 'scheduled' || padStart(r) > now) continue;
      if (!(await renew())) return;
      const w = r.profile_id ? who.get(r.profile_id) : undefined;
      if (!w || w.disabled || !(await mayRecord(ctx, w.user, w.profile))) { await cancelRow(ctx, r, 'forbidden'); continue; }
      if (!r.channel_id || !(await channelAllowed(ctx, w.user, w.profile, r.channel_id))) { await cancelRow(ctx, r, 'forbidden'); continue; }
      if (!installed) { await failRow(ctx, r, 'livetv_off'); continue; }
      if (now >= padEnd(r)) { await failRow(ctx, r, (await ctx.kv.get(whyKey(r.id)).catch(() => null)) ?? 'missed'); continue; }
      const free = (await readLivetvSystem(ctx).catch(() => null))?.recordings?.freeBytes;
      const st = await storageState(ctx);
      if ((typeof free === 'number' && free < FREE_MIN_BYTES) || (st.used >= recordSettings(ctx).limitBytes && !st.deletable)) { await failRow(ctx, r, 'storage_full'); continue; }
      await launch(ctx, r, w, now, false);
    }
    if (!installed) {
      // livetv went away under a running recording: after its end it is ended with what it had
      for (const r of active) if (r.state === 'recording' && now >= padEnd(r) + 10 * 60_000) await failRow(ctx, r, 'livetv_off', { from: ['recording'] });
      return;
    }

    // (3) reconcile with livetv's recorders
    if (!(await renew())) return;
    const list = await recorderList(ctx);
    if (list) {
      const byId = new Map(list.map((e) => [e.id, e] as const));
      const recording = (await ctx.db.query<RecRow>("select * from livetv_recordings where state = 'recording' order by start_at, id")).rows;
      const running = await runningChannelIds(ctx);
      for (const r of recording) {
        if (!(await renew())) return;
        const e = byId.get(r.id);
        const w = r.profile_id ? who.get(r.profile_id) ?? (await owners(ctx, [r.profile_id])).get(r.profile_id) : undefined;
        if (e && e.state !== 'recording') { await collect(ctx, r, e); continue; }
        if (now >= padEnd(r)) {
          if (!e) await failRow(ctx, r, 'stream_gone', { from: ['recording'] }); // its recorder is gone (livetv restarted after the end)
          continue; // a recorder still running past its end is stopped below
        }
        if (e) {
          // progress, and gaps seen so far (kept across a livetv restart, which starts the recorder's own list anew)
          await ctx.db.query("update livetv_recordings set bytes = $2, duration_s = $3, gaps = $4::jsonb where id = $1 and state = 'recording'",
            [r.id, e.bytes, e.durationS, JSON.stringify(mergeGaps(r.gaps, e.gaps))]);
          const end = await grow(ctx, r);
          if (end !== null) await livetvCall(ctx, 'PATCH', `/v1/recordings/${r.id}`, { endAt: end + r.pad_after_s * 1000 }, { timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined);
        }
        // livetv lost the recorder (a restart: new bootId), or its stream stopped: start the stream again and resume into the same folder
        if (w && r.channel_id && (!e || (running !== null && !running.has(r.channel_id)))) await launch(ctx, r, w, now, true);
      }
    }

    // (4) due stops: the recorder ends itself at its end; this is the net for a recorder that did not
    if (!(await renew())) return;
    for (const r of (await ctx.db.query<RecRow>("select * from livetv_recordings where state = 'recording' and end_at + make_interval(secs => pad_after_s) <= $1", [new Date(now)])).rows) {
      await livetvCall(ctx, 'DELETE', `/v1/recordings/${r.id}`, undefined, { timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined);
    }
  } finally {
    await ctx.kv.delIfEquals(TICK_KEY, token).catch(() => false);
  }
}

/** drops the reservation of a channel no recording needs any more (a delete, a cancel) */
export async function releaseReservation(ctx: Ctx, channelId: string): Promise<void> {
  invalidateRecordingUses();
  const still = (await ctx.db.query<{ n: number }>(
    `select count(*)::int as n from livetv_recordings where channel_id = $1 and (state = 'recording' or (state = 'scheduled'
       and start_at - make_interval(secs => pad_before_s) <= now() + make_interval(secs => $2::int)))`, [channelId, RECORD_LEAD_MS / 1000])).rows[0]?.n ?? 0;
  if (!still) await dropReservation(ctx, channelId);
}

// ---- the conflict forecast (spec §15.4) ----

export interface Forecast {
  slots: { used: number; limit: number };
  parallel: { used: number; max: number };
  provider: { used: number; max: number } | null;
  conflict: boolean;
}

/**
 * What a new recording of `channelId` over [from, to) (padding included) would meet at its busiest moment: the distinct channels whose
 * recordings transcode against the conversion limit minus the priority holdback (`slots`), the distinct recorded channels against
 * LIVETV_RECORD_MAX_PARALLEL (`parallel`) and the channels of the same provider against its connection limit (`provider`). Two
 * recordings of one channel count once; a recording that needs no conversion never conflicts on slots. `exceptId`: a recording left
 * out (the one being edited).
 */
export async function forecast(ctx: Ctx, o: { channelId: string; from: number; to: number; exceptId?: string }): Promise<Forecast> {
  const rows = (await ctx.db.query<{ id: string; channel_id: string; mode: string | null; state: RecState; s: Date; e: Date }>(
    `select id, channel_id, mode, state, start_at - make_interval(secs => pad_before_s) as s, end_at + make_interval(secs => pad_after_s) as e
       from livetv_recordings
      where state in ('scheduled','recording') and channel_id is not null and id <> coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        and start_at - make_interval(secs => pad_before_s) < $2 and end_at + make_interval(secs => pad_after_s) > $1`,
    [new Date(o.from), new Date(o.to), o.exceptId ?? null])).rows;
  const chans = await channelNames(ctx, [o.channelId, ...rows.map((r) => r.channel_id)]);
  const srcRows = (await ctx.db.query<{ id: string; source_id: string; max_streams: number | null }>(
    'select c.id, c.source_id, s.max_streams from livetv_channels c join livetv_sources s on s.id = c.source_id where c.id = any($1::uuid[])', [[...chans.keys()]])).rows;
  const sourceOf = new Map(srcRows.map((r) => [r.id, r] as const));
  const now = Date.now();
  const transcodes = (cid: string, mode: string | null, state: RecState) => {
    if (state === 'recording' && mode) return mode === 'transcode';
    const ch = chans.get(cid);
    return ch ? expectedMode(ch, now) === 'transcode' : false;
  };
  const mine = { channel: o.channelId, transcode: transcodes(o.channelId, null, 'scheduled') };
  const lim = await conversionLimit(ctx, { settingsMs: 800, checkLivetv: false });
  const slotsMax = Math.max(0, lim.limit - holdback(lim.limit, lim.priority));
  const parallelMax = recordSettings(ctx).maxParallel;
  const src = sourceOf.get(o.channelId);
  // the busiest moment: the new recording's start and every other recording's start inside it
  const points = [o.from, ...rows.map((r) => r.s.getTime()).filter((t) => t > o.from && t < o.to)];
  let worst = { slots: 0, parallel: 0, provider: 0 };
  let conflict = false;
  for (const t of points) {
    const at = rows.filter((r) => r.s.getTime() <= t && r.e.getTime() > t);
    const channels = new Set([...at.map((r) => r.channel_id), mine.channel]);
    const tr = new Set(at.filter((r) => transcodes(r.channel_id, r.mode, r.state)).map((r) => r.channel_id));
    const shares = tr.has(mine.channel) || at.some((r) => r.channel_id === mine.channel);
    if (mine.transcode) tr.add(mine.channel);
    const provider = src ? [...channels].filter((c) => sourceOf.get(c)?.source_id === src.source_id).length : 0;
    worst = { slots: Math.max(worst.slots, tr.size), parallel: Math.max(worst.parallel, channels.size), provider: Math.max(worst.provider, provider) };
    if (!shares && ((mine.transcode && tr.size > slotsMax) || channels.size > parallelMax || (src?.max_streams != null && provider > src.max_streams))) conflict = true;
  }
  return {
    slots: { used: worst.slots, limit: slotsMax },
    parallel: { used: worst.parallel, max: parallelMax },
    provider: src?.max_streams != null ? { used: worst.provider, max: src.max_streams } : null,
    conflict,
  };
}
