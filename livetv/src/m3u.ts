// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';

/**
 * The M3U reader of `/v1/fetch/m3u` (spec §3.2, §3.4). Provider lists are hostile input: every line is capped at 8 KB (a longer
 * line skips its entry), VOD entries are dropped, at most `max` live entries are kept, and nothing of the input ever reaches an
 * error text (the only error is `not_m3u`). Keys follow plan ruling 18 (credential path segments do not change them).
 */
export interface M3uEntry {
  key: string;
  name: string;
  tvgId?: string;
  tvgName?: string;
  chno?: number;
  group?: string;
  logo?: string;
  shiftMin?: number;
  pos: number /* 0-based among all live entries */;
  url: string;
  kind: 'hls' | 'ts' | 'srt';
  userAgent?: string;
}
/** what `parseM3u` returns and `POST /v1/fetch/m3u` answers (the backend re-declares it field for field) */
export interface M3uResult {
  entries: M3uEntry[];
  /** every group of a live entry, in list order, with its count of live entries (skipped groups included) */
  groups: Array<{ name: string; channels: number }>;
  /** every live entry (skipped groups and entries over the limit included) */
  listed: number;
  skipped: { vod: number; invalid: number; overLimit: number; groups: number };
}

export class M3uError extends Error {
  constructor(readonly code: 'not_m3u') {
    super(code);
    this.name = 'M3uError';
  }
}

export const MAX_LINE = 8 * 1024;
export const MAX_ENTRIES = 20_000;
const SHIFT_MIN_H = -12;
const SHIFT_MAX_H = 14;

/** `tvg-shift` hours (decimals allowed) → whole minutes; outside −12…+14 h or not a number → undefined (plan ruling 42) */
export function parseShift(raw: string | undefined): number | undefined {
  const s = raw?.trim();
  if (!s || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return undefined;
  const h = Number(s);
  if (h < SHIFT_MIN_H || h > SHIFT_MAX_H) return undefined;
  return Math.round(h * 60);
}

/**
 * A channel name for matching: lowercase, NFKD without combining marks, only letters and digits, a trailing `hd|fhd|uhd|4k`
 * dropped. Copied verbatim into the backend's `epg.ts` (Task 17), pinned by `test-vectors/livetv-normname.json`.
 */
export function normName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '').replace(/(?:fhd|uhd|hd|4k)$/, '');
}

/**
 * A channel's identity inside its source: the `tvg-id` when there is one; otherwise (plan ruling 18)
 * `sha256(normName(name) + '|' + host + '|' + last path segment)[0..32]`. Userinfo, port, query and the other path segments
 * (Xtream lists carry user and password there) are left out, so a password change keeps every key.
 */
export function entryKey(e: { tvgId?: string; name: string; url: string }): string {
  const id = e.tvgId?.trim();
  if (id) return id;
  let host = '';
  let last = '';
  try {
    const u = new URL(e.url);
    host = u.hostname.toLowerCase();
    last = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
  } catch {
    // parseM3u only passes valid URLs; anything else hashes its name alone
  }
  return createHash('sha256').update(`${normName(e.name)}|${host}|${last}`).digest('hex').slice(0, 32);
}

/**
 * Bytes → lines (LF; a CR before it dropped; UTF-8). A line longer than `maxLine` bytes is cut after `maxLine + 1` bytes (the rest
 * is dropped as it arrives, never buffered), so the parser still sees it as too long.
 */
export async function* splitLines(bytes: AsyncIterable<Uint8Array>, maxLine = MAX_LINE): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let len = 0;
  const take = (b: Buffer) => {
    const room = maxLine + 1 - len;
    if (room <= 0) return;
    const part = b.length > room ? b.subarray(0, room) : b;
    parts.push(part);
    len += part.length;
  };
  const flush = () => {
    let line = Buffer.concat(parts, len);
    parts = [];
    len = 0;
    if (line.length > 0 && line.length <= maxLine && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    return line.toString('utf8');
  };
  for await (const chunk of bytes) {
    const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let nl = b.indexOf(0x0a, start); nl !== -1; nl = b.indexOf(0x0a, start)) {
      take(b.subarray(start, nl));
      yield flush();
      start = nl + 1;
    }
    take(b.subarray(start));
  }
  if (len > 0) yield flush();
}

/** `key="quoted value"` or `key=unquoted`; names as providers write them (`tvg-id`, `group-title`, `tvg-shift`) */
const ATTR = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^\s,"]*))/g;
function attrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.matchAll(ATTR)) {
    const k = m[1]!.toLowerCase();
    if (!out.has(k)) out.set(k, (m[2] ?? m[3] ?? '').trim());
  }
  return out;
}
/** `#EXTINF:-1 attrs,Title` → the attribute part and the title (after the first comma outside quotes) */
function splitInfo(rest: string): { attrPart: string; title: string } {
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) return { attrPart: rest.slice(0, i), title: rest.slice(i + 1).trim() };
  }
  return { attrPart: rest, title: '' };
}
const nonEmpty = (v: string | undefined) => (v ? v : undefined);
const VOD = /\/(?:movie|series)\/|\.(?:mp4|mkv|avi|mov)$/i;

type Pending = { info?: Map<string, string>; title?: string; group?: string; userAgent?: string; broken?: boolean };

/**
 * Parse an M3U list. `#EXTM3U` must come first (blank lines aside; else `not_m3u`); its `tvg-shift` is every entry's default.
 * An entry is `#EXTINF` (+ `#EXTGRP`, `#EXTVLCOPT:http-user-agent=`) and its URL line. Invalid (counted, dropped): a line over
 * 8 KB anywhere in the entry, a URL without `#EXTINF`, a URL that is not http/https/srt, no name. VOD (§3.4) is counted apart.
 * Every other entry is live: it counts in `listed`, `groups` and `pos`, gets its key (duplicates `:2`, `:3`, counted over all live
 * entries so a selection never changes a key); then entries of `skipGroups` are dropped, and past `max` kept ones `overLimit`.
 */
export async function parseM3u(lines: AsyncIterable<string>, o: { max: number; skipGroups?: ReadonlySet<string> }): Promise<M3uResult> {
  const entries: M3uEntry[] = [];
  const groups = new Map<string, number>();
  const skipped = { vod: 0, invalid: 0, overLimit: 0, groups: 0 };
  const seenKeys = new Map<string, number>();
  let listed = 0;
  let header = false;
  let defaultShift: number | undefined;
  let p: Pending = {};

  const finishEntry = (rawUrl: string) => {
    const cur = p;
    p = {};
    if (cur.broken || !cur.info) { skipped.invalid++; return; }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      skipped.invalid++;
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'srt:') { skipped.invalid++; return; }
    const tvgName = nonEmpty(cur.info.get('tvg-name'));
    const name = cur.title || tvgName;
    if (!name) { skipped.invalid++; return; }
    if (VOD.test(url.pathname)) { skipped.vod++; return; }
    const pos = listed++;
    const group = nonEmpty(cur.info.get('group-title')) ?? nonEmpty(cur.group);
    if (group !== undefined) groups.set(group, (groups.get(group) ?? 0) + 1);
    const tvgId = nonEmpty(cur.info.get('tvg-id'));
    const base = entryKey({ tvgId, name, url: url.href });
    const n = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, n);
    if (group !== undefined && o.skipGroups?.has(group)) { skipped.groups++; return; }
    if (entries.length >= o.max) { skipped.overLimit++; return; }
    const chnoRaw = cur.info.get('tvg-chno');
    const chno = chnoRaw && /^\d{1,6}$/.test(chnoRaw) ? Number(chnoRaw) : undefined;
    const shiftMin = parseShift(cur.info.get('tvg-shift')) ?? defaultShift;
    const kind = url.protocol === 'srt:' ? 'srt' : url.pathname.toLowerCase().endsWith('.m3u8') ? 'hls' : 'ts';
    const logo = nonEmpty(cur.info.get('tvg-logo'));
    entries.push({
      key: n === 1 ? base : `${base}:${n}`, name,
      ...(tvgId !== undefined ? { tvgId } : {}), ...(tvgName !== undefined ? { tvgName } : {}), ...(chno !== undefined ? { chno } : {}),
      ...(group !== undefined ? { group } : {}), ...(logo !== undefined ? { logo } : {}), ...(shiftMin !== undefined ? { shiftMin } : {}),
      pos, url: rawUrl, kind, ...(cur.userAgent !== undefined ? { userAgent: cur.userAgent } : {}),
    });
  };

  let first = true;
  for await (let line of lines) {
    if (first) { line = line.replace(/^﻿/, ''); first = false; }
    const tooLong = Buffer.byteLength(line, 'utf8') > MAX_LINE;
    line = line.trim();
    if (!header) {
      if (line === '') continue;
      if (!line.startsWith('#EXTM3U')) throw new M3uError('not_m3u');
      header = true;
      if (!tooLong) defaultShift = parseShift(attrs(line.slice(7)).get('tvg-shift'));
      continue;
    }
    if (line === '') continue;
    if (!line.startsWith('#')) { if (tooLong) p.broken = true; finishEntry(line); continue; }
    if (tooLong) { p.broken = true; continue; }
    if (line.startsWith('#EXTINF:')) {
      // a new #EXTINF without a URL before it: the earlier one was broken
      if (p.info || p.broken) skipped.invalid++;
      const { attrPart, title } = splitInfo(line.slice(8));
      p = { info: attrs(attrPart), title };
    } else if (line.startsWith('#EXTGRP:')) {
      p.group = line.slice(8).trim();
    } else if (/^#EXTVLCOPT:http-user-agent=/i.test(line)) {
      p.userAgent = nonEmpty(line.slice(line.indexOf('=') + 1).trim());
    }
  }
  if (!header) throw new M3uError('not_m3u');
  return { entries, groups: [...groups].map(([name, channels]) => ({ name, channels })), listed, skipped };
}
