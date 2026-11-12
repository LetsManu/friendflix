// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Continuous AirPlay (admin switch CAST_AIRPLAY_CONTINUOUS): several episodes as ONE VOD stream for a multi-item AirPlay token.
 * Pure helpers only; the routes (`/media/c/<ct>/joined/{master,main,subs}.m3u8`, `/media/c/<ct>/s/<part>/<n>.ts`) live in gateway.ts.
 */
import { hlsAttrs } from './hls.js';

export interface JoinPart {
  /** one episode's media playlist, already through sanitizePlaylist (token-free, URIs relative and inside the token path) */
  text: string;
  /** what makes this part's relative URIs right from /media/c/<ct>/joined/, e.g. "../Videos/<id>/" (see joinedPrefix) */
  prefix: string;
}
export interface JoinedPartInfo {
  /** stream time (s) at which the part starts = sum of the EXTINF durations before it (that is AVPlayer's timeline) */
  start: number;
  duration: number;
  /**
   * the part's segment URIs as its own playlist names them, resolved against the part's playlist path with the query included
   * ("/Videos/<id>/hls1/main/0.ts?..."): what `../s/<part>/<n>.ts` stands for when the joined playlist uses short URIs
   */
  segments: string[];
}

const DROP_HEADER = /^#EXT(M3U|-X-(VERSION|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE|ENDLIST|INDEPENDENT-SEGMENTS|ALLOW-CACHE|DISCONTINUITY-SEQUENCE))(?=:|$)/;
/** tags the joined playlist cannot carry safely (fMP4 init, encryption, byte ranges, masters, live/event features) */
const REFUSE = /^#EXT-X-(MAP|KEY|SESSION-KEY|BYTERANGE|STREAM-INF|I-FRAME-STREAM-INF|MEDIA|PART|PRELOAD-HINT|PART-INF|SKIP|SERVER-CONTROL|DATERANGE|GAP)(?=:|$)/;
/** a segment URI a part may carry: relative, no scheme, no absolute path, no escape */
const SAFE_REL = /^(?![a-z][a-z0-9+.-]*:)(?!\/)[^\s\\]+$/i;
/** the directory the parts' prefixes are relative to (only its depth matters: one level below the token path) */
const JOINED_DIR = 'http://joined.invalid/joined/';

/**
 * Joins media playlists into one VOD media playlist: EXT-X-TARGETDURATION = max, EXT-X-VERSION = max, EXT-X-DISCONTINUITY
 * before each later part, one EXT-X-ENDLIST. Each part's URIs get its own prefix; with `o.shortUris` every segment URI is
 * `../s/<part>/<n>.ts` instead (n = the segment's index in its part) and only `parts[part].segments[n]` knows the original.
 * Null when any part is not a plain, complete VOD media playlist (no ENDLIST, fMP4 map, keys, byte ranges, a master, a URI
 * outside the relative form, an EXTINF without URI ...). The caller re-checks the result with sanitizePlaylist at the joined path.
 */
export function joinPlaylists(parts: JoinPart[], o: { shortUris?: boolean } = {}): { text: string; parts: JoinedPartInfo[] } | null {
  if (parts.length === 0) return null;
  let version = 3;
  let target = 1;
  let start = 0;
  const body: string[] = [];
  const info: JoinedPartInfo[] = [];
  for (const [n, p] of parts.entries()) {
    const lines = p.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST')) return null;
    if (!/^(\.\.\/)?[\w./-]*\/$/.test(p.prefix) || p.prefix.includes('/../')) return null;
    let dur = 0;
    const segments: string[] = [];
    let pendingInf: string | null = null;
    const out: string[] = [];
    for (const l of lines) {
      if (l.startsWith('#')) {
        if (REFUSE.test(l)) return null;
        const v = /^#EXT-X-VERSION:(\d+)$/.exec(l);
        if (v) { version = Math.max(version, Number(v[1])); continue; }
        const t = /^#EXT-X-TARGETDURATION:(\d+)$/.exec(l);
        if (t) { target = Math.max(target, Number(t[1])); continue; }
        if (l === '#EXT-X-ENDLIST') break;
        if (DROP_HEADER.test(l)) continue;
        if (l.startsWith('#EXTINF:')) {
          if (pendingInf) return null; // two EXTINF in a row
          const d = Number(/^#EXTINF:([0-9.]+)/.exec(l)?.[1]);
          if (!Number.isFinite(d) || d <= 0) return null;
          pendingInf = l;
          dur += d;
          target = Math.max(target, Math.round(d)); // RFC 8216 4.3.3.1: rounded EXTINF <= TARGETDURATION
          continue;
        }
        if (l === '#EXT-X-DISCONTINUITY') { out.push(l); continue; }
        if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME')) continue;
        if (l.startsWith('#EXT-X-')) return null; // unknown tag: strict (a receiver has choked on one before)
        continue; // plain comment
      }
      if (!pendingInf || !SAFE_REL.test(l) || l.split('?')[0]!.split('/').includes('..')) return null;
      const abs = new URL(`${p.prefix}${l}`, JOINED_DIR);
      out.push(pendingInf, o.shortUris ? `../s/${n}/${segments.length}.ts` : `${p.prefix}${l}`);
      segments.push(abs.pathname + abs.search);
      pendingInf = null;
    }
    if (pendingInf || segments.length === 0) return null;
    if (n > 0) body.push('#EXT-X-DISCONTINUITY');
    body.push(...out);
    info.push({ start, duration: dur, segments });
    start += dur;
  }
  const head = ['#EXTM3U', `#EXT-X-VERSION:${version}`, '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  return { text: [...head, ...body, '#EXT-X-ENDLIST', ''].join('\n'), parts: info };
}

export interface PartMaster {
  /** attributes of the first #EXT-X-STREAM-INF of the part's (compat) master */
  inf: Map<string, string>;
  /** the variant URI after it (relative to the master) */
  variant: string;
  /** the kept subtitle rendition (compatPlaylist with keepSubtitleIndex): its URI, NAME, LANGUAGE */
  sub?: { uri: string; name?: string; language?: string };
}

/** First variant and the kept subtitle rendition of a sanitised compat master; null when it has no variant. */
export function readMaster(text: string): PartMaster | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let sub: PartMaster['sub'];
  for (const [i, l] of lines.entries()) {
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = new Map(hlsAttrs(l.slice(13)));
      if (a.get('TYPE') === 'SUBTITLES' && a.get('URI')) sub = { uri: a.get('URI')!.replace(/^"|"$/g, ''), name: a.get('NAME'), language: a.get('LANGUAGE') };
    }
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const variant = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (!variant) return null;
      return { inf: new Map(hlsAttrs(l.slice(18))), variant, ...(sub ? { sub } : {}) };
    }
  }
  return null;
}

/**
 * The joined master: one variant (`main.m3u8`) with the highest BANDWIDTH / AVERAGE-BANDWIDTH of the parts and that part's
 * CODECS, RESOLUTION, FRAME-RATE; plus one subtitle rendition (`subs.m3u8`, NAME / LANGUAGE of part 1) when every part kept one.
 */
export function joinedMaster(parts: PartMaster[], withSubs: boolean): string {
  const num = (m: Map<string, string>, k: string) => Number(m.get(k) ?? 0) || 0;
  const top = parts.reduce((a, b) => (num(b.inf, 'BANDWIDTH') > num(a.inf, 'BANDWIDTH') ? b : a));
  const bw = Math.max(...parts.map((p) => num(p.inf, 'BANDWIDTH')));
  const abw = Math.max(...parts.map((p) => num(p.inf, 'AVERAGE-BANDWIDTH') || num(p.inf, 'BANDWIDTH')));
  const attrs = [`BANDWIDTH=${bw}`, `AVERAGE-BANDWIDTH=${abw}`];
  for (const k of ['CODECS', 'RESOLUTION', 'FRAME-RATE']) if (top.inf.get(k)) attrs.push(`${k}=${top.inf.get(k)}`);
  const out = ['#EXTM3U', '#EXT-X-VERSION:3'];
  if (withSubs && parts[0]?.sub) {
    const s = parts[0].sub;
    const name = s.name && /^"[^"\\]*"$/.test(s.name) ? s.name : '"Subtitles"';
    const lang = s.language && /^"[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*"$/.test(s.language) ? `,LANGUAGE=${s.language}` : '';
    out.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME=${name}${lang},DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"`);
    attrs.push('SUBTITLES="subs"');
  }
  out.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, 'main.m3u8', '');
  return out.join('\n');
}

/** "/Videos/<id>/main.m3u8" -> "../Videos/<id>/": the prefix of that playlist's relative URIs as seen from /media/c/<ct>/joined/ */
export const joinedPrefix = (upstreamPlaylistPath: string) => `..${upstreamPlaylistPath.slice(0, upstreamPlaylistPath.lastIndexOf('/') + 1)}`;
