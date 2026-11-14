// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { FetchError } from '../fetch.js';
import type { Answer, Route } from '../server.js';
import { XmltvError, parseXmltv } from '../xmltv.js';
import { Invalid, StreamError, XMLTV_MAX_BYTES, XMLTV_TIMEOUT_MS, invalid, obj, streamXmltv, xmltvFilter, xmltvOptions } from './fetch.js';

/**
 * `POST /v1/parse/xmltv` (extra guides, Stage 2): an XMLTV file the backend stored (an admin's upload), parsed exactly like a fetched
 * one. The backend never parses XML; it posts the file here.
 *
 * Body (`application/octet-stream`, signed by its SHA-256, protocol.ts HEADER_BODY_SHA): one JSON line `{ from, to, channels? }` (the
 * filter of `/v1/fetch/xmltv`, at most 64 KB) and `\n`, then the file's bytes as uploaded (plain XML or gzip, recognised by its magic
 * bytes), at most XMLTV_MAX_BYTES. A declared length over that is 413 before anything is read (server.ts); a bad filter line is 400
 * `invalid` with its field (`head` for the line itself). After that the answer is the NDJSON stream of `/v1/fetch/xmltv` with the same
 * limits (window, channel filter, 300 000 programmes, 1 GB decompressed, the gzip ratio guard). Its `end` line is sent only after the
 * whole body was read and its SHA-256 matched the signed one (else the last line is `bad_signature`): items already sent from a body
 * that turns out to be another one are never complete, and the backend keeps nothing of an answer without `end`. Bytes beyond the cap
 * (a body without a declared length) end it with `too_big`; a request not done within XMLTV_TIMEOUT_MS is cut off. Nothing here logs.
 */
/** the filter line's cap: the JSON body cap of the other signed routes (server.ts MAX_BODY; not imported, server.ts imports this file) */
export const PARSE_MAX_HEAD = 64 * 1024;

/** the signed request body, read once: hashed and counted while it is read; leaving a reader early never closes the request */
class SignedBody {
  private readonly it: AsyncIterator<Buffer>;
  private readonly hash = createHash('sha256');
  private bytes = 0;
  private ended = false;
  private left: Buffer | null = null;

  constructor(private readonly req: IncomingMessage, private readonly sha256: string, private readonly max: number) {
    this.it = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async pull(): Promise<Buffer | null> {
    if (this.ended) return null;
    const r = await this.it.next();
    if (r.done) { this.ended = true; return null; }
    const c = r.value;
    this.bytes += c.length;
    if (this.bytes > this.max) throw new XmltvError('too_big');
    this.hash.update(c);
    return c;
  }

  /** the first line (without its `\n`); null when the body has none within `limit` bytes */
  async head(limit: number): Promise<string | null> {
    const parts: Buffer[] = [];
    let n = 0;
    for (;;) {
      const c = await this.pull();
      if (!c) return null;
      const nl = c.indexOf(0x0a);
      if (nl === -1) {
        n += c.length;
        if (n > limit) return null;
        parts.push(c);
        continue;
      }
      if (n + nl > limit) return null;
      parts.push(c.subarray(0, nl));
      this.left = c.subarray(nl + 1);
      return Buffer.concat(parts).toString('utf8');
    }
  }

  /** the bytes after the first line; a reader that stops early leaves the rest to `complete` */
  rest(): AsyncIterable<Uint8Array> {
    const next = async (): Promise<IteratorResult<Uint8Array>> => {
      const l = this.left;
      this.left = null;
      if (l && l.length > 0) return { done: false, value: l };
      const c = await this.pull();
      return c ? { done: false, value: c } : { done: true, value: undefined };
    };
    return { [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true, value: undefined }) }) };
  }

  /** reads what is left and compares the whole body with the signed hash */
  async complete(): Promise<void> {
    this.left = null;
    while (await this.pull()) { /* counted and hashed */ }
    if (this.hash.digest('hex') !== this.sha256) throw new StreamError('bad_signature');
  }
}

/** `maxBytes`: the file cap (tests only; production uses XMLTV_MAX_BYTES) */
export function parseRoutes(o: { maxBytes?: number } = {}): Route[] {
  const maxBody = PARSE_MAX_HEAD + 1 + (o.maxBytes ?? XMLTV_MAX_BYTES);
  return [{
    method: 'POST', path: '/v1/parse/xmltv', rawBody: true, maxBody, bodyTimeoutMs: XMLTV_TIMEOUT_MS + 30_000,
    handle: async (c) => {
      const { req, res } = c;
      const body = new SignedBody(req, c.bodySha256!, maxBody);
      // a refusal before the stream: the answer goes out first, then the unread rest of the body is dropped with the connection
      const refuse = (a: Answer): Answer => { res.once('finish', () => req.destroy()); return a; };
      let filter: ReturnType<typeof xmltvFilter>;
      try {
        const line = await body.head(PARSE_MAX_HEAD);
        if (line === null) throw new Invalid('head');
        let j: unknown;
        try { j = JSON.parse(line); } catch { throw new Invalid('head'); }
        filter = xmltvFilter(obj(j, 'head'));
      } catch (e) {
        if (e instanceof Invalid) return refuse(invalid(e.field));
        if (e instanceof XmltvError) return refuse({ status: 413, json: { error: 'too_large' } });
        throw e; // the request broke off: nobody to answer
      }
      // the whole parse, reading included, has the fetch route's time; then the request is cut off
      const timer = setTimeout(() => req.destroy(new FetchError('timeout')), XMLTV_TIMEOUT_MS);
      try {
        await streamXmltv(res, async (signal) => {
          signal.addEventListener('abort', () => req.destroy(), { once: true });
          return parseXmltv(body.rest(), xmltvOptions(filter));
        }, { complete: () => body.complete() });
      } finally {
        clearTimeout(timer);
        // a stream that failed before the body's end: the unread rest goes with the connection once the answer is out
        if (!req.complete) { if (res.writableFinished) req.destroy(); else res.once('finish', () => req.destroy()); }
      }
    },
  }];
}
