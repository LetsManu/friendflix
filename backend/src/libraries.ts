// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { HttpError } from './users.js';

/**
 * The media server's libraries for the role and rights editors: the choices (cached 5 min per ctx), the names a write may use
 * (knownLibraries) and the names of a template the server no longer has (missingLibraries).
 */
export interface Library { id: string; name: string }
const LIB_TTL_MS = 5 * 60_000;
const libCache = new WeakMap<object, { at: number; list: Library[] }>();

/** the media server's libraries, cached 5 min per ctx; undefined while the server cannot list them (a failure is not cached) */
export async function fetchLibraries(ctx: Pick<Ctx, 'jf'>, fresh = false): Promise<Library[] | undefined> {
  const c = libCache.get(ctx);
  if (!fresh && c && Date.now() - c.at <= LIB_TTL_MS) return c.list;
  try {
    const list = (await ctx.jf.admin.libraries()).map((l) => ({ id: String(l.id), name: String(l.name) }));
    libCache.set(ctx, { at: Date.now(), list });
    return list;
  } catch {
    return undefined;
  }
}
/** the media server's libraries (cached 5 min); [] while the server cannot list them */
export const serverLibraries = async (ctx: Pick<Ctx, 'jf'>): Promise<Library[]> => (await fetchLibraries(ctx)) ?? [];
export const forgetLibraries = (ctx: object): void => void libCache.delete(ctx);

const lc = (s: string) => s.toLowerCase();
/** library names of a template the server no longer has (matched case-insensitively, like the policy); [] when that cannot be told */
export function missingLibraries(libraries: 'all' | string[], known: Library[] | undefined): string[] {
  if (libraries === 'all' || !known?.length) return [];
  const have = new Set(known.map((l) => lc(l.name)));
  return libraries.filter((n) => !have.has(lc(n)));
}

/**
 * Names a write wants → the server's spelling of each (deduplicated). A name the cached list lacks gets one fresh look (a library added
 * a minute ago); still unknown → 400 unknown_library. 502 libraries_unavailable while the server cannot list them.
 */
export async function knownLibraries(ctx: Pick<Ctx, 'jf'>, names: string[]): Promise<string[]> {
  const find = (list: Library[]) => names.map((n) => list.find((l) => lc(l.name) === lc(n))?.name);
  let list = await fetchLibraries(ctx);
  let found = list && find(list);
  if (!found || found.includes(undefined)) {
    list = await fetchLibraries(ctx, true);
    if (!list) throw new HttpError(502, 'libraries_unavailable');
    found = find(list);
  }
  if (found.includes(undefined)) throw new HttpError(400, 'unknown_library');
  return [...new Set(found as string[])];
}
