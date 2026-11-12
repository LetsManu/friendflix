// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Answer, Route } from '../server.js';
import type { Streams } from '../streams.js';

/**
 * `GET /s/<streamKey>/<file>` (spec §3.2): the stream files for the gateway, unsigned, reachable only on the internal network and
 * addressed by the 128-bit random stream key. Only `index.m3u8`, `init-<n>.mp4` and `<n>.ts` / `<n>.m4s` (no leading zeros)
 * exist; anything else, an
 * unknown key or a file that already left the window is 404. Every hit of a known key `touch`es its stream (the 180-s safety
 * net). Nothing here logs: a hit is not worth a line and its path holds the key.
 */
export const STREAM_KEY_RE = /^[0-9a-f]{32}$/;
export const FILE_RE = /^(index\.m3u8|init-[0-9]{1,10}\.mp4|(0|[1-9][0-9]{0,9})\.(ts|m4s))$/;

const notFound: Answer = { status: 404, json: { error: 'not_found' } };

export function fileRoutes(streams: Streams): Route[] {
  return [{
    method: 'GET', path: /^\/s\/([^/]*)\/([^/]*)$/,
    handle: async (c) => {
      const [key, name] = c.params as [string, string];
      if (!STREAM_KEY_RE.test(key)) return notFound;
      streams.touch(key);
      if (!FILE_RE.test(name)) return notFound;
      const f = streams.file(key, name);
      if (!f) return notFound;
      // opened first: a segment the window dropped a moment ago is a clean 404, not a broken 200
      const fh = await open(f.path, 'r').catch(() => null);
      if (!fh) return notFound;
      let size: number;
      try {
        size = (await fh.stat()).size;
      } catch {
        await fh.close().catch(() => {});
        return notFound;
      }
      c.res.writeHead(200, {
        'content-type': f.type, 'content-length': size, 'x-content-type-options': 'nosniff',
        // the playlist changes with every segment; a segment or init version never changes under its name (ruling R16)
        'cache-control': name === 'index.m3u8' ? 'no-cache' : 'max-age=3600',
      });
      // a gateway that hangs up mid-segment is normal (players abort fetches); it is no failure worth a log line. The stream
      // closes the file handle when it ends or fails.
      await pipeline(fh.createReadStream(), c.res).catch(() => {});
    },
  }];
}
