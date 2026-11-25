// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { timingSafeEqual } from 'node:crypto';
import { StepError } from '../docker.js';
import type { StartResult, Updater } from '../job.js';
import type { Job, MediaState } from '../state.js';
import { EngineError, type Engine } from './engine.js';
import type { EngineFacts } from './facts.js';
import { TemplateViolation, type SourceExpect } from './guard.js';
import type { runHelper } from './helpers.js';
import { baseCodeLogLine, hashBaseCode, newBaseCode, normalizeBaseCode } from './code.js';
import { redactLine } from './logs.js';
import { checkBasePath, isRel } from './paths.js';
import { SourceError, findCandidates, listCandidates, scanSource, type Candidate, type ScanResult, type SourceDeps } from './source.js';
import { helperSpec, volumeSpec, names, type HelperMount, type HelperVerb } from './template.js';
import { MEDIA_ERRORS, type DesiredSpec, type MediaError } from './types.js';

export interface MediaDeps {
  engine: Engine;
  updater: Updater;
  facts(): Promise<EngineFacts>;
  helper: typeof runHelper;
  /** the updater's stdout: where the base code goes, and why a move's copy failed (MediaJobs.helper) */
  print(line: string): void;
  now(): number;
  repo: string;
}

/** the limit of a helper that only reads (spec "Times": sync operations 25 s) */
export const SYNC_HELPER_MS = 25_000;
/** the sized scan of the chosen Jellyfin: it walks the whole metadata and trickplay tree (large on a NAS) */
export const SCAN_HELPER_MS = 120_000;
const CODE_TTL_MS = 30 * 60_000;
const MAX_FAILURES = 5;
const REQUESTS_PER_WINDOW = 3;
const WINDOW_MS = 10 * 60_000;
/** the container user before the admin chose one */
const DEFAULT_USER = { uid: 1000, gid: 1000 };

export type RequestError = 'path_invalid' | 'path_refused' | 'base_missing' | 'rate_limited' | 'not_available';
export type RequestResult =
  | { ok: true; expiresAt: string; warning: 'base_unreadable' | null }
  | { ok: false; status: 400 | 409 | 429; error: RequestError };
export type ConfirmResult =
  | { result: 'ok'; path: string; kept: string[]; dropped: string[]; job: Job | null }
  | { result: 'wrong' | 'expired' | 'locked' | 'no_pending' }
  | { error: 'busy' | 'not_available' | 'template_violation' };
export interface BrowseEntry { name: string; symlink: boolean; unreadable: boolean }
export type BrowseResult = { entries: BrowseEntry[]; truncated: boolean } | { error: 'no_base' | 'base_missing' | 'invalid_body' };
export interface GpuResult { dri: Array<{ node: string; gid: number; vendor: 'intel' | 'amd' | 'other' }>; nvidia: boolean }
/** a scan as the move sheet sees it: no host path (the recorded /config source stays here) and no server id */
export interface ScanView { source: { id: string; name: string; image: string; version: string | null }; folders: ScanResult['folders']; layout: ScanResult['layout']; bytes: number; trickplayBytes: number; plugins: string[]; nfo: boolean }
export type MoveScanResult =
  | { candidates: Array<Candidate & { matches: boolean | null }>; scan?: ScanView }
  | { error: MediaError | 'not_available'; outside?: string[]; refused?: string[]; nested?: string[] };

const STATUS: Record<'path_invalid' | 'path_refused' | 'base_missing' | 'not_available', 400 | 409> = { path_invalid: 400, path_refused: 400, base_missing: 409, not_available: 409 };
const fail = (error: keyof typeof STATUS): RequestResult => ({ ok: false, status: STATUS[error], error });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const RENDER_NODE_RE = /^renderD[0-9]{1,4}$/;

/** the facts a helper needs; null when the engine, the project or the own image is not known */
type Ready = { project: string; image: string; facts: EngineFacts };

/** what base-confirm needs from the media jobs: the recreate on the new base (MediaJobs.rebase) */
export interface Rebase { rebase(spec: DesiredSpec): StartResult }

export class MediaService {
  /** when each code was issued (in memory): at most 3 in 10 minutes */
  private issued: number[] = [];

  constructor(private readonly d: MediaDeps, private readonly jobs?: Rebase) {}

  private async ready(): Promise<Ready | null> {
    let f: EngineFacts;
    try { f = await this.d.facts(); } catch { return null; }
    return f.reason === null && f.project && f.selfImage ? { project: f.project, image: f.selfImage, facts: f } : null;
  }

  /** the container user the helpers run as (the chosen pair once there is one) and the media group */
  private user(): { uid: number; gid: number; groups: number[] } {
    const want = this.d.updater.mediaState().desired;
    return { uid: want?.uid ?? DEFAULT_USER.uid, gid: want?.gid ?? DEFAULT_USER.gid, groups: want?.mediaGid ? [want.mediaGid] : [] };
  }

  /**
   * One helper run: its JSON answer, or a StepError carrying the helper's own error code (a helper that exited 2 still answers
   * with a JSON object: `{"error":"<code>"}`) or the code runHelper gave.
   */
  private async helper(r: Ready, verb: HelperVerb, args: string[], mounts: HelperMount[], bind?: string, source?: SourceExpect, limitMs = SYNC_HELPER_MS): Promise<Obj> {
    const u = this.user();
    const req = helperSpec({ verb, args, uid: u.uid, gid: u.gid, groups: u.groups, mounts }, { project: r.project, image: r.image });
    const answer = await this.d.helper(this.d.engine, req, { project: r.project, uid: u.uid, gid: u.gid, image: r.image, verb, ...(bind !== undefined ? { bind } : {}), ...(source ? { source, dockerRoot: r.facts.dockerRoot } : {}) }, limitMs);
    if ('error' in answer) throw new StepError(typeof answer.error === 'string' && /^[a-z_]{1,40}$/.test(answer.error) ? answer.error : 'helper_failed');
    return answer;
  }

  /**
   * base-request: syntax, then a helper on a read-only bind of the path itself (exists, is a directory, can be listed, does not look
   * like a system root); then one pending code, its sha256 kept, its single log line to stdout. The code is in no answer.
   */
  async request(path: string): Promise<RequestResult> {
    const r = await this.ready();
    if (!r) return fail('not_available');
    const syntax = checkBasePath(path, { dockerRoot: r.facts.dockerRoot, stackDir: r.facts.stackDir });
    if (syntax) return fail(syntax);
    const now = this.d.now();
    this.issued = this.issued.filter((t) => now - t < WINDOW_MS);
    if (this.issued.length >= REQUESTS_PER_WINDOW) return { ok: false, status: 429, error: 'rate_limited' };
    // the slot is taken before the helper runs (concurrent requests all see it) and given back unless a code is issued
    this.issued.push(now);
    let issuedCode = false;
    try {
      return await this.issue(r, path, now, () => { issuedCode = true; });
    } finally {
      if (!issuedCode) { const i = this.issued.indexOf(now); if (i >= 0) this.issued.splice(i, 1); }
    }
  }

  private async issue(r: Ready, path: string, now: number, issued: () => void): Promise<RequestResult> {
    let a: Obj;
    try {
      a = await this.helper(r, 'check', ['base'], [{ kind: 'request', path }], path);
    } catch (e) {
      // a bind source that does not exist fails the helper's create
      const create = (e instanceof StepError && e.code === 'create_failed') || (e instanceof EngineError && e.code === 'create_failed');
      return fail(create ? 'base_missing' : 'not_available');
    }
    if (!bool(a.exists) || !bool(a.dir) || !bool(a.listable) || !bool(a.looksSystem)) return fail('not_available');
    if (!a.exists || !a.dir) return fail('base_missing');
    if (a.looksSystem) return fail('path_refused');

    const code = newBaseCode();
    const expiresAt = new Date(now + CODE_TTL_MS);
    issued();
    this.d.updater.updateMedia((m) => { m.pending = { path, codeHash: code.hash, expiresAt: expiresAt.toISOString(), failures: 0 }; });
    this.d.updater.log.add('media folder code issued');
    this.d.print(baseCodeLogLine(path, code.display, expiresAt));
    return { ok: true, expiresAt: expiresAt.toISOString(), warning: a.listable ? null : 'base_unreadable' };
  }

  /**
   * base-confirm: busy while a job runs (the code and its counter stay). Wrong codes are counted, the 5th clears the request; a right
   * one stores the base (its volume is created), and, where folders were chosen, says which exist below the new base.
   */
  async confirm(code: string): Promise<ConfirmResult> {
    if (this.d.updater.busy) return { error: 'busy' };
    // a migrated server's folders are paths below this base (the whole base among them): no base change while one exists or a move
    // is not settled (the request and its code stay)
    const media = this.d.updater.mediaState();
    if (media.desired?.migrated || media.move?.phase === 'running' || media.move?.phase === 'ready') return { error: 'template_violation' };
    const pending = media.pending;
    if (!pending) return { result: 'no_pending' };
    if (this.d.now() >= Date.parse(pending.expiresAt)) {
      this.d.updater.updateMedia((m) => { m.pending = null; });
      return { result: 'expired' };
    }
    const given = Buffer.from(hashBaseCode(normalizeBaseCode(code)), 'hex');
    if (!timingSafeEqual(given, Buffer.from(pending.codeHash, 'hex'))) return this.wrong(pending.codeHash);

    const r = await this.ready();
    if (!r) return { error: 'not_available' };
    // the path is checked once more: the Docker root or the stack directory may differ from what the request saw
    if (checkBasePath(pending.path, { dockerRoot: r.facts.dockerRoot, stackDir: r.facts.stackDir }) !== null) return { error: 'not_available' };
    const before = this.d.updater.mediaState();
    const volume = names(r.project).base(pending.path);
    let split: { kept: string[]; dropped: string[] };
    try {
      const spec = volumeSpec(r.project, 'base', { path: pending.path });
      const existing = await this.d.engine.inspectVolume(spec.Name);
      if (!existing) await this.d.engine.createVolume(spec);
      else if (existing.options.device !== pending.path) return { error: 'not_available' };
      split = await this.existingBelow(r, volume, before.desired?.folders.map((x) => x.rel) ?? []);
    } catch {
      return { error: 'not_available' };
    }
    // a job may have started, or the request been replaced, while the helper ran: nothing is committed then
    if (this.d.updater.busy) return { error: 'busy' };
    if (this.d.updater.mediaState().pending?.codeHash !== pending.codeHash) return { result: 'no_pending' };
    const at = new Date(this.d.now()).toISOString();
    const old = this.d.updater.mediaState().base;
    // the volume the container still uses (never the new base volume itself)
    const rawPrev = old && old.volume !== volume ? old.previousVolume ?? old.volume : old?.previousVolume ?? null;
    const previousVolume = rawPrev === volume ? null : rawPrev;
    this.d.updater.updateMedia((m) => {
      m.base = { path: pending.path, volume, confirmedAt: at, previousVolume };
      m.pending = null;
      // the folders that are not below the new base are dropped from the choice
      if (m.desired) m.desired.folders = m.desired.folders.filter((x) => split.kept.includes(x.rel));
    });
    this.d.updater.log.add('media base folder confirmed');
    // a replaced base volume that was never applied (neither the new one nor the one the container uses) is not needed any more
    if (old && old.volume !== volume && old.volume !== previousVolume) await this.dropBaseVolume(old.volume, r.project);
    // with a managed container the new base is applied at once: a recreate with the kept folders (Controller's call 4); the old base
    // volume goes when it succeeds
    return { result: 'ok', path: pending.path, ...split, job: this.recreate() };
  }

  private recreate(): Job | null {
    const m = this.d.updater.mediaState();
    if (!this.jobs || !m.container || !m.desired) return null;
    const { run: _run, ...spec } = m.desired;
    const started = this.jobs.rebase(spec);
    return started.ok ? started.job : null;
  }

  /**
   * best effort: only a base volume of this project, never while the media server or the container left aside mounts it (Docker
   * refuses any other user); a failure is swallowed with one fixed log line
   */
  private async dropBaseVolume(name: string, project: string): Promise<void> {
    try {
      const v = await this.d.engine.inspectVolume(name);
      if (v?.labels['friendflix.managed'] !== 'mediaserver-base' || v.labels['friendflix.project'] !== project) return;
      const n = names(project);
      for (const c of [n.container, n.old]) {
        const i = await this.d.engine.inspectContainer(c);
        const mounts = isObj(i?.HostConfig) && Array.isArray(i.HostConfig.Mounts) ? i.HostConfig.Mounts : [];
        if (mounts.some((m) => isObj(m) && m.Source === name)) throw new Error('in use');
      }
      await this.d.engine.removeVolume(name);
    } catch {
      this.d.updater.log.add('media base volume could not be removed');
    }
  }

  private wrong(hash: string): ConfirmResult {
    let locked = false;
    this.d.updater.updateMedia((m) => {
      if (m.pending?.codeHash !== hash) return;
      m.pending.failures += 1;
      if (m.pending.failures >= MAX_FAILURES) { m.pending = null; locked = true; }
    });
    return { result: locked ? 'locked' : 'wrong' };
  }

  /** which of the chosen folders exist below the base volume (a helper that lstat's every component; symlinks and unreadable ones do not) */
  private async existingBelow(r: Ready, volume: string, rels: string[]): Promise<{ kept: string[]; dropped: string[] }> {
    if (rels.length === 0) return { kept: [], dropped: [] };
    const a = await this.helper(r, 'check', ['folders', JSON.stringify(rels)], [{ kind: 'base', volume }]);
    const found = new Map<string, string>();
    if (Array.isArray(a.folders)) for (const x of a.folders) if (isObj(x) && typeof x.rel === 'string' && typeof x.code === 'string') found.set(x.rel, x.code);
    return { kept: rels.filter((x) => found.get(x) === 'ok'), dropped: rels.filter((x) => found.get(x) !== 'ok') };
  }

  /**
   * base-clear: no code (it only narrows), but not while a managed container or a job exists. The base volume and the one a
   * container last used go with it (only ours, never while mounted; see dropBaseVolume).
   */
  async clear(): Promise<{ ok: true } | { error: 'container_exists' | 'busy' }> {
    if (this.d.updater.busy) return { error: 'busy' };
    const before = this.d.updater.mediaState();
    if (before.container) return { error: 'container_exists' };
    this.d.updater.updateMedia((m) => { m.base = null; m.pending = null; });
    this.d.updater.log.add('media base folder cleared');
    if (!before.base) return { ok: true };
    const project = (await this.d.facts().catch(() => null))?.project;
    if (!project) { this.d.updater.log.add('media base volume could not be removed'); return { ok: true }; }
    for (const v of new Set([before.base.volume, before.base.previousVolume])) if (v) await this.dropBaseVolume(v, project);
    return { ok: true };
  }

  /**
   * browse: the directories below `<base>/<rel>` (names only). A folder that is gone or a helper that cannot run is `base_missing`;
   * a folder below that is a symlink or cannot be listed is `invalid_body` (the listing flags both, they are not browsable).
   */
  async browse(rel: string): Promise<BrowseResult> {
    const base: MediaState['base'] = this.d.updater.mediaState().base;
    if (!base) return { error: 'no_base' };
    if (!isRel(rel, 0, 3)) return { error: 'invalid_body' };
    const r = await this.ready();
    if (!r) return { error: 'base_missing' };
    let a: Obj;
    try {
      a = await this.helper(r, 'browse', [rel], [{ kind: 'base', volume: base.volume }]);
    } catch (e) {
      const code = e instanceof StepError ? e.code : '';
      return { error: code === 'invalid_body' || code === 'folder_symlink' || code === 'folder_unreadable' ? 'invalid_body' : 'base_missing' };
    }
    if (!Array.isArray(a.entries) || !bool(a.truncated)) return { error: 'base_missing' };
    const entries: BrowseEntry[] = [];
    for (const e of a.entries.slice(0, 300)) {
      if (isObj(e) && typeof e.name === 'string' && e.name.length <= 255 && bool(e.symlink) && bool(e.unreadable)) entries.push({ name: e.name, symlink: e.symlink, unreadable: e.unreadable });
    }
    return { entries, truncated: a.truncated || a.entries.length > 300 };
  }

  /** the render nodes of the host (a helper) and whether Docker has the NVIDIA runtime; a helper that cannot run finds no node */
  async gpu(): Promise<GpuResult> {
    let nvidia = false;
    try { nvidia = (await this.d.facts()).nvidia; } catch { /* unknown: no NVIDIA */ }
    const r = await this.ready();
    if (!r) return { dri: [], nvidia };
    let a: Obj;
    try {
      a = await this.helper(r, 'gpu', [], [{ kind: 'dri' }, { kind: 'drm' }]);
    } catch {
      return { dri: [], nvidia };
    }
    const dri: GpuResult['dri'] = [];
    if (Array.isArray(a.nodes)) {
      for (const n of a.nodes.slice(0, 16)) {
        if (!isObj(n) || typeof n.node !== 'string' || !RENDER_NODE_RE.test(n.node)) continue;
        if (typeof n.gid !== 'number' || !Number.isInteger(n.gid) || n.gid < 0 || n.gid > 65535) continue;
        const vendor = n.vendor === 'intel' || n.vendor === 'amd' ? n.vendor : 'other';
        dri.push({ node: n.node, gid: n.gid, vendor });
      }
    }
    return { dri, nvidia };
  }

  /**
   * what source.ts needs: the engine, the confirmed base and the `migrate-scan` helper on a /config, mounted read-only at /source
   * (the guard checks that mount against exactly this source and the engine's Docker root); null when no helper can run
   */
  async sourceDeps(): Promise<SourceDeps | null> {
    const r = await this.ready();
    if (!r) return null;
    const base = this.d.updater.mediaState().base;
    return {
      engine: this.d.engine, base: base ? { path: base.path } : null, now: () => this.d.now(),
      scan: (config, mode) => this.helper(r, 'migrate-scan', mode === 'id' ? ['id'] : [], [{ kind: 'source', type: config.type, source: config.source }], undefined, config,
        mode === 'id' ? SYNC_HELPER_MS : SCAN_HELPER_MS),
    };
  }

  /**
   * migrate-scan: the Jellyfin containers on this engine, each with whether it is FriendFlix's server (`serverId`, which the
   * backend read from it); with `source`, that candidate scanned as the source. Codes only: a refused media mount is named by its
   * container path.
   */
  async moveScan(serverId: string, source?: string): Promise<MoveScanResult> {
    const deps = await this.sourceDeps();
    if (!deps) return { error: 'not_available' };
    try {
      if (source === undefined) return { candidates: await listCandidates(deps, serverId) };
      const s = await scanSource(deps, source, serverId);
      // the others are not scanned again: only the chosen one is known to match
      const candidates = (await findCandidates(deps.engine)).map((c) => ({ ...c, matches: c.id === source ? true : null }));
      const { id, name, image, version } = s.source;
      return { candidates, scan: { source: { id, name, image, version }, folders: s.folders, layout: s.layout, bytes: s.bytes, trickplayBytes: s.trickplayBytes, plugins: s.plugins, nfo: s.nfo } };
    } catch (e) {
      if (e instanceof SourceError && e.code === 'source_outside_base') return { error: e.code, outside: e.outside, refused: e.refused };
      if (e instanceof SourceError && e.code === 'source_nested') return { error: e.code, nested: e.nested };
      if (e instanceof TemplateViolation) return { error: 'template_violation' };
      const code = e instanceof StepError || e instanceof EngineError ? e.code : '';
      return { error: (MEDIA_ERRORS as readonly string[]).includes(code) ? code as MediaError : 'helper_failed' };
    }
  }

  /** the redacted tail of the managed container's log; only a container that carries this project's labels */
  async logs(tail: number): Promise<{ lines: string[] } | { error: 'no_container' }> {
    const c = this.d.updater.mediaState().container;
    const r = await this.ready();
    if (!c || !r) return { error: 'no_container' };
    try {
      const labels = ((await this.d.engine.inspectContainer(c.id))?.Config as { Labels?: Record<string, unknown> } | undefined)?.Labels;
      if (labels?.['friendflix.managed'] !== 'mediaserver' || labels['friendflix.project'] !== r.project) return { error: 'no_container' };
      const lines = await this.d.engine.logs(c.id, Math.max(1, Math.min(500, Math.trunc(tail))));
      return { lines: lines.map(redactLine) };
    } catch {
      return { error: 'no_container' };
    }
  }
}
