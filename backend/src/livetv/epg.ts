// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Ctx } from '../ctx.js';
import { isOwnFeeds } from './channels.js';
import { LivetvError, livetvStream } from './client.js';
import { importLogos } from './logos.js';
import { invalidateLivetvRights } from './rights.js';
import { sourceSecrets, type SourceRow } from './sources.js';
import type { XmlItem } from './wire.js';

/**
 * The programme guide data of Phase 1 (spec §9.4, §10, §19; rulings 27, 42-44): the XMLTV import of a source through livetv
 * (`POST /v1/fetch/xmltv`, NDJSON), the automatic four-pass matching of channels to XMLTV channels, the EPG logos, now/next with the
 * channel's effective offset, and the daily prune.
 *
 * - A refresh replaces the source's imported programmes in one transaction, and only after a complete stream (its `end` line): an
 *   `error` line, a missing `end` line, a broken line or a failed request roll back and keep the old programmes (§19, ruling 27).
 * - `<icon>` URLs are kept in memory only (ruling 43): the refresh hands them to the matcher, which fetches the logos of matched
 *   channels that need them (`importLogo`, 7-day memo) and stores only the hash.
 * - `epg_last_error` holds fixed codes only (`^[a-z_]{1,40}$`), never a URL or a provider text (F13).
 * - Programme times are stored in UTC; offsets are applied when reading (ruling 42), so one XMLTV channel serves channels with
 *   different offsets.
 *
 * The `channels` filter of the request: livetv keeps only the listed XMLTV ids, exactly, and drops the other `<channel>` elements
 * too, so a filter built from tvg-ids would break the case-insensitive pass 1 and the name passes 2-4. The filter is therefore built
 * from the source's stored XMLTV channel index: every stored id any channel could match in any pass. The index itself comes from an
 * unfiltered run without programmes (an empty time window), at least every 7 days and whenever the EPG URL changed. A filter over
 * 2 000 ids or 48 KB (livetv's body cap is 64 KB) is omitted, and that run then replaces the index as well.
 */

/** livetv's own XMLTV timeout is 10 min; the backend waits a little longer so livetv answers the code */
const XMLTV_TIMEOUT_MS = 12 * 60_000;
const BATCH = 5_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** the programmes kept: yesterday (the prune drops older ones anyway) to 8 days ahead (the Phase 2 guide shows 7) */
const WINDOW_BACK_MS = DAY;
const WINDOW_AHEAD_MS = 8 * DAY;
/** sizes are counted from the bytes read, never from a content-length */
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 1024 ** 3;
const MAX_EPG_CHANNELS = 100_000;
/** livetv stops at 300 000 programmes (its XMLTV_MAX_PROGRAMMES); more is not its answer */
const MAX_PROGRAMMES = 300_000;
const FILTER_MAX_IDS = 2_000;
const FILTER_MAX_BYTES = 48 * 1024;
const INDEX_TTL_S = 7 * 24 * 3600;
/** the single-flight lock is renewed at most this often while a long stream is read */
const HEARTBEAT_MS = 60_000;
/** the logo step of one refresh stops after 5 minutes; the rest is fetched by the next refresh */
const LOGO_BUDGET_MS = 5 * 60_000;
const CODE_RE = /^[a-z_]{1,40}$/;
const PRUNE_HOUR = 4;
const PRUNE_MINUTE = 10;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const indexKey = (sourceId: string) => `ltv:epgidx:${sourceId}`;
const pruneKey = (day: string) => `ltv:epgprune:${day}`;
/** the key of the in-memory icon map: `sourceId|xmlId` */
const iconKey = (sourceId: string, xmlId: string) => `${sourceId}|${xmlId}`;

// ---- names ----

/**
 * livetv/src/m3u.ts `normName`, copied verbatim (the backend never imports from livetv/): NFKD, combining marks removed, lowercase,
 * letters and digits only, a trailing hd / fhd / uhd / 4k dropped. Both copies are pinned by test-vectors/livetv-normname.json (F18).
 */
export function normName(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').replace(/(?:fhd|uhd|hd|4k)$/, '');
}

/** a name for passes 2 and 3: case-insensitive, `_` and space alike, runs of spaces as one, trimmed */
const nameKey = (s: string) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const idKey = (s: string) => s.trim().toLowerCase();

// ---- the index and the four passes ----

/** one source's XMLTV channels by the key of each pass; every list holds distinct xml ids */
export interface EpgSourceIndex {
  /** lower-cased id -> xml ids (pass 1) */
  byId: Map<string, string[]>;
  /** lower-cased display-name, `_` as space -> xml ids (passes 2 and 3) */
  byName: Map<string, string[]>;
  /** normName(display-name) -> xml ids (pass 4) */
  byNorm: Map<string, string[]>;
}
/** the XMLTV channels of every source, per source */
export interface EpgIndex {
  sources: Map<string, EpgSourceIndex>;
}

const put = (m: Map<string, string[]>, k: string, xmlId: string) => {
  if (!k) return;
  const a = m.get(k);
  if (!a) m.set(k, [xmlId]);
  else if (!a.includes(xmlId)) a.push(xmlId);
};

export function buildEpgIndex(rows: Array<{ sourceId: string; xmlId: string; names: string[] }>): EpgIndex {
  const sources = new Map<string, EpgSourceIndex>();
  for (const r of rows) {
    let s = sources.get(r.sourceId);
    if (!s) sources.set(r.sourceId, (s = { byId: new Map(), byName: new Map(), byNorm: new Map() }));
    put(s.byId, idKey(r.xmlId), r.xmlId);
    for (const n of r.names) {
      put(s.byName, nameKey(n), r.xmlId);
      put(s.byNorm, normName(n), r.xmlId);
    }
  }
  return { sources };
}

type MatchInput = { sourceId: string; tvgId: string | null; tvgName: string | null; importName: string };
type Pass = { pass: 1 | 2 | 3 | 4; map: keyof EpgSourceIndex; key: (ch: MatchInput) => string };
/** spec §9.4, in this order; an empty key skips the pass */
const PASSES: readonly Pass[] = [
  { pass: 1, map: 'byId', key: (ch) => (ch.tvgId ? idKey(ch.tvgId) : '') },
  { pass: 2, map: 'byName', key: (ch) => (ch.tvgName ? nameKey(ch.tvgName) : '') },
  { pass: 3, map: 'byName', key: (ch) => nameKey(ch.importName) },
  { pass: 4, map: 'byNorm', key: (ch) => normName(ch.importName) },
];

/**
 * The automatic match of one channel (spec §9.4, ruling 27): the four passes in order; in each pass the channel's own source decides
 * when it has any hit (exactly one -> match, several -> next pass), otherwise the other sources together (exactly one hit across all
 * of them -> match, none or several -> next pass). Source positions play no part. Never a similarity match (ruling 44).
 */
export function matchChannel(ch: MatchInput, idx: EpgIndex): { sourceId: string; xmlId: string; pass: 1 | 2 | 3 | 4 } | null {
  for (const p of PASSES) {
    const key = p.key(ch);
    if (!key) continue;
    const own = idx.sources.get(ch.sourceId)?.[p.map].get(key);
    if (own && own.length > 0) {
      if (own.length === 1) return { sourceId: ch.sourceId, xmlId: own[0]!, pass: p.pass };
      continue;
    }
    let hit: { sourceId: string; xmlId: string } | null = null;
    let n = 0;
    for (const [sourceId, s] of idx.sources) {
      if (sourceId === ch.sourceId) continue;
      const a = s[p.map].get(key);
      if (!a) continue;
      n += a.length;
      if (n > 1) break;
      hit = { sourceId, xmlId: a[0]! };
    }
    if (n === 1 && hit) return { ...hit, pass: p.pass };
  }
  return null;
}

/** every xml id of one source index that any pass could hit for `ch` (the request filter) */
function candidates(ch: MatchInput, s: EpgSourceIndex, out: Set<string>): void {
  for (const p of PASSES) {
    const key = p.key(ch);
    for (const x of (key && s[p.map].get(key)) || []) out.add(x);
  }
}

/** the stored XMLTV channels of the sources that still have an EPG URL (one of them: `sourceId`) */
async function indexRows(ctx: Pick<Ctx, 'db'>, sourceId?: string): Promise<Array<{ sourceId: string; xmlId: string; names: string[] }>> {
  const rows = (await ctx.db.query<{ source_id: string; xml_id: string; names: string[] }>(
    `select e.source_id, e.xml_id, e.names from livetv_epg_channels e join livetv_sources s on s.id = e.source_id
      where s.epg_url_enc is not null and ($1::uuid is null or e.source_id = $1)`, [sourceId ?? null])).rows;
  return rows.map((r) => ({ sourceId: r.source_id, xmlId: r.xml_id, names: r.names }));
}

// ---- matching and logos ----

/**
 * Matches every channel with `epg_match = 'auto'` that is in the latest import (missing ones keep their mapping until they return or
 * are pruned); a channel without a match loses its mapping. With `icons` (the in-memory `<icon>` map of the refresh that just ran,
 * F17) the EPG logos follow (epgLogos); without, no logo is fetched and the stored `epg_logo_hash` values stay.
 */
export async function autoMatch(ctx: Ctx, o: { icons?: Map<string /* sourceId|xmlId */, string> } = {}): Promise<{ matched: number; total: number }> {
  const idx = buildEpgIndex(await indexRows(ctx));
  const rows = (await ctx.db.query<{ id: string; source_id: string; tvg_id: string | null; tvg_name: string | null; import_name: string; epg_source_id: string | null; epg_channel_id: string | null }>(
    `select id, source_id, tvg_id, tvg_name, import_name, epg_source_id, epg_channel_id from livetv_channels
      where epg_match = 'auto' and missing_since is null`)).rows;
  let matched = 0;
  const ids: string[] = [];
  const srcs: Array<string | null> = [];
  const xmls: Array<string | null> = [];
  for (const r of rows) {
    const m = matchChannel({ sourceId: r.source_id, tvgId: r.tvg_id, tvgName: r.tvg_name, importName: r.import_name }, idx);
    if (m) matched++;
    const src = m?.sourceId ?? null;
    const xml = m?.xmlId ?? null;
    if (src === r.epg_source_id && xml === r.epg_channel_id) continue;
    ids.push(r.id);
    srcs.push(src);
    xmls.push(xml);
  }
  for (let i = 0; i < ids.length; i += BATCH) {
    // `epg_match = 'auto'` again: an admin's manual choice made meanwhile is never overwritten
    await ctx.db.query(
      `update livetv_channels c set epg_source_id = u.src, epg_channel_id = u.xml
         from unnest($1::uuid[], $2::uuid[], $3::text[]) as u(id, src, xml) where c.id = u.id and c.epg_match = 'auto'`,
      [ids.slice(i, i + BATCH), srcs.slice(i, i + BATCH), xmls.slice(i, i + BATCH)]);
  }
  if (o.icons) await epgLogos(ctx, o.icons);
  return { matched, total: rows.length };
}

/**
 * The XMLTV logos (ruling 43): a matched channel whose source prefers `xmltv`, or prefers `m3u` but has no import logo, gets the
 * `<icon>` of its XMLTV channel through importLogo (7-day memo per URL) as `epg_logo_hash`; one whose XMLTV channel has no icon gets
 * null; an unmatched channel is cleared. Only channels matched to a source the map covers (the refresh that built it) are judged; a
 * logo that could not be fetched this time leaves the stored hash as it is. Answers the count of channels given a logo.
 */
export async function epgLogos(ctx: Ctx, icons: Map<string /* sourceId|xmlId */, string>): Promise<number> {
  await ctx.db.query('update livetv_channels set epg_logo_hash = null where (epg_source_id is null or epg_channel_id is null) and epg_logo_hash is not null');
  const covered = [...new Set([...icons.keys()].map((k) => k.slice(0, k.indexOf('|'))))];
  if (covered.length === 0) return 0;
  const rows = (await ctx.db.query<{ id: string; epg_source_id: string; epg_channel_id: string; allow_lan: boolean; epg_logo_hash: string | null }>(
    `select c.id, c.epg_source_id, c.epg_channel_id, es.allow_lan, c.epg_logo_hash
       from livetv_channels c join livetv_sources s on s.id = c.source_id join livetv_sources es on es.id = c.epg_source_id
      where c.epg_channel_id is not null and c.epg_source_id = any($1::uuid[]) and (s.logo_pref = 'xmltv' or c.import_logo_hash is null)`,
    [covered])).rows;
  const deadline = Date.now() + LOGO_BUDGET_MS;
  const urls = new Map<boolean, string[]>();
  for (const r of rows) {
    const u = icons.get(iconKey(r.epg_source_id, r.epg_channel_id));
    if (u) urls.set(r.allow_lan, [...(urls.get(r.allow_lan) ?? []), u]);
  }
  const found = new Map<string, string>(); // `${allowLan}|${url}` -> hash
  for (const [lan, list] of urls) {
    for (const [u, h] of await importLogos(ctx, list, lan, deadline)) found.set(`${lan}|${u}`, h);
  }
  const ids: string[] = [];
  const hashes: Array<string | null> = [];
  let given = 0;
  for (const r of rows) {
    const u = icons.get(iconKey(r.epg_source_id, r.epg_channel_id));
    const h = u ? found.get(`${r.allow_lan}|${u}`) : null;
    if (h === undefined) continue; // not fetched this time: unchanged
    if (h) given++;
    if (h === r.epg_logo_hash) continue;
    ids.push(r.id);
    hashes.push(h);
  }
  for (let i = 0; i < ids.length; i += BATCH) {
    await ctx.db.query(
      'update livetv_channels c set epg_logo_hash = u.hash from unnest($1::uuid[], $2::text[]) as u(id, hash) where c.id = u.id',
      [ids.slice(i, i + BATCH), hashes.slice(i, i + BATCH)]);
  }
  return given;
}

// ---- reading the NDJSON stream ----

type StreamEnd = { ok: true } | { error: string };
/** an item handler may stop the stream with a fixed code */
type OnItem = (item: XmlItem) => Promise<string | void> | string | void;

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const optStr = (o: Record<string, unknown>, k: string, max: number) => (str(o[k], max) ? { [k]: o[k] as string } : {});
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** one item line, read defensively (its strings come from a provider); null = dropped */
function readItem(o: Record<string, unknown>): XmlItem | null {
  if (o.t === 'channel') {
    if (!str(o.id, 500) || !Array.isArray(o.names)) return null;
    const names = o.names.filter((n): n is string => str(n, 200)).slice(0, 20);
    const icon = str(o.icon, 2048) && /^https?:\/\//i.test(o.icon) ? { icon: o.icon } : {};
    return { t: 'channel', id: o.id, names, ...icon };
  }
  if (o.t === 'prog') {
    if (!str(o.ch, 500) || !time(o.start) || !time(o.end) || o.end <= o.start || !str(o.title, 200)) return null;
    const cats = Array.isArray(o.cats) ? o.cats.filter((c): c is string => str(c, 100)).slice(0, 20) : [];
    return {
      t: 'prog', ch: o.ch, start: o.start, end: o.end, title: o.title,
      ...optStr(o, 'subtitle', 200), ...optStr(o, 'desc', 2000), ...(cats.length ? { cats } : {}), ...optStr(o, 'episode', 100),
      ...optStr(o, 'seriesId', 500), ...(o.isNew === true ? { isNew: true } : {}), ...(o.prevShown === true ? { prevShown: true } : {}),
      ...optStr(o, 'rating', 50),
    };
  }
  return null;
}

/**
 * Streams `/v1/fetch/xmltv` and hands each item to `onItem`. Complete only with the `end` line; anything else is a fixed code. The
 * body is cancelled whenever reading stops early (livetv then stops the provider download; client.ts clears its timer at once).
 */
async function readXmltv(ctx: Ctx, body: Record<string, unknown>, onItem: OnItem, heartbeat?: () => Promise<unknown>): Promise<StreamEnd> {
  let r: Response;
  try {
    r = await livetvStream(ctx, '/v1/fetch/xmltv', body, { timeoutMs: XMLTV_TIMEOUT_MS });
  } catch (e) {
    // TODO(1b merge): call dropLivetvProof(ctx) here when livetv was not reached (status null); PR 1b adds it, this lane lacks it
    if (e instanceof LivetvError) return { error: e.status === null ? 'livetv_unreachable' : e.code };
    throw e;
  }
  if (!r.body) return { error: 'incomplete' };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  let lineLen = 0;
  let total = 0;
  let beatAt = Date.now();

  const line = async (bytes: Uint8Array): Promise<StreamEnd | null> => {
    const text = decoder.decode(bytes).trim();
    if (!text) return null;
    let j: unknown;
    try { j = JSON.parse(text); } catch { return { error: 'invalid_answer' }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'invalid_answer' };
    const o = j as Record<string, unknown>;
    if (o.t === 'end') return { ok: true };
    if (o.t === 'error') return { error: typeof o.code === 'string' && CODE_RE.test(o.code) ? o.code : 'livetv_error' };
    const item = readItem(o);
    if (!item) return null;
    const stop = await onItem(item);
    return stop ? { error: stop } : null;
  };
  const take = () => {
    const b = Buffer.concat(parts, lineLen);
    parts = [];
    lineLen = 0;
    return b;
  };

  try {
    for (;;) {
      let chunk: Uint8Array;
      try {
        const x = await reader.read();
        if (x.done) break;
        chunk = x.value;
      } catch (e) {
        // the deadline aborts with a TimeoutError; anything else is a lost connection
        // TODO(1b merge): call dropLivetvProof(ctx) for the lost connection (`livetv_unreachable`) once PR 1b's helper is in this lane
        return { error: (e as { name?: unknown } | null)?.name === 'TimeoutError' ? 'timeout' : 'livetv_unreachable' };
      }
      total += chunk.byteLength;
      if (total > MAX_STREAM_BYTES) return { error: 'too_big' };
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        const piece = chunk.subarray(start, nl === -1 ? chunk.length : nl);
        lineLen += piece.byteLength;
        if (lineLen > MAX_LINE_BYTES) return { error: 'too_big' };
        parts.push(piece);
        if (nl === -1) break;
        start = nl + 1;
        const end = await line(take());
        if (end) return end;
        if (heartbeat && Date.now() - beatAt >= HEARTBEAT_MS) {
          beatAt = Date.now();
          await heartbeat();
        }
      }
    }
    if (lineLen > 0) {
      const end = await line(take());
      if (end) return end;
    }
    return { error: 'incomplete' }; // a stream without its end line failed (Task 14 ruling)
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ---- the import ----

type Tx = pg.PoolClient | Pick<Ctx, 'db'>['db'];

/** upserts the XMLTV channels; `replace` also drops the source's channels that are not in `chans` */
async function storeEpgChannels(db: Tx, sourceId: string, chans: Map<string, string[]>, replace: boolean): Promise<void> {
  const all = [...chans].map(([id, names]) => ({ id, names }));
  for (let i = 0; i < all.length; i += BATCH) {
    await db.query(
      `insert into livetv_epg_channels(source_id, xml_id, names)
       select $1, x.id, x.names from jsonb_to_recordset($2::jsonb) as x(id text, names text[])
       on conflict (source_id, xml_id) do update set names = excluded.names`,
      [sourceId, JSON.stringify(all.slice(i, i + BATCH))]);
  }
  if (replace) await db.query('delete from livetv_epg_channels where source_id = $1 and not (xml_id = any($2::text[]))', [sourceId, [...chans.keys()]]);
}

type ProgItem = Extract<XmlItem, { t: 'prog' }>;
async function insertProgrammes(db: Tx, sourceId: string, batch: readonly ProgItem[]): Promise<void> {
  if (batch.length === 0) return;
  const rows = batch.map((p) => ({
    ch: p.ch, s: p.start, e: p.end, title: p.title, subtitle: p.subtitle ?? null, descr: p.desc ?? null, cats: p.cats ?? null,
    episode: p.episode ?? null, series: p.seriesId ?? null, is_new: p.isNew ?? null, prev: p.prevShown ?? null, rating: p.rating ?? null,
  }));
  await db.query(
    `insert into livetv_programmes(source_id, xml_channel, start_at, end_at, title, subtitle, description, categories, episode, series_key,
       is_new, previously_shown, rating)
     select $1, x.ch, to_timestamp(x.s / 1000.0), to_timestamp(x.e / 1000.0), x.title, x.subtitle, x.descr, x.cats, x.episode, x.series,
       x.is_new, x.prev, x.rating
       from jsonb_to_recordset($2::jsonb) as x(ch text, s bigint, e bigint, title text, subtitle text, descr text, cats text[], episode text,
         series text, is_new boolean, prev boolean, rating text)`,
    [sourceId, JSON.stringify(rows)]);
}

/** the request filter: every stored xml id of this source any auto channel (or a manual mapping) could use; undefined = too big */
async function filterIds(ctx: Ctx, sourceId: string): Promise<string[] | undefined> {
  const s = buildEpgIndex(await indexRows(ctx, sourceId)).sources.get(sourceId);
  if (!s) return [];
  const out = new Set<string>();
  const rows = (await ctx.db.query<{ source_id: string; tvg_id: string | null; tvg_name: string | null; import_name: string; epg_match: string; epg_source_id: string | null; epg_channel_id: string | null }>(
    `select source_id, tvg_id, tvg_name, import_name, epg_match, epg_source_id, epg_channel_id from livetv_channels
      where (epg_match = 'auto' and missing_since is null) or (epg_match = 'manual' and epg_source_id = $1)`, [sourceId])).rows;
  for (const r of rows) {
    if (r.epg_match === 'manual') { if (r.epg_channel_id) out.add(r.epg_channel_id); continue; }
    candidates({ sourceId: r.source_id, tvgId: r.tvg_id, tvgName: r.tvg_name, importName: r.import_name }, s, out);
  }
  const ids = [...out];
  if (ids.length > FILTER_MAX_IDS || Buffer.byteLength(JSON.stringify(ids)) > FILTER_MAX_BYTES) return undefined;
  return ids;
}

async function importEpg(ctx: Ctx, source: SourceRow, url: string, icons: Map<string, string>, heartbeat?: () => Promise<unknown>): Promise<{ channels: number; programmes: number } | { error: string }> {
  const base = { url, allowLan: source.allow_lan, ...(source.user_agent ? { userAgent: source.user_agent } : {}) };
  const urlHash = sha256(url);
  const keepIcon = (it: Extract<XmlItem, { t: 'channel' }>) => { if (it.icon) icons.set(iconKey(source.id, it.id), it.icon); };

  // the index of the source's XMLTV channels: from a run without programmes when it is older than 7 days or the URL changed
  const stored = (await ctx.db.query<{ n: number }>('select count(*)::int as n from livetv_epg_channels where source_id = $1', [source.id])).rows[0]!.n;
  if ((await ctx.kv.get(indexKey(source.id))) !== urlHash || stored === 0) {
    const chans = new Map<string, string[]>();
    const r = await readXmltv(ctx, { ...base, from: 0, to: 1 }, (it) => {
      if (it.t !== 'channel') return;
      if (!chans.has(it.id) && chans.size >= MAX_EPG_CHANNELS) return 'too_big';
      chans.set(it.id, it.names);
      keepIcon(it);
    }, heartbeat);
    if ('error' in r) return r;
    const c = await (ctx.db as pg.Pool).connect();
    try {
      await c.query('begin');
      await storeEpgChannels(c, source.id, chans, true);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await ctx.kv.set(indexKey(source.id), urlHash, INDEX_TTL_S);
  }

  const filter = await filterIds(ctx, source.id);
  const now = Date.now();
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    await c.query('delete from livetv_programmes where source_id = $1', [source.id]);
    const chans = new Map<string, string[]>();
    let batch: ProgItem[] = [];
    let programmes = 0;
    const r = await readXmltv(ctx, { ...base, ...(filter ? { channels: filter } : {}), from: now - WINDOW_BACK_MS, to: now + WINDOW_AHEAD_MS }, async (it) => {
      if (it.t === 'channel') {
        if (!chans.has(it.id) && chans.size >= MAX_EPG_CHANNELS) return 'too_big';
        chans.set(it.id, it.names);
        keepIcon(it);
        return;
      }
      if (++programmes > MAX_PROGRAMMES) return 'too_big';
      batch.push(it);
      if (batch.length >= BATCH) {
        const b = batch;
        batch = [];
        await insertProgrammes(c, source.id, b);
      }
    }, heartbeat);
    if ('error' in r) {
      await c.query('rollback');
      return r;
    }
    await insertProgrammes(c, source.id, batch);
    // filtered: only the listed channels came, the others stay in the index; unfiltered: the run is a complete index
    await storeEpgChannels(c, source.id, chans, filter === undefined);
    await c.query('commit');
    if (filter === undefined) await ctx.kv.set(indexKey(source.id), urlHash, INDEX_TTL_S);
    return { channels: chans.size, programmes };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** the EPG state of the source: a fixed code or null (ok); a failure keeps the counts of the last good refresh */
async function record(ctx: Ctx, id: string, at: Date, error: string | null, counts: { channels: number; programmes: number } | null): Promise<void> {
  await ctx.db.query(
    `update livetv_sources set epg_last_refresh_at = $2, epg_last_ok_at = case when $3::text is null then $2 else epg_last_ok_at end,
       epg_last_error = $3, epg_counts = coalesce($4::jsonb, epg_counts) where id = $1`,
    [id, at, error, counts ? JSON.stringify(counts) : null]);
}

/**
 * Refreshes the programmes of one source (ruling 27): streams its XMLTV through livetv, upserts `livetv_epg_channels` and, in one
 * transaction, replaces the source's imported programmes (batches of 5 000); any failure rolls back and keeps the old ones. The
 * outcome goes to `epg_last_*` (fixed codes only). After the commit the channels are matched again with the `<icon>` URLs held in
 * memory, so their logos are fetched in the same refresh (F17). The own-feeds source and a source without an EPG URL have nothing to
 * refresh (`no_epg`, nothing recorded). `heartbeat` is called at most every minute while the stream is read (the caller's lock).
 * Unexpected errors are recorded as `internal` and rethrown.
 */
export async function refreshEpg(ctx: Ctx, source: SourceRow, o: { heartbeat?: () => Promise<unknown> } = {}): Promise<{ channels: number; programmes: number } | { error: string }> {
  if (isOwnFeeds(source.kind) || !source.epg_url_enc) return { error: 'no_epg' };
  const { epgUrl } = await sourceSecrets(ctx, source.id);
  if (!epgUrl) return { error: 'no_epg' };
  const at = new Date();
  const icons = new Map<string, string>();
  let r: { channels: number; programmes: number } | { error: string };
  try {
    r = await importEpg(ctx, source, epgUrl, icons, o.heartbeat);
    await record(ctx, source.id, at, 'error' in r ? r.error : null, 'error' in r ? null : r);
  } catch (e) {
    await record(ctx, source.id, at, 'internal', null).catch(() => undefined);
    throw e;
  }
  if (!('error' in r)) await autoMatch(ctx, { icons });
  return r;
}

// ---- reading ----

/** a programme as the user side shows it (spec §10): ISO date-times with the channel's effective EPG offset applied */
export interface Prog { title: string; start: string; end: string; subtitle?: string }

/**
 * Now and next of each mapped channel at `at` (default now), in one query. Per channel the programme covering `at − offset` (the
 * effective offset: channel override, else the list's tvg-shift, else the source's) is `now`, the first one starting after it is
 * `next`, and the offset is added to the times answered (ruling 42). Overlaps: the later start wins (spec §19). A channel without a
 * mapping or without programmes is absent or has neither.
 */
export async function nowNext(ctx: Pick<Ctx, 'db'>, channelIds: string[], at: Date = new Date()): Promise<Map<string, { now?: Prog; next?: Prog }>> {
  const out = new Map<string, { now?: Prog; next?: Prog }>();
  if (channelIds.length === 0) return out;
  type Row = { id: string; shift: number; n_title: string | null; n_sub: string | null; n_start: Date | null; n_end: Date | null; x_title: string | null; x_sub: string | null; x_start: Date | null; x_end: Date | null };
  const rows = (await ctx.db.query<Row>(
    `select ch.id, ch.shift,
            n.title as n_title, n.subtitle as n_sub, n.start_at as n_start, n.end_at as n_end,
            x.title as x_title, x.subtitle as x_sub, x.start_at as x_start, x.end_at as x_end
       from (select c.id, c.epg_source_id, c.epg_channel_id, coalesce(c.epg_shift_override_min, c.import_epg_shift_min, s.epg_shift_min) as shift
               from livetv_channels c join livetv_sources s on s.id = c.source_id
              where c.id = any($1::uuid[]) and c.epg_source_id is not null and c.epg_channel_id is not null) ch
       cross join lateral (select $2::timestamptz - make_interval(mins => ch.shift) as t) q
       left join lateral (select p.title, p.subtitle, p.start_at, p.end_at from livetv_programmes p
                           where p.source_id = ch.epg_source_id and p.xml_channel = ch.epg_channel_id
                             and p.start_at <= q.t and p.start_at > q.t - interval '2 days' and p.end_at > q.t
                           order by p.start_at desc limit 1) n on true
       left join lateral (select p.title, p.subtitle, p.start_at, p.end_at from livetv_programmes p
                           where p.source_id = ch.epg_source_id and p.xml_channel = ch.epg_channel_id and p.start_at > q.t
                           order by p.start_at limit 1) x on true`,
    [channelIds, at])).rows;
  const prog = (title: string | null, sub: string | null, start: Date | null, end: Date | null, shift: number): Prog | undefined => {
    if (title === null || start === null || end === null) return undefined;
    const p: Prog = { title, start: new Date(start.getTime() + shift * MINUTE).toISOString(), end: new Date(end.getTime() + shift * MINUTE).toISOString() };
    if (sub) p.subtitle = sub;
    return p;
  };
  for (const r of rows) {
    const now = prog(r.n_title, r.n_sub, r.n_start, r.n_end, r.shift);
    const next = prog(r.x_title, r.x_sub, r.x_start, r.x_end, r.shift);
    out.set(r.id, { ...(now ? { now } : {}), ...(next ? { next } : {}) });
  }
  return out;
}

/** Admin -> Live-TV, the Phase 1 guide counts (spec §9.4): channels in the latest import, how many have a programme mapping */
export async function epgSummary(ctx: Pick<Ctx, 'db'>): Promise<{ matched: number; total: number; unmatched: number }> {
  const r = (await ctx.db.query<{ total: number; matched: number }>(
    `select count(*)::int as total,
            (count(*) filter (where epg_source_id is not null and epg_channel_id is not null and epg_match <> 'none'))::int as matched
       from livetv_channels where missing_since is null`)).rows[0]!;
  return { matched: r.matched, total: r.total, unmatched: r.total - r.matched };
}

// ---- prune ----

/**
 * The daily prune (spec §10 `livetvEpgPrune`): programmes that ended more than a day ago, channels missing for more than 30 days (their
 * favourites and recent rows go with them), and logos no channel references. A logo fetched in the last hour is kept: a refresh may
 * have stored it and not yet written its hash to a channel.
 */
export async function epgPrune(ctx: Pick<Ctx, 'db'>, now: Date = new Date()): Promise<{ programmes: number; channels: number; logos: number }> {
  const t = now.getTime();
  const programmes = (await ctx.db.query('delete from livetv_programmes where end_at < $1', [new Date(t - DAY)])).rowCount ?? 0;
  const channels = (await ctx.db.query('delete from livetv_channels where missing_since < $1', [new Date(t - 30 * DAY)])).rowCount ?? 0;
  if (channels > 0) invalidateLivetvRights();
  const logos = (await ctx.db.query(
    `delete from livetv_logos l where l.fetched_at < $1 and not exists (select 1 from livetv_channels c
        where c.import_logo_hash = l.hash or c.logo_override_hash = l.hash or c.epg_logo_hash = l.hash)`,
    [new Date(t - 60 * MINUTE)])).rowCount ?? 0;
  return { programmes, channels, logos };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Every 10 minutes (server.ts): runs epgPrune once a day from 04:10 server time, once across processes (KV day key). A failed prune
 * gives the day key back, so the next tick of the hour tries again. True when it ran.
 */
export async function livetvEpgPruneTick(ctx: Pick<Ctx, 'db' | 'kv'>, now: Date = new Date()): Promise<boolean> {
  if (now.getHours() !== PRUNE_HOUR || now.getMinutes() < PRUNE_MINUTE) return false;
  const key = pruneKey(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  if (!(await ctx.kv.setnx(key, '1', 2 * 24 * 3600))) return false;
  try {
    await epgPrune(ctx, now);
  } catch (e) {
    await ctx.kv.del(key).catch(() => undefined);
    throw e;
  }
  return true;
}
