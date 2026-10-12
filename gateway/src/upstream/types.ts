/**
 * What the gateway needs to know about the media server behind /media/: which upstream paths it may forward, which
 * query parameters carry credentials or caps, and how to authenticate as the user. One adapter per server kind
 * (./jellyfin.ts); ./index.ts picks it at startup from MEDIA_SERVER.
 */
export interface UpstreamCredentials { token: string; deviceId: string }

export interface Upstream {
  readonly kind: string;
  /** env var holding the upstream base URL (e.g. JELLYFIN_URL) */
  readonly urlEnv: string;
  /** allowlist for cookie requests; anything else is refused (the gateway is never a general proxy) */
  readonly paths: RegExp[];
  /** Chromecast subset (token in the URL path): playlists, segments, VTT subtitles, poster images */
  readonly castPaths: RegExp[];
  /** original (untranscoded) streams: refused for roles with a height cap or without download rights */
  readonly directStream: RegExp;
  /** images: cacheable per user; the only thing a cast 'img' token may fetch */
  readonly image: RegExp;
  /** lower-case query keys that carry credentials: never forwarded, stripped from cast playlists */
  readonly stripQuery: ReadonlySet<string>;
  /** lower-case query keys dropped on the cast path (stream/device identity comes from the token) */
  readonly castDropQuery: ReadonlySet<string>;
  /** lower-case query keys clamped to the height cap / its 16:9 width / the bitrate cap */
  readonly clampHeight: readonly string[];
  readonly clampWidth: readonly string[];
  readonly clampBitrate: readonly string[];
  /** headers that authenticate an upstream request as the user */
  authHeaders(cred: UpstreamCredentials): Record<string, string>;
}
