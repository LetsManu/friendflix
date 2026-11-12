// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { auditInTx } from '../audit.js';
import { decrypt, encrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import { CHANNEL_COLUMNS, CHANNEL_FROM, OWN_FEEDS_KIND, isOwnFeeds, srtHost, type EffectiveRow, type EpgShiftFrom, type Ingest, type ProbeRec, type StreamKind } from './channels.js';
import { LivetvError, livetvCall } from './client.js';
import { pushEvent } from './events.js';
import { invalidateLivetvRights } from './rights.js';
import { checkSourceUrl, type SourceUrlCode } from './urls.js';
import type { LivetvSystem } from './wire.js';

/**
 * Own feeds (spec §3.5, §9.1): channels the admin adds by hand to the *Eigene Streams* source (stored kind 'manual' = OWN_FEEDS_KIND,
 * 'feeds' on the wire, F16), created on first use. A feed is pulled (an HLS / MPEG-TS / SRT-caller URL, checked like a provider URL
 * and stored encrypted) or pushed: an encoder sends SRT to one UDP port of LIVETV_SRT_PORTS (the lowest free one), with a generated
 * stream id and passphrase (both stored encrypted, shown once). livetv learns the complete push set through `PUT /v1/ingest`
 * (`syncIngest`), sent after every push change.
 *
 * Credentials (stream id, passphrase) and pull URLs are secrets (F13): never logged, never in audit meta (field names only), never in
 * an error text, never answered except in the one-time push result. Every write runs in one transaction under one advisory lock (the
 * port choice and the first-use source creation cannot race) and drops the cached channel sets afterwards.
 */

/** the stored name of the own-feeds source; the web shows it through i18n by kind (F16) */
export const OWN_FEEDS_NAME = 'Eigene Streams';
/** `/v1/system.srt.ports` is read at most once a minute (plan Task 20) */
const PORTS_MEMO_MS = 60_000;
const PORTS_TIMEOUT_MS = 3_000;
const INGEST_TIMEOUT_MS = 10_000;
const LOCK_KEY = 'livetv:ownfeeds';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PULL_SCHEMES: Array<'http:' | 'https:' | 'srt:'> = ['http:', 'https:', 'srt:'];
/** where a failed ingest sync is reported (the request log; codes only) */
type Log = { warn(o: object, m: string): void };

// ---- bodies (spec §9.1 *Stream hinzufügen*) ----
const name = z.string().trim().min(1).max(60);
const number = z.number().int().min(1).max(99_999).nullable().default(null);
const groupId = z.guid().nullable().default(null);
export const feedCreate = z.discriminatedUnion('ingest', [
  z.object({
    ingest: z.literal('pull'), name, url: z.string().trim().min(1).max(2048), kind: z.enum(['hls', 'ts', 'srt']).optional(), number, groupId,
    allowLan: z.boolean().default(false),
  }).strict(),
  z.object({ ingest: z.literal('push'), name, number, groupId }).strict(),
]);
export type FeedBody = z.output<typeof feedCreate>;

/** a refusal answered as `status` with `body` (fixed codes; never an input value) */
export class FeedError extends Error {
  constructor(readonly status: number, readonly body: { error: string; field?: string; n?: number }) {
    super(body.error);
    this.name = 'FeedError';
  }
}
const notFound = () => new FeedError(404, { error: 'not_found' });
const unreachable = () => new FeedError(503, { error: 'livetv_unreachable' });

// ---- the admin view of one channel (Task 19's AdminChannel shape) ----
export interface Prog { title: string; start: string; end: string; subtitle?: string }
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
  epg: boolean;
  now: Prog | null;
  mode: 'passthrough' | 'remux' | 'transcode' | null;
  probeError: string | null;
  overridden: { name?: string; number?: number | null; group?: string | null; logo?: true };
  dupNumber: boolean;
  epgShift: { min: number; from: EpgShiftFrom };
  /** push feeds only: never the stream id or the passphrase, only the hint ('ff-' + 6) */
  push?: { port: number; hint: string; portInRange: boolean };
}

/** the one-time push result (spec §3.5): host null while neither LIVETV_SRT_HOST nor PUBLIC_URL is known (then no URL either) */
export interface PushCredentials { host: string | null; port: number; streamId: string; passphrase: string; url: string | null }

type AdminRow = EffectiveRow & {
  import_name: string; import_number: number | null; name_override: string | null; number_override: number | null;
  group_override: string | null; import_group_id: string | null; logo_override_hash: string | null;
  push_port: number | null; push_stream_id_hint: string | null; dup_number: boolean;
};

/**
 * One channel as the admin sees it, or null. Task 19 builds the list and owns AdminChannel; this reads a single row the same way.
 * `now` stays null here (the EPG now line comes with Task 17's nowNext through Task 19). `portInRange` is true while the range is unknown.
 */
export async function adminChannel(ctx: Ctx, id: string): Promise<AdminChannel | null> {
  const r = (await ctx.db.query<AdminRow>(
    `select ${CHANNEL_COLUMNS}, c.import_name, c.import_number, c.name_override, c.number_override, c.group_override,
       (select m.group_id from livetv_group_map m where m.source_id = c.source_id and m.provider_group = c.import_group) as import_group_id,
       c.logo_override_hash, c.push_port, c.push_stream_id_hint,
       exists (select 1 from livetv_channels o where o.id <> c.id and o.missing_since is null
                 and coalesce(o.number_override, o.import_number) = coalesce(c.number_override, c.import_number)) as dup_number
     from ${CHANNEL_FROM} where c.id = $1`, [id])).rows[0];
  if (!r) return null;
  const overridden: AdminChannel['overridden'] = {};
  if (r.name_override !== null) overridden.name = r.import_name;
  if (r.number_override !== null) overridden.number = r.import_number;
  if (r.group_override !== null) overridden.group = r.import_group_id;
  if (r.logo_override_hash !== null) overridden.logo = true;
  const probe: ProbeRec | null = r.probe;
  const out: AdminChannel = {
    id: r.id, number: r.number, name: r.name, groupId: r.group_id, sourceId: r.source_id, streamKind: r.stream_kind, ingest: r.ingest,
    logoHash: r.logo_hash, hidden: r.hidden, missing: r.missing_since !== null, epg: r.epg_source_id !== null && r.epg_channel_id !== null,
    now: null, mode: probe?.needs ?? null, probeError: probe && !probe.ok ? (probe.error ?? 'failed') : null, overridden,
    dupNumber: r.number !== null && r.dup_number, epgShift: { min: r.epg_shift_min, from: r.epg_shift_from },
  };
  if (r.ingest === 'push' && r.push_port !== null) out.push = pushInfo(r.push_port, r.push_stream_id_hint, await srtPorts(ctx).catch(() => null));
  return out;
}

/**
 * The push facts of one channel for any admin answer (Task 19's list puts them on each own-feed row): the port, the stored hint
 * ('ff-' + 6 characters, no ellipsis; the web adds "…") and whether the port is in livetv's range (`ports` null = unknown: true, so
 * an unreachable livetv does not offer *Neuen Port zuweisen*). Never the stream id or the passphrase.
 */
export function pushInfo(port: number, hint: string | null, ports: readonly number[] | null): { port: number; hint: string; portInRange: boolean } {
  return { port, hint: hint ?? '', portInRange: ports === null || ports.includes(port) };
}

// ---- the port range (livetv's parsed LIVETV_SRT_PORTS) ----
const portsMemo = new WeakMap<object, { at: number; ports: number[] }>();

/** forgets the cached range (tests; a changed range is otherwise noticed within a minute) */
export function forgetSrtPorts(ctx: Ctx): void {
  portsMemo.delete(ctx);
}

/** `/v1/system.srt.ports`, sorted and deduplicated, cached 60 s; livetv not answering = FeedError 503 `livetv_unreachable` (not cached) */
export async function srtPorts(ctx: Ctx): Promise<number[]> {
  const hit = portsMemo.get(ctx);
  if (hit && Date.now() - hit.at < PORTS_MEMO_MS) return hit.ports;
  let raw: Partial<LivetvSystem> | null | undefined;
  try {
    raw = await livetvCall<Partial<LivetvSystem> | null>(ctx, 'GET', '/v1/system', undefined, { timeoutMs: PORTS_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof LivetvError) throw unreachable();
    throw e;
  }
  const list = raw?.srt?.ports;
  if (!Array.isArray(list)) throw unreachable();
  const ports = [...new Set(list.filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= 65_535))].sort((a, b) => a - b).slice(0, 1000);
  portsMemo.set(ctx, { at: Date.now(), ports });
  return ports;
}

/** the lowest port of the range no other push feed holds; FeedError 409 `srt_ports_full` with the range size */
async function freePort(c: pg.PoolClient, ports: readonly number[], except: string | null): Promise<number> {
  const used = new Set((await c.query<{ p: number }>(
    'select push_port as p from livetv_channels where push_port is not null and ($1::uuid is null or id <> $1)', [except])).rows.map((r) => r.p));
  const port = ports.find((p) => !used.has(p));
  if (port === undefined) throw new FeedError(409, { error: 'srt_ports_full', n: ports.length });
  return port;
}

// ---- credentials (spec §3.5) ----
/** `ff-` + 16 base32 characters (A–Z, 2–7; 256 is a multiple of 32, so every character is uniform) */
function newStreamId(): string {
  return `ff-${[...randomBytes(16)].map((b) => BASE32[b & 31]).join('')}`;
}
/** 32 base64url characters (24 random bytes; SRT AES-256, pbkeylen 32) */
const newPassphrase = (): string => randomBytes(24).toString('base64url');
/** ruling 35: `ff-` + the first 6 random characters */
const hintOf = (streamId: string): string => streamId.slice(0, 9);

function credentials(ctx: Ctx, port: number, streamId: string, passphrase: string): PushCredentials {
  const host = srtHost(ctx);
  const url = host === null ? null : `srt://${host}:${port}?streamid=${streamId}&passphrase=${passphrase}&pbkeylen=32&mode=caller&latency=200000`;
  return { host, port, streamId, passphrase, url };
}

// ---- writing ----
/** one transaction under the own-feeds lock; the cached channel sets are dropped afterwards (also after a rollback: harmless) */
async function write<T>(ctx: Pick<Ctx, 'db'>, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    invalidateLivetvRights();
  }
}

/** the *Eigene Streams* source, created on first use (no URL: the refresh and EPG ticks skip it) */
async function ownSource(c: pg.PoolClient, actor: string): Promise<string> {
  const found = (await c.query<{ id: string }>('select id from livetv_sources where kind = $1 order by created_at, id limit 1', [OWN_FEEDS_KIND])).rows[0];
  if (found) return found.id;
  const id = randomUUID();
  await c.query(
    `insert into livetv_sources(id, kind, name, position) values ($1, $2, $3, (select coalesce(max(position) + 1, 0) from livetv_sources))`,
    [id, OWN_FEEDS_KIND, OWN_FEEDS_NAME]);
  await auditInTx({ db: c }, actor, 'livetv.source.create', id, { fields: [], kind: 'feeds' });
  return id;
}

/** the pull URL check (spec §3.4, `srt:` allowed) as a fixed refusal on `url` */
function checkPullUrl(raw: string, allowLan: boolean): URL {
  const r = checkSourceUrl(raw, { allowLan, schemes: PULL_SCHEMES });
  if (!r.ok) {
    const code: Record<SourceUrlCode, string> = { invalid: 'invalid', scheme: 'invalid', host: 'refused', lan_required: 'lan_required', refused: 'refused' };
    throw new FeedError(400, { error: code[r.code], field: 'url' });
  }
  return new URL(raw);
}

/** the stream kind of a pull URL: `srt:` is SRT (caller), a path ending in `.ts` MPEG-TS, anything else HLS (the admin may correct it) */
export function detectKind(url: URL): StreamKind {
  if (url.protocol === 'srt:') return 'srt';
  return /\.ts$/i.test(url.pathname) ? 'ts' : 'hls';
}

const FIELD_ORDER = ['name', 'url', 'kind', 'number', 'groupId', 'allowLan'] as const;
const named = (b: object) => FIELD_ORDER.filter((k) => k in b && (b as Record<string, unknown>)[k] !== undefined && (b as Record<string, unknown>)[k] !== null);

/**
 * *Stream hinzufügen*: a pull or push feed in the own-feeds source. A push feed gets the lowest free port of the range and new
 * credentials; the answer carries them once. Refusals are FeedError (400 with field, 409 `srt_ports_full`, 503 `livetv_unreachable`).
 */
export async function createFeed(ctx: Ctx, actor: string, b: FeedBody, log?: Log): Promise<{ channel: AdminChannel; push?: PushCredentials }> {
  let kind: StreamKind = 'srt';
  if (b.ingest === 'pull') {
    const url = checkPullUrl(b.url, b.allowLan);
    const found = detectKind(url);
    // an SRT URL is always SRT, and SRT always needs an srt: URL
    if (b.kind !== undefined && (b.kind === 'srt') !== (found === 'srt')) throw new FeedError(400, { error: 'invalid', field: 'kind' });
    kind = b.kind ?? found;
  }
  // the range is asked before the transaction (a network call never holds the lock)
  const ports = b.ingest === 'push' ? await srtPorts(ctx) : [];
  const id = randomUUID();
  const push = await write(ctx, async (c) => {
    if (b.groupId !== null && !(await c.query('select 1 from livetv_groups where id = $1', [b.groupId])).rowCount) {
      throw new FeedError(400, { error: 'invalid', field: 'groupId' });
    }
    const sourceId = await ownSource(c, actor);
    const cols = 'id, source_id, source_key, stream_kind, ingest, import_name, import_number, group_override';
    const base = [id, sourceId, id, kind, b.ingest, b.name, b.number, b.groupId];
    let creds: { port: number; streamId: string; passphrase: string } | undefined;
    if (b.ingest === 'pull') {
      await c.query(`insert into livetv_channels(${cols}, stream_url_enc, allow_lan) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [...base, encrypt(ctx.encKey, b.url), b.allowLan]);
    } else {
      creds = { port: await freePort(c, ports, null), streamId: newStreamId(), passphrase: newPassphrase() };
      await c.query(
        `insert into livetv_channels(${cols}, push_port, push_stream_id_enc, push_stream_id_hint, push_passphrase_enc)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [...base, creds.port, encrypt(ctx.encKey, creds.streamId), hintOf(creds.streamId), encrypt(ctx.encKey, creds.passphrase)]);
    }
    await auditInTx({ db: c }, actor, 'livetv.channel.create', id, { fields: named(b), ingest: b.ingest });
    return creds;
  });
  if (push) await syncIngest(ctx, log);
  const channel = (await adminChannel(ctx, id))!;
  return push ? { channel, push: credentials(ctx, push.port, push.streamId, push.passphrase) } : { channel };
}

/** the channel row the push routes need, locked; FeedError 404 (none) / 409 `not_push` (a pull or provider channel) */
async function pushRow(c: pg.PoolClient, id: string): Promise<{ push_port: number }> {
  const r = (await c.query<{ ingest: Ingest; push_port: number | null }>('select ingest, push_port from livetv_channels where id = $1 for update', [id])).rows[0];
  if (!r) throw notFound();
  if (r.ingest !== 'push' || r.push_port === null) throw new FeedError(409, { error: 'not_push' });
  return { push_port: r.push_port };
}

/** *Zugangsdaten neu erzeugen*: a new stream id and passphrase on the same port (the old ones stop working with the sync) */
export async function regenerateCredentials(ctx: Ctx, actor: string, id: string, log?: Log): Promise<{ channel: AdminChannel; push: PushCredentials }> {
  const creds = await write(ctx, async (c) => {
    const r = await pushRow(c, id);
    const next = { port: r.push_port, streamId: newStreamId(), passphrase: newPassphrase() };
    await c.query('update livetv_channels set push_stream_id_enc = $2, push_stream_id_hint = $3, push_passphrase_enc = $4 where id = $1',
      [id, encrypt(ctx.encKey, next.streamId), hintOf(next.streamId), encrypt(ctx.encKey, next.passphrase)]);
    await auditInTx({ db: c }, actor, 'livetv.channel.credentials', id, { fields: ['streamId', 'passphrase'] });
    return next;
  });
  await syncIngest(ctx, log);
  return { channel: (await adminChannel(ctx, id))!, push: credentials(ctx, creds.port, creds.streamId, creds.passphrase) };
}

/** *Neuen Port zuweisen* (spec §19): the lowest free port of the current range; the credentials stay */
export async function reassignPort(ctx: Ctx, actor: string, id: string, log?: Log): Promise<{ port: number }> {
  const ports = await srtPorts(ctx);
  const port = await write(ctx, async (c) => {
    await pushRow(c, id);
    const p = await freePort(c, ports, id);
    await c.query('update livetv_channels set push_port = $2 where id = $1', [id, p]);
    await auditInTx({ db: c }, actor, 'livetv.channel.port', id, { fields: ['port'] });
    return p;
  });
  await syncIngest(ctx, log);
  return { port };
}

/** deletes a channel of the own-feeds source (a push feed frees its port); FeedError 404 / 409 `not_own_feed` (provider channels) */
export async function deleteFeed(ctx: Ctx, actor: string, id: string, log?: Log): Promise<void> {
  const ingest = await write(ctx, async (c) => {
    const r = (await c.query<{ ingest: Ingest; kind: string }>(
      'select c.ingest, s.kind from livetv_channels c join livetv_sources s on s.id = c.source_id where c.id = $1 for update of c', [id])).rows[0];
    if (!r) throw notFound();
    if (!isOwnFeeds(r.kind)) throw new FeedError(409, { error: 'not_own_feed' });
    await c.query('delete from livetv_channels where id = $1', [id]);
    await auditInTx({ db: c }, actor, 'livetv.channel.delete', id, { fields: [], ingest: r.ingest });
    return r.ingest;
  });
  if (ingest === 'push') await syncIngest(ctx, log);
}

// ---- ingest sync (spec §3.2 `PUT /v1/ingest`) ----
const syncChains = new WeakMap<object, Promise<unknown>>();

/**
 * Sends livetv the complete set of push feeds whose port is in the range (`PUT /v1/ingest`). Syncs run one at a time per backend, and
 * each reads the feeds when it runs, so the last one sent carries the newest state. `pending` = livetv has no ingest endpoint yet
 * (404, ruling 24; one `ingest_sync_pending` event), `failed` = livetv not reached or refused (logged to `log` with the code only). Never throws.
 */
export function syncIngest(ctx: Ctx, log?: Log): Promise<'ok' | 'pending' | 'failed'> {
  const prev = syncChains.get(ctx) ?? Promise.resolve();
  const run = prev.then(() => sendIngest(ctx, log), () => sendIngest(ctx, log));
  syncChains.set(ctx, run.catch(() => undefined));
  return run;
}

async function sendIngest(ctx: Ctx, log: Log | undefined): Promise<'ok' | 'pending' | 'failed'> {
  try {
    const ports = new Set(await srtPorts(ctx));
    const rows = (await ctx.db.query<{ id: string; push_port: number; push_stream_id_enc: string; push_passphrase_enc: string }>(
      `select id, push_port, push_stream_id_enc, push_passphrase_enc from livetv_channels
        where ingest = 'push' and push_port is not null order by push_port`)).rows;
    const feeds = rows.filter((r) => ports.has(r.push_port)).map((r) => ({
      channelId: r.id, port: r.push_port, streamId: decrypt(ctx.encKey, r.push_stream_id_enc), passphrase: decrypt(ctx.encKey, r.push_passphrase_enc),
    }));
    await livetvCall(ctx, 'PUT', '/v1/ingest', { feeds }, { timeoutMs: INGEST_TIMEOUT_MS });
    return 'ok';
  } catch (e) {
    if (e instanceof LivetvError && e.status === 404) {
      await pushEvent(ctx, { level: 'info', code: 'ingest_sync_pending' }).catch(() => undefined);
      return 'pending';
    }
    // only a fixed code: the request body holds credentials and must never reach a log
    const code = e instanceof LivetvError ? e.code : e instanceof FeedError ? e.body.error : 'error';
    log?.warn({ code }, 'livetv ingest sync failed');
    return 'failed';
  }
}

// ---- the *Eigene Streams* card (spec §9.1): host, range and the state of each push feed ----

/**
 * The state of a push feed on the card: `receiving` / `idle` as livetv reports it (`GET /v1/ingest`), `pending` = livetv does not know
 * the feed yet (no ingest endpoint before PR 1d, ruling 24, or not synced yet), `out_of_range` = its port left LIVETV_SRT_PORTS
 * (*Neuen Port zuweisen*), `error` = livetv not reached or an unexpected answer.
 */
export type FeedState = 'receiving' | 'idle' | 'pending' | 'out_of_range' | 'error';
export interface IngestView {
  /** srtHost: null before PUBLIC_URL / LIVETV_SRT_HOST are known */
  host: string | null;
  /** lowest and highest port of the range; null while livetv cannot tell or the range is empty */
  ports: { from: number; to: number } | null;
  feeds: Array<{ channelId: string; state: FeedState; rejected1h: number }>;
}
const INGEST_VIEW_TIMEOUT_MS = 3_000;

/** what `GET /v1/ingest` says per channel, read defensively (Task 26 declares IngestState in wire.ts) */
async function ingestStates(ctx: Ctx): Promise<Map<string, { receiving: boolean; rejected1h: number }> | 'pending' | 'error'> {
  let raw: unknown;
  try {
    raw = await livetvCall<unknown>(ctx, 'GET', '/v1/ingest', undefined, { timeoutMs: INGEST_VIEW_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof LivetvError) return e.status === 404 ? 'pending' : 'error';
    throw e;
  }
  if (!Array.isArray(raw)) return 'error';
  const out = new Map<string, { receiving: boolean; rejected1h: number }>();
  for (const x of raw as Array<Record<string, unknown> | null>) {
    if (!x || typeof x.channelId !== 'string') continue;
    const n = Number(x.rejected1h);
    out.set(x.channelId, { receiving: x.state === 'receiving', rejected1h: Number.isInteger(n) && n > 0 ? Math.min(n, 1_000_000) : 0 });
  }
  return out;
}

/** `GET /api/admin/livetv/ingest`: never a stream id, passphrase or peer address (livetv does not report them either) */
export async function ingestView(ctx: Ctx): Promise<IngestView> {
  const rows = (await ctx.db.query<{ id: string; push_port: number }>(
    "select id, push_port from livetv_channels where ingest = 'push' and push_port is not null order by push_port")).rows;
  const ports = await srtPorts(ctx).catch(() => null);
  const live = rows.length ? await ingestStates(ctx) : 'pending';
  const feeds = rows.map((r) => {
    const item = typeof live === 'string' ? undefined : live.get(r.id);
    let state: FeedState;
    if (ports !== null && !ports.includes(r.push_port)) state = 'out_of_range';
    else if (live === 'error' || ports === null) state = 'error';
    else if (live === 'pending' || !item) state = 'pending';
    else state = item.receiving ? 'receiving' : 'idle';
    return { channelId: r.id, state, rejected1h: item?.rejected1h ?? 0 };
  });
  return { host: srtHost(ctx), ports: ports?.length ? { from: ports[0]!, to: ports[ports.length - 1]! } : null, feeds };
}
