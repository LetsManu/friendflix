// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import type { Language } from '../i18n.js';
import { localizeStored } from '../notify.js';
import { CATEGORIES, categoryOf, type Category } from './categories.js';

/** Groups per feed page and newest entries listed per group. */
export const FEED_PAGE = 30;
export const FEED_ITEMS = 20;

export type SectionKey = 'today' | 'week' | `${number}-${string}`; // YYYY-MM
export type FeedFilter = 'all' | 'unread' | Category;
export interface FeedItem { id: number; title: string; body: string | null; at: string }
export interface FeedGroup { id: string; kind: string; category: Category; title: string; body: string | null; link: string | null; at: string; count: number; unread: boolean; unreadCount: number; items: FeedItem[] }
export interface FeedCounts { unread: number; categories: Array<{ key: Category; n: number }> }
/** `max`: the newest visible row id when the first page was loaded (the snapshot later pages keep; a read or clear by filter sends it back) */
export interface Feed extends FeedCounts { sections: Array<{ key: SectionKey; groups: FeedGroup[] }>; next: string | null; max: number }

/**
 * The shared SQL fragments below expect this FROM: `n` = the notification, `u` = the person (`$1` = their user id),
 * `s` = their notification_state row for `n` (null when there is none).
 */
export function fromSql(): string {
  return 'notifications n join users u on u.id = $1 left join notification_state s on s.user_id = $1 and s.notification_id = n.id';
}

/** The person's own rows and the broadcasts, minus what they cleared (personal: the row's hidden_at, broadcasts: their state row's). */
export function visibleSql(): string {
  return '((n.user_id = $1 and n.hidden_at is null) or (n.user_id is null and s.hidden_at is null))';
}

/** Read rule: a broadcast is read below the person's watermark or with a state read_at; a personal row with its read_at. */
export function readSql(): string {
  return '(case when n.user_id is null then coalesce(n.created_at <= u.notifications_read_at, false) or s.read_at is not null else n.read_at is not null end)';
}

export const isFeedFilter = (f: string): f is FeedFilter => f === 'all' || f === 'unread' || (CATEGORIES as readonly string[]).includes(f);

// Postgres' zone names, read once per pool: Intl also accepts offsets such as "+05", which Postgres reads as POSIX (sign inverted)
const pgZones = new WeakMap<object, Promise<Set<string>>>();
const zonesOf = (ctx: Pick<Ctx, 'db'>) => {
  let z = pgZones.get(ctx.db);
  if (!z) {
    z = ctx.db.query<{ name: string }>('select name from pg_timezone_names').then((r) => new Set(r.rows.map((x) => x.name)));
    z.catch(() => pgZones.delete(ctx.db)); // a failed read is retried next time
    pgZones.set(ctx.db, z);
  }
  return z;
};
const ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const knownZone = (zones: Set<string>, tz: string | null | undefined): tz is string => {
  if (!tz || !ZONE_RE.test(tz) || !zones.has(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** The viewer's IANA zone when both Intl and Postgres know it, else the server's TZ (UTC without a usable one). */
export async function viewerTz(ctx: Pick<Ctx, 'db'>, tz: string | null | undefined): Promise<string> {
  const zones = await zonesOf(ctx);
  if (knownZone(zones, tz)) return tz;
  return knownZone(zones, process.env.TZ) ? process.env.TZ : 'UTC';
}

// ---- cursor: opaque base64url JSON. A snapshot of the first page (its reference time `now` and its newest visible row id `max`),
// so later pages keep its sections and leave out rows that arrived since, plus the position after the page's last group (at, id).
const cursorSchema = z.object({ now: z.iso.datetime(), max: z.number().int().positive(), at: z.iso.datetime(), id: z.number().int().positive() });
export type FeedCursor = z.infer<typeof cursorSchema>;
/** The decoded cursor, or null when it is not one this feed handed out. */
export function decodeCursor(c: string): FeedCursor | null {
  try {
    const r = cursorSchema.safeParse(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
const encodeCursor = (c: FeedCursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

// ---- group ids: `<base64url JSON [groupKey, from ms, to ms, maxId]>.<HMAC>`, bound to the person ----
const groupMacKey = (ctx: Pick<Ctx, 'encKey'>) => createHmac('sha256', ctx.encKey).update('friendflix notes group v1').digest();
// userId is a uuid and from/to/maxId are numbers, so `|` separates the parts unambiguously even though the group key contains `|`
const groupSig = (ctx: Pick<Ctx, 'encKey'>, userId: string, key: string, from: number, to: number, maxId: number) =>
  createHmac('sha256', groupMacKey(ctx)).update([userId, key, from, to, maxId].join('|')).digest().subarray(0, 16);
const groupBody = z.tuple([z.string().min(1), z.number().int(), z.number().int(), z.number().int().positive()]);
export interface GroupRef { groupKey: string; from: Date; to: Date; maxId: number }

/**
 * Opaque id of a group for one person: its group key, its section's time range [from, to) and the newest row id of the group when
 * the page was loaded (maxId). Acting on a group touches only rows with id <= maxId, never entries that arrived later.
 */
export function groupId(ctx: Pick<Ctx, 'encKey'>, userId: string, groupKey: string, from: Date, to: Date, maxId: number): string {
  const body = Buffer.from(JSON.stringify([groupKey, from.getTime(), to.getTime(), maxId])).toString('base64url');
  return `${body}.${groupSig(ctx, userId, groupKey, from.getTime(), to.getTime(), maxId).toString('base64url')}`;
}

/** The group a groupId names, or null for a tampered id or one handed out to another person. */
export function parseGroupId(ctx: Pick<Ctx, 'encKey'>, userId: string, id: string): GroupRef | null {
  const dot = id.lastIndexOf('.');
  if (dot < 0) return null;
  let parsed: z.infer<typeof groupBody>;
  try {
    const r = groupBody.safeParse(JSON.parse(Buffer.from(id.slice(0, dot), 'base64url').toString('utf8')));
    if (!r.success) return null;
    parsed = r.data;
  } catch {
    return null;
  }
  const [groupKey, from, to, maxId] = parsed;
  const sig = Buffer.from(id.slice(dot + 1), 'base64url');
  const want = groupSig(ctx, userId, groupKey, from, to, maxId);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  return { groupKey, from: new Date(from), to: new Date(to), maxId };
}

type KindCount = { kind: string; n: number; unread: number; max_id: string };
const kindCounts = async (ctx: Pick<Ctx, 'db'>, userId: string) => (await ctx.db.query<KindCount>(
  `select n.kind, count(*)::int as n, (count(*) filter (where not ${readSql()}))::int as unread, max(n.id) as max_id
     from ${fromSql()} where ${visibleSql()} group by n.kind`,
  [userId],
)).rows;

function countsOf(rows: KindCount[]): FeedCounts {
  const per = new Map<Category, number>();
  let unread = 0;
  for (const row of rows) {
    const c = categoryOf(row.kind);
    per.set(c, (per.get(c) ?? 0) + row.n);
    unread += row.unread;
  }
  return { unread, categories: CATEGORIES.filter((c) => per.has(c)).map((key) => ({ key, n: per.get(key)! })) };
}

/** Unread entries and entries per category over everything the person sees (never filtered); empty categories are left out. */
export async function feedCounts(ctx: Pick<Ctx, 'db'>, userId: string): Promise<FeedCounts> {
  return countsOf(await kindCounts(ctx, userId));
}

interface GroupRow { sec: SectionKey; gk: string; count: number; unread: boolean; unread_count: number; at: Date; at_us: string; last_id: string; item_ids: string[]; range_from: Date; range_to: Date }
interface ItemRow { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: Date; msg: unknown }

/**
 * One page of the grouped feed. Sections are the viewer's calendar today, the 6 days before, then one per calendar month (in `tz`);
 * within a section, rows with the same group key are one group, which belongs to the section of its newest row. Groups are ordered
 * newest first and a page ends at a group boundary. `now` is the reference time for the sections of a first page (tests pin it);
 * a next page (`cursor`, validated by decodeCursor) uses the first page's time and leaves out rows newer than its newest visible one.
 */
export async function feed(
  ctx: Pick<Ctx, 'db' | 'encKey'>, userId: string, lang: Language,
  o: { tz: string; filter: FeedFilter; cursor: FeedCursor | null; limit: number }, now: Date = new Date(),
): Promise<Feed> {
  const { cursor } = o;
  const limit = Math.min(Math.max(1, Math.floor(o.limit)), FEED_PAGE);
  const tz = await viewerTz(ctx, o.tz);
  const perKind = await kindCounts(ctx, userId);
  const snap = cursor ? { now: new Date(cursor.now), max: cursor.max } : { now, max: Math.max(0, ...perKind.map((x) => Number(x.max_id))) };
  // a category filter is the set of the person's visible kinds that map to it
  const kinds = o.filter === 'all' || o.filter === 'unread' ? null : perKind.map((x) => x.kind).filter((k) => categoryOf(k) === o.filter);
  const g = await ctx.db.query<GroupRow>(
    `with t as (select ($3::timestamptz at time zone $2)::date as today),
     v as (
       select n.id, n.created_at, coalesce(n.group_key, n.kind || '|id:' || n.id) as gk, ${readSql()} as read,
              (n.created_at at time zone $2)::date as d
         from ${fromSql()}
        where ${visibleSql()} and n.id <= $9::bigint and ($4::text[] is null or n.kind = any($4::text[]))
     ),
     sv as (
       select v.*, case when v.d >= t.today then 'today' when v.d >= t.today - 6 then 'week' else to_char(v.d, 'YYYY-MM') end as sec
         from v, t
     ),
     g as (
       select sec, gk, count(*)::int as count, bool_or(not read) as unread, (count(*) filter (where not read))::int as unread_count, max(created_at) as at, max(id) as last_id, min(d) as d,
              (array_agg(id order by created_at desc, id desc))[1:${FEED_ITEMS}] as item_ids
         from sv group by sec, gk
     )
     select g.sec, g.gk, g.count, g.unread, g.unread_count, g.at, g.last_id, g.item_ids,
            to_char(g.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_us,
            (case g.sec when 'today' then t.today when 'week' then t.today - 6 else date_trunc('month', g.d)::date end)::timestamp at time zone $2 as range_from,
            (case g.sec when 'today' then t.today + 1 when 'week' then t.today
               else least((date_trunc('month', g.d) + interval '1 month')::date, t.today - 6) end)::timestamp at time zone $2 as range_to
       from g, t
      where (not $5::boolean or g.unread) and ($6::timestamptz is null or (g.at, g.last_id) < ($6::timestamptz, $7::bigint))
      order by g.at desc, g.last_id desc
      limit $8`,
    [userId, tz, snap.now, kinds, o.filter === 'unread', cursor?.at ?? null, cursor?.id ?? null, limit + 1, snap.max],
  );
  const page = g.rows.slice(0, limit);
  const ids = page.flatMap((x) => x.item_ids);
  const items = new Map<string, ItemRow>();
  if (ids.length) {
    const r = await ctx.db.query<ItemRow>('select id, kind, title, body, link, created_at, msg from notifications where id = any($1::bigint[])', [ids]);
    for (const row of r.rows) items.set(String(row.id), row);
  }
  const sections: Feed['sections'] = [];
  for (const row of page) {
    const rows = row.item_ids.map((id) => items.get(String(id))).filter((x): x is ItemRow => !!x);
    const shown = rows.map((x) => ({ ...localizeStored(x, lang), id: Number(x.id), at: x.created_at.toISOString() }));
    const newest = shown[0];
    if (!newest) continue; // deleted between the two queries (retention)
    const group: FeedGroup = {
      id: groupId(ctx, userId, row.gk, row.range_from, row.range_to, Number(row.last_id)),
      kind: newest.kind, category: categoryOf(newest.kind), title: newest.title, body: newest.body, link: newest.link,
      at: row.at.toISOString(), count: row.count, unread: row.unread, unreadCount: row.unread_count,
      items: shown.map((x) => ({ id: x.id, title: x.title, body: x.body, at: x.at })),
    };
    const last = sections[sections.length - 1];
    if (last?.key === row.sec) last.groups.push(group);
    else sections.push({ key: row.sec, groups: [group] });
  }
  const end = page[page.length - 1];
  const next = g.rows.length > limit && end ? encodeCursor({ now: snap.now.toISOString(), max: snap.max, at: end.at_us, id: Number(end.last_id) }) : null;
  return { sections, next, max: snap.max, ...countsOf(perKind) };
}
