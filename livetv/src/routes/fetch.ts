// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { FetchError, guardedFetch, type FetchErrorCode, type GuardDeps } from '../fetch.js';
import { LogoError, fetchLogo } from '../logo.js';
import { M3uError, MAX_ENTRIES, USER_AGENT_RE, parseM3u, splitLines, type M3uResult } from '../m3u.js';
import { probe, type StreamInput } from '../probe.js';
import type { Run } from '../run.js';
import type { Answer, Route } from '../server.js';
import { XmltvError, parseXmltv, type XmlItem, type XmltvErrorCode } from '../xmltv.js';

/**
 * The fetch routes of spec §3.2: `POST /v1/fetch/m3u`, `/v1/fetch/xmltv`, `/v1/fetch/logo` and `/v1/probe` (all signed; the
 * signature is checked by server.ts before a route runs). Bodies are checked by hand (`400 { error: 'invalid', field }`, never
 * echoing input); provider and fetch failures answer `422 { error: code }` with a fixed code; XMLTV streams NDJSON and reports any
 * failure as its last line `{ "t": "error", "code" }` (always after a 200 head, also when nothing was sent yet); only a complete
 * stream ends with `{ "t": "end", programmes, channels }`, so a reader treats a stream without it as failed. Nothing here
 * logs; nothing answers a URL, a host or a parser message.
 */
export const M3U_MAX_BYTES = 50 * 1024 * 1024;
export const M3U_TIMEOUT_MS = 60_000;
export const XMLTV_MAX_BYTES = 300 * 1024 * 1024;
export const XMLTV_TIMEOUT_MS = 10 * 60_000;
export const XMLTV_MAX_PROGRAMMES = 300_000;
const MAX_URL = 8192;
const MAX_SKIP_GROUPS = 2000;
const MAX_CHANNELS = 20_000;
const MAX_NAME = 500;

export type M3uAnswer = M3uResult;
/** one line of the `/v1/fetch/xmltv` NDJSON answer; the last line is `end` (complete) or `error` (failed), never both */
export type XmltvLine =
  | XmlItem
  | { t: 'end'; programmes: number; channels: number }
  | { t: 'error'; code: FetchErrorCode | XmltvErrorCode };

class Invalid extends Error {
  constructor(readonly field: string) { super('invalid'); }
}
const invalid = (field: string): Answer => ({ status: 400, json: { error: 'invalid', field } });
const failed = (code: string): Answer => ({ status: 422, json: { error: code } });

type Obj = Record<string, unknown>;
function obj(v: unknown, field = 'body'): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Invalid(field);
  return v as Obj;
}
/** a URL that parses (scheme and address are judged by the guard, which answers its own fixed codes) */
function url(b: Obj, field = 'url'): string {
  const v = b[field];
  if (typeof v !== 'string' || v.length > MAX_URL || !URL.canParse(v)) throw new Invalid(field);
  return v;
}
function bool(b: Obj, field: string): boolean {
  if (typeof b[field] !== 'boolean') throw new Invalid(field);
  return b[field] as boolean;
}
/** printable ASCII only: it becomes an HTTP header */
function userAgent(b: Obj): string | undefined {
  const v = b.userAgent;
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !USER_AGENT_RE.test(v)) throw new Invalid('userAgent');
  return v;
}
function names(b: Obj, field: string, max: number): string[] | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_NAME)) throw new Invalid(field);
  return v as string[];
}
function time(b: Obj, field: string): number {
  const v = b[field];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Invalid(field);
  return v;
}

/** a pulled or pushed input (`/v1/probe`, `/v1/streams`); throws `Invalid('input')` */
export function streamInput(v: unknown): StreamInput {
  const i = obj(v, 'input');
  if ('push' in i) {
    if (typeof i.push !== 'string' || !/^[\w-]{1,100}$/.test(i.push)) throw new Invalid('input');
    return { push: i.push };
  }
  if (typeof i.url !== 'string' || i.url.length > MAX_URL || (i.kind !== 'hls' && i.kind !== 'ts' && i.kind !== 'srt') || typeof i.allowLan !== 'boolean') throw new Invalid('input');
  if (i.userAgent !== undefined && (typeof i.userAgent !== 'string' || !USER_AGENT_RE.test(i.userAgent))) throw new Invalid('input');
  return { url: i.url, kind: i.kind, allowLan: i.allowLan, ...(i.userAgent !== undefined ? { userAgent: i.userAgent as string } : {}) };
}

/** a handler that answers 400 for a schema failure and 422 for the given error classes */
function guarded<T>(fn: (json: unknown) => Promise<T>): (json: unknown) => Promise<T | Answer> {
  return async (json) => {
    try {
      return await fn(json);
    } catch (e) {
      if (e instanceof Invalid) return invalid(e.field);
      if (e instanceof FetchError || e instanceof M3uError || e instanceof LogoError) return failed(e.code);
      throw e;
    }
  };
}

export function fetchRoutes(deps: { guard: GuardDeps; run: Run }): Route[] {
  const m3u = guarded(async (json) => {
    const b = obj(json);
    const target = url(b);
    const allowLan = bool(b, 'allowLan');
    const ua = userAgent(b);
    const skip = names(b, 'skipGroups', MAX_SKIP_GROUPS);
    const res = await guardedFetch(target, { allowLan, userAgent: ua, timeoutMs: M3U_TIMEOUT_MS, maxBytes: M3U_MAX_BYTES }, deps.guard);
    const answer: M3uAnswer = await parseM3u(splitLines(res.body), { max: MAX_ENTRIES, skipGroups: new Set(skip) });
    return { status: 200, json: answer };
  });

  const logo = guarded(async (json) => {
    const b = obj(json);
    const target = url(b);
    const allowLan = bool(b, 'allowLan');
    return fetchLogo(target, allowLan, deps.guard);
  });

  return [
    { method: 'POST', path: '/v1/fetch/m3u', handle: (c) => m3u(c.json) },
    {
      method: 'POST', path: '/v1/fetch/logo',
      handle: async (c) => {
        const a = await logo(c.json);
        if (!('bytes' in a)) return a;
        c.res.writeHead(200, { 'content-type': a.type, 'content-length': a.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        c.res.end(a.bytes);
      },
    },
    {
      method: 'POST', path: '/v1/fetch/xmltv',
      handle: async (c) => {
        let target: string, allowLan: boolean, ua: string | undefined, channels: string[] | undefined, from: number, to: number;
        try {
          const b = obj(c.json);
          target = url(b);
          allowLan = bool(b, 'allowLan');
          ua = userAgent(b);
          channels = names(b, 'channels', MAX_CHANNELS);
          from = time(b, 'from');
          to = time(b, 'to');
          if (to <= from) throw new Invalid('to');
        } catch (e) {
          if (e instanceof Invalid) return invalid(e.field);
          throw e;
        }
        const { res } = c;
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        // the head goes out now: the caller learns at once that the request was taken, before the provider answers
        res.flushHeaders();
        let gone = false;
        // the caller went away: the provider download stops at once, also while the parser is between lines
        const abort = new AbortController();
        res.on('close', () => { gone = true; abort.abort(); });
        const write = async (line: XmltvLine) => {
          if (gone) return;
          if (res.write(`${JSON.stringify(line)}\n`)) return;
          await new Promise<void>((r) => {
            const go = () => { res.off('drain', go); res.off('close', go); r(); };
            res.on('drain', go);
            res.on('close', go);
          });
        };
        let programmes = 0;
        let chans = 0;
        try {
          const f = await guardedFetch(target, { allowLan, userAgent: ua, timeoutMs: XMLTV_TIMEOUT_MS, maxBytes: XMLTV_MAX_BYTES, signal: abort.signal }, deps.guard);
          const items = parseXmltv(f.body, { from, to, maxProgrammes: XMLTV_MAX_PROGRAMMES, ...(channels ? { channels: new Set(channels) } : {}) });
          for await (const item of items) {
            // leaving the loop closes the parser and the provider connection
            if (gone) break;
            if (item.t === 'prog') programmes++;
            else chans++;
            await write(item);
          }
          if (!gone) await write({ t: 'end', programmes, channels: chans });
        } catch (e) {
          await write({ t: 'error', code: e instanceof FetchError || e instanceof XmltvError ? e.code : 'invalid' });
        }
        if (!gone) res.end();
      },
    },
    {
      method: 'POST', path: '/v1/probe',
      handle: async (c) => {
        let input: StreamInput;
        try {
          input = streamInput(obj(c.json, 'input').input);
        } catch (e) {
          if (e instanceof Invalid) return invalid('input');
          throw e;
        }
        return { status: 200, json: await probe(input, deps) };
      },
    },
  ];
}
