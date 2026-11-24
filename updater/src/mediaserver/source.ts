// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { StepError } from '../docker.js';
import type { Engine } from './engine.js';
import { isMigratedTarget, isRel } from './paths.js';
import type { Folder, MediaError, RecordedSource } from './types.js';

/**
 * The Jellyfin to move (stage 2 "Finding the source", "Reading the source", "Media paths"): the containers on this engine that run a
 * Jellyfin image, their `/config` and media mounts as Docker records them, and the scan helper's answer on that `/config` (mounted
 * read-only). A container is the source only when its image is a Jellyfin image, it is none of ours, and the server id in its
 * `/config` equals the one FriendFlix uses. Host paths and server ids stay in here and in the recorded state: never in a log line,
 * an error message or an op answer.
 */

/** the image repositories a source may run (any tag or digest) */
export const JELLYFIN_REPOS = ['jellyfin/jellyfin', 'docker.io/jellyfin/jellyfin', 'linuxserver/jellyfin', 'lscr.io/linuxserver/jellyfin'] as const;
/** at most this many candidates are scanned for their server id in one candidate list */
export const MAX_SCANNED = 5;
/** at most this many media folders (as parse.ts and jobs.ts) */
const MAX_FOLDERS = 20;

export interface Candidate { id: string; name: string; image: string; state: string }
export type SourceConfig = RecordedSource['config'];
export type Layout = 'official' | 'linuxserver';
export interface ScanResult { source: RecordedSource; folders: Folder[]; bytes: number; trickplayBytes: number; plugins: string[]; nfo: boolean; layout: Layout }
export interface Mounts { config: SourceConfig | null; media: Folder[]; outside: string[]; refused: string[]; nested: string[] }

/** a scan failure; container paths only: `outside` / `refused` for source_outside_base, `nested` for source_nested */
export class SourceError extends StepError {
  constructor(code: MediaError, readonly outside: string[] = [], readonly refused: string[] = [], readonly nested: string[] = []) { super(code); }
}

export interface SourceDeps {
  engine: Engine;
  /** the confirmed base folder (host path); null before one is confirmed */
  base: { path: string } | null;
  now(): number;
  /**
   * the `migrate-scan` helper on this `/config`, mounted read-only at /source; its JSON answer (a StepError with its code otherwise).
   * `id`: only the layout and the server id (fast; candidate lists and rematch); `sized`: also sizes, plugins and nfo (the chosen one)
   */
  scan(config: SourceConfig, mode: 'id' | 'sized'): Promise<Record<string, unknown>>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const fail = (code: MediaError): never => { throw new SourceError(code); };

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const SERVER_ID_RE = /^[0-9a-f]{32}$/;
/** a version-like label or tag (`latest`, `release` say nothing) */
const VERSION_RE = /^v?[0-9][0-9A-Za-z.+_-]{0,63}$/;
const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
/** an absolute, normalised host path other than `/` */
const HOST_PATH_RE = /^(\/[^/]+)+$/;
const isHostPath = (p: string): boolean => HOST_PATH_RE.test(p) && !p.split('/').some((c) => c === '.' || c === '..');
/** the container's time files: not media (the migrated server gets TZ) */
const TIME_FILES = ['/etc/localtime', '/etc/timezone'];

/** the repository of an image reference: without `@digest` and without `:tag` (a registry port is not a tag) */
export function repoOf(image: string): string {
  const at = image.indexOf('@');
  const ref = at >= 0 ? image.slice(0, at) : image;
  const colon = ref.lastIndexOf(':');
  return colon > ref.lastIndexOf('/') ? ref.slice(0, colon) : ref;
}
function tagOf(image: string): string | null {
  const at = image.indexOf('@');
  const ref = at >= 0 ? image.slice(0, at) : image;
  const colon = ref.lastIndexOf(':');
  return colon > ref.lastIndexOf('/') ? ref.slice(colon + 1) : null;
}

const isJellyfin = (image: string): boolean => (JELLYFIN_REPOS as readonly string[]).includes(repoOf(image));
/** containers FriendFlix created (the managed server, helpers, HDR runs, seeds) are never a source */
const ours = (labels: unknown): boolean => isObj(labels) && 'friendflix.managed' in labels;
const configImage = (i: Obj): string => (isObj(i.Config) ? str(i.Config.Image) : '');

/** a container that may be the source: a Jellyfin image (Config.Image, the reference it was created from), none of ours */
function candidateOf(i: Obj | null): i is Obj {
  return i !== null && CONTAINER_ID_RE.test(str(i.Id)) && isJellyfin(configImage(i)) && !ours(isObj(i.Config) ? i.Config.Labels : undefined);
}

/** every candidate with its inspect, running ones first, then by name */
async function candidates(engine: Engine): Promise<Array<{ c: Candidate; inspect: Obj }>> {
  const out: Array<{ c: Candidate; inspect: Obj }> = [];
  for (const l of await engine.allContainers()) {
    if (ours(l.labels) || !CONTAINER_ID_RE.test(l.id)) continue;
    // the list shows an image id when the reference moved on; a reference without "jellyfin" in it cannot match
    if (!l.image.includes('jellyfin') && !IMAGE_ID_RE.test(l.image) && !/^[0-9a-f]{12,64}$/.test(l.image)) continue;
    const i = await engine.inspectContainer(l.id).catch(() => null);
    if (!candidateOf(i) || i.Id !== l.id) continue;
    const state = isObj(i.State) && typeof i.State.Status === 'string' ? i.State.Status : l.state;
    out.push({ c: { id: l.id, name: str(i.Name).replace(/^\//, '') || (l.names[0] ?? ''), image: configImage(i), state }, inspect: i });
  }
  const rank = (s: string): number => (s === 'running' ? 0 : 1);
  return out.sort((a, b) => rank(a.c.state) - rank(b.c.state) || a.c.name.localeCompare(b.c.name));
}

/** the Jellyfin containers on this engine (running or stopped), repository match on Config.Image without tag or digest */
export async function findCandidates(engine: Engine): Promise<Candidate[]> {
  return (await candidates(engine)).map((x) => x.c);
}

const inspectMounts = (i: Obj): Obj[] => (Array.isArray(i.Mounts) ? i.Mounts.filter(isObj) : []);

/** the `/config` mount as Docker records it: a bind's host path or a named volume; null when there is none (or anything else) */
function configOf(i: Obj): SourceConfig | null {
  const m = inspectMounts(i).find((x) => x.Destination === '/config');
  if (m?.Type === 'bind' && isHostPath(str(m.Source))) return { type: 'bind', source: str(m.Source) };
  if (m?.Type === 'volume' && VOLUME_NAME_RE.test(str(m.Name))) return { type: 'volume', source: str(m.Name) };
  return null;
}

/** a mount that is neither the config nor media: cache, transcodes, devices, the Docker socket, tmpfs, the time files */
function skipped(m: Obj): boolean {
  const type = str(m.Type);
  const src = str(m.Source);
  const dst = str(m.Destination);
  if (type === 'tmpfs') return true;
  if (dst === '/cache' || dst.startsWith('/cache/') || dst.split('/').some((c) => /^transcodes?$/i.test(c))) return true;
  if ([src, dst].some((p) => p === '/dev' || p.startsWith('/dev/'))) return true;
  if ([src, dst].some((p) => /docker\.sock|containerd/.test(p))) return true;
  return type === 'bind' && TIME_FILES.includes(dst);
}

/** the host path behind a media mount: a bind's source, or a local volume's `device` (looked up by the caller); null otherwise */
function hostOf(m: Obj, devices: Readonly<Record<string, string>>): string | null {
  if (m.Type === 'bind') return str(m.Source);
  if (m.Type === 'volume') return devices[str(m.Name)] ?? null;
  return null;
}

/**
 * The source container's mounts against the confirmed base: `/config` (bind source or volume name, as Docker records it); every media
 * mount inside the base as a migrated folder at the container path Jellyfin uses (`rel` '' for the base itself). `outside` holds the
 * container path of every media mount that cannot be kept (outside the base, or refused); `refused` those inside the base whose
 * container path a migrated Ferrofin may not use (isMigratedTarget, nested below another, or too deep below the base). `devices`:
 * the host path of each local bind volume by name.
 */
export function classifyMounts(inspect: Obj, base: { path: string }, devices: Readonly<Record<string, string>> = {}): Mounts {
  const kept: Folder[] = [];
  const outside: string[] = [];
  const refused: string[] = [];
  for (const m of inspectMounts(inspect)) {
    const dst = str(m.Destination);
    if (dst === '/config' || skipped(m)) continue;
    const host = hostOf(m, devices);
    const inside = host !== null && isHostPath(host) && isHostPath(base.path) && (host === base.path || host.startsWith(base.path + '/'));
    if (!inside) { outside.push(dst); continue; }
    const rel = host === base.path ? '' : host.slice(base.path.length + 1);
    if (!isMigratedTarget(dst) || !isRel(rel, 0, 3)) { refused.push(dst); continue; }
    kept.push({ rel, target: dst, migrated: true });
  }
  const { media, nested } = unnest(kept);
  refused.sort();
  return { config: configOf(inspect), media, outside: [...outside, ...refused].sort(), refused, nested };
}

/** `rel` lies below `parent` (the base itself, '', is above every other folder) */
const relBelow = (rel: string, parent: string): boolean => (parent === '' ? rel !== '' : rel.startsWith(parent + '/'));

/**
 * Overlapping media mounts: an inner mount at exactly the path where its outer one already shows the same folder (`/movies` ←
 * Filme and `/movies/4K` ← Filme/4K) adds nothing and is dropped. Any other overlap (a target below another showing another folder,
 * one folder at two paths, a folder and its parent at unrelated paths) is `nested`: the move cannot keep both paths the database knows.
 */
function unnest(kept: Folder[]): { media: Folder[]; nested: string[] } {
  const redundant = new Set<Folder>();
  const nested = new Set<string>();
  for (const f of kept) {
    for (const g of kept) {
      if (f === g) continue;
      if (f.target.startsWith(g.target + '/')) {
        const sub = f.target.slice(g.target.length + 1);
        if (f.rel === (g.rel === '' ? sub : `${g.rel}/${sub}`)) redundant.add(f);
        else { nested.add(f.target); nested.add(g.target); }
      } else if (!g.target.startsWith(f.target + '/') && (f.rel === g.rel || relBelow(f.rel, g.rel))) {
        nested.add(f.target); nested.add(g.target);
      }
    }
  }
  return { media: kept.filter((f) => !redundant.has(f)), nested: [...nested].sort() };
}

/** the host path of each local volume among the mounts that is a bind (`device` an absolute host path, `o` with `bind`) */
async function devicesOf(engine: Engine, i: Obj): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of inspectMounts(i)) {
    if (m.Type !== 'volume' || m.Destination === '/config' || skipped(m)) continue;
    const name = str(m.Name);
    if (!VOLUME_NAME_RE.test(name) || (m.Driver !== undefined && m.Driver !== 'local')) continue;
    const v = await engine.inspectVolume(name).catch(() => null);
    const o = v?.options ?? {};
    const device = o.device ?? '';
    if ((o.type === undefined || o.type === 'none') && (o.o ?? '').split(',').includes('bind') && isHostPath(device)) out[name] = device;
  }
  return out;
}

/** the id-only answer: the layout and the server id */
function parseId(a: Record<string, unknown>): { layout: Layout; serverId: string } {
  const { layout, serverId } = a;
  if ((layout !== 'official' && layout !== 'linuxserver') || typeof serverId !== 'string' || !SERVER_ID_RE.test(serverId)) fail('helper_failed');
  return { layout: layout as Layout, serverId: serverId as string };
}

/** the helper's sized answer, checked field by field; anything else is helper_failed */
function parseScan(a: Record<string, unknown>): { layout: Layout; serverId: string; bytes: number; trickplayBytes: number; plugins: string[]; nfo: boolean } {
  const size = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const { layout, serverId, bytes, trickplayBytes, plugins, nfo } = a;
  parseId(a);
  if (!size(bytes) || !size(trickplayBytes) || typeof nfo !== 'boolean' || !Array.isArray(plugins) || plugins.length > 50 || !plugins.every((p) => typeof p === 'string' && p.length <= 100)) fail('helper_failed');
  return { layout: layout as Layout, serverId: serverId as string, bytes: bytes as number, trickplayBytes: trickplayBytes as number, plugins: plugins as string[], nfo: nfo as boolean };
}

/** the Jellyfin version: the image's `org.opencontainers.image.version` label, else the reference's tag, else null */
async function versionOf(engine: Engine, i: Obj): Promise<string | null> {
  const id = str(i.Image);
  const img = IMAGE_ID_RE.test(id) ? await engine.inspectImage(id).catch(() => null) : null;
  const label = img?.labels['org.opencontainers.image.version'];
  if (label !== undefined && VERSION_RE.test(label)) return label;
  const tag = tagOf(configImage(i));
  return tag !== null && VERSION_RE.test(tag) ? tag : null;
}

/** the server id in this container's /config (an id-only scan); null when it has none or cannot be scanned */
export async function serverIdOf(deps: Pick<SourceDeps, 'scan'>, config: SourceConfig | null): Promise<string | null> {
  if (!config) return null;
  try { return parseId(await deps.scan(config, 'id')).serverId; } catch { return null; }
}

/**
 * Scans the candidate `id` as the source: source_missing (no such Jellyfin container, or one of ours), source_layout (no /config,
 * or the helper found no known layout), source_mismatch (another server than `expectServerId`), source_outside_base (a media mount
 * that cannot be kept; container paths in the error). The /config is only ever mounted read-only into the helper.
 */
export async function scanSource(deps: SourceDeps, id: string, expectServerId: string): Promise<ScanResult> {
  const base = deps.base ?? fail('no_base');
  if (!CONTAINER_ID_RE.test(id)) fail('source_missing');
  const i = await deps.engine.inspectContainer(id);
  if (!candidateOf(i) || i.Id !== id) return fail('source_missing');
  const config = configOf(i) ?? fail('source_layout');
  const scan = parseScan(await deps.scan(config, 'sized'));
  if (scan.serverId !== expectServerId) fail('source_mismatch');
  const m = classifyMounts(i, base, await devicesOf(deps.engine, i));
  if (m.outside.length > 0) throw new SourceError('source_outside_base', m.outside, m.refused);
  if (m.nested.length > 0) throw new SourceError('source_nested', [], [], m.nested);
  if (m.media.length > MAX_FOLDERS) fail('too_many_folders');
  const source: RecordedSource = {
    id, name: str(i.Name).replace(/^\//, ''), image: configImage(i), config, serverId: scan.serverId,
    version: await versionOf(deps.engine, i), at: new Date(deps.now()).toISOString(),
  };
  return { source, folders: m.media, layout: scan.layout, bytes: scan.bytes, trickplayBytes: scan.trickplayBytes, plugins: scan.plugins, nfo: scan.nfo };
}

const sameConfig = (a: SourceConfig | null, b: SourceConfig): boolean => a !== null && a.type === b.type && a.source === b.source;

/**
 * The recorded source today (stage 2 "A recreated source"): a Jellyfin candidate (none of ours) with the same /config mount source,
 * where an id-only scan of that /config finds the recorded server id. The recorded id when it is among them; otherwise exactly one
 * other (several = not decidable = null). Null as well while any other container on that /config runs, whatever its image: starting
 * the source next to it would put two servers on one database. The caller replaces the recorded id and audits it.
 */
export async function rematch(deps: Pick<SourceDeps, 'engine' | 'scan'>, recorded: RecordedSource): Promise<string | null> {
  const found = (await candidates(deps.engine)).filter((x) => sameConfig(configOf(x.inspect), recorded.config)).map((x) => x.c.id);
  const chosen = found.includes(recorded.id) ? recorded.id : found.length === 1 ? found[0]! : null;
  if (chosen === null) return null;
  for (const l of await deps.engine.allContainers()) {
    if (l.id === chosen || l.state !== 'running') continue;
    const i = await deps.engine.inspectContainer(l.id).catch(() => null);
    // a running container that cannot be read may be on the same /config: not decidable
    if (i === null || sameConfig(configOf(i), recorded.config)) return null;
  }
  // they all mount the one /config: one scan answers for all of them
  return (await serverIdOf(deps, recorded.config)) === recorded.serverId ? chosen : null;
}

/**
 * how many containers on this engine (any image, running or not) mount this /config: 0 means the recorded source is gone for good
 * (nothing could become it again); an inspect that fails throws (not decidable now, never read as gone)
 */
export async function onConfig(engine: Engine, config: SourceConfig): Promise<number> {
  let n = 0;
  for (const l of await engine.allContainers()) {
    const i = await engine.inspectContainer(l.id);
    if (i && sameConfig(configOf(i), config)) n++;
  }
  return n;
}

/** the candidate list for the move sheet: each with `matches` from a scan of its server id (the first MAX_SCANNED; null beyond) */
export async function listCandidates(deps: Pick<SourceDeps, 'engine' | 'scan'>, expectServerId: string): Promise<Array<Candidate & { matches: boolean | null }>> {
  const all = await candidates(deps.engine);
  return Promise.all(all.map(async (x, k) => {
    if (k >= MAX_SCANNED) return { ...x.c, matches: null };
    return { ...x.c, matches: (await serverIdOf(deps, configOf(x.inspect))) === expectServerId };
  }));
}
