// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { decrypt, encrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import { invalidateLivetvRights } from './rights.js';
import type { SourceRow } from './sources.js';
import type { M3uEntry } from './wire.js';

/**
 * The import merge of a provider list (spec §10 *Import merge rules*, §19; rulings 18, 19, 39-41). livetv has already dropped the
 * entries of skipped groups (`skipGroups`), so they are absent here (and dropped again if not). In one transaction:
 *   - entries are keyed by `source_key` (livetv's key: tvg-id, else name + host + stream id, ruling 18);
 *   - new -> insert; its provider group maps through `livetv_group_map`; a provider group seen for the first time maps to the group
 *     with the same name (case-insensitive) if there is one, else a new group is created unreleased, granted to no role, not
 *     kid-friendly (spec §8, ruling 39);
 *   - existing -> `import_*`, `tvg_*`, `stream_url_enc`, `stream_kind` rewritten and `missing_since` cleared (only rows that changed
 *     are written); admin overrides (`*_override`, `hidden`) are never touched;
 *   - absent -> `missing_since = now` (kept when it is already set, so the 30-day clock keeps running).
 * The shrink guard: a list with 0 live entries, or fewer than 20 % of the previous list's, changes nothing and answers `empty`. Both
 * counts are taken before group skipping (`listed`, ruling 41), so unticking groups never trips it and never renumbers.
 */

export interface ImportResult { added: number; updated: number; missing: number; returned: number; total: number; listed: number; newGroups: number }

/** the channel number an entry gets (rulings 19, 41): `chno` = `tvg-chno`, else base + position; `order` = base + position */
export function importNumber(e: Pick<M3uEntry, 'chno' | 'pos'>, src: { numbering: 'chno' | 'order'; number_base: number }): number {
  const derived = src.number_base + e.pos;
  return src.numbering === 'chno' ? e.chno ?? derived : derived;
}

/** a group name as stored (1-40 characters, spec §6.1); '' = no group */
export function groupName(provider: string): string {
  return [...provider.trim()].slice(0, 40).join('').trim();
}

/** the previous list's `listed` (last_counts), 0 when unknown */
function previousListed(s: SourceRow): number {
  const v = s.last_counts?.listed;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** true when a list of `listed` live entries is treated as a provider error (spec §10) */
export function shrunk(listed: number, previous: number): boolean {
  return listed <= 0 || (previous > 0 && listed < previous * 0.2);
}

interface Existing {
  id: string;
  source_key: string;
  stream_url_enc: string | null;
  stream_kind: string;
  import_name: string;
  import_number: number | null;
  import_group: string | null;
  tvg_id: string | null;
  tvg_name: string | null;
  import_epg_shift_min: number | null;
  missing_since: Date | null;
}

const CHUNK = 2000;

async function inTx<T>(ctx: Pick<Ctx, 'db'>, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    invalidateLivetvRights();
  }
}

/**
 * The provider group -> group id of every group among `groups`, creating the missing mappings (and groups) as spec §10 says. Returns
 * the map and how many groups were created.
 */
async function mapGroups(c: pg.PoolClient, sourceId: string, groups: readonly string[]): Promise<{ map: Map<string, string>; created: number }> {
  const map = new Map<string, string>();
  for (const r of (await c.query<{ provider_group: string; group_id: string }>(
    'select provider_group, group_id from livetv_group_map where source_id = $1', [sourceId])).rows) map.set(r.provider_group, r.group_id);
  let created = 0;
  for (const g of groups) {
    if (map.has(g)) continue;
    const name = groupName(g);
    if (!name) continue;
    // a new group: unreleased, no livetv_group_roles row, not kid-friendly; an existing name (any case) is reused as it is
    const ins = await c.query<{ id: string }>(
      `insert into livetv_groups(id, name, released, kid_friendly, position)
       values ($1, $2, false, false, (select coalesce(max(position) + 1, 0) from livetv_groups))
       on conflict (lower(name)) do nothing returning id`, [randomUUID(), name]);
    let id = ins.rows[0]?.id;
    if (id) created++;
    else id = (await c.query<{ id: string }>('select id from livetv_groups where lower(name) = lower($1)', [name])).rows[0]!.id;
    await c.query(
      `insert into livetv_group_map(source_id, provider_group, group_id) values ($1, $2, $3)
       on conflict (source_id, provider_group) do nothing`, [sourceId, g, id]);
    map.set(g, id);
  }
  return { map, created };
}

/**
 * Merges a fetched list into the source's channels (spec §10, see the module comment). `fetched.entries` are the live entries livetv
 * kept (skipped groups and entries over the limit dropped), `fetched.listed` every live entry of the list. `{ error: 'empty' }` = the
 * shrink guard tripped and nothing changed.
 */
export async function mergeImport(ctx: Ctx, source: SourceRow, fetched: { entries: M3uEntry[]; listed: number }, now: Date = new Date()): Promise<ImportResult | { error: 'empty' }> {
  if (shrunk(fetched.listed, previousListed(source))) return { error: 'empty' };

  // livetv has dropped the skipped groups already; dropped here too, so an entry of an unticked group can never be imported. One entry
  // per key (livetv already makes keys unique with `:2`, `:3`; this only guards the unique index).
  const skip = new Set(source.skip_groups);
  const entries: M3uEntry[] = [];
  const seen = new Set<string>();
  for (const e of fetched.entries) {
    if ((e.group && skip.has(e.group)) || seen.has(e.key)) continue;
    seen.add(e.key);
    entries.push(e);
  }

  return inTx(ctx, async (c) => {
    // one import of a source at a time (the refresh lock is in KV; this also covers a lock that ran out)
    await c.query('select id from livetv_sources where id = $1 for update', [source.id]);
    const groups = [...new Set(entries.map((e) => e.group).filter((g): g is string => !!g))];
    const { created } = await mapGroups(c, source.id, groups);

    const existing = new Map<string, Existing>();
    for (const r of (await c.query<Existing>(
      `select id, source_key, stream_url_enc, stream_kind, import_name, import_number, import_group, tvg_id, tvg_name, import_epg_shift_min,
              missing_since
         from livetv_channels where source_id = $1`, [source.id])).rows) existing.set(r.source_key, r);

    type Row = [id: string, key: string, url: string, kind: string, name: string, num: number, group: string | null, tvgId: string | null, tvgName: string | null, shift: number | null];
    const inserts: Row[] = [];
    const updates: Row[] = [];
    let returned = 0;
    for (const e of entries) {
      const num = importNumber(e, source);
      const group = e.group || null;
      const tvgId = e.tvgId ?? null, tvgName = e.tvgName ?? null, shift = e.shiftMin ?? null;
      const old = existing.get(e.key);
      if (!old) {
        inserts.push([randomUUID(), e.key, encrypt(ctx.encKey, e.url), e.kind, e.name, num, group, tvgId, tvgName, shift]);
        continue;
      }
      existing.delete(e.key);
      if (old.missing_since !== null) returned++;
      let url: string | null = null;
      try { url = old.stream_url_enc ? decrypt(ctx.encKey, old.stream_url_enc) : null; } catch { /* unreadable: rewrite it */ }
      const same = old.missing_since === null && url === e.url && old.stream_kind === e.kind && old.import_name === e.name
        && old.import_number === num && old.import_group === group && old.tvg_id === tvgId && old.tvg_name === tvgName
        && old.import_epg_shift_min === shift;
      if (!same) updates.push([old.id, e.key, url === e.url && old.stream_url_enc ? old.stream_url_enc : encrypt(ctx.encKey, e.url), e.kind, e.name, num, group, tvgId, tvgName, shift]);
    }
    // what is left was not in this list: missing from now on (the ones already missing keep their date)
    const gone = [...existing.values()].filter((r) => r.missing_since === null).map((r) => r.id);

    const cols = (rows: Row[]) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => rows.map((r) => r[i]));
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await c.query(
        `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, ingest, import_name, import_number, import_group,
           tvg_id, tvg_name, import_epg_shift_min)
         select u.id, $1, u.key, u.url, u.kind, 'pull', u.name, u.num, u.grp, u.tvg_id, u.tvg_name, u.shift
           from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[], $9::text[], $10::text[], $11::int[])
             as u(id, key, url, kind, name, num, grp, tvg_id, tvg_name, shift)`,
        [source.id, ...cols(inserts.slice(i, i + CHUNK))]);
    }
    for (let i = 0; i < updates.length; i += CHUNK) {
      await c.query(
        `update livetv_channels c set stream_url_enc = u.url, stream_kind = u.kind, import_name = u.name, import_number = u.num,
           import_group = u.grp, tvg_id = u.tvg_id, tvg_name = u.tvg_name, import_epg_shift_min = u.shift, missing_since = null
           from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[], $9::text[], $10::text[], $11::int[])
             as u(id, key, url, kind, name, num, grp, tvg_id, tvg_name, shift)
          where c.id = u.id and c.source_id = $1`,
        [source.id, ...cols(updates.slice(i, i + CHUNK))]);
    }
    for (let i = 0; i < gone.length; i += CHUNK) {
      await c.query('update livetv_channels set missing_since = $2 where source_id = $1 and id = any($3::uuid[]) and missing_since is null',
        [source.id, now, gone.slice(i, i + CHUNK)]);
    }
    return {
      added: inserts.length,
      updated: updates.length - returned,
      missing: gone.length,
      returned,
      total: entries.length,
      listed: fetched.listed,
      newGroups: created,
    };
  });
}
