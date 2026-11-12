// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { vi } from 'vitest';
import type { Store } from '../src/cache.js';
import { FetchError, type FetchOptions, type GuardedResponse } from '../src/fetch.js';

/** an in-memory Store: fake-timer tests never wait for real disk I/O */
export function memoryStore(): { files: Map<string, Buffer>; store: Store } {
  const files = new Map<string, Buffer>();
  const store: Store = {
    mkdir: async () => {},
    write: async (path, data) => {
      let b: Buffer;
      if (typeof data === 'string' || Buffer.isBuffer(data)) b = Buffer.from(data);
      else {
        const parts: Buffer[] = [];
        for await (const c of data) parts.push(Buffer.from(c));
        b = Buffer.concat(parts);
      }
      files.set(path, b);
      return b.length;
    },
    remove: async (path) => { files.delete(path); },
    removeDir: async (dir) => { for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
  };
  return { files, store };
}

/** what a fake provider answers for a URL: a body, a FetchError, or a function of the call (for playlists that change) */
export type Served = string | Buffer | FetchError | (() => string | Buffer | FetchError);

/** a fake `guardedFetch`: answers from `routes`, records each URL and the time it was asked */
export function fakeFetch(routes: Map<string, Served>) {
  const calls: Array<{ url: string; at: number; maxBytes: number }> = [];
  const fetch = async (url: string, o: FetchOptions): Promise<GuardedResponse> => {
    calls.push({ url, at: Date.now(), maxBytes: o.maxBytes });
    const r = routes.get(url);
    if (r === undefined) throw new FetchError('not_found');
    const v = typeof r === 'function' ? r() : r;
    if (v instanceof FetchError) throw v;
    const buf = Buffer.from(v);
    return { status: 200, url, headers: {}, body: (async function* () { yield buf; })() };
  };
  return { calls, fetch };
}

/** let every pending promise chain run (fake timers: no real time passes) */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}
