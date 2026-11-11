// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { jellyfinUpstream, type Upstream } from './upstream/index.js';
import { hlsAttrs } from './hls.js';
import { joinPlaylists, joinedMaster, joinedPrefix, readMaster, type PartMaster } from './joined.js';

export { hlsAttrs };

export interface GatewayOptions {
  /** media server adapter (allowlist, credential params, auth header); default Jellyfin */
  upstream?: Upstream;
  /** base URL of the media server, or a getter of the current one (remoteConfig); null/invalid = /media/* answers 503 */
  upstreamUrl?: string | (() => string | null);
  backendUrl: string;
  internalSecret: string;
  metricsToken?: string;
  fetchImpl?: typeof fetch;
  /** called with the x-ff-config-rev header of every /internal/authz* answer (remoteConfig.noteRev) */
  onConfigRev?: (rev: string | null) => void;
  /** directory holding prepared offline downloads (read-only mount); without it 'file' downloads answer 503 */
  downloadDir?: string;
  /**
   * continuous AirPlay: every `/media/c/<ct>/s/<part>/<n>.ts` fetch that passed authz and the cast checks (just before it is
   * proxied). `tokenHash` = sha256 hex of the cast token (what the backend keys cast records by; the hook never sees the bearer
   * token), `part` the 0-based episode of the joined stream, `positionTicks` the segment's start in that episode (Jellyfin's
   * `runtimeTicks`; a segment without a valid one reports nothing). Default: joinedProgressSender (the backend's per-episode progress).
   */
  onJoinedSegment?: (e: JoinedSegment) => void;
}

/** a token's progress goes to the backend at once when its part changes, else at most this often */
export const JOINED_PROGRESS_MS = 15_000;
/** two calls of one token for different parts are at least this far apart */
export const JOINED_PART_FLOOR_MS = 1_000;

/**
 * The default onJoinedSegment: POST /internal/cast/progress `{ tokenHash, itemId, positionTicks }` (the backend turns it into the
 * episode's start / progress / stop). Throttled per token: at once on a part change (but at least JOINED_PART_FLOOR_MS after the
 * token's last call), else at most every JOINED_PROGRESS_MS. Fire and forget: the segment response never waits for it, a failing or
 * hanging backend (5 s timeout) is swallowed and nothing is logged. The body carries the token's hash only (never the token, never the
 * receiver's address).
 */
export function joinedProgressSender(o: { backendUrl: string; internalSecret: string; fetchImpl?: typeof fetch; now?: () => number }): (e: JoinedSegment) => void {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const url = new URL('/internal/cast/progress', o.backendUrl).href;
  /** per token hash: the part and time of its last call */
  const last = new Map<string, { part: number; at: number }>();
  return (e) => {
    const t = now();
    const prev = last.get(e.tokenHash);
    // the same part: at most every 15 s; a part change at once, but never sooner than 1 s after the token's last call (a TV, or a
    // token holder, alternating between parts never drives one backend call per segment)
    if (prev && t - prev.at < (prev.part === e.part ? JOINED_PROGRESS_MS : JOINED_PART_FLOOR_MS)) return;
    if (!prev && last.size >= 5000) { // bounded: forget tokens that went quiet (a joined stream fetches every few seconds)
      for (const [k, v] of last) if (t - v.at > 10 * 60_000) last.delete(k);
      if (last.size >= 5000) last.clear();
    }
    last.set(e.tokenHash, { part: e.part, at: t });
    try {
      void f(url, {
        method: 'POST',
        headers: { 'x-internal-secret': o.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ tokenHash: e.tokenHash, itemId: e.itemId, positionTicks: e.positionTicks }),
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.body?.cancel().catch(() => {}), () => {});
    } catch { /* progress is best effort: playback never depends on it */ }
  };
}

export interface JoinedSegment { tokenHash: string; part: number; itemId: string; positionTicks: number }
/** one episode of a joined AirPlay token as the backend's authz answer lists it (backend cast.ts JoinedItem without runtimeTicks) */
export interface JoinedItemScope {
  itemId: string; mediaSourceId: string; playSessionId: string;
  /** the episode's Jellyfin HLS master as minted ("/Videos/<id>/master.m3u8?..."), backend-built, never a credential */
  hlsPath: string;
  /** this episode's own subtitle track (its one WebVTT rendition); absent = it carries none */
  hlsSubIndex?: number;
}
type CastTuple = { itemId: string; mediaSourceId: string; playSessionId: string };
/** an authz answer of a cast token (authorizeCast never returns one without scope) */
type CastAuthz = Authz & { scope: NonNullable<Authz['scope']> };

/** Answer of the backend for {sid, dl}: the user's media credentials plus what to serve. Names/paths come from the backend only. */
export type DownloadTarget =
  | { kind: 'file'; file: string; size: number; etag: string }
  | { kind: 'static'; path: string; query?: Record<string, string> };
type DownloadAuthz = Authz & { download: DownloadTarget };

const DL_ROUTE = /^\/media\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Shared-vector helper: the download id of a public request path (no query, no fragment), or null. */
export const matchDownloadPath = (raw: string): string | null => DL_ROUTE.exec(raw)?.[1] ?? null;
const DL_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;
const DL_ETAG = /^[\w.-]{1,128}$/;
const DL_MAX_OPEN = 2;

interface Authz {
  userId: string;
  token: string;
  deviceId: string;
  maxBitrate: number;
  /** only present for Chromecast tokens: the one item / media source / play session the token may touch */
  scope?: { itemId: string; mediaSourceId: string; playSessionId: string; /** AirPlay token whose stream carries one subtitle rendition (anything but `true` = drop every subtitle group) */ hlsSub?: boolean; /** with hlsSub: the track whose rendition compatPlaylist keeps and whose paths the token may fetch */ hlsSubIndex?: number; /** a joined (multi-item) AirPlay token: each episode with its own tuple and track; item 0 = the fields above */ items?: JoinedItemScope[] };
  /** cast only: 'img' tokens may fetch poster images and nothing else (default 'media') */
  kind?: 'media' | 'img';
  /** resolution cap: role limit (cookie path, when the role has one) or cast token cap (role limit, at most 1080) */
  maxHeight?: number;
  /** role may download originals; anything but `true` (missing, older backend) counts as no, so direct streams fail closed */
  canDownload?: boolean;
}

/**
 * Allowlist of upstream paths (of the default Jellyfin adapter, see upstream/jellyfin.ts). Anything else is rejected, so the
 * gateway can never be used as a general proxy to the media server (or any other host: the upstream origin is fixed anyway).
 */
export const ALLOWED_PATHS: RegExp[] = jellyfinUpstream.paths;

/** Chromecast subset (token in the URL path, no cookie) of the default adapter. */
export const CAST_PATHS: RegExp[] = jellyfinUpstream.castPaths;
const CAST_ROUTE = /^\/media\/c\/([A-Za-z0-9_-]{43})(\/.*)$/;
const CAST_PREFIX = '/media/c/';
const CAST_PLAYLIST_MAX = 8 * 1024 * 1024; // very long films at short segment lengths reach several MB
const CAST_FAIL_LIMIT = 30; // DISTINCT failing tokens per minute and client address
const CAST_BLOCK_MS = 5 * 60_000;
const CAST_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
  'cross-origin-resource-policy': 'cross-origin',
};

/**
 * Direct (original) streams bypass the transcoder, so the resolution cap and the download flag cannot be enforced on them.
 * Roles with a height cap or without download rights get HLS only; every direct stream request is refused.
 */
export const blocksDirectStream = (path: string, auth: Pick<Authz, 'maxHeight' | 'canDownload'>, up: Upstream = jellyfinUpstream) =>
  up.directStream.test(path) && (Boolean(auth.maxHeight) || auth.canDownload !== true);

const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition'];

/** Returns a safe normalized path or null. Rejects traversal, encoded slashes, backslashes, control chars. */
export function normalizePath(raw: string, allow: RegExp[] = ALLOWED_PATHS): string | null {
  if (/%2f|%5c|%00|%2e%2e/i.test(raw)) return null;
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes('..') || p.includes('\\') || p.includes('//') || /[\x00-\x1f]/.test(p)) return null;
  return allow.some((re) => re.test(p)) ? p : null;
}

/**
 * Address sent as `ip` to /internal/authz (decides the remote bitrate cap): X-Real-IP, else the LAST X-Forwarded-For entry (clientKey rule).
 * Without a usable forwarding header only a loopback peer is passed on; any other peer (a docker bridge, say) is 'unknown' = remote.
 */
export function authClientIp(headers: IncomingMessage['headers'], peer: string | undefined): string {
  const real = headers['x-real-ip'];
  const xff = headers['x-forwarded-for'];
  const fwd = (typeof real === 'string' ? real.trim() : '') || (typeof xff === 'string' ? xff : '').split(',').pop()?.trim() || '';
  if (fwd) return fwd.slice(0, 64);
  return peer && (peer === '::1' || /^(::ffff:)?127\./.test(peer)) ? peer.slice(0, 64) : 'unknown';
}

export const normalizeCastPath = (raw: string, up: Upstream = jellyfinUpstream) => normalizePath(raw, up.castPaths);

/**
 * AirPlay subtitle rendition paths (Upstream.castHlsSubPaths): `rawPathWithQuery` ("/Videos/<id>/<ms>/Subtitles/<n>/subtitles.m3u8?SegmentLength=30")
 * -> { index } when the path matches one entry and every query key is a credential key (stripped later) or one of that entry's allowed keys, once,
 * with a matching value; else null. Only a token whose scope says hlsSub (and this index) may use it (handleCast); `castPaths` stay unchanged.
 */
export function castHlsSubAllowed(rawPathWithQuery: string, up: Upstream = jellyfinUpstream): { index: number } | null {
  const q = rawPathWithQuery.indexOf('?');
  const rawPath = q === -1 ? rawPathWithQuery : rawPathWithQuery.slice(0, q);
  for (const e of up.castHlsSubPaths ?? []) {
    const path = normalizePath(rawPath, [e.path]);
    const m = path ? e.path.exec(path) : null;
    if (!m) continue;
    const seen = new Set<string>();
    for (const [k, v] of new URLSearchParams(q === -1 ? '' : rawPathWithQuery.slice(q + 1))) {
      const lk = k.toLowerCase();
      if (up.stripQuery.has(lk)) continue;
      const re = e.query[lk];
      if (!re || seen.has(lk) || !re.test(v)) return null;
      seen.add(lk);
    }
    return { index: Number(m[1]) };
  }
  return null;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const lc = (v: string) => v.replace(/-/g, '').toLowerCase();
/** the joined item a cast path names (its first 32-hex id), or undefined (also for a single-item token) */
const joinedItemOf = (scope: Authz['scope'], path: string): JoinedItemScope | undefined => {
  const id = path.match(/[0-9a-fA-F]{32}/)?.[0];
  return id ? scope?.items?.find((i) => lc(i.itemId) === lc(id)) : undefined;
};
/**
 * The subtitle track an AirPlay token may carry for `path`, else undefined (never a poster token). Single-item token: scope.hlsSub === true with
 * an integer hlsSubIndex. Joined token: the integer hlsSubIndex of the item the path names (each episode has its own track index).
 */
const hlsSubIndexOf = (auth: Pick<Authz, 'scope' | 'kind'>, path: string): number | undefined => {
  if (auth.kind === 'img') return undefined;
  if (auth.scope?.items) {
    const it = joinedItemOf(auth.scope, path);
    return it && Number.isInteger(it.hlsSubIndex) ? it.hlsSubIndex : undefined;
  }
  return auth.scope?.hlsSub === true && Number.isInteger(auth.scope.hlsSubIndex) ? auth.scope.hlsSubIndex : undefined;
};
/** never a burn-in: with a subtitle track only that track with SubtitleMethod=Hls may be named (without one, forward() strips the selectors) */
const burnInFree = (query: URLSearchParams, subIndex: number | undefined) =>
  subIndex === undefined || [...query].every(([k, v]) => {
    const lk = k.toLowerCase();
    return !((lk === 'subtitlemethod' && v.toLowerCase() !== 'hls') || (lk === 'subtitlestreamindex' && v !== String(subIndex)));
  });
/** the joined playlists of a multi-item token (query-free) */
const JOINED_ROUTE = /^\/joined\/(master|main|subs)\.m3u8$/;
/** a short segment URI of the joined main playlist: `s/<part>/<n>.ts`, part 0-2 (JOINED_MAX_ITEMS), canonical decimal only (no leading zero, no sign) */
const SHORT_SEG_ROUTE = /^\/s\/([0-2])\/(0|[1-9]\d{0,5})\.ts$/;
/** spec §6: at most three episodes per joined token (the backend mints at most three; a longer list is refused here too) */
const JOINED_MAX_ITEMS = 3;
/**
 * The joined build fetches and rewrites playlists itself and bypasses the adapter's playlist / authorize / rewrite hooks, so it runs only
 * for the Jellyfin adapter, which has none (continuous AirPlay is Jellyfin-only: the backend's switch requires it). Anything else: 403.
 */
const joinedCapable = (up: Upstream) => up.kind === 'jellyfin' && !up.playlist && !up.authorize && !up.rewrite;
const JOINED_TTL_MS = 6 * 3600_000;
const JOINED_FAIL_TTL_MS = 10_000; // a failed build is retried after this (an upstream hiccup must not kill the stream for hours)
const JOINED_MAX = 50;

/** Removes token-like parameters from one playlist URI (relative, optionally with a query). */
export function stripUriTokens(uri: string, strip: ReadonlySet<string> = jellyfinUpstream.stripQuery): string {
  const q = uri.indexOf('?');
  if (q === -1) return uri;
  const keep = uri.slice(q + 1).split('&').filter((kv) => {
    let k = kv.split('=')[0] ?? '';
    try { k = decodeURIComponent(k); } catch { /* keep raw */ }
    return !strip.has(k.toLowerCase());
  });
  return keep.length ? `${uri.slice(0, q)}?${keep.join('&')}` : uri.slice(0, q);
}

/** `#EXT-X-STREAM-INF` attributes the compatibility master keeps (AUDIO / VIDEO only while their EXT-X-MEDIA group is kept) */
const COMPAT_STREAM_ATTRS = new Set(['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'CODECS', 'RESOLUTION', 'FRAME-RATE']);
const COMPAT_GROUP_ATTRS = new Set(['AUDIO', 'VIDEO', 'SUBTITLES']); // SUBTITLES only ever matches the one kept rendition (see compatPlaylist)

const unquote = (v: string) => v.replace(/^"|"$/g, '');

/**
 * Cast / AirPlay compatibility master: the receivers (Apple TV, AirPlay 2 TVs from LG, Samsung, Sony, Vizio, Roku ..., Chromecast's
 * Default Media Receiver) get a strict, plain Apple-HLS master playlist. Field bug: an LG webOS TV fetched Jellyfin's master and then
 * nothing else (MEDIA_ERR_SRC_NOT_SUPPORTED) - the only non-Apple element in it was Jellyfin's trickplay line.
 * - `#EXT-X-IMAGE-*` (Roku-style trickplay image playlists, `#EXT-X-IMAGE-STREAM-INF ... CODECS="jpeg"`) is dropped, in any playlist;
 *   an image tag without a URI attribute takes the URI line after it along.
 * - `#EXT-X-MEDIA:TYPE=SUBTITLES` / `TYPE=CLOSED-CAPTIONS` groups are dropped (receivers have failed on subtitle groups; cast
 *   subtitles use their own side-loaded path), and with them the `SUBTITLES=` / `CLOSED-CAPTIONS=` references.
 * - `#EXT-X-STREAM-INF` keeps only BANDWIDTH, AVERAGE-BANDWIDTH, CODECS, RESOLUTION, FRAME-RATE, and AUDIO / VIDEO when that group
 *   is still declared. VIDEO-RANGE ruling (draft-pantos-hls-rfc8216bis-17): it carries NO EXT-X-VERSION requirement (section 8 ties
 *   versions only to IV, float EXTINF, BYTERANGE, MAP, INSTREAM-ID SERVICE, variable substitution, SKIP, QUERYPARAM and REQ-
 *   attributes), but it is a 2nd-edition attribute that RFC 8216 (1st edition) parsers in older TV firmware do not know, and
 *   "its absence implies a value of SDR". The cast stream is forced to H.264 8 bit (Level 41, MaxVideoBitDepth 8), i.e. SDR, so
 *   dropping it loses nothing and removes one more thing a strict receiver can choke on. HDCP-LEVEL, ALLOWED-CPC, PATHWAY-ID,
 *   SUPPLEMENTAL-CODECS, REQ-* and other newer attributes go for the same reason.
 *   Exception (`opts.keepSubtitleIndex`, AirPlay tokens whose authz scope says `hlsSub` with that `hlsSubIndex`): Jellyfin lists EVERY text track
 *   (DEFAULT=YES on the requested one, LANGUAGE after URI), so the rendition is picked by its URI, never by position: the first
 *   `TYPE=SUBTITLES` line whose URI path ends in `Subtitles/<index>/subtitles.m3u8` stays, rewritten
 *   to exactly `TYPE, GROUP-ID, NAME, LANGUAGE, DEFAULT=YES, AUTOSELECT=YES, FORCED=NO, URI` (nothing else of the upstream line survives),
 *   and `SUBTITLES="<that group>"` stays on `#EXT-X-STREAM-INF`. Without GROUP-ID or URI, with an odd value or without that track it is
 *   dropped like the rest (no fallback to another track). LANGUAGE stays only when it is a language tag (Jellyfin writes "Unknown"); a missing
 *   NAME becomes the fixed "Subtitles" (intentionally not localised: the playlist is not per-language). Other subtitle groups and every
 *   CLOSED-CAPTIONS rendition always go. `opts.checkUri` re-checks the exact URI string that is emitted (sanitizePlaylist's origin / prefix check).
 * - Every other tag (EXTM3U, EXT-X-VERSION, EXT-X-INDEPENDENT-SEGMENTS, media playlist tags, EXT-X-I-FRAME-STREAM-INF ...) and all
 *   media playlists stay as they are.
 * Runs on the already URI-checked / token-stripped lines (sanitizePlaylist), so the hardening is unaffected.
 */
export function compatPlaylist(lines: string[], opts: { keepSubtitleIndex?: number; checkUri?: (uri: string) => void } = {}): string[] {
  const dropTypes = /^(SUBTITLES|CLOSED-CAPTIONS)$/;
  const groups = new Set<string>(); // `TYPE:GROUP-ID` of kept EXT-X-MEDIA renditions
  const keptSub: { line: number; text: string }[] = []; // the requested track's rendition AirPlay keeps (the first line matching keepSubtitleIndex; at most one entry)
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-MEDIA:')) return;
    const a = new Map(hlsAttrs(line.slice(13)));
    const type = a.get('TYPE') ?? '';
    if (!dropTypes.test(type)) groups.add(`${type}:${unquote(a.get('GROUP-ID') ?? '')}`);
    else if (type === 'SUBTITLES' && opts.keepSubtitleIndex !== undefined && !keptSub.length) {
      const group = a.get('GROUP-ID');
      const uri = a.get('URI');
      const name = a.get('NAME');
      const lang = a.get('LANGUAGE');
      const plain = /^"[^"\\]*"$/; // only plain quoted strings are re-emitted
      const m = uri && /^"[^"'\\,\s]+"$/.test(uri) ? /(?:^|\/)Subtitles\/(\d{1,3})\/subtitles\.m3u8$/.exec(unquote(uri).split('?')[0]!) : null;
      if (group && plain.test(group) && m && Number(m[1]) === opts.keepSubtitleIndex) {
        opts.checkUri?.(unquote(uri!));
        keptSub.push({
          line: i,
          text: `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=${group},NAME=${name && plain.test(name) ? name : '"Subtitles"'}${lang && /^"[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*"$/.test(lang) ? `,LANGUAGE=${lang}` : ''},DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI=${uri}`,
        });
        groups.add(`SUBTITLES:${unquote(group)}`);
      }
    }
  });
  const out: string[] = [];
  let skipUri = false;
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (skipUri && t && !t.startsWith('#')) { skipUri = false; continue; }
    if (t.startsWith('#EXT-X-IMAGE-')) {
      if (/-INF:/.test(t) && !/URI\s*=/i.test(t)) skipUri = true;
      continue;
    }
    if (t.startsWith('#EXT-X-MEDIA:')) {
      if (dropTypes.test(new Map(hlsAttrs(t.slice(13))).get('TYPE') ?? '')) {
        if (keptSub[0]?.line === i) out.push(keptSub[0].text);
        continue;
      }
      out.push(line);
      continue;
    }
    if (t.startsWith('#EXT-X-STREAM-INF:')) {
      const kept = hlsAttrs(t.slice(18)).filter(([k, v]) => COMPAT_STREAM_ATTRS.has(k) || (COMPAT_GROUP_ATTRS.has(k) && groups.has(`${k}:${unquote(v)}`)));
      out.push(`#EXT-X-STREAM-INF:${kept.map(([k, v]) => `${k}=${v}`).join(',')}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Cast playlist hardening: strips api_key-like params from every URI and refuses (null) any URI that does not stay inside
 * /media/c/<token>/ on the same origin once resolved against the playlist's own URL (absolute URLs, //host, /abs paths,
 * ../ escapes, backslash tricks): the receiver would otherwise fetch from another host/path and leak or bypass the gateway.
 * `requestPath` is the public path the playlist was requested at (/media/c/<token>/Videos/<id>/main.m3u8).
 * Then the compatibility rewrite for the receivers (compatPlaylist; `opts.keepSubtitleIndex` from the token's authz scope). Every line is
 * URI-checked first, also the ones it drops and the subtitle rendition it may keep.
 */
export function sanitizePlaylist(text: string, requestPath: string, strip: ReadonlySet<string> = jellyfinUpstream.stripQuery, opts: { keepSubtitleIndex?: number } = {}): string | null {
  const m = CAST_ROUTE.exec(requestPath);
  if (!m) return null;
  const prefix = `${CAST_PREFIX}${m[1]}/`;
  const base = `https://h${requestPath.slice(0, requestPath.lastIndexOf('/') + 1)}`;
  let bad = false;
  const check = (u: string) => {
    if (u.includes('\\')) return void (bad = true);
    try {
      const r = new URL(u, base);
      if (r.origin !== 'https://h' || !r.pathname.startsWith(prefix)) bad = true;
    } catch {
      bad = true;
    }
  };
  const out = text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) {
      return line.replace(/(URI\s*=\s*["']?)([^"',]*)/gi, (_m, pre: string, u: string) => {
        check(u);
        return `${pre}${stripUriTokens(u, strip)}`;
      });
    }
    const t = line.trim();
    if (!t) return line;
    check(t);
    return stripUriTokens(t, strip);
  });
  // the kept subtitle line's exact URI string is checked once more, as emitted (`check` is the same origin / prefix rule)
  const res = compatPlaylist(out, { ...opts, checkUri: check });
  return bad ? null : res.join('\n');
}

export function createGateway(opts: GatewayOptions): { server: Server; metrics: () => string } {
  const f = opts.fetchImpl ?? fetch;
  const up = opts.upstream ?? jellyfinUpstream;
  const onJoinedSegment = opts.onJoinedSegment ?? joinedProgressSender({ backendUrl: opts.backendUrl, internalSecret: opts.internalSecret, fetchImpl: f });
  const upstreamUrl = opts.upstreamUrl;
  if (!upstreamUrl) throw new Error('gateway: upstreamUrl missing');
  const currentUrl = typeof upstreamUrl === 'function' ? upstreamUrl : (() => { const u = new URL(upstreamUrl).href; return () => u; })();
  /** the media server base for this request (parsed once per URL); null = none yet or not a URL */
  let parsed: { raw: string; url: URL | null } | undefined;
  const upstreamBase = (): URL | null => {
    const raw = currentUrl();
    if (!raw) return null;
    if (parsed?.raw !== raw) {
      let url: URL | null = null;
      try { url = new URL(raw); } catch { /* answered as "no upstream" */ }
      parsed = { raw, url };
    }
    return parsed.url;
  };
  /** every /internal/authz* answer tells the settings revision; a newer one makes remoteConfig refetch the upstream */
  const noteRev = (r: Response) => opts.onConfigRev?.(r.headers.get('x-ff-config-rev'));
  const authCache = new Map<string, { exp: number; v: Authz | null }>();
  const castCache = new Map<string, { exp: number; v: Authz | null }>();
  const castFails = new Map<string, { start: number; hashes: Set<string>; blockedUntil: number }>();
  const dlOpen = new Map<string, number>();
  const dlCache = new Map<string, { exp: number; v: DownloadAuthz | 401 | 404 }>();
  const m = { dlBytes: 0, bytes: 0, active: 0, req: new Map<string, number>(), cast: new Map<string, number>() };
  const count = (k: string) => m.req.set(k, (m.req.get(k) ?? 0) + 1);

  const metrics = () =>
    [
      '# TYPE friendflix_gateway_bytes_total counter',
      `friendflix_gateway_bytes_total ${m.bytes}`,
      '# TYPE friendflix_gateway_download_bytes_total counter',
      `friendflix_gateway_download_bytes_total ${m.dlBytes}`,
      '# TYPE friendflix_gateway_active_streams gauge',
      `friendflix_gateway_active_streams ${m.active}`,
      '# TYPE friendflix_gateway_requests_total counter',
      ...[...m.req].map(([k, v]) => `friendflix_gateway_requests_total{code="${k}"} ${v}`),
      '# TYPE friendflix_gateway_cast_requests_total counter',
      ...[...m.cast].map(([k, v]) => `friendflix_gateway_cast_requests_total{code="${k}"} ${v}`),
    ].join('\n') + '\n';

  /**
   * Session -> media credentials, memoised 5 s (denials 2 s). Single flight: the ~30 image/segment requests a page fires right
   * after the memo expired share ONE backend call. Backend failures (network, 5xx such as 503 setup_required, a refused secret) are
   * 'error' (503 to the client) and are not memoised, so the next request retries.
   */
  const authInflight = new Map<string, Promise<Authz | null | 'error'>>();

  /** Upstream.authorize helper: item visibility of the session's active profile (backend /internal/authz/item), memoised 5 s. */
  const itemCache = new Map<string, { exp: number; v: boolean }>();
  async function checkItem(sid: string, itemId: string, kind: 'media' | 'image' | 'subtitle'): Promise<boolean> {
    const id = lc(itemId);
    if (!/^[0-9a-f]{32}$/.test(id)) return false;
    const key = `${sha256(sid)}|${id}`; // never keep the raw session id as a key; visibility does not depend on the kind
    const hit = itemCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const r = await f(new URL('/internal/authz/item', opts.backendUrl), {
      method: 'POST',
      headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ sid, itemId: id, kind }),
      signal: AbortSignal.timeout(5000),
    });
    noteRev(r);
    if (r.status === 401) return false;
    if (!r.ok) throw new Error(`authz/item ${r.status}`); // backend trouble: 503, not cached
    const v = ((await r.json()) as { allow?: unknown }).allow === true;
    itemCache.set(key, { exp: Date.now() + 5_000, v });
    if (itemCache.size > 5000) itemCache.clear();
    return v;
  }
  /** The backend lowers maxBitrate for callers outside the home networks, so the answer depends on the client address (same rule as clientKey). */
  async function authorize(cookie: string | undefined, ip: string): Promise<Authz | null | 'error'> {
    const sid = /(?:^|;\s*)ff_sid=([\w-]+)/.exec(cookie ?? '')?.[1];
    if (!sid) return null;
    const key = `${sid}|${ip}`;
    const hit = authCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const running = authInflight.get(key);
    if (running) return running;
    const p = (async () => {
      let v: Authz | null | 'error' = null;
      try {
        const r = await f(new URL('/internal/authz', opts.backendUrl), {
          method: 'POST',
          headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
          body: JSON.stringify({ sid, ip }),
          signal: AbortSignal.timeout(5000),
        });
        noteRev(r);
        if (r.ok) v = (await r.json()) as Authz;
        else if (![400, 401].includes(r.status)) v = 'error'; // 400/401 = no usable session (memoised); anything else is the backend's trouble
      } catch {
        v = 'error';
      }
      if (v !== 'error') {
        authCache.set(key, { exp: Date.now() + (v ? 5_000 : 2_000), v });
        if (authCache.size > 5000) authCache.clear();
      }
      return v;
    })().finally(() => authInflight.delete(key));
    authInflight.set(key, p);
    return p;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return end(res, 200, '{"status":"ok"}', 'application/json');
    if (url.pathname === '/metrics') {
      if (opts.metricsToken && req.headers.authorization !== `Bearer ${opts.metricsToken}`) return end(res, 401, 'unauthorized');
      return end(res, 200, metrics(), 'text/plain; version=0.0.4');
    }
    // no media server yet (setup not done): 503 before any backend call; /health stays 200 so the container is not restarted
    if (url.pathname.startsWith('/media/') && !upstreamBase()) {
      const cast = url.pathname.startsWith(CAST_PREFIX); // a receiver must be able to read the 503 (CORS), counted as a cast request
      (cast ? castCount : count)('503');
      return end(res, 503, 'unavailable', 'text/plain', { 'retry-after': '5', 'cache-control': 'no-store', ...(cast ? CAST_CORS : {}) });
    }
    if (url.pathname.startsWith(CAST_PREFIX)) return handleCast(req, res, url);
    if (url.pathname.startsWith('/media/d/')) return handleDownload(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
    if (!url.pathname.startsWith('/media/')) return end(res, 404, 'not found');

    const path = normalizePath(url.pathname.slice('/media'.length), up.paths);
    if (!path) {
      count('403');
      return end(res, 403, 'forbidden');
    }
    if (tooLong(url)) {
      count('414');
      return end(res, 414, 'query too long');
    }
    const t0 = performance.now();
    const auth = await authorize(req.headers.cookie, authClientIp(req.headers, req.socket.remoteAddress));
    const authzMs = performance.now() - t0;
    if (auth === 'error') {
      count('503');
      return end(res, 503, 'unavailable', 'text/plain', { 'cache-control': 'no-store' });
    }
    if (!auth) {
      count('401');
      return end(res, 401, 'unauthorized');
    }
    if (blocksDirectStream(path, auth, up)) {
      count('403');
      return end(res, 403, 'forbidden');
    }
    if (up.authorize) {
      const sid = /(?:^|;\s*)ff_sid=([\w-]+)/.exec(req.headers.cookie ?? '')![1]!;
      const ok = await up.authorize({ path, query: url.searchParams, cast: false, checkItem: (id, kind) => checkItem(sid, id, kind) }).catch(() => 'error' as const);
      if (ok !== true) {
        count(ok === 'error' ? '503' : '403');
        return ok === 'error' ? end(res, 503, 'unavailable') : end(res, 403, 'forbidden');
      }
    }
    return forward(req, res, url, path, auth, count, false, false, authzMs);
  }

  /** 'error' = backend failing (not cached, 503). null = unknown/invalid session or licence. */
  async function authorizeDownload(sid: string, dl: string): Promise<DownloadAuthz | 401 | 404 | 'error'> {
    const key = `${sha256(sid)}|${dl}`; // never keep the raw session id as a key
    const hit = dlCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    let v: DownloadAuthz | 401 | 404 = 401;
    try {
      const r = await f(new URL('/internal/authz', opts.backendUrl), {
        method: 'POST',
        headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ sid, dl }),
        signal: AbortSignal.timeout(5000),
      });
      noteRev(r);
      if (r.ok) {
        const j = (await r.json()) as DownloadAuthz;
        if (!j?.download || (j.download.kind !== 'file' && j.download.kind !== 'static')) return 'error';
        v = j;
      } else if (r.status === 404) v = 404;
      else if (r.status !== 401) return 'error';
    } catch {
      return 'error';
    }
    dlCache.set(key, { exp: Date.now() + (typeof v === 'object' ? 5_000 : 2_000), v });
    if (dlCache.size > 5000) dlCache.clear();
    return v;
  }

  /** GET/HEAD /media/d/<downloadId>: cookie auth + licence check; no query, no CORS, never cacheable. */
  async function handleDownload(req: IncomingMessage, res: ServerResponse, url: URL) {
    const fail = (code: number, body: string, extra: Record<string, string> = {}) => {
      count(String(code));
      return end(res, code, body, 'text/plain', { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    };
    const mm = DL_ROUTE.exec(url.pathname);
    if (!mm) return fail(404, 'not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed', { allow: 'GET, HEAD' });
    if (url.search !== '') return fail(400, 'bad request'); // nothing in the query may influence what is served
    const sid = /(?:^|;\s*)ff_sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sid) return fail(401, 'unauthorized');
    const t0 = performance.now();
    const auth = await authorizeDownload(sid, mm[1]!);
    const authzMs = performance.now() - t0;
    if (auth === 'error') return fail(503, 'unavailable');
    if (auth === 401) return fail(401, 'unauthorized');
    if (auth === 404) return fail(404, 'not found');

    const head = req.method === 'HEAD';
    if (!head) {
      if ((dlOpen.get(auth.userId) ?? 0) >= DL_MAX_OPEN) return fail(429, 'too many downloads', { 'retry-after': '5' });
      dlOpen.set(auth.userId, (dlOpen.get(auth.userId) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const n = (dlOpen.get(auth.userId) ?? 1) - 1;
        if (n <= 0) dlOpen.delete(auth.userId);
        else dlOpen.set(auth.userId, n);
      };
      res.once('close', release);
    }

    const t = auth.download;
    if (t.kind === 'static') {
      const path = normalizePath(t.path, up.paths);
      if (!path) return fail(403, 'forbidden');
      const target = new URL(path, 'http://x');
      for (const [k, v] of Object.entries(t.query ?? {})) target.searchParams.set(k, v);
      return forward(req, res, target, path, auth, count, false, true, authzMs);
    }
    return serveFile(req, res, t);
  }

  async function serveFile(req: IncomingMessage, res: ServerResponse, t: Extract<DownloadTarget, { kind: 'file' }>) {
    const fail = (code: number, body: string, extra: Record<string, string> = {}) => {
      count(String(code));
      return end(res, code, body, 'text/plain', { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    };
    if (!opts.downloadDir) return fail(503, 'unavailable');
    if (!DL_FILE.test(t.file) || !DL_ETAG.test(t.etag) || !Number.isSafeInteger(t.size) || t.size < 0) return fail(500, 'error');
    const root = await realpath(resolve(opts.downloadDir)).catch(() => null);
    if (!root) return fail(503, 'unavailable');
    const full = resolve(root, t.file);
    if (!full.startsWith(root + sep)) return fail(500, 'error');
    let fh;
    try {
      fh = await open(full, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    } catch {
      return fail(404, 'not found');
    }
    let handedOver = false;
    try {
      const st = await fh.stat();
      const real = await realpath(full).catch(() => null);
      if (!st.isFile() || real !== full) return fail(404, 'not found');
      if (st.size !== t.size) return fail(503, 'not ready', { 'retry-after': '30' });
      const size = st.size;
      const etag = `"${t.etag}"`;
      const base: Record<string, string> = {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        etag,
        vary: 'Cookie',
      };
      let start = 0;
      let endB = size - 1;
      let partial = false;
      const rh = req.headers.range;
      const ifRange = req.headers['if-range'];
      if (typeof rh === 'string' && (ifRange === undefined || ifRange === etag)) {
        const r = /^bytes=(\d*)-(\d*)$/.exec(rh.trim()); // exactly one range; lists and other units are refused
        let ok = false;
        if (r && (r[1] || r[2])) {
          if (!r[1]) {
            const n = Number(r[2]);
            if (n > 0) { start = Math.max(0, size - n); endB = size - 1; ok = size > 0; }
          } else {
            start = Number(r[1]);
            endB = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
            ok = start < size && start <= endB;
          }
        }
        if (!ok) return fail(416, 'range not satisfiable', { 'content-range': `bytes */${size}` });
        partial = true;
      }
      const len = size === 0 ? 0 : endB - start + 1;
      const hdr = { ...base, 'content-length': String(len), ...(partial ? { 'content-range': `bytes ${start}-${endB}/${size}` } : {}) };
      count(partial ? '206' : '200');
      res.writeHead(partial ? 206 : 200, hdr);
      if (req.method === 'HEAD' || len === 0) return void res.end();
      handedOver = true;
      m.active++;
      const rs = fh.createReadStream({ start, end: endB, autoClose: true });
      rs.on('data', (c) => (m.dlBytes += c.length));
      rs.on('error', () => res.destroy());
      res.once('close', () => {
        m.active--;
        rs.destroy();
      });
      rs.pipe(res);
    } finally {
      if (!handedOver) await fh.close().catch(() => {});
    }
  }

  const tooLong = (url: URL) => url.search.length > 2049 || [...url.searchParams].length > 40;

  // ---- Chromecast: /media/c/<token>/<jellyfin path> (token in the path because the receiver sends no cookies) ----
  const castCount = (k: string) => m.cast.set(k, (m.cast.get(k) ?? 0) + 1);
  const clientKey = (req: IncomingMessage) => {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.slice(0, 64);
    const xff = req.headers['x-forwarded-for'];
    const last = (typeof xff === 'string' ? xff : '').split(',').pop()?.trim(); // the proxy appends the real peer last
    return (last || req.socket.remoteAddress || 'unknown').slice(0, 64);
  };
  const isBlocked = (ip: string) => (castFails.get(ip)?.blockedUntil ?? 0) > Date.now();
  /** counts DISTINCT failing token hashes per window: one stale/revoked token retried by a receiver is not an attack, guessing is */
  function noteFail(ip: string, tokenHash: string) {
    const now = Date.now();
    let e = castFails.get(ip);
    if (!e || now - e.start > 60_000) e = { start: now, hashes: new Set(), blockedUntil: e?.blockedUntil ?? 0 };
    if (e.hashes.size <= CAST_FAIL_LIMIT) e.hashes.add(tokenHash); // bounded memory
    if (e.hashes.size > CAST_FAIL_LIMIT) e.blockedUntil = now + CAST_BLOCK_MS;
    castFails.set(ip, e);
    if (castFails.size > 5000) castFails.clear();
  }

  /** 'error' = backend unreachable/failing (not the caller's fault: never counted as a failed auth). */
  async function authorizeCast(ct: string, client: string): Promise<Authz | null | 'error'> {
    const key = `${sha256(ct)}|${client}`; // the raw token is never used as a cache key; the answer depends on the client (first client pins the token)
    const hit = castCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    let v: Authz | null = null;
    try {
      const r = await f(new URL('/internal/authz', opts.backendUrl), {
        method: 'POST',
        headers: { 'x-internal-secret': opts.internalSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ ct, client }),
        signal: AbortSignal.timeout(5000),
      });
      noteRev(r);
      if (r.ok) {
        const j = (await r.json()) as Authz;
        if (!j.scope) return 'error'; // a cast answer without scope would be an unscoped token: never use it
        v = j;
      } else if (r.status !== 401) return 'error';
    } catch {
      return 'error';
    }
    castCache.set(key, { exp: Date.now() + (v ? 5_000 : 2_000), v });
    if (castCache.size > 5000) castCache.clear();
    return v;
  }

  /**
   * item id (first 32-hex id of the path) and media source id (second one, subtitles only) must match the token's scope. A joined token
   * accepts each listed item only with ITS OWN media source and play session (the tuple, never a mix of two episodes).
   */
  function inScope(path: string, url: URL, scope: NonNullable<Authz['scope']>): boolean {
    if (!scope.items) return inTuple(path, url, scope);
    if (scope.items.length > JOINED_MAX_ITEMS) return false; // never minted: refuse the whole token
    const it = joinedItemOf(scope, path);
    return it !== undefined && inTuple(path, url, it);
  }
  function inTuple(path: string, url: URL, scope: CastTuple): boolean {
    const ids = path.match(/[0-9a-fA-F]{32}/g) ?? [];
    if (!ids[0] || lc(ids[0]) !== lc(scope.itemId)) return false;
    if (ids[1] && lc(ids[1]) !== lc(scope.mediaSourceId)) return false;
    for (const [k, v] of url.searchParams) {
      const lk = k.toLowerCase();
      if (lk === 'mediasourceid' && lc(v) !== lc(scope.mediaSourceId)) return false;
      if (lk === 'itemid' && lc(v) !== lc(scope.itemId)) return false; // Jellyfin's obsolete override of the route's item id
      if (lk === 'playsessionid' && v !== scope.playSessionId) return false;
    }
    return true;
  }

  async function handleCast(req: IncomingMessage, res: ServerResponse, url: URL) {
    const cors = (code: number, body: string) => end(res, code, body, 'text/plain', CAST_CORS);
    const mm = CAST_ROUTE.exec(url.pathname);
    if (!mm) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CAST_CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-allow-headers': 'Range, Content-Type', 'access-control-max-age': '600' });
      return void res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return cors(405, 'method not allowed');
    const ip = clientKey(req);
    if (isBlocked(ip)) {
      castCount('429');
      res.setHeader('retry-after', '300');
      return cors(429, 'too many requests');
    }
    const jr = JOINED_ROUTE.exec(mm[2]!);
    const sr = jr ? null : SHORT_SEG_ROUTE.exec(mm[2]!);
    if (jr || sr) {
      if (url.search !== '' || !joinedCapable(up)) {
        castCount('403'); // nothing from the receiver shapes a joined playlist or picks a segment's query; Jellyfin adapter only
        return cors(403, 'forbidden');
      }
      return jr ? handleJoined(req, res, mm[1]!, jr[1] as JoinedName, ip) : handleShortSegment(req, res, mm[1]!, Number(sr![1]), Number(sr![2]), ip);
    }
    let path = normalizeCastPath(mm[2]!, up);
    // the AirPlay subtitle rendition's own paths (query allowlisted): reachable only with an hlsSub token of that track (checked below)
    const subPath = path ? null : castHlsSubAllowed(mm[2]! + url.search, up);
    if (subPath) path = normalizePath(mm[2]!, (up.castHlsSubPaths ?? []).map((e) => e.path));
    if (!path) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (tooLong(url)) {
      castCount('414');
      return cors(414, 'query too long');
    }
    const t0 = performance.now();
    const auth = await authorizeCast(mm[1]!, ip);
    const authzMs = performance.now() - t0;
    if (auth === 'error') {
      castCount('503');
      return cors(503, 'unavailable');
    }
    if (!auth || !auth.scope) {
      noteFail(ip, sha256(mm[1]!));
      castCount('401');
      return cors(401, 'unauthorized');
    }
    return serveCast(req, res, url, path, subPath, auth as CastAuthz, authzMs);
  }

  /** the checks every authorised cast request passes (scope tuple, subtitle track, burn-in guard, adapter authz), then the proxy */
  async function serveCast(req: IncomingMessage, res: ServerResponse, url: URL, path: string, subPath: { index: number } | null, auth: CastAuthz, authzMs: number, joinedSeg?: Omit<JoinedSegment, 'positionTicks'>) {
    const cors = (code: number, body: string) => end(res, code, body, 'text/plain', CAST_CORS);
    if (auth.kind === 'img' && !up.image.test(path)) {
      castCount('403'); // poster tokens may fetch images only
      return cors(403, 'forbidden');
    }
    if (!inScope(path, url, auth.scope)) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    const subIndex = hlsSubIndexOf(auth, path);
    if (subPath && subIndex !== subPath.index) {
      castCount('403'); // not an hlsSub token, or another track than the one it asked for
      return cors(403, 'forbidden');
    }
    // never a burn-in: an hlsSub token may only name its own track, with SubtitleMethod=Hls; every other token's subtitle selectors are stripped (forward)
    if (!burnInFree(url.searchParams, subIndex)) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    if (up.authorize) {
      const scope = auth.scope;
      const ok = await up.authorize({ path, query: url.searchParams, cast: true, checkItem: async (id) => (scope.items ?? [scope]).some((i) => lc(id) === lc(i.itemId)) }).catch(() => 'error' as const);
      if (ok !== true) {
        castCount(ok === 'error' ? '503' : '403');
        return cors(ok === 'error' ? 503 : 403, ok === 'error' ? 'unavailable' : 'forbidden');
      }
    }
    if (joinedSeg) {
      const ticks = Number(url.searchParams.get('runtimeTicks') ?? NaN);
      if (Number.isSafeInteger(ticks) && ticks >= 0) {
        try { onJoinedSegment({ ...joinedSeg, positionTicks: ticks }); } catch { /* a reporting hook never breaks playback */ }
      }
    }
    return forward(req, res, url, path, auth, castCount, true, false, authzMs);
  }

  // ---- continuous AirPlay: /media/c/<ct>/joined/{master,main,subs}.m3u8 and /media/c/<ct>/s/<part>/<n>.ts (multi-item tokens only) ----
  type JoinedName = 'master' | 'main' | 'subs';
  /** the joined playlists of one token plus, per part, its item and original segment URIs ("/Videos/<id>/hls1/main/<n>.ts?...") */
  type Joined = { master: string; main: string; subs: string | null; parts: Array<{ itemId: string; segments: string[] }> };
  /** by token hash (never the raw token): two tokens never share an entry; the parts are VOD and fixed at mint */
  const joinedCache = new Map<string, { exp: number; v: Promise<Joined | null> }>();

  /** GET of one upstream path with the token's media credentials; the backend-built query minus credentials and receiver-identity keys */
  async function upstreamGet(pathWithQuery: string, auth: Authz, subIndex: number | undefined): Promise<Response | null> {
    const base = upstreamBase();
    if (!base || !pathWithQuery.startsWith('/') || pathWithQuery.startsWith('//')) return null;
    const u = new URL(pathWithQuery, base);
    if (u.origin !== base.origin) return null;
    for (const k of [...u.searchParams.keys()]) {
      const lk = k.toLowerCase();
      if (up.stripQuery.has(lk) || up.castDropQuery.has(lk) || ((lk === 'subtitlemethod' || lk === 'subtitlestreamindex') && subIndex === undefined)) u.searchParams.delete(k);
    }
    const r = await f(u.href, { headers: { ...up.authHeaders(auth), 'accept-encoding': 'identity' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r && r.status !== 200) { await r.body?.cancel().catch(() => {}); return null; }
    return r;
  }
  async function upstreamText(pathWithQuery: string, auth: Authz, subIndex: number | undefined): Promise<string | null> {
    const r = await upstreamGet(pathWithQuery, auth, subIndex);
    if (!r) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > CAST_PLAYLIST_MAX ? null : buf.toString('utf8');
  }
  /** a path the token may fetch for THIS item: an allowed cast path inside its own tuple, no burn-in selector */
  const partPathOk = (u: URL, it: JoinedItemScope, sub = false) => {
    const sp = sub ? castHlsSubAllowed(u.pathname + u.search, up) : null;
    const path = sub ? (sp && sp.index === it.hlsSubIndex ? u.pathname : null) : normalizeCastPath(u.pathname, up);
    return path !== null && inTuple(path, u, it) && burnInFree(u.searchParams, Number.isInteger(it.hlsSubIndex) ? it.hlsSubIndex : undefined);
  };

  /** the joined playlists of a token: built once after authz (cached JOINED_TTL_MS by token hash, at most JOINED_MAX entries) */
  function joined(ct: string, auth: Authz): Promise<Joined | null> {
    const key = sha256(ct);
    const now = Date.now();
    const hit = joinedCache.get(key);
    if (hit && hit.exp > now) return hit.v;
    joinedCache.delete(key);
    for (const [k, e] of joinedCache) if (e.exp <= now) joinedCache.delete(k);
    while (joinedCache.size >= JOINED_MAX) joinedCache.delete(joinedCache.keys().next().value!); // oldest first
    const entry = { exp: now + JOINED_TTL_MS, v: buildJoined(ct, auth).catch(() => null) };
    joinedCache.set(key, entry);
    void entry.v.then((j) => { if (j === null) entry.exp = Math.min(entry.exp, Date.now() + JOINED_FAIL_TTL_MS); });
    return entry.v;
  }

  async function buildJoined(ct: string, auth: Authz): Promise<Joined | null> {
    const tok = `${CAST_PREFIX}${ct}`;
    const items = auth.scope!.items!;
    const one = async (it: JoinedItemScope) => {
      const subIndex = Number.isInteger(it.hlsSubIndex) ? it.hlsSubIndex : undefined;
      if (typeof it.hlsPath !== 'string' || !it.hlsPath.startsWith('/') || it.hlsPath.startsWith('//')) return null;
      const mu = new URL(it.hlsPath, 'http://x');
      // the backend's path must be an allowed cast path of THIS item (defence in depth: the playlist decides what the TV fetches)
      if (!partPathOk(mu, it)) return null;
      const mt = await upstreamText(mu.pathname + mu.search, auth, subIndex);
      const mc = mt === null ? null : sanitizePlaylist(mt, `${tok}${mu.pathname}`, up.stripQuery, { keepSubtitleIndex: subIndex });
      const pm: PartMaster | null = mc === null ? null : readMaster(mc);
      if (!pm) return null;
      const vu = new URL(pm.variant, `http://x${mu.pathname}`);
      if (!partPathOk(vu, it)) return null;
      const vt = await upstreamText(vu.pathname + vu.search, auth, subIndex);
      const vc = vt === null ? null : sanitizePlaylist(vt, `${tok}${vu.pathname}`, up.stripQuery);
      if (vc === null) return null;
      let sub: { text: string; prefix: string } | null = null;
      if (pm.sub && subIndex !== undefined) {
        const su = new URL(pm.sub.uri, `http://x${mu.pathname}`);
        if (!partPathOk(su, it, true)) return null;
        const st = await upstreamText(su.pathname + su.search, auth, subIndex);
        if (st !== null) { // an unreachable subtitle playlist only costs the subtitles; one that fails the URI check fails the stream
          const sc = sanitizePlaylist(st, `${tok}${su.pathname}`, up.stripQuery);
          if (sc === null) return null;
          sub = { text: sc, prefix: joinedPrefix(su.pathname) };
        }
      }
      return { it, pm, video: { text: vc, prefix: joinedPrefix(vu.pathname) }, sub };
    };
    const parts = await Promise.all(items.map(one)); // in parallel: three episodes = 6-9 upstream playlist requests, once per token
    if (parts.some((p) => p === null)) return null;
    const ps = parts as NonNullable<(typeof parts)[number]>[];
    const main = joinPlaylists(ps.map((p) => p.video), { shortUris: true });
    if (!main) return null;
    // every short URI must stand for a path of ITS part's own tuple: /s/<part>/<n> never reaches another item or path
    for (const [i, p] of main.parts.entries()) {
      for (const seg of p.segments) if (!partPathOk(new URL(seg, 'http://x'), ps[i]!.it)) return null;
    }
    const withSubs = ps.every((p) => p.sub);
    const subs = withSubs ? joinPlaylists(ps.map((p) => p.sub!)) : null;
    if (withSubs && !subs) return null;
    // the joined playlists go through the same URI check as any cast playlist, at their own path
    const mainC = sanitizePlaylist(main.text, `${tok}/joined/main.m3u8`, up.stripQuery);
    const subsC = subs ? sanitizePlaylist(subs.text, `${tok}/joined/subs.m3u8`, up.stripQuery) : null;
    if (mainC === null || (withSubs && subsC === null)) return null;
    if (subs) warmSubtitles(subs.parts, ps.map((p) => p.it), auth);
    return {
      master: joinedMaster(ps.map((p) => p.pm), subsC !== null),
      main: mainC,
      subs: subsC,
      parts: main.parts.map((p, i) => ({ itemId: ps[i]!.it.itemId, segments: p.segments })),
    };
  }

  /**
   * Subtitle warm-up (spec 5.4 e): Jellyfin extracts a text track on its first request, which can stall the TV at a boundary. Right after
   * a build (= within seconds of the mint, when the TV fetches joined/master.m3u8), one fire-and-forget GET of the first subtitle segment
   * of parts 2 and 3. Body read to the end (an aborted request may cancel the extraction); failures are ignored.
   */
  function warmSubtitles(parts: Array<{ segments: string[] }>, items: JoinedItemScope[], auth: Authz) {
    for (const i of [1, 2]) {
      const seg = parts[i]?.segments[0];
      const it = items[i];
      if (!seg || !it) continue;
      const u = new URL(seg, 'http://x');
      if (!partPathOk(u, it, true)) continue;
      void upstreamGet(u.pathname + u.search, auth, it.hlsSubIndex)
        .then((r) => r?.arrayBuffer())
        .catch(() => {});
    }
  }

  /** authz of a joined route: the multi-item media token, else the answer already sent (null) */
  async function joinedAuth(res: ServerResponse, ct: string, ip: string): Promise<{ auth: CastAuthz; authzMs: number } | null> {
    const cors = (code: number, body: string) => end(res, code, body, 'text/plain', CAST_CORS);
    const t0 = performance.now();
    const auth = await authorizeCast(ct, ip);
    const authzMs = performance.now() - t0;
    if (auth === 'error') { castCount('503'); cors(503, 'unavailable'); return null; }
    if (!auth || !auth.scope) { noteFail(ip, sha256(ct)); castCount('401'); cors(401, 'unauthorized'); return null; }
    // single-item and poster tokens have no joined stream; nor has a scope longer than the cap
    const n = auth.scope.items?.length ?? 0;
    if (auth.kind === 'img' || n < 2 || n > JOINED_MAX_ITEMS) { castCount('403'); cors(403, 'forbidden'); return null; }
    return { auth: auth as CastAuthz, authzMs };
  }

  async function handleJoined(req: IncomingMessage, res: ServerResponse, ct: string, which: JoinedName, ip: string) {
    const cors = (code: number, body: string) => end(res, code, body, 'text/plain', CAST_CORS);
    const a = await joinedAuth(res, ct, ip);
    if (!a) return;
    const j = await joined(ct, a.auth);
    const text = j === null ? null : which === 'master' ? j.master : which === 'main' ? j.main : j.subs;
    if (text === null) {
      castCount(j === null ? '502' : '404'); // 404: subs.m3u8 of a stream without subtitles
      return cors(j === null ? 502 : 404, j === null ? 'bad gateway' : 'not found');
    }
    castCount('200');
    const body = Buffer.from(text, 'utf8');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': String(body.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...CAST_CORS });
    m.bytes += body.length;
    return void res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** `s/<part>/<n>.ts` -> that part's original segment path and query, then the ordinary cast checks and the proxy */
  async function handleShortSegment(req: IncomingMessage, res: ServerResponse, ct: string, part: number, n: number, ip: string) {
    const cors = (code: number, body: string) => end(res, code, body, 'text/plain', CAST_CORS);
    const a = await joinedAuth(res, ct, ip);
    if (!a) return;
    const j = await joined(ct, a.auth);
    if (j === null) {
      castCount('502');
      return cors(502, 'bad gateway');
    }
    const p = j.parts[part];
    const seg = p?.segments[n];
    if (!p || seg === undefined) {
      castCount('404');
      return cors(404, 'not found');
    }
    const url = new URL(seg, 'http://x');
    const path = normalizeCastPath(url.pathname, up);
    if (!path) {
      castCount('403');
      return cors(403, 'forbidden');
    }
    return serveCast(req, res, url, path, null, a.auth, a.authzMs, { tokenHash: sha256(ct), part, itemId: p.itemId });
  }

  async function forward(req: IncomingMessage, res: ServerResponse, url: URL, path: string, auth: Authz, countCode: (k: string) => void, cast = false, download = false, authzMs = 0) {
    const base = upstreamBase();
    if (!base) {
      countCode('503');
      return end(res, 503, 'unavailable', 'text/plain', cast ? CAST_CORS : undefined); // the upstream went away since the check in handle()
    }
    let target = new URL(path, base);
    if (target.origin !== base.origin) return end(res, 403, 'forbidden'); // SSRF guard (defence in depth)
    for (const [k, v] of url.searchParams) {
      const lk = k.toLowerCase();
      if (up.stripQuery.has(lk)) continue;
      if (cast && up.castDropQuery.has(lk)) continue; // stream/device identity comes from the token, never from the receiver's URL
      if (cast && (lk === 'subtitlemethod' || lk === 'subtitlestreamindex') && hlsSubIndexOf(auth, path) === undefined) continue; // no burn-in selector from a token without a subtitle rendition (handleCast refused wrong ones for the others)
      // resolution cap: always on the cast path (default 1080), on the cookie path when the role has one
      if ((cast || auth.maxHeight) && (up.clampHeight.includes(lk) || up.clampWidth.includes(lk))) {
        const cap = auth.maxHeight ?? 1080;
        const lim = up.clampWidth.includes(lk) ? Math.ceil((cap * 16) / 9) : cap; // widths: 16:9 equivalent of the height cap
        const n = Number(v);
        target.searchParams.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, lim) : lim));
        continue;
      }
      if (up.clampBitrate.includes(lk)) {
        const n = Number(v);
        target.searchParams.set(k, String(Number.isFinite(n) && n > 0 ? Math.min(n, auth.maxBitrate) : auth.maxBitrate));
        continue;
      }
      target.searchParams.append(k, v);
    }
    // a transcoded stream without the bitrate params would run at the source bitrate: add the missing ones at the cap
    if (up.requireBitrate?.path.test(path)) {
      const have = new Set([...target.searchParams.keys()].map((k) => k.toLowerCase()));
      for (const p of up.requireBitrate.params) if (!have.has(p.toLowerCase())) target.searchParams.set(p, String(auth.maxBitrate));
    }
    if (up.rewrite) {
      const r = up.rewrite(target.pathname, target.searchParams);
      const q = r.query.toString();
      if (!r.path.startsWith('/') || r.path.startsWith('//') || r.path.includes('\\')) return end(res, 502, 'bad gateway');
      target = new URL(`${r.path}${q ? `?${q}` : ''}`, base);
      if (target.origin !== base.origin) return end(res, 502, 'bad gateway');
    }
    const requestUrl = `${base.origin}${target.pathname}${target.search}`;
    const m3u8 = /\.m3u8$/.test(path);
    // cast playlists are always sanitised; other playlists are only touched when the adapter has a playlist() hook (Jellyfin: none)
    const playlist = m3u8 && (cast || Boolean(up.playlist));
    const extra = cast ? CAST_CORS : undefined;

    // identity: keep upstream bytes as-is so content-length matches the body we relay
    const headers: Record<string, string> = { ...up.authHeaders(auth), 'accept-encoding': 'identity' };
    // rewritten playlists are always fetched whole and unconditionally
    for (const h of playlist ? ['accept'] : ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }

    const ac = new AbortController();
    res.on('close', () => ac.abort());
    let upRes: Response;
    const tUp = performance.now();
    try {
      upRes = await f(requestUrl, { method: req.method, headers, signal: ac.signal, redirect: 'manual' });
    } catch {
      countCode('502');
      return end(res, 502, 'bad gateway', 'text/plain', extra);
    }
    countCode(String(upRes.status));
    if (upRes.status >= 300 && upRes.status < 400 && upRes.status !== 304) return end(res, 502, 'bad gateway', 'text/plain', extra);

    const out: Record<string, string> = {};
    for (const h of PASS_RESPONSE_HEADERS) {
      // fetch decodes content-encoding transparently, so the upstream length no longer describes the body
      if (h === 'content-length' && upRes.headers.get('content-encoding')) continue;
      const v = upRes.headers.get(h);
      if (v) out[h] = v;
    }
    out['x-content-type-options'] = 'nosniff';
    // authz = session check (memo hit ~0 ms), upstream = time until Jellyfin's response headers (transcoder start, image resize)
    out['server-timing'] = `authz;dur=${ms(authzMs)}, upstream;dur=${ms(performance.now() - tUp)}`;
    if (cast) {
      // the URL carries a credential: nothing may be cached (browser or shared), and CORS is open (the receiver has another origin)
      out['cache-control'] = 'no-store';
      Object.assign(out, CAST_CORS);
    } else if (download) {
      out['cache-control'] = 'no-store'; // licensed content behind a cookie: never stored by a cache, no CORS headers
      out['vary'] = 'Cookie';
    } else if (up.image.test(path) && upRes.status < 400) {
      // Images are static per `tag` (Jellyfin's image tag changes with the image): with a tag the URL is immutable, without one
      // the browser revalidates after a day. Always private: never in shared caches such as NPM (access is per user).
      // Everything else (playlists, segments, streams) stays uncacheable unless Jellyfin says otherwise.
      out['cache-control'] = hasImageTag(url) ? 'private, max-age=31536000, immutable' : 'private, max-age=86400, stale-while-revalidate=604800';
      out['vary'] = 'Cookie';
    } else {
      out['cache-control'] = (out['cache-control'] ?? 'no-store').replace(/\bpublic\b/i, 'private');
    }

    if (playlist && upRes.status === 200) {
      // buffered (<8 MB) so every URI can be checked: Jellyfin may emit api_key params or absolute URLs
      const len = Number(upRes.headers.get('content-length') ?? 0);
      if (len > CAST_PLAYLIST_MAX) return end(res, 502, 'bad gateway', 'text/plain', extra);
      if (req.method === 'HEAD') {
        delete out['content-length'];
        res.writeHead(200, out);
        return void res.end();
      }
      const buf = Buffer.from(await upRes.arrayBuffer());
      let text: string | null = buf.length > CAST_PLAYLIST_MAX ? null : buf.toString('utf8');
      if (text !== null && up.playlist) {
        try {
          text = up.playlist(text, { path, query: url.searchParams, requestPath: url.pathname, cast });
        } catch {
          text = null;
        }
      }
      const clean = text === null ? null : cast ? sanitizePlaylist(text, url.pathname, up.stripQuery, { keepSubtitleIndex: hlsSubIndexOf(auth, path) }) : text;
      if (clean === null) {
        countCode('502');
        return end(res, 502, 'bad gateway', 'text/plain', extra);
      }
      const body = Buffer.from(clean, 'utf8');
      out['content-length'] = String(body.length);
      delete out['etag'];
      res.writeHead(200, out);
      m.bytes += body.length;
      return void res.end(body);
    }

    res.writeHead(upRes.status, out);
    if (!upRes.body || req.method === 'HEAD') return void res.end();

    m.active++;
    const body = Readable.fromWeb(upRes.body as never);
    body.on('data', (c: Buffer) => { m.bytes += c.length; if (download) m.dlBytes += c.length; });
    const done = () => {
      m.active--;
    };
    res.once('close', done);
    body.on('error', () => res.destroy());
    body.pipe(res); // streamed, no buffering; backpressure handled by pipe
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) end(res, 500, 'error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65_000;
  return { server, metrics };
}

const ms = (v: number) => (Math.round(v * 10) / 10).toString();
/** a non-empty `tag` query parameter (Jellyfin image tag, hex) marks a versioned image URL */
const hasImageTag = (url: URL) => /^[\w-]{1,64}$/.test(url.searchParams.get('tag') ?? '');

function end(res: ServerResponse, code: number, body: string, type = 'text/plain', extra: Record<string, string> = {}) {
  res.writeHead(code, { 'content-type': type, ...extra });
  res.end(body);
}
