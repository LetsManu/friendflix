// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { auditInTx } from '../audit.js';
import { decrypt, encrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import { CHANNEL_SELECT, OWN_FEEDS_KIND, isOwnFeeds } from './channels.js';
import { LivetvError, dropLivetvProof, livetvCall, livetvStream } from './client.js';
import { matchIds } from './epg.js';
import { removeGuideFiles } from './guidefiles.js';
import { livetvWrite } from './tx.js';
import { checkSourceUrl, maskUrl, urlRefusal } from './urls.js';
import type { FetchM3uAnswer } from './wire.js';

/**
 * Live TV sources (spec §6.1, §9.1): provider lists (`m3u`) and the own-feeds source (stored kind 'manual', called 'feeds' on the
 * wire, F16). Provider URLs are secrets (F13): stored only as APP_ENC_KEY blobs (`url_enc`, `epg_url_enc`), answered only as the
 * masked hint (`https://iptv.example.com/…`), never logged, never in audit meta (field names only), never in an error text (fixed
 * codes). `sourceSecrets` decrypts them, and only for calls to livetv; the backend itself never follows a provider URL (spec §3.4).
 * Every write runs in one transaction with its audit entry and drops the cached channel sets afterwards (invalidateLivetvRights).
 */

const SCHEMES: Array<'http:' | 'https:'> = ['http:', 'https:'];
/** livetv's own M3U timeout is 60 s (livetv/src/routes/fetch.ts); the backend waits a little longer so livetv answers the code */
const TEST_M3U_TIMEOUT_MS = 75_000;
/** the EPG count of *Prüfen* stops after 2 minutes (the refresh itself may take 10) */
const TEST_EPG_TIMEOUT_MS = 120_000;
const SAMPLES = 5;
/** *Prüfen* on a guide names this many of its channels */
const GUIDE_SAMPLES = 8;
/** stored kind of an extra programme guide (migration 52); the API says 'guide' too */
export const GUIDE_KIND = 'guide';
/** an extra programme guide (kind 'guide'): no channels, no list, only its XMLTV (extra guides design) */
export const isGuide = (kind: string): boolean => kind === GUIDE_KIND;
export type GuideProvider = 'xmltv_url' | 'xmltv_file';
/** an extra guide from an uploaded XMLTV file (Stage 2): no link, refreshed only by an upload, *Aktualisieren* or an edit (refresh.ts) */
export const isFileGuide = (s: { kind: string; guide_provider: string | null }): boolean => isGuide(s.kind) && s.guide_provider === 'xmltv_file';

export type Refresh = '6h' | '12h' | '24h' | 'weekly' | 'manual';

/** a `livetv_sources` row as stored (migrations 48, 52); `*_enc` are APP_ENC_KEY blobs and never leave the backend */
export interface SourceRow {
  id: string;
  kind: 'm3u' | typeof OWN_FEEDS_KIND | typeof GUIDE_KIND;
  name: string;
  url_enc: string | null;
  url_hint: string | null;
  epg_url_enc: string | null;
  epg_hint: string | null;
  user_agent: string | null;
  allow_lan: boolean;
  refresh: Refresh;
  skip_groups: string[];
  numbering: 'chno' | 'order';
  number_base: number;
  logo_pref: 'm3u' | 'xmltv';
  epg_shift_min: number;
  max_streams: number | null;
  enabled: boolean;
  position: number;
  last_refresh_at: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
  last_counts: Record<string, unknown> | null;
  epg_last_refresh_at: Date | null;
  epg_last_ok_at: Date | null;
  epg_last_error: string | null;
  epg_counts: Record<string, unknown> | null;
  /** kind 'guide' only: where its XMLTV comes from */
  guide_provider: GuideProvider | null;
  /** kind 'guide' only: the sources whose channels it may serve; null = all, [] = none left (the guide was disabled) */
  guide_scope: string[] | null;
  /** an uploaded guide's stored file (Stage 2): `<id>.xml[.gz]` in guidefiles.ts guideDir, set once an upload's import succeeded */
  guide_file: string | null;
  /** the stored file's name as uploaded (cut) and its size (bigint: pg answers a string) (migration 53) */
  guide_file_name: string | null;
  guide_file_bytes: string | null;
  created_at: Date;
  updated_at: Date;
}

/** one source as the admin sees it (the web re-declares it, Task 21); no URL but the masked hints */
export interface SourceView {
  id: string;
  /** stored 'm3u' | 'manual' (F16) | 'guide' */
  kind: 'm3u' | 'feeds' | 'guide';
  name: string;
  urlHint: string | null;
  epgHint: string | null;
  userAgent: string | null;
  allowLan: boolean;
  refresh: Refresh;
  skipGroups: string[];
  numbering: 'chno' | 'order';
  numberBase: number;
  logoPref: 'm3u' | 'xmltv';
  epgShiftMin: number;
  maxStreams: number | null;
  enabled: boolean;
  position: number;
  /** channels of this source that are in the latest import (missing ones not counted) */
  channelCount: number;
  /** unreleased groups holding channels of this source */
  pendingGroups: number;
  /** a guide's provider; null for lists and the own-feeds source */
  guideProvider: GuideProvider | null;
  /** a guide's "Gilt für": null = all channels, else source ids; [] = its scoped sources were all deleted (then it is disabled) */
  guideScope: string[] | null;
  /** channels (in the latest import) whose programme currently comes from this source */
  servedChannels: number;
  /** an uploaded guide's current file: the name it was uploaded with and its size; null until an upload was imported, and for others */
  fileName: string | null;
  fileBytes: number | null;
  state: {
    lastRefreshAt: string | null;
    lastOkAt: string | null;
    lastError: string | null;
    counts: { channels: number; added: number; removed: number } | null;
    epg: { lastRefreshAt: string | null; lastOkAt: string | null; lastError: string | null; programmes: number | null };
  };
}

// ---- the body (spec §9.1 sheet; plan Task 15 SourceBody) ----
const httpUrl = z.string().trim().min(1).max(2048).refine((v) => {
  try {
    return (SCHEMES as string[]).includes(new URL(v).protocol);
  } catch {
    return false;
  }
});
/** an EPG URL; an empty (or blank) field means none, as the web form may send it */
const epgUrl = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), httpUrl.nullable());
/** printable ASCII only: livetv sends it as an HTTP header (livetv/src/m3u.ts USER_AGENT_RE); empty = none */
const userAgent = z.string().max(200).regex(/^[ -~]*$/).nullable();
const fields = {
  name: z.string().trim().min(1).max(60),
  url: httpUrl,
  epgUrl,
  userAgent,
  allowLan: z.boolean(),
  refresh: z.enum(['6h', '12h', '24h', 'weekly', 'manual']),
  skipGroups: z.array(z.string().min(1).max(200)).max(2000).transform((a) => [...new Set(a)]),
  numbering: z.enum(['chno', 'order']),
  numberBase: z.number().int().min(1).max(99_999),
  logoPref: z.enum(['m3u', 'xmltv']),
  epgShiftMin: z.number().int().min(-720).max(840).multipleOf(30),
  maxStreams: z.number().int().min(1).max(50).nullable(),
  enabled: z.boolean(),
};
/** a guide's "Gilt für": null = all channels, else a non-empty set of source ids (lists or the own-feeds source, checked on save) */
const guideScope = z.array(z.guid()).min(1).max(500).transform((a) => [...new Set(a)]).nullable();
/** the place of a source in its card list; a guide given the place of another guide swaps with it (updateSource) */
const position = z.number().int().min(0).max(1_000_000);
const listCreate = z.object({
  kind: z.literal('m3u'),
  ...fields,
  epgUrl: fields.epgUrl.default(null),
  userAgent: fields.userAgent.default(null),
  allowLan: fields.allowLan.default(false),
  refresh: fields.refresh.default('24h'),
  skipGroups: fields.skipGroups.default([]),
  numbering: fields.numbering.default('chno'),
  numberBase: fields.numberBase.default(1),
  logoPref: fields.logoPref.default('m3u'),
  epgShiftMin: fields.epgShiftMin.default(0),
  maxStreams: fields.maxStreams.default(null),
  enabled: fields.enabled.default(true),
}).strict();
/** an extra programme guide from an XMLTV link (Stage 1) */
const linkGuideCreate = z.object({
  kind: z.literal('guide'),
  guideProvider: z.literal('xmltv_url'),
  name: fields.name,
  epgUrl: httpUrl,
  userAgent: fields.userAgent.default(null),
  allowLan: fields.allowLan.default(false),
  refresh: fields.refresh.default('24h'),
  epgShiftMin: fields.epgShiftMin.default(0),
  guideScope,
  enabled: fields.enabled.default(true),
}).strict();
/** none of a link's fields: a field given anyway is refused `invalid` with its name */
const absent = z.never().optional();
/** an extra programme guide from an uploaded XMLTV file (Stage 2): created first, its file follows with `PUT /sources/:id/file` */
const fileGuideCreate = z.object({
  kind: z.literal('guide'),
  guideProvider: z.literal('xmltv_file'),
  name: fields.name,
  epgUrl: absent,
  userAgent: absent,
  allowLan: absent,
  /** a file is imported when it is uploaded, never on a schedule */
  refresh: z.literal('manual').default('manual'),
  epgShiftMin: fields.epgShiftMin.default(0),
  guideScope,
  enabled: fields.enabled.default(true),
}).strict();
const guideCreate = z.discriminatedUnion('guideProvider', [linkGuideCreate, fileGuideCreate]);
/** `POST /sources`: a body without `kind` is a provider list (as before guides existed), a guide without `guideProvider` a link */
export const sourceCreate = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    if (!('kind' in v)) return { ...v, kind: 'm3u' };
    return (v as { kind: unknown }).kind === 'guide' && !('guideProvider' in v) ? { ...v, guideProvider: 'xmltv_url' } : v;
  },
  z.discriminatedUnion('kind', [listCreate, guideCreate]),
);
export const sourcePatch = z.object({ ...fields, guideScope, position }).partial().strict();
export type ListBody = z.output<typeof listCreate>;
export type GuideBody = z.output<typeof linkGuideCreate>;
export type FileGuideBody = z.output<typeof fileGuideCreate>;
export type SourceBody = ListBody | GuideBody | FileGuideBody;
export type SourcePatch = z.output<typeof sourcePatch>;

/** `POST /sources/test`: a missing `url` (`epgUrl`, `userAgent`) with `sourceId` uses the stored one; `epgUrl: null` = no EPG */
export const sourceTestBody = z.object({
  url: httpUrl.optional(),
  epgUrl: epgUrl.optional(),
  userAgent: userAgent.optional(),
  allowLan: z.boolean(),
  sourceId: z.guid().optional(),
}).strict();
export type SourceTestBody = z.output<typeof sourceTestBody>;
/** `POST /sources/test` for a guide: its link (or, with `sourceId`, the stored one) */
export const guideTestBody = z.object({
  kind: z.literal('guide'),
  epgUrl: httpUrl.optional(),
  userAgent: userAgent.optional(),
  allowLan: z.boolean().default(false),
  sourceId: z.guid().optional(),
}).strict();
export type GuideTestBody = z.output<typeof guideTestBody>;
/** a list test body has no `kind` (as before guides existed) */
export const anyTestBody = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) && !('kind' in v) ? { ...v, kind: 'm3u' } : v),
  z.discriminatedUnion('kind', [sourceTestBody.extend({ kind: z.literal('m3u') }), guideTestBody]),
);

/** a refusal that is not a schema failure, answered `400 { error: code, field }` (Global Constraint *Errors*) */
export class SourceRefusal extends Error {
  constructor(readonly code: 'invalid' | 'lan_required' | 'refused', readonly field: string) {
    super(code);
    this.name = 'SourceRefusal';
  }
}

/** the save-time URL check as a refusal: a wrong scheme or no URL is `invalid` (as the schema answers it), a single-label host `refused` */
function checkUrl(raw: string, allowLan: boolean, field: 'url' | 'epgUrl'): void {
  const r = checkSourceUrl(raw, { allowLan, schemes: SCHEMES });
  if (!r.ok) throw new SourceRefusal(urlRefusal(r.code), field);
}

// ---- reading ----
const VIEW_COLUMNS = `src.id, src.kind, src.name, src.url_hint, src.epg_hint, src.user_agent, src.allow_lan, src.refresh, src.skip_groups,
  src.numbering, src.number_base, src.logo_pref, src.epg_shift_min, src.max_streams, src.enabled, src.position,
  src.last_refresh_at, src.last_ok_at, src.last_error, src.last_counts, src.epg_last_refresh_at, src.epg_last_ok_at, src.epg_last_error,
  src.epg_counts, src.guide_provider, src.guide_scope, src.guide_file, src.guide_file_name, src.guide_file_bytes`;
const VIEW_SQL = `
  select ${VIEW_COLUMNS},
    coalesce(n.channels, 0)::int as channel_count,
    coalesce(p.pending, 0)::int as pending_groups,
    coalesce(sv.served, 0)::int as served_channels
  from livetv_sources src
  left join (select source_id, count(*) as channels from livetv_channels where missing_since is null group by source_id) n
    on n.source_id = src.id
  left join (select x.source_id, count(distinct x.group_id) as pending from (${CHANNEL_SELECT}) x
               join livetv_groups g on g.id = x.group_id and not g.released
              where x.missing_since is null group by x.source_id) p
    on p.source_id = src.id
  left join (select epg_source_id, count(*) as served from livetv_channels
              where missing_since is null and epg_channel_id is not null and epg_match <> 'none' group by epg_source_id) sv
    on sv.epg_source_id = src.id`;
type ViewRow = Omit<SourceRow, 'url_enc' | 'epg_url_enc' | 'created_at' | 'updated_at'> & { channel_count: number; pending_groups: number; served_channels: number };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toView(r: ViewRow): SourceView {
  const c = r.last_counts;
  const counts = c && num(c.channels) !== null ? { channels: num(c.channels)!, added: num(c.added) ?? 0, removed: num(c.removed) ?? 0 } : null;
  return {
    id: r.id,
    kind: isOwnFeeds(r.kind) ? 'feeds' : isGuide(r.kind) ? 'guide' : 'm3u',
    name: r.name,
    urlHint: r.url_hint,
    epgHint: r.epg_hint,
    userAgent: r.user_agent,
    allowLan: r.allow_lan,
    refresh: r.refresh,
    skipGroups: r.skip_groups,
    numbering: r.numbering,
    numberBase: r.number_base,
    logoPref: r.logo_pref,
    epgShiftMin: r.epg_shift_min,
    maxStreams: r.max_streams,
    enabled: r.enabled,
    position: r.position,
    channelCount: r.channel_count,
    pendingGroups: r.pending_groups,
    guideProvider: isGuide(r.kind) ? r.guide_provider : null,
    guideScope: isGuide(r.kind) ? r.guide_scope : null,
    servedChannels: r.served_channels,
    fileName: isFileGuide(r) && r.guide_file ? r.guide_file_name ?? 'guide.xml' : null,
    fileBytes: isFileGuide(r) && r.guide_file ? num(Number(r.guide_file_bytes)) : null,
    state: {
      lastRefreshAt: iso(r.last_refresh_at),
      lastOkAt: iso(r.last_ok_at),
      lastError: r.last_error,
      counts,
      epg: { lastRefreshAt: iso(r.epg_last_refresh_at), lastOkAt: iso(r.epg_last_ok_at), lastError: r.epg_last_error, programmes: num(r.epg_counts?.programmes) },
    },
  };
}

export async function listSources(ctx: Pick<Ctx, 'db'>): Promise<SourceView[]> {
  const rows = (await ctx.db.query<ViewRow>(`${VIEW_SQL} order by src.position, src.created_at, src.id`)).rows;
  return rows.map(toView);
}

export async function sourceView(ctx: Pick<Ctx, 'db'>, id: string): Promise<SourceView | null> {
  const r = (await ctx.db.query<ViewRow>(`${VIEW_SQL} where src.id = $1`, [id])).rows[0];
  return r ? toView(r) : null;
}

/** the decrypted URLs, only for calls to livetv (F13): never answered, logged or audited */
export async function sourceSecrets(ctx: Pick<Ctx, 'db' | 'encKey'>, id: string): Promise<{ url: string | null; epgUrl: string | null }> {
  const r = (await ctx.db.query<Pick<SourceRow, 'url_enc' | 'epg_url_enc'>>('select url_enc, epg_url_enc from livetv_sources where id = $1', [id])).rows[0];
  return {
    url: r?.url_enc ? decrypt(ctx.encKey, r.url_enc) : null,
    epgUrl: r?.epg_url_enc ? decrypt(ctx.encKey, r.epg_url_enc) : null,
  };
}

// ---- writing ----
type WriteCtx = Pick<Ctx, 'db' | 'encKey'>;

/** one transaction; the cached channel sets are dropped afterwards (tx.ts) */
const write = <T>(ctx: Pick<Ctx, 'db'>, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => livetvWrite(ctx, fn);

/** the field names of a body in a fixed order (audit meta: names only, never values) */
const FIELD_ORDER = [...Object.keys(fields), 'guideScope', 'position'];
const named = (b: object) => FIELD_ORDER.filter((k) => k in b && (b as Record<string, unknown>)[k] !== undefined);

/** a guide's scope names existing lists or the own-feeds source, never a guide (or an unknown id): else `invalid` `guideScope` */
async function checkScope(c: pg.PoolClient, scope: readonly string[] | null): Promise<void> {
  if (scope === null) return;
  // locked (like deleteSource's `for update`): a list deleted meanwhile cannot leave its id in an enabled guide's scope
  const n = (await c.query('select id from livetv_sources where id = any($1::uuid[]) and kind <> $2 order by id for share', [[...scope], GUIDE_KIND])).rowCount;
  if (n !== scope.length) throw new SourceRefusal('invalid', 'guideScope'); // the schema removed duplicates
}

/** the fields a guide does not have (it has no list): a patch naming one is refused `invalid` with that field */
const LIST_ONLY = ['url', 'skipGroups', 'numbering', 'numberBase', 'logoPref', 'maxStreams'] as const;
/** the link fields an uploaded guide does not have either (its refresh stays 'manual') */
const LINK_ONLY = ['epgUrl', 'userAgent', 'allowLan'] as const;

/**
 * A provider list (kind 'm3u'; the own-feeds source is created by Task 20) or an extra programme guide (kind 'guide', an XMLTV link).
 * URLs are checked first, then stored encrypted. A new guide has never been refreshed, so the next refresh tick imports it.
 */
export async function createSource(ctx: WriteCtx, actor: string, b: SourceBody): Promise<SourceView> {
  if (b.kind === 'guide') return b.guideProvider === 'xmltv_file' ? createFileGuide(ctx, actor, b) : createGuide(ctx, actor, b);
  checkUrl(b.url, b.allowLan, 'url');
  if (b.epgUrl !== null) checkUrl(b.epgUrl, b.allowLan, 'epgUrl');
  const id = randomUUID();
  await write(ctx, async (c) => {
    await c.query(
      `insert into livetv_sources(id, kind, name, url_enc, url_hint, epg_url_enc, epg_hint, user_agent, allow_lan, refresh, skip_groups,
         numbering, number_base, logo_pref, epg_shift_min, max_streams, enabled, position)
       values ($1, 'm3u', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         (select coalesce(max(position) + 1, 0) from livetv_sources))`,
      [id, b.name, encrypt(ctx.encKey, b.url), maskUrl(b.url), b.epgUrl === null ? null : encrypt(ctx.encKey, b.epgUrl), b.epgUrl === null ? null : maskUrl(b.epgUrl),
        b.userAgent || null, b.allowLan, b.refresh, b.skipGroups, b.numbering, b.numberBase, b.logoPref, b.epgShiftMin, b.maxStreams, b.enabled]);
    await auditInTx({ db: c }, actor, 'livetv.source.create', id, { fields: named(b) });
  });
  return (await sourceView(ctx, id))!;
}

async function createGuide(ctx: WriteCtx, actor: string, b: GuideBody): Promise<SourceView> {
  checkUrl(b.epgUrl, b.allowLan, 'epgUrl');
  const id = randomUUID();
  await write(ctx, async (c) => {
    await checkScope(c, b.guideScope);
    await c.query(
      `insert into livetv_sources(id, kind, name, epg_url_enc, epg_hint, user_agent, allow_lan, refresh, epg_shift_min, enabled, guide_provider, guide_scope,
         position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'xmltv_url', $11, (select coalesce(max(position) + 1, 0) from livetv_sources))`,
      [id, GUIDE_KIND, b.name, encrypt(ctx.encKey, b.epgUrl), maskUrl(b.epgUrl), b.userAgent || null, b.allowLan, b.refresh, b.epgShiftMin, b.enabled,
        b.guideScope]);
    await auditInTx({ db: c }, actor, 'livetv.source.create', id, { fields: named(b) });
  });
  return (await sourceView(ctx, id))!;
}

/** a guide whose file comes with `PUT /sources/:id/file`; until then it has none (`fileName` null) and nothing to import */
async function createFileGuide(ctx: WriteCtx, actor: string, b: FileGuideBody): Promise<SourceView> {
  const id = randomUUID();
  await write(ctx, async (c) => {
    await checkScope(c, b.guideScope);
    await c.query(
      `insert into livetv_sources(id, kind, name, refresh, epg_shift_min, enabled, guide_provider, guide_scope, position)
       values ($1, $2, $3, 'manual', $4, $5, 'xmltv_file', $6, (select coalesce(max(position) + 1, 0) from livetv_sources))`,
      [id, GUIDE_KIND, b.name, b.epgShiftMin, b.enabled, b.guideScope]);
    await auditInTx({ db: c }, actor, 'livetv.source.create', id, { fields: named(b) });
  });
  return (await sourceView(ctx, id))!;
}

/** the same set of group names (both are free of duplicates: the schema removes them, and so did every earlier save) */
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const have = new Set(b);
  return a.length === b.length && a.every((x) => have.has(x));
};

/**
 * Changes the fields `patch` names: an absent `url`/`epgUrl` stays as stored, `epgUrl: null` removes it. The stored URLs are checked
 * again against the resulting `allowLan` (turning *LAN erlauben* off under a LAN address is refused). The own-feeds source has no list
 * and no EPG URL (`invalid`). A changed `skipGroups`, `numbering`, `numberBase` or `url` marks the source due (`last_refresh_at`
 * cleared), so the next refresh tick re-imports it (whatever its refresh interval, *Manuell* too). A new `url` drops `last_counts.listed`, the shrink guard's reference. null = no such source.
 */
export async function updateSource(ctx: WriteCtx, actor: string, id: string, patch: SourcePatch): Promise<SourceView | null> {
  const found = await write(ctx, async (c) => {
    const s = (await c.query<SourceRow>('select * from livetv_sources where id = $1 for update', [id])).rows[0];
    if (!s) return false;
    const own = isOwnFeeds(s.kind);
    const guide = isGuide(s.kind);
    // a guide has no list and always its link; only a guide has a scope
    if (guide) for (const k of LIST_ONLY) if (patch[k] !== undefined) throw new SourceRefusal('invalid', k);
    if (isFileGuide(s)) {
      for (const k of LINK_ONLY) if (patch[k] !== undefined) throw new SourceRefusal('invalid', k);
      if (patch.refresh !== undefined && patch.refresh !== 'manual') throw new SourceRefusal('invalid', 'refresh');
    }
    if (guide && patch.epgUrl === null) throw new SourceRefusal('invalid', 'epgUrl');
    if (!guide && patch.guideScope !== undefined) throw new SourceRefusal('invalid', 'guideScope');
    // a guide whose scoped sources were all deleted ([]) is switched on again only together with a new scope
    if (guide && patch.enabled === true && patch.guideScope === undefined && s.guide_scope?.length === 0) throw new SourceRefusal('invalid', 'guideScope');
    // only the extra guides are ordered (the web does not reorder lists): a list's or the own-feeds source's position is not patchable
    if (!guide && patch.position !== undefined) throw new SourceRefusal('invalid', 'position');
    if (own && patch.url !== undefined) throw new SourceRefusal('invalid', 'url');
    if (own && patch.epgUrl !== undefined && patch.epgUrl !== null) throw new SourceRefusal('invalid', 'epgUrl');
    const allowLan = patch.allowLan ?? s.allow_lan;
    // what is checked: the new URL, else the stored one when allowLan changes (the stored ones passed under the old value)
    const url = patch.url ?? (s.url_enc && patch.allowLan !== undefined ? decrypt(ctx.encKey, s.url_enc) : undefined);
    if (url !== undefined) checkUrl(url, allowLan, 'url');
    const epg = patch.epgUrl !== undefined ? patch.epgUrl : (s.epg_url_enc && patch.allowLan !== undefined ? decrypt(ctx.encKey, s.epg_url_enc) : null);
    if (epg !== null) checkUrl(epg, allowLan, 'epgUrl');

    const set: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.url !== undefined) { put('url_enc', encrypt(ctx.encKey, patch.url)); put('url_hint', maskUrl(patch.url)); }
    if (patch.epgUrl !== undefined) {
      put('epg_url_enc', patch.epgUrl === null ? null : encrypt(ctx.encKey, patch.epgUrl));
      put('epg_hint', patch.epgUrl === null ? null : maskUrl(patch.epgUrl));
    }
    if (patch.userAgent !== undefined) put('user_agent', patch.userAgent || null);
    if (patch.allowLan !== undefined) put('allow_lan', patch.allowLan);
    if (patch.refresh !== undefined) put('refresh', patch.refresh);
    if (patch.skipGroups !== undefined) put('skip_groups', patch.skipGroups);
    if (patch.numbering !== undefined) put('numbering', patch.numbering);
    if (patch.numberBase !== undefined) put('number_base', patch.numberBase);
    if (patch.logoPref !== undefined) put('logo_pref', patch.logoPref);
    if (patch.epgShiftMin !== undefined) put('epg_shift_min', patch.epgShiftMin);
    if (patch.maxStreams !== undefined) put('max_streams', patch.maxStreams);
    if (patch.enabled !== undefined) put('enabled', patch.enabled);
    if (patch.guideScope !== undefined) {
      await checkScope(c, patch.guideScope);
      put('guide_scope', patch.guideScope);
    }
    if (patch.position !== undefined && patch.position !== s.position) {
      // order among guides (first wins a fill): the guide holding that place takes this one's old place
      await c.query('update livetv_sources set position = $2 where kind = $3 and position = $1 and id <> $4', [patch.position, s.position, GUIDE_KIND, id]);
      put('position', patch.position);
    }
    // a guide imports again on the next tick when its link, its scope (the request filter) or its being switched on changed
    const scopeChanged = patch.guideScope !== undefined && !(patch.guideScope === null ? s.guide_scope === null : s.guide_scope !== null && sameSet(patch.guideScope, s.guide_scope));
    const epgUrlChanged = guide && patch.epgUrl != null && decrypt(ctx.encKey, s.epg_url_enc!) !== patch.epgUrl;
    if (guide && (epgUrlChanged || scopeChanged || (patch.enabled === true && !s.enabled))) {
      set.push('epg_last_refresh_at = null');
    }
    // another list (a new URL) is imported again too (bughunt L1), also for a source with refresh *Manuell*
    const due = (patch.skipGroups !== undefined && !sameSet(patch.skipGroups, s.skip_groups))
      || (patch.numbering !== undefined && patch.numbering !== s.numbering)
      || (patch.numberBase !== undefined && patch.numberBase !== s.number_base)
      || (patch.url !== undefined && (s.url_enc === null || decrypt(ctx.encKey, s.url_enc) !== patch.url));
    if (due) set.push('last_refresh_at = null');
    // another list: the 20 % shrink guard must not compare it with the old one (it would refuse a smaller list for ever)
    if (patch.url !== undefined) set.push("last_counts = last_counts - 'listed'");
    set.push('updated_at = now()');
    vals.push(id);
    await c.query(`update livetv_sources set ${set.join(', ')} where id = $${vals.length}`, vals);
    await auditInTx({ db: c }, actor, 'livetv.source.update', id, { fields: named(patch) });
    // the fill pass (epg.ts matchIds) follows a guide's being switched on or off, its scope and its order at once
    if (guide && ((patch.enabled !== undefined && patch.enabled !== s.enabled) || scopeChanged || epgUrlChanged || (patch.position !== undefined && patch.position !== s.position))) {
      await matchIds(c);
    }
    return true;
  });
  return found ? sourceView(ctx, id) : null;
}

/**
 * Deletes the source; its channels (with their overrides, favourites and recent entries) go with it. null = no such source. `push` =
 * push feeds went with it (counted inside the transaction), so the caller re-sends livetv's ingest set (ownfeeds.ts syncIngest).
 * Guides: a deleted guide's channels (automatic matches and hand pins) go back to `auto`; a deleted source leaves every guide scope,
 * and a guide whose scope is left empty is switched off ("Gilt für keine Quelle mehr"). Either way the channels are matched again.
 * An uploaded guide's files go after the commit (an upload still running for it removes its own when it finds the row gone).
 */
export async function deleteSource(
  ctx: Pick<Ctx, 'db' | 'cfg'>, actor: string, id: string, log?: { warn(o: object, m: string): void },
): Promise<{ channels: number; push: boolean } | null> {
  const r = await write(ctx, async (c) => {
    const s = (await c.query<{ kind: string }>('select kind from livetv_sources where id = $1 for update', [id])).rows[0];
    if (!s) return null;
    const n = (await c.query<{ n: number; push: number }>(
      "select count(*)::int as n, count(*) filter (where ingest = 'push')::int as push from livetv_channels where source_id = $1", [id])).rows[0]!;
    const guide = isGuide(s.kind);
    if (guide) {
      await c.query(
        "update livetv_channels set epg_match = 'auto', epg_source_id = null, epg_channel_id = null, epg_logo_hash = null where epg_source_id = $1", [id]);
    }
    await c.query('delete from livetv_sources where id = $1', [id]);
    const scoped = (await c.query(
      `update livetv_sources set guide_scope = array_remove(guide_scope, $1::uuid),
         enabled = enabled and cardinality(array_remove(guide_scope, $1::uuid)) > 0, updated_at = now()
        where kind = $2 and $1::uuid = any(guide_scope)`, [id, GUIDE_KIND])).rowCount ?? 0;
    if (guide || scoped > 0) await matchIds(c);
    await auditInTx({ db: c }, actor, 'livetv.source.delete', id, { fields: [], channels: n.n });
    return { channels: n.n, push: n.push > 0, guide };
  });
  if (!r) return null;
  // the delete has committed: a file that cannot be removed is logged (by the error's name), never answered as a failed delete
  if (r.guide) {
    await removeGuideFiles(ctx, id).catch((e: unknown) => {
      log?.warn({ sourceId: id, error: e instanceof Error ? e.name : 'unknown' }, 'livetv guide files not removed');
    });
  }
  return { channels: r.channels, push: r.push };
}

// ---- Prüfen (spec §9.1) ----
export interface SourceTestAnswer {
  /** every live entry of the list (skipped groups and entries over the limit included) */
  channels: number;
  /** every group of a live entry with its count, in list order (F6), for the group picker */
  groups: Array<{ name: string; channels: number }>;
  /** the first five channel names */
  samples: string[];
  /** channels of the XMLTV file; null = no EPG URL, or the EPG could not be read (then `epgError`) */
  epgChannels: number | null;
  /** why the EPG could not be read (a fixed code), null otherwise; the list result stays usable */
  epgError: string | null;
}

/** what a test refused: a body refusal (400 with field) or a livetv/provider failure (`status` null = livetv not reached) */
export class SourceTestError extends Error {
  constructor(readonly status: number | null, readonly code: string) {
    super(code);
    this.name = 'SourceTestError';
  }
}

/** the M3U answer, read defensively (it is livetv's, but its names come from a provider) */
function readM3u(a: FetchM3uAnswer | undefined): Omit<SourceTestAnswer, 'epgChannels' | 'epgError'> {
  const objects = (xs: unknown[]) => xs.every((x) => typeof x === 'object' && x !== null);
  if (!a || typeof a !== 'object' || !Array.isArray(a.groups) || !Array.isArray(a.entries) || typeof a.listed !== 'number' || !objects(a.groups) || !objects(a.entries)) {
    throw new LivetvError(200, 'invalid_answer');
  }
  return {
    channels: a.listed,
    groups: a.groups.map((g) => ({ name: String(g.name), channels: Number(g.channels) || 0 })),
    samples: a.entries.slice(0, SAMPLES).map((e) => String(e.name)),
  };
}

/**
 * counts the channels of an XMLTV file: livetv streams NDJSON; programmes are left out by an empty time window. `samples` > 0 also
 * keeps the first display names (a provider's text: NUL stripped, at most 200 characters, the id when a channel has no name).
 */
async function epgChannels(ctx: Ctx, url: string, allowLan: boolean, userAgent: string | null, signal: AbortSignal, samples = 0): Promise<{ n: number; samples: string[] } | { error: string }> {
  try {
    const r = await livetvStream(ctx, '/v1/fetch/xmltv', { url, allowLan, ...(userAgent ? { userAgent } : {}), from: 0, to: 1 }, { timeoutMs: TEST_EPG_TIMEOUT_MS, signal });
    let text: string;
    try { text = await r.text(); } catch {
      if (!signal.aborted) dropLivetvProof(ctx); // not our own cancel: livetv may be gone
      return { error: 'timeout' };
    }
    let n = 0;
    const names: string[] = [];
    const clean = (v: unknown) => (typeof v === 'string' ? [...v.replace(/\u0000/g, '').trim()].slice(0, 200).join('') : '');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let j: { t?: unknown; code?: unknown; id?: unknown; names?: unknown };
      try { j = JSON.parse(line) as typeof j; } catch { return { error: 'invalid_answer' }; }
      if (j.t === 'channel') {
        n++;
        if (names.length < samples) {
          const name = (Array.isArray(j.names) ? j.names.map(clean).find((x) => x) : undefined) ?? clean(j.id);
          if (name) names.push(name);
        }
      } else if (j.t === 'end') return { n, samples: names };
      else if (j.t === 'error') return { error: typeof j.code === 'string' && /^[a-z_]{1,40}$/.test(j.code) ? j.code : 'invalid' };
    }
    return { error: 'incomplete' }; // a stream without its end line failed (Task 14 ruling)
  } catch (e) {
    if (e instanceof LivetvError) return { error: e.status === null ? 'livetv_unreachable' : e.code };
    throw e;
  }
}

/**
 * *Prüfen*: asks livetv (`/v1/fetch/m3u` without `skipGroups`, so every group is counted, and `/v1/fetch/xmltv` for the EPG URL) —
 * never the provider (spec §3.4). URLs pass the save-time check first. Refusals: `SourceRefusal` (400 with field), `SourceTestError`
 * (`status` null = livetv not reached, else the code livetv answered for the list), `not_found` for an unknown `sourceId`.
 */
export async function testSource(ctx: Ctx, b: SourceTestBody): Promise<SourceTestAnswer> {
  let stored: { url: string | null; epgUrl: string | null; userAgent: string | null } | null = null;
  if (b.sourceId) {
    const s = (await ctx.db.query<Pick<SourceRow, 'user_agent'>>('select user_agent from livetv_sources where id = $1', [b.sourceId])).rows[0];
    if (!s) throw new SourceTestError(404, 'not_found');
    stored = { ...(await sourceSecrets(ctx, b.sourceId)), userAgent: s.user_agent };
  }
  const url = b.url ?? stored?.url;
  if (!url) throw new SourceRefusal('invalid', 'url');
  const epgUrl = b.epgUrl !== undefined ? b.epgUrl : stored?.epgUrl ?? null;
  const ua = (b.userAgent !== undefined ? b.userAgent : stored?.userAgent ?? null) || null;
  checkUrl(url, b.allowLan, 'url');
  if (epgUrl !== null) checkUrl(epgUrl, b.allowLan, 'epgUrl');

  // a failed list ends the EPG count at once (livetv stops the provider download when the backend goes away)
  const cancel = new AbortController();
  const listed = livetvCall<FetchM3uAnswer>(ctx, 'POST', '/v1/fetch/m3u', { url, allowLan: b.allowLan, ...(ua ? { userAgent: ua } : {}) }, { timeoutMs: TEST_M3U_TIMEOUT_MS })
    // readM3u inside the chain: a malformed or empty 200 answer is a refusal (422 invalid_answer) like any other livetv error
    .then((a) => readM3u(a))
    .catch((e: unknown) => {
      cancel.abort();
      if (e instanceof LivetvError) throw new SourceTestError(e.status, e.code);
      throw e;
    });
  const [list, epg] = await Promise.all([listed, epgUrl === null ? Promise.resolve(null) : epgChannels(ctx, epgUrl, b.allowLan, ua, cancel.signal)]);
  return { ...list, epgChannels: epg && 'n' in epg ? epg.n : null, epgError: epg && 'error' in epg ? epg.error : null };
}

/** *Prüfen* of a guide: how many channels its XMLTV has, and the first few names */
export interface GuideTestAnswer { epgChannels: number; samples: string[] }

/**
 * *Prüfen* on a guide link, through livetv's `/v1/fetch/xmltv` (never the provider). A missing `epgUrl` with `sourceId` uses the stored
 * link. Refusals as testSource: `SourceRefusal` (400 with field), `SourceTestError` (null = livetv not reached, else the fixed code).
 */
export async function testGuide(ctx: Ctx, b: GuideTestBody): Promise<GuideTestAnswer> {
  let stored: { epgUrl: string | null; userAgent: string | null } | null = null;
  if (b.sourceId) {
    const s = (await ctx.db.query<Pick<SourceRow, 'user_agent'>>('select user_agent from livetv_sources where id = $1', [b.sourceId])).rows[0];
    if (!s) throw new SourceTestError(404, 'not_found');
    stored = { epgUrl: (await sourceSecrets(ctx, b.sourceId)).epgUrl, userAgent: s.user_agent };
  }
  const url = b.epgUrl ?? stored?.epgUrl;
  if (!url) throw new SourceRefusal('invalid', 'epgUrl');
  const ua = (b.userAgent !== undefined ? b.userAgent : stored?.userAgent ?? null) || null;
  checkUrl(url, b.allowLan, 'epgUrl');
  const r = await epgChannels(ctx, url, b.allowLan, ua, new AbortController().signal, GUIDE_SAMPLES);
  if ('error' in r) throw new SourceTestError(r.error === 'livetv_unreachable' ? null : 422, r.error);
  return { epgChannels: r.n, samples: r.samples };
}
