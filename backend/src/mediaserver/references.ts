// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { MediaSetupError } from '../media/types.js';
import { libraryItemIds, managedKey, MANAGED_URL } from './serverApi.js';
import { readManaged } from './store.js';

export interface LibraryReferences { lists: number; resume: number; recordings: number }
const NONE: LibraryReferences = { lists: 0, resume: 0, recordings: 0 };

/**
 * How many FriendFlix references point at items of the managed library `slug` (spec "Folder changes after the first run"), counted from
 * the backend's own tables: list entries and watchlist rows, hidden resume points, recordings exported into it. A library that does not
 * exist in the server (unknown slug, not created yet) has none. Throws MediaSetupError when the server cannot list its items (the caller
 * refuses what needs the count: fail closed).
 */
export async function libraryReferences(ctx: Ctx, slug: string): Promise<LibraryReferences> {
  const lib = (await readManaged(ctx.db)).libraries.find((l) => l.slug === slug);
  if (!lib?.created) return { ...NONE };
  const key = managedKey(ctx.cfg);
  if (!key) throw new MediaSetupError('unreachable');
  const ids = await libraryItemIds(ctx.fetchImpl, MANAGED_URL, key, lib.name);
  if (!ids.length) return { ...NONE };
  const r = await ctx.db.query<{ lists: number; resume: number; recordings: number }>(
    `select (select count(*) from list_items where item_id = any($1))::int + (select count(*) from watchlist where item_id = any($1))::int as lists,
            (select count(*) from resume_hidden where item_id = any($1))::int as resume,
            (select count(*) from livetv_recordings where jellyfin_item_id = any($1))::int as recordings`, [ids]);
  const row = r.rows[0];
  return row ? { lists: row.lists, resume: row.resume, recordings: row.recordings } : { ...NONE };
}

export const referenced = (r: LibraryReferences): boolean => r.lists + r.resume + r.recordings > 0;
