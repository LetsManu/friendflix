/** Trimmed item shape sent to the browser (never raw Jellyfin JSON, no tokens, no server paths). */
export interface ItemDto {
  id: string;
  name: string;
  type: string;
  year?: number;
  overview?: string;
  runtimeTicks?: number;
  seriesId?: string;
  seriesName?: string;
  seasonId?: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  genres: string[];
  rating?: string;
  communityRating?: number;
  premiereDate?: string;
  image: boolean;
  backdrop: boolean;
  /** transparent title logo available (shown in the billboard) */
  logo: boolean;
  played: boolean;
  favorite: boolean;
  positionTicks: number;
  playedPercentage?: number;
  childCount?: number;
  unplayedCount?: number;
}

export function toItemDto(i: Record<string, any>): ItemDto {
  const ud = i.UserData ?? {};
  return {
    id: i.Id,
    name: i.Name,
    type: i.Type,
    year: i.ProductionYear,
    overview: i.Overview,
    runtimeTicks: i.RunTimeTicks,
    seriesId: i.SeriesId,
    seriesName: i.SeriesName,
    seasonId: i.SeasonId,
    indexNumber: i.IndexNumber,
    parentIndexNumber: i.ParentIndexNumber,
    genres: Array.isArray(i.Genres) ? i.Genres : [],
    rating: i.OfficialRating,
    communityRating: i.CommunityRating,
    premiereDate: i.PremiereDate,
    image: Boolean(i.ImageTags?.Primary),
    backdrop: Array.isArray(i.BackdropImageTags) && i.BackdropImageTags.length > 0,
    logo: Boolean(i.ImageTags?.Logo),
    played: Boolean(ud.Played),
    favorite: Boolean(ud.IsFavorite),
    positionTicks: Number(ud.PlaybackPositionTicks ?? 0),
    playedPercentage: ud.PlayedPercentage,
    childCount: i.ChildCount,
    unplayedCount: ud.UnplayedItemCount,
  };
}

export interface PlaybackDto {
  itemId: string;
  playSessionId: string;
  mediaSourceId: string;
  directUrl?: string;
  hlsUrl: string;
  runtimeTicks?: number;
  resumeTicks: number;
  /** bitrate cap used for this session (<= role limit) */
  maxBitrate: number;
  /** role limit, upper bound for the quality menu */
  roleMaxBitrate?: number;
  trickplay?: TrickplayDto;
  audioTracks: Array<{ index: number; language?: string; title: string; isDefault: boolean }>;
  subtitles: Array<{ index: number; language?: string; title: string; url: string; isDefault: boolean }>;
}

const TEXT_SUBS = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'subviewer']);

export function toPlaybackDto(args: {
  itemId: string;
  info: Record<string, any>;
  deviceId: string;
  maxBitrate: number;
  resumeTicks: number;
  audioIndex?: number;
}): PlaybackDto {
  const { itemId, info, deviceId, maxBitrate, resumeTicks, audioIndex } = args;
  const src = (info.MediaSources ?? [])[0];
  if (!src) throw new Error('no media source');
  const streams: Array<Record<string, any>> = src.MediaStreams ?? [];
  const common = new URLSearchParams({ MediaSourceId: src.Id, PlaySessionId: info.PlaySessionId, DeviceId: deviceId });

  const hls = new URLSearchParams(common);
  hls.set('VideoCodec', 'h264');
  hls.set('AudioCodec', 'aac,mp3');
  hls.set('SegmentContainer', 'ts');
  hls.set('MinSegments', '1');
  hls.set('BreakOnNonKeyFrames', 'true');
  hls.set('TranscodingMaxAudioChannels', '2');
  hls.set('MaxStreamingBitrate', String(maxBitrate));
  if (audioIndex !== undefined) hls.set('AudioStreamIndex', String(audioIndex));

  const browserContainer = /(^|,)(mp4|m4v|webm|mov)(,|$)/i.test(String(src.Container ?? ''));
  const directOk = Boolean(src.SupportsDirectPlay) && browserContainer && Number(src.Bitrate ?? 0) <= maxBitrate && audioIndex === undefined;
  const direct = new URLSearchParams(common);
  direct.set('static', 'true');

  return {
    itemId,
    playSessionId: info.PlaySessionId,
    mediaSourceId: src.Id,
    directUrl: directOk ? `/media/Videos/${itemId}/stream?${direct}` : undefined,
    hlsUrl: `/media/Videos/${itemId}/master.m3u8?${hls}`,
    runtimeTicks: src.RunTimeTicks,
    resumeTicks,
    maxBitrate,
    audioTracks: streams
      .filter((s) => s.Type === 'Audio')
      .map((s) => ({ index: s.Index, language: s.Language, title: s.DisplayTitle ?? s.Title ?? s.Language ?? `Spur ${s.Index}`, isDefault: Boolean(s.IsDefault) })),
    subtitles: streams
      .filter((s) => s.Type === 'Subtitle' && (s.IsTextSubtitleStream || TEXT_SUBS.has(String(s.Codec ?? '').toLowerCase())))
      .map((s) => ({
        index: s.Index,
        language: s.Language,
        title: s.DisplayTitle ?? s.Title ?? s.Language ?? `Untertitel ${s.Index}`,
        isDefault: Boolean(s.IsDefault),
        url: `/media/Videos/${itemId}/${src.Id}/Subtitles/${s.Index}/0/Stream.vtt`,
      })),
  };
}

/** Timeline preview thumbnails (Jellyfin >= 10.9 trickplay): tile sheets of tileWidth x tileHeight thumbnails. */
export interface TrickplayDto {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  count: number;
  /** ms between thumbnails */
  interval: number;
  /** URL with {n} = sheet index */
  url: string;
}

/** Picks the resolution closest to ~320 px from Jellyfin's `Trickplay[mediaSourceId][width]` map. */
export function toTrickplayDto(itemId: string, mediaSourceId: string, raw: Record<string, any> | undefined): TrickplayDto | undefined {
  const forSource = raw?.[mediaSourceId] ?? (raw ? Object.values(raw)[0] : undefined);
  if (!forSource || typeof forSource !== 'object') return undefined;
  const widths = Object.keys(forSource).map(Number).filter((w) => w >= 40 && w <= 2000);
  if (!widths.length) return undefined;
  const w = widths.reduce((a, b) => (Math.abs(b - 320) < Math.abs(a - 320) ? b : a));
  const t = forSource[String(w)];
  if (!t || !t.TileWidth || !t.TileHeight || !t.Interval || !t.ThumbnailCount) return undefined;
  return {
    width: Number(t.Width ?? w), height: Number(t.Height), tileWidth: Number(t.TileWidth), tileHeight: Number(t.TileHeight),
    count: Number(t.ThumbnailCount), interval: Number(t.Interval),
    url: `/media/Videos/${itemId}/Trickplay/${w}/{n}.jpg?MediaSourceId=${encodeURIComponent(mediaSourceId)}`,
  };
}
