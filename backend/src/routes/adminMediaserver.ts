// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadable } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { addressOnly } from '../media/address.js';
import { MediaSetupError } from '../media/types.js';
import { BACKUP_ID, decodePassphrase, mediaDownload, mediaOp, mediaScan, mediaUpload, parseMediaStatus, startMediaJob, type MediaBackup, type MediaStatus } from '../mediaserver/client.js';
import { recordApplyFirstRun } from '../mediaserver/firstRun.js';
import { ACTIVE_PHASES, freshScan, goBack, readScan, scanRunning, startScan, SWITCHED_PHASES, type MoveScanRecord } from '../mediaserver/move.js';
import { libraryReferences, referenced } from '../mediaserver/references.js';
import { deleteLibrary, managedKey, MANAGED_URL, publicInfo, renameLibrary } from '../mediaserver/serverApi.js';
import { adminPassword, claimAdminPassword, externalKey, idsInUse, readManaged, slugFor, writeManaged, type Kind, type LibraryEntry, type ManagedPatch, type MediaManaged, type MigratedFrom, type MoveRecord, type SetupStep } from '../mediaserver/store.js';
import { recentlyAuthenticated } from '../reauth.js';
import { requireAdmin } from '../session.js';
import { requireSetupSession } from '../setup/code.js';
import { PENDING, startedJob, updaterView, type MediaStep, type StartResult, type UpdaterView } from '../updater.js';

/**
 * Admin -> Einstellungen -> Medienserver and the wizard's media step (spec "Backend routes"): the managed media server through the
 * updater's POST /v1/mediaserver (mediaserver/client.ts). Admin routes need an admin session, the ones that change which host data a
 * container reads, delete data or switch servers also a recent re-authentication; the setup routes run the same handlers under the
 * setup session (actor null, no re-authentication). Answers carry codes only, never updater, Docker or server text; the base code,
 * the generated admin password and API keys never reach an answer, an audit row or a log.
 */

export type OfferReason = 'no_updater' | 'plex' | 'url_pinned' | 'ids_in_use' | 'engine_old' | 'proxy_outdated' | 'no_project' | 'no_network' | 'updater_outdated' | 'starting';
/**
 * The move from the external Jellyfin (stage 2): `offered` exactly while FriendFlix uses an external Jellyfin whose ids its data depends
 * on, the connection is not pinned in .env and the updater can run the media server; `reason` why it cannot (null: nothing keeps it from
 * being offered, or there is nothing to move: no linked ids, a managed server, Plex's own stage); `state` the move as the backend follows
 * it (with the step and abort flag of the updater's job); `migratedFrom` the Jellyfin a move came from; `sourceState` that container's
 * Docker state (`missing` once it is gone); `requestsWarning` the request service still points at the old Jellyfin; `scan` the
 * background scan of the chosen Jellyfin (mediaserver/move.ts MoveScanRecord). Not offered while a move is under way.
 */
export interface MoveView {
  offered: boolean; reason: OfferReason | null; scan: MoveScanRecord | null;
  state: (Omit<MoveRecord, 'requestsWarning'> & { step: MediaStep | null; abort: boolean }) | null;
  migratedFrom: MigratedFrom | null; sourceState: string | null; requestsWarning: boolean;
}
export interface MediaView {
  /** managed = media_managed.kind is set */
  mode: 'managed' | 'external';
  offer: { managed: boolean; reason: OfferReason | null };
  /** the image pins this build carries */
  kinds: { ferrofin: boolean; jellyfin: boolean };
  status: MediaStatus | null;
  managed: MediaManaged;
  /** the external server kept while managed (one click back) */
  external: { url: string | null; hasKey: boolean };
  /** LIVETV_RECORD_LIBRARY_JF_PATH (spec "Subfolders", last point) */
  livetvLibraryPath: string | null;
  move: MoveView;
}

const KINDS = ['ferrofin', 'jellyfin'] as const;
const GPUS = ['off', 'dri', 'nvidia'] as const;
const LIBRARY_TYPES = ['movies', 'tvshows', 'music', 'mixed'] as const;
/** the administrator FriendFlix creates in the managed server (spec "First run"; Ferrofin: FERROFIN_ADMIN_USER) */
export const ADMIN_USER = 'friendflix-admin';
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const CODE_RE = /^[a-z_]{1,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const REL = /^[\p{L}\p{N} ._\-+()&']{1,200}(\/[\p{L}\p{N} ._\-+()&']{1,200}){0,2}$/u;
const HOST_PATH = /^\/[\p{L}\p{N} ._\-+()&'/]{0,199}$/u;
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const CONTROL = /\p{Cc}/u;
/** a directory name as browse lists it: no separator, no control character */
const NAME = /^[^/\p{Cc}]+$/u;
const RENDER_NODE = /^renderD[0-9]{1,4}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
/** the user a move runs as when the updater records none (the one its scan helpers ran as: updater/src/mediaserver/service.ts user()) */
const MOVE_USER = { uid: 1000, gid: 1000 };
const MAX_LINES = 500;
const MAX_ENTRIES = 300;
const PASSPHRASE_HEADER = 'x-ff-backup-passphrase';
/** the largest encrypted backup an upload may carry (spec "Backup and restore": 20 GiB) */
const UPLOAD_MAX = 20 * 1024 ** 3;

/** the server's time zone for the container: TZ when it is an IANA name the updater accepts, else Etc/UTC */
export function containerTz(tz = process.env.TZ): string {
  return tz && tz.length <= 64 && TZ_RE.test(tz) ? tz : 'Etc/UTC';
}

const pinned = (ctx: Ctx): boolean => {
  try {
    const src = ctx.settings.sources();
    return src.JELLYFIN_URL === 'env' || src.JELLYFIN_ADMIN_API_KEY === 'env';
  } catch {
    return false;
  }
};

const STATUS_REASON: Record<NonNullable<MediaStatus['reason']>, OfferReason> = { engine_old: 'engine_old', no_logs: 'proxy_outdated', no_project: 'no_project', no_network: 'no_network', starting: 'starting' };

/** what keeps FriendFlix from running a managed media server at all (Plex, a pinned connection, the updater); null = nothing */
function updaterReason(ctx: Ctx, view: UpdaterView): OfferReason | null {
  if (ctx.cfg.MEDIA_SERVER === 'plex') return 'plex';
  if (pinned(ctx)) return 'url_pinned';
  if (!('status' in view)) return 'no_updater';
  const ms = view.status.mediaserver;
  // no `mediaserver` at all: an updater from before the media server (one that has not read it yet answers reason `starting`)
  if (!ms) return 'updater_outdated';
  // available false without a reason: the updater cannot reach its engine right now
  if (!ms.available) return ms.reason ? STATUS_REASON[ms.reason] : 'no_updater';
  return null;
}

/** why managed mode cannot be offered (spec "Who may do what", "Fresh server only where nothing depends on ids"); null = it can */
async function offerReason(ctx: Ctx, view: UpdaterView, managed: MediaManaged, kind?: Kind): Promise<OfferReason | null> {
  const reason = updaterReason(ctx, view);
  if (reason) return reason;
  if ((managed.kind === null || (kind !== undefined && kind !== managed.kind)) && (await idsInUse(ctx.db))) return 'ids_in_use';
  return null;
}

/** the external Jellyfin FriendFlix uses now (address only, no trailing slash); null when there is none or it is the managed server */
function currentJellyfin(ctx: Ctx): string | null {
  const url = addressOnly(ctx.cfg.JELLYFIN_URL ?? '').replace(/\/+$/, '');
  return url && url !== MANAGED_URL ? url : null;
}

/**
 * a move under way: the backend follows one (its active phases), or the updater holds an unfinished one (running, or copied and waiting
 * for the backend; an aborted or done move is history)
 */
const moving = (managed: MediaManaged, status: MediaStatus | null): boolean =>
  (managed.move !== null && ACTIVE_PHASES.includes(managed.move.phase)) || status?.move?.phase === 'running' || status?.move?.phase === 'ready';

/** whether the move is offered (MoveView): the updater's reasons first, then an external Jellyfin with linked ids and no move under way */
async function moveOffer(ctx: Ctx, view: UpdaterView, managed: MediaManaged, status: MediaStatus | null): Promise<Pick<MoveView, 'offered' | 'reason'>> {
  const reason = updaterReason(ctx, view);
  if (reason) return { offered: false, reason };
  return { offered: managed.kind === null && !moving(managed, status) && currentJellyfin(ctx) !== null && (await idsInUse(ctx.db)), reason: null };
}

function moveView(managed: MediaManaged, status: MediaStatus | null, offer: Pick<MoveView, 'offered' | 'reason'>, scan: MoveScanRecord | null): MoveView {
  const rec = managed.move;
  return {
    ...offer, scan,
    state: rec ? { phase: rec.phase, error: rec.error, jobId: rec.jobId, startedAt: rec.startedAt, step: status?.move?.step ?? null, abort: status?.move?.abort === true } : null,
    migratedFrom: managed.migratedFrom, sourceState: status?.source?.state ?? null, requestsWarning: rec?.requestsWarning === true,
  };
}

interface Loaded { view: UpdaterView; managed: MediaManaged; status: MediaStatus | null }
async function load(ctx: Ctx, read?: UpdaterView): Promise<Loaded> {
  const [view, managed] = await Promise.all([read ?? updaterView(ctx), readManaged(ctx.db)]);
  return { view, managed, status: 'status' in view ? view.status.mediaserver : null };
}

/** the page's view: mode, offer, status and the stored half (no secret: only whether one is stored); `read`: a status the caller already read */
export async function mediaView(ctx: Ctx, read?: UpdaterView): Promise<MediaView> {
  const { view, managed, status } = await load(ctx, read);
  const reason = await offerReason(ctx, view, managed);
  const move = moveView(managed, status, await moveOffer(ctx, view, managed, status), await readScan(ctx));
  return {
    mode: managed.kind ? 'managed' : 'external',
    offer: { managed: reason === null, reason },
    kinds: { ferrofin: status?.pins.ferrofin === true, jellyfin: status?.pins.jellyfin === true },
    status, managed,
    external: { url: managed.externalUrl, hasKey: managed.hasExternalKey },
    livetvLibraryPath: ctx.cfg.LIVETV_RECORD_LIBRARY_JF_PATH ?? null,
    move,
  };
}

type Answer = Awaited<ReturnType<typeof mediaOp>>;
/** an updater refusal as a code: its 400/409 codes when they are codes, rate_limited, else a fixed code */
function refusal(r: Answer): { status: number; error: string } {
  if (!r) return { status: 409, error: 'not_available' };
  const e = (r.json as { error?: unknown } | null)?.error;
  const code = typeof e === 'string' && CODE_RE.test(e) ? e : null;
  if ((r.status === 400 || r.status === 409) && code) return { status: r.status, error: code };
  if (r.status === 429) return { status: 429, error: 'rate_limited' };
  if (r.status === 404) return { status: 409, error: 'updater_outdated' };
  return { status: 502, error: 'updater_error' };
}
const refuse = (reply: FastifyReply, r: Answer) => {
  const f = refusal(r);
  return reply.code(f.status).send({ error: f.error });
};
const jobAnswer = (reply: FastifyReply, r: StartResult) =>
  (r.ok ? reply.code(202).send('job' in r ? { job: r.job } : {}) : reply.code(r.status).send({ error: r.error }));
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** the folders a base change kept or dropped: relative, no hidden or `..` component */
const rels = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && REL.test(x) && !x.split('/').some((c) => c.startsWith('.'))).slice(0, 20) : []);

/** the updater's GPU detection, checked field by field */
function gpuInfo(json: unknown): { dri: Array<{ node: string; gid: number; vendor: 'intel' | 'amd' | 'other' }>; nvidia: boolean } {
  const j = obj(json);
  const dri = (Array.isArray(j.dri) ? j.dri : []).slice(0, 16).flatMap((d) => {
    const o = obj(d);
    const vendor: 'intel' | 'amd' | 'other' = o.vendor === 'intel' || o.vendor === 'amd' ? o.vendor : 'other';
    const gid = typeof o.gid === 'number' && Number.isInteger(o.gid) && o.gid >= 0 && o.gid <= 65535 ? o.gid : null;
    return typeof o.node === 'string' && RENDER_NODE.test(o.node) && gid !== null ? [{ node: o.node, gid, vendor }] : [];
  });
  return { dri, nvidia: j.nvidia === true };
}

const id = z.number().int().min(1).max(65535);
const libraryName = z.string().min(1).max(60).refine((s) => s.trim() !== '' && !CONTROL.test(s));
const simple = <O extends string>(op: O) => z.object({ op: z.literal(op) }).strict();
const hdrTest = z.object({ op: z.literal('hdr-test'), kind: z.enum(KINDS) }).strict();
const S = {
  base: z.object({ path: z.string().max(200) }).strict(),
  confirm: z.object({ code: z.string().max(20) }).strict(),
  browse: z.object({ rel: z.string().max(200) }).strict(),
  apply: z.object({
    kind: z.enum(KINDS),
    folders: z.array(z.object({ rel: z.string().min(1).max(200), name: libraryName, type: z.enum(LIBRARY_TYPES) }).strict()).max(20)
      .refine((fs) => new Set(fs.map((f) => f.rel)).size === fs.length)
      // one library per name in the server (ensureLibrary skips a name that exists): names compared trimmed, without regard to case
      .refine((fs) => new Set(fs.map((f) => f.name.trim().toLowerCase())).size === fs.length),
    uid: id, gid: id, gpu: z.enum(GPUS), mediaGid: id.nullable(), egress: z.boolean(),
  }).strict(),
  logs: z.object({ tail: z.number().int().min(50).max(500) }).strict(),
  mode: z.object({ mode: z.literal('external'), restore: z.boolean() }).strict(),
  adminAction: z.discriminatedUnion('op', [
    simple('start'), simple('stop'), simple('restart'), simple('update'), simple('retry'), hdrTest,
    z.object({ op: z.literal('backup'), trickplay: z.boolean() }).strict(),
    z.object({ op: z.literal('restore'), id: z.string().regex(BACKUP_ID) }).strict(),
    z.object({ op: z.literal('remove'), data: z.boolean() }).strict(),
  ]),
  setupAction: z.discriminatedUnion('op', [simple('retry'), hdrTest]),
  none: z.object({}).strict(),
  moveScan: z.object({ source: z.string().regex(CONTAINER_ID).optional() }).strict(),
  move: z.object({ source: z.string().regex(CONTAINER_ID), trickplay: z.boolean() }).strict(),
};
type Action = z.infer<typeof S.adminAction>;
type ApplyBody = z.infer<typeof S.apply>;

/**
 * Managed -> external (spec "Switching"): `restore` puts the kept external address and key back, otherwise both are emptied. The managed
 * half becomes external (kind null, the setup starts over); the generated administrator and the libraries stay for a way back.
 */
async function toExternal(ctx: Ctx, restore: boolean, actor: string | null): Promise<void> {
  const m = await readManaged(ctx.db);
  const values = restore ? { JELLYFIN_URL: m.externalUrl, JELLYFIN_ADMIN_API_KEY: await externalKey(ctx) } : { JELLYFIN_URL: null, JELLYFIN_ADMIN_API_KEY: null };
  await ctx.settings.save(values, actor);
  await writeManaged(ctx, { kind: null, setup: 'none', setupError: null });
  await audit(ctx, actor, 'mediaserver.mode', undefined, { from: 'managed', to: 'external' });
}

interface Libraries { chosen: LibraryEntry[]; kept: LibraryEntry[]; changed: Array<{ from: LibraryEntry; to: LibraryEntry }> }
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/**
 * the libraries of an apply, or the refusal (spec "Folder changes after the first run"): `library_name_taken` when a folder is named like
 * the kept library of a removed folder (the server holds one library per name), `library_referenced`. `changed`: libraries in the server
 * that are renamed or retyped (unreferenced). Throws MediaSetupError when the references cannot be counted (fail closed).
 */
async function librariesFor(ctx: Ctx, managed: MediaManaged, b: ApplyBody): Promise<Libraries | { error: 'library_name_taken' | 'library_referenced' }> {
  // a folder chosen before keeps its slug (its mount point); a removed folder's library stays once it exists in the server (its items
  // show as missing); a new kind starts without libraries
  const before = managed.kind === b.kind ? managed.libraries : [];
  const byRel = new Map(before.map((l) => [l.rel, l]));
  const rels = new Set(b.folders.map((f) => f.rel));
  const kept = before.filter((l) => !rels.has(l.rel) && l.created);
  if (b.folders.some((f) => kept.some((k) => sameName(k.name, f.name)))) return { error: 'library_name_taken' };
  const changed: Libraries['changed'] = [];
  for (const f of b.folders) {
    const l = byRel.get(f.rel);
    if (!l?.created || (l.name === f.name && l.type === f.type)) continue;
    if (referenced(await libraryReferences(ctx, l.slug))) return { error: 'library_referenced' };
    // a new type is a new library (delete + create: the tick creates it), a new name a rename in place
    changed.push({ from: l, to: { ...l, name: f.name, type: f.type, created: l.type === f.type } });
  }
  const changedTo = new Map(changed.map((c) => [c.to.slug, c.to]));
  const taken = new Set([...kept, ...b.folders.flatMap((f) => byRel.get(f.rel) ?? [])].map((l) => l.slug));
  const chosen = b.folders.map((f): LibraryEntry => {
    const l = byRel.get(f.rel);
    if (l) return changedTo.get(l.slug) ?? { ...l, name: f.name, type: f.type };
    const slug = slugFor(f.name, taken);
    taken.add(slug);
    return { slug, name: f.name, type: f.type, rel: f.rel, created: false };
  });
  return { chosen, kept, changed };
}

/** stores one entry as it is now in the server (by slug), so a refused apply after it leaves the stored list true */
async function storeEntry(ctx: Ctx, entry: LibraryEntry): Promise<void> {
  const m = await readManaged(ctx.db);
  await writeManaged(ctx, { libraries: m.libraries.map((l) => (l.slug === entry.slug ? entry : l)) });
}

/** renames or retypes the changed libraries in the server before the apply recreates it (the server answers now) */
async function changeLibraries(ctx: Ctx, changed: Libraries['changed']): Promise<void> {
  if (!changed.length) return;
  const key = managedKey(ctx.cfg);
  if (!key) throw new MediaSetupError('unreachable');
  for (const { from, to } of changed) {
    if (from.type !== to.type) await deleteLibrary(ctx.fetchImpl, MANAGED_URL, key, from.name);
    else await renameLibrary(ctx.fetchImpl, MANAGED_URL, key, from.name, to.name);
    await storeEntry(ctx, to);
  }
}

/** a code for an answer from a MediaSetupError, rethrowing anything else */
const setupCode = (e: unknown): string => {
  if (e instanceof MediaSetupError) return e.code;
  throw e;
};

/** one operation: its body (checked before anything runs), whether the admin must have re-authenticated for it, what it does */
interface Op<T> { body: z.ZodType<T>; reauth?: (b: T) => boolean; run: (b: T, reply: FastifyReply, actor: string | null, req: FastifyRequest) => Promise<unknown> }
const op = <T>(o: Op<T>): Op<T> => o;

function ops(ctx: Ctx) {
  const base = op({
    body: S.base, reauth: () => true,
    run: async (b, reply, actor) => {
      const r = await mediaOp(ctx, { op: 'base-request', path: b.path });
      if (r?.status !== 200) return refuse(reply, r);
      const j = obj(r.json);
      await audit(ctx, actor, 'mediaserver.base_request', undefined, { path: b.path });
      return { pending: true, expiresAt: typeof j.expiresAt === 'string' && ISO.test(j.expiresAt) ? j.expiresAt : null, warning: j.warning === 'base_unreadable' ? 'base_unreadable' : null };
    },
  });

  const confirm = op({
    body: S.confirm,
    run: async (b, reply, actor) => {
      const r = await mediaOp(ctx, { op: 'base-confirm', code: b.code });
      const j = obj(r?.json);
      const result = r?.status === 200 && typeof j.result === 'string' && ['ok', 'wrong', 'expired', 'locked', 'no_pending'].includes(j.result) ? j.result : null;
      if (!result) return refuse(reply, r);
      const path = result === 'ok' && typeof j.path === 'string' && HOST_PATH.test(j.path) ? j.path : null;
      await audit(ctx, actor, 'mediaserver.base_confirm', undefined, { result, ...(path ? { path } : {}) });
      if (result !== 'ok') return reply.code(409).send({ error: result });
      // a managed container is recreated on the new base at once: its job is followed like an apply's
      const started = j.job ? startedJob({ status: 202, json: { job: j.job } }, 'mediaserver-apply') : null;
      if (started?.ok) await ctx.kv.set(`${PENDING}${started.job.id}`, JSON.stringify({ actor, action: 'mediaserver', op: 'apply' }), 7 * 86_400).catch(() => undefined);
      return { result, path, kept: rels(j.kept), dropped: rels(j.dropped), job: started?.ok ? started.job : null };
    },
  });

  const clear = op({
    body: S.none,
    run: async (_b, reply, actor) => {
      const r = await mediaOp(ctx, { op: 'base-clear' });
      if (r?.status !== 200) return refuse(reply, r);
      await audit(ctx, actor, 'mediaserver.base_clear');
      return { ok: true };
    },
  });

  const browse = op({
    body: S.browse,
    run: async (b, reply) => {
      const r = await mediaOp(ctx, { op: 'browse', rel: b.rel });
      if (r?.status !== 200) return refuse(reply, r);
      const j = obj(r.json);
      const entries = (Array.isArray(j.entries) ? j.entries : []).slice(0, MAX_ENTRIES).flatMap((e) => {
        const o = obj(e);
        const name = typeof o.name === 'string' && o.name.length <= 255 && NAME.test(o.name) ? o.name : null;
        return name ? [{ name, symlink: o.symlink === true, unreadable: o.unreadable === true }] : [];
      });
      return { entries, truncated: j.truncated === true };
    },
  });

  const gpu = op({
    body: S.none,
    run: async (_b, reply) => {
      const r = await mediaOp(ctx, { op: 'gpu' });
      if (r?.status !== 200) return refuse(reply, r);
      return gpuInfo(r.json);
    },
  });

  const apply = op({
    body: S.apply, reauth: () => true,
    run: async (b, reply, actor) => {
      const { view, managed, status } = await load(ctx);
      const reason = await offerReason(ctx, view, managed, b.kind);
      if (reason) return reply.code(409).send({ error: reason });
      let libs: Libraries;
      try {
        const found = await librariesFor(ctx, managed, b);
        if ('error' in found) return reply.code(409).send({ error: found.error });
        libs = found;
      } catch (e) {
        return reply.code(409).send({ error: setupCode(e) });
      }
      // once the server was changed (a retyped library deleted, stored not created), the libraries step makes it whole again, whether
      // the apply below starts or not (each change is stored as it happens: changeLibraries)
      const resume = async () => { if (libs.changed.length && managed.setup === 'done') await writeManaged(ctx, { setup: 'libraries', setupError: null }); };
      try {
        await changeLibraries(ctx, libs.changed);
      } catch (e) {
        await resume();
        return reply.code(409).send({ error: setupCode(e) });
      }
      // a first run (or one that has not finished): the generated administrator. Ferrofin gets its password in the create body (without
      // it, it would start with a passwordless admin). A stored password is reused: a data volume that survived (a failed run, a remove
      // without data, a switch back) knows only the password it was created with.
      const firstRun = managed.kind !== b.kind || managed.setup !== 'done';
      let password: string | null = null;
      if (firstRun) {
        password = (await adminPassword(ctx)) ?? await claimAdminPassword(ctx, ADMIN_USER, randomBytes(32).toString('base64url'));
      }
      // a new managed setup keeps the external server first (spec "Switching"); an empty connection (a switch without restore) leaves
      // the one kept before in place
      if (!managed.kind && ctx.cfg.JELLYFIN_URL) await writeManaged(ctx, { externalUrl: addressOnly(ctx.cfg.JELLYFIN_URL ?? '') || null, externalKey: ctx.cfg.JELLYFIN_ADMIN_API_KEY || null });
      const spec = {
        kind: b.kind, folders: libs.chosen.map((l) => ({ rel: l.rel, target: `/media/${l.slug}` })),
        uid: b.uid, gid: b.gid, gpu: b.gpu, mediaGid: b.mediaGid, egress: b.egress, tz: containerTz(),
      };
      const body = { op: 'apply', spec, ...(b.kind === 'ferrofin' && password ? { firstRun: { password } } : {}) };
      const r = await startMediaJob(ctx, body, actor, { kind: b.kind, folders: b.folders.length, gpu: b.gpu, egress: b.egress });
      if (r.ok) {
        if ('job' in r) await recordApplyFirstRun(ctx, r.job.id, 'firstRun' in body);
        const patch: ManagedPatch = { kind: b.kind, libraries: [...libs.chosen, ...libs.kept] };
        // after the first run: a new (or retyped) library goes back to the libraries step, a changed GPU to the encoding settings; the
        // tick waits for this apply first
        const again: SetupStep | null = firstRun ? null : libs.chosen.some((l) => !l.created) ? 'libraries' : status?.desired?.gpu !== b.gpu ? 'hwaccel' : null;
        if (firstRun) await writeManaged(ctx, { ...patch, setup: 'applying', setupError: null, adminUser: ADMIN_USER });
        else await writeManaged(ctx, again ? { ...patch, setup: again, setupError: null } : patch);
      } else {
        await resume();
      }
      return jobAnswer(reply, r);
    },
  });

  const action = <T extends Action>(body: z.ZodType<T>) => op<T>({
    body, reauth: (a) => a.op === 'restore' || (a.op === 'remove' && a.data),
    run: async (a, reply, actor) => {
      if (a.op === 'retry') {
        await writeManaged(ctx, { setupError: null });
        await audit(ctx, actor, 'mediaserver.action', undefined, { op: 'retry' });
        return { ok: true };
      }
      const managed = a.op === 'remove' ? await readManaged(ctx.db) : null;
      const r = await startMediaJob(ctx, a, actor, {});
      // a removed managed server is no longer the media server: FriendFlix switches to external, both connection settings emptied (a
      // leftover container removed while external leaves the external connection alone)
      if (r.ok && managed?.kind) await toExternal(ctx, false, actor);
      return jobAnswer(reply, r);
    },
  });

  return { base, confirm, clear, browse, gpu, apply, adminAction: action(S.adminAction), setupAction: action(S.setupAction) };
}

/**
 * The move's preconditions (stage 2 "Finding the source"): offered (MoveView), and the server id of the Jellyfin FriendFlix uses now
 * (`/System/Info/Public`), which the updater matches each candidate against; it never reaches an answer, an audit row or a log.
 */
async function moveGate(ctx: Ctx): Promise<{ error: string } | { status: MediaStatus | null; managed: MediaManaged; serverId: string }> {
  const { view, managed, status } = await load(ctx);
  // one move at a time: a move under way is `busy`, not "not offered"
  if (moving(managed, status) && !updaterReason(ctx, view)) return { error: 'busy' };
  const offer = await moveOffer(ctx, view, managed, status);
  if (!offer.offered) return { error: offer.reason ?? 'not_offered' };
  const info = await publicInfo(ctx.fetchImpl, currentJellyfin(ctx)!);
  return info?.id ? { status, managed, serverId: info.id } : { error: 'jellyfin_unreachable' };
}

/** the GPU the move's server gets: what the detection finds (as the wizard proposes it: NVIDIA, else a render node, else none) */
async function detectedGpu(ctx: Ctx): Promise<(typeof GPUS)[number]> {
  const r = await mediaOp(ctx, { op: 'gpu' });
  if (r?.status !== 200) return 'off';
  const g = gpuInfo(r.json);
  return g.nvidia ? 'nvidia' : g.dri.length ? 'dri' : 'off';
}

/**
 * The move's routes (stage 2 "Backend"): the scan, the move (the updater's copy job; the backend's phases follow in mediaserver/move.ts),
 * its abort and the way back. Codes only; the server id the backend adds is never part of an answer.
 */
function moveOps(ctx: Ctx) {
  // the candidate list answers at once (each candidate's id scan: at most 45 s); the sized scan of one candidate runs in the background
  // (mediaserver/move.ts startScan; the view shows it as move.scan); one scan at a time
  const scan = op({
    body: S.moveScan,
    run: async (b, reply) => {
      const gate = await moveGate(ctx);
      if ('error' in gate) return reply.code(409).send({ error: gate.error });
      if (await scanRunning(ctx)) return reply.code(409).send({ error: 'busy' });
      if (b.source !== undefined) {
        const started = await startScan(ctx, b.source, gate.serverId);
        return started ? reply.code(202).send({ scan: started }) : reply.code(409).send({ error: 'busy' });
      }
      const r = await mediaScan(ctx, undefined, gate.serverId);
      if (!r.ok) return reply.code(r.status).send({ error: r.error, outside: r.outside, refused: r.refused, nested: r.nested });
      return { candidates: r.candidates };
    },
  });

  // the user is the one the scan ran as, the GPU the detection's proposal, the time zone the server's; one move at a time
  const move = op({
    body: S.move, reauth: () => true,
    run: async (b, reply, actor) => {
      const gate = await moveGate(ctx);
      if ('error' in gate) return reply.code(409).send({ error: gate.error });
      // the admin confirmed what a scan of this very container showed, a short while ago
      if (!(await freshScan(ctx, b.source))) return reply.code(409).send({ error: 'scan_required' });
      const gpu = await detectedGpu(ctx);
      const user = gate.status?.desired ? { uid: gate.status.desired.uid, gid: gate.status.desired.gid } : MOVE_USER;
      const body = { op: 'migrate', source: b.source, trickplay: b.trickplay, gpu, uid: user.uid, gid: user.gid, tz: containerTz(), serverId: gate.serverId };
      const r = await startMediaJob(ctx, body, actor, { trickplay: b.trickplay, gpu }, 'mediaserver.move');
      if (r.ok && 'job' in r) {
        await writeManaged(ctx, { move: { phase: 'copying', error: null, jobId: r.job.id, startedAt: new Date().toISOString(), requestsWarning: false } });
      }
      return jobAnswer(reply, r);
    },
  });

  // the updater aborts the copy (its job checks between steps) or, once copied, runs the abort as its own job: the new container
  // removed, the old Jellyfin started. From the switch on FriendFlix uses the new server: the way back is /back.
  const abort = op({
    body: S.none,
    run: async (_b, reply, actor) => {
      const m = await readManaged(ctx.db);
      const phase = m.move?.phase ?? null;
      if (phase && SWITCHED_PHASES.includes(phase)) return reply.code(409).send({ error: 'not_abortable' });
      const r = await startMediaJob(ctx, { op: 'migrate-abort' }, actor, { phase }, 'mediaserver.move_abort');
      // an abort the copy's own job carries out is read from that job's end; one the updater runs as a new job (the copy was done,
      // whatever phase the backend shows) ends the move here, so no phase continues after it
      const ownJob = r.ok && 'job' in r && r.job.id === m.move?.jobId;
      if (r.ok && m.move && ACTIVE_PHASES.includes(m.move.phase) && (phase === 'nfo' || phase === 'verify' || !ownJob)) {
        await writeManaged(ctx, { move: { ...m.move, phase: 'failed', error: 'move_aborted' } });
      }
      return jobAnswer(reply, r);
    },
  });

  const back = op({
    body: S.none, reauth: () => true,
    run: async (_b, reply, actor) => {
      const m = await readManaged(ctx.db);
      if (!m.migratedFrom || !m.kind) return reply.code(409).send({ error: 'not_moved' });
      const r = await goBack(ctx, actor);
      if (!r.ok) return reply.code(409).send({ error: r.error });
      await audit(ctx, actor, 'mediaserver.back', undefined, { name: m.migratedFrom.name });
      return { ok: true };
    },
  });

  return { scan, move, abort, back };
}

/** a limit for the whole portal (the updater is one), counted after the guard and the body check so nobody else can use it up */
const limit = (max: number, timeWindow: string, key: string) => ({ rateLimit: { max, timeWindow, keyGenerator: () => `mediaserver:${key}`, hook: 'preHandler' as const } });
const LIMITS = {
  base: limit(3, '10 minutes', 'base'), confirm: limit(10, '10 minutes', 'confirm'), browse: limit(30, '1 minute', 'browse'), gpu: limit(30, '1 minute', 'gpu'),
  apply: limit(3, '2 minutes', 'apply'), action: limit(3, '2 minutes', 'action'), clear: limit(3, '2 minutes', 'base-clear'), logs: limit(20, '1 minute', 'logs'),
  libraries: limit(20, '1 minute', 'libraries'), libraryDelete: limit(3, '2 minutes', 'library-delete'), mode: limit(3, '2 minutes', 'mode'),
  download: limit(3, '2 minutes', 'backup-download'), upload: limit(3, '10 minutes', 'backup-upload'),
  moveScan: limit(6, '2 minutes', 'move-scan'), move: limit(3, '2 minutes', 'move'), moveAbort: limit(3, '2 minutes', 'move-abort'), back: limit(3, '2 minutes', 'back'),
};

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
/**
 * the route of an operation behind `guard`: the body is checked (400 invalid_body, nothing sent) and, where `reauth` asks, the
 * re-authentication (401 reauth_required) before the limiter counts the request
 */
function route<T>(guard: Hook, o: Op<T>, config: object, actor: (req: FastifyRequest) => string | null, reauth: boolean) {
  const check: Hook = async (req, reply) => {
    const p = o.body.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'invalid_body' });
    req.body = p.data;
    if (reauth && o.reauth?.(p.data) && !recentlyAuthenticated(req.session!)) return reply.code(401).send({ error: 'reauth_required' });
  };
  return { opts: { preHandler: [guard, check], config }, handler: async (req: FastifyRequest, reply: FastifyReply) => o.run(req.body as T, reply, actor(req), req) };
}

/** an updater answer to a backup stream as a code: its 400/404/409/413 codes keep their status, anything else is a fixed code */
function streamRefusal(r: Answer): { status: number; error: string } {
  if (!r) return { status: 502, error: 'updater_error' };
  const e = (r.json as { error?: unknown } | null)?.error;
  const code = typeof e === 'string' && CODE_RE.test(e) ? e : null;
  if ([400, 404, 409, 413].includes(r.status) && code) return { status: r.status, error: code };
  if (r.status === 429) return { status: 429, error: 'rate_limited' };
  return { status: 502, error: 'updater_error' };
}
/** the passphrase header exactly as the browser sent it (base64url), when it holds a passphrase of 12–1024 code points */
const passphraseHeader = (req: FastifyRequest): string | null => {
  const h = req.headers[PASSPHRASE_HEADER];
  return typeof h === 'string' && decodePassphrase(h) !== null ? h : null;
};
/** the uploaded backup as the updater recorded it, checked like a listed one */
const uploadedBackup = (json: unknown): MediaBackup | null => parseMediaStatus({ backups: [obj(json).backup] })?.backups[0] ?? null;

/**
 * The encrypted backup download and the upload that restores one (spec "Backup and restore"): admin, a recent re-authentication, the
 * passphrase header, and the route's own checks before the limiter counts the request and before a byte is read or sent. The header is
 * passed on as sent (the updater verifies the signature over it); neither it nor the passphrase reaches an answer, an audit row or a log
 * (app.ts redacts the header). Both streams go through without being buffered; a client that goes away aborts the updater request.
 */
function backupStreamRoutes(app: FastifyInstance, ctx: Ctx, guard: Hook, P: string) {
  const check = (own: (req: FastifyRequest) => { status: number; error: string } | null): Hook => async (req, reply) => {
    const f = !recentlyAuthenticated(req.session!) ? { status: 401, error: 'reauth_required' }
      : own(req) ?? (passphraseHeader(req) === null ? { status: 400, error: 'invalid_passphrase' } : null);
    if (f) return reply.code(f.status).send({ error: f.error });
  };
  /** aborted once the client's connection is gone (or the answer is complete) */
  const clientGone = (reply: FastifyReply): AbortSignal => {
    const ac = new AbortController();
    reply.raw.once('close', () => ac.abort());
    return ac.signal;
  };

  const downloadCheck = check((req) => (BACKUP_ID.test((req.params as { id: string }).id) ? null : { status: 404, error: 'not_found' }));
  app.get(`${P}/backups/:id/download`, { preHandler: [guard, downloadCheck], config: LIMITS.download }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await mediaDownload(ctx, id, passphraseHeader(req)!, clientGone(reply));
    if (r?.status !== 200 || !r.body) {
      const f = streamRefusal(r && { status: r.status, json: await r.json().catch(() => null) });
      return reply.code(f.status).send({ error: f.error });
    }
    await audit(ctx, req.user!.id, 'mediaserver.backup_download', undefined, { id });
    // the file name is built from the checked id, never taken from the updater
    return reply.code(200).headers({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${id}.tar.gz.age"`, 'cache-control': 'no-store' })
      .send(Readable.fromWeb(r.body as unknown as WebReadable<Uint8Array>));
  });

  const uploadCheck = check((req) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/octet-stream') return { status: 415, error: 'unsupported_media_type' };
    const len = req.headers['content-length'];
    if (typeof len !== 'string' || !/^[0-9]{1,15}$/.test(len)) return { status: 411, error: 'length_required' };
    return Number(len) > UPLOAD_MAX ? { status: 413, error: 'too_large' } : null;
  });
  void app.register(async (sub) => {
    // the body stays a stream, whatever its type: nothing reads it before the checks, then it goes to the updater as it arrives
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    // every answer closes the connection: the rest of a refused body (up to 20 GiB) is never read
    const close = async (_req: FastifyRequest, reply: FastifyReply) => { reply.header('connection', 'close'); };
    sub.post(`${P}/backups/upload`, { onRequest: close, preHandler: [guard, uploadCheck], config: LIMITS.upload }, async (req, reply) => {
      const size = Number(req.headers['content-length']);
      const r = await mediaUpload(ctx, req.raw, size, passphraseHeader(req)!, clientGone(reply));
      // a connection the updater cut while the body was sent (its 20-GiB limit) is null: a failure, never a restore
      const backup = r?.status === 200 ? uploadedBackup(r.json) : null;
      if (!backup) {
        const f = r?.status === 200 ? { status: 502, error: 'updater_error' } : streamRefusal(r);
        return reply.code(f.status).send({ error: f.error });
      }
      const actor = req.user!.id;
      await audit(ctx, actor, 'mediaserver.backup_upload', undefined, { size });
      const started = await startMediaJob(ctx, { op: 'restore', id: backup.id }, actor, {});
      // the upload is kept as a backup either way: a refused restore (busy, no_target) can be started from the list later
      if (!started.ok) return reply.code(started.status).send({ error: started.error, backup });
      return reply.code(202).send({ backup, job: 'job' in started ? started.job : null });
    });
  });
}

export function adminMediaserverRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = requireAdmin(ctx);
  const o = ops(ctx);
  const P = '/api/admin/mediaserver';
  const actor = (req: FastifyRequest) => req.user!.id;
  const post = <T>(path: string, x: Op<T>, config: object) => { const r = route(guard, x, config, actor, true); app.post(`${P}${path}`, r.opts, r.handler); };

  app.get(P, { preHandler: guard }, async () => mediaView(ctx));
  post('/base', o.base, LIMITS.base);
  post('/base/confirm', o.confirm, LIMITS.confirm);
  const clear = route(guard, o.clear, LIMITS.clear, actor, true);
  app.delete(`${P}/base`, clear.opts, clear.handler);
  post('/browse', o.browse, LIMITS.browse);
  post('/gpu', o.gpu, LIMITS.gpu);
  post('/apply', o.apply, LIMITS.apply);
  post('/action', o.adminAction, LIMITS.action);
  const mv = moveOps(ctx);
  post('/move/scan', mv.scan, LIMITS.moveScan);
  post('/move', mv.move, LIMITS.move);
  post('/move/abort', mv.abort, LIMITS.moveAbort);
  post('/back', mv.back, LIMITS.back);

  post('/logs', op({
    body: S.logs,
    run: async (b, reply) => {
      const r = await mediaOp(ctx, { op: 'logs', tail: b.tail });
      if (r?.status !== 200) return refuse(reply, r);
      const lines = obj(r.json).lines;
      return { lines: (Array.isArray(lines) ? lines : []).filter((l): l is string => typeof l === 'string').slice(-MAX_LINES).map((l) => l.slice(0, 500)) };
    },
  }), LIMITS.logs);

  app.get(`${P}/backups`, { preHandler: guard }, async () => {
    const { status } = await load(ctx);
    return { backups: status?.backups ?? [] };
  });
  backupStreamRoutes(app, ctx, guard, P);

  // references: null while the server cannot list the library's items
  app.get(`${P}/libraries`, { preHandler: guard, config: LIMITS.libraries }, async () => {
    const m = await readManaged(ctx.db);
    const refs = async (slug: string) => {
      try {
        return await libraryReferences(ctx, slug);
      } catch (e) {
        setupCode(e); // rethrows anything but a server failure
        return null;
      }
    };
    const libraries = [];
    for (const l of m.libraries) libraries.push({ ...l, references: await refs(l.slug) });
    return { libraries };
  });

  // deletes the library in the server (its references stay orphaned; the dialog counted them before) and its entry
  const del = route(guard, op({
    body: S.none, reauth: () => true,
    run: async (_b, reply, who, req) => {
      const { slug } = req.params as { slug: string };
      const m = await readManaged(ctx.db);
      const lib = SLUG_RE.test(slug) ? m.libraries.find((l) => l.slug === slug) : undefined;
      if (!lib) return reply.code(404).send({ error: 'not_found' });
      if (lib.created) {
        const key = managedKey(ctx.cfg);
        // a 409 with a code, not a 5xx: no server error reaches the answer
        if (!key) return reply.code(409).send({ error: 'unreachable' });
        try {
          await deleteLibrary(ctx.fetchImpl, MANAGED_URL, key, lib.name);
        } catch (e) {
          return reply.code(409).send({ error: setupCode(e) });
        }
      }
      const now = await readManaged(ctx.db);
      await writeManaged(ctx, { libraries: now.libraries.filter((l) => l.slug !== slug) });
      await audit(ctx, who, 'mediaserver.action', undefined, { op: 'library_delete' });
      return { ok: true };
    },
  }), LIMITS.libraryDelete, actor, true);
  app.delete(`${P}/libraries/:slug`, del.opts, del.handler);

  post('/mode', op({
    body: S.mode, reauth: () => true,
    run: async (b, reply, who) => {
      const { managed, status } = await load(ctx);
      if (!managed.kind) return reply.code(409).send({ error: 'not_managed' });
      if (b.restore && !managed.externalUrl) return reply.code(409).send({ error: 'no_external' });
      // the managed container is stopped, not removed (spec "Switching")
      if (status?.container) {
        const r = await startMediaJob(ctx, { op: 'stop' }, who, {});
        if (!r.ok) return jobAnswer(reply, r);
      }
      await toExternal(ctx, b.restore, who);
      return { ok: true };
    },
  }), LIMITS.mode);
}

/** the wizard's media step (spec "Admin and wizard"): the same operations under the setup session, no re-authentication, actor null */
export function setupMediaserverRoutes(app: FastifyInstance, ctx: Ctx) {
  const guard = requireSetupSession(ctx);
  const o = ops(ctx);
  const P = '/api/setup/mediaserver';
  const post = <T>(path: string, x: Op<T>, config: object) => { const r = route(guard, x, config, () => null, false); app.post(`${P}${path}`, r.opts, r.handler); };

  app.get(P, { preHandler: guard }, async () => mediaView(ctx));
  post('/base', o.base, LIMITS.base);
  post('/base/confirm', o.confirm, LIMITS.confirm);
  post('/browse', o.browse, LIMITS.browse);
  post('/gpu', o.gpu, LIMITS.gpu);
  post('/apply', o.apply, LIMITS.apply);
  post('/action', o.setupAction, LIMITS.action);
}
