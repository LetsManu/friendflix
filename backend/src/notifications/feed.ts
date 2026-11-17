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
export interface FeedGroup { id: string; kind: string; category: Category; title: string; body: string | null; link: string | null; at: string; count: number; unread: boolean; items: FeedItem[] }
export interface FeedCounts { unread: number; categories: Array<{ key: Category; n: number }> }
export interface Feed extends FeedCounts { sections: Array<{ key: SectionKey; groups: FeedGroup[] }>; next: string | null }

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

let zones: Set<string> | undefined;
/** The viewer's IANA zone when known, else the server's TZ (UTC without one). */
export function viewerTz(tz: string | null | undefined): string {
  zones ??= new Set(Intl.supportedValuesOf('timeZone'));
  return tz && zones.has(tz) ? tz : process.env.TZ || 'UTC';
}

// ---- cursor: opaque base64url JSON of the last group on the page ----
const cursorSchema = z.object({ s: z.string().regex(/^(today|week|\d{4}-\d{2})$/), at: z.iso.datetime(), id: z.number().int().positive() });
type Cursor = z.infer<typeof cursorSchema>;
/** The decoded cursor, or null when it is not one this feed handed out. */
export function decodeCursor(c: string): Cursor | null {
  try {
    const r = cursorSchema.safeParse(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

// ---- group ids: `<base64url JSON [groupKey, from ms, to ms]>.<HMAC>`, bound to the person ----
const groupMacKey = (ctx: Pick<Ctx, 'encKey'>) => createHmac('sha256', ctx.encKey).update('friendflix notes group v1').digest();
// userId is a uuid and from/to are numbers, so `|` separates the parts unambiguously even though the group key contains `|`
const groupSig = (ctx: Pick<Ctx, 'encKey'>, userId: string, key: string, from: number, to: number) =>
  createHmac('sha256', groupMacKey(ctx)).update([userId, key, from, to].join('|')).digest().subarray(0, 16);
const groupBody = z.tuple([z.string().min(1), z.number().int(), z.number().int()]);

/** Opaque id of a group for one person: its group key and its section's time range [from, to). */
export function groupId(ctx: Pick<Ctx, 'encKey'>, userId: string, groupKey: string, from: Date, to: Date): string {
  const body = Buffer.from(JSON.stringify([groupKey, from.getTime(), to.getTime()])).toString('base64url');
  return `${body}.${groupSig(ctx, userId, groupKey, from.getTime(), to.getTime()).toString('base64url')}`;
}

/** The group a groupId names, or null for a tampered id or one handed out to another person. */
export function parseGroupId(ctx: Pick<Ctx, 'encKey'>, userId: string, id: string): { groupKey: string; from: Date; to: Date } | null {
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
  const [groupKey, from, to] = parsed;
  const sig = Buffer.from(id.slice(dot + 1), 'base64url');
  const want = groupSig(ctx, userId, groupKey, from, to);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  return { groupKey, from: new Date(from), to: new Date(to) };
}

type KindCount = { kind: string; n: number; unread: number };
const kindCounts = async (ctx: Pick<Ctx, 'db'>, userId: string) => (await ctx.db.query<KindCount>(
  `select n.kind, count(*)::int as n, (count(*) filter (where not ${readSql()}))::int as unread
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

interface GroupRow { sec: SectionKey; gk: string; count: number; unread: boolean; at: Date; at_us: string; last_id: string; item_ids: string[]; range_from: Date; range_to: Date }
interface ItemRow { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: Date; msg: unknown }

/**
 * One page of the grouped feed. Sections are the viewer's calendar today, the 6 days before, then one per calendar month (in `tz`);
 * within a section, rows with the same group key are one group, which belongs to the section of its newest row. Groups are ordered
 * newest first and a page ends at a group boundary. `now` is the reference time for the sections (tests pin it).
 */
export async function feed(
  ctx: Pick<Ctx, 'db' | 'encKey'>, userId: string, lang: Language,
  o: { tz: string; filter: FeedFilter; cursor: string | null; limit: number }, now: Date = new Date(),
): Promise<Feed> {
  const cursor = o.cursor ? decodeCursor(o.cursor) : null;
  if (o.cursor && !cursor) throw new Error('invalid_cursor');
  const limit = Math.min(Math.max(1, Math.floor(o.limit)), FEED_PAGE);
  const tz = viewerTz(o.tz);
  const perKind = await kindCounts(ctx, userId);
  // a category filter is the set of the person's visible kinds that map to it
  const kinds = o.filter === 'all' || o.filter === 'unread' ? null : perKind.map((x) => x.kind).filter((k) => categoryOf(k) === o.filter);
  const g = await ctx.db.query<GroupRow>(
    `with t as (select ($3::timestamptz at time zone $2)::date as today),
     v as (
       select n.id, n.created_at, coalesce(n.group_key, n.kind || '|id:' || n.id) as gk, ${readSql()} as read,
              (n.created_at at time zone $2)::date as d
         from ${fromSql()}
        where ${visibleSql()} and ($4::text[] is null or n.kind = any($4::text[]))
     ),
     sv as (
       select v.*, case when v.d >= t.today then 'today' when v.d >= t.today - 6 then 'week' else to_char(v.d, 'YYYY-MM') end as sec
         from v, t
     ),
     g as (
       select sec, gk, count(*)::int as count, bool_or(not read) as unread, max(created_at) as at, max(id) as last_id, min(d) as d,
              (array_agg(id order by created_at desc, id desc))[1:${FEED_ITEMS}] as item_ids
         from sv group by sec, gk
     )
     select g.sec, g.gk, g.count, g.unread, g.at, g.last_id, g.item_ids,
            to_char(g.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_us,
            (case g.sec when 'today' then t.today when 'week' then t.today - 6 else date_trunc('month', g.d)::date end)::timestamp at time zone $2 as range_from,
            (case g.sec when 'today' then t.today + 1 when 'week' then t.today
               else least((date_trunc('month', g.d) + interval '1 month')::date, t.today - 6) end)::timestamp at time zone $2 as range_to
       from g, t
      where (not $5::boolean or g.unread) and ($6::timestamptz is null or (g.at, g.last_id) < ($6::timestamptz, $7::bigint))
      order by g.at desc, g.last_id desc
      limit $8`,
    [userId, tz, now, kinds, o.filter === 'unread', cursor?.at ?? null, cursor?.id ?? null, limit + 1],
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
      id: groupId(ctx, userId, row.gk, row.range_from, row.range_to),
      kind: newest.kind, category: categoryOf(newest.kind), title: newest.title, body: newest.body, link: newest.link,
      at: row.at.toISOString(), count: row.count, unread: row.unread,
      items: shown.map((x) => ({ id: x.id, title: x.title, body: x.body, at: x.at })),
    };
    const last = sections[sections.length - 1];
    if (last?.key === row.sec) last.groups.push(group);
    else sections.push({ key: row.sec, groups: [group] });
  }
  const end = page[page.length - 1];
  const next = g.rows.length > limit && end ? encodeCursor({ s: end.sec, at: end.at_us, id: Number(end.last_id) }) : null;
  return { sections, next, ...countsOf(perKind) };
}
