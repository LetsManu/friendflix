import { decrypt, encrypt } from '../crypto.js';
import type { KV } from '../kv.js';
import type { UserRow } from '../types.js';
import { JellyfinClient, JellyfinError } from './client.js';
import { toItemDto, toPlaybackDto, toTrickplayDto, type ItemDto, type PlaybackDto, type TrickplayDto } from './dto.js';

const TOKEN_TTL = 6 * 3600;
const FIELDS = 'Overview,Genres,OfficialRating,CommunityRating,PremiereDate,ProductionYear,ChildCount,RunTimeTicks';

export interface ItemQuery {
  parentId?: string;
  q?: string;
  types?: string;
  sort?: string;
  desc?: boolean;
  limit?: number;
  start?: number;
  filter?: 'favorites' | 'unplayed' | 'played';
  ids?: string[];
  genre?: string;
}

/**
 * Per-user Jellyfin access. The portal logs in server-side (AuthenticateByName) with the
 * stored (encrypted) password, caches the user token (encrypted, in Redis) and re-authenticates
 * on 401. The token never leaves the backend/gateway.
 */
export class JellyfinService {
  /** Remembers which of two possible API paths a given Jellyfin version supports. */
  private readonly compatChoice = new Map<string, number>();

  constructor(
    readonly client: JellyfinClient,
    private readonly kv: KV,
    private readonly encKey: Buffer,
  ) {}

  deviceId(user: UserRow) {
    return `ff-${user.id}`;
  }

  async token(user: UserRow, force = false): Promise<string> {
    const key = `jft:${user.id}`;
    if (!force) {
      const cached = await this.kv.get(key);
      if (cached) return decrypt(this.encKey, cached);
    }
    const pw = decrypt(this.encKey, user.jellyfin_pw_enc);
    const auth = await this.client.authenticateByName(user.jellyfin_username, pw, this.deviceId(user));
    await this.kv.set(key, encrypt(this.encKey, auth.AccessToken), TOKEN_TTL);
    return auth.AccessToken;
  }

  async call(user: UserRow, path: string, init: RequestInit = {}): Promise<Response> {
    let res = await this.client.userFetch(await this.token(user), this.deviceId(user), path, init);
    if (res.status === 401) {
      res = await this.client.userFetch(await this.token(user, true), this.deviceId(user), path, init);
    }
    return res;
  }

  async json<T = any>(user: UserRow, path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.call(user, path, init);
    if (!res.ok) throw new JellyfinError(res.status, `Jellyfin ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${res.status}`);
    const t = await res.text();
    return (t ? JSON.parse(t) : undefined) as T;
  }

  /** Tries the current API path first, falls back to the legacy one (paths differ between Jellyfin versions). */
  private async compat<T>(user: UserRow, name: string, paths: string[], init: RequestInit = {}): Promise<T> {
    const start = this.compatChoice.get(name) ?? 0;
    for (let n = 0; n < paths.length; n++) {
      const idx = (start + n) % paths.length;
      const res = await this.call(user, paths[idx]!, init);
      if (res.status === 404 || res.status === 405) continue;
      if (!res.ok) throw new JellyfinError(res.status, `Jellyfin ${name} -> ${res.status}`);
      this.compatChoice.set(name, idx);
      const t = await res.text();
      return (t ? JSON.parse(t) : undefined) as T;
    }
    throw new JellyfinError(404, `Jellyfin ${name}: no supported path`);
  }

  async views(user: UserRow): Promise<ItemDto[]> {
    const uid = user.jellyfin_user_id;
    const r = await this.compat<{ Items: any[] }>(user, 'views', [`/UserViews?userId=${uid}`, `/Users/${uid}/Views`]);
    return r.Items.map(toItemDto);
  }

  async items(user: UserRow, q: ItemQuery): Promise<{ items: ItemDto[]; total: number }> {
    const uid = user.jellyfin_user_id;
    const p = new URLSearchParams({ userId: uid, recursive: 'true', fields: FIELDS, enableTotalRecordCount: 'true' });
    if (q.parentId) p.set('parentId', q.parentId);
    if (q.q) p.set('searchTerm', q.q);
    p.set('includeItemTypes', q.types ?? (q.q ? 'Movie,Series' : 'Movie,Series'));
    p.set('sortBy', q.sort ?? 'SortName');
    p.set('sortOrder', q.desc ? 'Descending' : 'Ascending');
    p.set('limit', String(Math.min(q.limit ?? 60, 200)));
    p.set('startIndex', String(q.start ?? 0));
    if (q.filter === 'favorites') p.set('filters', 'IsFavorite');
    if (q.filter === 'unplayed') p.set('filters', 'IsUnplayed');
    if (q.filter === 'played') p.set('filters', 'IsPlayed');
    if (q.ids?.length) p.set('ids', q.ids.join(','));
    if (q.genre) p.set('genres', q.genre);
    const r = await this.json<{ Items: any[]; TotalRecordCount: number }>(user, `/Items?${p}`);
    return { items: r.Items.map(toItemDto), total: r.TotalRecordCount ?? r.Items.length };
  }

  async resume(user: UserRow): Promise<ItemDto[]> {
    const uid = user.jellyfin_user_id;
    const qs = `userId=${uid}&limit=20&mediaTypes=Video&fields=${FIELDS}&enableTotalRecordCount=false`;
    const r = await this.compat<{ Items: any[] }>(user, 'resume', [`/UserItems/Resume?${qs}`, `/Users/${uid}/Items/Resume?${qs}`]);
    return r.Items.map(toItemDto);
  }

  async nextUp(user: UserRow, seriesId?: string): Promise<ItemDto[]> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, limit: '20', fields: FIELDS });
    if (seriesId) p.set('seriesId', seriesId);
    const r = await this.json<{ Items: any[] }>(user, `/Shows/NextUp?${p}`);
    return r.Items.map(toItemDto);
  }

  async item(user: UserRow, id: string): Promise<ItemDto> {
    const uid = user.jellyfin_user_id;
    const i = await this.compat<any>(user, 'item', [`/Items/${id}?userId=${uid}`, `/Users/${uid}/Items/${id}`]);
    return toItemDto(i);
  }

  async genres(user: UserRow, types = 'Movie,Series'): Promise<string[]> {
    const r = await this.json<{ Items: Array<{ Name: string }> }>(user, `/Genres?userId=${user.jellyfin_user_id}&includeItemTypes=${types}&sortBy=SortName`);
    return r.Items.map((g) => g.Name);
  }

  /**
   * Intro/outro/recap segments (Jellyfin >= 10.10 media segments API). Older servers answer 404 -> empty list,
   * the "Intro überspringen" button then simply never shows.
   */
  async segments(user: UserRow, id: string): Promise<Array<{ type: string; start: number; end: number }>> {
    const res = await this.call(user, `/MediaSegments/${id}`);
    if (!res.ok) return [];
    const r = (await res.json().catch(() => null)) as { Items?: Array<{ Type: string; StartTicks: number; EndTicks: number }> } | null;
    return (r?.Items ?? [])
      .filter((s) => ['Intro', 'Outro', 'Recap'].includes(s.Type) && s.EndTicks > s.StartTicks)
      .map((s) => ({ type: s.Type.toLowerCase(), start: s.StartTicks / 1e7, end: s.EndTicks / 1e7 }));
  }

  /** Timeline thumbnails; undefined when the server has none (older Jellyfin or trickplay not generated). */
  async trickplay(user: UserRow, itemId: string, mediaSourceId: string): Promise<TrickplayDto | undefined> {
    try {
      const r = await this.json<{ Items: Array<{ Trickplay?: Record<string, any> }> }>(user, `/Items?userId=${user.jellyfin_user_id}&ids=${itemId}&fields=Trickplay`);
      return toTrickplayDto(itemId, mediaSourceId, r.Items[0]?.Trickplay);
    } catch {
      return undefined;
    }
  }

  /** "Ähnliche Titel" from Jellyfin's own similarity (genres/people/tags). */
  async similar(user: UserRow, id: string, limit = 24): Promise<ItemDto[]> {
    const r = await this.json<{ Items: any[] }>(user, `/Items/${id}/Similar?userId=${user.jellyfin_user_id}&limit=${limit}&fields=${FIELDS}`);
    return r.Items.map(toItemDto);
  }

  /** Last finished movie/series (episodes are mapped to their series) as seed for "Weil du ... gesehen hast". */
  async lastWatched(user: UserRow): Promise<ItemDto | null> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, recursive: 'true', filters: 'IsPlayed', sortBy: 'DatePlayed', sortOrder: 'Descending', limit: '1', includeItemTypes: 'Movie,Episode', fields: FIELDS });
    const r = await this.json<{ Items: any[] }>(user, `/Items?${p}`);
    const i = r.Items[0];
    if (!i) return null;
    return i.Type === 'Episode' && i.SeriesId ? this.item(user, i.SeriesId) : toItemDto(i);
  }

  async seasons(user: UserRow, seriesId: string): Promise<ItemDto[]> {
    const r = await this.json<{ Items: any[] }>(user, `/Shows/${seriesId}/Seasons?userId=${user.jellyfin_user_id}&fields=${FIELDS}`);
    return r.Items.map(toItemDto);
  }

  async episodes(user: UserRow, seriesId: string, seasonId?: string): Promise<ItemDto[]> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, fields: FIELDS });
    if (seasonId) p.set('seasonId', seasonId);
    const r = await this.json<{ Items: any[] }>(user, `/Shows/${seriesId}/Episodes?${p}`);
    return r.Items.map(toItemDto);
  }

  async upcoming(user: UserRow): Promise<ItemDto[]> {
    const r = await this.json<{ Items: any[] }>(user, `/Shows/Upcoming?userId=${user.jellyfin_user_id}&limit=50&fields=${FIELDS}`);
    return r.Items.map(toItemDto);
  }

  async setFavorite(user: UserRow, id: string, on: boolean) {
    const uid = user.jellyfin_user_id;
    await this.compat(user, 'favorite' + on, [`/UserFavoriteItems/${id}?userId=${uid}`, `/Users/${uid}/FavoriteItems/${id}`], { method: on ? 'POST' : 'DELETE' });
  }

  async setPlayed(user: UserRow, id: string, on: boolean) {
    const uid = user.jellyfin_user_id;
    await this.compat(user, 'played' + on, [`/UserPlayedItems/${id}?userId=${uid}`, `/Users/${uid}/PlayedItems/${id}`], { method: on ? 'POST' : 'DELETE' });
  }

  async playbackInfo(user: UserRow, itemId: string, opts: { maxBitrate: number; startTicks?: number; audioIndex?: number }): Promise<PlaybackDto> {
    const p = new URLSearchParams({ UserId: user.jellyfin_user_id, MaxStreamingBitrate: String(opts.maxBitrate), AutoOpenLiveStream: 'false' });
    if (opts.startTicks) p.set('StartTimeTicks', String(opts.startTicks));
    if (opts.audioIndex !== undefined) p.set('AudioStreamIndex', String(opts.audioIndex));
    const profile = {
      Name: 'FriendFlix Web',
      MaxStreamingBitrate: opts.maxBitrate,
      DirectPlayProfiles: [{ Container: 'mp4,m4v,webm', Type: 'Video', VideoCodec: 'h264,vp9,av1', AudioCodec: 'aac,mp3,opus,flac' }],
      TranscodingProfiles: [
        { Container: 'ts', Type: 'Video', AudioCodec: 'aac,mp3', VideoCodec: 'h264', Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true },
      ],
      SubtitleProfiles: [
        { Format: 'vtt', Method: 'External' },
        { Format: 'srt', Method: 'External' },
        { Format: 'ass', Method: 'External' },
      ],
    };
    const info = await this.json<Record<string, any>>(user, `/Items/${itemId}/PlaybackInfo?${p}`, {
      method: 'POST',
      body: JSON.stringify({ DeviceProfile: profile }),
    });
    if (info.ErrorCode) throw new JellyfinError(403, `playback blocked: ${info.ErrorCode}`);
    return toPlaybackDto({ itemId, info, deviceId: this.deviceId(user), maxBitrate: opts.maxBitrate, resumeTicks: opts.startTicks ?? 0, audioIndex: opts.audioIndex });
  }

  /** Playing / Progress / Stopped reports (powers "Weiterschauen" and Jellyfin statistics). */
  async report(user: UserRow, kind: 'Playing' | 'Playing/Progress' | 'Playing/Stopped', body: Record<string, unknown>) {
    const res = await this.call(user, `/Sessions/${kind}`, { method: 'POST', body: JSON.stringify({ CanSeek: true, PlayMethod: 'DirectStream', ...body }) });
    if (!res.ok) throw new JellyfinError(res.status, `report ${kind} -> ${res.status}`);
  }

  /** Library lookup by TMDB id with the admin key (used to link finished Seerr requests to library items). */
  async findByTmdb(tmdbId: number, mediaType: string): Promise<{ id: string; name: string } | null> {
    const type = mediaType === 'tv' ? 'Series' : 'Movie';
    const r = await this.client.adminJson<{ Items: Array<{ Id: string; Name: string }> }>(
      `/Items?anyProviderIdEquals=tmdb.${tmdbId}&recursive=true&includeItemTypes=${type}&limit=1`,
    );
    const i = r.Items[0];
    return i ? { id: i.Id, name: i.Name } : null;
  }
}
