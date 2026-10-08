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
  maxBitrate: number;
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
