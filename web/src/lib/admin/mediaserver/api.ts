// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The managed media server's routes (backend routes/adminMediaserver.ts) for the card *Medienserver* (Admin → Einstellungen →
 * Medienserver) and the wizard's media step: one interface, two bindings. `adminMediaApi` calls `/api/admin/mediaserver…` with the
 * app's CSRF header (api()); `setupMediaApi()` calls `/api/setup/mediaserver…` under the setup session with its CSRF header and
 * refuses what the wizard has no route for (`not_supported`, before anything is sent). Refusals arrive as ApiError (status + code);
 * the backend answers codes only. The two backup streams go through fetch() directly: the download is never read into memory as a
 * whole, the upload is the file as it is (application/octet-stream), and the passphrase rides in `x-ff-backup-passphrase` as
 * base64url of its UTF-8 bytes (Controller's call 2), never in a URL or a body.
 */
import { api, ApiError, getCsrf } from '#lib/api';
import { CSRF_COOKIE, CSRF_HEADER, readCookie } from '#lib/setup/api';
import { isMediaJob, type UpdaterJob, type UpdaterView } from '../updater';

export type Kind = 'ferrofin' | 'jellyfin';
export type Gpu = 'off' | 'dri' | 'nvidia';
export type LibraryType = 'movies' | 'tvshows' | 'music' | 'mixed';
export type SetupStep = 'none' | 'applying' | 'first_run' | 'api_key' | 'libraries' | 'hwaccel' | 'finishing' | 'done' | 'failed';
export type OfferReason = 'no_updater' | 'plex' | 'url_pinned' | 'ids_in_use' | 'engine_old' | 'proxy_outdated' | 'no_project' | 'no_network' | 'updater_outdated' | 'starting';
/** `ffmedia`: a folder added after a move, mounted at `/ffmedia/<slug>` (else `/media/<slug>`) */
export interface LibraryEntry { slug: string; name: string; type: LibraryType; rel: string; created: boolean; ffmedia?: true }
export interface LibraryReferences { lists: number; resume: number; recordings: number }
/** `createdAt`, uploads only: when the archive was made (`at` is when it was uploaded) */
export interface MediaBackup { id: string; kind: Kind; upstream: string; at: string; tag: 'manual' | 'auto' | 'upload'; size: number; createdAt?: string }
/** a folder of the media server; `migrated`: one a move took over (its target is the path the old Jellyfin used, `rel` '' the whole base) */
export interface MediaFolder { rel: string; target: string; migrated?: true }
/** the steps of the updater's move job (backend updater.ts MEDIA_STEPS: the media job's own plus the move's) */
export type MoveJobStep = 'check' | 'pull' | 'verify' | 'snapshot' | 'create' | 'start' | 'health' | 'rollback' | 'copy_bulk' | 'stop_source' | 'copy' | 'adopt';
/** backend mediaserver/client.ts MediaStatus */
export interface MediaStatus {
  available: boolean;
  /** `starting`: the updater has read no media status yet since it started */
  reason: 'engine_old' | 'no_logs' | 'no_project' | 'no_network' | 'starting' | null;
  base: { set: boolean; path: string | null; pending: boolean; expiresAt: string | null };
  desired: { kind: Kind; folders: MediaFolder[]; uid: number; gid: number; gpu: Gpu; mediaGid: number | null; egress: boolean; run: boolean; migrated?: true } | null;
  container: { state: string; health: 'healthy' | 'unhealthy' | 'starting' | ''; kind: Kind; image: { digest: string; upstream: string }; template: 'current' | 'update_pending'; tampered: boolean; createdAt: string } | null;
  pin: { image: string | null; upstream: string | null; changed: boolean } | null;
  pins: { ferrofin: boolean; jellyfin: boolean };
  engine: { api: string | null; logs: boolean; arch: string | null; nvidia: boolean };
  error: string | null;
  backups: MediaBackup[];
  hdr: { kind: Kind; at: string; opencl: 'pass' | 'fail'; qsv: 'pass' | 'fail' } | null;
  /** the updater's move (stage 2): its phase, the step of its job; absent from an older backend */
  move?: { phase: 'running' | 'ready' | 'aborted' | 'done'; step: MoveJobStep | null; source: { name: string; version: string | null }; folders: MediaFolder[]; abort: boolean } | null;
  /** the Jellyfin a move came from as Docker shows it now (`missing`: no container mounts its config any more) */
  source?: { name: string; state: string; version: string | null } | null;
  /** the Ferrofin data volume holds the copy of a move that did not finish (*Entfernen* with the data removes it) */
  moveCopy?: boolean;
}

// ------------------------------------------------------------------ the move from Jellyfin (stage 2)
/** a Jellyfin container on the updater's engine; `matches`: its server id is the one FriendFlix uses (null: not scanned) */
export interface MoveCandidate { id: string; name: string; image: string; state: string; matches: boolean | null }
/** the chosen candidate scanned: its media folders as Ferrofin will see them, the copy's size (without trickplay), the plugins left behind */
export interface MoveScan {
  source: { id: string; name: string; image: string; version: string | null }; folders: MediaFolder[]; layout: 'official' | 'linuxserver';
  bytes: number; trickplayBytes: number; plugins: string[]; nfo: boolean;
}
/** the background scan of one candidate (backend mediaserver/move.ts MoveScanRecord); a refusal names its code and container paths */
export interface MoveScanRecord {
  source: string; state: 'running' | 'done' | 'failed'; result?: MoveScan; error?: string; outside?: string[]; refused?: string[]; nested?: string[]; at: string;
}
export type MovePhase = 'copying' | 'nfo' | 'verify' | 'switch' | 'requests' | 'done' | 'failed';
/** the way back as far as it got (`failed`: it changed nothing, its code in `backError`) */
export type BackStep = 'starting' | 'switched' | 'stopped' | 'done' | 'failed';
export interface IdCheck { users: { total: number; missing: number }; items: { sampled: number; missing: number } }
/** the move as the backend follows it, with the step and abort flag of the updater's job (routes/adminMediaserver.ts MoveView.state) */
export interface MoveState {
  phase: MovePhase; error: string | null; jobId: string | null; startedAt: string; errorMeta?: IdCheck | { warning: 'updater_aborted' };
  back?: BackStep; backError?: string; step: MoveJobStep | null; abort: boolean;
  /** a failed move: the phase it failed (or was aborted) in */
  failedIn?: Exclude<MovePhase, 'done' | 'failed'>;
}
/** the Jellyfin a move came from (container name and version) and when */
export interface MigratedFrom { name: string; version: string | null; at: string }
/** backend routes/adminMediaserver.ts MoveView */
export interface MoveView {
  offered: boolean; reason: OfferReason | null; scan: MoveScanRecord | null; state: MoveState | null;
  migratedFrom: MigratedFrom | null; sourceState: string | null; requestsWarning: boolean;
  /** a request service is set up (the move points it over; absent from an older backend) */
  requests?: boolean;
}
/** backend mediaserver/store.ts MediaManaged */
export interface MediaManaged {
  kind: Kind | null; setup: SetupStep; setupError: string | null; adminUser: string | null; hasPassword: boolean;
  libraries: LibraryEntry[]; externalUrl: string | null; hasExternalKey: boolean; updatedAt: string | null;
}
/** backend routes/adminMediaserver.ts MediaView */
export interface MediaView {
  mode: 'managed' | 'external';
  offer: { managed: boolean; reason: OfferReason | null };
  kinds: { ferrofin: boolean; jellyfin: boolean };
  status: MediaStatus | null;
  managed: MediaManaged;
  external: { url: string | null; hasKey: boolean };
  livetvLibraryPath: string | null;
  /** the move from Jellyfin (stage 2); absent from an older backend */
  move?: MoveView;
}

export interface FolderInput { rel: string; name: string; type: LibraryType }
export interface ApplyInput { kind: Kind; folders: FolderInput[]; uid: number; gid: number; gpu: Gpu; mediaGid: number | null; egress: boolean }
/** the action bodies (backend S.adminAction; the wizard has retry and hdr-test) */
export type ActionBody =
  | { op: 'start' | 'stop' | 'restart' | 'update' | 'retry' }
  | { op: 'hdr-test'; kind: Kind }
  | { op: 'backup'; trickplay: boolean }
  | { op: 'restore'; id: string }
  | { op: 'remove'; data: boolean };
export type JobAnswer = { job?: UpdaterJob };
export interface BrowseEntry { name: string; symlink: boolean; unreadable: boolean }
export interface GpuInfo { dri: Array<{ node: string; gid: number; vendor: 'intel' | 'amd' | 'other' }>; nvidia: boolean }
export interface BaseRequest { pending: true; expiresAt: string | null; warning: 'base_unreadable' | null }
export interface BaseConfirm { result: 'ok'; path: string | null; kept: string[]; dropped: string[]; job: UpdaterJob | null }

export interface MediaApi {
  /** which binding (the card offers what the wizard cannot do only in the admin one) */
  readonly scope: 'admin' | 'setup';
  view(): Promise<MediaView>;
  /** the media job the updater ran last (admin: GET /api/admin/updater; the wizard has none: null) */
  lastJob(): Promise<UpdaterJob | null>;
  requestBase(path: string): Promise<BaseRequest>;
  confirmBase(code: string): Promise<BaseConfirm>;
  clearBase(): Promise<{ ok: true }>;
  browse(rel: string): Promise<{ entries: BrowseEntry[]; truncated: boolean }>;
  gpu(): Promise<GpuInfo>;
  apply(input: ApplyInput): Promise<JobAnswer>;
  action(body: ActionBody): Promise<JobAnswer | { ok: true }>;
  logs(tail: number): Promise<{ lines: string[] }>;
  libraries(): Promise<{ libraries: Array<LibraryEntry & { references: LibraryReferences | null }> }>;
  deleteLibrary(slug: string): Promise<{ ok: true }>;
  mode(restore: boolean): Promise<{ ok: true }>;
  /**
   * `target`: the file picked for it (pickSaveTarget, asked once on the click: a retry after a fresh sign-in reuses it, the browser
   * would refuse a second picker without the click); undefined = pick here, null = the browser has no picker (a download link)
   */
  download(id: string, passphrase: string, target?: SaveTarget | null): Promise<void>;
  upload(file: File, passphrase: string): Promise<{ backup: MediaBackup; job: UpdaterJob | null }>;
  /**
   * the move (admin only, stage 2): without `source` the Jellyfin containers at once; with one, its sized scan starts in the background
   * (202, the view's `move.scan` follows it). A refusal carries the container paths it names (`outside`, `refused`, `nested`).
   */
  moveScan(source?: string): Promise<{ candidates?: MoveCandidate[]; scan?: MoveScanRecord }>;
  /** the move of the scanned source (re-authentication); the view's `move.state` follows it */
  move(body: { source: string; trickplay: boolean }): Promise<JobAnswer>;
  moveAbort(): Promise<JobAnswer>;
  /** back to the old Jellyfin (re-authentication; 202, the view's `move.state.back` follows it) */
  back(): Promise<Record<string, never>>;
}

export const PASSPHRASE_HEADER = 'x-ff-backup-passphrase';

/** base64url (no padding) of the passphrase's UTF-8 bytes: the header value the backend decodes (mediaserver/client.ts decodePassphrase) */
export function encodePassphrase(p: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(p)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const json = async (res: Response): Promise<unknown> => {
  const text = await res.text().catch(() => '');
  try { return text ? JSON.parse(text) : null; } catch { return null; }
};

/** the file the person picked (File System Access API); `remove` where the browser has it */
export type SaveTarget = { createWritable(): Promise<WritableStream<Uint8Array>>; remove?(): Promise<void> };
type SavePicker = (o: { suggestedName: string }) => Promise<SaveTarget>;

/**
 * Asks where to save `<id>.tar.gz.age` (showSaveFilePicker), on the click itself: it needs the click's user activation. null when the
 * browser has no picker (the download then goes through a link). Cancelling rejects with an AbortError, a refused picker with a
 * SecurityError (model.ts saveErrorText).
 */
export async function pickSaveTarget(id: string): Promise<SaveTarget | null> {
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return picker ? picker({ suggestedName: `${id}.tar.gz.age` }) : null;
}

/** a picked file that got nothing (a refusal, a broken stream): removed where the browser can, never left empty or partial */
const discard = async (t: SaveTarget) => { try { await t.remove?.(); } catch { /* the browser keeps it: nothing more to do */ } };

/**
 * The encrypted backup to a file: streamed into the picked file when there is one, else through a Blob and an object URL (a download
 * link clicked once). A refusal is an ApiError with the backend's code and leaves no file; a stream that breaks aborts the writable
 * (pipeTo: nothing written is kept) and removes the file.
 */
async function saveDownload(path: string, id: string, headers: Record<string, string>, target: SaveTarget | null | undefined): Promise<void> {
  const name = `${id}.tar.gz.age`;
  const handle = target === undefined ? await pickSaveTarget(id) : target;
  const res = await fetch(path, { method: 'GET', credentials: 'same-origin', headers, cache: 'no-store' });
  if (!res.ok || !res.body) {
    if (handle) await discard(handle);
    throw new ApiError(res.status, await json(res));
  }
  if (handle) {
    try {
      await res.body.pipeTo(await handle.createWritable());
    } catch (e) {
      await discard(handle);
      throw e;
    }
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // the click has started the download: the URL may go once the browser took it
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

const P = '/api/admin/mediaserver';
/** the admin routes: the app session, its CSRF header (api()) */
export const adminMediaApi: MediaApi = {
  scope: 'admin',
  view: () => api<MediaView>(P),
  async lastJob() {
    const v = await api<UpdaterView>('/api/admin/updater');
    const job = 'status' in v ? v.status.job : null;
    return job && isMediaJob(job.action) ? job : null;
  },
  requestBase: (path) => api(`${P}/base`, { method: 'POST', body: { path } }),
  confirmBase: (code) => api(`${P}/base/confirm`, { method: 'POST', body: { code } }),
  clearBase: () => api(`${P}/base`, { method: 'DELETE', body: {} }),
  browse: (rel) => api(`${P}/browse`, { method: 'POST', body: { rel } }),
  gpu: () => api(`${P}/gpu`, { method: 'POST', body: {} }),
  apply: (input) => api(`${P}/apply`, { method: 'POST', body: input }),
  action: (body) => api(`${P}/action`, { method: 'POST', body }),
  logs: (tail) => api(`${P}/logs`, { method: 'POST', body: { tail } }),
  libraries: () => api(`${P}/libraries`),
  deleteLibrary: (slug) => api(`${P}/libraries/${encodeURIComponent(slug)}`, { method: 'DELETE', body: {} }),
  mode: (restore) => api(`${P}/mode`, { method: 'POST', body: { mode: 'external', restore } }),
  download: (id, passphrase, target) =>
    saveDownload(`${P}/backups/${encodeURIComponent(id)}/download`, id, { 'x-csrf-token': getCsrf(), [PASSPHRASE_HEADER]: encodePassphrase(passphrase) }, target),
  async upload(file, passphrase) {
    const res = await fetch(`${P}/backups/upload`, {
      method: 'POST', credentials: 'same-origin', body: file,
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': getCsrf(), [PASSPHRASE_HEADER]: encodePassphrase(passphrase) },
    });
    const body = await json(res);
    if (!res.ok) throw new ApiError(res.status, body);
    return body as { backup: MediaBackup; job: UpdaterJob | null };
  },
  moveScan: (source) => api(`${P}/move/scan`, { method: 'POST', body: source === undefined ? {} : { source } }),
  move: (body) => api(`${P}/move`, { method: 'POST', body }),
  moveAbort: () => api(`${P}/move/abort`, { method: 'POST', body: {} }),
  back: () => api(`${P}/back`, { method: 'POST', body: {} }),
};

/** the wizard's routes: the setup session and its CSRF header (setup/api.ts); what it has no route for is refused here */
export function setupMediaApi(): MediaApi {
  const S = '/api/setup/mediaserver';
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers[CSRF_HEADER] = readCookie(CSRF_COOKIE); }
    const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await json(res);
    if (!res.ok) throw new ApiError(res.status, j ?? {});
    return j as T;
  };
  const no = (): Promise<never> => Promise.reject(new ApiError(404, { error: 'not_supported' }));
  return {
    scope: 'setup',
    view: () => call<MediaView>(S),
    lastJob: () => Promise.resolve(null),
    requestBase: (path) => call(`${S}/base`, { path }),
    confirmBase: (code) => call(`${S}/base/confirm`, { code }),
    clearBase: no,
    browse: (rel) => call(`${S}/browse`, { rel }),
    gpu: () => call(`${S}/gpu`, {}),
    apply: (input) => call(`${S}/apply`, input),
    action: (body) => call(`${S}/action`, body),
    logs: no, libraries: no, deleteLibrary: no, mode: no, download: no, upload: no, moveScan: no, move: no, moveAbort: no, back: no,
  };
}
