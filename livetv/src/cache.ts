// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { KEEP_NEWEST, type SegmentWindow } from './window.js';

/**
 * The DVR cache (`/cache/<streamKey>/`, the `livetv-cache` volume; spec §3.3). `evict` is the cap: while the cache is over
 * `LIVETV_CACHE_MAX_GB`, the window with the most seconds gives its oldest segment, so long windows shrink towards each other and
 * the live edge (the newest 3 of every window) never goes. `Store` is the disk seam of the streams: tests pass one in memory.
 */
export function evict(windows: Array<{ id: string; w: SegmentWindow }>, maxBytes: number): Array<{ id: string; file: string }> {
  const out: Array<{ id: string; file: string }> = [];
  let total = windows.reduce((n, x) => n + x.w.bytes, 0);
  while (total > maxBytes) {
    let longest: { id: string; w: SegmentWindow } | null = null;
    for (const x of windows) if (x.w.length > KEEP_NEWEST && (!longest || x.w.seconds > longest.w.seconds)) longest = x;
    if (!longest) break;
    const before = longest.w.bytes;
    const file = longest.w.dropOldest()!;
    total -= before - longest.w.bytes;
    out.push({ id: longest.id, file });
  }
  return out;
}

export interface Store {
  mkdir(dir: string): Promise<void>;
  /** writes the whole file under a temporary name and renames it into place (a reader never sees half a file); answers its bytes */
  write(path: string, data: string | Buffer | AsyncIterable<Uint8Array>): Promise<number>;
  /** a missing file is fine */
  remove(path: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
}

export const fsStore: Store = {
  mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
  async write(path, data) {
    const tmp = `${path}.part`;
    try {
      let n = 0;
      if (typeof data === 'string' || Buffer.isBuffer(data)) {
        n = Buffer.byteLength(data);
        await writeFile(tmp, data);
      } else {
        const counted = (async function* () {
          for await (const c of data) { n += c.length; yield c; }
        })();
        await pipeline(Readable.from(counted), createWriteStream(tmp));
      }
      await rename(tmp, path);
      return n;
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  },
  remove: async (path) => { await rm(path, { force: true }); },
  removeDir: async (dir) => { await rm(dir, { recursive: true, force: true }); },
};

const STREAM_DIR = /^[0-9a-f]{32}$/;

/** at start: the stream directories a previous process left behind (its streams are gone); nothing else in the cache */
export async function clearStale(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  for (const n of names) if (STREAM_DIR.test(n)) await rm(join(root, n), { recursive: true, force: true });
}
