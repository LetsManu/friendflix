// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '../config.js';
import { mediaBrowserHeader } from '../media/mediaBrowser.js';
import { MediaSetupError } from '../media/types.js';
import { smallJson } from '../settings/probeKit.js';
import type { LibraryEntry } from './store.js';

/**
 * The managed media server's own API as the first run and the library routes use it (spec "First run", "Folder changes after the first
 * run"): the startup wizard, libraries and the encoding settings. Ferrofin speaks Jellyfin's API. Every request has a 5 s deadline and
 * never follows a redirect; a failure is a MediaSetupError naming its code only (never server text, a password or a key).
 */

/** the managed server on the internal `media` network (hostname `mediaserver`, never published) */
export const MANAGED_URL = 'http://mediaserver:8096';
/** each request's deadline (a move's tick lock is sized from it: mediaserver/move.ts) */
export const TIMEOUT_MS = 5_000;
const DEVICE_ID = 'friendflix-managed';
const ITEM_ID = /^[0-9a-f]{32}$/;
const SERVER_ID = /^[0-9a-f]{32}$/;
const RENDER_NODE = /^renderD[0-9]{1,4}$/;
const PAGE = 2_000;
const MAX_ITEMS = 200_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const cancel = (r: Response) => void r.body?.cancel().catch(() => undefined);

/** the managed connection when the settings point at the managed server and hold a key; null otherwise */
export function managedKey(cfg: Pick<Config, 'JELLYFIN_URL' | 'JELLYFIN_ADMIN_API_KEY'>): string | null {
  return cfg.JELLYFIN_URL === MANAGED_URL && cfg.JELLYFIN_ADMIN_API_KEY ? cfg.JELLYFIN_ADMIN_API_KEY : null;
}

interface CallOpts { key?: string; body?: unknown; ok404?: boolean }

/** one request; unreachable (network, deadline, redirect), unauthorized (401/403) or unexpected (any other non-2xx) */
async function call(f: typeof fetch, base: string, method: 'GET' | 'POST' | 'DELETE', path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: mediaBrowserHeader({ device: 'Setup', deviceId: DEVICE_ID, token: o.key }), accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  let r: Response;
  try {
    r = await f(`${base}${path}`, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  } catch {
    throw new MediaSetupError('unreachable');
  }
  if (r.ok || (o.ok404 && r.status === 404)) return r;
  cancel(r);
  if (r.status >= 300 && r.status < 400) throw new MediaSetupError('unreachable', 'redirect');
  if (r.status === 401 || r.status === 403) throw new MediaSetupError('unauthorized');
  // the status as detail (a server still starting answers 5xx; a move's phases retry those)
  throw new MediaSetupError('unexpected', `http_${r.status}`);
}

/** a JSON body within the deadline; a stalled or oversized body is unreachable */
const json = (r: Response, max: number): Promise<unknown> => smallJson(r, max).catch(() => { throw new MediaSetupError('unreachable', 'bad_response'); });
const done = async (r: Response): Promise<void> => cancel(r);

/**
 * `/System/Info/Public`: whether the startup wizard is complete and the server id (32 hex, null when it is none; stage 2 matches the
 * Jellyfin to move by it, it never reaches an answer or a log); null while the server does not answer (or not as expected)
 */
export async function publicInfo(f: typeof fetch, base: string): Promise<{ wizardDone: boolean; id: string | null } | null> {
  try {
    const r = await call(f, base, 'GET', '/System/Info/Public');
    const o = obj(await json(r, 64 * 1024));
    // the id as the updater's scan reads it from the server's files: lower case, without dashes
    const id = typeof o?.Id === 'string' ? o.Id.toLowerCase().replace(/-/g, '') : '';
    return o ? { wizardDone: o.StartupWizardCompleted === true, id: SERVER_ID.test(id) ? id : null } : null;
  } catch {
    return null;
  }
}

/**
 * Jellyfin's startup wizard through its API (spec "First run" 3): configuration, the first user (GET /Startup/User creates it), remote
 * access off, complete. Every step may run again (a restart in the middle): the configuration and the user are overwritten. A wizard
 * that is already complete (or completes meanwhile: the endpoints then need an administrator) is `wizard_taken`.
 */
export async function startupWizard(f: typeof fetch, base: string, o: { name: string; password: string; culture: string; language: string; country: string }): Promise<void> {
  const info = await publicInfo(f, base);
  if (!info) throw new MediaSetupError('unreachable');
  if (info.wizardDone) throw new MediaSetupError('wizard_taken');
  const step = (method: 'GET' | 'POST', path: string, body?: unknown) => call(f, base, method, path, { body }).then(done, (e: unknown) => {
    throw e instanceof MediaSetupError && e.code === 'unauthorized' ? new MediaSetupError('wizard_taken') : e;
  });
  await step('POST', '/Startup/Configuration', { UICulture: o.culture, MetadataCountryCode: o.country, PreferredMetadataLanguage: o.language });
  await step('GET', '/Startup/User');
  await step('POST', '/Startup/User', { Name: o.name, Password: o.password });
  // the server is reachable only on internal networks (no published port); requests from them count as local
  await step('POST', '/Startup/RemoteAccess', { EnableRemoteAccess: false, EnableAutomaticPortMapping: false });
  await step('POST', '/Startup/Complete');
}

/**
 * Whether `name` / `password` sign in (a wizard found complete may be FriendFlix's own from an earlier run, spec ruling on
 * `wizard_taken`). The session is ended at once. false only for a refused sign-in; anything else throws.
 */
export async function signsIn(f: typeof fetch, base: string, name: string, password: string): Promise<boolean> {
  let r: Response;
  try {
    r = await call(f, base, 'POST', '/Users/AuthenticateByName', { body: { Username: name, Pw: password } });
  } catch (e) {
    if (e instanceof MediaSetupError && e.code === 'unauthorized') return false;
    throw e;
  }
  const token = obj(await json(r, 256 * 1024))?.AccessToken;
  if (typeof token !== 'string' || !token) throw new MediaSetupError('unexpected');
  await call(f, base, 'POST', '/Sessions/Logout', { key: token }).then(done, () => undefined);
  return true;
}

interface Folder { name: string; itemId: string | null; locations: string[] }
async function virtualFolders(f: typeof fetch, base: string, key: string): Promise<Folder[]> {
  const list = await json(await call(f, base, 'GET', '/Library/VirtualFolders', { key }), 1024 * 1024);
  if (!Array.isArray(list)) throw new MediaSetupError('unexpected');
  return list.flatMap((x) => {
    const o = obj(x);
    if (typeof o?.Name !== 'string') return [];
    const locations = Array.isArray(o.Locations) ? o.Locations.filter((l): l is string => typeof l === 'string') : [];
    return [{ name: o.Name, itemId: typeof o.ItemId === 'string' && ITEM_ID.test(o.ItemId) ? o.ItemId : null, locations }];
  });
}
const q = (v: Record<string, string>) => new URLSearchParams(v).toString();

/**
 * The library of an entry (spec "First run" 5): `/media/<slug>`, real-time monitoring on, no local metadata and no savers (the media is
 * read-only), the instance's metadata language. A no-op when a library of that name exists on that folder (a restart after the post, a
 * surviving server); `library_name_taken` when a library of that name exists on another folder (its folder would get no library).
 */
export async function ensureLibrary(f: typeof fetch, base: string, key: string, lib: LibraryEntry, o: { language: string; country: string }): Promise<void> {
  const path = `/media/${lib.slug}`;
  const same = (await virtualFolders(f, base, key)).find((v) => v.name === lib.name);
  if (same?.locations.includes(path)) return;
  if (same) throw new MediaSetupError('library_name_taken');
  const query = q({ name: lib.name, collectionType: lib.type, paths: path, refreshLibrary: 'false' });
  const LibraryOptions = { EnableRealtimeMonitor: true, SaveLocalMetadata: false, MetadataSavers: [], PreferredMetadataLanguage: o.language, MetadataCountryCode: o.country };
  await call(f, base, 'POST', `/Library/VirtualFolders?${query}`, { key, body: { LibraryOptions } }).then(done);
}

/** renames a library in place (its items keep their ids); a no-op when `to` exists already */
export async function renameLibrary(f: typeof fetch, base: string, key: string, from: string, to: string): Promise<void> {
  const names = (await virtualFolders(f, base, key)).map((v) => v.name);
  if (names.includes(to) && !names.includes(from)) return;
  await call(f, base, 'POST', `/Library/VirtualFolders/Name?${q({ name: from, newName: to, refreshLibrary: 'false' })}`, { key }).then(done);
}

/** deletes a library in the server (its files stay); a no-op when there is none of that name */
export async function deleteLibrary(f: typeof fetch, base: string, key: string, name: string): Promise<void> {
  if (!(await virtualFolders(f, base, key)).some((v) => v.name === name)) return;
  await call(f, base, 'DELETE', `/Library/VirtualFolders?${q({ name, refreshLibrary: 'false' })}`, { key }).then(done);
}

/**
 * every item id below the library `name` (movies, series, seasons, episodes …), page by page; none when there is no such library;
 * `unexpected` when there may be more than `max` (never a short count)
 */
export async function libraryItemIds(f: typeof fetch, base: string, key: string, name: string, max = MAX_ITEMS): Promise<string[]> {
  const folder = (await virtualFolders(f, base, key)).find((v) => v.name === name);
  if (!folder?.itemId) return [];
  const ids: string[] = [];
  for (let start = 0; ; start += PAGE) {
    // more items than counted: an under-count could let a referenced library be renamed, so it fails (the caller refuses)
    if (start >= max) throw new MediaSetupError('unexpected', 'too_many_items');
    const query = q({ ParentId: folder.itemId, Recursive: 'true', EnableImages: 'false', EnableUserData: 'false', EnableTotalRecordCount: 'false', StartIndex: String(start), Limit: String(PAGE) });
    const items = obj(await json(await call(f, base, 'GET', `/Items?${query}`, { key }), 16 * 1024 * 1024))?.Items;
    if (!Array.isArray(items)) throw new MediaSetupError('unexpected');
    for (const i of items) {
      const id = obj(i)?.Id;
      if (typeof id === 'string' && ITEM_ID.test(id)) ids.push(id);
    }
    if (items.length < PAGE) break;
  }
  return ids;
}

type Hw = 'qsv' | 'vaapi' | 'nvenc' | 'none';
const CODECS: Record<'intel' | 'amd' | 'other' | 'nvidia' | 'off', string[]> = {
  intel: ['h264', 'hevc', 'mpeg2video', 'vc1', 'vp8', 'vp9', 'av1'],
  amd: ['h264', 'hevc', 'mpeg2video', 'vc1', 'vp9', 'av1'],
  // another (or an undetected) VA-API vendor: only what every VA-API decoder does
  other: ['h264', 'hevc'],
  nvidia: ['h264', 'hevc', 'mpeg2video', 'mpeg4', 'vc1', 'vp8', 'vp9', 'av1'],
  off: [],
};

/**
 * The server's encoding settings for the chosen GPU (spec "GPU"): Intel QSV, AMD VA-API on the render node, another or an undetected
 * vendor VA-API with H.264 and HEVC decoding only, NVIDIA NVENC, off software; tone mapping bt2390, hardware decoding for the vendor's
 * codecs. Every other field is kept as it is.
 */
export async function setEncoding(f: typeof fetch, base: string, key: string, hw: { gpu: 'off' | 'dri' | 'nvidia'; vendor: 'intel' | 'amd' | 'other' | null; node: string | null }): Promise<void> {
  const current = obj(await json(await call(f, base, 'GET', '/System/Configuration/encoding', { key }), 256 * 1024));
  if (!current) throw new MediaSetupError('unexpected');
  const vendor = hw.gpu === 'off' ? 'off' : hw.gpu === 'nvidia' ? 'nvidia' : hw.vendor ?? 'other';
  const type: Hw = vendor === 'off' ? 'none' : vendor === 'nvidia' ? 'nvenc' : vendor === 'intel' ? 'qsv' : 'vaapi';
  const next: Obj = {
    ...current, HardwareAccelerationType: type, EnableTonemapping: true, TonemappingAlgorithm: 'bt2390', HardwareDecodingCodecs: CODECS[vendor],
    ...(hw.gpu === 'dri' ? { VaapiDevice: `/dev/dri/${hw.node && RENDER_NODE.test(hw.node) ? hw.node : 'renderD128'}` } : {}),
  };
  await call(f, base, 'POST', '/System/Configuration/encoding', { key, body: next }).then(done);
}

/** a scan of every library */
export async function refreshLibraries(f: typeof fetch, base: string, key: string): Promise<void> {
  await call(f, base, 'POST', '/Library/Refresh', { key }).then(done);
}

/** the libraries one call of nfoSaversOff changes at most (bounds a tick: mediaserver/move.ts sizes its lock from it) */
export const NFO_PER_CALL = 6;

/**
 * A move's `nfo` phase (stage 2 "The move" 7; the recipe in mediaserver/try.sh): the migrated media are mounted read-only, so every
 * library whose options save local metadata or name metadata savers (or name none: the server's defaults, the NFO saver among them)
 * gets `SaveLocalMetadata: false` and `MetadataSavers: []`, its other options kept. Libraries already off are left alone, so a second
 * run posts nothing. At most `max` libraries per call; returns how many are still on afterwards (0: done; the caller calls again).
 */
export async function nfoSaversOff(f: typeof fetch, base: string, key: string, max = NFO_PER_CALL): Promise<number> {
  const list = await json(await call(f, base, 'GET', '/Library/VirtualFolders', { key }), 1024 * 1024);
  if (!Array.isArray(list)) throw new MediaSetupError('unexpected');
  let left = 0;
  for (const x of list) {
    const o = obj(x);
    const options = obj(o?.LibraryOptions) ?? {};
    const savers = options.MetadataSavers;
    if (options.SaveLocalMetadata === false && Array.isArray(savers) && savers.length === 0) continue;
    // a library without an id cannot be changed: its saver would stay on (fail closed)
    if (typeof o?.ItemId !== 'string' || !ITEM_ID.test(o.ItemId)) throw new MediaSetupError('unexpected');
    if (max <= 0) { left++; continue; }
    await call(f, base, 'POST', '/Library/VirtualFolders/LibraryOptions', { key, body: { Id: o.ItemId, LibraryOptions: { ...options, SaveLocalMetadata: false, MetadataSavers: [] } } }).then(done);
    max--;
  }
  return left;
}
