// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { auditInTx } from '../audit.js';
import { decrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import type { Db } from '../db.js';
import { CHANNEL_COLUMNS, CHANNEL_FROM, type EffectiveRow, type EpgShiftFrom, type Ingest, type ProbeRec, type StreamKind } from './channels.js';
import { LivetvError, livetvCall } from './client.js';
import { buildEpgIndex, matchChannel, nowNext, type Prog } from './epg.js';
import { sniffImage, storeLogo } from './logos.js';
// ownfeeds.ts imports adminChannel from here and this module calls srtPorts / syncIngest from there: neither is used at module load
import { srtPorts, syncIngest } from './ownfeeds.js';
import { livetvWrite } from './tx.js';
import type { ProbeResult, StreamInput } from './wire.js';

/**
 * Admin -> Live-TV -> *Kanäle* (spec §9.2, §10): the channel list with server paging, per-channel overrides (name, number, group,
 * visibility, EPG mapping, EPG offset), bulk actions, the *Reihenfolge* save, the stream test and own logos. Every write runs in one
 * transaction (tx.ts, which drops the cached channel sets afterwards), is audited `livetv.channel.*` with ids and field names only,
 * and a hide or show of a push feed sends livetv the new ingest set (syncIngest). No answer, audit entry, log line or error carries a
 * stream URL (F13): the stream test decrypts the URL only for the signed call to livetv.
 */

/** one channel as the admin sees it (web Task 23 re-declares it) */
export interface AdminChannel {
  id: string;
  number: number | null;
  name: string;
  groupId: string | null;
  sourceId: string;
  streamKind: StreamKind;
  ingest: Ingest;
  logoHash: string | null;
  hidden: boolean;
  missing: boolean;
  /** an EPG mapping is set */
  epg: boolean;
  /** F7: spec §10's Prog, the effective EPG offset applied (nowNext); null without a programme now */
  now: Prog | null;
  /** from the last stream test; null = not tested or the test failed */
  mode: 'passthrough' | 'remux' | 'transcode' | null;
  /** the fixed code of the last failed test */
  probeError: string | null;
  /** the import value of each overridden field ("geändert (Import: …)"); a key is present only while overridden */
  overridden: { name?: string; number?: number | null; group?: string | null; logo?: true };
  /** another channel that is not missing has the same number */
  dupNumber: boolean;
  epgShift: { min: number; from: EpgShiftFrom };
  /** push feeds only: never the stream id or the passphrase, only the hint ('ff-' + 6) */
  push?: { port: number; hint: string; portInRange: boolean };
}

/** a refusal answered as `status` with `body` (fixed codes; never an input value) */
export class ChannelRefusal extends Error {
  constructor(readonly status: number, readonly body: { error: string; field?: string }) {
    super(body.error);
    this.name = 'ChannelRefusal';
  }
}
const notFound = () => new ChannelRefusal(404, { error: 'not_found' });
const invalid = (field: string) => new ChannelRefusal(400, { error: 'invalid', field });

/** where a failed ingest sync is reported (codes only) */
type Log = { warn(o: object, m: string): void };

// ---- bodies ----
const uuid = z.guid();
/** spec §9.2 / ruling 42: −12 … +14 h in 30-minute steps */
const shiftMin = z.number().int().min(-720).max(840).refine((v) => v % 30 === 0);
export const MAX_BULK = 20_000;
export const MAX_BULK_TEST = 20;
/** the *Reihenfolge* view shows at most 500 rows (spec §9.2) */
export const MAX_ORDER = 500;

export const channelQuery = z.object({
  q: z.string().trim().max(100).optional(),
  source: uuid.optional(),
  group: z.union([uuid, z.literal('none')]).optional(),
  state: z.enum(['visible', 'hidden', 'missing']).optional(),
  epg: z.enum(['yes', 'no']).optional(),
  error: z.literal('1').optional(),
  sort: z.enum(['number', 'name', 'source']).default('number'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type ChannelQuery = z.output<typeof channelQuery>;

export const channelPatch = z.object({
  name: z.string().trim().min(1).max(60).nullable(),
  number: z.number().int().min(1).max(99_999).nullable(),
  groupId: uuid.nullable(),
  hidden: z.boolean(),
  /** false = no programme (`epg_match 'none'`); null (or true) = automatic matching again */
  epg: z.boolean().nullable(),
  epgShiftMin: shiftMin.nullable(),
}).partial().strict();
export type ChannelPatch = z.output<typeof channelPatch>;

export const bulkBody = z.object({
  ids: z.array(uuid).min(1).max(MAX_BULK),
  action: z.enum(['hide', 'show', 'group', 'renumber', 'reset', 'test']),
  groupId: uuid.nullable().optional(),
  from: z.number().int().min(1).max(99_999).optional(),
}).strict();
export type BulkBody = z.output<typeof bulkBody>;

export const orderBody = z.object({ ids: z.array(uuid).min(1).max(MAX_ORDER) }).strict();

// ---- reading ----

/** CHANNEL_COLUMNS plus what the admin view needs (import values, push facts, sort keys); never an encrypted column */
const ADMIN_COLUMNS = `${CHANNEL_COLUMNS}, c.import_name, c.import_number, c.name_override, c.number_override, c.group_override,
  (select m.group_id from livetv_group_map m where m.source_id = c.source_id and m.provider_group = c.import_group) as import_group_id,
  c.logo_override_hash, c.push_port, c.push_stream_id_hint, c.tvg_id, s.position as source_position, s.created_at as source_created`;
/** the effective rows as a relation `a`, so filters and sorting can use the aliases (CHANNEL_SELECT's note) */
const ADMIN_ROWS = `(select ${ADMIN_COLUMNS} from ${CHANNEL_FROM}) a`;
/**
 * the same with the duplicate-number flag: a window over every channel (before any filter, so a duplicate on another page counts too);
 * missing channels neither count nor are flagged
 */
const ADMIN_PAGE = `(select a.*, (a.number is not null and a.missing_since is null
    and count(*) filter (where a.missing_since is null) over (partition by a.number) > 1) as dup_number from ${ADMIN_ROWS}) a`;

type AdminRow = EffectiveRow & {
  import_name: string; import_number: number | null; name_override: string | null; number_override: number | null;
  group_override: string | null; import_group_id: string | null; logo_override_hash: string | null;
  push_port: number | null; push_stream_id_hint: string | null; dup_number: boolean;
};

/**
 * The push facts of one channel: the port, the stored hint ('ff-' + 6 characters, no ellipsis; the web adds "…") and whether the
 * port is in livetv's range (`ports` null = unknown: true, so an unreachable livetv does not offer *Neuen Port zuweisen*). Never the
 * stream id or the passphrase.
 */
export function pushInfo(port: number, hint: string | null, ports: readonly number[] | null): { port: number; hint: string; portInRange: boolean } {
  return { port, hint: hint ?? '', portInRange: ports === null || ports.includes(port) };
}

/** the rows of one page as AdminChannel: one nowNext call (F7) and, when a push feed is among them, one look at the port range */
async function toAdmin(ctx: Ctx, rows: AdminRow[]): Promise<AdminChannel[]> {
  if (rows.length === 0) return [];
  const nn = await nowNext(ctx, rows.map((r) => r.id));
  const ports = rows.some((r) => r.ingest === 'push' && r.push_port !== null) ? await srtPorts(ctx).catch(() => null) : null;
  return rows.map((r) => {
    const overridden: AdminChannel['overridden'] = {};
    if (r.name_override !== null) overridden.name = r.import_name;
    if (r.number_override !== null) overridden.number = r.import_number;
    if (r.group_override !== null) overridden.group = r.import_group_id;
    if (r.logo_override_hash !== null) overridden.logo = true;
    const probe: ProbeRec | null = r.probe;
    const out: AdminChannel = {
      id: r.id, number: r.number, name: r.name, groupId: r.group_id, sourceId: r.source_id, streamKind: r.stream_kind, ingest: r.ingest,
      logoHash: r.logo_hash, hidden: r.hidden, missing: r.missing_since !== null, epg: r.epg_source_id !== null && r.epg_channel_id !== null,
      now: nn.get(r.id)?.now ?? null,
      mode: probe?.ok ? (probe.needs ?? null) : null,
      probeError: probe && !probe.ok ? (probe.error ?? 'failed') : null,
      overridden, dupNumber: r.dup_number, epgShift: { min: r.epg_shift_min, from: r.epg_shift_from },
    };
    if (r.ingest === 'push' && r.push_port !== null) out.push = pushInfo(r.push_port, r.push_stream_id_hint, ports);
    return out;
  });
}

/** one channel as the admin sees it, or null (the PATCH answer, `GET /channels/:id`, the own-feeds answers) */
export async function adminChannel(ctx: Ctx, id: string): Promise<AdminChannel | null> {
  const rows = (await ctx.db.query<AdminRow>(`select * from ${ADMIN_PAGE} where a.id = $1`, [id])).rows;
  return (await toAdmin(ctx, rows))[0] ?? null;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** the `where` of a list query over the relation `a` (ADMIN_ROWS / ADMIN_PAGE) */
function listFilter(q: ChannelQuery): { where: string; args: unknown[] } {
  const conds: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (q.q) {
    const like = arg(`%${likeEscape(q.q)}%`);
    const num = /^\d{1,5}$/.test(q.q) ? arg(Number(q.q)) : null;
    conds.push(`(a.name ilike ${like} or a.tvg_id ilike ${like}${num ? ` or a.number = ${num}` : ''})`);
  }
  if (q.source) conds.push(`a.source_id = ${arg(q.source)}`);
  if (q.group === 'none') conds.push('a.group_id is null');
  else if (q.group) conds.push(`a.group_id = ${arg(q.group)}`);
  if (q.state === 'visible') conds.push('not a.hidden and a.missing_since is null');
  else if (q.state === 'hidden') conds.push('a.hidden and a.missing_since is null');
  else if (q.state === 'missing') conds.push('a.missing_since is not null');
  if (q.epg === 'yes') conds.push('a.epg_source_id is not null and a.epg_channel_id is not null');
  else if (q.epg === 'no') conds.push('(a.epg_source_id is null or a.epg_channel_id is null)');
  if (q.error) conds.push(`a.probe is not null and (a.probe->>'ok')::boolean is false`);
  return { where: conds.length ? `where ${conds.join(' and ')}` : '', args };
}

function listOrder(q: ChannelQuery): string {
  const d = q.dir === 'desc' ? 'desc' : 'asc';
  const tail = 'lower(a.name), a.id';
  if (q.sort === 'name') return `lower(a.name) ${d}, a.number nulls last, a.id`;
  if (q.sort === 'source') return `a.source_position ${d}, a.source_created ${d}, a.source_id ${d}, a.number nulls last, ${tail}`;
  return `a.number ${d} nulls last, ${tail}`;
}

/** `GET /api/admin/livetv/channels`: one page and the count of every channel the filters match */
export async function listChannels(ctx: Ctx, q: ChannelQuery): Promise<{ channels: AdminChannel[]; total: number }> {
  const f = listFilter(q);
  const n = f.args.length;
  const [count, page] = await Promise.all([
    ctx.db.query<{ n: number }>(`select count(*)::int as n from ${ADMIN_ROWS} ${f.where}`, f.args),
    ctx.db.query<AdminRow>(`select * from ${ADMIN_PAGE} ${f.where} order by ${listOrder(q)} limit $${n + 1} offset $${n + 2}`, [...f.args, q.limit, q.offset]),
  ]);
  return { channels: await toAdmin(ctx, page.rows), total: count.rows[0]!.n };
}

// ---- EPG matching of single channels ----

/**
 * The automatic match (epg.ts matchChannel, the four passes) for `ids` that are `epg_match = 'auto'`, inside the caller's transaction.
 * The index is the one autoMatch builds (the stored XMLTV channels of the sources that still have an EPG URL). A changed mapping drops
 * the EPG logo: the next EPG refresh fetches the one of the new XMLTV channel.
 */
async function rematch(c: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const idx = buildEpgIndex((await c.query<{ source_id: string; xml_id: string; names: string[] }>(
    `select e.source_id, e.xml_id, e.names from livetv_epg_channels e join livetv_sources s on s.id = e.source_id
      where s.epg_url_enc is not null`)).rows.map((r) => ({ sourceId: r.source_id, xmlId: r.xml_id, names: r.names })));
  const rows = (await c.query<{ id: string; source_id: string; tvg_id: string | null; tvg_name: string | null; import_name: string; epg_source_id: string | null; epg_channel_id: string | null }>(
    `select id, source_id, tvg_id, tvg_name, import_name, epg_source_id, epg_channel_id from livetv_channels
      where id = any($1::uuid[]) and epg_match = 'auto'`, [[...ids]])).rows;
  const changed: string[] = [];
  const srcs: Array<string | null> = [];
  const xmls: Array<string | null> = [];
  for (const r of rows) {
    const m = matchChannel({ sourceId: r.source_id, tvgId: r.tvg_id, tvgName: r.tvg_name, importName: r.import_name }, idx);
    const src = m?.sourceId ?? null;
    const xml = m?.xmlId ?? null;
    if (src === r.epg_source_id && xml === r.epg_channel_id) continue;
    changed.push(r.id);
    srcs.push(src);
    xmls.push(xml);
  }
  if (changed.length === 0) return;
  await c.query(
    `update livetv_channels c set epg_source_id = u.src, epg_channel_id = u.xml, epg_logo_hash = null
       from unnest($1::uuid[], $2::uuid[], $3::text[]) as u(id, src, xml) where c.id = u.id`, [changed, srcs, xmls]);
}

// ---- writing ----

const PATCH_FIELDS = ['name', 'number', 'groupId', 'hidden', 'epg', 'epgShiftMin'] as const;

async function groupKnown(c: Db, id: string): Promise<boolean> {
  return ((await c.query('select 1 from livetv_groups where id = $1', [id])).rowCount ?? 0) > 0;
}

/** does any of `ids` push (its hide / show changes livetv's ingest set)? */
async function anyPush(c: Db, ids: readonly string[]): Promise<boolean> {
  return ((await c.query("select 1 from livetv_channels where id = any($1::uuid[]) and ingest = 'push' limit 1", [[...ids]])).rowCount ?? 0) > 0;
}

/**
 * `PATCH /channels/:id`: overrides (`null` = back to the import value), visibility, the EPG mapping (`false` = none, `null`/`true` =
 * automatic again, matched at once) and the EPG offset (`null` = inherited). Answers the updated channel, whose `now` already uses the
 * new offset (F7); null = no such channel. ChannelRefusal 400 `groupId` for a group that does not exist.
 */
export async function patchChannel(ctx: Ctx, actor: string, id: string, p: ChannelPatch, log?: Log): Promise<AdminChannel | null> {
  const r = await livetvWrite(ctx, async (c) => {
    const cur = (await c.query<{ ingest: Ingest; hidden: boolean }>('select ingest, hidden from livetv_channels where id = $1 for update', [id])).rows[0];
    if (!cur) return null;
    if (p.groupId && !(await groupKnown(c, p.groupId))) throw invalid('groupId');
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (p.name !== undefined) set('name_override', p.name);
    if (p.number !== undefined) set('number_override', p.number);
    if (p.groupId !== undefined) set('group_override', p.groupId);
    if (p.hidden !== undefined) set('hidden', p.hidden);
    if (p.epgShiftMin !== undefined) set('epg_shift_override_min', p.epgShiftMin);
    if (p.epg === false) {
      set('epg_match', 'none');
      sets.push('epg_source_id = null', 'epg_channel_id = null', 'epg_logo_hash = null');
    } else if (p.epg !== undefined) {
      set('epg_match', 'auto');
    }
    if (sets.length === 0) return { sync: false };
    await c.query(`update livetv_channels set ${sets.join(', ')} where id = $1`, vals);
    if (p.epg === null || p.epg === true) await rematch(c, [id]);
    await auditInTx({ db: c }, actor, 'livetv.channel.update', id, { fields: PATCH_FIELDS.filter((k) => p[k] !== undefined) });
    return { sync: cur.ingest === 'push' && p.hidden !== undefined && p.hidden !== cur.hidden };
  });
  if (!r) return null;
  if (r.sync) await syncIngest(ctx, log);
  return adminChannel(ctx, id);
}

/** new numbers for `ids` in this order from `from` (number_override), inside the caller's transaction */
async function renumber(c: Db, ids: readonly string[], from: number): Promise<number> {
  if (from + ids.length - 1 > 99_999) throw invalid('from');
  return (await c.query(
    `update livetv_channels c set number_override = u.n from unnest($1::uuid[], $2::int[]) as u(id, n) where c.id = u.id`,
    [[...ids], ids.map((_, i) => from + i)])).rowCount ?? 0;
}

/**
 * The bulk bar (spec §9.2) except *Testen* (bulkTest): hide, show, group (`groupId`, null = back to the import group), renumber from
 * `from` in the current order (number, then name), reset (every override back to the import value and the EPG mapping automatic
 * again). Unknown ids are skipped. Answers how many channels it changed. A hide or show that touches a push feed syncs livetv.
 */
export async function bulkChannels(ctx: Ctx, actor: string, b: BulkBody, log?: Log): Promise<{ changed: number }> {
  const ids = [...new Set(b.ids)];
  if (b.action === 'group' && b.groupId === undefined) throw invalid('groupId');
  if (b.action === 'renumber' && b.from === undefined) throw invalid('from');
  const r = await livetvWrite(ctx, async (c) => {
    let changed = 0;
    let sync = false;
    if (b.action === 'hide' || b.action === 'show') {
      const hidden = b.action === 'hide';
      changed = (await c.query('update livetv_channels set hidden = $2 where id = any($1::uuid[]) and hidden <> $2', [ids, hidden])).rowCount ?? 0;
      sync = changed > 0 && (await anyPush(c, ids));
    } else if (b.action === 'group') {
      if (b.groupId && !(await groupKnown(c, b.groupId))) throw invalid('groupId');
      changed = (await c.query('update livetv_channels set group_override = $2 where id = any($1::uuid[])', [ids, b.groupId ?? null])).rowCount ?? 0;
    } else if (b.action === 'renumber') {
      const ordered = (await c.query<{ id: string }>(
        `select a.id from ${ADMIN_ROWS} where a.id = any($1::uuid[]) order by a.number nulls last, lower(a.name), a.id`, [ids])).rows.map((x) => x.id);
      changed = await renumber(c, ordered, b.from!);
    } else if (b.action === 'reset') {
      const wasNotAuto = (await c.query<{ id: string }>("select id from livetv_channels where id = any($1::uuid[]) and epg_match <> 'auto'", [ids])).rows.map((x) => x.id);
      changed = (await c.query(
        `update livetv_channels set name_override = null, number_override = null, group_override = null, logo_override_hash = null,
           epg_shift_override_min = null, epg_match = 'auto' where id = any($1::uuid[])`, [ids])).rowCount ?? 0;
      await rematch(c, wasNotAuto);
    }
    if (changed > 0) await auditInTx({ db: c }, actor, 'livetv.channel.bulk', undefined, { action: b.action, count: changed });
    return { changed, sync };
  });
  if (r.sync) await syncIngest(ctx, log);
  return { changed: r.changed };
}

/**
 * *Reihenfolge* → *Speichern* (`PUT /channels/order`): the channels get consecutive numbers in the given order, starting at the smallest
 * number among them (1 when none has one). ChannelRefusal 400 `ids` for a repeated or unknown id or numbers beyond 99 999.
 */
export async function orderChannels(ctx: Ctx, actor: string, ids: readonly string[]): Promise<{ from: number }> {
  if (new Set(ids).size !== ids.length) throw invalid('ids');
  return livetvWrite(ctx, async (c) => {
    const rows = (await c.query<{ id: string; number: number | null }>(
      `select a.id, a.number from ${ADMIN_ROWS} where a.id = any($1::uuid[])`, [[...ids]])).rows;
    if (rows.length !== ids.length) throw invalid('ids');
    const nums = rows.map((x) => x.number).filter((n): n is number => n !== null);
    const from = nums.length ? Math.min(...nums) : 1;
    if (from + ids.length - 1 > 99_999) throw invalid('ids');
    await renumber(c, ids, from);
    await auditInTx({ db: c }, actor, 'livetv.channel.order', undefined, { count: ids.length });
    return { from };
  });
}

// ---- logos (ruling 32) ----

export const LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 512 * 1024;

/**
 * *Eigenes Logo hochladen*: the raw body of a `content-type: image/png|jpeg|webp` request (≤ 512 KB, the route's limit), checked by its
 * magic bytes, which must agree with the declared type (ChannelRefusal 415 `unsupported_type`); stored in livetv_logos and set as the
 * channel's `logo_override_hash`. null = no such channel.
 */
export async function setLogo(ctx: Ctx, actor: string, id: string, declared: string, bytes: Buffer): Promise<AdminChannel | null> {
  const mime = sniffImage(bytes);
  if (mime === null || mime !== declared) throw new ChannelRefusal(415, { error: 'unsupported_type' });
  if (bytes.length > LOGO_MAX_BYTES) throw new ChannelRefusal(413, { error: 'too_large' });
  const found = await livetvWrite(ctx, async (c) => {
    if (!(await c.query('select 1 from livetv_channels where id = $1 for update', [id])).rowCount) return false;
    const hash = await storeLogo(c, mime, bytes);
    await c.query('update livetv_channels set logo_override_hash = $2 where id = $1', [id, hash]);
    await auditInTx({ db: c }, actor, 'livetv.channel.logo', id, { fields: ['logo'] });
    return true;
  });
  return found ? adminChannel(ctx, id) : null;
}

/** back to the imported logo; null = no such channel */
export async function dropLogo(ctx: Ctx, actor: string, id: string): Promise<AdminChannel | null> {
  const found = await livetvWrite(ctx, async (c) => {
    const cur = (await c.query<{ logo_override_hash: string | null }>('select logo_override_hash from livetv_channels where id = $1 for update', [id])).rows[0];
    if (!cur) return false;
    if (cur.logo_override_hash !== null) {
      await c.query('update livetv_channels set logo_override_hash = null where id = $1', [id]);
      await auditInTx({ db: c }, actor, 'livetv.channel.logo', id, { fields: ['logo'] });
    }
    return true;
  });
  return found ? adminChannel(ctx, id) : null;
}

// ---- the stream test (spec §9.2, ruling 15: probe facts only in Phase 1) ----

/** livetv's own budget is 10 s (livetv/src/probe.ts PROBE_BUDGET_MS); the backend waits a little longer so livetv answers the code */
const PROBE_TIMEOUT_MS = 15_000;
const CODE_RE = /^[a-z_]{1,40}$/;

export interface TestAnswer {
  ok: boolean;
  video: NonNullable<ProbeResult['video']> | null;
  audio: NonNullable<ProbeResult['audio']> | null;
  needs: ProbeResult['needs'] | null;
  error?: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const shortText = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 40;

/** livetv's `/v1/probe` answer, read defensively; null = an unexpected shape */
function parseProbe(raw: unknown): ProbeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ok !== 'boolean' || (r.needs !== 'passthrough' && r.needs !== 'remux' && r.needs !== 'transcode')) return null;
  const out: ProbeResult = { ok: r.ok, needs: r.needs };
  const v = r.video as Record<string, unknown> | undefined;
  if (v !== undefined) {
    if (!v || !shortText(v.codec) || !finite(v.width) || !finite(v.height) || !finite(v.fps)) return null;
    out.video = { codec: v.codec, width: v.width, height: v.height, fps: v.fps };
  }
  const a = r.audio as Record<string, unknown> | undefined;
  if (a !== undefined) {
    if (!a || !shortText(a.codec) || !finite(a.channels)) return null;
    out.audio = { codec: a.codec, channels: a.channels };
  }
  // a code a newer livetv adds is kept as long as it looks like one; never free text
  if (r.error !== undefined) out.error = (typeof r.error === 'string' && CODE_RE.test(r.error) ? r.error : 'invalid') as ProbeResult['error'];
  return out;
}

/**
 * *Testen* (`POST /channels/:id/test`): livetv probes the channel (`/v1/probe` with the decrypted input; a push feed by its channel id)
 * and the result is stored as `probe = { at, ok, video, audio, needs, error? }` (`needs` null when it failed). Admin only: it checks
 * that the channel exists and that its source is enabled, never the viewing rights or the group's release (F10), so the channels of a
 * new, unreleased group can be tested. ChannelRefusal 404 / 409 `source_disabled` / 503 `livetv_unreachable` / 502 `livetv_error`.
 */
export async function testChannel(ctx: Ctx, actor: string, id: string): Promise<TestAnswer> {
  const r = (await ctx.db.query<{ ingest: Ingest; stream_kind: StreamKind; stream_url_enc: string | null; allow_lan: boolean | null; enabled: boolean; source_lan: boolean; user_agent: string | null }>(
    `select c.ingest, c.stream_kind, c.stream_url_enc, c.allow_lan, s.enabled, s.allow_lan as source_lan, s.user_agent
       from livetv_channels c join livetv_sources s on s.id = c.source_id where c.id = $1`, [id])).rows[0];
  if (!r) throw notFound();
  if (!r.enabled) throw new ChannelRefusal(409, { error: 'source_disabled' });
  let input: StreamInput;
  if (r.ingest === 'push' || r.stream_url_enc === null) input = { push: id };
  else {
    input = { url: decrypt(ctx.encKey, r.stream_url_enc), kind: r.stream_kind, allowLan: r.allow_lan ?? r.source_lan };
    if (r.user_agent) input.userAgent = r.user_agent;
  }
  let raw: unknown;
  try {
    raw = await livetvCall<unknown>(ctx, 'POST', '/v1/probe', { input }, { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof LivetvError) throw new ChannelRefusal(e.status === null ? 503 : 502, { error: e.status === null ? 'livetv_unreachable' : 'livetv_error' });
    throw e;
  }
  const p = parseProbe(raw);
  if (!p) throw new ChannelRefusal(502, { error: 'livetv_error' });
  const rec: ProbeRec = {
    at: new Date().toISOString(), ok: p.ok, ...(p.video ? { video: p.video } : {}), ...(p.audio ? { audio: p.audio } : {}),
    needs: p.ok ? p.needs : null, ...(p.error && !p.ok ? { error: p.error } : {}),
  };
  const stored = await livetvWrite(ctx, async (c) => {
    if (!(await c.query('update livetv_channels set probe = $2 where id = $1', [id, JSON.stringify(rec)])).rowCount) return false;
    await auditInTx({ db: c }, actor, 'livetv.channel.test', id, { fields: ['probe'] });
    return true;
  });
  if (!stored) throw notFound(); // deleted while livetv probed it
  return { ok: rec.ok, video: rec.video ?? null, audio: rec.audio ?? null, needs: rec.needs, ...(rec.error ? { error: rec.error } : {}) };
}

/**
 * *Testen* in the bulk bar: at most 20 channels, one after another. A channel that cannot be tested gets its fixed code; once livetv
 * was not reached, the rest are not tried (each would wait for the same timeout).
 */
export async function bulkTest(ctx: Ctx, actor: string, ids: readonly string[]): Promise<{ results: Array<{ id: string; ok: boolean; needs?: string; error?: string }> }> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK_TEST) throw invalid('ids');
  const results: Array<{ id: string; ok: boolean; needs?: string; error?: string }> = [];
  let down = false;
  for (const id of unique) {
    if (down) { results.push({ id, ok: false, error: 'livetv_unreachable' }); continue; }
    try {
      const t = await testChannel(ctx, actor, id);
      results.push(t.ok ? { id, ok: true, needs: t.needs! } : { id, ok: false, error: t.error ?? 'failed' });
    } catch (e) {
      if (!(e instanceof ChannelRefusal)) throw e;
      results.push({ id, ok: false, error: e.body.error });
      down = e.body.error === 'livetv_unreachable';
    }
  }
  return { results };
}
