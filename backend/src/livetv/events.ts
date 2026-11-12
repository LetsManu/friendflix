// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';

/**
 * Live-Status events (spec §9.5, F20): a KV ring of the newest 200 for 7 days, codes only (never text, URLs or credentials).
 *
 * Minimal stand-in written by Task 20 (own feeds), which emits `ingest_sync_pending`, while Task 16 (which owns this file) was still
 * in progress: the code list and the `pushEvent` signature are Task 16's interface verbatim. Task 16's version replaces this file.
 */
export const LIVE_EVENT_CODES = ['source_refresh_failed', 'ingest_sync_pending', 'stopped_by_admin', 'start_refused_full', 'start_failed', 'input_lost', 'input_back', 'push_rejected', 'released_on_switch'] as const;
export type LiveEventCode = (typeof LIVE_EVENT_CODES)[number];

export interface LiveEvent {
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
const REASON_RE = /^[a-z_]{1,40}$/;

/** Adds one event (newest first, the newest 200 kept for 7 days). A reason that is not a fixed code is dropped, never stored as text. */
export async function pushEvent(ctx: Ctx, e: Omit<LiveEvent, 'at'>): Promise<void> {
  const ev: LiveEvent = { at: Date.now(), level: e.level, code: e.code };
  if (e.channelId) ev.channelId = e.channelId;
  if (e.sourceId) ev.sourceId = e.sourceId;
  if (typeof e.n === 'number' && Number.isFinite(e.n)) ev.n = e.n;
  if (e.reason && REASON_RE.test(e.reason)) ev.reason = e.reason;
  const owner = `${process.pid}:${Math.random()}`;
  // a short lock so two writers do not drop each other's event; without it after a few tries the event is written anyway
  let locked = false;
  for (let i = 0; i < 10 && !locked; i++) {
    locked = await ctx.kv.setnx(LOCK, owner, LOCK_TTL_S);
    if (!locked) await new Promise((r) => setTimeout(r, 20));
  }
  try {
    let list: LiveEvent[] = [];
    try { list = JSON.parse((await ctx.kv.get(KEY)) ?? '[]') as LiveEvent[]; } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    await ctx.kv.set(KEY, JSON.stringify([ev, ...list].slice(0, MAX)), TTL_S);
  } finally {
    if (locked) await ctx.kv.delIfEquals(LOCK, owner);
  }
}
