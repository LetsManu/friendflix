// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../ctx.js';

/**
 * The Live TV event ring (spec §10 `events.ts`, pre-flight F20): what *Live-Status* lists under *Ereignisse* (Task 26). Events carry
 * fixed codes and ids only, never text or URLs (F13): the web renders the words from `code` and `reason`. One KV value `ltv:events`
 * holds the newest 200 events, newest first, kept 7 days.
 *
 * LIVE_EVENT_CODES is the complete Phase 1 list, declared before most emitters exist so Task 26's texts cover each code; a new code is
 * added here first. Emitters: `source_refresh_failed` refresh.ts (Task 16); `ingest_sync_pending` Task 20; `stopped_by_admin`
 * Task 26; `start_refused_full`, `start_failed`, `input_lost`, `input_back`, `push_rejected` Task 31; `released_on_switch` Task 32.
 */
export const LIVE_EVENT_CODES = [
  'source_refresh_failed',
  'ingest_sync_pending',
  'stopped_by_admin',
  'start_refused_full',
  'start_failed',
  'input_lost',
  'input_back',
  'push_rejected',
  'released_on_switch',
] as const;
export type LiveEventCode = (typeof LIVE_EVENT_CODES)[number];

export interface LiveEvent {
  /** epoch ms */
  at: number;
  level: 'info' | 'warn' | 'error';
  code: LiveEventCode;
  channelId?: string;
  sourceId?: string;
  n?: number;
  /** a fixed error code, ^[a-z_]{1,40}$ */
  reason?: string;
}

const KEY = 'ltv:events';
const LOCK = 'ltv:events:lock';
const MAX = 200;
const TTL_S = 7 * 24 * 3600;
const LOCK_TTL_S = 5;
const LOCK_TRIES = 20;
const LOCK_WAIT_MS = 25;

const REASON_RE = /^[a-z_]{1,40}$/;
const ID_RE = /^[0-9a-f-]{36}$/;
const LEVELS: readonly string[] = ['info', 'warn', 'error'];
const CODES: readonly string[] = LIVE_EVENT_CODES;

/** one stored event as read back (anything else in the value is dropped, so a stray field never reaches the page) */
function clean(v: unknown): LiveEvent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || !LEVELS.includes(o.level as string) || !CODES.includes(o.code as string)) return null;
  const e: LiveEvent = { at: o.at, level: o.level as LiveEvent['level'], code: o.code as LiveEventCode };
  if (typeof o.channelId === 'string' && ID_RE.test(o.channelId)) e.channelId = o.channelId;
  if (typeof o.sourceId === 'string' && ID_RE.test(o.sourceId)) e.sourceId = o.sourceId;
  if (typeof o.n === 'number' && Number.isInteger(o.n)) e.n = o.n;
  if (typeof o.reason === 'string' && REASON_RE.test(o.reason)) e.reason = o.reason;
  return e;
}

async function read(ctx: Pick<Ctx, 'kv'>, now: number): Promise<LiveEvent[]> {
  const raw = await ctx.kv.get(KEY);
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const since = now - TTL_S * 1000;
  return list.map(clean).filter((e): e is LiveEvent => e !== null && e.at >= since);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Adds an event (newest first, the newest 200 kept, 7 days). A read-modify-write under a short lock, so two emitters at once do not
 * drop each other's event; after ~0.5 s without the lock the event is written anyway (an event is a hint for the admin, never a reason
 * to fail the caller). A `reason` that is not a fixed code is left out, never stored as text.
 */
export async function pushEvent(ctx: Pick<Ctx, 'kv'>, e: Omit<LiveEvent, 'at'>): Promise<void> {
  const token = randomBytes(8).toString('hex');
  let locked = false;
  for (let i = 0; i < LOCK_TRIES && !locked; i++) {
    locked = await ctx.kv.setnx(LOCK, token, LOCK_TTL_S);
    if (!locked) await sleep(LOCK_WAIT_MS);
  }
  try {
    const now = Date.now();
    const ev = clean({ ...e, at: now });
    if (!ev) return;
    const list = [ev, ...(await read(ctx, now))].slice(0, MAX);
    await ctx.kv.set(KEY, JSON.stringify(list), TTL_S);
  } finally {
    if (locked) await ctx.kv.delIfEquals(LOCK, token);
  }
}

/** the newest events first, at most `limit` (default and maximum 200), none older than 7 days */
export async function listEvents(ctx: Pick<Ctx, 'kv'>, limit = MAX): Promise<LiveEvent[]> {
  const n = Math.max(0, Math.min(MAX, Math.floor(limit)));
  return (await read(ctx, Date.now())).slice(0, n);
}
