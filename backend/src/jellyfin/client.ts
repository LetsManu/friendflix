// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { MediaError } from '../media/types.js';
import type { RoleTemplate } from '../roles.js';
import { timed } from '../timing.js';

/**
 * Jellyfin authorization header, e.g.
 * MediaBrowser Client="FriendFlix", Device="Portal", DeviceId="abc", Version="0.1.0", Token="..."
 * Values are stripped of quotes/newlines so they can never break out of the header.
 */
export function mediaBrowserHeader(opts: { deviceId: string; token?: string; version?: string; device?: string }): string {
  const esc = (v: string) => v.replace(/["\\\r\n]/g, '');
  const parts: Array<[string, string]> = [
    ['Client', 'FriendFlix'],
    ['Device', opts.device ?? 'Portal'],
    ['DeviceId', opts.deviceId],
    ['Version', opts.version ?? '0.1.0'],
  ];
  if (opts.token) parts.push(['Token', opts.token]);
  return 'MediaBrowser ' + parts.map(([k, v]) => `${k}="${esc(v)}"`).join(', ');
}

export interface AuthResult {
  AccessToken: string;
  User: { Id: string; Name: string };
}

/** Jellyfin HTTP failure; routes only check the server-neutral MediaError base class. */
export class JellyfinError extends MediaError {}

/** Maps a role template to the Jellyfin UserPolicy fields we manage. */
export function policyFromTemplate(t: RoleTemplate, folderIds: string[] | null): Record<string, unknown> {
  return {
    IsAdministrator: false,
    IsDisabled: false,
    EnableRemoteAccess: true,
    EnableAllFolders: t.libraries === 'all',
    EnabledFolders: t.libraries === 'all' ? [] : (folderIds ?? []),
    MaxParentalRating: t.maxParentalRating,
    EnableVideoPlaybackTranscoding: t.transcoding,
    EnableAudioPlaybackTranscoding: t.transcoding,
    EnablePlaybackRemuxing: true,
    EnableContentDownloading: t.download,
    EnableMediaConversion: false,
    EnableLiveTvAccess: false,
    EnableSharedDeviceControl: false,
    RemoteClientBitrateLimit: t.maxBitrate,
    MaxActiveSessions: t.maxStreams,
  };
}

export type LibraryLocations = Array<{ name: string; paths: string[] }>;
/** how long libraryLocations() keeps the library folders (a new library is also picked up by forgetLibraryLocations()) */
export const LIBRARY_LOCATIONS_TTL_MS = 5 * 60_000;

/** The library whose folder holds `path` (an item's Path, file or folder); with nested folders the deepest wins. null when none does.
 * A folder matches itself and what lies below it ('/' or '\\' after it), never a sibling that only shares the prefix. A Windows folder
 * (drive letter or \\server) matches without regard to case or the kind of slash, as its file system does; a POSIX one exactly. */
export function libraryOfPath(path: unknown, libs: LibraryLocations): string | null {
  if (typeof path !== 'string' || !path) return null;
  let best: { name: string; len: number } | null = null;
  for (const lib of libs) {
    for (const raw of lib.paths) {
      const win = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(raw);
      // a Windows folder may be entered with / while Jellyfin's item paths use \ (or the other way): both sides to \ and lower case
      const norm = (x: string) => (win ? x.toLowerCase().replace(/\//g, '\\') : x);
      const dir = norm(raw).replace(/[\\/]+$/, '');
      const p = norm(path);
      if (!raw || (p !== dir && !(p.startsWith(dir) && (p[dir.length] === '/' || p[dir.length] === '\\')))) continue;
      if (!best || dir.length > best.len) best = { name: lib.name, len: dir.length };
    }
  }
  return best?.name ?? null;
}

export type LibraryFolder = { id: string | null; name: string; paths: string[] };

/** Low-level Jellyfin client: admin-key calls plus raw user-token calls. Never used by browsers. */
export class JellyfinClient {
  constructor(
    readonly baseUrl: string,
    private readonly adminApiKey: string,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Server-relative path (+ query) -> absolute URL. Anything else (absolute or protocol-relative URL, backslashes) is refused. */
  url(path: string) {
    if (!/^\/(?![/\\])/.test(path) || path.includes('\\') || /[\x00-\x1f]/.test(path)) throw new JellyfinError(400, 'Jellyfin: only server-relative paths');
    const base = new URL(this.baseUrl.replace(/\/?$/, '/'));
    const u = new URL(path.replace(/^\//, ''), base);
    if (u.origin !== base.origin) throw new JellyfinError(400, 'Jellyfin: only server-relative paths');
    return u.toString();
  }

  private adminHeaders() {
    return {
      Authorization: mediaBrowserHeader({ deviceId: 'portal-admin', token: this.adminApiKey }),
      'content-type': 'application/json',
    };
  }

  /** Every Jellyfin request goes through here: booked as `jf` in the request's Server-Timing (time to response headers). */
  private send(url: string, init: RequestInit) {
    return timed('jf', () => this.fetchImpl(url, init));
  }

  adminFetch(path: string, init: RequestInit = {}) {
    return this.send(this.url(path), {
      ...init,
      headers: { ...this.adminHeaders(), ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
  }

  async adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.adminFetch(path, init);
    if (!res.ok) throw new JellyfinError(res.status, `Jellyfin ${init.method ?? 'GET'} ${path} -> ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  userFetch(token: string, deviceId: string, path: string, init: RequestInit = {}) {
    return this.send(this.url(path), {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
        Authorization: mediaBrowserHeader({ deviceId, token }),
      },
      signal: init.signal ?? AbortSignal.timeout(20000),
    });
  }

  async authenticateByName(username: string, password: string, deviceId: string = randomUUID()): Promise<AuthResult> {
    const res = await this.send(this.url('/Users/AuthenticateByName'), {
      method: 'POST',
      headers: { Authorization: mediaBrowserHeader({ deviceId }), 'content-type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new JellyfinError(res.status, `Jellyfin auth failed: ${res.status}`);
    return (await res.json()) as AuthResult;
  }

  createUser(name: string, password: string) {
    return this.adminJson<{ Id: string }>('/Users/New', { method: 'POST', body: JSON.stringify({ Name: name, Password: password }) });
  }

  async deleteUser(id: string) {
    await this.adminFetch(`/Users/${id}`, { method: 'DELETE' });
  }

  async setPassword(id: string, newPw: string) {
    // Admin reset then set: Jellyfin accepts NewPw with ResetPassword=false when called as admin.
    await this.adminJson(`/Users/${id}/Password`, { method: 'POST', body: JSON.stringify({ NewPw: newPw }) });
  }

  /** Merges our managed policy fields into the existing policy (keeps unknown fields intact). */
  async setPolicy(userId: string, patch: Record<string, unknown>) {
    const user = await this.adminJson<{ Policy: Record<string, unknown> }>(`/Users/${userId}`);
    await this.adminJson(`/Users/${userId}/Policy`, { method: 'POST', body: JSON.stringify({ ...user.Policy, ...patch }) });
  }

  async mediaFolders(): Promise<Array<{ Id: string; Name: string }>> {
    const r = await this.adminJson<{ Items: Array<{ Id: string; Name: string }> }>('/Library/MediaFolders');
    return r.Items;
  }

  /**
   * Films and series matching `term` in every library (admin key, no user: no parental cap or library limit applies). Only for the admin's
   * title check. The term is in the URL only: the error message carries the status, never the request path.
   */
  async searchItems(term: string, limit: number): Promise<Array<Record<string, any>>> {
    const p = new URLSearchParams({
      searchTerm: term, Recursive: 'true', IncludeItemTypes: 'Movie,Series', Limit: String(limit), Fields: 'OfficialRating,ProductionYear,Path',
      EnableImages: 'false', EnableUserData: 'false', EnableTotalRecordCount: 'false',
    });
    const res = await this.adminFetch(`/Items?${p}`);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new JellyfinError(res.status, `Jellyfin admin search -> ${res.status}`);
    }
    return this.itemList(res, 'search');
  }

  /** One item by id in any library (admin key, no user), for the admin's title check; null when the server does not know it. */
  async itemById(id: string): Promise<Record<string, any> | null> {
    const p = new URLSearchParams({
      ids: id, Recursive: 'true', Fields: 'OfficialRating,ProductionYear,Path', EnableImages: 'false', EnableUserData: 'false', EnableTotalRecordCount: 'false', Limit: '1',
    });
    const res = await this.adminFetch(`/Items?${p}`);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new JellyfinError(res.status, `Jellyfin admin item lookup -> ${res.status}`);
    }
    return (await this.itemList(res, 'item lookup'))[0] ?? null;
  }

  /** `Items` of an answer; a body that is not the expected JSON is a 502 (never "no hits"). The message names no path. */
  private async itemList(res: Response, what: string): Promise<Array<Record<string, any>>> {
    const r = (await res.json().catch(() => undefined)) as { Items?: unknown } | null | undefined;
    if (!r || typeof r !== 'object' || !Array.isArray(r.Items)) throw new JellyfinError(502, `Jellyfin admin ${what}: no item list`);
    return r.Items as Array<Record<string, any>>;
  }

  /** `/Library/VirtualFolders` as each library's name and folders, kept LIBRARY_LOCATIONS_TTL_MS (a failed read is not kept). For the admin's
   * title check: Jellyfin names no library among an item's ancestors when asked with the admin key and no userId (12.4, 10.x and Ferrofin
   * answer the physical folder and the AggregateFolder "root"), so the item's Path is matched against these folders instead. */
  libraryLocations(): Promise<LibraryLocations> {
    const now = Date.now();
    if (this.locations && this.locations.exp > now) return this.locations.p;
    const p = this.adminJson<unknown>('/Library/VirtualFolders').then((list) => (Array.isArray(list) ? list : []).flatMap((f: { Name?: unknown; Locations?: unknown }) => (
      f && typeof f.Name === 'string'
        ? [{ name: f.Name, paths: Array.isArray(f.Locations) ? f.Locations.filter((x): x is string => typeof x === 'string') : [] }]
        : [])));
    const entry = { exp: now + LIBRARY_LOCATIONS_TTL_MS, p };
    this.locations = entry;
    p.catch(() => { if (this.locations === entry) this.locations = null; });
    return p;
  }

  /**
   * `/Library/VirtualFolders` with each library's id. ItemId as the server answers it, except where a real Jellyfin 12.4 gets it wrong:
   * null after a restart (for every library that was there before), and for two libraries whose names differ only in case ("Filme",
   * "filme") the id of the other one. Those take the id of the one CollectionFolder of exactly that name in `/Library/MediaFolders` (asked
   * only then; it also lists the ManualPlaylistsFolder "Playlists", which is no library). None, several or a failed read: id null.
   */
  async libraryFolders(): Promise<LibraryFolder[]> {
    const list = await this.adminJson<unknown>('/Library/VirtualFolders');
    const vfs = (Array.isArray(list) ? list : []).flatMap((f: { Name?: unknown; ItemId?: unknown; Locations?: unknown }) => (f && typeof f.Name === 'string'
      ? [{ name: f.Name, itemId: typeof f.ItemId === 'string' && f.ItemId ? f.ItemId : null, paths: Array.isArray(f.Locations) ? f.Locations.filter((x): x is string => typeof x === 'string') : [] }]
      : []));
    const folded = new Map<string, number>();
    for (const v of vfs) folded.set(v.name.toLowerCase(), (folded.get(v.name.toLowerCase()) ?? 0) + 1);
    const byName = (v: { name: string; itemId: string | null }) => !v.itemId || folded.get(v.name.toLowerCase())! > 1;
    const ids = new Map<string, string | null>();
    if (vfs.some(byName)) {
      const r = await this.adminJson<{ Items?: unknown }>('/Library/MediaFolders').catch(() => null);
      for (const m of (Array.isArray(r?.Items) ? r.Items : []) as Array<{ Name?: unknown; Id?: unknown; Type?: unknown }>) {
        if (!m || typeof m.Name !== 'string' || typeof m.Id !== 'string' || !m.Id || (m.Type !== undefined && m.Type !== 'CollectionFolder')) continue;
        ids.set(m.Name, ids.has(m.Name) ? null : m.Id);
      }
    }
    return vfs.map((v) => ({ id: byName(v) ? (ids.get(v.name) ?? null) : v.itemId, name: v.name, paths: v.paths }));
  }

  /** a library was added or changed: the next libraryLocations() reads them afresh */
  forgetLibraryLocations() {
    this.locations = null;
  }

  private locations: { exp: number; p: Promise<LibraryLocations> } | null = null;

  sessions() {
    return this.adminJson<Array<Record<string, any>>>('/Sessions?activeWithinSeconds=15');
  }

  /** Block 22: every recently active session (FriendFlix devices included), for the admin's active streams */
  allSessions() {
    return this.adminJson<Array<Record<string, any>>>('/Sessions?activeWithinSeconds=30');
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url('/System/Ping'), { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
